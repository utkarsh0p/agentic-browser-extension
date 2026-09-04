import asyncio
import json
import os
import re
import uuid
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv

# LangSmith reads LANGSMITH_* from os.environ on first use and memoizes the result, so the
# .env has to land before any langchain import builds a tracer. Explicit path, because bare
# load_dotenv() searches up from the working directory and misses the file when the server
# is launched from the repo root.
load_dotenv(Path(__file__).with_name(".env"))

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from langchain.agents import create_agent
from langchain.agents.middleware import (
    AgentMiddleware,
    ClearToolUsesEdit,
    ContextEditingMiddleware,
    HumanInTheLoopMiddleware,
    ModelCallLimitMiddleware,
    ToolCallLimitMiddleware,
    ToolErrorMiddleware,
)
from langchain_core.messages import ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from langchain_core.tools import tool

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

LLM_TIMEOUT = 120

# A page task is many model calls plus a browser round trip each, so the socket transport
# gets a far longer budget than a single-shot POST.
WS_TIMEOUT          = 600
# How long a single browser-side tool may take before the agent gives up on it.
CLIENT_TOOL_TIMEOUT = 120
# How long to wait on a human. Generous — they may be reading the page — but bounded, so a
# panel that was closed mid-approval fails the request instead of pinning the connection.
HITL_TIMEOUT        = 300
# Backstop against an agent that asks for approval in a loop.
MAX_HITL_ROUNDS     = 20

# langgraph surfaces a paused graph as {"__interrupt__": (Interrupt(value, id), ...)}.
INTERRUPT_KEY = "__interrupt__"

# Names that mean an action is worth confirming. Matched against an element's accessible
# name, which is why the server keeps the last snapshot around — it only ever receives
# {"verb": "click", "id": 15} and has no other way to know 15 is "Delete account".
RISKY_NAME    = re.compile(
    r"\b(delete|remove|discard|buy|purchase|pay|checkout|order|send|unsubscribe|"
    r"deactivate|transfer|withdraw|confirm)\b", re.I)
SECRET_FIELD  = re.compile(r"password|card|cvv|cvc|iban|ssn", re.I)
# Verbs that are consequential regardless of what they target.
RISKY_VERBS   = frozenset({"submit", "press"})

# Caps on a single turn. The agent loop is otherwise unbounded, and a tool whose
# arguments the model cannot get right will burn calls until the request times out.
MODEL_CALL_LIMIT       = 25
TOOL_CALL_LIMIT        = 30
IDENTICAL_CALL_LIMIT   = 2
# The same cap, but counted across the whole turn instead of per look at the page. Needed
# because IDENTICAL_CALL_LIMIT resets on every observation, so alternating act/read_page
# retries one dead action indefinitely — the shape every observed spiral has taken. Set
# well above IDENTICAL_CALL_LIMIT: re-reading legitimately re-opens an action, and this is
# only here to stop that being an infinite supply of retries.
IDENTICAL_CALL_CEILING = 4

# Transcript size at which page *text* starts being cleared. Sized to one turn's working
# set rather than to a context window: the point is to keep each model call small, because
# every call re-sends everything before it. Element maps are handled by
# TrimSupersededMaps instead, which needs no threshold.
TEXT_CLEAR_TRIGGER = 6_000

# Tools that only look. Never rate-limited, and each one re-opens every action: see
# RepeatedToolCallGuard. `find` is listed ahead of existing to keep the two in step.
OBSERVATION_TOOLS = frozenset({"read_page", "read_text", "find",
                               "search_page", "summarize_page"})

# ── Prompt fragments ──────────────────────────────────────────────────────────
# The prompt is assembled per lane from the fragments of the tools that lane actually
# received, so a turn never reads instructions for tools it does not have. Each fragment
# is attached to its tool in CAPABILITIES below — adding a tool adds its guidance.

PROMPT_BASE = (
    "You are SiteWhisper, a helpful AI assistant. "
    "You have access to tools — use them when they can help answer the user's question. "
    "If no tool is needed, answer directly from your knowledge.\n\n"
    "Handling tool failures: if a tool call fails or returns an error, do NOT reissue the "
    "same call with the same arguments. Read the error, correct the arguments, and try once "
    "more. If it fails again, stop and tell the user what went wrong."
)

PROMPT_ASK_USER = (
    "Missing information: when you need something only the user can supply — a value for a "
    "form field, a choice between paths, a detail you would otherwise be guessing at — call "
    "the ask_user tool. Do not invent the value, and do not end your turn to ask in prose: "
    "ask_user keeps the task running and brings their answer straight back to you.\n\n"
    "Some actions pause for the user's approval. If one comes back rejected, do not retry "
    "it — say what you were going to do and let them decide."
)

PROMPT_BROWSING = (
    "Reaching the internet: you have no search tool, but you have a browser — that IS your "
    "internet access. Never tell the user you cannot look something up. Put the query "
    "straight into a search address and go there: https://duckduckgo.com/?q=your+query, or "
    "https://www.google.com/search?q=your+query, with spaces written as +. If a results "
    "page needs the box filled in instead, type into it and press Enter.\n\n"
    "Moving between pages: if a link to where you want to go is visible on the page, click "
    "it. Otherwise use goto — with an address the user gave you, one you know, or a search "
    "address as above. Do not invent a deep link and hope; guessed URLs land on missing "
    "pages."
)

PROMPT_READING = (
    "Reading a page: read_text gives you its visible text — use it for any question about "
    "what a page says. read_page gives the interactive elements instead — links, buttons, "
    "inputs — which is what you need in order to act. A results page already lists its "
    "results as links in the element map, so read_text is usually unnecessary there; open "
    "the page you want and read_text that."
)

# Ids are written bare — "12 link Main page" — because the element map dropped its brackets
# and quotes; 71% of every line was punctuation. Keep these examples in step with
# content.js describe().
PROMPT_ACTING = (
    "Element numbers are names, not positions. A number stays with the same control for as "
    "long as that control is on the page, so a number you were given earlier still means "
    "the same thing even after the page has changed around it. The ORDER OF THE LINES is "
    "the order things appear on the page — read 'the first one' off the line order, never "
    "off the numbers. Numbers from a different page are dead; using one tells you so.\n\n"
    "Finishing: a request that names one target — the first mail, the top result, that "
    "button — is done as soon as one action on it succeeds. When the result says it worked, "
    "say what you did and stop. Do not repeat it on whatever has since moved into that "
    "position: the map that comes back is there so you can continue a longer task, not a "
    "list of more work to do.\n\n"
    "After an action: act and goto both return the page's element map as it is after they "
    "ran, so start from that rather than re-reading out of habit. If a result says the map "
    "is unchanged, the numbers you already have are still valid; do not re-read for them. "
    "If one action in a batch failed, the ones before it still happened.\n\n"
    "When something you expected is NOT in the map, do not conclude it is absent and do "
    "not repeat the same action hoping for a different result. The map can be wrong in "
    "several ways, so work through them:\n"
    "- The map is capped, and says so in its header when it truncates. A control can be "
    "present on the page and simply not listed.\n"
    "- If you opened a menu, dialog or overlay, what you want is inside it. Read the page "
    "again — an overlay changes the map completely.\n"
    "- The page may still have been rendering when the map was taken. Run act with "
    '{"verb":"wait"} and look again.\n'
    "- If a control is on screen but unlistable, act on what has focus instead: press and "
    "submit work with no id. A dialog usually focuses its input the moment it opens.\n"
    "- If none of that works, ask_user what they can see. Do not just report failure while "
    "you still have moves left.\n\n"
    "Reading the page again is always allowed and never counts against you."
)

PROMPT_RETRIEVAL = (
    "Answering about this page: call search_page with the part of the question you are "
    "looking for. It returns the passages of the page that match, not the whole page, so "
    "ask it more than once with different wording rather than guessing from one result. "
    "Answer only from what it returns — if the passages do not contain the answer, say so "
    "instead of filling the gap from memory.\n\n"
    "Use summarize_page when the user wants the whole page: a summary, an overview, or "
    "'what is this about'."
)

PROMPT_ESCALATE = (
    "You cannot act on the page in this turn — you have no click, type or navigate tool. "
    "The moment the request needs one, call escalate with a one-line reason and stop; the "
    "task is handed straight to the tools that can do it. Never claim you performed an "
    "action, and never guess at page content you were not given."
)


# ── Lane + capability registry ────────────────────────────────────────────────
# One declaration per tool decides three things at once: which lanes may offer it, what
# guidance joins the prompt when it does, and (via LANES) what the router is told about
# its lane. Adding a tool means adding one entry here — no routing code to touch.

LANE_CHAT     = "chat"
LANE_ASK_PAGE = "ask_page"
LANE_OPERATE  = "operate"
LANE_APP      = "app"


@dataclass(frozen=True)
class Lane:
    # What the router reads when choosing. This text IS the routing rule.
    description:   str
    # Requires a live browser round trip, so it exists only on the socket transport.
    needs_browser: bool = False


