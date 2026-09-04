// ── Backend URL — toggle one line to switch between local and production ──────
//const BACKEND = 'http://localhost:5000';        // ← local testing
const BACKEND = 'https://api.cember.in';          // ← production

// ── Avatars ───────────────────────────────────────────────────────────────────

const AI_AVATAR_SVG = `<svg viewBox="0 0 100 100" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M16 11 L57 50 L16 89" stroke="#fafaf8" stroke-width="14" stroke-linejoin="miter" stroke-linecap="round"/>
  <path d="M57 14 A39 39 0 0 1 57 86" stroke="#fafaf8" stroke-width="13" stroke-linecap="round"/>
  <line x1="57" y1="50" x2="88" y2="50" stroke="#fafaf8" stroke-width="9" stroke-linecap="round"/>
  <line x1="57" y1="50" x2="79" y2="27" stroke="#fafaf8" stroke-width="9" stroke-linecap="round"/>
  <line x1="57" y1="50" x2="79" y2="73" stroke="#fafaf8" stroke-width="9" stroke-linecap="round"/>
</svg>`;

const TYPING_SVG = `<svg class="dots-anim" width="28" height="12" viewBox="0 0 28 12" xmlns="http://www.w3.org/2000/svg">
  <circle cx="5"  cy="6" r="2.2" fill="#aaaaaa"><animate id="td0" begin="0;td2.end+0.25s" attributeName="cy" calcMode="spline" dur="0.55s" values="6;2.5;6" keySplines=".33,.66,.66,1;.33,0,.66,.33"/></circle>
  <circle cx="14" cy="6" r="2.2" fill="#aaaaaa"><animate begin="td0.begin+0.1s" attributeName="cy" calcMode="spline" dur="0.55s" values="6;2.5;6" keySplines=".33,.66,.66,1;.33,0,.66,.33"/></circle>
  <circle cx="23" cy="6" r="2.2" fill="#aaaaaa"><animate id="td2" begin="td0.begin+0.2s" attributeName="cy" calcMode="spline" dur="0.55s" values="6;2.5;6" keySplines=".33,.66,.66,1;.33,0,.66,.33"/></circle>
</svg>`;

// ── Markdown renderer ─────────────────────────────────────────────────────────

function renderMarkdown(md) {
  const esc    = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const links  = [];
  const LINK_MARK = '\x00L';
  const saveLinks = s => s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, text, url) => {
    links.push(`<a href="${url}" target="_blank" rel="noopener">${esc(text)}</a>`);
    return LINK_MARK + (links.length - 1) + '\x00';
  });
  const restoreLinks = s => s.replace(new RegExp(LINK_MARK + '(\\d+)\x00', 'g'), (_, i) => links[+i]);
  const inline = s => restoreLinks(
    saveLinks(s)
      .replace(/`([^`]+)`/g,        '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g,    '<strong>$1</strong>')
      .replace(/__(.+?)__/g,         '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g,    '<em>$1</em>')
      .replace(/_([^_\n]+)_/g,      '<em>$1</em>')
  );

  const blocks = [];
  const MARK   = '\x00B';
  md = md.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${esc(code.trim())}</code></pre>`);
    return MARK + (blocks.length - 1) + '\x00';
  });

  const lines   = md.split('\n');
  const out     = [];
  let listTag   = null;
  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null; } };

  for (const raw of lines) {
    if (raw.includes(MARK)) { closeList(); out.push(raw); continue; }
    const hm = raw.match(/^(#{1,3})\s+(.*)/);
    if (hm) { closeList(); const lvl = Math.min(hm[1].length + 1, 4); out.push(`<h${lvl}>${inline(esc(hm[2]))}</h${lvl}>`); continue; }
    const ul = raw.match(/^[-*]\s+(.*)/);
    if (ul) { if (listTag !== 'ul') { closeList(); out.push('<ul>'); listTag = 'ul'; } out.push(`<li>${inline(esc(ul[1]))}</li>`); continue; }
    const ol = raw.match(/^\d+\.\s+(.*)/);
    if (ol) { if (listTag !== 'ol') { closeList(); out.push('<ol>'); listTag = 'ol'; } out.push(`<li>${inline(esc(ol[1]))}</li>`); continue; }
    closeList();
    if (raw.trim() === '') { out.push('<div class="md-gap"></div>'); continue; }
    out.push(`<p>${inline(esc(raw))}</p>`);
  }

  closeList();
  return out.join('').replace(new RegExp(MARK + '(\\d+)\x00', 'g'), (_, i) => blocks[+i]);
}

// ── Provider icons ─────────────────────────────────────────────────────────────

const OPENAI_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 256 260"><path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z"/></svg>`;

const GEMINI_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g1" x1="0%" x2="68.73%" y1="100%" y2="30.395%"><stop offset="0%" stop-color="#1C7DFF"/><stop offset="52%" stop-color="#1C69FF"/><stop offset="100%" stop-color="#F0DCD6"/></linearGradient></defs><path d="M12 24A14.304 14.304 0 000 12 14.304 14.304 0 0012 0a14.305 14.305 0 0012 12 14.305 14.305 0 00-12 12" fill="url(#g1)"/></svg>`;

const GROQ_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="6" fill="#f55036"/><text x="12" y="17" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="14" font-weight="600" fill="#ffffff" text-anchor="middle">G</text></svg>`;

const CLAUDE_ICON = `<svg fill="#c96442" fill-rule="evenodd" width="13" height="13" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/></svg>`;

// ── Provider & model metadata ──────────────────────────────────────────────────

const PROVIDERS = {
  claude: { label: 'Claude', sub: 'Anthropic', icon: CLAUDE_ICON, accent: '#c96442' },
  gemini: { label: 'Gemini', sub: 'Google',    icon: GEMINI_ICON, accent: '#1c69ff' },
  openai: { label: 'GPT',    sub: 'OpenAI',    icon: OPENAI_ICON, accent: '#10a37f' },
  groq:   { label: 'Groq',   sub: 'GroqCloud', icon: GROQ_ICON,   accent: '#f55036' },
};

// ── Small pure helpers (reasoning trace + card chrome) ──────────────────────────

function formatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

// Whisper-voice labels for the reasoning rail
const TOOL_DISPLAY = {
  read_text:                          'Reading the page',
  read_page:                          'Looking at the controls',
  act:                                'Acting on the page',
  goto:                               'Opening a page',
  COMPOSIO_SEARCH_TOOLS:              'Finding tools',
  COMPOSIO_CHECK_ACTIVE_CONNECTIONS:  'Checking connections',
  COMPOSIO_INITIATE_CONNECTION:       'Connecting',
  COMPOSIO_MANAGE_CONNECTIONS:        'Managing connections',
  // EXECUTE_ACTION / MULTI_EXECUTE_TOOL are deliberately absent: they fall
  // through to railLabel's slug branch so the row names the real action.
};

function prettify(name) {
  return (name || 'Working')
    .replace(/^COMPOSIO_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, c => c.toUpperCase());
}

function toolLabel(name) {
  return TOOL_DISPLAY[name] || prettify(name);
}

// Composio's tools are meta-tools: the real action (GMAIL_SEND_EMAIL) is a
// parameter, not the tool name. Read it from a fixed key list — never by
// scanning args for "any string", which is what used to surface junk like
// "wish" or "star" from whatever internal field happened to come first.
const SLUG_KEYS = ['tool_slug', 'slug', 'action', 'tool_name', 'toolkit_slug', 'tool'];

// Only slug-shaped values are accepted, so a wrong key can never render a nonce.
const SLUG_SHAPE = /^[A-Z][A-Z0-9_]{3,}$/;

function slugFromArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object') return '';
    for (const k of SLUG_KEYS) {
      const v = obj[k];
      if (typeof v === 'string' && SLUG_SHAPE.test(v.trim())) return v.trim();
    }
    return '';
  };
  const direct = pick(args);
  if (direct) return direct;
  // Multi-execute nests them: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', … }] }
  for (const v of Object.values(args)) {
    if (Array.isArray(v)) {
      for (const entry of v) {
        const nested = pick(entry);
        if (nested) return nested;
      }
    }
  }
  return '';
}

// A rail row's text comes from the tool's NAME, never from free-form arg text.
function railLabel(name, args) {
  if (TOOL_DISPLAY[name]) return TOOL_DISPLAY[name];
  if (/^COMPOSIO_/.test(name || '')) {
    return `${prettify(slugFromArgs(args) || name)} · executing`;
  }
  return prettify(name);
}

const PROVIDER_ORDER = ['claude', 'gemini', 'openai', 'groq'];

// How each lane reads in the reasoning rail. The server routes every turn to one of these
// before doing anything, and naming it here is what makes a misroute visible.
const ROUTE_LABELS = {
  chat:     'Answering from knowledge',
  ask_page: 'Reading this page',
  operate:  'Working on the page',
  app:      'Using a connected app',
};

// ── Key metadata ──────────────────────────────────────────────────────────────
// Provider keys live in storage under `apiKeys`, tool keys under `toolKeys`.
// Carried over from the options page this panel replaced.

const TOOL_ORDER = ['composio'];

const TOOLS = {
  composio: { label: 'Composio', sub: 'App Integrations', glyph: 'C' },
};

const KEY_HINTS = {
  claude:   { placeholder: 'sk-ant-api03-…', host: 'console.anthropic.com',  url: 'https://console.anthropic.com/',       prefix: 'sk-ant-' },
  gemini:   { placeholder: 'AIzaSy…',        host: 'aistudio.google.com',    url: 'https://aistudio.google.com/apikey',   prefix: 'AIza'    },
  openai:   { placeholder: 'sk-proj-…',      host: 'platform.openai.com',    url: 'https://platform.openai.com/api-keys', prefix: 'sk-'     },
  groq:     { placeholder: 'gsk_…',          host: 'console.groq.com',       url: 'https://console.groq.com/keys',        prefix: 'gsk_'    },
  composio: { placeholder: 'ak_…',           host: 'app.composio.dev',       url: 'https://app.composio.dev/',            prefix: 'ak_'     },
};

const EYE_OPEN_ICON = `<svg class="eye-open" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`;
const EYE_SHUT_ICON = `<svg class="eye-closed" style="display:none" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/></svg>`;

const OUTLINK_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M7 7h10v10"/></svg>`;

// Only models that can actually drive the page agent. The bar is not general
// intelligence, it is four specific things this harness demands: nested-JSON tool calls
// for act(actions), structured output for the router, picking the right line out of a
// ~200-line element map, and staying oriented after TrimSupersededMaps has deleted every
// map but the newest. Cheap and "lite" tiers fail the last two first, and a model that
// thrashes is worse than one that is absent — nothing caps repeats below TOOL_CALL_LIMIT,
// so a weak model burns minutes of the user's own API credit before anything intervenes.
//
// models[0] is the default: a stored selectedModelId that no longer exists falls back to
// it (see the restore in loadSettings), so the order here is load-bearing. Keep each
// provider's first entry in step with _resolve_llm's default in server.py.
const MODELS = {
  openai: [
    { id: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol'   },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  ],
  gemini: [
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  ],
  // Thin by evidence, not by oversight. GPT-OSS 120B was measured spiralling through 14
  // tool calls on a task Qwen completed, and 20B is the same model with less to work with.
  // groq/compound is excluded on architecture rather than quality: it brings its own
  // built-in web search and code execution, which fights a tool surface whose whole point
  // is acting on the page the user is already looking at.
  //
  // Caveat: qwen3.6-27b is preview status on GroqCloud, and Groq does retire preview
  // models (Llama 3.1 8B and 3.3 70B went on 2026-06-17). If it disappears, this provider
  // has no replacement that has been shown to work here.
  groq: [
    { id: 'qwen/qwen3.6-27b', label: 'Qwen3.6 27B' },
  ],
  // Opus 5 and Sonnet 5 are the only Claude models that reason without a code change:
  // get_claude_client passes no `thinking` parameter, and omitting it means adaptive
  // thinking on the 5 family but nothing at all on Haiku 4.5 / Sonnet 4.6 / Opus 4.6 —
  // which is the same reasoning-off state that made GPT-OSS 120B thrash. Fable 5 is
  // deliberately absent: always-on thinking and turns that can run minutes are wrong for
  // a side panel, whatever they do for quality.
  claude: [
    { id: 'claude-opus-5',   label: 'Claude Opus 5'   },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  ],
};

// ── Shared SSE stream reader ───────────────────────────────────────────────────

// Both transports carry the same frame vocabulary, so routing lives in one place.
// Returns true when the frame ends the stream.
function dispatchFrame(parsed, h) {
  if (parsed.error)       { h.onError?.(parsed.error); return true; }
  if (parsed.done)        return true;                       // WebSocket's [DONE]
  if (parsed.status)      { h.onMeta?.(parsed); return false; }
  if (parsed.route)       { h.onRoute?.(parsed.route); return false; }
  if (parsed.usage)       { h.onUsage?.(parsed.usage); return false; }
  if (parsed.tool)        { h.onTool?.(parsed.tool); return false; }
  if (parsed.tool_result) { h.onToolResult?.(parsed.tool_result); return false; }
  if (parsed.text)        h.onText?.(parsed.text);
  return false;
}

async function readSSEStream(response, handlers) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try {
          if (dispatchFrame(JSON.parse(raw), handlers)) return;
        } catch { /* skip malformed line */ }
      }
    }
  } catch (err) {
    handlers.onError?.(err.message);
  }
}

