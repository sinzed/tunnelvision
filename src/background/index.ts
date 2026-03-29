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

const tabState = new Map<number, TabCaptureState>();
const portsByTab = new Map<number, Set<chrome.runtime.Port>>();

const OFFSCREEN_DOC_PATH = 'src/offscreen/peer-link-host.html';

let offscreenPort: chrome.runtime.Port | null = null;
let offscreenPortWaiters: Array<() => void> = [];

const pendingOffscreenRpc = new Map<string, (msg: Record<string, unknown>) => void>();

function resolveOffscreenPortWaiters() {
  const w = offscreenPortWaiters;
  offscreenPortWaiters = [];
  for (const fn of w) fn();
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'peer-link-offscreen') return;
  offscreenPort = port;
  resolveOffscreenPortWaiters();
  port.onMessage.addListener((msg: { _replyId?: string } & Record<string, unknown>) => {
    const rid = msg._replyId;
    if (typeof rid === 'string' && pendingOffscreenRpc.has(rid)) {
      pendingOffscreenRpc.get(rid)!(msg);
    }
  });
  port.onDisconnect.addListener(() => {
    offscreenPort = null;
    for (const res of pendingOffscreenRpc.values()) {
      res({ ok: false, error: 'Offscreen host disconnected.' });
    }
    pendingOffscreenRpc.clear();
  });
});

function waitForOffscreenPort(timeoutMs: number): Promise<void> {
  if (offscreenPort) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done: () => void;
    const t = setTimeout(() => {
      const i = offscreenPortWaiters.indexOf(done);
      if (i >= 0) offscreenPortWaiters.splice(i, 1);
      reject(new Error('Timed out waiting for offscreen WebRTC host.'));
    }, timeoutMs);
    done = () => {
      clearTimeout(t);
      const i = offscreenPortWaiters.indexOf(done);
      if (i >= 0) offscreenPortWaiters.splice(i, 1);
      resolve();
    };
    offscreenPortWaiters.push(done);
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_DOC_PATH);
  let hasDoc = false;
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [url],
    });
    hasDoc = existing.length > 0;
  } catch {
    hasDoc = false;
  }
  if (!hasDoc) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOC_PATH,
        reasons: [chrome.offscreen.Reason.WEB_RTC],
        justification:
          'Keeps the WebRTC offerer PeerConnection alive while the extension popup is closed so answers still match.',
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Only a single offscreen|already exists|duplicate/i.test(msg)) throw e;
    }
  }
  await waitForOffscreenPort(30_000);
}

async function sendOffscreenRpc(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureOffscreenDocument();
  if (!offscreenPort) throw new Error('Offscreen host not connected.');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pendingOffscreenRpc.delete(id);
      reject(new Error('Offscreen request timed out.'));
    }, 120_000);
    pendingOffscreenRpc.set(id, msg => {
      clearTimeout(t);
      pendingOffscreenRpc.delete(id);
      resolve(msg);
    });
    offscreenPort!.postMessage({ ...payload, _replyId: id });
  });
}

function postOffscreenCloseTab(tabId: number) {
  try {
    offscreenPort?.postMessage({ type: 'PL_HOST_CLOSE', tabId });
  } catch {
    /* ignore */
  }
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
  tabState.delete(tabId);
  postOffscreenCloseTab(tabId);
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

  if (msg?.type === 'PL_HOST_LOG') {
    const tabId = msg.tabId as number;
    if (typeof tabId === 'number') appendLog(tabId, String(msg.line ?? ''));
    return;
  }

  if (msg?.type === 'PL_HOST_DC_MSG') {
    const tabId = msg.tabId as number;
    if (typeof tabId === 'number') {
      appendLog(tabId, `[peer] ${String(msg.text ?? '')}`);
      for (const p of portsByTab.get(tabId) ?? []) {
        try {
          p.postMessage({ type: 'dcMsg', text: msg.text });
        } catch {
          // ignore
        }
      }
    }
    return;
  }

  if (msg?.type === 'PL_HOST_DC_STATE') {
    const tabId = msg.tabId as number;
    if (typeof tabId === 'number') {
      for (const p of portsByTab.get(tabId) ?? []) {
        try {
          p.postMessage({
            type: 'dcState',
            state: msg.state,
            label: msg.label,
          });
        } catch {
          // ignore
        }
      }
    }
    return;
  }

  if (msg?.type === 'PL_OFFERER_CREATE') {
    const tabId = msg.tabId as number;
    if (typeof tabId !== 'number') return;
    void (async () => {
      try {
        const r = await sendOffscreenRpc({
          type: 'PL_HOST_CREATE_OFFER',
          tabId,
          iceServers: msg.iceServers,
        });
        sendResponse(r);
      } catch (e: unknown) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'PL_OFFERER_APPLY_ANSWER') {
    const tabId = msg.tabId as number;
    if (typeof tabId !== 'number') return;
    void (async () => {
      try {
        const r = await sendOffscreenRpc({
          type: 'PL_HOST_APPLY_ANSWER',
          tabId,
          answerText: String(msg.answerText ?? ''),
        });
        sendResponse(r);
      } catch (e: unknown) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'PL_OFFERER_DC_SEND') {
    const tabId = msg.tabId as number;
    if (typeof tabId !== 'number') return;
    void (async () => {
      try {
        const r = await sendOffscreenRpc({
          type: 'PL_HOST_DC_SEND',
          tabId,
          text: String(msg.text ?? ''),
        });
        sendResponse(r);
      } catch (e: unknown) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'PL_OFFERER_CLOSE') {
    const tabId = msg.tabId as number;
    if (typeof tabId === 'number') postOffscreenCloseTab(tabId);
    sendResponse({ ok: true });
    return true;
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

  return false;
});
