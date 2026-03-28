import { countCandidatesInSdp, waitForIceGathering } from '../lib/ice-gather';

type TabCaptureState = {
  url?: string;
  iceServers?: RTCIceServer[];
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

type HandshakeBundle = { sdp: RTCSessionDescriptionInit };

const iceKey = (tabId: number) => `peerLink_ice_${tabId}`;
const uiKey = (tabId: number) => `peerLink_ui_${tabId}`;

const tabState = new Map<number, TabCaptureState>();
const portsByTab = new Map<number, Set<chrome.runtime.Port>>();

type PeerSession = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  role: 'offerer' | 'answerer';
};

const peerByTab = new Map<number, PeerSession>();

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
  let set = portsByTab.get(tabId);
  if (!set) {
    set = new Set();
    portsByTab.set(tabId, set);
  }
  set.add(port);
  port.onDisconnect.addListener(() => {
    set!.delete(port);
    if (set!.size === 0) portsByTab.delete(tabId);
  });
  void loadStoredUi(tabId).then(ui => {
    try {
      port.postMessage({ type: 'init', ui, tabId });
    } catch {
      // ignore
    }
  });
}

function closePeer(tabId: number) {
  const s = peerByTab.get(tabId);
  if (!s) return;
  try {
    s.dc?.close();
  } catch {
    // ignore
  }
  try {
    s.pc.close();
  } catch {
    // ignore
  }
  peerByTab.delete(tabId);
}

function b64encodeUtf8(text: string) {
  return btoa(unescape(encodeURIComponent(text)));
}
function b64decodeUtf8(b64: string) {
  return decodeURIComponent(escape(atob(b64)));
}