LANES: dict[str, Lane] = {
    LANE_CHAT: Lane(
        description=("general conversation, greetings, or a knowledge question that does "
                     "not depend on the page the user is looking at"),
    ),
    LANE_ASK_PAGE: Lane(
        description=("a question about the page the user is on: what it says, finding "
                     "something in it, summarising it, giving an overview, or explaining "
                     "what it is about"),
    ),
    LANE_OPERATE: Lane(
        description=("the user wants something DONE in the browser: click, type, fill, "
                     "scroll, navigate, go back, open a site, search the web, or any "
                     "multi-step task. Covers anything doable on the page they are looking "
                     "at, including acting inside a web app they already have open"),
        needs_browser=True,
    ),
    LANE_APP: Lane(
        # "not looking at" is the whole distinction. Without it, "delete the first mail"
        # routed here purely because it says mail — while the user was sitting on Gmail
        # with the mail in front of them — and the turn spent a model call escalating.
        description=("an action in an outside service the user is NOT currently looking "
                     "at, reached through a connected account rather than through the "
                     "page in front of them"),
    ),
}

# Lanes that cannot act on the page, and therefore get `escalate`.
ESCALATING_LANES = frozenset({LANE_CHAT, LANE_ASK_PAGE, LANE_APP})

# On router failure, fall back to the lane that can do the most — behaving exactly as the
# single-agent design did — rather than silently answering with fewer tools than the task
# needs. Downgraded to ASK_PAGE when there is no browser.
FALLBACK_LANE = LANE_OPERATE


@dataclass(frozen=True)
class Cap:
    """Which lanes may offer a tool, and the prompt guidance that comes with it."""
    lanes:  frozenset
    prompt: Optional[str] = None


CAPABILITIES: dict[str, Cap] = {
    "search_page":    Cap(frozenset({LANE_ASK_PAGE}),                prompt=PROMPT_RETRIEVAL),
    "summarize_page": Cap(frozenset({LANE_ASK_PAGE, LANE_OPERATE, LANE_APP})),
    "read_text":      Cap(frozenset({LANE_OPERATE}),                 prompt=PROMPT_READING),
    "read_page":      Cap(frozenset({LANE_ASK_PAGE, LANE_OPERATE})),
    "act":            Cap(frozenset({LANE_OPERATE}),                 prompt=PROMPT_ACTING),
    "goto":           Cap(frozenset({LANE_OPERATE}),                 prompt=PROMPT_BROWSING),
    "ask_user":       Cap(frozenset({LANE_OPERATE}),                 prompt=PROMPT_ASK_USER),
    "escalate":       Cap(frozenset(ESCALATING_LANES),               prompt=PROMPT_ESCALATE),
}

# Anything not declared above is an external integration (Composio ships its tools at
# runtime, named per toolkit), so it lands in the app lane without needing an entry.
DEFAULT_CAP = Cap(frozenset({LANE_APP}))


def _cap(name: str) -> Cap:
    return CAPABILITIES.get(name, DEFAULT_CAP)


# The order fragments appear in is not cosmetic. Composing them in registry order put the
# ask_user guidance last, and the model then reached for ask_user instead of act — on a
# task the original prompt completed with three act calls. This sequence reproduces the
# order of the prompt that was tuned by use: what the agent should do comes before how to
# ask for help, and the acting rules (with the "not in the map" ladder) close the prompt.
# Anything not listed still gets appended, so a new tool contributes without editing this.
PROMPT_SEQUENCE = ("ask_user", "goto", "read_text", "search_page", "act", "escalate")


_SNAP_HEADER = {"page": re.compile(r'^page:\s*(.+)$', re.M),
                "url":  re.compile(r'^url:\s*(.+)$',  re.M)}


def _page_hint(snapshot: str) -> str:
    """One line naming the page the user is on, from the map header the panel already sends.

    Costs ~20 tokens and removes a whole class of stall: without it the agent cannot tell
    whether a page is open at all, and asking the user which page they mean is a reasonable
    thing to do when nothing has said.
    """
    if not snapshot:
        return ""
    title = _SNAP_HEADER["page"].search(snapshot)
    url   = _SNAP_HEADER["url"].search(snapshot)
    if not (title or url):
        return ""
    where = " — ".join(x.group(1).strip() for x in (title, url) if x)
    return (f"The user is looking at this page right now: {where}\n"
            "That is the page your tools act on. You do not need to ask which page they "
            "mean, and you do not need its address to work on it.")


def _lane_prompt(tools: list, page_hint: str = "") -> str:
    """Compose the system prompt from the tools this lane actually received."""
    have  = {getattr(t, "name", "") for t in tools}
    order = [n for n in PROMPT_SEQUENCE if n in CAPABILITIES]
    order += [n for n in CAPABILITIES if n not in order]

    parts, seen = [PROMPT_BASE], {PROMPT_BASE}
    if page_hint:
        parts.append(page_hint)
    for name in order:
        fragment = CAPABILITIES[name].prompt
        # Identity check, not equality: two tools may legitimately share one fragment and
        # it must still appear once.
        if fragment and name in have and fragment not in seen:
            parts.append(fragment)
            seen.add(fragment)
    return "\n\n".join(parts)


def _on_tool_error(exc: Exception, request) -> str:
    """Turn a tool exception into a message the model can actually act on.

    Without this the exception propagates and the model never learns *why* the call
    failed, so it retries the same arguments verbatim — the cause of the repeated
    identical Composio calls seen in the UI. The text also reaches the panel, because
    the resulting ToolMessage is what feeds the `tool_result` SSE frame below.
    """
    name = (getattr(request, "tool_call", None) or {}).get("name", "")
    return (
        f"Tool '{name}' failed: {type(exc).__name__}: {exc}\n"
        "Correct the arguments and try once, or report the failure to the user. "
        "Do not repeat this call unchanged."
    )


class RepeatedToolCallGuard(AgentMiddleware):
    """Refuse an action already tried, byte-identical, since the last look at the page.

    ToolCallLimitMiddleware caps calls per tool *name*, which cannot catch this without
    knowing the offending name up front — and with Composio the real action is a
    parameter, not the tool name. Matching on (name, args) instead is name-agnostic.

    Two things this deliberately does NOT do, both learned the hard way:

    Observation is never blocked. read_page and read_text take no arguments, so keying on
    (name, args) alone made their keys the constants "read_page::{}" and "read_text::{}" —
    which capped LOOKING at the page to twice per run. Re-observing is precisely how an
    agent recovers from an incomplete snapshot, and the system prompt tells it to; blocking
    that turned a recoverable state into a dead end.

    Counters are scoped to an epoch that every observation bumps, so the rule reads "you
    already tried this and you have not looked since" rather than "you tried this once, in
    this run, on some page". A fresh look re-opens every action — the agent has new
    information, so the same click may now be the right move. It also stops a low element
    id on page B colliding with the same id on page A, since ids are small integers and the
    JSON is byte-identical across pages.

    A second, unscoped counter sits behind that one, and it is the reason this class is not
    just the epoch rule. Because every observation clears the epoch counters, and because
    the prompt's recovery ladder tells the agent to re-read whenever something is missing,
    act/read_page/act is both the natural response to a bad map AND a way to retry one dead
    action forever — nothing stopped it short of TOOL_CALL_LIMIT ending the whole turn.
    Every spiral observed in practice had exactly that shape. So (name, args) is also
    counted across the turn, with a higher ceiling: a fresh look still re-opens an action a
    few times, which is the behaviour worth keeping, but it is no longer an unlimited supply.

    State is per-instance, which is per-request here: the agent (and so this middleware)
    is constructed inside the request handler, not cached like the LLM clients are.
    """

    def __init__(self, limit: int = IDENTICAL_CALL_LIMIT,
                 ceiling: int = IDENTICAL_CALL_CEILING) -> None:
        super().__init__()
        self.limit   = limit
        self.ceiling = ceiling
        self.tools   = []         # registers no tools of its own
        self._seen: dict[str, int] = {}
        self._total: dict[str, int] = {}
        self._epoch = 0

    def _exhausted(self, request) -> Optional[str]:
        """None to let the call through, else which cap it hit ("epoch" or "turn")."""
        call = getattr(request, "tool_call", None) or {}
        name = call.get("name") or ""
        if name in OBSERVATION_TOOLS:
            self._epoch += 1
            return None
        try:
            args = json.dumps(call.get("args", {}), sort_keys=True, default=str)
        except (TypeError, ValueError):
            args = str(call.get("args"))

        # Counted twice, deliberately. The epoch-scoped key is the useful one — it says
        # "you tried this and you have not looked since" and a fresh look clears it. The
        # unscoped key exists because that clearing is unlimited: read_page bumps the epoch,
        # so act/read_page/act retries a dead action until TOOL_CALL_LIMIT ends the turn,
        # which is minutes of the user's own API spend on a click that will never work.
        both = f"{name}::{args}"
        self._total[both] = self._total.get(both, 0) + 1

        key = f"{self._epoch}::{both}"
        self._seen[key] = self._seen.get(key, 0) + 1

        if self._seen[key] > self.limit:
            return "epoch"
        if self._total[both] > self.ceiling:
            return "turn"
        return None

    def _refusal(self, request, scope: str) -> ToolMessage:
        call = getattr(request, "tool_call", None) or {}
        # Not status="error": a block is not a tool failure, and marking it as one made the
        # model apply the prompt's two-strikes "stop and tell the user" rule and give up.
        # The content is a ladder of alternatives, because the old wording offered only
        # "change the arguments or tell the user it failed" — and a zero-arg tool has no
        # arguments to change, leaving surrender as the sole option on the menu.
        if scope == "turn":
            # Re-reading is normally the way out, so this branch must not offer it: the
            # whole point of the turn-scoped cap is that re-reading has already been tried
            # and did not help. Pointing back at read_page here would be the loop.
            reason = (
                f"was already tried {self.ceiling}x with these exact arguments in this "
                "turn, across several reads of the page. Re-reading has not changed the "
                "outcome, so it will not this time either — this exact call is done."
            )
            ladder = (
                "- a DIFFERENT element, or a different approach to the same goal\n"
                '- act with {"verb":"wait"} if the page may still have been rendering\n'
                "- press/submit with no id, to hit whatever has focus\n"
                "- ask_user what they can see on screen — they are looking at it\n"
                "- if none of that applies, say what you were unable to do and stop"
            )
        else:
            reason = (
                f"was already tried {self.limit}x with these exact arguments and the page "
                "has not been read since, so the result would be the same."
            )
            ladder = (
                "- read_page to see the page as it is NOW; the earlier map may have been "
                "incomplete or truncated, and re-reading also re-enables this action\n"
                '- act with {"verb":"wait"} if the page may still have been rendering\n'
                "- a different element, or press/submit with no id to hit whatever has focus\n"
                "- ask_user what they can see on screen"
            )

        return ToolMessage(
            content=(
                f"Not run: '{call.get('name')}' {reason} This is not a failure — try "
                f"something else:\n{ladder}"
            ),
            tool_call_id=call.get("id") or "",
            name=call.get("name") or "",
        )

    # Both paths implemented: /chat streams via astream(), but a sync entry point
    # would otherwise raise NotImplementedError.
    def wrap_tool_call(self, request, handler):
        scope = self._exhausted(request)
        return self._refusal(request, scope) if scope else handler(request)

    async def awrap_tool_call(self, request, handler):
        scope = self._exhausted(request)
        if scope:
            return self._refusal(request, scope)
        return await handler(request)


