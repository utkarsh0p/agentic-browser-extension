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

const USER_AVATAR_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
  <circle cx="12" cy="8" r="4"/>
  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
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

const CLAUDE_ICON = `<svg fill="#c96442" fill-rule="evenodd" width="13" height="13" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/></svg>`;

// ── Provider & model metadata ──────────────────────────────────────────────────

const PROVIDERS = {
  claude: { label: 'Claude', sub: 'Anthropic', icon: CLAUDE_ICON, accent: '#c96442' },
  gemini: { label: 'Gemini', sub: 'Google',    icon: GEMINI_ICON, accent: '#1c69ff' },
  openai: { label: 'GPT',    sub: 'OpenAI',    icon: OPENAI_ICON, accent: '#10a37f' },
};

// ── Small pure helpers (reasoning trace + card chrome) ──────────────────────────

function formatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

// Whisper-voice labels for the reasoning rail
const TOOL_DISPLAY = {
  search_page:                        'Searching the page',
  summarize_page:                     'Reading the page',
  web_search:                         'Searching the web',
  COMPOSIO_SEARCH_TOOLS:              'Finding tools',
  COMPOSIO_CHECK_ACTIVE_CONNECTIONS:  'Checking connections',
  COMPOSIO_INITIATE_CONNECTION:       'Connecting',
  COMPOSIO_EXECUTE_ACTION:            'Taking action',
  COMPOSIO_MANAGE_CONNECTIONS:        'Managing connections',
  COMPOSIO_MULTI_EXECUTE_TOOL:        'Running tools',
};

function toolLabel(name) {
  if (TOOL_DISPLAY[name]) return TOOL_DISPLAY[name];
  return (name || 'Working')
    .replace(/^COMPOSIO_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, c => c.toUpperCase());
}

// Pull a human-readable input (usually the query) from a tool's args
function argPreview(args) {
  if (!args || typeof args !== 'object') return '';
  const v = args.query ?? args.q ?? args.input ?? args.text
    ?? Object.values(args).find(x => typeof x === 'string');
  if (typeof v !== 'string' || !v.trim()) return '';
  return v.length > 64 ? v.slice(0, 64) + '…' : v;
}

