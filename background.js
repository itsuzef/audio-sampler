chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getStreamId') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ error: 'No active tab found' });
        return;
      }
      const tabId = tabs[0].id;
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ streamId, tabTitle: tabs[0].title || '' });
      });
    });
    return true;
  }
});
