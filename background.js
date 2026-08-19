// Toolbar icon toggles the side panel. Set at top level, not only in
// onInstalled, so it re-applies every time the service worker wakes.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// Nothing opens on install — the panel gates itself and prompts for keys the
// first time the user opens it (see updateSetupGate in popup/popup.js).

// Chats are keyed by tab id, so a closed tab's conversation is dead weight.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { chats = {} } = await chrome.storage.local.get('chats');
  if (chats[tabId] === undefined) return;
  delete chats[tabId];
  chrome.storage.local.set({ chats });
});
