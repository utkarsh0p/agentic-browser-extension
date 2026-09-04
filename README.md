# SiteWhisper

A Chrome extension powered by a **LangGraph ReAct agent** that lives in your browser. It can read any webpage, search the web, and connect to 500+ apps — all from a chat side panel that docks beside the page and stays open while you browse.

---

## What It Does

- **Summarize pages** — get a full summary of any article or page in one click
- **Connect to 500+ apps** — via Composio meta tools, the agent can search for tools, connect to services (Gmail, Google Docs, Slack, etc.), and execute actions on your behalf
- **General AI chat** — works as a regular AI assistant when no page context is needed

---

## Architecture

```
User types question
        │
        ▼
   popup.js (side panel UI — one chat per window)
        │
        ├── chrome.tabs.sendMessage → content.js
        │       ├── SW_SNAPSHOT → numbered element map: 15 button Sign in
        │       └── SW_ACT      → click / type / check / select / press / scroll …
        │
        └── WebSocket /chat/ws  → FastAPI backend   (POST /chat as fallback)
                │
                ├── create_agent (ReAct loop) decides which tools to use:
                │     ├── read_text       → the page's visible text              ┐ run in
                │     ├── read_page       → interactive elements + their state   │ the
                │     ├── act             → perform actions on the page          │ browser
                │     ├── ask_user        → pause and ask the user for input     │
                │     ├── goto            → send the tab to a new address       ┘
                │     └── Composio tools  → dynamic tool discovery + execution
                │
                ├── Middleware: call limits, identical-call guard, tool errors,
                │   stale tool-output eviction, human-in-the-loop
                │
                └── Stream response via SSE with tool status updates
```

---

## Tech Stack

**Frontend (Chrome Extension — Manifest V3)**
- Plain JavaScript, HTML, CSS — no build step
- `popup.js` — side panel UI: the conversation, provider/model selection, SSE streaming, persistence
- `background.js` — routes the toolbar click to the side panel, prunes chats for closed windows
- `content.js` — page agent: builds the numbered accessibility snapshot the model uses to
  address elements, and executes the action verbs. Element references stay in the page;
  only `[15] button "Sign in"` is sent, and only `click(15)` comes back

**Backend (FastAPI + LangGraph)**
- FastAPI with SSE streaming responses
- LangChain v1 `create_agent` — tool-calling agent with middleware
- Composio for dynamic app integrations

**AI Providers**
| Provider | LLM |
|---|---|
| Claude (Anthropic) | Opus 5 / Sonnet 5 |
| Gemini (Google) | 3.7 Flash / 3.6 Flash |
| GPT (OpenAI) | GPT-5.6 Sol / GPT-5.6 Terra |
| Groq (GroqCloud) | Qwen3.6 27B |

The list is short on purpose. Page automation needs a model that can hold a ~200-line
element map and keep its place after the context middleware trims it; the cheaper tiers
loop instead of failing, which costs the user real credit. The first entry per provider is
the default.

---

## How Page Actions Work

1. `content.js` walks the page's interactive elements and emits a numbered snapshot —
   essentially the accessibility tree, so it works on any site with no per-domain rules.
   Each line carries **state**, not just identity: `16 checkbox Terms [unchecked]`.
   Ids and names are unquoted on purpose — brackets and quotes were 71% of every line's
   tokens, and dropping them halves the map (1,820 → 967 on a 200-element page)
2. Only that text goes to the model. Element references never leave the page, so the model
   addresses things by number and the panel resolves them locally
3. `act` runs a batch of verbs in one round trip — the main cost lever, since a 10-field
   form becomes ~2 model calls instead of ~10. Verbs: `click type clear check uncheck
   select press hover scroll submit wait back forward`
4. A batch **stops after the first `click`, `press` or `submit`**, because those change the
   page and every later id may be stale. Fills are grouped; the click goes last
5. Afterwards a `MutationObserver` waits for the DOM to go quiet (~400ms, capped at 3s),
   then a fresh snapshot is returned so the agent can continue

Actions need the WebSocket transport: the agent runs on the server but its page tools
execute in the browser, so a tool call has to travel back out mid-run. A `client_tool`
frame goes down, a `client_tool_result` comes back, and one uninterrupted agent run does
the whole task — no transcript replay and no checkpointer. On `POST /chat` the action tools
are simply not offered.

**Element numbers are handles, not positions.** A number is assigned to an element the
first time it is listed and stays with it for as long as it is on the page, so a number the
model is still holding keeps meaning the same control even after the page rearranges around
it. Line order carries position; the number carries identity.