// "restricted" asks before consequential page actions; "unrestricted" runs them without
// asking. Deliberately a plain variable and NOT chrome.storage: the side panel's document
// is torn down when the panel closes, so this resets to restricted on every reopen —
// unrestricted has to be a fresh decision each time, never something left on by accident.
let agentMode = 'restricted';

// Raised when the socket never opened, which is the one case worth retrying over POST:
// an older backend, or a proxy that drops upgrades. A socket that opens and then fails is
// a real error and must surface as one.
class TransportUnavailable extends Error {}

// A backend without /chat/ws refuses the upgrade, but a proxy that blackholes it just
// hangs — so waiting for the browser's own timeout is not an option.
const WS_CONNECT_TIMEOUT_MS = 2500;
// …and once it has failed, stop paying that cost on every single question. Re-armed after
// a while so a backend deployed mid-session is picked up without a reload.
const WS_RETRY_AFTER_MS = 10 * 60 * 1000;
let wsUnavailableUntil = 0;

function wsWorthTrying() { return Date.now() >= wsUnavailableUntil; }
function markWsUnavailable() { wsUnavailableUntil = Date.now() + WS_RETRY_AFTER_MS; }

// The socket exists so page tools can run in the browser mid-turn: the server sends a
// `client_tool` frame and waits for the matching `client_tool_result`, which keeps the
// whole task inside one agent run.
function runWsQuery(payload, handlers, signal) {
  return new Promise((resolve, reject) => {
    const url = BACKEND.replace(/^http/, 'ws') + '/chat/ws';
    let ws;
    try { ws = new WebSocket(url); } catch (err) { reject(new TransportUnavailable(err.message)); return; }

    let opened = false, settled = false;
    const openTimer = setTimeout(() => {
      if (!opened) finish(new TransportUnavailable('socket did not open in time'));
    }, WS_CONNECT_TIMEOUT_MS);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      try { ws.close(); } catch { /* already closing */ }
      err ? reject(err) : resolve();
    };

    const onAbort = () => finish(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.onopen = () => { opened = true; clearTimeout(openTimer); ws.send(JSON.stringify(payload)); };

    ws.onmessage = async (ev) => {
      let parsed;
      try { parsed = JSON.parse(ev.data); } catch { return; }

      // The graph has actually paused for a human. Same round-trip shape as a client
      // tool, but the answer is a decisions object rather than text.
      if (parsed.hitl) {
        const { id, request } = parsed.hitl;
        let decisions = null;
        try {
          decisions = await handlers.onHitl?.(request);
        } catch {
          decisions = null;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ hitl_decision: { id, decisions } }));
        }
        return;
      }

      if (parsed.client_tool) {
        const { id, name, args } = parsed.client_tool;
        let result;
        try {
          result = await handlers.onClientTool?.(name, args || {});
        } catch (err) {
          result = 'The browser could not run that action: ' + (err?.message || err);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ client_tool_result: { id, result: String(result ?? '') } }));
        }
        return;
      }

      if (dispatchFrame(parsed, handlers)) finish();
    };

    ws.onerror  = () => { if (!opened) finish(new TransportUnavailable('socket error')); };
    ws.onclose  = () => finish(opened ? undefined : new TransportUnavailable('socket closed before opening'));
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const askBtn       = document.getElementById('ask');
  const input        = document.getElementById('query');
  const settingsBtn  = document.getElementById('settingsBtn');
  const responseArea = document.getElementById('responseArea');
  const shell        = document.querySelector('.popup-shell');
  const setupBtn     = document.getElementById('setupBtn');
  const newChatBtn   = document.getElementById('newChatBtn');
  // The #intro wrapper itself is never touched from here — it is shown and hidden by
  // the .chat-empty class on the shell, so only its contents need a handle.
  const introList    = document.getElementById('introList');
  const introFoot    = document.getElementById('introFoot');

  // Active-page indicator in the header
  const pageIndicator = document.getElementById('pageIndicator');
  const pageFavicon   = document.getElementById('pageFavicon');
  const pageHost      = document.getElementById('pageHost');

  // Overlay elements
  const overlay      = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayList  = document.getElementById('overlayList');
  const overlayFooter = document.getElementById('overlayFooter');
  const overlayClose = document.getElementById('overlayClose');
  const overlayBack  = document.getElementById('overlayBack');

  // Selector elements
  const providerSelector = document.getElementById('providerSelector');
  const providerBtn      = document.getElementById('providerBtn');
  const providerBtnInner = document.getElementById('providerBtnInner');
  const providerIcon     = document.getElementById('providerIcon');
  const providerLabel    = document.getElementById('providerLabel');
  const modelSelector    = document.getElementById('modelSelector');
  const modelBtn         = document.getElementById('modelBtn');
  const modelBtnInner    = document.getElementById('modelBtnInner');
  const modelLabel       = document.getElementById('modelLabel');

  let selectedProvider  = null;
  let selectedModel     = null;
  let savedApiKeys      = {};
  let savedToolKeys     = {};

  // ── One conversation per panel ──────────────────────────────────────────────
  // This is a side panel, not a popup: one document per window, alive across
  // navigation and tab switches. So the chat is bound to neither. Move forward,
  // press Back, switch tabs, open and close tabs — the same thread stays put.
  //
  // Binding it to a tab is what used to force a reset on every URL change, and
  // nothing about the model needs it: _build_messages on the backend keeps only
  // user/assistant TEXT, so no page content survives a turn anyway. Every turn
  // re-reads whatever page is in front of it.
  //
  // Which tab the agent ACTS on is a separate question, resolved per turn at send
  // time and pinned for that turn's duration. See handleQuery.
  const chat = {
    el: null,                    // the .chat-history element, set during init
    messages: [], controller: null, streaming: false, pageGeneration: 0,
  };
  let panelWindowId = null;

  const STOP_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
  const STOP_BADGE_ICON = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
  const SEND_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;

  // Send button reflects the ACTIVE view only — a background tab's stream must
  // not put the visible button into stop mode.
  function refreshSendButton() {
    const streaming = !!activeView()?.streaming;
    askBtn.innerHTML = streaming ? STOP_ICON : SEND_ICON;
    askBtn.classList.toggle('stop-mode', streaming);
    askBtn.disabled  = streaming ? false : (input.disabled || !input.value.trim());
  }

  // ── First-run gate ──────────────────────────────────────────────────────────
  // Without at least one LLM key there is nothing the panel can do, so it shows
  // the setup prompt instead of a chat the user cannot use.
  function updateSetupGate() {
    const ready = PROVIDER_ORDER.some(p => savedApiKeys[p]);
    shell.classList.toggle('needs-keys', !ready);
    input.disabled = !ready;
    input.placeholder = ready ? 'Ask about this page, or tell it what to do…' : 'Add an API key to start';
    refreshSendButton();
  }

  function setStreaming(view, on) {
    view.streaming = on;
    if (!on) view.controller = null;
    refreshSendButton();
  }

  // ── View plumbing ───────────────────────────────────────────────────────────

  function activeView() { return chat; }

  function makeHistoryEl() {
    const el = document.createElement('div');
    el.className = 'chat-history visible';
    return el;
  }

  function scrollToEnd(el) { el.scrollTop = el.scrollHeight; }

  function reveal() { responseArea.classList.add('visible'); refreshIntro(); }

  // Put the one chat element on screen and sync the controls to it.
  function attach(view) {
    if (responseArea.firstElementChild !== view.el) {
      responseArea.replaceChildren(view.el);
    }
    responseArea.classList.toggle('visible', view.el.childElementCount > 0);
    scrollToEnd(view.el);
    refreshSendButton();
    refreshNewChatBtn();
    refreshIntro();
  }

  // Empty the conversation. The only thing that clears a chat now is the user asking.
  function resetView(view) {
    view.controller?.abort();
    setStreaming(view, false);
    view.messages = [];
    view.el.replaceChildren();
    saveChat(view);
    responseArea.classList.remove('visible');
    refreshNewChatBtn();
    refreshIntro();
  }

  // ── Intro ───────────────────────────────────────────────────────────────────
  // What the extension does, shown while the chat is empty. It leads with browser
  // automation on purpose: the placeholder and the panel's shape both suggest a
  // summariser, so acting on the page is the one capability nobody discovers on
  // their own. Each row names a capability and shows one thing to type — a list of
  // bare prompts would teach only those prompts.

  const INTRO_IC = {
    zap:    '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    send:   '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    key:    '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  };

  function introIcon(name) {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${INTRO_IC[name]}</svg>`;
  }

  // Put an example in the box rather than sending it. The agent can click things, so
  // the first one a person ever runs should be one they have actually read.
  function prefill(text) {
    input.value = text;
    input.dispatchEvent(new Event('input'));   // resize the textarea, enable Send
    input.focus();
    input.setSelectionRange(text.length, text.length);
  }

  function introRows() {
    const host = pageHost.textContent;
    return [
      {
        icon: 'zap',
        name: 'Automate the browser',
        // Fixed, unlike the row below: a whole errand across sites is the clearest
        // proof that it is not stuck on the tab you happen to have open.
        eg:   '“Open a MrBeast video on YouTube”',
        run:  () => prefill('Open a MrBeast video on YouTube'),
      },
      {
        icon: 'search',
        name: 'Ask what’s on it',
        eg:   host ? `“What does ${host} say about …”` : '“What does this page say about …”',
        run:  () => prefill(host ? `What does ${host} say about ` : 'What does this page say about '),
      },
      // Both of these open the key screen rather than filling the box: each one needs a
      // key before it can do anything, and Composio's tools are not even built
      // server-side without one.
      {
        icon: 'send',
        name: 'Reach your connected apps',
        eg:   savedToolKeys.composio
          ? '“Email me a summary of this page”'
          : 'Connect apps with a Composio key',
        run:  () => showOverlay('keys'),
      },
      {
        icon: 'key',
        name: 'Bring your own model',
        eg:   'Claude · Gemini · GPT · Groq — keys stay on this device',
        run:  () => showOverlay('keys'),
      },
    ];
  }

  function renderIntro() {
    introList.replaceChildren();
    for (const row of introRows()) {
      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = 'intro-row';
      btn.innerHTML = `
        <span class="intro-ic">${introIcon(row.icon)}</span>
        <span class="intro-meta">
          <span class="intro-name">${escHtml(row.name)}</span>
          <span class="intro-eg">${escHtml(row.eg)}</span>
        </span>`;
      btn.addEventListener('click', row.run);
      introList.appendChild(btn);
    }
    paintIntroFoot();
  }

  // The one place the mode pill is ever explained, so it tracks the real setting
  // instead of assuming the default.
  function paintIntroFoot() {
    introFoot.textContent = agentMode === 'unrestricted'
      ? 'Unrestricted · acts without asking'
      : 'Restricted · asks before it clicks';
  }

  function refreshIntro() {
    const empty = !activeView()?.el.childElementCount;
    shell.classList.toggle('chat-empty', empty);
    if (empty) renderIntro();
  }

  // ── Chat persistence ────────────────────────────────────────────────────
  // One top-level key per WINDOW, because a side panel is one document per window.
  // A nested { [windowId]: messages } object would not do: storage.local.set writes
  // whole values, so each panel would overwrite the other window's entry with its own
  // mirror. A key per window makes that impossible, and needs no read-modify-write.
  //
  // Window ids do not survive a browser restart, so a new session starts fresh.

  const CHAT_KEY = (id) => `panelChat:${id}`;

  function saveChat(view) {
    if (panelWindowId == null) return;
    const key = CHAT_KEY(panelWindowId);
    if (view.messages.length) chrome.storage.local.set({ [key]: view.messages });
    else chrome.storage.local.remove(key);
  }

  function renderMessages(view) {
    for (const msg of view.messages) {
      if (msg.role === 'user') {
        const wrap = document.createElement('div');
        wrap.className = 'chat-msg user';
        wrap.innerHTML = `<div class="chat-bubble user-bubble">${escHtml(msg.content)}</div>`;
        view.el.appendChild(wrap);
      } else {
        view.el.appendChild(renderStoredAiTurn(msg));
      }
    }
    scrollToEnd(view.el);
  }

  // Rebuild a completed AI turn (folded rail + answer card) from a stored message
  function renderStoredAiTurn(msg) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ai';
    const turnEl = document.createElement('div');
    turnEl.className = 'ai-turn';
    if (msg.provider && PROVIDERS[msg.provider])
      turnEl.style.setProperty('--accent', PROVIDERS[msg.provider].accent);

    const steps = Array.isArray(msg.steps) ? msg.steps : [];
    if (steps.length) {
      const rail = document.createElement('div');
      rail.className = 'whisper-rail';
      let toolCount = 0;
      for (const s of steps) {
        if (s.kind === 'tool') {
          // s.label is absent on chats stored before the rail rewrite
          rail.appendChild(railToolEl(s.label || toolLabel(s.name), { done: true, count: s.count || 1 }));
          toolCount++;
        } else if (s.kind === 'reason' && s.text) {
          rail.appendChild(railReasonEl(s.text));
        }
      }
      turnEl.appendChild(rail);
      foldRail(turnEl, rail, toolCount || steps.length, msg.durationMs,
               { stopped: !!msg.interrupted, usage: msg.usage || null });
    }

    const { card, body } = makeCard(msg.provider, msg.model);
    if ((msg.content || '').trim()) body.innerHTML = renderMarkdown(msg.content);
    else body.innerHTML = emptyBodyHTML(msg.interrupted);
    turnEl.appendChild(card);
    addCardFooter(card, msg.ts, msg.content || '', { interrupted: !!msg.interrupted });
    wrap.appendChild(turnEl);
    return wrap;
  }

  function clearActiveChat() {
    resetView(chat);
  }

  // Nothing to start over from on an empty chat — say so rather than no-op
  function refreshNewChatBtn() {
    newChatBtn.disabled = !activeView()?.el.childElementCount;
  }

  // ── Load saved state ───────────────────────────────────────────────────────

  async function loadSettings() {
    const res = await chrome.storage.local.get(
      ['apiKeys', 'toolKeys', 'apiProvider', 'apiKey', 'selectedProvider', 'selectedModelId']
    );
    savedApiKeys  = res.apiKeys  || {};
    savedToolKeys = res.toolKeys || {};

    // Migrate legacy single-key storage
    if (res.apiProvider && res.apiKey && !savedApiKeys[res.apiProvider])
      savedApiKeys[res.apiProvider] = res.apiKey;

    // Drop keys for providers this build no longer ships (a renamed or removed
    // provider), so a stale `selectedProvider` can't point at a missing model list.
    const stale = Object.keys(savedApiKeys).filter(p => !MODELS[p]);
    if (stale.length) {
      stale.forEach(p => delete savedApiKeys[p]);
      chrome.storage.local.set({ apiKeys: savedApiKeys });
    }

    const lastProvider = res.selectedProvider && savedApiKeys[res.selectedProvider]
      ? res.selectedProvider : null;
    selectedProvider = lastProvider || PROVIDER_ORDER.find(p => savedApiKeys[p]) || null;

    if (selectedProvider) {
      const models = MODELS[selectedProvider];
      selectedModel = models.find(m => m.id === res.selectedModelId) || models[0];
    }

    renderProviderBtn();
    renderModelBtn();
  }

  // Return this window's stored conversation, and tidy up on the way through: the
  // per-tab shapes this replaced, plus keys for windows that no longer exist.
  //
  // `chats` and `chatMessages`/`chatPageUrl` were keyed by TAB. Tab ids and window ids
  // share a number space, so a leftover chats['101'] would read as window 101 — hence a
  // new key namespace rather than a migration.
  async function loadChat() {
    const all   = await chrome.storage.local.get(null);
    const live  = new Set((await chrome.tabs.query({})).map(t => CHAT_KEY(t.windowId)));
    const stale = ['chats', 'chatMessages', 'chatPageUrl'].filter(k => all[k] !== undefined);
    const dead  = Object.keys(all).filter(k => k.startsWith('panelChat:') && !live.has(k));
    if (stale.length || dead.length) chrome.storage.local.remove([...stale, ...dead]);

    const mine = all[CHAT_KEY(panelWindowId)];
    return Array.isArray(mine) ? mine : [];
  }

  // ── Active-page indicator ──────────────────────────────────────────────────

  pageFavicon.addEventListener('error', () => pageFavicon.removeAttribute('src'));

  function renderPageIndicator(tab) {
    let host = '';
    try { host = new URL(tab?.url || '').hostname.replace(/^www\./, ''); }
    catch { /* chrome://, about:, a local file — nothing worth showing */ }

    if (!host) {
      pageIndicator.classList.remove('visible');
      pageHost.textContent = '';   // the intro reads this to name the current site
      refreshIntro();
      return;
    }
    pageHost.textContent = host;
    pageHost.title       = tab.url;
    if (tab.favIconUrl) pageFavicon.src = tab.favIconUrl;
    else pageFavicon.removeAttribute('src');
    pageIndicator.classList.add('visible');
    refreshIntro();
  }

  // ── Tab tracking ───────────────────────────────────────────────────────────
  // The chat no longer cares which tab is in front. These listeners only keep the
  // header indicator honest, so the user can see which page the agent would act on.

  let shownTabId = null;

  async function showTab(tabId) {
    shownTabId = tabId;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    // Fast switching can resolve these out of order — only the newest wins.
    if (!tab || shownTabId !== tabId) return;
    renderPageIndicator(tab);
  }

  // These fire for every window; this panel owns exactly one.
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (windowId !== panelWindowId) return;
    showTab(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.windowId !== panelWindowId) return;
    // Favicon and title land after the URL, so refresh the header on those too.
    if (tabId === shownTabId && (changeInfo.url || changeInfo.favIconUrl || changeInfo.title)) {
      renderPageIndicator(tab);
    }
  });

  (async () => {
    await loadSettings();
    updateSetupGate();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) panelWindowId = tab.windowId;
    const saved = await loadChat();

    chat.el = makeHistoryEl();
    if (saved.length) {
      chat.messages = saved;
      renderMessages(chat);
    }
    attach(chat);

    if (tab?.id != null) await showTab(tab.id);
    else refreshSendButton();
  })();

  // ── UI helpers ─────────────────────────────────────────────────────────────

  const TICK_ICON    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
  const CHEVRON_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;
  const COPY_ICON    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Card + rail builders (shared by live streaming and history replay) ───────

  function cardHeaderHTML(provider, model) {
    const prov = provider && PROVIDERS[provider];
    if (prov) {
      const meta = model ? `${prov.label} · ${model}` : prov.label;
      return `<span class="ai-card-ic">${prov.icon}</span><span class="ai-card-meta">${escHtml(meta)}</span>`;
    }
    return `<span class="ai-card-ic sw">${AI_AVATAR_SVG}</span><span class="ai-card-meta">SiteWhisper</span>`;
  }

  function makeCard(provider, model) {
    const card = document.createElement('div');
    card.className = 'ai-card';
    const header = document.createElement('div');
    header.className = 'ai-card-header';
    header.innerHTML = cardHeaderHTML(provider, model);
    const body = document.createElement('div');
    body.className = 'ai-card-body';
    card.append(header, body);
    return { card, body };
  }

  // Body text for a turn that produced no answer. An interrupted one says so rather than
  // claiming it finished.
  function emptyBodyHTML(interrupted) {
    return `<p class="ai-empty">${interrupted ? 'Stopped before answering.' : 'Done.'}</p>`;
  }

  function addCardFooter(card, ts, rawText, { interrupted = false } = {}) {
    const footer = document.createElement('div');
    footer.className = 'ai-card-footer';
    if (interrupted) {
      const badge = document.createElement('span');
      badge.className = 'ai-interrupted';
      badge.innerHTML = `${STOP_BADGE_ICON}<span>Interrupted</span>`;
      footer.appendChild(badge);
    }
    const time = document.createElement('span');
    time.className = 'ai-time';
    time.textContent = formatTime(ts);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-btn';
    copy.innerHTML = `${COPY_ICON}<span>Copy</span>`;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rawText || '');
        copy.classList.add('copied');
        copy.querySelector('span').textContent = 'Copied';
        setTimeout(() => {
          copy.classList.remove('copied');
          const s = copy.querySelector('span'); if (s) s.textContent = 'Copy';
        }, 1400);
      } catch { /* clipboard blocked — ignore */ }
    });
    footer.append(time, copy);
    card.appendChild(footer);
  }

  function railReasonEl(text) {
    const el = document.createElement('div');
    el.className = 'rail-step reason';
    el.innerHTML = `<span class="rail-dot"></span><span class="rail-body"><span class="rail-reason"></span></span>`;
    el.querySelector('.rail-reason').textContent = text;
    return el;
  }

  function railToolEl(label, { done = false, count = 1 } = {}) {
    const el = document.createElement('div');
    el.className = 'rail-step tool' + (done ? ' done' : ' active');
    el.innerHTML =
      `<span class="rail-dot">${done ? TICK_ICON : ''}</span>` +
      `<span class="rail-body">` +
        `<span class="rail-tool-label">${escHtml(label)}</span>` +
        `<span class="rail-count"></span>` +
      `</span>`;
    setRailCount(el, count);
    return el;
  }

  // Values the user typed into a `secret` prompt. They are held here and swapped in at
  // the moment of typing, so a password reaches the page WITHOUT ever reaching the model.
  // Module-scoped, so it dies with the panel and is never persisted.
  const secretVault = new Map();
  let secretSeq = 0;

  function stashSecret(value) {
    const token = `__sw_secret_${++secretSeq}__`;
    secretVault.set(token, value);
    return token;
  }

  // Swap placeholders back for real values on their way to the page. Exact-match only: if
  // the model mangles a token, the fill types the token and fails visibly rather than
  // leaking or silently doing the wrong thing.
  function fillSecrets(actions) {
    return actions.map((a) => (
      a && typeof a.text === 'string' && secretVault.has(a.text)
        ? { ...a, text: secretVault.get(a.text) }
        : a
    ));
  }

  // One block per action the middleware is holding. Resolves with a decision array in the
  // same order — the count is a hard contract, the middleware raises without it.
  function railHitlEl(request, onComplete) {
    const requests = Array.isArray(request?.action_requests) ? request.action_requests : [];
    const configs  = new Map(
      (request?.review_configs || []).map((c) => [c.action_name, c])
    );

    const wrap = document.createElement('div');
    wrap.className = 'rail-step hitl active';
    const dot = document.createElement('span');
    dot.className = 'rail-dot';
    const body = document.createElement('span');
    body.className = 'rail-body hitl-body';
    wrap.append(dot, body);

    const decisions = new Array(requests.length).fill(null);
    let settled = false;

    const settle = (summary) => {
      if (settled) return;
      settled = true;
      wrap.classList.remove('active');
      wrap.classList.add('done');
      dot.innerHTML = TICK_ICON;
      body.innerHTML = `<span class="rail-tool-label">${escHtml(summary)}</span>`;
      onComplete(decisions.map((d) => d || { type: 'reject', message: 'No decision was made.' }), summary);
    };

    const record = (i, decision, summary) => {
      if (settled || decisions[i]) return;
      decisions[i] = decision;
      if (decisions.every(Boolean)) settle(summary);
    };

    requests.forEach((req, i) => {
      const cfg     = configs.get(req?.name) || {};
      const allowed = cfg.allowed_decisions || ['approve', 'reject'];
      const block   = document.createElement('span');
      block.className = 'hitl-item';

      // "respond" means the human's answer IS the tool result — the ask_user shape.
      if (allowed.includes('respond')) {
        const a        = req?.args || {};
        const kind     = String(a.kind || 'text').toLowerCase();
        const question = String(a.question || 'The agent needs some input.');

        const q = document.createElement('span');
        q.className = 'hitl-question';
        q.textContent = question;
        block.appendChild(q);

        const answer = (text, shown) => {
          const message = kind === 'secret'
            ? `The user supplied the value. When you need to enter it, use exactly this ` +
              `placeholder as the text: ${stashSecret(text)}`
            : text;
          record(i, { type: 'respond', message }, shown);
        };

        if (kind === 'choice' && Array.isArray(a.options) && a.options.length) {
          const row = document.createElement('span');
          row.className = 'hitl-actions';
          a.options.slice(0, 6).forEach((opt) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'hitl-btn';
            b.textContent = String(opt);
            b.addEventListener('click', () => answer(String(opt), `You chose "${opt}"`));
            row.appendChild(b);
          });
          block.appendChild(row);
        } else {
          const row = document.createElement('span');
          row.className = 'hitl-actions';
          const field = document.createElement('input');
          field.className = 'hitl-input';
          field.type = kind === 'secret' ? 'password' : 'text';
          field.placeholder = kind === 'secret' ? 'Value stays in the browser' : 'Your answer…';
          const send = document.createElement('button');
          send.type = 'button';
          send.className = 'hitl-btn primary';
          send.textContent = 'Send';
          const submit = () => {
            const v = field.value.trim();
            if (!v) { field.focus(); return; }
            // A secret is never echoed into the rail, and `steps` is persisted.
            answer(v, kind === 'secret' ? 'You provided a value' : `You answered "${v}"`);
          };
          send.addEventListener('click', submit);
          field.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
          row.append(field, send);
          block.appendChild(row);
          setTimeout(() => field.focus(), 0);
        }
      } else {
        // Approval.
        const q = document.createElement('span');
        q.className = 'hitl-question';
        q.textContent = req?.description || `Allow ${req?.name || 'this action'}?`;
        const row = document.createElement('span');
        row.className = 'hitl-actions';

        const approve = document.createElement('button');
        approve.type = 'button';
        approve.className = 'hitl-btn primary';
        approve.textContent = 'Approve';
        approve.addEventListener('click', () => record(i, { type: 'approve' }, 'You approved it'));

        const reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'hitl-btn';
        reject.textContent = 'Reject';
        reject.addEventListener('click', () => record(i,
          { type: 'reject', message: 'The user declined this action.' }, 'You declined it'));

        row.append(approve, reject);
        block.append(q, row);
      }

      body.appendChild(block);
    });

    // The turn was stopped while this prompt was still open. Deliberately does NOT call
    // onComplete — the graph is gone, and resolving askHuman would push a step and restart
    // the elapsed ticker on a dead turn.
    const cancel = () => {
      if (settled) return;
      settled = true;
      wrap.classList.remove('active');
      wrap.classList.add('stopped');
      body.innerHTML = `<span class="rail-tool-label">Stopped</span>`;
    };

    if (!requests.length) settle('Nothing to approve');
    return { el: wrap, settle, cancel };
  }

  // A retried call collapses into its own row rather than repeating it
  function setRailCount(el, count) {
    const badge = el.querySelector('.rail-count');
    if (badge) badge.textContent = count > 1 ? `×${count}` : '';
  }

  // Collapse a finished rail into a "Whispered through N steps · Ns" chip
  // Tokens are shown as "1.3k" rather than exactly: the useful signal is order of
  // magnitude — whether a turn cost hundreds or tens of thousands.
  function formatTokens(n) {
    if (!n) return '';
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
  }

  function foldRail(turnEl, railEl, stepCount, durationMs, { stopped = false, usage = null } = {}) {
    const secs = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'trace-chip';
    const verb  = stopped ? 'Stopped after' : 'Whispered through';
    const toks  = usage?.total ? ` · ${formatTokens(usage.total)} tokens` : '';
    const label = `${verb} ${stepCount} step${stepCount === 1 ? '' : 's'}` +
                  `${secs ? ` · ${secs}s` : ''}${toks}`;
    chip.innerHTML = `<span class="chip-chev">${CHEVRON_ICON}</span><span>${escHtml(label)}</span>`;
    railEl.classList.add('collapsed');
    chip.addEventListener('click', () => {
      const open = railEl.classList.toggle('open');
      chip.classList.toggle('open', open);
    });
    turnEl.insertBefore(chip, railEl);
  }

  // Live streaming controller for one AI turn (reasoning rail + answer card)
  function createAiTurn(view, provider, model) {
    reveal();

    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ai';
    const turnEl = document.createElement('div');
    turnEl.className = 'ai-turn';
    if (provider && PROVIDERS[provider]) turnEl.style.setProperty('--accent', PROVIDERS[provider].accent);

    const rail = document.createElement('div');
    rail.className = 'whisper-rail';
    const waiting = document.createElement('div');
    waiting.className = 'rail-step reason active waiting';
    waiting.innerHTML = `<span class="rail-dot"></span><span class="rail-body"><span class="whispering-label">Whispering</span>${TYPING_SVG}<span class="rail-elapsed"></span></span>`;
    rail.appendChild(waiting);

    const { card, body } = makeCard(provider, model);
    card.style.display = 'none';   // revealed once real answer text streams in

    turnEl.append(rail, card);
    wrap.appendChild(turnEl);
    view.el.appendChild(wrap);
    scrollToEnd(view.el);

    const startTs = Date.now();
    const steps   = [];         // persisted: {kind:'reason'|'tool', ...}
    const toolEls = {};         // tool id -> { el, item }
    let lastToolEl = null;      // for collapsing consecutive identical calls
    let answer    = '';         // provisional final-answer markdown
    let toolCount = 0;
    let turnUsage = null;       // token total, once the server reports it

    // The waiting row is shown whenever the turn is live and nothing else is
    // animating — notably BETWEEN steps, which is where the agent actually
    // spends its time. It used to be destroyed on the first tool call.
    let ticker = null;
    const elapsedEl = waiting.querySelector('.rail-elapsed');

    function paintElapsed() {
      const secs = Math.round((Date.now() - startTs) / 1000);
      elapsedEl.textContent = secs >= 1 ? `${secs}s` : '';
    }
    function startTicker() {
      paintElapsed();
      ticker ??= setInterval(paintElapsed, 1000);
    }
    // The panel outlives every turn, so a stray interval would run forever
    function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

    const showWaiting = () => {
      waiting.remove();          // re-append so it stays the LAST row
      rail.appendChild(waiting);
      startTicker();
    };
    const hideWaiting = () => { waiting.remove(); stopTicker(); };

    startTicker();
    // The prompt currently waiting on the user, so a stop can close it out
    let liveHitl = null;

    // Any text collected in the answer body before a tool call was actually reasoning
    function flushAnswerAsReason() {
      const t = answer.trim();
      if (t) {
        steps.push({ kind: 'reason', text: t });
        rail.appendChild(railReasonEl(t));
      }
      answer = '';
      body.innerHTML = '';
      card.style.display = 'none';
    }

    return {
      // The graph is paused. Park the rail on a prompt and hand back the user's decisions.
      askHuman(request) {
        // Stop the clock: the user reading a prompt is not the agent being slow, and a
        // ticking counter next to a question reads as a hang.
        hideWaiting();
        return new Promise((resolve) => {
          const hitl = railHitlEl(request, (decisions, summary) => {
            liveHitl = null;
            // The summary comes from the row that produced it rather than being scraped
            // back out of the DOM — `steps` is persisted, so it must never accidentally
            // capture a secret the row deliberately never displayed.
            steps.push({ kind: 'reason', text: summary || 'Responded' });
            showWaiting();          // the agent is working again
            resolve(decisions);
          });
          liveHitl = hitl;
          rail.appendChild(hitl.el);
          scrollToEnd(view.el);
        });
      },

      onText(delta) {
        hideWaiting();
        answer += delta;
        card.style.display = '';
        body.innerHTML = renderMarkdown(answer);
        scrollToEnd(view.el);
      },
      onTool(tool) {
        hideWaiting();
        flushAnswerAsReason();
        // Accept both the new object form {name,args,id} and the legacy string form
        const isObj = tool && typeof tool === 'object';
        const name  = isObj ? tool.name : tool;
        const args  = isObj ? tool.args : null;
        const label = railLabel(name, args);
        // Temporary: reveals Composio's real arg keys so SLUG_KEYS can be tightened
        console.debug('[SiteWhisper] tool', name, Object.keys(args || {}));

        const last = steps[steps.length - 1];
        if (last && last.kind === 'tool' && last.label === label && lastToolEl) {
          last.count = (last.count || 1) + 1;
          setRailCount(lastToolEl, last.count);
          lastToolEl.classList.remove('done');
          lastToolEl.classList.add('active');
          lastToolEl.querySelector('.rail-dot').innerHTML = '';
          if (isObj && tool.id != null) toolEls[tool.id] = { el: lastToolEl, item: last };
          scrollToEnd(view.el);
          return;
        }

        const item = { kind: 'tool', name, label, count: 1 };
        steps.push(item);
        const el = railToolEl(label);
        rail.appendChild(el);
        lastToolEl = el;
        if (isObj && tool.id != null) toolEls[tool.id] = { el, item };
        toolCount++;
        scrollToEnd(view.el);
      },
      // Which lane took the turn. Shown as a rail step so a misroute is visible in the
      // trace rather than something to be inferred from which tools ran.
      onRoute(lane) {
        const label = ROUTE_LABELS[lane] || `Routing: ${lane}`;
        steps.push({ kind: 'tool', name: `route:${lane}`, label, count: 1 });
        const el = railToolEl(label, { done: true });
        rail.appendChild(el);
        lastToolEl = null;   // a route is never the target of a tool_result tick
        scrollToEnd(view.el);
      },
      onUsage(u) {
        turnUsage = u;
      },
      onToolResult(res) {
        const ref = res && res.id != null ? toolEls[res.id] : null;
        if (ref) {
          ref.el.classList.remove('active');
          ref.el.classList.add('done');
          ref.el.querySelector('.rail-dot').innerHTML = TICK_ICON;
        }
        showWaiting();   // nothing animates between steps otherwise
        scrollToEnd(view.el);
      },
      // Finalize: fold the rail, stamp footer, return the record to persist
      finish() {
        hideWaiting();
        // Resolve any tool still shown as running (e.g. a backend that never sent tool_result)
        rail.querySelectorAll('.rail-step.tool.active').forEach(el => {
          el.classList.remove('active');
          el.classList.add('done');
          el.querySelector('.rail-dot').innerHTML = TICK_ICON;
        });
        const durationMs = Date.now() - startTs;
        const ts = Date.now();
        if (toolCount > 0 || steps.length > 0) {
          foldRail(turnEl, rail, toolCount || steps.length, durationMs, { usage: turnUsage });
        } else {
          rail.remove();
        }
        card.style.display = '';
        if (!answer.trim()) body.innerHTML = emptyBodyHTML(false);
        addCardFooter(card, ts, answer);
        scrollToEnd(view.el);
        return { content: answer, provider, model, ts, durationMs, steps, usage: turnUsage };
      },
      // The user hit stop. Same shape as finish(), but the turn is labelled as cut short
      // instead of being deleted — a vanished bubble leaves the question looking ignored.
      interrupt() {
        hideWaiting();
        liveHitl?.cancel();   // its buttons would otherwise stay live on a dead turn
        // A tick here would claim a call that never came back had succeeded
        rail.querySelectorAll('.rail-step.tool.active').forEach(el => {
          el.classList.remove('active');
          el.classList.add('stopped');
          el.querySelector('.rail-dot').innerHTML = '';
        });
        const durationMs = Date.now() - startTs;
        const ts = Date.now();
        if (toolCount > 0 || steps.length > 0) {
          foldRail(turnEl, rail, toolCount || steps.length, durationMs,
                   { stopped: true, usage: turnUsage });
        } else {
          rail.remove();
        }
        card.style.display = '';
        if (!answer.trim()) body.innerHTML = emptyBodyHTML(true);
        addCardFooter(card, ts, answer, { interrupted: true });
        scrollToEnd(view.el);
        return { content: answer, provider, model, ts, durationMs, steps,
                 usage: turnUsage, interrupted: true };
      },
      fail(text) {
        hideWaiting();
        rail.remove();
        card.style.display = '';
        body.className = 'ai-card-body error';
        body.textContent = text;
        scrollToEnd(view.el);
      },
      discard() { stopTicker(); wrap.remove(); },
    };
  }

  // Standalone error bubble (used before a turn exists, e.g. missing key)
  function showError(text, view = chat) {
    if (!view.el) { console.error('SiteWhisper:', text); return; }   // panel still initialising
    reveal();
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ai';
    wrap.innerHTML = `<div class="ai-turn"><div class="ai-card"><div class="ai-card-body error">${escHtml(text)}</div></div></div>`;
    view.el.appendChild(wrap);
    scrollToEnd(view.el);
    refreshNewChatBtn();
  }

  // ── Provider / model buttons ───────────────────────────────────────────────

  function renderProviderBtn() {
    if (!selectedProvider) { providerIcon.innerHTML = ''; providerLabel.textContent = 'Provider'; return; }
    providerIcon.innerHTML    = PROVIDERS[selectedProvider].icon;
    providerLabel.textContent = PROVIDERS[selectedProvider].label;
  }

  function renderModelBtn() {
    modelLabel.textContent = selectedModel ? selectedModel.label : 'Model';
  }

  function animate(el) {
    el.classList.remove('switching');
    void el.offsetWidth;
    el.classList.add('switching');
  }

  // ── Keys screen ────────────────────────────────────────────────────────────
  // Replaces the old options page. Saved keys are never rendered back into the
  // inputs — a "Saved" badge stands in, so a stored secret can't be read off
  // the screen. Saving merges, so a key the user didn't retype survives.

  const KEY_GROUPS = [
    { title: 'Provider Keys', ids: PROVIDER_ORDER, scope: 'api',
      meta: id => PROVIDERS[id],
      iconHTML: id => PROVIDERS[id].icon,
      saved: id => !!savedApiKeys[id] },
    { title: 'Tool Keys', ids: TOOL_ORDER, scope: 'tool',
      meta: id => TOOLS[id],
      iconHTML: id => `<span class="key-glyph">${TOOLS[id].glyph}</span>`,
      saved: id => !!savedToolKeys[id] },
  ];

  // One accordion row: the name is all you see until it's tapped open.
  function keyRowEl(group, id) {
    const meta = group.meta(id);
    const hint = KEY_HINTS[id];
    const row  = document.createElement('div');
    row.className = 'key-acc';
    row.innerHTML = `
      <button class="key-acc-head" type="button">
        <span class="key-row-left">
          <span class="key-row-icon">${group.iconHTML(id)}</span>
          <span class="key-row-meta">
            <span class="key-row-name">${escHtml(meta.label)}</span>
            <span class="key-row-sub">${escHtml(meta.sub)}</span>
          </span>
        </span>
        <span class="key-acc-right">
          <span class="saved-badge${group.saved(id) ? ' visible' : ''}" data-badge="${id}">${TICK_ICON}Saved</span>
          <svg class="key-acc-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </span>
      </button>
      <div class="key-acc-body">
        <div class="input-wrap">
          <input type="password" class="key-input" data-key="${id}"
                 placeholder="${escHtml(hint.placeholder)}" autocomplete="off" spellcheck="false" />
          <button class="eye-btn" type="button">${EYE_OPEN_ICON}${EYE_SHUT_ICON}</button>
        </div>
        <p class="hint">Get at <a href="${hint.url}" target="_blank" rel="noopener">${escHtml(hint.host)}</a> — starts with <code>${escHtml(hint.prefix)}</code></p>
      </div>`;

    const field = row.querySelector('.key-input');

    // Accordion: opening one closes the rest. A collapsed row keeps whatever was
    // typed into it, so Save still picks up every key entered this visit.
    row.querySelector('.key-acc-head').addEventListener('click', () => {
      const wasOpen = row.classList.contains('open');
      overlayList.querySelectorAll('.key-acc').forEach(r => r.classList.remove('open'));
      if (!wasOpen) { row.classList.add('open'); field.focus?.(); }
    });

    // Eye toggle — lets the user verify what they just pasted
    row.querySelector('.eye-btn').addEventListener('click', (e) => {
      const hidden = field.type === 'password';
      field.type = hidden ? 'text' : 'password';
      e.currentTarget.querySelector('.eye-open').style.display   = hidden ? 'none' : '';
      e.currentTarget.querySelector('.eye-closed').style.display = hidden ? ''     : 'none';
    });
    return row;
  }

  function renderKeysScreen() {
    for (const group of KEY_GROUPS) {
      const wrap = document.createElement('div');
      wrap.className = 'ov-group';
      const title = document.createElement('div');
      title.className = 'ov-group-title';
      title.textContent = group.title;
      wrap.appendChild(title);
      group.ids.forEach(id => wrap.appendChild(keyRowEl(group, id)));
      overlayList.appendChild(wrap);
    }

    const saveBtn = document.createElement('button');
    saveBtn.type      = 'button';
    saveBtn.className = 'save-btn';
    saveBtn.textContent = 'Save Keys';
    const status = document.createElement('div');
    status.className = 'status-msg';
    overlayFooter.append(saveBtn, status);

    const setStatus = (msg, isError) => {
      status.textContent = msg;
      status.className   = 'status-msg ' + (isError ? 'error' : 'success');
    };

    saveBtn.addEventListener('click', async () => {
      const collected = { api: {}, tool: {} };
      for (const group of KEY_GROUPS) {
        for (const id of group.ids) {
          const val = overlayList.querySelector(`.key-input[data-key="${id}"]`)?.value.trim();
          if (val) collected[group.scope][id] = val;
        }
      }
      const added = [...Object.keys(collected.api), ...Object.keys(collected.tool)];
      if (!added.length) { setStatus('Enter at least one key to save.', true); return; }

      saveBtn.disabled    = true;
      saveBtn.textContent = 'Saving…';
      try {
        // Merge over what's stored — never clobber a key that wasn't retyped
        const cur = await chrome.storage.local.get(['apiKeys', 'toolKeys']);
        await chrome.storage.local.set({
          apiKeys:  { ...(cur.apiKeys  || {}), ...collected.api  },
          toolKeys: { ...(cur.toolKeys || {}), ...collected.tool },
        });
      } catch (err) {
        saveBtn.disabled    = false;
        saveBtn.textContent = 'Save Keys';
        setStatus('Could not save: ' + err.message, true);
        return;
      }

      // Re-reads keys, auto-selects a provider and re-renders the selectors
      await loadSettings();
      updateSetupGate();
      refreshIntro();   // a Composio key just arriving changes what the apps row offers

      added.forEach(id => {
        overlayList.querySelector(`.saved-badge[data-badge="${id}"]`)?.classList.add('visible');
        const field = overlayList.querySelector(`.key-input[data-key="${id}"]`);
        if (field) { field.value = ''; field.type = 'password'; }
      });
      // Fold everything back to the plain name list, now showing Saved badges
      overlayList.querySelectorAll('.key-acc').forEach(r => r.classList.remove('open'));
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Save Keys';
      setStatus('Saved!', false);
      setTimeout(hideOverlay, 700);
    });
  }

  // ── Tips ──────────────────────────────────────────────────────────────────

  // Things that look like bugs but are not: a throttled free key, a model too weak to
  // drive the page, a turn that does not remember the last one. Each costs a new user a
  // bad first impression that one sentence prevents. Groups are data so adding a tip is
  // an array entry, not new markup.
  const TIPS = [
    { label: 'Speed', lines: [
      'A free API key is rate-limited, so replies are slow and page actions may not finish. A paid key is much faster.',
      'The first request after a quiet spell wakes the server and can take up to 30 seconds.',
    ]},
    { label: 'Models', lines: [
      'Cheaper models struggle with clicking and typing. For anything beyond questions, use Claude or Gemini.',
    ]},
    { label: 'How it behaves', lines: [
      'Each message stands on its own — it doesn’t remember the last one, so say the whole task in one go.',
      'It works in the tab you opened it from, and can’t switch tabs.',
      'Restricted mode asks before risky clicks, and resets every time you reopen the panel.',
    ]},
  ];

  function renderTipsScreen() {
    const wrap = document.createElement('div');
    wrap.className = 'tips';
    wrap.innerHTML = TIPS.map(group => `
      <div class="tip-group">
        <p class="about-label">${escHtml(group.label)}</p>
        ${group.lines.map(line => `<p class="tip-line">${escHtml(line)}</p>`).join('')}
      </div>`).join('');
    overlayList.appendChild(wrap);
  }

  // ── About ─────────────────────────────────────────────────────────────────

  // The version is read from the manifest, never written here. The store rejects an
  // upload whose version was not bumped, so a literal in this file would sooner or later
  // name a version that was never shipped — and this screen is the one place a user
  // looks to find out what they are running.
  function renderAboutScreen() {
    const version = chrome.runtime.getManifest().version;

    const wrap = document.createElement('div');
    wrap.className = 'about';
    wrap.innerHTML = `
      <div class="about-block">
        <div class="about-head">
          <span class="about-app">SiteWhisper</span>
          <span class="about-version">${escHtml(version)}</span>
        </div>
        <p class="about-body">Reads the page you’re on and acts on it — fills forms,
           clicks through flows, looks things up.</p>
        <p class="about-body">Runs on your own API key. Keys and chats stay in your
           browser.</p>
      </div>

      <div class="about-rule"></div>

      <div class="about-block">
        <p class="about-label">Built by</p>
        <p class="about-person">Utkarsh Singh</p>
        <p class="about-roles">AI Engineer · Web Developer · Software Engineer</p>
        <p class="about-roles">Agentic enthusiast</p>
        <a class="about-link" href="https://github.com/utkarsh0p"
           target="_blank" rel="noopener">${OUTLINK_ICON}github.com/utkarsh0p</a>
      </div>`;

    overlayList.appendChild(wrap);
  }

  // ── Overlay ────────────────────────────────────────────────────────────────

  function showOverlay(mode, prevMode = null) {
    overlayList.innerHTML = '';
    overlayFooter.innerHTML = '';
    overlayBack.style.display = prevMode ? 'flex' : 'none';
    overlayBack.onclick = prevMode ? () => showOverlay(prevMode) : null;

    if (mode === 'menu') {
      overlayTitle.textContent = 'Menu';

      const items = [
        {
          icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>`,
          label: 'API Keys', sub: 'Providers and tools',
          action: () => showOverlay('keys', 'menu'),
        },
        {
          icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21.5h4"/><path d="M12 2.5a6.5 6.5 0 0 0-3.7 11.8V15h7.4v-.7A6.5 6.5 0 0 0 12 2.5z"/></svg>`,
          label: 'Tips', sub: 'Speed, limits, and quirks',
          action: () => showOverlay('tips', 'menu'),
        },
        {
          icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11.5v4.5"/><path d="M12 7.75h.01"/></svg>`,
          label: 'About', sub: 'Version and credits',
          action: () => showOverlay('about', 'menu'),
        },
      ];   // Clear Chat lives in the header now, not in here

      items.forEach(item => {
        const btn = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'ov-option menu-option' + (item.disabled ? ' menu-disabled' : '');
        btn.innerHTML = `
          <span class="ov-left">
            <span class="ov-icon">${item.icon}</span>
            <span class="ov-meta">
              <span class="ov-name">${item.label}</span>
              <span class="ov-sub">${item.sub}</span>
            </span>
          </span>
          ${item.disabled
            ? '<span class="menu-soon">Soon</span>'
            : `<svg class="menu-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`
          }`;
        if (!item.disabled) btn.addEventListener('click', item.action);
        overlayList.appendChild(btn);
      });

    } else if (mode === 'keys') {
      overlayTitle.textContent = 'API Keys';
      renderKeysScreen();

    } else if (mode === 'tips') {
      overlayTitle.textContent = 'Tips';
      renderTipsScreen();

    } else if (mode === 'about') {
      overlayTitle.textContent = 'About';
      renderAboutScreen();

    } else if (mode === 'provider') {
      overlayTitle.textContent = 'Choose Provider';

      PROVIDER_ORDER.forEach(provKey => {
        const prov     = PROVIDERS[provKey];
        const hasKey   = !!savedApiKeys[provKey];
        const isActive = provKey === selectedProvider;
        const btn = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'ov-option' + (isActive ? ' active' : '') + (!hasKey ? ' nokey' : '');
        btn.innerHTML = `
          <span class="ov-left">
            <span class="ov-icon">${prov.icon}</span>
            <span class="ov-meta">
              <span class="ov-name">${prov.label}</span>
              <span class="ov-sub">${prov.sub}${!hasKey ? ' &nbsp;·&nbsp; <span class="ov-nokey-tag">no key</span>' : ''}</span>
            </span>
          </span>
          <svg class="ov-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
        btn.addEventListener('click', () => {
          if (hasKey) {
            selectedProvider = provKey;
            selectedModel    = MODELS[provKey][0];
            chrome.storage.local.set({ selectedProvider, selectedModelId: selectedModel.id });
            animate(providerBtnInner);
            animate(modelBtnInner);
            renderProviderBtn();
            renderModelBtn();
            hideOverlay();
          } else {
            // No key for this provider — go add one, with a way back
            showOverlay('keys', 'provider');
          }
        });
        overlayList.appendChild(btn);
      });

    } else {
      // model picker
      overlayTitle.textContent = 'Choose Model';
      if (selectedProvider) {
        MODELS[selectedProvider].forEach(m => {
          const isActive = m.id === selectedModel?.id;
          const btn = document.createElement('button');
          btn.type      = 'button';
          btn.className = 'ov-option' + (isActive ? ' active' : '');
          btn.innerHTML = `
            <span class="ov-left">
              <span class="ov-icon">${PROVIDERS[selectedProvider].icon}</span>
              <span class="ov-name">${m.label}</span>
            </span>
            <svg class="ov-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
          btn.addEventListener('click', () => {
            selectedModel = m;
            chrome.storage.local.set({ selectedModelId: m.id });
            animate(modelBtnInner);
            renderModelBtn();
            hideOverlay();
          });
          overlayList.appendChild(btn);
        });
      }
    }

    overlay.classList.add('visible');
  }

  function hideOverlay() {
    overlay.classList.remove('visible');
    providerSelector.classList.remove('open');
    modelSelector.classList.remove('open');
  }

  overlayClose.addEventListener('click', hideOverlay);
  providerBtn.addEventListener('click', () => showOverlay('provider'));
  modelBtn.addEventListener('click',    () => showOverlay('model'));
  settingsBtn.addEventListener('click', () => showOverlay('menu'));
  setupBtn.addEventListener('click',    () => showOverlay('keys'));
  newChatBtn.addEventListener('click',  () => clearActiveChat());

  const modeBtn = document.getElementById('modeBtn');

  function paintMode() {
    const open = agentMode === 'unrestricted';
    modeBtn.classList.toggle('unrestricted', open);
    modeBtn.textContent = open ? 'Unrestricted' : 'Restricted';
    modeBtn.title = open
      ? 'Page actions run without asking. External tools still ask. Click to restrict.'
      : 'Consequential page actions ask first. Click to allow them without asking.';
    modeBtn.setAttribute('aria-pressed', String(open));
    paintIntroFoot();   // the intro explains this pill; it must not describe the old state
  }

  modeBtn.addEventListener('click', () => {
    agentMode = agentMode === 'unrestricted' ? 'restricted' : 'unrestricted';
    paintMode();
  });
  paintMode();

  // ── Context fetching ───────────────────────────────────────────────────────

  // The page's visible prose. Read live, when the tool runs — goto and act move the page
  // mid-turn, so anything captured earlier is about wherever the agent used to be.
  function getPageText(tab, cb, fail) {
    if (!tab || tab.id == null) { fail('Cannot access this page (try a regular http/https page).'); return; }

    // Inject on demand so it works on tabs that were already open before the extension
    // loaded — declared content scripts only reach pages opened after.
    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        func: () => (document.body?.innerText || '').replace(/[\n\t]+/g, ' ').trim(),
      },
      (results) => {
        if (chrome.runtime.lastError || !results || !results[0]) {
          fail('Cannot access this page (try a regular http/https page).');
          return;
        }
        cb(results[0].result || '');
      }
    );
  }

  // Returns content.js's snapshot response ({ snapshot, generation, ... }) or null if the
  // page can't provide one. Best-effort by design: a missing snapshot must degrade to
  // text-only chat, never fail the request.
  // `opts.waitForStable` asks content.js to let the page finish drawing before it measures.
  // Only worth it where the page is known to be new — see snapshotAfterLoad. read_page and
  // the turn-start snapshot pass nothing and stay immediate.
  function getPageSnapshot(tab, cb, opts = {}) {
    if (!tab || tab.id == null) { cb(null); return; }

    const request = (mayInject) => {
      // Wrapped because a snapshot is a nice-to-have: sendMessage can throw synchronously
      // on a tab that died mid-request, and that must not take the whole turn down with it.
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'SW_SNAPSHOT', ...opts }, (res) => {
          if (chrome.runtime.lastError) {
            // No receiver. content.js is declared for <all_urls>, but declared scripts
            // only reach pages loaded *after* the extension did, so older tabs need an
            // explicit inject before they can answer.
            if (!mayInject) { cb(null); return; }
            chrome.scripting.executeScript(
              { target: { tabId: tab.id }, files: ['content.js'] },
              () => {
                if (chrome.runtime.lastError) { cb(null); return; }
                request(false);
              }
            );
            return;
          }
            cb(res && res.ok ? res : null);
        });
      } catch {
        cb(null);
      }
    };

    request(true);
  }

  // ── Page actions (client-side tools) ───────────────────────────────────────
  // read_page and act execute here, not on the server: the server has no DOM. Over the
  // socket the agent asks for them mid-run and waits for the answer.

  // Mirrors content.js describe(): "15 button Delete account", with optional " = value",
  // " [flags]" and " options: ..." suffixes. Unquoted names mean the name is whatever is
  // left after those suffixes are stripped — see the same logic in server.py.
  const SNAP_LINE     = /^(\d+)\s+(\S+)(?:\s+(.*))?$/;
  const SNAP_SUFFIXES = [/\s+options:\s.*$/, /\s+\[[^\]]*\]$/, /\s+=\s.*$/];

  function snapName(rest) {
    return SNAP_SUFFIXES.reduce((acc, re) => acc.replace(re, ''), rest || '').trim();
  }

  // The panel needs the element names to judge whether an action is consequential, and the
  // snapshot text is the only place it has them.
  function parseSnapshot(text) {
    const map = new Map();
    for (const line of String(text || '').split('\n')) {
      const m = SNAP_LINE.exec(line);
      if (m) map.set(Number(m[1]), { role: m[2], name: snapName(m[3]) });
    }
    return map;
  }

  // content.js rejects actions chosen from an older snapshot, which is what stops a click
  // landing on a re-rendered element. Tracking it here means the model never has to.
  function recordSnapshot(view, res) {
    if (!res) return '';
    if (view) {
      if (Number.isInteger(res.generation)) view.pageGeneration = res.generation;
      view.pageElements = parseSnapshot(res.snapshot);
    }
    return res.snapshot || '';
  }

  // Consequential actions used to be refused here. They are now gated properly by
  // HumanInTheLoopMiddleware on the server, which pauses the graph and asks — see the
  // `hitl` frame handling. Keeping a second gate here would double-ask, and the refusal
  // would always win.

  // Flattened into prose because the model reads this as a tool result.
  function formatActResult(res) {
    if (!res) return 'The page did not respond. It may have navigated away.';

    // A refusal used to return here with the reason and nothing else, which cost the agent
    // a whole read_page before it could try anything — the map it needed was one field away
    // the entire time. Anything the page sent back gets rendered below.
    if (res.error && !res.snapshot) return res.error;

    const lines = res.error
      ? [res.error]
      : (res.results || []).map((r) => `${r.ok ? 'ok' : 'FAILED'}: ${r.detail}`);
    if (res.remaining) {
      lines.push(`Stopped after action ${res.stopped_after + 1} because it changes the page; ` +
                 `${res.remaining} later action(s) were not run. Continue from the snapshot below.`);
    }
    // The effect, ahead of the map. A click that opened a dialog and a click that did
    // nothing used to produce identical text, so the model had to infer from the snapshot
    // whether its action worked — and when the snapshot was the thing that was wrong, it
    // concluded the click had failed and retried.
    if (res.drift)   lines.push(`note: ${res.drift}`);
    if (res.changed) lines.push(`→ ${res.changed}`);

    // An act result appends the map as a convenience, so when the map is byte-identical to
    // the one the model already has, saying so costs a line instead of ~1,000 tokens. Only
    // safe here: content.js decides `unchanged` by comparing the real serialization, and an
    // explicit read_page is never answered this way, since re-reading is how the agent
    // recovers a map that has been dropped from its context.
    // The recovery hint matters: context editing can clear the earlier map, so "unchanged"
    // must never be the only thing standing between the agent and a map it no longer holds.
    const tail = res.unchanged
      ? 'The element map is unchanged, so the ids you already have are still valid. ' +
        'If you no longer have that map, call read_page.'
      : (res.snapshot || '');

    return (lines.join('\n') || 'Nothing to do.') + '\n\n' + tail;
  }

  function sendToPage(tab, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tab.id, message, (res) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(res || null);
        });
      } catch { resolve(null); }
    });
  }

  // Resolves when the tab finishes loading, or on timeout. Event-driven rather than
  // polling, and scoped to this panel's window like the other tab listeners.
  function waitForTabLoad(tabId, ms = 15000) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch { /* no-op */ }
        resolve(ok);
      };
      const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
      const timer = setTimeout(() => done(false), ms);
      try {
        chrome.tabs.onUpdated.addListener(onUpdated);
      } catch {
        done(false);
        return;
      }
      // It may already be complete — check once, so a load that finished in the gap
      // between the action and the listener attaching is not waited on forever.
      Promise.resolve()
        .then(() => chrome.tabs.get(tabId))
        .then((t) => { if (t && t.status === 'complete') done(true); })
        .catch(() => { /* the listener and the timeout still cover it */ });
    });
  }

  // The page went away mid-action. Report what we can prove and hand back the new map.
  // Waits for a tab to settle, then hands back its element map. Shared by the two ways a
  // page can change under the agent: a click that navigated, and an explicit goto.
  async function snapshotAfterLoad(tabId, view, headline) {
    await waitForTabLoad(tabId);

    let tab = { id: tabId };
    try {
      const fresh = await chrome.tabs.get(tabId);
      if (fresh) tab = fresh;
    } catch { /* the tab went away; the snapshot attempt below will fail cleanly */ }

    // waitForTabLoad above only proves the document and its subresources arrived. On a
    // JS-rendered site that is well before the controls exist, so the map taken here would
    // describe an empty shell — the same partial-map problem the in-page click path has,
    // one layer down. waitForStable asks the page whether it has stopped growing.
    const res = await new Promise((resolve) =>
      getPageSnapshot(tab, resolve, { waitForStable: true }));
    const snapshot = recordSnapshot(view, res);
    const where = tab.url ? headline.replace('%url%', tab.url) : headline.replace(' %url%', '');

    return snapshot
      ? `${where}\n\n${snapshot}`
      : `${where} The page could not be read yet — call read_page to try again.`;
  }

  // Only ever send the agent somewhere a link could have taken the user. javascript:,
  // file: and chrome: are all reachable from chrome.tabs and none of them should be.
  function safeUrl(raw) {
    let parsed;
    try { parsed = new URL(String(raw || '').trim()); } catch { return null; }
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null;
  }

  async function runClientTool(tabId, view, name, args) {
    // Resolved per call rather than captured: after a goto the tab's url has changed, and
    // a stale tab object would carry the old one into the snapshot.
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return 'That tab is no longer open.';
    }
    if (!tab || tab.id == null) return 'No page is available to act on.';

    // `tab` was re-resolved from the pinned tabId just above, so this reads whatever page
    // the agent has navigated to, not the one the turn started on.
    if (name === 'read_text') {
      return await new Promise((resolve) =>
        getPageText(tab, (text) => resolve(text || ''), (msg) => resolve(msg)));
    }

    if (name === 'read_page') {
      const res = await new Promise((resolve) => getPageSnapshot(tab, resolve));
      return recordSnapshot(view, res) ||
        'No element map available for this page. It may be a browser-internal page.';
    }

    if (name === 'act') {
      const actions = Array.isArray(args.actions) ? args.actions : [];
      if (!actions.length) return 'No actions supplied.';

      const res = await sendToPage(tab, {
        type: 'SW_ACT',
        actions: fillSecrets(actions),
        generation: view?.pageGeneration,
      });

      // No reply usually means the click started a real page load: the document unloads,
      // content.js is destroyed, and the response never comes. Wait for the new page and
      // snapshot that, so the agent gets somewhere to continue instead of an error it has
      // to guess its way out of.
      if (!res) {
        return await snapshotAfterLoad(tab.id, view, 'The action ran and the page is now %url%.');
      }

      recordSnapshot(view, res);
      return formatActResult(res);
    }

    if (name === 'goto') {
      const url = safeUrl(args.url);
      if (!url) {
        return `"${args.url}" is not a web address I can open. Only http and https are allowed.`;
      }

      try {
        await chrome.tabs.update(tab.id, { url });
      } catch (err) {
        return `Could not navigate: ${err?.message || err}`;
      }
      return await snapshotAfterLoad(tab.id, view, 'The page is now %url%.');
    }

    return `Unknown page tool "${name}".`;
  }

  // ── Main handler ───────────────────────────────────────────────────────────

  async function handleQuery(tab, view, query, turn) {
    const key = savedApiKeys[selectedProvider];
    if (!key) { turn.fail('No API key for this provider. Open the ☰ menu → API Keys.'); return; }

    {
      // The snapshot is the element map for acting; it also seeds the generation that
      // content.js checks before it will touch anything.
      const snapRes  = await new Promise((resolve) => getPageSnapshot(tab, resolve));
      const snapshot = recordSnapshot(view, snapRes);

      const controller = new AbortController();
      view.controller  = controller;
      setStreaming(view, true);

      // A stopped turn stays in the transcript, labelled. Only the panel's own housekeeping
      // aborts delete it — those fire while the chat is being wiped, so re-adding a bubble
      // there would resurrect a conversation that was just cleared.
      const endAborted = () => {
        setStreaming(view, false);
        if (controller.signal.reason === 'user-stop') {
          view.messages.push({ role: 'assistant', ...turn.interrupt() });
          saveChat(view);
        } else {
          turn.discard();
        }
      };

      const payload = {
        query,
        snapshot:  snapshot || '',
        mode:      agentMode,
        model:     selectedModel?.id,
        // No conversation goes up. Each message is a self-contained job that finishes
        // inside its own turn, so previous turns are cost without purpose — see
        // _build_messages in the backend. The panel still shows and stores everything;
        // this only governs what the model is given.
        tool_keys: savedToolKeys,
      };

      let errored = false;
      const handlers = {
        onMeta:       () => {},
        onRoute:      (lane) => turn.onRoute(lane),
        onUsage:      (u)    => turn.onUsage(u),
        onTool:       (tool) => turn.onTool(tool),
        onToolResult: (res)  => turn.onToolResult(res),
        onText:       (t)    => turn.onText(t),
        onError:      (msg)  => { if (!controller.signal.aborted) { errored = true; turn.fail(msg); } },
        onClientTool: (name, args) => runClientTool(tab.id, view, name, args),
        onHitl:       (request)    => turn.askHuman(request),
      };

      // The socket first, because it is the only transport that can run page actions: it
      // lets the server call back mid-run. A backend or proxy without WebSocket support
      // falls back to POST, which still answers questions — it just cannot act.
      let done = false;
      if (wsWorthTrying()) {
        try {
          await runWsQuery(
            { ...payload, token: key, provider: selectedProvider },
            handlers,
            controller.signal,
          );
          done = true;
        } catch (err) {
          if (err?.name === 'AbortError') { endAborted(); return; }
          if (!(err instanceof TransportUnavailable)) {
            setStreaming(view, false);
            turn.fail('Connection lost: ' + (err?.message || err));
            return;
          }
          markWsUnavailable();   // don't re-pay the connect timeout every question
        }
      }

      if (!done) {
        // Best-effort: a page that will not yield its text degrades to a knowledge answer,
        // which is why this resolves to '' instead of failing the turn.
        const pageText = await new Promise((resolve) =>
          getPageText(tab, (t) => resolve(t || ''), () => resolve('')));

        let response;
        try {
          response = await fetch(`${BACKEND}/chat`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Token': key, 'Provider': selectedProvider },
            signal:  controller.signal,
            body: JSON.stringify({ ...payload, text: pageText }),
          });
        } catch (err) {
          if (err.name === 'AbortError') { endAborted(); return; }
          setStreaming(view, false);
          turn.fail('Could not reach backend: ' + err.message);
          return;
        }

        if (!response.ok) {
          setStreaming(view, false);
          try { const d = await response.json(); turn.fail(d.detail || 'Backend error.'); }
          catch { turn.fail('Backend error ' + response.status); }
          return;
        }

        await readSSEStream(response, handlers);
      }

      if (errored) { setStreaming(view, false); return; }
      if (controller.signal.aborted) { endAborted(); return; }
      setStreaming(view, false);

      const rec = turn.finish();
      if (rec.content.trim() || rec.steps.length) {
        view.messages.push({ role: 'assistant', ...rec });
        saveChat(view);
      } else {
        turn.discard();
      }
    }
  }

  // ── Input handling ─────────────────────────────────────────────────────────

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
    refreshSendButton();   // must not clobber stop mode mid-stream
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!askBtn.disabled) askBtn.click(); }
  });

  // ── Send button ────────────────────────────────────────────────────────────

  askBtn.addEventListener('click', async () => {
    if (askBtn.classList.contains('stop-mode')) {
      // The reason is what tells handleQuery this was a deliberate stop and not the panel
      // tidying up after a navigation or a closed tab.
      activeView()?.controller?.abort('user-stop');   // handleQuery clears streaming state
      return;
    }

    const query = input.value.trim();
    if (!query) return;
    if (!selectedProvider) { showError('No provider set. Open the ☰ menu → API Keys to add one.'); return; }

    input.value        = '';
    input.style.height = 'auto';
    askBtn.disabled    = true;
    hideOverlay();

    try {
      // Resolve the tab at send time — in a persistent panel the user may have
      // switched pages since the last question.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id == null) {
        showError('Cannot access this page (try a regular http/https page).');
        return;
      }
      shownTabId = tab.id;   // also cancels any in-flight showTab
      const view = chat;
      renderPageIndicator(tab);

      reveal();
      const userWrap = document.createElement('div');
      userWrap.className = 'chat-msg user';
      userWrap.innerHTML = `<div class="chat-bubble user-bubble">${escHtml(query)}</div>`;
      view.el.appendChild(userWrap);
      scrollToEnd(view.el);
      refreshNewChatBtn();
      view.messages.push({ role: 'user', content: query });
      saveChat(view);

      const turn = createAiTurn(view, selectedProvider, selectedModel?.label);
      handleQuery(tab, view, query, turn);
    } catch (err) {
      showError('Unexpected error: ' + err.message);
    }
  });
});
