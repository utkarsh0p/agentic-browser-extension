# SiteWhisper

A Chrome extension powered by a **LangGraph ReAct agent** that lives in your browser. It can read any webpage, search the web, and connect to 500+ apps — all from a chat side panel that docks beside the page and stays open while you browse.

---

## What It Does

- **Chat with any webpage** — AI reads the page, finds relevant sections using RAG, and answers your questions
- **Summarize pages** — get a full summary of any article or page in one click
- **Connect to 500+ apps** — via Composio meta tools, the agent can search for tools, connect to services (Gmail, Google Docs, Slack, etc.), and execute actions on your behalf
- **General AI chat** — works as a regular AI assistant when no page context is needed

---

## Architecture

```
User types question
        │
        ▼
   popup.js (side panel UI — one chat per tab)
        │
        ├── chrome.scripting.executeScript → active tab
        │       └── Scrapes page text (raw innerText)
        │
        ├── chrome.tabs.sendMessage → content.js
        │       ├── SW_SNAPSHOT → numbered element map: [15] button "Sign in"
        │       └── SW_ACT      → click / type / check / select / press / scroll …
        │
        └── WebSocket /chat/ws  → FastAPI backend   (POST /chat as fallback)
                │
                ├── RecursiveCharacterTextSplitter (500 chars, 50 overlap)
                │
                ├── create_agent (ReAct loop) decides which tools to use:
                │     ├── search_page     → embed chunks, cosine similarity, top 3
                │     ├── summarize_page  → return full page text to LLM
                │     ├── read_page       → interactive elements + their state   ┐ run in
                │     ├── act             → perform actions on the page          │ the
                │     ├── ask_user        → pause and ask the user for input     │ browser
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
- `popup.js` — side panel UI: per-tab chats, provider/model selection, SSE streaming, persistence
- `background.js` — routes the toolbar click to the side panel, prunes chats for closed tabs
- `content.js` — page agent: builds the numbered accessibility snapshot the model uses to
  address elements, and executes the action verbs. Element references stay in the page;
  only `[15] button "Sign in"` is sent, and only `click(15)` comes back

**Backend (FastAPI + LangGraph)**
- FastAPI with SSE streaming responses
- LangGraph `create_react_agent` — ReAct agent with tool use
- LangChain for LLM abstraction and text splitting
- Scikit-learn for TF-IDF + cosine similarity (Claude fallback)
- Vector embeddings via OpenAI / Gemini APIs
- Composio for dynamic app integrations

**AI Providers**
| Provider | LLM | Embeddings |
|---|---|---|
| Claude (Anthropic) | Haiku 4.5 / Sonnet 4.6 / Opus 4.6 | Gemini fallback or TF-IDF |
| Gemini (Google) | 2.5 Flash / 2.5 Pro / 2.0 Flash | gemini-embedding-001 |
| GPT (OpenAI) | GPT-4.1 mini / GPT-4.1 / o4-mini | text-embedding-3-small |

---

## How RAG Works

1. `popup.js` reads `document.body.innerText` via `chrome.scripting.executeScript` and sends the raw text to the backend
2. Backend uses `RecursiveCharacterTextSplitter` (500 chars, 50 overlap) — splits on paragraphs, sentences, then words
3. The agent decides whether to call `search_page` based on the user's question
4. `search_page` embeds all chunks + query using the provider's embedding model (or TF-IDF for Claude)
5. Cosine similarity selects the **top 3 most relevant chunks**
6. Agent uses those chunks to generate a grounded answer

---

## How Page Actions Work

1. `content.js` walks the page's interactive elements and emits a numbered snapshot —
   essentially the accessibility tree, so it works on any site with no per-domain rules.
   Each line carries **state**, not just identity: `[16] checkbox "Terms" [unchecked]`
2. Only that text goes to the model. Element references never leave the page, so the model
   addresses things by number and the panel resolves them locally
3. `act` runs a batch of verbs in one round trip — the main cost lever, since a 10-field
   form becomes ~2 model calls instead of ~10
4. A batch **stops after the first `click`, `press` or `submit`**, because those change the
   page and every later id may be stale. Fills are grouped; the click goes last
5. Afterwards a `MutationObserver` waits for the DOM to go quiet (~400ms, capped at 3s),
   then a fresh snapshot is returned so the agent can continue

Actions need the WebSocket transport: the agent runs on the server but its page tools
execute in the browser, so a tool call has to travel back out mid-run. A `client_tool`
frame goes down, a `client_tool_result` comes back, and one uninterrupted agent run does
the whole task — no transcript replay and no checkpointer. On `POST /chat` the action tools
are simply not offered.

**Safety.** `check`/`uncheck` read current state and no-op when already correct, so
"accept the terms" cannot un-accept a pre-checked box. Element ids are verified before use:
a removed element, a renamed one, or a navigation since the snapshot is refused rather than
clicked. Passwords are never sent to the model — the snapshot reports a length.

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

## Agent Tools

| Tool | What it does | When the agent uses it |
|---|---|---|
| `search_page` | Embeds page chunks, finds top 3 by cosine similarity | Any question about what the page says |
| `summarize_page` | Returns full page text (up to 15k chars) | Only an explicit summary or full-contents request |
| Composio meta tools | Search, connect, and execute 500+ app integrations | User asks to send email, create docs, etc. |

The agent **decides** which tools to use — it's not a fixed pipeline. Simple questions get direct answers, page questions trigger `search_page`, and complex tasks chain multiple tools.

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
│   └── popup.js           # Per-tab chats, streaming, provider/model selection, key setup
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
   straight into the setup screen — add a key from Anthropic, Google, or OpenAI and
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
| `apiKeys` | `{ claude, gemini, openai }` — LLM provider keys |
| `toolKeys` | `{ composio }` — external tool keys |
| `selectedProvider` | Last used provider |
| `selectedModelId` | Last used model |
| `chatMessages` | Persisted chat history |
| `chatPageUrl` | URL of the page the chat belongs to |

---

## Key Design Decisions

- **ReAct agent over fixed pipeline** — the LLM decides which tools to call, enabling flexible multi-step reasoning
- **Chunking on the backend** — `RecursiveCharacterTextSplitter` with sentence-aware splitting and overlap, instead of blind 500-char cuts on the frontend
- **Gemini embedding fallback for Claude** — Anthropic has no embeddings API, so if the user has a Gemini key, it's used for embeddings; otherwise falls back to TF-IDF
- **Conditional tool loading** — Composio tools are only added to the agent when the user has provided that API key
- **SSE streaming with tool status** — streams both tool call names (for UI status updates) and text tokens for real-time display
- **Chat persistence with page awareness** — chat history is saved to storage and auto-cleared when the user navigates to a different page
