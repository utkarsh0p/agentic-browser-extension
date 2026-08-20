// Toolbar icon toggles the side panel. Set at top level, not only in
// onInstalled, so it re-applies every time the service worker wakes.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// Nothing opens on install — the panel gates itself and prompts for keys the
// first time the user opens it (see updateSetupGate in popup/popup.js).

// One conversation per side panel, and a side panel is one document per window — so a
// closed window's chat is dead weight. Tabs no longer matter: the chat outlives them.
chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.local.remove(`panelChat:${windowId}`);
});
