const PROVIDERS = ['claude', 'gemini', 'openai'];
const TOOLS     = ['tavily', 'composio'];

// Load saved status — never pre-fill keys, just show "Saved" badge
chrome.storage.local.get(['apiKeys', 'toolKeys', 'apiProvider', 'apiKey'], (res) => {
  const apiKeys  = res.apiKeys  || {};
  const toolKeys = res.toolKeys || {};

  // Migrate legacy single-key storage into apiKeys
  if (res.apiProvider && res.apiKey && !apiKeys[res.apiProvider]) {
    apiKeys[res.apiProvider] = res.apiKey;
  }

  if (res.apiProvider) {
    chrome.storage.local.set({ apiKeys });
  }

  PROVIDERS.forEach(p => {
    if (apiKeys[p]) showBadge(p);
  });
  TOOLS.forEach(t => {
    if (toolKeys[t]) showBadge(t);
  });
});

// Eye toggle
document.querySelectorAll('.eye-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.for);
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.querySelector('.eye-open').style.display  = isPassword ? 'none'  : '';
    btn.querySelector('.eye-closed').style.display = isPassword ? ''     : 'none';
  });
});

// Save
document.getElementById('saveBtn').addEventListener('click', () => {
  const newKeys = {};
  PROVIDERS.forEach(p => {
    const val = document.getElementById(`key-${p}`).value.trim();
    if (val) newKeys[p] = val;
  });

  const newToolKeys = {};
  TOOLS.forEach(t => {
    const val = document.getElementById(`key-${t}`).value.trim();
    if (val) newToolKeys[t] = val;
  });

  if (Object.keys(newKeys).length === 0 && Object.keys(newToolKeys).length === 0) {
    setStatus('Enter at least one key to save.', true);
    return;
  }

  const btn = document.getElementById('saveBtn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  chrome.storage.local.get(['apiKeys', 'toolKeys'], (res) => {
    const mergedApi   = { ...(res.apiKeys  || {}), ...newKeys };
    const mergedTools = { ...(res.toolKeys || {}), ...newToolKeys };
    chrome.storage.local.set({ apiKeys: mergedApi, toolKeys: mergedTools }, () => {
      Object.keys(newKeys).forEach(p => showBadge(p));
      Object.keys(newToolKeys).forEach(t => showBadge(t));
      setStatus('Saved!', false);
      setTimeout(() => window.close(), 800);
    });
  });
});

function showBadge(provider) {
  const badge = document.getElementById(`badge-${provider}`);
  if (badge) badge.classList.add('visible');
}

function setStatus(msg, isError) {
  const el  = document.getElementById('statusMsg');
  const btn = document.getElementById('saveBtn');
  el.textContent = msg;
  el.className   = 'status-msg ' + (isError ? 'error' : 'success');
  if (isError) {
    btn.disabled    = false;
    btn.textContent = 'Save Keys';
  }
}
