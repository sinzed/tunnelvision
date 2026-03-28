import { loadPeerLinkUi, mergePeerLinkUi, peerLinkUiKey, type PeerLinkStoredUi } from '../lib/peer-link-ui-storage';

type TabCaptureState = {
  url?: string;
  iceServers?: RTCIceServer[];
  /** Full list from the page hook before URL-scheme filtering (for debugging). */
  iceServersRaw?: RTCIceServer[];
  updatedAt?: number;
  lastError?: string;
};

const iceKey = (tabId: number) => `peerLink_ice_${tabId}`;

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

const tabState = new Map<number, TabCaptureState>();
const portsByTab = new Map<number, Set<chrome.runtime.Port>>();

async function ensureOffscreenDoc(): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WEB_RTC],
      justification:
        'Keeps the WebRTC offer-side PeerConnection alive when the extension popup closes (e.g. while copying blobs to a peer).',
    });
  } catch (e: unknown) {
    const s = e instanceof Error ? e.message : String(e);
    if (s.includes('Only a single offscreen') || s.includes('already exists')) return;
    throw e;
  }
}

async function offererOffscreenRpc(msg: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreenDoc();
  return chrome.runtime.sendMessage({ type: 'BALE_OFFSCREEN_OFFERER', ...msg });
}

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

function appendLog(tabId: number, line: string) {
  void (async () => {
    const cur = await loadPeerLinkUi(tabId);
    const logs = [...(cur.logs ?? []), line].slice(-120);
    await mergePeerLinkUi(tabId, { logs });
    for (const p of portsByTab.get(tabId) ?? []) {
      try {
        p.postMessage({ type: 'log', line });
      } catch {
        // port closed
      }
    }
  })();
}

function broadcastUi(tabId: number, patch: Partial<PeerLinkStoredUi>) {
  void mergePeerLinkUi(tabId, patch).then(() => {
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
  void loadPeerLinkUi(tabId).then(ui => {
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
  void chrome.runtime
    .sendMessage({ type: 'BALE_OFFSCREEN_OFFERER', tabId, op: 'reset' })
    .catch(() => void 0);
  tabState.delete(tabId);
  void chrome.storage.local.remove([iceKey(tabId), peerLinkUiKey(tabId)]);
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
    if (typeof tabId === 'number') void mergePeerLinkUi(tabId, msg.patch ?? {});
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
        const ui = await loadPeerLinkUi(tabId);
        sendResponse({ ok: true, tabId, state, ui });
      })
      .catch((err: unknown) => sendResponse({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (msg?.type === 'BALE_OFFERER_EVENT') {
    const tabId = msg.tabId as number;
    if (typeof tabId !== 'number') return false;
    if (msg.kind === 'log' && typeof msg.line === 'string') appendLog(tabId, msg.line);
    if (msg.kind === 'dc_message' && typeof msg.text === 'string') {
      appendLog(tabId, `[peer] ${msg.text}`);
      for (const p of portsByTab.get(tabId) ?? []) {
        try {
          p.postMessage({ type: 'offerer_dc', text: msg.text });
        } catch {
          /* port closed */
        }
      }
    }
    if (msg.kind === 'dc_open') {
      appendLog(tabId, '[dc] open (A)');
      for (const p of portsByTab.get(tabId) ?? []) {
        try {
          p.postMessage({ type: 'offerer_dc_state', open: true });
        } catch {
          /* ignore */
        }
      }
    }
    if (msg.kind === 'dc_close') {
      appendLog(tabId, '[dc] close (A)');
      for (const p of portsByTab.get(tabId) ?? []) {
        try {
          p.postMessage({ type: 'offerer_dc_state', open: false });
        } catch {
          /* ignore */
        }
      }
    }
    return false;
  }

  if (msg?.type === 'BALE_OFFERER_RPC') {
    const { type: _t, ...rest } = msg as { type?: string } & Record<string, unknown>;
    void offererOffscreenRpc(rest)
      .then(r => sendResponse(r))
      .catch((err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true;
  }

  return false;
});