This matters more than it sounds. When numbers were array indices, one row arriving at the
top renumbered everything below it, so a number the model still held silently pointed at a
*different* element. That single property forced batch-wide staleness vetoes (the only safe
answer to a stale index is to refuse everything), blinded the repeated-call guard (the same
target had different arguments every time), and made map diffing impossible. On a
hash-routed app like Gmail — where the view changes without a page load — it produced turns
that alternated `act → read_page → act → read_page` and never finished.

**Safety.** `check`/`uncheck` read current state and no-op when already correct, so
"accept the terms" cannot un-accept a pre-checked box. Every action re-verifies its target
before touching it: the number must still resolve to the same element, that element must
still carry the name it was listed under (a re-render can reuse a node for something else),
and it must still be reachable — an element a dialog has since covered is refused rather
than clicked. Passwords are never sent to the model — the snapshot reports a length.

---

## Moving between pages

`goto(url)` sends the current tab to a new address and returns the destination's element
map, so the agent can act immediately without a separate `read_page`. Element numbers belong
to one page and are dead the moment it navigates.

Only `http`/`https` are accepted — `javascript:`, `file:` and `chrome:` are refused before
Chrome is touched. It is not gated for approval: navigation is reversible with Back, and
everything consequential at the destination already asks.

The agent stays in the tab you asked from, so the chat never moves. It cannot open or switch
tabs — that was tried and removed as more complexity than it was worth.

---

## Restricted / Unrestricted

A pill in the header toggles how much the agent asks before acting.

| | Restricted (default) | Unrestricted |
|---|---|---|
| Fill, check, select, scroll, ordinary clicks | runs | runs |
| Submits, and clicks named delete / buy / pay / send… | **asks** | runs |
| Typing into a password or card field | **asks** | runs |
| External side effects (Composio: send email, delete…) | **asks** | **asks** |
| `ask_user` — the agent needs a value from you | asks | asks |

Unrestricted deliberately covers page actions only: a wrong click is undone with Back, a
sent email is not. It is **session-scoped** — reopening the panel always returns to
Restricted, so it can never be left on by accident.

## Human-in-the-loop

Built on LangChain's `HumanInTheLoopMiddleware`, so the graph genuinely *pauses* and
resumes rather than ending the turn and starting a new one.

- **Approval** — the prompt names the element (*Click "Delete account"?*) because the
  server keeps the last snapshot and parses it. Every risky action in a batch is listed, so
  a benign-sounding lead can never hide a dangerous one.
- **Input** — `ask_user(question, kind, options)` renders a text box, option buttons, or a
  masked field. The agent decides what to ask; its answer comes straight back as the tool
  result and the run continues.
- **Secrets stay in the browser.** A `secret` answer is held in the panel and swapped in at
  the moment of typing. The model only ever sees a placeholder token, and the value is never
  written to the saved transcript.

---

## Lanes

Every turn is routed once, before any tools are loaded, and then handled by a lane that
holds only what that lane needs. One structured-output call reads the lane descriptions —
never the tool schemas — so routing costs ~190 tokens and happens once per turn, not once
per model call.

| Lane | Tools | Preamble |
|---|---|---|
| `chat` | `escalate` only | ~250 tokens |
| `ask_page` | `search_page`, `summarize_page`, `read_page` | ~675 |
| `operate` | `read_page`, `read_text`, `act`, `goto`, `ask_user`, `summarize_page` | ~1,900 |
| `app` | Composio tools, `summarize_page` | varies |

Why it matters beyond cost: a conversational message cannot trip an approval prompt or a
page action, because the lane that handles it has no such tool to call. Misrouting is
recoverable — every lane except `operate` carries `escalate`, which hands the turn to the
page tools once, and the transport enforces the single hop by building the second pass
without an `escalate` tool at all.

`CAPABILITIES` in `server.py` is the single source: one entry per tool declares which lanes
may offer it and what prompt guidance joins the prompt when it does. Adding a tool means
adding one entry — the router's options and each lane's prompt follow from it. Anything not
declared (Composio ships its tools at runtime) lands in the `app` lane by default.

Prompt fragment **order** is fixed by `PROMPT_SEQUENCE` rather than by registry order: it
reproduces the sequence of the prompt that was tuned by use, and the acting rules close the
prompt.

---

## Agent Tools

