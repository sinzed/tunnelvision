type IceServer = RTCIceServer;

type BgActiveTabStateResponse =
  | { ok: true; tabId: number; state: { url?: string; iceServers?: IceServer[]; updatedAt?: number; lastError?: string } }
  | { ok: false; reason: string };

type HandshakeBundle = {
  sdp: RTCSessionDescriptionInit;
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T | null;

function b64encodeUtf8(text: string) {
  return btoa(unescape(encodeURIComponent(text)));
}
function b64decodeUtf8(b64: string) {
  return decodeURIComponent(escape(atob(b64)));
}

function render() {
  document.body.style.margin = '0';
  document.body.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  document.body.style.width = '360px';

  const root = $('#app')!;
  root.innerHTML = `
    <div style="padding:12px 12px 10px;border-bottom:1px solid #e9e9ee;">
      <div style="font-weight:650;font-size:14px;">Bale Peer Link</div>
      <div id="status" style="margin-top:6px;font-size:12px;color:#555;line-height:1.35;"></div>
    </div>

    <div style="padding:12px;display:grid;gap:10px;">
      <div style="display:grid;gap:6px;">
        <div style="font-size:12px;font-weight:600;">1) Create offer (Peer A)</div>
        <button id="btnOffer" style="padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">Create offer</button>
        <textarea id="offerOut" placeholder="Offer appears here (copy and send to Peer B)" style="width:100%;height:90px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
      </div>

      <div style="display:grid;gap:6px;">
        <div style="font-size:12px;font-weight:600;">2) Create answer (Peer B)</div>
        <textarea id="offerIn" placeholder="Paste offer from Peer A" style="width:100%;height:70px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
        <button id="btnAnswer" style="padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">Create answer</button>
        <textarea id="answerOut" placeholder="Answer appears here (copy back to Peer A)" style="width:100%;height:90px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
      </div>

      <div style="display:grid;gap:6px;">
        <div style="font-size:12px;font-weight:600;">3) Apply answer (Peer A)</div>
        <textarea id="answerIn" placeholder="Paste answer from Peer B" style="width:100%;height:70px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
        <button id="btnApplyAnswer" style="padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">Apply answer</button>
      </div>

      <div style="display:grid;gap:6px;">
        <div style="font-size:12px;font-weight:600;">DataChannel</div>
        <div id="dcState" style="font-size:12px;color:#555;">Not connected</div>
        <textarea id="msgIn" placeholder="Type message…" style="width:100%;height:60px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
        <button id="btnSend" style="padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;" disabled>Send</button>
        <pre id="log" style="white-space:pre-wrap;margin:0;padding:10px;border:1px solid #eee;border-radius:8px;background:#fafafa;font-size:12px;max-height:160px;overflow:auto;"></pre>
      </div>
    </div>
  `;
}

function log(line: string) {
  const el = $('#log') as HTMLPreElement;
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

async function getActiveTabState(): Promise<BgActiveTabStateResponse> {
  return (await chrome.runtime.sendMessage({ type: 'BALE_BG_GET_ACTIVE_TAB_STATE' })) as BgActiveTabStateResponse;
}

function countCandidatesInSdp(sdp?: string | null) {
  if (!sdp) return 0;
  return (sdp.match(/^a=candidate:/gm) ?? []).length;
}

async function waitForIceGathering(pc: RTCPeerConnection, opts?: { timeoutMs?: number; minCandidates?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const minCandidates = opts?.minCandidates ?? 1;

  const already = countCandidatesInSdp(pc.localDescription?.sdp);
  if (pc.iceGatheringState === 'complete' || already >= minCandidates) return;

  return new Promise<void>(resolve => {
    let bestCount = already;
    const startedAt = Date.now();

    const maybeDone = () => {
      const nowCount = countCandidatesInSdp(pc.localDescription?.sdp);
      if (nowCount > bestCount) {
        bestCount = nowCount;
        log(`[ice] candidates so far: ${bestCount}`);
      }

      const elapsed = Date.now() - startedAt;
      if (pc.iceGatheringState === 'complete') {
        cleanup();
        log('[ice] gathering complete');
        resolve();
        return;
      }
      if (bestCount >= minCandidates) {
        cleanup();
        log(`[ice] got ${bestCount} candidate(s) (continuing without waiting for complete)`);
        resolve();
        return;
      }
      if (elapsed >= timeoutMs) {
        cleanup();
        log(`[ice] timed out after ${Math.round(timeoutMs / 1000)}s with ${bestCount} candidate(s)`);
        resolve();
      }
    };

    const onIceCandidate = () => maybeDone();
    const onGatheringChange = () => maybeDone();

    const to = setTimeout(() => maybeDone(), timeoutMs);
    const cleanup = () => {
      clearTimeout(to);
      pc.removeEventListener('icecandidate', onIceCandidate);
      pc.removeEventListener('icegatheringstatechange', onGatheringChange);
    };

    pc.addEventListener('icecandidate', onIceCandidate);
    pc.addEventListener('icegatheringstatechange', onGatheringChange);
    maybeDone();
  });
}

let pcA: RTCPeerConnection | null = null;
let dcA: RTCDataChannel | null = null;
let dcB: RTCDataChannel | null = null;

function setDcState(text: string) {
  const el = $('#dcState')!;
  el.textContent = text;
}

function setSendEnabled(enabled: boolean) {
  const btn = $('#btnSend') as HTMLButtonElement;
  btn.disabled = !enabled;
}

function attachDc(dc: RTCDataChannel, label: string) {
  dc.addEventListener('open', () => {
    setDcState(`Connected (${label})`);
    setSendEnabled(true);
    log(`[dc] open (${label})`);
  });
  dc.addEventListener('close', () => {
    setDcState('Closed');
    setSendEnabled(false);
    log(`[dc] close (${label})`);
  });
  dc.addEventListener('message', e => {
    log(`[peer] ${String(e.data)}`);
  });
  dc.addEventListener('error', () => {
    log(`[dc] error (${label})`);
  });
}

async function getIceServersOrThrow(): Promise<IceServer[]> {
  const r = await getActiveTabState();
  if (!r.ok) throw new Error(r.reason);
  const servers = r.state.iceServers ?? [];
  if (!servers.length) {
    throw new Error('No TURN/STUN servers captured yet. Open Bale chat and wait until it starts a call/WebRTC.');
  }
  return servers;
}

function decodeBundle(text: string): HandshakeBundle {
  const raw = b64decodeUtf8(text.trim());
  return JSON.parse(raw) as HandshakeBundle;
}
function encodeBundle(bundle: HandshakeBundle) {
  return b64encodeUtf8(JSON.stringify(bundle));
}

async function createOffer() {
  const iceServers = await getIceServersOrThrow();

  pcA?.close();
  pcA = new RTCPeerConnection({ iceServers });
  pcA.addEventListener('connectionstatechange', () => log(`[pcA] ${pcA?.connectionState}`));
  pcA.addEventListener('iceconnectionstatechange', () => log(`[pcA] ice=${pcA?.iceConnectionState}`));
  pcA.addEventListener('icecandidateerror', e => {
    log(`[pcA] icecandidateerror code=${e.errorCode} text=${e.errorText ?? ''}`);
  });

  dcA = pcA.createDataChannel('bale-link');
  attachDc(dcA, 'A');

  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  await waitForIceGathering(pcA);

  const bundle: HandshakeBundle = { sdp: pcA.localDescription! };
  ($('#offerOut') as HTMLTextAreaElement).value = encodeBundle(bundle);

  log(`[offer] created (candidates in SDP: ${countCandidatesInSdp(pcA.localDescription?.sdp)})`);
}

async function createAnswer() {
  const iceServers = await getIceServersOrThrow();
  const offerText = ($('#offerIn') as HTMLTextAreaElement).value;
  if (!offerText.trim()) throw new Error('Paste an offer first.');

  const offerBundle = decodeBundle(offerText);
  const pc = new RTCPeerConnection({ iceServers });
  pc.addEventListener('connectionstatechange', () => log(`[pcB] ${pc.connectionState}`));
  pc.addEventListener('iceconnectionstatechange', () => log(`[pcB] ice=${pc.iceConnectionState}`));
  pc.addEventListener('icecandidateerror', e => {
    log(`[pcB] icecandidateerror code=${e.errorCode} text=${e.errorText ?? ''}`);
  });

  pc.ondatachannel = e => {
    dcB = e.channel;
    attachDc(dcB, 'B');
  };

  await pc.setRemoteDescription(offerBundle.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc);

  const answerBundle: HandshakeBundle = { sdp: pc.localDescription! };
  ($('#answerOut') as HTMLTextAreaElement).value = encodeBundle(answerBundle);

  log(`[answer] created (candidates in SDP: ${countCandidatesInSdp(pc.localDescription?.sdp)})`);
}

async function applyAnswer() {
  if (!pcA) throw new Error('Create an offer first.');
  const answerText = ($('#answerIn') as HTMLTextAreaElement).value;
  if (!answerText.trim()) throw new Error('Paste an answer first.');

  const answerBundle = decodeBundle(answerText);
  await pcA.setRemoteDescription(answerBundle.sdp);
  log('[answer] applied');
}

async function main() {
  render();
  setDcState('Not connected');

  const status = $('#status')!;
  try {
    const r = await getActiveTabState();
    if (!r.ok) {
      status.textContent = `Active tab: unavailable (${r.reason})`;
    } else {
      const age = r.state.updatedAt ? `${Math.round((Date.now() - r.state.updatedAt) / 1000)}s ago` : 'never';
      const count = r.state.iceServers?.length ?? 0;
      status.textContent = `Active tab: ${r.state.url ?? '(unknown)'}\nCaptured iceServers: ${count} (updated: ${age})${
        r.state.lastError ? `\nLast hook error: ${r.state.lastError}` : ''
      }`;
    }
  } catch (e) {
    status.textContent = `Status error: ${e instanceof Error ? e.message : String(e)}`;
  }

  ($('#btnOffer') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      await createOffer();
    } catch (e) {
      log(`[error] ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  ($('#btnAnswer') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      await createAnswer();
    } catch (e) {
      log(`[error] ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  ($('#btnApplyAnswer') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      await applyAnswer();
    } catch (e) {
      log(`[error] ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  ($('#btnSend') as HTMLButtonElement).addEventListener('click', () => {
    const msg = ($('#msgIn') as HTMLTextAreaElement).value;
    const dc = dcA?.readyState === 'open' ? dcA : dcB?.readyState === 'open' ? dcB : null;
    if (!dc) {
      log('[send] DataChannel not open');
      return;
    }
    dc.send(msg);
    log(`[me] ${msg}`);
  });
}

main().catch(e => {
  render();
  log(`[fatal] ${e instanceof Error ? e.message : String(e)}`);
});