# The header content.js puts at the top of every element map. Finding it is how a map is
# told apart from the outcome lines that precede it in an act result.
MAP_HEADER = re.compile(r'^page:\s.*$', re.M)

MAP_DROPPED_NOTE = "[element map removed — it was superseded by a later one]"


class TrimSupersededMaps(AgentMiddleware):
    """Drop stale element maps from the transcript while keeping what the actions did.

    An act result has two halves with completely different shelf lives:

        ok: clicked "Delete"          <- what happened. Small, and it is the agent's only
        → the page changed (3 gone)      memory of its own work.

        page: Inbox                   <- the map. Large, and worthless the moment a newer
        12 row Mail from Ana             one arrives.
        ...

    ClearToolUsesEdit replaces a tool message wholesale, so using it here threw the first
    half away with the second. That is what made a turn loop: three steps in, the agent
    could no longer see that it had already clicked Delete, and the placeholder it got
    instead told it to read the page again — so it did, saw a fresh inbox, and deleted
    again. Approving the action changed nothing, because the evidence of it was overwritten
    on the next model call.

    Keeping the outcomes is also cheaper than the placeholder that replaced them: a couple
    of lines per past step against a sentence of boilerplate.
    """

    def __init__(self) -> None:
        super().__init__()
        self.tools = []          # registers no tools of its own

    @staticmethod
    def _split(content: str) -> Optional[str]:
        """The content with its map removed, or None if there was no map to remove."""
        if not isinstance(content, str):
            return None
        found = MAP_HEADER.search(content)
        if not found:
            return None
        head = content[:found.start()].rstrip()
        return f"{head}\n\n{MAP_DROPPED_NOTE}" if head else MAP_DROPPED_NOTE

    @classmethod
    def _trim(cls, messages: list) -> list:
        # Newest first, so "keep the current map" needs no second pass.
        seen_map = False
        out = []
        for msg in reversed(messages):
            if isinstance(msg, ToolMessage):
                trimmed = cls._split(msg.content)
                if trimmed is not None:
                    if seen_map:
                        # copy, never mutate: the message list is shared with graph state,
                        # and editing in place would make the trim permanent.
                        msg = msg.model_copy(update={"content": trimmed})
                    seen_map = True
            out.append(msg)
        out.reverse()
        return out

    def wrap_model_call(self, request, handler):
        return handler(request.override(messages=self._trim(request.messages)))

    async def awrap_model_call(self, request, handler):
        return await handler(request.override(messages=self._trim(request.messages)))


# ── Cached client factories ────────────────────────────────────────────────────

@lru_cache(maxsize=256)
def get_openai_clients(token: str, model_id: str):
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(model=model_id, openai_api_key=token, streaming=True,
                      stream_usage=True)


@lru_cache(maxsize=256)
def get_gemini_clients(token: str, model_id: str):
    from langchain_google_genai import ChatGoogleGenerativeAI
    return ChatGoogleGenerativeAI(model=model_id, google_api_key=token, streaming=True)


# GroqCloud exposes an OpenAI-compatible endpoint (chat completions, streaming, tool
# calls), so this rides langchain-openai with a different base_url instead of adding
# another SDK. Note: Groq, the inference host — not xAI's Grok.
@lru_cache(maxsize=256)
def get_groq_clients(token: str, model_id: str):
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        model=model_id,
        openai_api_key=token,
        base_url="https://api.groq.com/openai/v1",
        streaming=True,
        stream_usage=True,
    )


@lru_cache(maxsize=256)
def get_claude_client(token: str, model_id: str):
    from langchain_anthropic import ChatAnthropic
    return ChatAnthropic(model=model_id, anthropic_api_key=token, streaming=True)


# ── Helpers ────────────────────────────────────────────────────────────────────

# Each fallback is the first entry of that provider's list in popup.js, and has to stay
# that way: the panel drops back to models[0] when a stored selection no longer exists, so
# a mismatch here means the turn silently runs on a different model than the one showing in
# the picker. These are the defaults rather than the cheapest option on purpose — a model
# that cannot read the element map does not fail cleanly, it loops until the user gives up.
def _resolve_llm(provider: str, token: str, model: Optional[str]):
    if provider == "openai":
        return get_openai_clients(token, model or "gpt-5.6-sol")
    if provider == "gemini":
        return get_gemini_clients(token, model or "gemini-3.7-flash")
    if provider == "groq":
        return get_groq_clients(token, model or "qwen/qwen3.6-27b")
    if provider == "claude":
        return get_claude_client(token, model or "claude-opus-5")
    raise ValueError(f"Unsupported provider: {provider}")


# Auth failures only. Deliberately NOT a bare "invalid" match: OpenAI-compatible
# APIs label a missing model `"type": "invalid_request_error"`, so a substring test
# on "invalid" reports a working key as a bad one and hides the real cause.
_AUTH_MARKERS = (
    "invalid api key", "invalid_api_key", "incorrect api key", "invalid x-api-key",
    "api key not valid", "no api key", "missing api key", "api_key",
    "authentication", "unauthorized", "permission denied", "401",
)


def _is_auth_error(e: Exception) -> bool:
    msg = str(e).lower()
    return any(k in msg for k in _AUTH_MARKERS)


# A provider's quota, kept separate from auth because the user's action is different —
# wait or shorten, not go and check the key — and because the raw provider JSON is not a
# sentence anyone should be shown.
#
# Phrases only, plus the exception's own status code. Deliberately no bare "429"/"413"/
# "tpm": those appear inside org ids, token counts and request ids, and matching them would
# repeat the mistake that made a missing model report itself as a bad API key.
_RATE_MARKERS = (
    "rate_limit_exceeded", "rate limit reached", "rate limit exceeded",
    "too many requests", "tokens per", "requests per", "request too large",
)
_RATE_STATUS = frozenset({413, 429})

# "Please try again in 11m7.872s" / "try again in 19.8s" — the provider knows the window,
# so quote it rather than guessing whether the cap was per minute or per day.
_RETRY_AFTER = re.compile(r"try again in ([0-9hms.]+)", re.I)
# TPD and TPM are the same error shape with very different consequences for the user.
_RATE_WINDOW = re.compile(r"tokens per (day|minute|hour)", re.I)


def _is_rate_limit_error(e: Exception) -> bool:
    if getattr(e, "status_code", None) in _RATE_STATUS:
        return True
    msg = str(e).lower()
    return any(k in msg for k in _RATE_MARKERS)