| Tool | What it does | When the agent uses it |
|---|---|---|
| `read_text` | Page's visible text, read live when the tool runs | Any question about what a page says |
| `search_page` | Chunks the page and returns the passages matching a query | A question about the page — the `ask_page` lane's main tool |
| `summarize_page` | The whole page's text, capped | "Summarise this", "what is this about" |
| `escalate` | Hands the turn to the page tools | A non-`operate` lane finds it needs to click or type |
| Composio meta tools | Search, connect, and execute 500+ app integrations | User asks to send email, create docs, etc. |

`search_page` ranks chunks by TF-IDF cosine similarity, and by provider embeddings when the
selected provider has them (OpenAI, Gemini). TF-IDF is the default rather than a fallback:
**Groq exposes no embeddings endpoint**, so it is the only retrieval that works there — and
it costs no tokens and no extra call. A page question returns ~600 tokens of passages
instead of a 5,000-token text dump.

Within a lane the agent still **decides** which of its tools to use — it is not a fixed
pipeline.

**Web lookups have no dedicated tool.** The browser *is* the internet access: the agent puts the
query straight into a search address (`https://duckduckgo.com/?q=…`) and navigates there. A results
page already lists its results as links in the element map, so it can pick one, open it, and
`read_text` that.

---

## Project Structure

```
chrome-rag-extension/
├── manifest.json          # MV3 config — permissions, content scripts, side panel
├── background.js          # Service worker — side panel behavior, chat cleanup
├── content.js             # Page agent: builds the numbered element snapshot
│
├── popup/                 # The side panel document (path kept from the popup era)
│   ├── popup.html         # Chat UI shell
│   ├── popup.css          # Styles
│   └── popup.js           # The conversation, streaming, provider/model selection, key setup
│
├── icons/
│   ├── logo.svg           # Source logo
│   └── icon{16,32,48,128}.png
│
└── backend/
    ├── server.py          # FastAPI + LangGraph ReAct agent
    ├── requirements.txt
    ├── Dockerfile
    └── docker-compose.yml
```

---

## Running Locally

**Backend**
```bash
cd backend
pip install -r requirements.txt
python3 server.py
# runs on http://localhost:5000
```

Or with Docker:
```bash
cd backend
docker compose up -d --build
```

**Tracing (optional)**

LLM API keys come from the extension, not the server — but LangSmith is configured
server-side. Drop a `backend/.env` with:

```
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_API_KEY=lsv2_...
LANGSMITH_PROJECT=extension
```

`server.py` loads that file on import and Compose passes it into the container, so every
agent run shows up under the named project. Values already present in the real environment
(Render, `docker run -e`) take precedence over the file. The flag is read once per process,
so flipping it needs a restart.

**Extension**
1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked** → select the repo root
4. Click the extension icon to toggle the side panel. With no keys saved it opens
   straight into the setup screen — add a key from Anthropic, Google, OpenAI, or Groq and
   the chat unlocks. Later, reach it again via ☰ → **API Keys**.

Requires Chrome/Edge/Brave 114+ for the Side Panel API.

**Toggle backend URL** in `popup/popup.js`:
```javascript
const BACKEND = 'http://localhost:5000';       // local
// const BACKEND = 'https://api.cember.in';    // production
```

---

## Storage

All data stored in `chrome.storage.local`:

| Key | Purpose |
|---|---|
| `apiKeys` | `{ claude, gemini, openai, groq }` — LLM provider keys |
| `toolKeys` | `{ composio }` — external tool keys |
| `selectedProvider` | Last used provider |
| `selectedModelId` | Last used model |
| `panelChat:<windowId>` | Persisted conversation, one key per window |
| `chatPageUrl` | URL of the page the chat belongs to |

---

## Key Design Decisions

- **ReAct agent over fixed pipeline** — the LLM decides which tools to call, enabling flexible multi-step reasoning
- **Chunking on the backend** — `RecursiveCharacterTextSplitter` with sentence-aware splitting and overlap, instead of blind 500-char cuts on the frontend
- **Conditional tool loading** — Composio tools are only added to the agent when the user has provided that API key
- **SSE streaming with tool status** — streams both tool call names (for UI status updates) and text tokens for real-time display
- **Chat unbound from tabs and pages** — a side panel is one persistent document per window, so the conversation is too. Navigating, switching tabs, and opening or closing tabs all leave it alone; only New Chat clears it. Storage uses one key per window (`panelChat:<windowId>`) rather than a nested object, because `storage.local.set` writes whole values and two panels sharing one object would overwrite each other
- **Capped history** — the panel shows every message, but only the last 20 go upstream, so a long session does not grow the prompt without bound
