type TabCaptureState = {
  url?: string;
  iceServers?: RTCIceServer[];
  /** Full list from the page hook before URL-scheme filtering (for debugging). */
  iceServersRaw?: RTCIceServer[];
  updatedAt?: number;
  lastError?: string;
};

type StoredUi = {
  offerOut?: string;
  offerIn?: string;
  answerOut?: string;
  answerIn?: string;
  logs?: string[];
};

const iceKey = (tabId: number) => `peerLink_ice_${tabId}`;
const uiKey = (tabId: number) => `peerLink_ui_${tabId}`;

const tabState = new Map<number, TabCaptureState>();
const portsByTab = new Map<number, Set<chrome.runtime.Port>>();

function setTabState(tabId: number, patch: TabCaptureState) {
  const prev = tabState.get(tabId) ?? {};
  const next = { ...prev, ...patch };
  tabState.set(tabId, next);
  void chrome.storage.local.set({ [iceKey(tabId)]: next });
}

async function loadStoredIce(tabId: number): Promise<TabCaptureState | null> {
  const r = await chrome.storage.local.get(iceKey(tabId));
  const v = r[iceKey(tabId)] as TabCaptureState | undefined;
  return v && typeof v === 'object' ? v : null;
}

async function loadStoredUi(tabId: number): Promise<StoredUi> {
  const r = await chrome.storage.local.get(uiKey(tabId));
  const v = r[uiKey(tabId)] as StoredUi | undefined;
  return v && typeof v === 'object' ? v : {};
}

async function patchStoredUi(tabId: number, patch: Partial<StoredUi>) {
  const cur = await loadStoredUi(tabId);
  const next: StoredUi = { ...cur, ...patch };
  if (next.logs && next.logs.length > 120) next.logs = next.logs.slice(-120);
  await chrome.storage.local.set({ [uiKey(tabId)]: next });
  return next;
}

function appendLog(tabId: number, line: string) {
  void (async () => {
    const cur = await loadStoredUi(tabId);
    const logs = [...(cur.logs ?? []), line].slice(-120);
    await patchStoredUi(tabId, { logs });
    for (const p of portsByTab.get(tabId) ?? []) {
      try {
        p.postMessage({ type: 'log', line });
      } catch {
        // port closed
      }
    }
  })();
}

function broadcastUi(tabId: number, patch: Partial<StoredUi>) {
  void patchStoredUi(tabId, patch).then(() => {
    for (const p of portsByTab.get(tabId) ?? []) {
      try {
        p.postMessage({ type: 'ui', patch });
      } catch {
        // ignore
      }
    }
  });
}

function subscribePort(tabId: number, port: chrome.runtime.Port) {
  let bucket = portsByTab.get(tabId);
  if (!bucket) {
    bucket = new Set();
    portsByTab.set(tabId, bucket);
  }
  bucket.add(port);
  port.onDisconnect.addListener(() => {
    bucket!.delete(port);
    if (bucket!.size === 0) portsByTab.delete(tabId);
  });
  void loadStoredUi(tabId).then(ui => {
    try {
      port.postMessage({ type: 'init', ui, tabId });
    } catch {
      // ignore
    }
  });
}

async function mergeStateForTab(tabId: number): Promise<TabCaptureState> {
  const mem = tabState.get(tabId) ?? {};
  const stored = await loadStoredIce(tabId);
  if (!stored) return { ...mem };
  const memTs = mem.updatedAt ?? 0;
  const stTs = stored.updatedAt ?? 0;
  if (stTs > memTs) return { ...stored, ...mem };
  return { ...stored, ...mem };
}

chrome.tabs.onRemoved.addListener(tabId => {
  tabState.delete(tabId);
  void chrome.storage.local.remove([iceKey(tabId), uiKey(tabId)]);
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'peer-link') return;
  port.onMessage.addListener((msg: { type?: string; tabId?: number }) => {
    if (msg?.type === 'subscribe' && typeof msg.tabId === 'number') {
      subscribePort(msg.tabId, port);
    }
  });
});

chrome.runtime.onMessage.addListener((msg: any, sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void) => {
  if (msg?.type === 'BALE_ICE_SERVERS') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      setTabState(tabId, {
        iceServers: msg.iceServers,
        iceServersRaw: Array.isArray(msg.iceServersRaw) ? msg.iceServersRaw : msg.iceServers,
        url: msg.url,
        updatedAt: Date.now(),
        lastError: undefined,
      });
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

  if (msg?.type === 'BALE_ICE_SERVERS_SYNC') {
    const tabId = msg.tabId as number;
    if (typeof tabId === 'number') {
      setTabState(tabId, {
        iceServers: msg.iceServers,
        iceServersRaw: Array.isArray(msg.iceServersRaw) ? msg.iceServersRaw : msg.iceServers,
        url: String(msg.url ?? ''),
        updatedAt: Date.now(),
        lastError: undefined,
      });
    }
    return;
  }

  if (msg?.type === 'BALE_APPEND_LOG') {
    const tabId = msg.tabId as number;
    if (typeof tabId === 'number') appendLog(tabId, String(msg.line ?? ''));
    return;
  }

  if (msg?.type === 'BALE_UI_SAVE') {
    const tabId = msg.tabId as number;
    if (typeof tabId === 'number') void patchStoredUi(tabId, msg.patch ?? {});
    return;
  }

  if (msg?.type === 'BALE_UI_PATCH') {
    const tabId = msg.tabId as number;
    if (typeof tabId === 'number') broadcastUi(tabId, msg.patch ?? {});
    return;
  }

  if (msg?.type === 'BALE_BG_GET_ACTIVE_TAB_STATE') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs: chrome.tabs.Tab[]) => {
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, reason: 'No active tab' });
          return;
        }
        const state = await mergeStateForTab(tabId);
        const ui = await loadStoredUi(tabId);
        sendResponse({ ok: true, tabId, state, ui });
      })
      .catch((err: unknown) => sendResponse({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  return false;
});
