import asyncio
import json
import os
import re
import uuid
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
from langchain_text_splitters import RecursiveCharacterTextSplitter
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

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

SYSTEM_PROMPT = (
    "You are SiteWhisper, a helpful AI assistant. "
    "You have access to tools — use them when they can help answer the user's question. "
    "If no tool is needed, answer directly from your knowledge.\n\n"
    "Handling tool failures: if a tool call fails or returns an error, do NOT reissue the "
    "same call with the same arguments. Read the error, correct the arguments, and try once "
    "more. If it fails again, stop and tell the user what went wrong.\n\n"
    "Missing information: when you need something only the user can supply — a value for a "
    "form field, a choice between paths, a detail you would otherwise be guessing at — call "
    "the ask_user tool. Do not invent the value, and do not end your turn to ask in prose: "
    "ask_user keeps the task running and brings their answer straight back to you.\n\n"
    "Some actions pause for the user's approval. If one comes back rejected, do not retry "
    "it — say what you were going to do and let them decide.\n\n"
    "Moving between pages: if a link to where you want to go is visible on the page, click "
    "it — only use goto when you know the address or the user gave you one. Guessing a URL "
    "usually lands on a missing page.\n\n"
    "After an action: act and goto both return the page's element map as it is after they "
    "ran, so use it directly rather than calling read_page to confirm. Element numbers "
    "belong to one page — ids from before a navigation are dead. If the returned map looks "
    "empty or is missing something you expected, the page was probably still loading; then "
    "call read_page again."
)


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
    """Refuse a tool call already made with byte-identical arguments.

    ToolCallLimitMiddleware caps calls per tool *name*, which cannot catch this without
    knowing the offending name up front — and with Composio the real action is a
    parameter, not the tool name. Matching on (name, args) instead is name-agnostic.

    State is per-instance, which is per-request here: the agent (and so this middleware)
    is constructed inside the request handler, not cached like the LLM clients are.
    """

    def __init__(self, limit: int = IDENTICAL_CALL_LIMIT) -> None:
        super().__init__()
        self.limit  = limit
        self.tools  = []          # registers no tools of its own
        self._seen: dict[str, int] = {}

    def _exhausted(self, request) -> bool:
        call = getattr(request, "tool_call", None) or {}
        try:
            args = json.dumps(call.get("args", {}), sort_keys=True, default=str)
        except (TypeError, ValueError):
            args = str(call.get("args"))
        key = f"{call.get('name')}::{args}"
        self._seen[key] = self._seen.get(key, 0) + 1
        return self._seen[key] > self.limit

    def _refusal(self, request) -> ToolMessage:
        call = getattr(request, "tool_call", None) or {}
        return ToolMessage(
            content=(
                f"Blocked: '{call.get('name')}' was already called {self.limit} time(s) "
                "with these exact arguments without succeeding. Change the arguments or "
                "tell the user it failed."
            ),
            tool_call_id=call.get("id") or "",
            name=call.get("name") or "",
            status="error",
        )

    # Both paths implemented: /chat streams via astream(), but a sync entry point
    # would otherwise raise NotImplementedError.
    def wrap_tool_call(self, request, handler):
        return self._refusal(request) if self._exhausted(request) else handler(request)

    async def awrap_tool_call(self, request, handler):
        if self._exhausted(request):
            return self._refusal(request)
        return await handler(request)


# ── Cached client factories ────────────────────────────────────────────────────

@lru_cache(maxsize=256)
def get_openai_clients(token: str, model_id: str):
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    embedding = OpenAIEmbeddings(model="text-embedding-3-small", openai_api_key=token)
    llm       = ChatOpenAI(model=model_id, openai_api_key=token, streaming=True)
    return llm, embedding


@lru_cache(maxsize=256)
def get_gemini_clients(token: str, model_id: str):
    from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
    embedding = GoogleGenerativeAIEmbeddings(model="gemini-embedding-001", google_api_key=token)
    llm       = ChatGoogleGenerativeAI(model=model_id, google_api_key=token, streaming=True)
    return llm, embedding


@lru_cache(maxsize=256)
def get_claude_client(token: str, model_id: str):
    from langchain_anthropic import ChatAnthropic
    return ChatAnthropic(model=model_id, anthropic_api_key=token, streaming=True)


# ── Helpers ────────────────────────────────────────────────────────────────────

