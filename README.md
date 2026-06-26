# SiteWhisper

A Chrome extension powered by a **LangGraph ReAct agent** that lives in your browser. It can read any webpage, search the web, and connect to 500+ apps — all from a chat popup.

---

## What It Does

- **Chat with any webpage** — AI reads the page, finds relevant sections using RAG, and answers your questions
- **Summarize pages** — get a full summary of any article or page in one click
- **Search the web** — agent uses Tavily to find up-to-date information beyond the current page
- **Connect to 500+ apps** — via Composio meta tools, the agent can search for tools, connect to services (Gmail, Google Docs, Slack, etc.), and execute actions on your behalf
- **General AI chat** — works as a regular AI assistant when no page context is needed

---

## Architecture

```
User types question
        │
        ▼
   popup.js (Chrome Extension UI)
        │
        ├── chrome.tabs.sendMessage → content.js
        │       └── Scrapes page text (raw innerText)
        │
        └── fetch POST /chat → FastAPI backend (https://api.cember.in)
                │
                ├── RecursiveCharacterTextSplitter (500 chars, 50 overlap)
                │
                ├── LangGraph ReAct Agent decides which tools to use:
                │     ├── search_page     → embed chunks, cosine similarity, top 3
                │     ├── summarize_page  → return full page text to LLM
                │     ├── web_search      → Tavily API for internet search
                │     └── Composio tools  → dynamic tool discovery + execution
                │
                └── Stream response via SSE with tool status updates
```

---

## Tech Stack

**Frontend (Chrome Extension — Manifest V3)**
- Plain JavaScript, HTML, CSS — no build step
- `content.js` — injected into every page, reads DOM text
- `popup.js` — chat UI, provider/model selection, SSE streaming, chat persistence
- `background.js` — opens options page on first install

**Backend (FastAPI + LangGraph)**
- FastAPI with SSE streaming responses
- LangGraph `create_react_agent` — ReAct agent with tool use
- LangChain for LLM abstraction and text splitting
- Scikit-learn for TF-IDF + cosine similarity (Claude fallback)
- Vector embeddings via OpenAI / Gemini APIs
- Tavily for web search
- Composio for dynamic app integrations

**AI Providers**
| Provider | LLM | Embeddings |
|---|---|---|
| Claude (Anthropic) | Haiku 4.5 / Sonnet 4.6 / Opus 4.6 | Gemini fallback or TF-IDF |
| Gemini (Google) | 2.5 Flash / 2.5 Pro / 2.0 Flash | gemini-embedding-001 |
| GPT (OpenAI) | GPT-4.1 mini / GPT-4.1 / o4-mini | text-embedding-3-small |

---

## How RAG Works

1. `content.js` scrapes `document.body.innerText` and sends the raw text to the backend
2. Backend uses `RecursiveCharacterTextSplitter` (500 chars, 50 overlap) — splits on paragraphs, sentences, then words
3. The ReAct agent decides whether to call `search_page` based on the user's question
4. `search_page` embeds all chunks + query using the provider's embedding model (or TF-IDF for Claude)
5. Cosine similarity selects the **top 3 most relevant chunks**
6. Agent uses those chunks to generate a grounded answer

---

## Agent Tools

| Tool | What it does | When the agent uses it |
|---|---|---|
| `search_page` | Embeds page chunks, finds top 3 by cosine similarity | User asks about something on the page |
| `summarize_page` | Returns full page text (up to 15k chars) | User asks for a summary or overview |
| `web_search` | Searches the internet via Tavily | User needs info not on the page |
| Composio meta tools | Search, connect, and execute 500+ app integrations | User asks to send email, create docs, etc. |

The agent **decides** which tools to use — it's not a fixed pipeline. Simple questions get direct answers, page questions trigger `search_page`, and complex tasks chain multiple tools.

---

## Project Structure

```
chrome-rag-extension/
├── manifest.json          # MV3 config — permissions, content scripts, popup
├── background.js          # Service worker — opens options on first install
├── content.js             # Injected into every page — scrapes page text
│
├── popup/
│   ├── popup.html         # Chat UI shell
│   ├── popup.css          # Styles
│   └── popup.js           # Chat logic, streaming, provider/model selection, persistence
│
├── options/
│   ├── option.html        # API key + tool key setup (two-column layout)
│   ├── option.css
│   └── option.js          # Saves keys to chrome.storage.local
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

**Extension**
1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked** → select the repo root
4. Click the extension icon → open Settings → add your API key

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
| `toolKeys` | `{ tavily, composio }` — external tool keys |
| `selectedProvider` | Last used provider |
| `selectedModelId` | Last used model |
| `chatMessages` | Persisted chat history |
| `chatPageUrl` | URL of the page the chat belongs to |

---

## Key Design Decisions

- **ReAct agent over fixed pipeline** — the LLM decides which tools to call, enabling flexible multi-step reasoning
- **Chunking on the backend** — `RecursiveCharacterTextSplitter` with sentence-aware splitting and overlap, instead of blind 500-char cuts on the frontend
- **Gemini embedding fallback for Claude** — Anthropic has no embeddings API, so if the user has a Gemini key, it's used for embeddings; otherwise falls back to TF-IDF
- **Conditional tool loading** — Tavily and Composio tools are only added to the agent when the user has provided those API keys
- **SSE streaming with tool status** — streams both tool call names (for UI status updates) and text tokens for real-time display
- **Chat persistence with page awareness** — chat history is saved to storage and auto-cleared when the user navigates to a different page
