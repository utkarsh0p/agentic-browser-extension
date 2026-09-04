# SiteWhisper

A Chrome side panel that reads the page you're on — and acts on it for you.

Ask it what an article says, or tell it to fill the form, click through the flow, look
something up and come back with the answer. It docks beside the page and stays there while
you browse: navigating, switching tabs, opening and closing tabs all leave the conversation
alone.

Bring your own API key. There's no account, no subscription, and no key stored on anyone's
server — you add a key from Anthropic, Google, OpenAI or Groq, and it lives in your browser.

---

## What you can do with it

| | |
|---|---|
| **Ask about the page** | *"What does this say about the refund window?"* — it searches the page and answers from what it finds, not from memory |
| **Summarise it** | *"What is this about?"* |
| **Fill things in** | *"Fill this form with my details and submit it"* — it asks you for anything it doesn't know |
| **Look something up** | *"Search for the tallest building and tell me who built it"* — the browser is its internet access; it navigates and reads |
| **Work inside an app you have open** | *"Delete the first email"* while you're sitting in Gmail |
| **Reach apps you don't have open** | Add a [Composio](https://composio.dev) key and it can search, connect to, and act in 500+ services |

---

## Bring your own key

One key is enough to start. The panel opens straight into a setup screen and unlocks as
soon as you add one.

| Provider | Models |
|---|---|
| **Claude** — Anthropic | Opus 5 · Sonnet 5 |
| **Gemini** — Google | 3.7 Flash · 3.6 Flash |
| **GPT** — OpenAI | GPT-5.6 Sol · GPT-5.6 Terra |
| **Groq** — GroqCloud | Qwen3.6 27B |

The list is short deliberately. Driving a page needs a model that can hold a ~200-line
element map, pick the right line out of it, and stay oriented after the context middleware
trims it. Cheaper tiers don't fail cleanly at this — they loop, and the loop is billed to
your key.

Keys are kept in `chrome.storage.local` and sent to the backend only to authenticate that
provider's API. They are never logged or stored server-side. Your conversation is stored
locally too, one entry per browser window.

---

## How it works

```
┌── Chrome side panel ───────────┐         ┌── FastAPI + LangGraph ─────────┐
│                                │         │                                │
│  your question ────────────────┼── ws ──▶│  1. route the turn to a lane   │
│  + provider, model, your key   │         │  2. build only that lane's     │
│                                │         │     tools and prompt           │
│  content.js                    │         │  3. run the agent loop         │
│   ├─ builds the element map    │◀── tool ┤                                │
│   └─ runs click / type / goto ─┼─ result▶│     page tools call back out ──┤
│                                │         │                                │
│  reasoning rail ◀──────────────┼─ frames ┤     approvals pause the graph  │
└────────────────────────────────┘         └────────────────────────────────┘
```

### The element map

`content.js` walks the page and emits a numbered snapshot — a distilled accessibility tree,
not markup. ~400 characters of button HTML collapses to one line:

```
page: Sign in — Example
url: https://example.com/login

12 textbox Email = you@example.com [required]
14 textbox Password [length 11]
16 checkbox Remember me [unchecked]
19 button Sign in
30 combobox Country options: India | Japan | Brazil
```

Because it's the a11y tree, it works on any site with no per-domain rules. Because it's one
line per control, a page costs ~500–2k tokens instead of 50k+ of raw HTML.

**Element references never leave the page.** Only that text goes up, and only `click(19)`
comes back — resolved locally against the live element. Passwords are never sent; the map
reports a length.

**Numbers are handles, not positions.** A number is assigned to an element the first time
it's listed and stays with it for as long as it's on the page, so a number the model is
still holding keeps meaning the same control even after the page rearranges around it. Line
order carries position; the number carries identity.

The map also tells the model when it can't be trusted: when a dialog is open it covers only
the dialog's contents, when the page was still rendering it says so, and when it hits the
200-element cap it says that too.

### Lanes

Every turn is routed once, before any tools are loaded, by a single structured-output call
that sees the four lane descriptions and the request — never the tool schemas. That costs
~190 tokens and happens once per turn, not once per model call.

| Lane | For | Tools |
|---|---|---|
| `chat` | conversation, general knowledge | *(none)* |
| `ask_page` | a question about this page | `search_page` `summarize_page` `read_page` |
| `operate` | something to be **done** in the browser | `read_page` `read_text` `act` `goto` `ask_user` `summarize_page` |
| `app` | an action in a service you're not looking at | Composio tools · `summarize_page` |

This is a safety property as much as a cost one: a conversational message *cannot* trip an
approval prompt or a page action, because the lane handling it has no such tool to call.

Misrouting is recoverable — every lane except `operate` carries an `escalate` tool that
hands the turn to the page tools once. The hop is enforced by the transport, which builds
the second pass without an `escalate` tool at all, so it can't become a loop.

### Acting on the page

`act` runs a batch of verbs in one round trip — the main cost lever, since a 10-field form
becomes ~2 model calls instead of ~10. The verbs are `click` `type` `clear` `check`
`uncheck` `select` `press` `hover` `scroll` `submit` `wait` `back` `forward`.

A batch **stops after the first `click`, `press` or `submit`**, because those change the
page and every later id may be stale. Fills are grouped and the click goes last. Afterwards
the page is given time to settle, and the result leads with *what actually happened* before
handing back a fresh map:

```
ok: typed "hello@example.com" into "Email"
ok: clicked "Sign in"
→ the page navigated to https://example.com/dashboard — element numbers from before are dead
```

That line matters more than it looks: without it, a click that opened a dialog and a click
that did nothing produce identical output, and the model has to guess which it was.