def get_top_chunks(query: str, chunks: list, embedding=None) -> str:
    if not chunks:
        return ""
    if embedding:
        doc_vectors  = embedding.embed_documents(chunks)
        query_vector = embedding.embed_query(query)
        scores = cosine_similarity([query_vector], doc_vectors)[0]
    else:
        vectorizer = TfidfVectorizer()
        matrix     = vectorizer.fit_transform(chunks + [query])
        scores     = cosine_similarity(matrix[-1], matrix[:-1])[0]
    top_indices = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)[:3]
    return "\n\n".join(chunks[i] for i, _ in top_indices)


def _resolve_llm(provider: str, token: str, model: Optional[str], gemini_key: Optional[str] = None):
    if provider == "openai":
        model_id = model or "gpt-4.1-mini"
        return get_openai_clients(token, model_id)
    if provider == "gemini":
        model_id = model or "gemini-2.5-flash"
        return get_gemini_clients(token, model_id)
    if provider == "claude":
        model_id = model or "claude-haiku-4-5"
        llm = get_claude_client(token, model_id)
        if gemini_key:
            from langchain_google_genai import GoogleGenerativeAIEmbeddings
            embedding = GoogleGenerativeAIEmbeddings(model="gemini-embedding-001", google_api_key=gemini_key)
            return llm, embedding
        return llm, None
    raise ValueError(f"Unsupported provider: {provider}")


def _sse_error_handler(e: Exception, provider: str) -> str:
    msg = str(e).lower()
    if any(k in msg for k in ("api key", "apikey", "authentication", "unauthorized", "invalid")):
        return f"Invalid API key for {provider}. Check your key in Settings."
    return f"Stream error ({provider}): {e}"


# ── Page context: what the server knows about the page it is acting on ────────
# Mirrors the snapshot format content.js emits, e.g.  [15] button "Delete account"
SNAPSHOT_LINE = re.compile(r'^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?')


def _snapshot_elements(text: str) -> dict:
    """Parse a snapshot back into {id: (role, name)}."""
    found = {}
    for line in (text or "").splitlines():
        m = SNAPSHOT_LINE.match(line)
        if m:
            found[int(m.group(1))] = (m.group(2), m.group(3) or "")
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
    "search_page", "summarize_page", "read_page", "act", "ask_user",
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
    cfg: dict = {
        # Asking the user for information is not a restriction, it is the agent doing its
        # job, so it stays on in both modes.
        "ask_user": {"allowed_decisions": ["respond"]},
    }

    if mode != "unrestricted":
        cfg["act"] = {
            "allowed_decisions": ["approve", "reject"],
            "when":              ctx.needs_approval,
            "description":       ctx.describe_act,
        }

    for name in tool_names:
        if name not in SAFE_TOOL_NAMES:
            cfg[name] = {"allowed_decisions": ["approve", "reject"]}

    return cfg


# ── Agent assembly, shared by both transports ─────────────────────────────────

def _chunk_page(text: str) -> list:
    if not text.strip():
        return []
    splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
    return splitter.split_text(text)


def _build_tools(body: "ChatRequest", embedding, chunks: list, client_call=None) -> list:
    """Assemble the tool list.

    `client_call(name, args)` is an awaitable that runs a tool *in the browser* and
    returns its result. It is only available over the WebSocket transport, because a
    plain POST has no way to call back into the panel mid-request. When it is absent the
    page-action tools are simply not offered, so the model is never shown a tool it
    cannot use.
    """

    @tool
    def search_page(query: str) -> str:
        """Find specific information in the current page's text.

        Use this for any question about what the page says — facts, details, what it
        covers on a topic. Returns only the passages relevant to the query."""
        if not chunks:
            return "No page content available."
        try:
            return get_top_chunks(query, chunks, embedding)
        except Exception:
            return get_top_chunks(query, chunks, None)

    @tool
    def summarize_page() -> str:
        """Return the page's entire text.

        Use only when the user explicitly asks for a summary, an overview, or the full
        contents. This returns a lot of text — for a specific question about the page,
        use search_page instead."""
        if not body.text.strip():
            return "No page content available."
        max_chars = 15000
        text = body.text.strip()
        if len(text) > max_chars:
            return text[:max_chars] + "\n\n[Content truncated — page is very long]"
        return text

    tools = [search_page, summarize_page]

    # ── read_page: live over a socket, otherwise the snapshot sent with the request ──
    if client_call is None:
        @tool
        def read_page() -> str:
            """List the interactive elements on the current page: buttons, links, text inputs,
            checkboxes, dropdowns. Each line gives a number, the element's role, its visible
            label, and its current state (for example whether a checkbox is already checked or
            a field already has a value).

            Use this when the user asks what is on the page, what they can do here, or wants to
            interact with a control. To read the page's TEXT instead, use search_page or
            summarize_page."""
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
            again if that map looks empty or is missing something you expected.

            To read the page's TEXT instead, use search_page or summarize_page."""
            return await client_call("read_page", {})

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

        tools.append(act)
        tools.append(ask_user)
        tools.append(goto)

    tools.append(read_page)

    composio_key = (body.tool_keys or {}).get("composio")
    if composio_key:
        from composio import Composio
        from composio_langchain import LangchainProvider
        composio = Composio(api_key=composio_key, provider=LangchainProvider())
        session = composio.create(user_id="default")
        tools.extend(session.tools())

    return tools