def _rate_limit_message(provider: str, e: Optional[Exception] = None) -> str:
    raw    = str(e or "")
    window = _RATE_WINDOW.search(raw)
    retry  = _RETRY_AFTER.search(raw)
    scope  = f"per-{window.group(1)} limit" if window else "rate limit"
    # rstrip(".") because the duration pattern also swallows the sentence's full stop.
    when   = (f" Try again in {retry.group(1).rstrip(chr(46))}." if retry
              else " Wait a moment and try again.")
    return (f"{provider.title()} hit its {scope}.{when} "
            "A long page task in one turn is the usual cause; a paid tier or another "
            "provider lifts it.")


def _sse_error_handler(e: Exception, provider: str) -> str:
    if _is_auth_error(e):
        return f"Invalid API key for {provider}. Check your key in Settings."
    if _is_rate_limit_error(e):
        return _rate_limit_message(provider, e)
    return f"Stream error ({provider}): {e}"


# ── Page context: what the server knows about the page it is acting on ────────
# Mirrors the snapshot format content.js emits, e.g.
#   15 button Delete account
#   12 textbox Search = laptops [required]
#   30 combobox Country options: India | Japan
# The name is unquoted, so it is read as "everything after the role, minus the suffixes".
# content.js's clean() strips "[", "]" and " = " out of names and values precisely so
# these suffix patterns cannot match inside one. Keep the three in step: this parser, the
# panel's SNAP_LINE, and describe().
SNAPSHOT_LINE = re.compile(r'^(\d+)\s+(\S+)(?:\s+(.*))?$')
_SNAP_SUFFIXES = (
    re.compile(r'\s+options:\s.*$'),     # <select> choices, appended last
    re.compile(r'\s+\[[^\]]*\]$'),        # state flags
    re.compile(r'\s+=\s.*$'),            # current value
)


def _snapshot_name(rest: str) -> str:
    """Strip the value/flags/options suffixes, leaving the element's name."""
    for pattern in _SNAP_SUFFIXES:
        rest = pattern.sub("", rest)
    return rest.strip()


def _snapshot_elements(text: str) -> dict:
    """Parse a snapshot back into {id: (role, name)}."""
    found = {}
    for line in (text or "").splitlines():
        m = SNAPSHOT_LINE.match(line)
        if m:
            found[int(m.group(1))] = (m.group(2), _snapshot_name(m.group(3) or ""))
    return found


class PageContext:
    """Remembers the latest element map so the approval gate can talk about names.

    The model addresses elements by number, so a tool call is only ever
    `{"verb": "click", "id": 15}` — nothing in it says 15 is "Delete account". But every
    snapshot passes through here as the return value of read_page/act, so keeping the last
    one is enough to both decide whether to ask and to write a prompt worth reading.

    One instance per WebSocket connection; it dies with the socket.
    """

    def __init__(self) -> None:
        self.elements: dict = {}

    def observe(self, tool_result: str) -> None:
        found = _snapshot_elements(tool_result)
        if found:
            self.elements = found      # replace, don't merge: stale ids must not linger

    def _label(self, action: dict) -> str:
        role, name = self.elements.get(action.get("id"), ("", ""))
        return name or role or f'element {action.get("id")}'

    def _is_risky(self, action: dict) -> bool:
        verb = str(action.get("verb", "")).lower()
        if verb in RISKY_VERBS:
            return True
        role, name = self.elements.get(action.get("id"), ("", ""))
        if verb == "click" and RISKY_NAME.search(name):
            return True
        if verb in ("type", "clear") and SECRET_FIELD.search(f"{role} {name}"):
            return True
        return False

    @staticmethod
    def _args_of(tool_call):
        args = getattr(tool_call, "args", None)
        if args is None and isinstance(tool_call, dict):
            args = tool_call.get("args")
        return args

    @classmethod
    def _actions_of(cls, tool_call) -> list:
        args = cls._args_of(tool_call)
        actions = (args or {}).get("actions") or [] if isinstance(args, dict) else []
        return [a for a in actions if isinstance(a, dict)]

    def needs_approval(self, request) -> bool:
        """InterruptOnConfig["when"] — ask only when the batch actually does something
        consequential, so ordinary typing and scrolling stay uninterrupted.

        Fails closed: an unreadable request shape returns True rather than sliding through
        as "nothing risky found", which is exactly what an empty actions list looks like.
        """
        try:
            tool_call = getattr(request, "tool_call", request)
            if not isinstance(self._args_of(tool_call), dict):
                return True
            return any(self._is_risky(a) for a in self._actions_of(tool_call))
        except Exception:
            return True

    def _phrase(self, action: dict) -> str:
        verb = str(action.get("verb", "act")).lower()
        if verb == "submit":
            return "submit the form"
        if verb == "press":
            return f'press {action.get("key", "a key")}'
        if verb in ("type", "clear"):
            return f'fill "{self._label(action)}"'
        return f'{verb} "{self._label(action)}"'

    def describe_act(self, tool_call, state=None, runtime=None) -> str:
        """InterruptOnConfig["description"] — names the elements instead of saying
        "approve act", which is the difference between a usable prompt and a scary one.

        EVERY risky action in the batch is named. Leading with just the first one lets a
        benign-sounding summary ("Fill Password?") hide the one that actually matters
        ("click Delete account") — and the user would approve both.
        """
        try:
            actions = self._actions_of(tool_call)
        except Exception:
            actions = []
        if not actions:
            return "Perform an action on the page?"

        risky  = [a for a in actions if self._is_risky(a)]
        shown  = risky or actions
        listed = [self._phrase(a) for a in shown[:3]]
        text   = ", then ".join(listed)

        if len(shown) > len(listed):
            text += f", plus {len(shown) - len(listed)} more"
        quiet = len(actions) - len(shown)
        if risky and quiet > 0:
            text += f" ({quiet} other action{'s' if quiet > 1 else ''} in the same batch)"

        return text[:1].upper() + text[1:] + "?"


# Everything here is read-only or already gated by its own rules; anything else reaching the
# agent is an external side effect (Composio) and asks in both modes by default.
SAFE_TOOL_NAMES = frozenset({
    "read_text", "read_page", "act", "ask_user",
    # Retrieval reads the page and nothing else; escalate only re-dispatches this turn.
    "search_page", "summarize_page", "escalate",
    # goto is here deliberately: navigation is reversible with Back, and everything
    # consequential at the destination is already gated by needs_approval. Prompting on
    # "go to google" would only train the user to approve without reading.
    "goto",
})


def _hitl_config(mode: str, tool_names: list, ctx: "PageContext") -> dict:
    """Which tools pause for a human, given the mode.

    Unrestricted covers page actions only. External side effects still ask either way — a
    wrong click is undone with Back, a sent email is not.
    """
    have = set(tool_names)
    cfg: dict = {}

    # Asking the user for information is not a restriction, it is the agent doing its job,
    # so it stays on in both modes.
    if "ask_user" in have:
        cfg["ask_user"] = {"allowed_decisions": ["respond"]}

    # Only ever configure gates for tools this lane actually holds: a lane without `act`
    # has nothing to approve, and a config naming absent tools invites the reader to think
    # the gate is doing something it cannot.
    if mode != "unrestricted" and "act" in have:
        cfg["act"] = {
            "allowed_decisions": ["approve", "reject"],
            "when":              ctx.needs_approval,
            "description":       ctx.describe_act,
        }

    for name in tool_names:
        if name not in SAFE_TOOL_NAMES:
            cfg[name] = {"allowed_decisions": ["approve", "reject"]}

    return cfg


# ── Page text and retrieval ───────────────────────────────────────────────────
# Retrieval runs here, not in the model's context: search_page returns the passages that
# match, so a question about a long page costs a few hundred tokens instead of the whole
# page. TF-IDF is the default because it needs no embedding endpoint at all — Groq has
# none, and it is the cheapest thing that works everywhere.

CHUNK_SIZE      = 500
CHUNK_OVERLAP   = 50
TOP_CHUNKS      = 5
MAX_TEXT_CHARS  = 8000     # one read_text; ~2k tokens, sized to leave room under a TPM cap
MAX_SUMMARY_CHARS = 12000  # a summary genuinely needs the whole page, so it gets more


@lru_cache(maxsize=64)
def _resolve_embedding(provider: str, token: str):
    """An embedding model for the selected provider, or None when it has none.

    Groq and Anthropic ship no embeddings endpoint, so those return None and retrieval
    falls back to TF-IDF rather than failing.
    """
    try:
        if provider == "openai":
            from langchain_openai import OpenAIEmbeddings
            return OpenAIEmbeddings(model="text-embedding-3-small", openai_api_key=token)
        if provider == "gemini":
            from langchain_google_genai import GoogleGenerativeAIEmbeddings
            return GoogleGenerativeAIEmbeddings(model="models/text-embedding-004",
                                                google_api_key=token)
    except Exception:
        return None
    return None