// Tool outputs are often raw JSON — never dump that into the trace.
function cleanResult(s) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^[[{]/.test(s)) return '';                             // JSON blob
  if (((s.match(/[{}[\]"]/g) || []).length) > 4) return '';   // looks structured
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

const PROVIDER_ORDER = ['claude', 'gemini', 'openai'];

const MODELS = {
  openai: [
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { id: 'gpt-4.1',      label: 'GPT-4.1'      },
    { id: 'o4-mini',      label: 'o4-mini'       },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro'   },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  ],
  claude: [
    { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5'  },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6'   },
  ],
};

// ── Shared SSE stream reader ───────────────────────────────────────────────────

async function readSSEStream(response, { onText, onMeta, onError, onTool, onToolResult }) {
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
          const parsed = JSON.parse(raw);
          if (parsed.error)       { onError?.(parsed.error); return; }
          if (parsed.status)      { onMeta?.(parsed); continue; }
          if (parsed.tool)        { onTool?.(parsed.tool); continue; }
          if (parsed.tool_result) { onToolResult?.(parsed.tool_result); continue; }
          if (parsed.text)        onText?.(parsed.text);
        } catch { /* skip malformed line */ }
      }
    }
  } catch (err) {
    onError?.(err.message);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const askBtn       = document.getElementById('ask');
  const input        = document.getElementById('query');
  const settingsBtn  = document.getElementById('settingsBtn');
  const responseArea = document.getElementById('responseArea');

  // Active-page indicator in the header
  const pageIndicator = document.getElementById('pageIndicator');
  const pageFavicon   = document.getElementById('pageFavicon');
  const pageHost      = document.getElementById('pageHost');

  // Overlay elements
  const overlay      = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayList  = document.getElementById('overlayList');
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

  // ── Per-tab conversations ───────────────────────────────────────────────────
  // The panel outlives every tab it shows, so each tab owns a View whose `el` is
  // a DETACHED .chat-history element. Switching tabs swaps which element is
  // attached to #responseArea; a stream in flight keeps appending to its own
  // detached node, so switching away mid-answer and back resumes it intact —
  // no partial-state serialization, no aborted requests.
  const views     = new Map();   // tabId -> { el, messages, url, controller, streaming, seq }
  const MAX_VIEWS = 15;          // bound the DOM we keep alive; LRU beyond this
  let storedChats  = {};         // in-memory mirror of chrome.storage.local.chats
  let activeTabId  = null;
  let seqCounter   = 0;

  const STOP_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
  const SEND_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;

  // Send button reflects the ACTIVE view only — a background tab's stream must
  // not put the visible button into stop mode.
  function refreshSendButton() {
    const streaming = !!activeView()?.streaming;
    askBtn.innerHTML = streaming ? STOP_ICON : SEND_ICON;
    askBtn.classList.toggle('stop-mode', streaming);
    askBtn.disabled  = streaming ? false : !input.value.trim();
  }

  function setStreaming(view, on) {
    view.streaming = on;
    if (!on) view.controller = null;
    refreshSendButton();
  }

  // ── View plumbing ───────────────────────────────────────────────────────────

  function activeView() { return activeTabId == null ? null : views.get(activeTabId); }

  function isActive(view) { return view === activeView(); }

  function makeHistoryEl() {
    const el = document.createElement('div');
    el.className = 'chat-history visible';
    return el;
  }

  function scrollToEnd(el) { el.scrollTop = el.scrollHeight; }

  // Reveal the chat area — only when the view the caller wrote to is on screen.
  function reveal(view) {
    if (isActive(view)) responseArea.classList.add('visible');
  }

  // Swap which view's element is attached to #responseArea.
  function attach(view) {
    if (responseArea.firstElementChild !== view.el) {
      responseArea.replaceChildren(view.el);
    }
    responseArea.classList.toggle('visible', view.el.childElementCount > 0);
    // Detached elements have scrollHeight 0, so a background view's autoscroll
    // was a no-op; catch it up now that the element has a layout box.
    scrollToEnd(view.el);
    refreshSendButton();
  }

  // Strip the fragment: in-page #anchor navigation must not wipe a conversation.
  function pageKey(url) {
    if (!url) return '';
    const hash = url.indexOf('#');
    return hash === -1 ? url : url.slice(0, hash);
  }

  function newView(tabId, url) {
    return { tabId, el: makeHistoryEl(), messages: [], url: url || '', controller: null, streaming: false, seq: ++seqCounter };
  }

  // Get (or build) the view for a tab, resetting it if the page changed.
  function ensureView(tab) {
    const existing = views.get(tab.id);
    if (existing) {
      existing.seq = ++seqCounter;
      if (tab.url && pageKey(existing.url) !== pageKey(tab.url)) resetView(existing, tab.url);
      return existing;
    }

    const view = newView(tab.id, tab.url);
    // Only adopt a stored conversation if it belongs to the page now in the tab.
    // Tab ids are reused across browser restarts, so the id alone proves nothing.
    const stored = storedChats[tab.id];
    if (stored && Array.isArray(stored.messages) && stored.messages.length
        && tab.url && pageKey(stored.url) === pageKey(tab.url)) {
      view.messages = stored.messages;
      renderMessages(view);
    }
    views.set(tab.id, view);
    evictStaleViews();
    return view;
  }

  // Drop the least-recently-viewed idle views. Messages are already in storage,
  // so this only releases DOM — the view rebuilds from storage if revisited.
  function evictStaleViews() {
    if (views.size <= MAX_VIEWS) return;
    const candidates = [...views.entries()]
      .filter(([id, v]) => id !== activeTabId && !v.streaming)
      .sort((a, b) => a[1].seq - b[1].seq);
    for (const [id] of candidates) {
      if (views.size <= MAX_VIEWS) break;
      views.delete(id);
    }
  }

  function resetView(view, url) {
    view.controller?.abort();   // the answer was about the page we just left
    setStreaming(view, false);
    view.messages = [];
    view.url      = url || '';
    view.el.replaceChildren();
    delete storedChats[view.tabId];
    chrome.storage.local.set({ chats: storedChats });
    if (isActive(view)) responseArea.classList.remove('visible');
  }

  // ── Chat persistence ────────────────────────────────────────────────────

  function saveChat(view) {
    if (view.tabId == null) return;
    storedChats[view.tabId] = { url: view.url, messages: view.messages };
    chrome.storage.local.set({ chats: storedChats });
  }

  function renderMessages(view) {
    for (const msg of view.messages) {
      if (msg.role === 'user') {
        const wrap = document.createElement('div');
        wrap.className = 'chat-msg user';
        wrap.innerHTML = `<div class="chat-bubble user-bubble">${escHtml(msg.content)}</div><div class="chat-avatar user-av">${USER_AVATAR_SVG}</div>`;
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
          rail.appendChild(railToolEl(s.name, s.argPreview, { done: true, summary: s.summary || '' }));
          toolCount++;
        } else if (s.kind === 'reason' && s.text) {
          rail.appendChild(railReasonEl(s.text));
        }
      }
      turnEl.appendChild(rail);
      foldRail(turnEl, rail, toolCount || steps.length, msg.durationMs);
    }

    const { card, body } = makeCard(msg.provider, msg.model);
    body.innerHTML = renderMarkdown(msg.content || '');
    turnEl.appendChild(card);
    addCardFooter(card, msg.ts, msg.content || '');
    wrap.appendChild(turnEl);
    return wrap;
  }

  function clearActiveChat() {
    const view = activeView();
    if (view) resetView(view, view.url);
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

  // Build `storedChats`: migrate the pre-side-panel flat keys, then drop entries
  // whose tab is gone. Tab ids are recycled across restarts, so this prunes the
  // obvious dead ones; ensureView() still URL-checks before adopting a chat.
  async function loadChats(activeTab) {
    const res   = await chrome.storage.local.get(['chats', 'chatMessages', 'chatPageUrl']);
    const chats = { ...(res.chats || {}) };

    const legacy = Array.isArray(res.chatMessages) ? res.chatMessages : null;
    if (legacy?.length && activeTab?.url && res.chatPageUrl
        && pageKey(res.chatPageUrl) === pageKey(activeTab.url)) {
      chats[activeTab.id] = { url: activeTab.url, messages: legacy };
    }
    if (res.chatMessages !== undefined || res.chatPageUrl !== undefined) {
      chrome.storage.local.remove(['chatMessages', 'chatPageUrl']);
    }

    const live = new Set((await chrome.tabs.query({})).map(t => String(t.id)));
    storedChats = {};
    for (const [id, entry] of Object.entries(chats)) {
      if (live.has(id)) storedChats[id] = entry;
    }
    chrome.storage.local.set({ chats: storedChats });
  }

  // ── Active-page indicator ──────────────────────────────────────────────────

  pageFavicon.addEventListener('error', () => pageFavicon.removeAttribute('src'));

  function renderPageIndicator(tab) {
    let host = '';
    try { host = new URL(tab?.url || '').hostname.replace(/^www\./, ''); }
    catch { /* chrome://, about:, a local file — nothing worth showing */ }

    if (!host) { pageIndicator.classList.remove('visible'); return; }
    pageHost.textContent = host;
    pageHost.title       = tab.url;
    if (tab.favIconUrl) pageFavicon.src = tab.favIconUrl;
    else pageFavicon.removeAttribute('src');
    pageIndicator.classList.add('visible');
  }

  // ── Tab tracking — the panel persists, so it has to follow the browser ─────

  let panelWindowId = -1;   // chrome.windows.WINDOW_ID_NONE
  let pendingTabId  = null;

  async function showTab(tabId) {
    pendingTabId = tabId;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    // Fast switching can resolve these out of order — only the newest wins.
    if (!tab || pendingTabId !== tabId) return;
    activeTabId = tab.id;
    attach(ensureView(tab));
    renderPageIndicator(tab);
  }

  // onActivated/onUpdated fire for every window; this panel owns exactly one.
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (windowId !== panelWindowId) return;
    showTab(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.windowId !== panelWindowId) return;
    if (changeInfo.url) {
      const view = views.get(tabId);
      if (view && pageKey(view.url) !== pageKey(changeInfo.url)) resetView(view, changeInfo.url);
      else if (view) view.url = changeInfo.url;   // same page, new fragment
    }
    // Favicon and title land after the URL, so refresh the header on those too.
    if (tabId === activeTabId && (changeInfo.url || changeInfo.favIconUrl || changeInfo.title)) {
      renderPageIndicator(tab);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    views.get(tabId)?.controller?.abort();
    views.delete(tabId);
    delete storedChats[tabId];   // background.js clears the persisted copy
  });

  (async () => {
    await loadSettings();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) panelWindowId = tab.windowId;
    await loadChats(tab);
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

  function addCardFooter(card, ts, rawText) {
    const footer = document.createElement('div');
    footer.className = 'ai-card-footer';
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

  function railToolEl(name, argp, { done = false } = {}) {
    const el = document.createElement('div');
    el.className = 'rail-step tool' + (done ? ' done' : ' active');
    el.innerHTML =
      `<span class="rail-dot">${done ? TICK_ICON : ''}</span>` +
      `<span class="rail-body">` +
        `<span class="rail-tool-label">${escHtml(toolLabel(name))}</span>` +
        (argp ? `<span class="rail-arg">${escHtml(argp)}</span>` : '') +
      `</span>`;
    return el;
  }

  // Collapse a finished rail into a "Whispered through N steps · Ns" chip
  function foldRail(turnEl, railEl, stepCount, durationMs) {
    const secs = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'trace-chip';
    const label = `Whispered through ${stepCount} step${stepCount === 1 ? '' : 's'}${secs ? ` · ${secs}s` : ''}`;
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
    reveal(view);

    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ai';
    const turnEl = document.createElement('div');
    turnEl.className = 'ai-turn';
    if (provider && PROVIDERS[provider]) turnEl.style.setProperty('--accent', PROVIDERS[provider].accent);

    const rail = document.createElement('div');
    rail.className = 'whisper-rail';
    const waiting = document.createElement('div');
    waiting.className = 'rail-step reason active waiting';
    waiting.innerHTML = `<span class="rail-dot"></span><span class="rail-body"><span class="whispering-label">Whispering</span>${TYPING_SVG}</span>`;
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
    let answer    = '';         // provisional final-answer markdown
    let toolCount = 0;

    const dropWaiting = () => { waiting.remove(); };
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
      onText(delta) {
        dropWaiting();
        answer += delta;
        card.style.display = '';
        body.innerHTML = renderMarkdown(answer);
        scrollToEnd(view.el);
      },
      onTool(tool) {
        dropWaiting();
        flushAnswerAsReason();
        // Accept both the new object form {name,args,id} and the legacy string form
        const isObj = tool && typeof tool === 'object';
        const name  = isObj ? tool.name : tool;
        const argp  = argPreview(isObj ? tool.args : null);
        const item  = { kind: 'tool', name, argPreview: argp, summary: '' };
        steps.push(item);
        const el = railToolEl(name, argp);
        rail.appendChild(el);
        if (isObj && tool.id != null) toolEls[tool.id] = { el, item };
        toolCount++;
        scrollToEnd(view.el);
      },
      onToolResult(res) {
        const ref = res && res.id != null ? toolEls[res.id] : null;
        const short = cleanResult(res && res.summary);
        if (ref) {
          ref.item.summary = short;
          ref.el.classList.remove('active');
          ref.el.classList.add('done');
          ref.el.querySelector('.rail-dot').innerHTML = TICK_ICON;
          if (short) ref.el.querySelector('.rail-result').textContent = short;
        }
        scrollToEnd(view.el);
      },
      // Finalize: fold the rail, stamp footer, return the record to persist
      finish() {
        dropWaiting();
        // Resolve any tool still shown as running (e.g. a backend that never sent tool_result)
        rail.querySelectorAll('.rail-step.tool.active').forEach(el => {
          el.classList.remove('active');
          el.classList.add('done');
          el.querySelector('.rail-dot').innerHTML = TICK_ICON;
        });
        const durationMs = Date.now() - startTs;
        const ts = Date.now();
        if (toolCount > 0 || steps.length > 0) {
          foldRail(turnEl, rail, toolCount || steps.length, durationMs);
        } else {
          rail.remove();
        }
        card.style.display = '';
        if (!answer.trim()) body.innerHTML = `<p class="ai-empty">Done.</p>`;
        addCardFooter(card, ts, answer);
        scrollToEnd(view.el);
        return { content: answer, provider, model, ts, durationMs, steps };
      },
      fail(text) {
        dropWaiting();
        rail.remove();
        card.style.display = '';
        body.className = 'ai-card-body error';
        body.textContent = text;
        scrollToEnd(view.el);
      },
      discard() { wrap.remove(); },
      hasAnswer() { return !!answer.trim(); },
      hasSteps()  { return steps.length > 0; },
    };
  }

  // Standalone error bubble (used before a turn exists, e.g. missing key)
  function showError(text, view = activeView()) {
    if (!view) { console.error('SiteWhisper:', text); return; }   // no tab bound yet
    reveal(view);
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ai';
    wrap.innerHTML = `<div class="ai-turn"><div class="ai-card"><div class="ai-card-body error">${escHtml(text)}</div></div></div>`;
    view.el.appendChild(wrap);
    scrollToEnd(view.el);
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

  // ── Overlay ────────────────────────────────────────────────────────────────

  function showOverlay(mode, prevMode = null) {
    overlayList.innerHTML = '';
    overlayBack.style.display = prevMode ? 'flex' : 'none';
    overlayBack.onclick = prevMode ? () => showOverlay(prevMode) : null;

    if (mode === 'menu') {
      overlayTitle.textContent = 'Menu';

      const items = [
        {
          icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>`,
          label: 'Providers', sub: 'Manage your API keys',
          action: () => { hideOverlay(); chrome.runtime.openOptionsPage(); },
        },
        {
          icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>`,
          label: 'Clear Chat', sub: 'Start a new conversation',
          action: () => { clearActiveChat(); hideOverlay(); },
        },
      ];

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
          } else {
            chrome.runtime.openOptionsPage();
          }
          hideOverlay();
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

  // ── Context fetching ───────────────────────────────────────────────────────

  function getPageText(tab, cb, fail) {
    if (!tab || tab.id == null) { fail('Cannot access this page (try a regular http/https page).'); return; }

    // Inject on-demand so it works on tabs that were already open before the
    // extension loaded (declared content scripts only reach pages opened after).
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

  // ── Main handler ───────────────────────────────────────────────────────────

  async function handleQuery(tab, view, query, turn) {
    const key = savedApiKeys[selectedProvider];
    if (!key) { turn.fail('No API key for this provider. Open Settings (⚙).'); return; }

    getPageText(tab, async (text) => {
      const controller = new AbortController();
      view.controller  = controller;
      setStreaming(view, true);

      let response;
      try {
        const payload = {
            query,
            text:       text || '',
            model:      selectedModel?.id,
            history:    view.messages.slice(0, -1),
            tool_keys:  savedToolKeys,
          };
          if (selectedProvider === 'claude' && savedApiKeys.gemini)
            payload.gemini_key = savedApiKeys.gemini;

          response = await fetch(`${BACKEND}/chat`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Token': key, 'Provider': selectedProvider },
          signal:  controller.signal,
          body: JSON.stringify(payload),
        });
      } catch (err) {
        setStreaming(view, false);
        if (err.name === 'AbortError') { turn.discard(); return; }
        turn.fail('Could not reach backend: ' + err.message);
        return;
      }

      if (!response.ok) {
        setStreaming(view, false);
        try { const d = await response.json(); turn.fail(d.detail || 'Backend error.'); }
        catch { turn.fail('Backend error ' + response.status); }
        return;
      }

      let errored = false;

      await readSSEStream(response, {
        onMeta:       () => {},
        onTool:       (tool) => turn.onTool(tool),
        onToolResult: (res)  => turn.onToolResult(res),
        onText:       (t)    => turn.onText(t),
        onError:      (msg)  => { if (!controller.signal.aborted) { errored = true; turn.fail(msg); } },
      });

      const aborted = controller.signal.aborted;
      setStreaming(view, false);
      if (errored) return;

      if (aborted && !turn.hasAnswer()) { turn.discard(); return; }

      const rec = turn.finish();
      if (rec.content.trim() || rec.steps.length) {
        view.messages.push({ role: 'assistant', ...rec });
        saveChat(view);
      } else {
        turn.discard();
      }
    }, (m) => { setStreaming(view, false); turn.fail(m); });
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
      activeView()?.controller?.abort();   // handleQuery clears streaming state
      return;
    }

    const query = input.value.trim();
    if (!query) return;
    if (!selectedProvider) { showError('No provider set. Open Settings (⚙) to add an API key.'); return; }

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
      activeTabId = pendingTabId = tab.id;   // also cancels any in-flight showTab
      const view  = ensureView(tab);
      if (tab.url) view.url = tab.url;
      attach(view);

      reveal(view);
      const userWrap = document.createElement('div');
      userWrap.className = 'chat-msg user';
      userWrap.innerHTML = `<div class="chat-bubble user-bubble">${escHtml(query)}</div><div class="chat-avatar user-av">${USER_AVATAR_SVG}</div>`;
      view.el.appendChild(userWrap);
      scrollToEnd(view.el);
      view.messages.push({ role: 'user', content: query });
      saveChat(view);

      const turn = createAiTurn(view, selectedProvider, selectedModel?.label);
      handleQuery(tab, view, query, turn);
    } catch (err) {
      showError('Unexpected error: ' + err.message);
    }
  });
});