def _build_agent(llm, tools: list, interrupt_on: Optional[dict] = None, checkpointer=None):
    """create_agent (langchain>=1) over langgraph's create_react_agent: the same
    tool-calling loop, but it accepts middleware. Order matters — first listed is
    outermost, so the call limits sit outside everything and cannot be bypassed.

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
        # Drops superseded tool output once the window fills, keeping only the last
        # few results. Matters most once page snapshots arrive on every step.
        ContextEditingMiddleware(edits=[ClearToolUsesEdit(trigger=100_000, keep=3)]),
    ]

    return create_agent(
        model=llm,
        tools=tools,
        system_prompt=SYSTEM_PROMPT,
        middleware=middleware,
        checkpointer=checkpointer,
    )


def _build_messages(history, query: str) -> list:
    from langchain_core.messages import HumanMessage, AIMessage
    messages = []
    for h in (history or []):
        if h.get("role") == "user":
            messages.append(HumanMessage(content=h["content"]))
        elif h.get("role") == "assistant":
            messages.append(AIMessage(content=h["content"]))
    messages.append(HumanMessage(content=query))
    return messages


def _flatten(content) -> str:
    if isinstance(content, list):
        return "".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content
        )
    return content if isinstance(content, str) else ""


async def _stream_agent(
    agent,
    messages: list,
    timeout: int,
    provider: str,
    config: Optional[dict] = None,
    on_interrupt=None,
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
        yield {"done": True}


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
    text:       str                  = ""
    # Numbered element map built by content.js. Separate from `text` on purpose: `text` is
    # prose for answering questions, `snapshot` is the addressing scheme for acting.
    snapshot:   str                  = ""
    # "restricted" (default) asks before consequential page actions; "unrestricted" runs
    # them without asking. External side effects ask in either mode. Session-scoped in the
    # panel, so it is never remembered across reopens.
    mode:       str                  = "restricted"
    model:      Optional[str]        = None
    history:    Optional[list[dict]] = None
    gemini_key: Optional[str]        = None
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
        llm, embedding = _resolve_llm(provider, token, body.model, body.gemini_key)
    except Exception as e:
        msg = str(e).lower()
        if any(k in msg for k in ("api key", "apikey", "authentication", "unauthorized", "invalid")):
            raise HTTPException(status_code=401, detail=f"Invalid API key for {provider}. Check your key in Settings.")
        raise HTTPException(status_code=500, detail=f"Server error ({provider}): {e}")

    agent = _build_agent(llm, _build_tools(body, embedding, _chunk_page(body.text)))

    return StreamingResponse(
        _sse(_stream_agent(agent, _build_messages(body.history, body.query), LLM_TIMEOUT, provider)),
        media_type="text/event-stream",
    )


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
        llm, embedding = _resolve_llm(provider, token, body.model, body.gemini_key)
    except Exception as e:
        msg = str(e).lower()
        detail = (f"Invalid API key for {provider}. Check your key in Settings."
                  if any(k in msg for k in ("api key", "apikey", "authentication", "unauthorized", "invalid"))
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
        tools = _build_tools(body, embedding, _chunk_page(body.text), client_call)
        agent = _build_agent(
            llm, tools,
            interrupt_on=_hitl_config(body.mode, [t.name for t in tools], page),
            # Interrupts need checkpointing. In-memory is right here and not a compromise:
            # the run lives and dies with this connection, which pins it to one worker, so
            # nothing has to be shared across processes.
            checkpointer=InMemorySaver(),
        )
        async for frame in _stream_agent(
            agent, _build_messages(body.history, body.query), WS_TIMEOUT, provider,
            config={"configurable": {"thread_id": uuid.uuid4().hex}},
            on_interrupt=on_interrupt,
        ):
            await ws.send_json(frame)
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