def _rank_chunks(query: str, chunks: list, embedding=None, k: int = TOP_CHUNKS) -> str:
    """Top-k chunks for the query. Synchronous and CPU-bound — call in a threadpool."""
    if not chunks:
        return ""
    from sklearn.metrics.pairwise import cosine_similarity

    scores = None
    if embedding is not None:
        try:
            doc_vectors  = embedding.embed_documents(chunks)
            query_vector = embedding.embed_query(query)
            scores = cosine_similarity([query_vector], doc_vectors)[0]
        except Exception:
            scores = None      # a paid embedding call must never lose the answer
    if scores is None:
        from sklearn.feature_extraction.text import TfidfVectorizer
        try:
            matrix = TfidfVectorizer().fit_transform(chunks + [query])
            scores = cosine_similarity(matrix[-1], matrix[:-1])[0]
        except ValueError:
            # Every term was a stop word, so there is nothing to rank on. Returning the
            # head of the page beats returning nothing.
            return "\n\n".join(chunks[:k])

    ranked = sorted(range(len(chunks)), key=lambda i: scores[i], reverse=True)[:k]
    # Document order, not score order: passages read as prose when they stay in sequence.
    return "\n\n".join(chunks[i] for i in sorted(ranked))


class PageText:
    """The page's visible text, fetched at most once per turn and then chunked.

    Fetched lazily rather than up front because most turns never ask for it, and because
    over a socket the text has to come from the live page — grabbing it at send time would
    describe wherever the tab used to be.
    """

    def __init__(self, fetch=None, fallback: str = "") -> None:
        self._fetch    = fetch        # awaitable client_call; socket transport only
        self._fallback = fallback     # send-time text; POST transport
        self._text: Optional[str]     = None
        self._chunks: Optional[list]  = None

    async def text(self) -> str:
        if self._text is None:
            if self._fetch is not None:
                try:
                    self._text = str(await self._fetch("read_text", {}) or "").strip()
                except Exception:
                    self._text = ""
            else:
                self._text = (self._fallback or "").strip()
        return self._text

    async def chunks(self) -> list:
        if self._chunks is None:
            from langchain_text_splitters import RecursiveCharacterTextSplitter
            body = await self.text()
            splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE,
                                                      chunk_overlap=CHUNK_OVERLAP)
            self._chunks = splitter.split_text(body) if body else []
        return self._chunks


class Escalation:
    """Records a lane's request to hand the turn to the page tools.

    The tool cannot re-dispatch the graph itself, so it parks the reason here and the
    transport re-runs the turn in the operate lane once. One instance per turn, and the
    single hop is enforced by the transport, not by trusting the model to stop asking.
    """

    def __init__(self) -> None:
        self.reason: Optional[str] = None

    @property
    def requested(self) -> bool:
        return self.reason is not None


# ── Intent router ─────────────────────────────────────────────────────────────
# One structured-output call per turn picks the lane. It is deliberately tiny — it sees
# the lane descriptions and the last exchange, never the tool schemas — which is what
# makes it ~100 tokens instead of the ~1.8k a tool-selection pass would cost, and it runs
# once per turn rather than once per model call.

ROUTER_TIMEOUT = 20


def _route_instructions(lanes: list[str]) -> str:
    """The routing rule, written from the registry so it cannot drift from LANES."""
    lines = [f"- {name}: {LANES[name].description}" for name in lanes]
    return (
        "Classify what the user wants so it can be handled by the right tools. "
        "Choose exactly one option.\n\n" + "\n".join(lines) + "\n\n"
        "Judge the request on its own. If it asks for something to be done rather than "
        "answered, choose the option that does things."
    )


def _router_input(query: str) -> str:
    """The user turn shown to the router: the request, verbatim.

    No prior conversation (see _build_messages) and deliberately no page context either.
    Telling the router which page the user is on reads as an instruction to act on it: with
    the page named, "what does this page say about his goals" and even "hi" were classified
    as work to do. The bare request scores 14/15 on the case set; adding context scored 4/6
    and then 2/8. The remaining miss is recovered by escalate.
    """
    return query


async def _route(llm, body: "ChatRequest", allow_browser: bool,
                 usage: Optional["Usage"] = None) -> tuple[str, Optional[str]]:
    """Pick a lane. Returns (lane, error) — error is set only for reporting, never fatal.

    Failure falls back to the most capable available lane, so a router that cannot parse
    leaves the turn behaving exactly as the old single-agent design did instead of
    answering with fewer tools than the task needs.
    """
    from typing import Literal
    from pydantic import Field, create_model

    available = [n for n in LANES if allow_browser or not LANES[n].needs_browser]
    fallback  = FALLBACK_LANE if FALLBACK_LANE in available else LANE_ASK_PAGE
    if len(available) < 2:
        return fallback, None

    # Built from the registry so a new lane needs no change here.
    Route = create_model(
        "Route",
        lane=(Literal[tuple(available)],
              Field(description="which option handles the user's latest message")),
    )

    try:
        async with asyncio.timeout(ROUTER_TIMEOUT):
            # include_raw so the routing call's own tokens land in the turn's total. A
            # counter that hid the router would understate every turn by its cheapest part.
            got = await llm.with_structured_output(Route, include_raw=True).ainvoke([
                ("system", _route_instructions(available)),
                ("user",   _router_input(body.query)),
            ])
        raw    = (got or {}).get("raw")
        picked = (got or {}).get("parsed")
        if usage is not None and getattr(raw, "usage_metadata", None):
            usage.observe(getattr(raw, "id", None), raw.usage_metadata)
        lane = getattr(picked, "lane", None)
        if lane in available:
            return lane, None
        return fallback, f"router returned {lane!r}"
    except Exception as e:
        return fallback, f"{type(e).__name__}: {e}"


# ── Agent assembly, shared by both transports ─────────────────────────────────

