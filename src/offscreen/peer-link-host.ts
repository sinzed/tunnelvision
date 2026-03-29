import {
  countCandidatesInSdp,
  countRelayCandidatesInSdp,
  waitForIceGathering,
} from '../lib/ice-gather';
import {
  decodeBundle,
  encodeBundle,
  type HandshakeBundle,
} from '../lib/handshake-bundle';

type Session = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
};

const sessions = new Map<number, Session>();

function offererStillNeedsAnswer(pc: RTCPeerConnection): boolean {
  if (pc.remoteDescription) return false;
  if (pc.signalingState === 'have-local-offer') return true;
  return pc.localDescription?.type === 'offer';
}

function closeSession(tabId: number) {
  logChains.delete(tabId);
  const s = sessions.get(tabId);
  if (!s) return;
  try {
    s.dc?.close();
  } catch {
    /* ignore */
  }
  try {
    s.pc.close();
  } catch {
    /* ignore */
  }
  sessions.delete(tabId);
}

function forwardDcState(tabId: number, state: string, label: string) {
  chrome.runtime.sendMessage({
    type: 'PL_HOST_DC_STATE',
    tabId,
    state,
    label,
  });
}

/** Serialize logs so order matches real-time (parallel sendMessage can reorder lines in the UI). */
const logChains = new Map<number, Promise<void>>();

function forwardLog(tabId: number, line: string): void {
  const prev = logChains.get(tabId) ?? Promise.resolve();
  const next = prev.then(() =>
    chrome.runtime.sendMessage({ type: 'PL_HOST_LOG', tabId, line }).then(() => void 0),
  );
  logChains.set(tabId, next.catch(() => void 0));
}

function attachDc(tabId: number, dc: RTCDataChannel, label: string) {
  dc.addEventListener('open', () => {
    forwardDcState(tabId, 'open', label);
    forwardLog(tabId, `[dc] open (${label})`);
  });
  dc.addEventListener('close', () => {
    forwardDcState(tabId, 'closed', label);
    forwardLog(tabId, `[dc] close (${label})`);
  });
  dc.addEventListener('message', e => {
    const s = String(e.data);
    void chrome.runtime.sendMessage({ type: 'PL_HOST_DC_MSG', tabId, text: s });
  });
  dc.addEventListener('error', () => {
    forwardLog(tabId, `[dc] error (${label})`);
  });
}

async function handleCreateOffer(tabId: number, iceServers: RTCIceServer[]) {
  if (!iceServers.length) {
    return { ok: false as const, error: 'No ICE servers.' };
  }
  closeSession(tabId);
  forwardLog(tabId, '[offer] creating… (offscreen host)');

  const pc = new RTCPeerConnection({ iceServers });
  const log = (line: string) => forwardLog(tabId, line);
  pc.addEventListener('connectionstatechange', () => log(`[pcA] conn=${pc.connectionState}`));
  pc.addEventListener('iceconnectionstatechange', () => {
    log(`[pcA] ice=${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      log(
        '[pcA] ICE failed — check both blobs were copied after “gathering complete”, both sides have STUN/TURN, and try TURN from an active call on the capture tab.',
      );
    }
  });
  pc.addEventListener('signalingstatechange', () => log(`[pcA] signaling=${pc.signalingState}`));
  pc.addEventListener('icecandidateerror', e => {
    log(`[pcA] icecandidateerror code=${e.errorCode} text=${e.errorText ?? ''}`);
  });

  const dc = pc.createDataChannel('bale-link');
  attachDc(tabId, dc, 'A');

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, log, { waitUntilComplete: true });
  } catch (e) {
    try {
      dc.close();
    } catch {
      /* ignore */
    }
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    throw e;
  }

  const bundle: HandshakeBundle = { sdp: pc.localDescription! };
  const offerB64 = encodeBundle(bundle);
  sessions.set(tabId, { pc, dc });

  const sdpA = pc.localDescription?.sdp;
  forwardLog(
    tabId,
    `[offer] done (candidates: ${countCandidatesInSdp(sdpA)}, relay: ${countRelayCandidatesInSdp(sdpA)})`,
  );

  return { ok: true as const, offerB64 };
}

async function handleApplyAnswer(tabId: number, answerText: string) {
  const s = sessions.get(tabId);
  if (!s) {
    return {
      ok: false as const,
      error:
        'No offer session in the background host. Click “Create offer” again (keep the popup open is optional now).',
    };
  }
  if (!offererStillNeedsAnswer(s.pc)) {
    return { ok: false as const, error: 'Answer was already applied. Use “Clear local peers” for a new offer.' };
  }

  const answerBundle = decodeBundle(answerText);
  await s.pc.setRemoteDescription(answerBundle.sdp);
  forwardLog(
    tabId,
    `[answer] applied (signaling=${s.pc.signalingState}, ice=${s.pc.iceConnectionState}, conn=${s.pc.connectionState})`,
  );
  return { ok: true as const };
}

function handleDcSend(tabId: number, text: string) {
  const s = sessions.get(tabId);
  const dc = s?.dc;
  if (!dc || dc.readyState !== 'open') {
    return { ok: false as const, error: 'DataChannel not open' };
  }
  dc.send(text);
  return { ok: true as const };
}

type HostRequest =
  | { type: 'PL_HOST_CREATE_OFFER'; tabId: number; iceServers: RTCIceServer[] }
  | { type: 'PL_HOST_APPLY_ANSWER'; tabId: number; answerText: string }
  | { type: 'PL_HOST_DC_SEND'; tabId: number; text: string }
  | { type: 'PL_HOST_CLOSE'; tabId: number };

async function handleMessage(msg: HostRequest): Promise<Record<string, unknown>> {
  switch (msg.type) {
    case 'PL_HOST_CREATE_OFFER':
      return handleCreateOffer(msg.tabId, msg.iceServers);
    case 'PL_HOST_APPLY_ANSWER':
      return handleApplyAnswer(msg.tabId, msg.answerText);
    case 'PL_HOST_DC_SEND':
      return handleDcSend(msg.tabId, msg.text);
    case 'PL_HOST_CLOSE':
      closeSession(msg.tabId);
      forwardDcState(msg.tabId, 'closed', 'A');
      return { ok: true as const };
    default:
      return { ok: false as const, error: `Unknown host message: ${(msg as { type: string }).type}` };
  }
}

const port = chrome.runtime.connect({ name: 'peer-link-offscreen' });

port.onMessage.addListener((msg: { _replyId?: string } & Partial<HostRequest>) => {
  if (!msg.type?.startsWith('PL_HOST_')) return;

  if (!msg._replyId) {
    if (msg.type === 'PL_HOST_CLOSE' && typeof msg.tabId === 'number') {
      closeSession(msg.tabId);
      forwardDcState(msg.tabId, 'closed', 'A');
    }
    return;
  }

  const rid = msg._replyId;
  const { _replyId: _r, ...rest } = msg;
  void (async () => {
    try {
      const result = await handleMessage(rest as HostRequest);
      port.postMessage({ _replyId: rid, ...result });
    } catch (e) {
      port.postMessage({
        _replyId: rid,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
});