function decodeBundle(text: string): HandshakeBundle {
  const raw = b64decodeUtf8(text.trim());
  return JSON.parse(raw) as HandshakeBundle;
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
  closePeer(tabId);
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
      .then(async (tabs: chrome.tabs.Tab[]) => {
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, reason: 'No active tab' });
          return;
        }
        const state = await mergeStateForTab(tabId);
        const ui = await loadStoredUi(tabId);
        const peer = peerByTab.get(tabId);
        sendResponse({
          ok: true,
          tabId,
          state,
          ui,
          peer: peer
            ? {
                role: peer.role,
                connectionState: peer.pc.connectionState,
                iceConnectionState: peer.pc.iceConnectionState,
                dcState: peer.dc?.readyState ?? null,
              }
            : null,
        });
      })
      .catch((err: unknown) => sendResponse({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (msg?.type === 'BALE_UI_SAVE') {
    const tabId = msg.tabId as number;
    if (typeof tabId !== 'number') return;
    void patchStoredUi(tabId, msg.patch ?? {});
    return;
  }

  if (msg?.type === 'BALE_PC_CREATE_OFFER') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs: chrome.tabs.Tab[]) => {
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, error: 'No active tab' });
          return;
        }
        const merged = await mergeStateForTab(tabId);
        const iceServers = merged.iceServers ?? [];
        if (!iceServers.length) {
          sendResponse({ ok: false, error: 'No TURN/STUN servers captured yet.' });
          return;
        }

        closePeer(tabId);
        appendLog(tabId, '[offer] creating…');

        const pc = new RTCPeerConnection({ iceServers });
        const log = (line: string) => appendLog(tabId, line);
        pc.addEventListener('connectionstatechange', () => log(`[pc] ${pc.connectionState}`));
        pc.addEventListener('iceconnectionstatechange', () => log(`[pc] ice=${pc.iceConnectionState}`));
        pc.addEventListener('icecandidateerror', e => {
          log(`[pc] icecandidateerror code=${e.errorCode} text=${e.errorText ?? ''}`);
        });

        const dc = pc.createDataChannel('bale-link');
        dc.addEventListener('open', () => {
          appendLog(tabId, '[dc] open (offerer)');
        });
        dc.addEventListener('close', () => appendLog(tabId, '[dc] close (offerer)'));
        dc.addEventListener('message', e => appendLog(tabId, `[peer] ${String(e.data)}`));

        peerByTab.set(tabId, { pc, dc, role: 'offerer' });

        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await waitForIceGathering(pc, log);
          const bundle: HandshakeBundle = { sdp: pc.localDescription! };
          const offerB64 = b64encodeUtf8(JSON.stringify(bundle));
          await patchStoredUi(tabId, { offerOut: offerB64 });
          broadcastUi(tabId, { offerOut: offerB64 });
          appendLog(tabId, `[offer] done (candidates in SDP: ${countCandidatesInSdp(pc.localDescription?.sdp)})`);
          sendResponse({ ok: true, offerOut: offerB64 });
        } catch (e) {
          closePeer(tabId);
          const err = e instanceof Error ? e.message : String(e);
          appendLog(tabId, `[error] ${err}`);
          sendResponse({ ok: false, error: err });
        }
      })
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  if (msg?.type === 'BALE_PC_CREATE_ANSWER') {
    const offerIn = String(msg.offerIn ?? '').trim();
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs: chrome.tabs.Tab[]) => {
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, error: 'No active tab' });
          return;
        }
        if (!offerIn) {
          sendResponse({ ok: false, error: 'Paste an offer first.' });
          return;
        }
        const merged = await mergeStateForTab(tabId);
        const iceServers = merged.iceServers ?? [];
        if (!iceServers.length) {
          sendResponse({ ok: false, error: 'No TURN/STUN servers captured yet.' });
          return;
        }

        closePeer(tabId);
        appendLog(tabId, '[answer] creating…');

        const offerBundle = decodeBundle(offerIn);
        const pc = new RTCPeerConnection({ iceServers });
        const log = (line: string) => appendLog(tabId, line);
        pc.addEventListener('connectionstatechange', () => log(`[pc] ${pc.connectionState}`));
        pc.addEventListener('iceconnectionstatechange', () => log(`[pc] ice=${pc.iceConnectionState}`));
        pc.addEventListener('icecandidateerror', e => {
          log(`[pc] icecandidateerror code=${e.errorCode} text=${e.errorText ?? ''}`);
        });

        let dc: RTCDataChannel | null = null;
        pc.ondatachannel = e => {
          dc = e.channel;
          peerByTab.set(tabId, { pc, dc, role: 'answerer' });
          dc.addEventListener('open', () => {
            appendLog(tabId, '[dc] open (answerer)');
          });
          dc.addEventListener('close', () => appendLog(tabId, '[dc] close (answerer)'));
          dc.addEventListener('message', ev => appendLog(tabId, `[peer] ${String(ev.data)}`));
        };

        peerByTab.set(tabId, { pc, dc: null, role: 'answerer' });

        try {
          await pc.setRemoteDescription(offerBundle.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await waitForIceGathering(pc, log);
          const bundle: HandshakeBundle = { sdp: pc.localDescription! };
          const answerB64 = b64encodeUtf8(JSON.stringify(bundle));
          await patchStoredUi(tabId, { offerIn, answerOut: answerB64 });
          broadcastUi(tabId, { offerIn, answerOut: answerB64 });
          appendLog(tabId, `[answer] done (candidates in SDP: ${countCandidatesInSdp(pc.localDescription?.sdp)})`);
          sendResponse({ ok: true, answerOut: answerB64 });
        } catch (e) {
          closePeer(tabId);
          const err = e instanceof Error ? e.message : String(e);
          appendLog(tabId, `[error] ${err}`);
          sendResponse({ ok: false, error: err });
        }
      })
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  if (msg?.type === 'BALE_PC_APPLY_ANSWER') {
    const answerIn = String(msg.answerIn ?? '').trim();
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs: chrome.tabs.Tab[]) => {
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, error: 'No active tab' });
          return;
        }
        if (!answerIn) {
          sendResponse({ ok: false, error: 'Paste an answer first.' });
          return;
        }
        const sess = peerByTab.get(tabId);
        if (!sess || sess.role !== 'offerer') {
          sendResponse({ ok: false, error: 'Create an offer first (same tab).' });
          return;
        }
        try {
          const answerBundle = decodeBundle(answerIn);
          await sess.pc.setRemoteDescription(answerBundle.sdp);
          await patchStoredUi(tabId, { answerIn });
          broadcastUi(tabId, { answerIn });
          appendLog(tabId, '[answer] applied');
          sendResponse({ ok: true });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          appendLog(tabId, `[error] ${err}`);
          sendResponse({ ok: false, error: err });
        }
      })
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  if (msg?.type === 'BALE_PC_SEND') {
    const text = String(msg.text ?? '');
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs: chrome.tabs.Tab[]) => {
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, error: 'No active tab' });
          return;
        }
        const sess = peerByTab.get(tabId);
        const dc = sess?.dc;
        if (!dc || dc.readyState !== 'open') {
          sendResponse({ ok: false, error: 'DataChannel not open' });
          return;
        }
        try {
          dc.send(text);
          appendLog(tabId, `[me] ${text}`);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  if (msg?.type === 'BALE_PC_RESET') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs: chrome.tabs.Tab[]) => {
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false });
          return;
        }
        closePeer(tabId);
        appendLog(tabId, '[peer] session reset');
        sendResponse({ ok: true });
      });
    return true;
  }
});