def _build_tools(body: "ChatRequest", client_call=None, lane: str = LANE_OPERATE,
                 page_text: Optional["PageText"] = None,
                 escalation: Optional["Escalation"] = None,
                 provider: str = "", token: str = "") -> list:
    """Assemble the tool list for one lane.

    Every candidate tool is defined here and then filtered through CAPABILITIES, so a
    lane's tool list — and therefore its prompt and its token cost — follows from the
    registry rather than from a branch per lane.

    `client_call(name, args)` is an awaitable that runs a tool *in the browser* and
    returns its result. It is only available over the WebSocket transport, because a
    plain POST has no way to call back into the panel mid-request. When it is absent the
    page-action tools are simply not offered, so the model is never shown a tool it
    cannot use.
    """

    tools     = []
    page_text = page_text or PageText(fallback=getattr(body, "text", "") or "")

    if client_call is None:
        @tool
        def read_page() -> str:
            """List the interactive elements on the current page: buttons, links, text inputs,
            checkboxes, dropdowns. Each line gives a number, the element's role, its visible
            label, and its current state (for example whether a checkbox is already checked or
            a field already has a value).

            Use this when the user asks what is on the page, what they can do here, or wants to
            interact with a control."""
            if not body.snapshot.strip():
                return (
                    "No element map available for this page. It may be a browser-internal page, "
                    "or it may not have finished loading."
                )
            return body.snapshot
    else:
        @tool
        async def read_page() -> str:
            """List the interactive elements on the current page: buttons, links, text inputs,
            checkboxes, dropdowns. Each line gives a number, the element's role, its visible
            label, and its current state (for example whether a checkbox is already checked or
            a field already has a value).

            Element numbers are only valid until the page changes. act and goto return an
            updated map themselves, so you do not need to call this after them — only call it
            again if that map looks empty or is missing something you expected."""
            return await client_call("read_page", {})

        # Fetched when the tool runs, never captured up front: goto and act move the page
        # mid-turn, so send-time text describes wherever the agent used to be. The cap
        # lives at module scope beside the retrieval sizes it has to stay in step with.

        @tool
        async def read_text() -> str:
            """Read the current page's visible text.

            Use this to answer any question about what a page says — its content, facts,
            details, what an article covers. For the page's buttons and inputs, so you can
            act on them, use read_page instead."""
            text = (await client_call("read_text", {}) or "").strip()
            if not text:
                return ("No text on this page. It may be a browser-internal page, or it may "
                        "not have finished loading.")
            if len(text) > MAX_TEXT_CHARS:
                return text[:MAX_TEXT_CHARS] + "\n\n[Truncated — the page is very long]"
            return text

        @tool
        async def act(actions: list[dict]) -> str:
            """Perform actions on the page. Each action needs a "verb" and usually the "id"
            of an element from read_page.

            Verbs:
              click   {"verb":"click","id":15}
              type    {"verb":"type","id":12,"text":"hello"}
              clear   {"verb":"clear","id":12}
              check   {"verb":"check","id":16}      — idempotent; never toggles a set box
              uncheck {"verb":"uncheck","id":16}
              select  {"verb":"select","id":30,"value":"India"}   — native <select> only
              press   {"verb":"press","id":12,"key":"Enter"}
              hover   {"verb":"hover","id":20}
              scroll  {"verb":"scroll","direction":"down"}        — or "up"/"top"/"bottom"
              submit  {"verb":"submit","id":19}
              wait    {"verb":"wait"}
              back    {"verb":"back"}      — browser Back, to return to a list you came from
              forward {"verb":"forward"}

            press, submit, scroll, wait, back and forward also work with NO id, acting on
            whatever has focus. That is your way in when a control is on screen but missing from the
            map — a dialog normally focuses its input as it opens, so a bare press can
            type into something you cannot address by number.

            wait on its own — act with [{"verb":"wait"}] — settles the page and returns a
            fresh map. Use it when a map looks incomplete, before assuming anything is
            missing.

            Actions run in order and STOP after the first click, press or submit, because
            those change the page and every id after them may be stale. Group your fills
            together and put the click last, then read the returned snapshot to continue.

            A dropdown that is not a native <select> cannot be set in one step: click it to
            open, read the new snapshot, then click the option.

            Returns what happened plus a fresh snapshot of the page."""
            return await client_call("act", {"actions": actions})

        @tool
        def ask_user(question: str, kind: str = "text", options: Optional[list] = None) -> str:
            """Ask the user for something you need before you can continue: a value for a
            form field, a choice between paths, a detail only they know.

            Also use it when you are stuck — the page is not behaving as expected, or a
            control you need is not in the element map. They are looking at the screen and
            you are not. "I clicked X but I cannot see a text box — what do you see?" keeps
            the task alive where reporting failure ends it.

            Prefer this over guessing, and over ending your turn to ask in prose — this
            keeps the task running, and their answer comes straight back to you.

            kind:
              "text"   free-form answer (default)
              "choice" pick one of `options`
              "secret" a password or other value that must stay hidden
            """
            # Unreachable in normal operation: HumanInTheLoopMiddleware gates this with
            # allowed_decisions=["respond"], so the human's answer replaces the call and
            # the body never runs. It only fires if the gate is somehow absent.
            return "The question could not be put to the user, so it went unanswered."

        @tool
        async def goto(url: str) -> str:
            """Go to a web address, navigating the tab you are working in.

            Returns the new page's element map, so you can act on it straight away without
            calling read_page first. Element numbers from the previous page are dead the
            moment this returns.
            """
            return await client_call("goto", {"url": url})

        tools.append(read_text)
        tools.append(act)
        tools.append(ask_user)
        tools.append(goto)

    tools.append(read_page)

    # ── Retrieval over the page's text ────────────────────────────────────────
    embedding = _resolve_embedding(provider, token) if token else None

    @tool
    async def search_page(query: str) -> str:
        """Search the current page for the passages relevant to a query.

        Use this to answer any question about what the page says. Returns the matching
        passages, not the whole page, so call it again with different wording if the
        first result does not contain the answer."""
        chunks = await page_text.chunks()
        if not chunks:
            return ("No text on this page. It may be a browser-internal page, or it may "
                    "not have finished loading.")
        # sklearn is synchronous and CPU-bound; off the event loop so a long page cannot
        # stall the socket that is streaming this turn.
        found = await run_in_threadpool(_rank_chunks, query, chunks, embedding)
        return found or "Nothing on this page matched that."

    @tool
    async def summarize_page() -> str:
        """Return the page's full visible text, for a summary or an overview.

        Use this when the user wants the whole page rather than one detail from it."""
        body_text = await page_text.text()
        if not body_text:
            return ("No text on this page. It may be a browser-internal page, or it may "
                    "not have finished loading.")
        if len(body_text) > MAX_SUMMARY_CHARS:
            return body_text[:MAX_SUMMARY_CHARS] + "\n\n[Truncated — the page is very long]"
        return body_text

    tools.append(search_page)
    tools.append(summarize_page)

    # ── Handing a turn to the page tools ──────────────────────────────────────
    if escalation is not None:
        @tool
        def escalate(reason: str) -> str:
            """Hand this request to the page-action tools, which can click, type and
            navigate. Call it as soon as the request needs one of those, with a one-line
            reason, and then stop."""
            escalation.reason = reason or "the request needs page actions"
            return ("Handed to the page tools. Stop here and add nothing further — the "
                    "task continues there.")

        tools.append(escalate)

    composio_key = (body.tool_keys or {}).get("composio")
    if composio_key:
        from composio import Composio
        from composio_langchain import LangchainProvider
        composio = Composio(api_key=composio_key, provider=LangchainProvider())
        session = composio.create(user_id="default")
        tools.extend(session.tools())

    # The registry, not a branch per lane, decides what this turn is allowed to hold.
    return [t for t in tools if lane in _cap(getattr(t, "name", "")).lanes]


def _build_agent(llm, tools: list, lane: str = LANE_OPERATE,
                 interrupt_on: Optional[dict] = None, checkpointer=None,
                 page_hint: str = ""):
    """create_agent (langchain>=1) over langgraph's create_react_agent: the same
    tool-calling loop, but it accepts middleware. Order matters — first listed is
    outermost, so the call limits sit outside everything and cannot be bypassed.

    The system prompt is composed from `lane` and the tools actually passed in, so a lane
    never carries instructions for tools it does not have.

    `interrupt_on`/`checkpointer` are supplied only by the socket transport. Interrupts
    require checkpointing, and a POST has no way to ask a human anyway, so it passes
    neither and behaves exactly as before.
    """
    middleware = [
        # exit_behavior="end" (not "error") so an exhausted turn returns the partial
        # answer instead of collapsing the stream into an error frame.
        ModelCallLimitMiddleware(run_limit=MODEL_CALL_LIMIT, exit_behavior="end"),
        ToolCallLimitMiddleware(run_limit=TOOL_CALL_LIMIT),
        RepeatedToolCallGuard(),
    ]

    # Sits inside the limits but outside error handling and context editing: a call the
    # human rejected must never reach the tool, and a rejection is not a tool error.
    if interrupt_on:
        middleware.append(HumanInTheLoopMiddleware(interrupt_on=interrupt_on))

    middleware += [
        ToolErrorMiddleware(_on_tool_error),
        # Where the tokens actually are: the ReAct loop re-sends the whole transcript on
        # every model call, so k element maps cost O(k^2). This drops every map but the
        # current one on every call — unconditionally, with no trigger to cross — while
        # keeping the outcome lines that tell the agent what it has already done.
        TrimSupersededMaps(),
        # Backstop for page *text*, which has no separable outcome line and so can only be
        # cleared wholesale. High trigger: a summary or a quote may legitimately need text
        # from several steps back, and unlike a stale map it does not go wrong with age.
        #
        # exclude_tools is not optional — without it this undoes TrimSupersededMaps above and
        # re-creates the exact loop its docstring describes. ClearToolUsesEdit replaces a
        # tool message's content with "[cleared]", and because it runs INSIDE the trim it
        # lands on messages whose map is already gone, so the only thing left to destroy is
        # `ok: clicked "..."` — the agent's sole memory of its own work. That is invisible on
        # a one-step task and fatal on a multi-step one: the transcript crosses the trigger
        # about two maps in, and from there the agent cannot see that it already opened the
        # page it is standing on, so it opens it again.
        #
        # Trimmed act/goto results are ~20 tokens of outcome line, so excluding them costs
        # almost nothing and leaves this aimed at what it was sized for: read_text and the
        # retrieval tools, which are genuinely large and genuinely disposable.
        ContextEditingMiddleware(edits=[
            ClearToolUsesEdit(trigger=TEXT_CLEAR_TRIGGER, keep=2,
                              exclude_tools=("act", "goto")),
        ]),
    ]

    return create_agent(
        model=llm,
        tools=tools,
        system_prompt=_lane_prompt(tools, page_hint),
        middleware=middleware,
        checkpointer=checkpointer,
    )


def _build_messages(query: str) -> list:
    """The turn's messages: the request, and nothing before it.

    This is a task runner, not a chat. "Open wikipedia, search ronaldo and tell me about
    him" is a whole job on its own, and it completes inside one turn — the tool loop, the
    element maps, ask_user and the approvals all live there. Prose from *earlier* turns
    would only add cost (it was billed again on every model call of the loop, unbounded,
    because the old cap counted messages rather than tokens) and offer the model context
    from a page it may no longer be on.

    The trade is deliberate: a follow-up like "now the next one" has nothing to refer to,
    so a request has to say what it wants.
    """
    from langchain_core.messages import HumanMessage
    return [HumanMessage(content=query)]


def _flatten(content) -> str:
    if isinstance(content, list):
        return "".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content
        )
    return content if isinstance(content, str) else ""


