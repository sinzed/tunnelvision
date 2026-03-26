type TabCaptureState = {
  url?: string;
  iceServers?: RTCIceServer[];
  updatedAt?: number;
  lastError?: string;
};

const tabState = new Map<number, TabCaptureState>();

function setTabState(tabId: number, patch: TabCaptureState) {
  const prev = tabState.get(tabId) ?? {};
  tabState.set(tabId, { ...prev, ...patch });
}

chrome.tabs.onRemoved.addListener(tabId => {
  tabState.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) => {
  if (msg?.type === 'BALE_ICE_SERVERS') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      setTabState(tabId, { iceServers: msg.iceServers, url: msg.url, updatedAt: Date.now(), lastError: undefined });
    }
    return;
  }

  if (msg?.type === 'BALE_RTCPC_ERROR') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      setTabState(tabId, { lastError: String(msg.message ?? ''), url: msg.url, updatedAt: Date.now() });
    }
    return;
  }

  if (msg?.type === 'BALE_BG_GET_ACTIVE_TAB_STATE') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs: chrome.tabs.Tab[]) => {
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, reason: 'No active tab' });
          return;
        }
        sendResponse({ ok: true, tabId, state: tabState.get(tabId) ?? {} });
      })
      .catch((err: unknown) => sendResponse({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
    return true;
  }
});
