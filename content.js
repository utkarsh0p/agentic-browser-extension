chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_DATA') {
    const rawText     = document.body.innerText;
    const cleanedText = rawText.replace(/[\n\t]+/g, ' ').trim();
    sendResponse({ text: cleanedText || '' });
  }
  return true;
});