class Usage:
    """Token total for one turn, across every model call it makes.

    Kept per model call and combined with max(), never by summing what arrives. That is
    not defensive style, it is required: Groq emits its usage block twice in a stream, and
    langchain's chunk aggregation adds the two, so a summing counter reports exactly double
    (334 where the API charged 167). Input tokens are a property of a request, not a
    quantity that accumulates within one, so the largest value seen for a call is the true
    one whether the provider reports it once, twice, or incrementally.

    Keyed on the message id, which every chunk of a single completion shares.
    """

    def __init__(self) -> None:
        self._calls: dict[str, tuple[int, int]] = {}
        self._anon = 0

    def observe(self, call_id: Optional[str], meta) -> None:
        if not isinstance(meta, dict):
            return
        got = (int(meta.get("input_tokens") or 0), int(meta.get("output_tokens") or 0))
        if not call_id:
            # No id to key on — count it as its own call rather than merging it into
            # another and under-reporting.
            self._anon += 1
            call_id = f"anon{self._anon}"
        have = self._calls.get(call_id, (0, 0))
        self._calls[call_id] = (max(have[0], got[0]), max(have[1], got[1]))

    @property
    def input(self) -> int:
        return sum(i for i, _ in self._calls.values())

    @property
    def output(self) -> int:
        return sum(o for _, o in self._calls.values())

    @property
    def calls(self) -> int:
        return len(self._calls)

    def frame(self) -> dict:
        return {"usage": {"input":  self.input,
                          "output": self.output,
                          "total":  self.input + self.output,
                          "calls":  self.calls}}


async def _stream_agent(
    agent,
    messages: list,
    timeout: int,
    provider: str,
    config: Optional[dict] = None,
    on_interrupt=None,
    usage: Optional["Usage"] = None,
    emit_usage: bool = True,
):
    """Yield frames as plain dicts, so /chat can wrap them as SSE and /chat/ws can send
    them as JSON without either transport inventing its own vocabulary.

    Two stream modes at once:
      • "messages" → token-by-token text deltas (keeps the answer streaming live)
      • "updates"  → complete messages at each node boundary, so tool calls arrive with
                     full args and tool results (ToolMessages) can be forwarded.
    The frontend classifies text into "reasoning" vs "answer" by event ordering: a step
    whose text is followed by a tool call is reasoning; the final tool-less text is the
    answer.

    `on_interrupt(hitl_request) -> decisions | None` turns this into a resume loop:
    HumanInTheLoopMiddleware pauses the graph, we ask the panel, and feed the answer back
    with Command(resume=...) so the SAME run continues. Callers without it (the POST
    transport, which has no way to ask) simply never interrupt.
    """
    yield {"status": "started"}

    # Hoisted out of the astream call on purpose: a resumed pass replays messages the panel
    # has already been told about, so per-pass dedupe sets would duplicate rail rows on
    # every approval. Middleware nodes ("<name>.before_model") and ContextEditingMiddleware
    # rewriting the message list can do the same within a single pass.
    seen_tool_ids   = set()
    seen_result_ids = set()

    stream_input: Any = {"messages": messages}
    rounds = 0

    try:
        while True:
            pending = None

            # The timeout bounds *agent* work per pass, not the human's thinking time —
            # a slow approval must not read as "the LLM timed out".
            async with asyncio.timeout(timeout):
                async for mode, data in agent.astream(
                    stream_input, config=config, stream_mode=["messages", "updates"]
                ):
                    # ── token deltas: stream text from the model node only ──────
                    if mode == "messages":
                        msg, metadata = data
                        if metadata.get("langgraph_node") == "tools":
                            continue
                        if usage is not None and getattr(msg, "usage_metadata", None):
                            usage.observe(getattr(msg, "id", None), msg.usage_metadata)
                        text = _flatten(getattr(msg, "content", None))
                        if text:
                            yield {"text": text}
                        continue

                    # ── the graph paused for a human ────────────────────────────
                    # Handled before the node loop because __interrupt__'s value is a
                    # tuple of Interrupt, not a node update, so the messages branch below
                    # would silently drop it.
                    if INTERRUPT_KEY in data:
                        entries = data[INTERRUPT_KEY]
                        if entries:
                            pending = entries[0]
                        continue

                    # ── node boundaries: tool calls (with args) + tool results ──
                    for node, upd in data.items():
                        node_msgs = upd.get("messages", []) if isinstance(upd, dict) else []
                        for m in node_msgs:
                            if node == "tools" or getattr(m, "type", None) == "tool":
                                result_id = getattr(m, "tool_call_id", None)
                                if result_id is not None and result_id in seen_result_ids:
                                    continue
                                seen_result_ids.add(result_id)
                                summary = _flatten(getattr(m, "content", "")) or str(getattr(m, "content", ""))
                                yield {"tool_result": {
                                    "id": result_id,
                                    "name": getattr(m, "name", ""),
                                    "summary": summary[:300],
                                }}
                                continue
                            for tc in (getattr(m, "tool_calls", None) or []):
                                tc_id = tc.get("id")
                                if tc_id in seen_tool_ids:
                                    continue
                                seen_tool_ids.add(tc_id)
                                try:
                                    args = tc.get("args", {})
                                    json.dumps(args)
                                except (TypeError, ValueError):
                                    args = {}
                                yield {"tool": {"name": tc.get("name"), "args": args, "id": tc_id}}

            if pending is None or on_interrupt is None:
                break

            rounds += 1
            if rounds > MAX_HITL_ROUNDS:
                yield {"error": f"Stopped after {MAX_HITL_ROUNDS} approval requests in one turn."}
                break

            decisions = await on_interrupt(getattr(pending, "value", pending))
            if not decisions:
                yield {"error": "The approval request went unanswered, so the run stopped."}
                break

            # The middleware raises ValueError unless there is exactly one decision per
            # hanging tool call, so the shape is the caller's contract, not a suggestion.
            stream_input = Command(resume={"decisions": decisions})

    except TimeoutError:
        yield {"error": f"LLM timed out after {timeout}s."}
    except Exception as e:
        yield {"error": _sse_error_handler(e, provider)}
    finally:
        if emit_usage and usage is not None and usage.calls:
            yield usage.frame()
        yield {"done": True}


async def _stream_chat(llm, messages: list, timeout: int, provider: str,
                       usage: Optional["Usage"] = None, emit_usage: bool = True):
    """The chat lane: stream the model with no tools at all.

    Not an agent with an empty tool list — a plain model call. That is both the cheapest
    turn the server can serve and the reason a conversational message can never trip an
    approval prompt or a page action: there is nothing there to trip.
    """
    yield {"status": "started"}
    try:
        async with asyncio.timeout(timeout):
            async for chunk in llm.astream([("system", PROMPT_BASE), *messages]):
                text = _flatten(getattr(chunk, "content", None))
                if text:
                    yield {"text": text}
                if usage is not None and getattr(chunk, "usage_metadata", None):
                    usage.observe(getattr(chunk, "id", None), chunk.usage_metadata)
    except TimeoutError:
        yield {"error": f"LLM timed out after {timeout}s."}
    except Exception as e:
        yield {"error": _sse_error_handler(e, provider)}
    finally:
        if emit_usage and usage is not None and usage.calls:
            yield usage.frame()
        yield {"done": True}


async def _with_route(lane: str, frames):
    """Announce the lane before the turn starts.

    Worth a frame of its own: when a turn behaves oddly the first question is always
    which lane took it, and guessing from the tool calls is how misroutes stay invisible.
    """
    yield {"route": lane}
    async for frame in frames:
        yield frame


async def _sse(frames):
    """Wrap the shared frame stream in the SSE envelope the panel already parses."""
    async for frame in frames:
        if frame.get("done"):
            yield "data: [DONE]\n\n"
        else:
            yield f"data: {json.dumps(frame)}\n\n"


# ── /chat endpoint ────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    query:      str
    # Numbered element map built by content.js, captured at send time. Only the POST
    # fallback reads it — over a socket read_page fetches a live one instead. It also
    # seeds the generation that content.js checks before it will act.
    snapshot:   str                  = ""
    # The page's visible text at send time. Only the POST fallback uses it — over a socket
    # PageText fetches the live text instead, since goto and act move the page mid-turn.
    text:       str                  = ""
    # "restricted" (default) asks before consequential page actions; "unrestricted" runs
    # them without asking. External side effects ask in either mode. Session-scoped in the
    # panel, so it is never remembered across reopens.
    mode:       str                  = "restricted"
    model:      Optional[str]        = None
    # Accepted and ignored: turns are independent, see _build_messages. Kept on the schema
    # so a panel build that still sends it does not fail validation, and so restoring
    # conversational turns is a one-line change rather than a protocol change.
    history:    Optional[list[dict]] = None
    tool_keys:  Optional[dict]       = None


