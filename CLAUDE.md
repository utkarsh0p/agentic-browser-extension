# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SiteWhisper — a Chrome MV3 side panel (vanilla JS, no build step) plus a FastAPI + LangGraph
backend. The agent runs on the server; its page tools run in the browser and are called back
out over a WebSocket mid-run. Users bring their own provider API key; it lives in
`chrome.storage.local` and is sent per request, never stored server-side.

`README.md` is unusually detailed and is the design document — read it before changing the
element map, the lane router, the approval gate, or the act batching rules.

## Commands

```bash
# Backend (from backend/)
pip install -r requirements.txt
python3 server.py                 # http://localhost:5000, uvicorn reload=True locally
docker compose up --build         # containerised, same port

# Extension
# chrome://extensions → Developer mode → Load unpacked → repo root.
# After editing content.js/background.js, hit reload on the extension card AND reload
# any open tab — a stale content script stays injected in already-loaded tabs.
# popup/ changes only need the side panel closed and reopened.
```

There is no test suite, no linter, no package.json, and no bundler. Verification is manual:
run the backend, load unpacked, drive a real page.

`backend/.env` holds only `LANGSMITH_*` tracing vars. Provider keys (`claude`/`gemini`/
`openai`/`groq`) arrive from the panel on each request — never add them to `.env` and never
read them from `os.environ`.

Switch the panel's target with the single `BACKEND` constant at the top of `popup/popup.js`.

## Architecture

```
popup/popup.js  ──ws /chat/ws──▶  backend/server.py
   ▲  client_tool / hitl frames ◀──┘   route → build lane tools+prompt → agent loop
   │
   └─ chrome.tabs.sendMessage ──▶ content.js  (element map, verbs)
```

**`content.js`** — page agent, injected declaratively for `<all_urls>` and on demand via
`chrome.scripting.executeScript` for tabs that predate the extension load. Guarded by
`window.__siteWhisper` against double-injection. Builds the numbered element map (a distilled
a11y tree, not markup) and executes the verbs. Answers two messages: `SW_SNAPSHOT` and
`SW_ACT`, both async (`return true`).

**`popup/popup.js`** (~2k lines, one IIFE) — conversation UI, reasoning rail, key setup, and
the client-tool executor. `runClientTool()` is where `read_page` / `read_text` / `act` / `goto`
actually happen. One conversation per browser *window*, persisted as a top-level
`panelChat:<windowId>` key; `background.js` deletes it on window close.

**`backend/server.py`** (~1.8k lines, single module) — router, lane/capability registry, tools,
middleware, and both transports.

### Invariants that span files

These will not fail loudly if broken:

- **Element ids are handles, not indices.** `content.js` assigns a number to an element the
  first time it is listed (`state.handles` WeakMap) and keeps it. Never renumber by position.
  Every act carries a `generation`; content.js refuses actions chosen from an older map.
- **The snapshot line format is parsed in three places** — `describe()` in `content.js`,
  `_snapshot_name`/`_snapshot_elements` in `server.py`, and `snapName`/`parseSnapshot` in
  `popup.js`. Changing the format means changing all three. The server only ever receives
  `{"verb":"click","id":15}`, so parsing the last snapshot is its only way to know 15 is
  "Delete account" — which is what the approval gate keys on.
- **`MODELS[provider][0]` in `popup.js` must equal that provider's default in `_resolve_llm`.**
  The panel falls back to `models[0]` when a stored selection disappears; a mismatch silently
  runs a different model than the picker shows.
- **The frame vocabulary is shared by both transports.** `text` / `tool` / `tool_result` /
  `route` / `usage` / `error` / `done`, dispatched in one place (`dispatchFrame` in
  `popup.js`). SSE wraps them in `data: `; the WebSocket sends them raw.
- **Turns are stateless.** `_build_messages` sends only the current query — no history. The
  panel stores and displays the transcript, but the model never sees it. `ChatRequest.history`
  is accepted and ignored on purpose.

### Adding a tool

1. Define it inside `_build_tools` in `server.py`.
2. Add one `CAPABILITIES` entry: which lanes may offer it, plus its prompt fragment. The
   system prompt is composed per lane from the fragments of the tools that lane received, so
   a lane never reads instructions for tools it lacks. Fragment order comes from
   `PROMPT_SEQUENCE` and is load-bearing (it was tuned by use).
3. If it runs in the browser, add a branch to `runClientTool` in `popup.js`; the server side
   is just `await client_call(name, args)`.
4. Observation-only tools must go in `OBSERVATION_TOOLS` — they are exempt from the repeat
   guard, because re-reading is how the agent recovers.
5. Step 2 is not optional. `DEFAULT_CAP` is fail-closed (`frozenset()`), so a tool with no
   `CAPABILITIES` entry is built and then filtered out of every lane — it simply never
   appears, rather than erroring.

### Lanes

Every turn is routed once by a structured-output call that sees only the three lane
descriptions — never the tool schemas — before any tools are built. This is a safety
property, not just a cost one: a `chat` turn *cannot* trigger a page action, because that
lane holds no such tool. Every lane but `operate` gets `escalate`, and the hop is enforced by
the transport (the second pass is built without an `escalate` tool), so it cannot loop.

### Two kinds of callback

Do not conflate them — they share the socket and the `pending` future map, and are told apart
by the reply key:

- **`client_tool`** — the graph does *not* pause. The tool coroutine sends a frame and awaits
  the reply inside its own call. No checkpointer needed.
- **`hitl`** — the graph genuinely pauses (`HumanInTheLoopMiddleware` + `InMemorySaver`), the
  panel renders the approval, and the answer resumes the same run. `InMemorySaver` is correct
  here: the run lives and dies with the connection, which pins it to one worker.

`POST /chat` is the fallback for backends or proxies that drop upgrades. It has no way to call
back into the panel, so the page-action tools are never offered there and the `operate` lane
is unreachable.

### Safety model

- Approvals are gated **only** on the server (`_hitl_config`). A second gate in the panel would
  double-ask; the old client-side refusal was removed deliberately.
- `restricted` (default) asks before submits, risky-named clicks (`RISKY_NAME`), and secret
  fields (`SECRET_FIELD`). `unrestricted` covers page actions only — external side effects ask
  in either mode. It is a plain variable, not storage, so it resets on every panel reopen.
- Secrets never reach the model: `ask_user` answers are stashed in the panel and swapped in by
  `fillSecrets` at the moment of typing.
- `goto` accepts `http`/`https` only (`safeUrl`), keeping the agent out of `javascript:`,
  `file:` and `chrome:`.
- An `act` batch stops after the first `click`/`press`/`submit`, because those invalidate later
  ids. The result leads with what actually happened before the fresh map — without that line, a
  click that opened a dialog and a click that did nothing look identical.

### Middleware

`_build_agent` stacks middleware that each address one observed failure mode: call limits
(partial answer, not an error, on exhaustion), `RepeatedToolCallGuard` (byte-identical action
refused since the last observation; `IDENTICAL_CALL_CEILING` catches the act/read_page
alternation that resets the per-observation counter), `ToolErrorMiddleware` (exception →
actionable message), `TrimSupersededMaps` (drops every element map but the current one while
keeping the outcome lines — the agent's only memory of its own work), and
`ContextEditingMiddleware` for page text.

## Style

The codebase carries dense explanatory comments that record *why* a decision was made, usually
naming the failure it prevents. Match that: when changing tuned behaviour, update the comment
that justifies it rather than leaving it stale.