`goto(url)` navigates the tab and returns the destination's map, so the agent can act
immediately. Only `http`/`https` are accepted. There's no web-search tool — the browser
*is* the internet access, so the agent puts a query straight into a search URL and reads the
results page like any other.

### The agent loop

The backend builds a LangGraph agent per turn with `create_agent`, wrapped in middleware
that each solve one failure mode:

| | |
|---|---|
| **Call limits** | 25 model calls, 30 tool calls per turn. An exhausted turn returns its partial answer rather than an error |
| **Repeat guard** | Refuses an action already tried byte-identically since the last look at the page. Observation is never blocked — re-reading is how an agent recovers |
| **Tool errors** | Turns an exception into a message the model can act on, so it corrects the arguments instead of retrying them verbatim |
| **Map trimming** | Drops every element map but the current one on every model call, while keeping the outcome lines — the agent's only memory of its own work |
| **Human-in-the-loop** | Genuinely pauses the graph for an approval or a question, and resumes the same run |

### Why a WebSocket

The agent runs on the server, but its page tools run in your browser — so a tool call has to
travel back *out* mid-run. There are two ways that happens, and they're not the same thing:

- **`client_tool`** — the graph does *not* pause. `act` sends a frame down the wire and
  awaits the reply inside its own tool call, so one uninterrupted agent run does the whole
  task. No transcript replay, no checkpointer.
- **`hitl`** — the graph genuinely pauses. An approval or an `ask_user` interrupts the run,
  the panel renders it, and the answer resumes the *same* run where it stopped.

If the socket can't be established — an older backend, a proxy that drops upgrades — the
panel falls back to `POST /chat`, which still answers questions. It just can't act, so the
page-action tools are never offered there.

---

## Staying in control

A pill in the header toggles how much the agent asks before acting.

| | Restricted *(default)* | Unrestricted |
|---|---|---|
| Fill, check, select, scroll, ordinary clicks | runs | runs |
| Submits, and clicks named delete / buy / pay / send… | **asks** | runs |
| Typing into a password or card field | **asks** | runs |
| External side effects (send an email, delete a file…) | **asks** | **asks** |
| `ask_user` — it needs a value from you | asks | asks |

Unrestricted deliberately covers page actions only: a wrong click is undone with Back, a
sent email is not. It's **session-scoped** — reopening the panel always returns to
Restricted, so it can never be left on by accident.

Approval prompts name the element rather than the tool — *Click "Delete account"?* — and
every risky action in a batch is listed, so a benign-sounding lead can't hide a dangerous
one. `check`/`uncheck` read the current state and no-op when it's already correct, so
"accept the terms" can never un-accept a pre-checked box. Every action re-verifies its
target before touching it: the element must still be the one it was listed as, still carry
the same name, and still be reachable — one a dialog has since covered is refused rather
than clicked.

**Secrets stay in the browser.** When the agent asks for a password, your answer is held in
the panel and swapped in at the moment of typing. The model only ever sees a placeholder,
and the value is never written to the saved conversation.

---

## What you see while it works

Each turn shows a live reasoning rail — *Reading the page*, *Acting on the page*, the app
action it's executing — with the lane it chose as its own row, so a misroute is visible
rather than mysterious. Repeated calls collapse into one row with a `×N` badge. Approvals
and questions appear inline in the rail, in place.

When the turn finishes the rail folds into a chip:

```
▸ Whispered through 6 steps · 12s · 1.3k tokens
```

Click it to expand the whole trace. The send button becomes a stop button while a turn is
running; a stopped turn stays in the transcript, labelled.

---

## Running it

**Backend**

```bash
cd backend
pip install -r requirements.txt
python3 server.py          # http://localhost:5000
```

**Extension**

1. Open `chrome://extensions`
2. Enable Developer mode
3. **Load unpacked** → select the repo root
4. Click the toolbar icon to open the side panel, and add an API key when it asks.
   Later: ☰ → **API Keys**

Requires Chrome/Edge/Brave 114+ for the Side Panel API.

Point the panel at your backend with one line at the top of `popup/popup.js`:

```javascript
const BACKEND = 'http://localhost:5000';       // local
// const BACKEND = 'https://api.cember.in';    // hosted
```

---

## Project layout

```
agentic-browser-extension/
├── manifest.json          # MV3 — permissions, content script, side panel
├── background.js          # Service worker: toolbar click, chat cleanup
├── content.js             # Page agent: builds the element map, runs the verbs
│
├── popup/                 # The side panel (path kept from the popup era)
│   ├── popup.html
│   ├── popup.css
│   └── popup.js           # Conversation, reasoning rail, streaming, key setup
│
├── icons/
│
└── backend/
    ├── server.py          # FastAPI + LangGraph — router, lanes, tools, middleware
    └── requirements.txt
```

---

## Good to know

- **Each turn is self-contained.** No conversation history is sent to the model — a message
  is a whole job that finishes inside its own turn. The panel shows and stores everything,
  but a follow-up like *"now do the next one"* has nothing to refer to, so say what you
  want. This keeps a long session from growing the prompt without bound.
- **It works in the tab you asked from** and stays there. It can't open or switch tabs.
- **The map caps at 200 elements**, and says so when it does. A control can be on the page
  and not listed — the agent has ways around that, including asking you what you can see.
- **Page actions need the WebSocket.** Over the `POST` fallback it can still read and answer,
  but not click or type.

---

## Privacy

Page content is read only when you ask a question, and isn't stored or logged after the
answer is returned. See [PRIVACY.md](PRIVACY.md).