@app.post("/chat")
async def chat(
    body: ChatRequest,
    token:    str = Header(..., alias="Token"),
    provider: str = Header(..., alias="Provider"),
):
    """Single-shot turn. The model can read the page but not act on it: a plain POST has
    no way to call back into the panel mid-request, so the page-action tools are only
    offered over /chat/ws."""
    token    = token.strip()
    provider = provider.lower()

    if not token:
        raise HTTPException(status_code=400, detail="No API key provided. Open Settings and add your key.")

    try:
        llm = _resolve_llm(provider, token, body.model)
    except Exception as e:
        if _is_auth_error(e):
            raise HTTPException(status_code=401, detail=f"Invalid API key for {provider}. Check your key in Settings.")
        raise HTTPException(status_code=500, detail=f"Server error ({provider}): {e}")

    # No client_call over a POST, so the operate lane is unreachable here and the router
    # is not offered it. Page questions still work: PageText falls back to the send-time
    # text the panel included.
    usage      = Usage()
    lane, _err = await _route(llm, body, allow_browser=False, usage=usage)
    tools      = _build_tools(body, None, lane, provider=provider, token=token)
    messages   = _build_messages(body.query)

    # No escalation on this transport. It would need a second pass mid-stream, and the
    # only lane worth escalating *to* — operate — is unavailable here anyway. The cost is
    # that a turn the router sends to `chat` cannot reach the page even if it turns out to
    # need it; the socket transport, which the panel prefers, has the hop.
    if not tools:
        frames = _stream_chat(llm, messages, LLM_TIMEOUT, provider, usage=usage)
    else:
        agent  = _build_agent(llm, tools, lane,
                              page_hint=_page_hint(body.snapshot))
        frames = _stream_agent(agent, messages, LLM_TIMEOUT, provider, usage=usage)

    return StreamingResponse(_sse(_with_route(lane, frames)), media_type="text/event-stream")


# ── /chat/ws endpoint ─────────────────────────────────────────────────────────
# The agent runs here but its page tools execute in the browser, so they have to call
# *out* mid-run. A socket lets one uninterrupted agent run do the whole task: the tool
# coroutine sends a request down the wire and awaits the reply.
#
# The alternative — ending the stream on every tool call and having the panel re-POST an
# extended transcript — would mean round-tripping AIMessage(tool_calls=[...]) with matching
# ToolMessage(tool_call_id=...), since providers reject a transcript where a tool call went
# unanswered. This avoids that entirely, and needs no checkpointer, so `workers` stays > 1:
# the connection itself is the affinity.

@app.websocket("/chat/ws")
async def chat_ws(ws: WebSocket):
    await ws.accept()

    try:
        init = await ws.receive_json()
    except Exception:
        await ws.close(code=1003)
        return

    # Credentials arrive in the first frame rather than as headers: browsers cannot set
    # custom headers on a WebSocket handshake. Over wss:// both are equally encrypted.
    token    = str(init.get("token") or "").strip()
    provider = str(init.get("provider") or "").lower()

    if not token:
        await ws.send_json({"error": "No API key provided. Open Settings and add your key."})
        await ws.send_json({"done": True})
        await ws.close()
        return

    try:
        body = ChatRequest(**{k: v for k, v in init.items() if k in ChatRequest.model_fields})
    except Exception as e:
        await ws.send_json({"error": f"Bad request: {e}"})
        await ws.send_json({"done": True})
        await ws.close()
        return

    try:
        llm = _resolve_llm(provider, token, body.model)
    except Exception as e:
        detail = (f"Invalid API key for {provider}. Check your key in Settings."
                  if _is_auth_error(e)
                  else f"Server error ({provider}): {e}")
        await ws.send_json({"error": detail})
        await ws.send_json({"done": True})
        await ws.close()
        return

    # ── Bridge: a tool call here becomes a request to the panel ────────────────
    # Two kinds of round trip share the socket and the same future map: `client_tool` runs
    # a tool in the browser (the graph stays inside the tool call), and `hitl` asks a human
    # (the graph has actually paused). They are told apart by the reply's key.
    pending: dict[str, asyncio.Future] = {}
    counter = 0
    page = PageContext()

    def _await_panel(kind: str, payload: dict, timeout: int):
        nonlocal counter
        counter += 1
        req_id = f"{kind}{counter}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        pending[req_id] = fut

        async def run():
            try:
                await ws.send_json({kind: {"id": req_id, **payload}})
                return await asyncio.wait_for(fut, timeout=timeout)
            finally:
                pending.pop(req_id, None)

        return run()

    async def client_call(name: str, args: dict) -> str:
        try:
            # Bounded so a panel that never answers — a closed side panel, say — fails the
            # tool instead of wedging the whole run until the outer timeout.
            result = await _await_panel("client_tool", {"name": name, "args": args},
                                        CLIENT_TOOL_TIMEOUT)
        except asyncio.TimeoutError:
            return (f"The browser did not respond within {CLIENT_TOOL_TIMEOUT}s. "
                    "The panel may be closed. Tell the user the action could not be performed.")
        except Exception as e:
            return f"Could not reach the browser: {e}"

        text = str(result)
        # Every snapshot passes through here, which is the only way the approval gate ever
        # learns that element 15 is called "Delete account".
        if name in ("read_page", "act"):
            page.observe(text)
        return text

    async def on_interrupt(hitl_request):
        """Put a paused graph in front of the user and return their decisions.

        HumanInTheLoopMiddleware requires exactly one decision per hanging tool call, so a
        short reply is padded with rejections rather than allowed to raise.
        """
        requests = (hitl_request or {}).get("action_requests") or []
        want = len(requests) or 1
        reject = [{"type": "reject", "message": "The user did not respond in time."}] * want

        try:
            answer = await _await_panel("hitl", {"request": hitl_request}, HITL_TIMEOUT)
        except asyncio.TimeoutError:
            return reject
        except Exception:
            return reject

        decisions = (answer or {}).get("decisions") if isinstance(answer, dict) else None
        if not isinstance(decisions, list) or not decisions:
            return reject
        if len(decisions) < want:
            decisions = decisions + reject[len(decisions):]
        return decisions[:want]

    async def pump():
        """Resolve replies from the panel. Runs concurrently with the agent, because the
        agent is writing frames out on the same socket while we read replies in."""
        while True:
            msg = await ws.receive_json()
            for key in ("client_tool_result", "hitl_decision"):
                payload = msg.get(key)
                if not isinstance(payload, dict):
                    continue
                fut = pending.get(payload.get("id"))
                if fut is not None and not fut.done():
                    # client tools answer with text; HITL answers with a decisions object.
                    fut.set_result(payload if key == "hitl_decision"
                                   else str(payload.get("result", "")))

    reader = asyncio.create_task(pump())

    try:
        # Page text is fetched by the tools that need it, once per turn, and never up
        # front: over a socket goto and act move the page mid-turn, so send-time text
        # would describe wherever the tab used to be.
        page_text = PageText(fetch=client_call)
        usage     = Usage()
        messages  = _build_messages(body.query)

        lane, _err = await _route(llm, body, allow_browser=True, usage=usage)

        # One hop only, and it is the transport that enforces it: the second pass is built
        # without an Escalation, so the operate lane has no escalate tool to call and the
        # handoff cannot become a loop.
        for hop in range(2):
            escalation = Escalation() if (hop == 0 and lane in ESCALATING_LANES) else None
            tools = _build_tools(body, client_call, lane, page_text=page_text,
                                 escalation=escalation, provider=provider, token=token)

            await ws.send_json({"route": lane})

            if not tools:
                frames = _stream_chat(llm, messages, WS_TIMEOUT, provider,
                                      usage=usage, emit_usage=False)
            else:
                agent = _build_agent(
                    llm, tools, lane,
                    interrupt_on=_hitl_config(body.mode, [t.name for t in tools], page),
                    page_hint=_page_hint(body.snapshot),
                    # Interrupts need checkpointing. In-memory is right here and not a
                    # compromise: the run lives and dies with this connection, which pins
                    # it to one worker, so nothing has to be shared across processes.
                    checkpointer=InMemorySaver(),
                )
                frames = _stream_agent(
                    agent, messages, WS_TIMEOUT, provider,
                    config={"configurable": {"thread_id": uuid.uuid4().hex}},
                    on_interrupt=on_interrupt,
                    usage=usage,
                    # A turn may run two passes, so end-of-turn belongs to the transport,
                    # not to either pass.
                    emit_usage=False,
                )

            async for frame in frames:
                if frame.get("done"):
                    continue
                await ws.send_json(frame)

            if escalation is None or not escalation.requested:
                break
            lane = LANE_OPERATE

        # One total for the whole turn, both passes included, and always before `done` —
        # the panel stops reading at `done`.
        if usage.calls:
            await ws.send_json(usage.frame())
        await ws.send_json({"done": True})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"error": _sse_error_handler(e, provider)})
            await ws.send_json({"done": True})
        except Exception:
            pass
    finally:
        reader.cancel()
        # Anything still waiting on the panel will never be answered now.
        for fut in pending.values():
            if not fut.done():
                fut.cancel()
        try:
            await ws.close()
        except Exception:
            pass


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    # Locally, pick up edits without a manual restart. The failure mode otherwise is
    # silent: the extension keeps working, just against whatever tool list the running
    # process was started with. reload and workers are mutually exclusive in uvicorn.
    on_render = bool(os.environ.get("RENDER"))
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5000)),
        **({"workers": 4} if on_render else {"reload": True}),
    )
