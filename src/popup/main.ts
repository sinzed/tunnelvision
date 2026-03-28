import { countCandidatesInSdp, waitForIceGathering } from '../lib/ice-gather';
import { mergePeerLinkUi } from '../lib/peer-link-ui-storage';

type BgStateResponse =
  | {
      ok: true;
      tabId: number;
      state: {
        url?: string;
        iceServers?: RTCIceServer[];
        iceServersRaw?: RTCIceServer[];
        updatedAt?: number;
        lastError?: string;
      };
      ui: { offerOut?: string; offerIn?: string; answerOut?: string; answerIn?: string; logs?: string[] };
    }
  | { ok: false; reason: string };

type HandshakeBundle = { sdp: RTCSessionDescriptionInit };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T | null;

let activeTabId: number | null = null;

function render() {
  document.body.style.margin = '0';
  document.body.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  document.body.style.width = '420px';

  const root = $('#app')!;
  root.innerHTML = `
    <div style="padding:12px 12px 10px;border-bottom:1px solid #e9e9ee;">
      <div style="font-weight:650;font-size:14px;">Peer Link</div>
      <div id="status" style="margin-top:6px;font-size:12px;color:#555;line-height:1.35;"></div>
    </div>

    <div style="padding:12px;display:grid;gap:10px;">
      <div style="display:grid;gap:6px;">
        <div style="font-size:12px;font-weight:600;">Captured ICE (STUN / TURN)</div>
        <div style="font-size:11px;color:#666;">Full JSON from the page hook. Credentials are sensitive—do not share.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="btnRefreshIce" type="button" style="padding:6px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">Refresh from tab</button>
        </div>
        <pre id="iceSummary" style="margin:0;padding:8px;border:1px solid #eee;border-radius:8px;background:#f7f7fa;font-size:11px;max-height:100px;overflow:auto;white-space:pre-wrap;"></pre>
        <pre id="iceJson" style="margin:0;padding:8px;border:1px solid #ddd;border-radius:8px;background:#fafafa;font-size:10px;line-height:1.35;max-height:180px;overflow:auto;"></pre>
      </div>

      <div style="font-size:11px;color:#666;">WebRTC runs in this popup while connected. Offer/answer blobs are saved to storage when the popup closes so you can paste Peer B’s answer after reopening.</div>

      <div style="display:grid;gap:6px;">
        <div style="font-size:12px;font-weight:600;">1) Create offer (Peer A)</div>
        <button id="btnOffer" type="button" style="padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">Create offer</button>
        <textarea id="offerOut" placeholder="Offer appears here (copy and send to Peer B)" style="width:100%;height:90px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
      </div>

      <div style="display:grid;gap:6px;">
        <div style="font-size:12px;font-weight:600;">2) Create answer (Peer B)</div>
        <textarea id="offerIn" placeholder="Paste offer from Peer A" style="width:100%;height:70px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
        <button id="btnAnswer" type="button" style="padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">Create answer</button>
        <textarea id="answerOut" placeholder="Answer appears here (copy back to Peer A)" style="width:100%;height:90px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
      </div>

      <div style="display:grid;gap:6px;">
        <div style="font-size:12px;font-weight:600;">3) Apply answer (Peer A)</div>
        <textarea id="answerIn" placeholder="Paste answer from Peer B" style="width:100%;height:70px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
        <button id="btnApplyAnswer" type="button" style="padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">Apply answer</button>
      </div>

      <div style="display:flex;gap:8px;">
        <button id="btnReset" type="button" style="flex:1;padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">Clear session (local)</button>
      </div>

      <div style="display:grid;gap:6px;">
        <div style="font-size:12px;font-weight:600;">DataChannel</div>
        <div id="dcState" style="font-size:12px;color:#555;">Not connected</div>
        <textarea id="msgIn" placeholder="Type message…" style="width:100%;height:60px;resize:vertical;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:12px;"></textarea>
        <button id="btnSend" type="button" style="padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;" disabled>Send</button>
        <pre id="log" style="white-space:pre-wrap;margin:0;padding:10px;border:1px solid #eee;border-radius:8px;background:#fafafa;font-size:12px;max-height:160px;overflow:auto;"></pre>
      </div>
    </div>
  `;
}

function setLogText(text: string) {
  const el = $('#log') as HTMLPreElement;
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}

function appendLogLine(line: string) {
  const el = $('#log') as HTMLPreElement;
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

async function persistLogLine(line: string) {
  appendLogLine(line);
  if (typeof activeTabId === 'number') {
    await chrome.runtime.sendMessage({ type: 'BALE_APPEND_LOG', tabId: activeTabId, line }).catch(() => void 0);
  }
}

function urlKind(u: string): string {
  const x = u.toLowerCase();
  if (x.startsWith('turns:')) return 'TURNS';
  if (x.startsWith('turn:')) return 'TURN';
  if (x.startsWith('stuns:')) return 'STUNS';
  if (x.startsWith('stun:')) return 'STUN';
  return 'OTHER';
}

function summarizeIceServers(servers: RTCIceServer[] | undefined): string {
  if (!servers?.length) return '(none)';
  return servers
    .map((s, i) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(Boolean) as string[];
      const kinds = urls.map(urlKind);
      const hasUser = Boolean((s as any).username);
      const hasCred = Boolean((s as any).credential);
      const ct = (s as any).credentialType ?? 'default';
      return `#${i} [${kinds.join(', ')}] ${urls.join(' | ')}  user=${hasUser ? 'yes' : 'no'}  credential=${hasCred ? 'yes' : 'no'}  credentialType=${ct}`;
    })
    .join('\n');
}

function updateIcePanel(state: Extract<BgStateResponse, { ok: true }>['state']) {
  const raw = state.iceServersRaw ?? state.iceServers ?? [];
  const filtered = state.iceServers ?? [];
  ($('#iceSummary') as HTMLPreElement).textContent =
    `Filtered (used for WebRTC): ${filtered.length} server(s)\n` + summarizeIceServers(filtered) +
    `\n\nRaw (from page): ${raw.length} server(s)\n` + summarizeIceServers(raw);

  const dump = {
    capturedFromUrl: state.url,
    updatedAt: state.updatedAt,
    lastHookError: state.lastError ?? null,
    iceServersFiltered: filtered,
    iceServersRaw: state.iceServersRaw ?? raw,
  };
  ($('#iceJson') as HTMLPreElement).textContent = JSON.stringify(dump, null, 2);
}

async function getState(): Promise<BgStateResponse> {
  return (await chrome.runtime.sendMessage({ type: 'BALE_BG_GET_ACTIVE_TAB_STATE' })) as BgStateResponse;
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
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

let pcA: RTCPeerConnection | null = null;
let dcA: RTCDataChannel | null = null;
let pcB: RTCPeerConnection | null = null;
let dcB: RTCDataChannel | null = null;

function setDcState(text: string) {
  ($('#dcState') as HTMLDivElement).textContent = text;
}

function setSendEnabled(enabled: boolean) {
  ($('#btnSend') as HTMLButtonElement).disabled = !enabled;
}

function closeLocalPeers() {
  try {
    dcA?.close();
  } catch {
    /* ignore */
  }
  try {
    dcB?.close();
  } catch {
    /* ignore */
  }
  try {
    pcA?.close();
  } catch {
    /* ignore */
  }
  try {
    pcB?.close();
  } catch {
    /* ignore */
  }
  dcA = null;
  dcB = null;
  pcA = null;
  pcB = null;
  setDcState('Not connected');
  setSendEnabled(false);
}

function attachDc(dc: RTCDataChannel, label: string) {
  dc.addEventListener('open', () => {
    setDcState(`Connected (${label})`);
    setSendEnabled(true);
    void persistLogLine(`[dc] open (${label})`);
  });
  dc.addEventListener('close', () => {
    setDcState('Closed');
    setSendEnabled(false);
    void persistLogLine(`[dc] close (${label})`);
  });
  dc.addEventListener('message', e => {
    void persistLogLine(`[peer] ${String(e.data)}`);
  });
  dc.addEventListener('error', () => {
    void persistLogLine(`[dc] error (${label})`);
  });
}

function iceServersForPc(state: Extract<BgStateResponse, { ok: true }>['state']): RTCIceServer[] {
  const primary = state.iceServers ?? [];
  if (primary.length) return primary;
  const raw = state.iceServersRaw ?? [];
  return raw;
}

async function getIceServersOrThrow(state: Extract<BgStateResponse, { ok: true }>['state']): Promise<RTCIceServer[]> {
  const servers = iceServersForPc(state);
  if (!servers.length) {
    throw new Error(
      'No ICE servers for this tab. Open the chat/call page, wait for WebRTC, then click “Refresh from tab”.',
    );
  }
  return servers;
}

function offererStillNeedsAnswer(pc: RTCPeerConnection | null): boolean {
  if (!pc) return false;
  return pc.localDescription?.type === 'offer' && !pc.remoteDescription;
}

/** Peer A loses in-memory pcA when the popup closes; rebuild from the saved offer blob before setRemoteDescription(answer). */
async function ensureOffererReadyForAnswer(tabId: number): Promise<void> {
  // Prefer description state over signalingState (some builds report differently while ICE runs).
  if (offererStillNeedsAnswer(pcA)) return;

  if (pcA?.remoteDescription) {
    throw new Error('Answer was already applied. Use “Clear session” if you need a new offer.');
  }

  let offerText = ($('#offerOut') as HTMLTextAreaElement).value.trim();
  const st = await getState();
  if (!st.ok) throw new Error(st.reason);

  if (!offerText && typeof st.ui?.offerOut === 'string' && st.ui.offerOut.trim()) {
    offerText = st.ui.offerOut.trim();
    ($('#offerOut') as HTMLTextAreaElement).value = offerText;
    await persistLogLine('[offer] loaded offer blob from storage (field was empty)');
  }

  if (!offerText) {
    throw new Error(
      'No saved offer. Click “Create offer” first, or reload the popup so the offer field refills from storage.',
    );
  }

  const iceServers = await getIceServersOrThrow(st.state);
  const offerBundle = decodeBundle(offerText);

  closeLocalPeers();
  await persistLogLine('[offer] restored local peer from saved offer (needed after popup closed or session cleared)');

  pcA = new RTCPeerConnection({ iceServers });
  const log = (line: string) => {
    appendLogLine(line);
    void chrome.runtime.sendMessage({ type: 'BALE_APPEND_LOG', tabId, line }).catch(() => void 0);
  };
  pcA.addEventListener('connectionstatechange', () => log(`[pcA] ${pcA?.connectionState}`));
  pcA.addEventListener('iceconnectionstatechange', () => log(`[pcA] ice=${pcA?.iceConnectionState}`));
  pcA.addEventListener('icecandidateerror', e => {
    log(`[pcA] icecandidateerror code=${e.errorCode} text=${e.errorText ?? ''}`);
  });

  dcA = pcA.createDataChannel('bale-link');
  attachDc(dcA, 'A');

  await pcA.setLocalDescription(offerBundle.sdp);
}

function applyUiFromState(r: Extract<BgStateResponse, { ok: true }>, opts?: { fullLog?: boolean }) {
  const ui = r.ui ?? {};
  if (ui.offerOut != null) ($('#offerOut') as HTMLTextAreaElement).value = ui.offerOut;
  if (ui.offerIn != null) ($('#offerIn') as HTMLTextAreaElement).value = ui.offerIn;
  if (ui.answerOut != null) ($('#answerOut') as HTMLTextAreaElement).value = ui.answerOut;
  if (ui.answerIn != null) ($('#answerIn') as HTMLTextAreaElement).value = ui.answerIn;

  if (opts?.fullLog && ui.logs?.length) {
    setLogText(ui.logs.join('\n'));
  }

  updateIcePanel(r.state);
}

function wireUiPersistence(tabId: number) {
  const save = debounce((patch: Record<string, string>) => {
    void mergePeerLinkUi(tabId, patch);
  }, 300);

  for (const id of ['offerOut', 'offerIn', 'answerOut', 'answerIn'] as const) {
    const el = $(`#${id}`) as HTMLTextAreaElement;
    el.addEventListener('input', () => {
      // Avoid debounced empty saves wiping a just-created offer blob from storage.
      if ((id === 'offerOut' || id === 'answerOut') && el.value.trim() === '') return;
      save({ [id]: el.value });
    });
  }
}

/** Writes handshake fields straight to chrome.storage from the popup so they survive an immediate close. */
function bindHandshakeFlushOnClose(tabId: number) {
  const flush = () => {
    void mergePeerLinkUi(tabId, {
      offerOut: ($('#offerOut') as HTMLTextAreaElement).value,
      offerIn: ($('#offerIn') as HTMLTextAreaElement).value,
      answerOut: ($('#answerOut') as HTMLTextAreaElement).value,
      answerIn: ($('#answerIn') as HTMLTextAreaElement).value,
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}

async function main() {
  render();

  if (typeof RTCPeerConnection === 'undefined') {
    ($('#status')!).textContent = 'This popup has no RTCPeerConnection (unexpected). Try updating Chrome.';
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (typeof tabId !== 'number') {
    ($('#status')!).textContent = 'No active tab';
    return;
  }
  activeTabId = tabId;

  const port = chrome.runtime.connect({ name: 'peer-link' });
  port.postMessage({ type: 'subscribe', tabId });

  port.onMessage.addListener((msg: { type?: string; line?: string; patch?: Record<string, string>; ui?: any }) => {
    if (msg?.type === 'log' && typeof msg.line === 'string') {
      appendLogLine(msg.line);
    }
    if (msg?.type === 'ui' && msg.patch) {
      const p = msg.patch;
      for (const key of ['offerOut', 'offerIn', 'answerOut', 'answerIn'] as const) {
        const v = p[key];
        if (typeof v !== 'string') continue;
        if ((key === 'offerOut' || key === 'answerOut') && !v.trim()) continue;
        ($(`#${key}`) as HTMLTextAreaElement).value = v;
      }
    }
    if (msg?.type === 'init' && msg.ui) {
      const u = msg.ui;
      // Late `init` can carry stale empty ui and must not wipe blobs the user already generated.
      for (const key of ['offerOut', 'offerIn', 'answerOut', 'answerIn'] as const) {
        const v = u[key];
        if (typeof v !== 'string' || !v.trim()) continue;
        const el = $(`#${key}`) as HTMLTextAreaElement;
        if (!el.value.trim()) el.value = v;
      }
      if (u.logs?.length && !($('#log') as HTMLPreElement).textContent?.trim()) {
        setLogText(u.logs.join('\n'));
      }
    }
  });

  const r = await getState();
  const status = $('#status')!;
  if (!r.ok) {
    status.textContent = `Active tab: unavailable (${r.reason})`;
    return;
  }

  const age = r.state.updatedAt ? `${Math.round((Date.now() - r.state.updatedAt) / 1000)}s ago` : 'never';
  const fc = r.state.iceServers?.length ?? 0;
  const rc = r.state.iceServersRaw?.length ?? fc;
  status.textContent = `Tab ${r.tabId}: ${r.state.url ?? '(unknown)'}\nICE filtered: ${fc} | raw: ${rc} (updated: ${age})${
    r.state.lastError ? `\nHook error: ${r.state.lastError}` : ''
  }`;

  applyUiFromState(r, { fullLog: true });
  wireUiPersistence(tabId);
  bindHandshakeFlushOnClose(tabId);

  ($('#btnRefreshIce') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'BALE_GET_ICE_SERVERS' });
      await chrome.runtime.sendMessage({
        type: 'BALE_ICE_SERVERS_SYNC',
        tabId,
        iceServers: resp?.iceServers ?? [],
        iceServersRaw: resp?.iceServersRaw ?? resp?.iceServers ?? [],
        url: resp?.url ?? '',
      });
      const st = await getState();
      if (st.ok) {
        applyUiFromState(st);
        const age2 = st.state.updatedAt ? `${Math.round((Date.now() - st.state.updatedAt) / 1000)}s ago` : 'never';
        status.textContent = `Tab ${st.tabId}: ${st.state.url ?? ''}\nICE filtered: ${st.state.iceServers?.length ?? 0} | raw: ${st.state.iceServersRaw?.length ?? 0} (updated: ${age2})`;
        await persistLogLine('[ice] refreshed from content script');
      }
    } catch (e) {
      await persistLogLine(
        `[error] Refresh failed — is this tab supported? ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  ($('#btnOffer') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      const st = await getState();
      if (!st.ok) throw new Error(st.reason);
      const iceServers = await getIceServersOrThrow(st.state);

      closeLocalPeers();
      await persistLogLine('[offer] creating…');

      pcA = new RTCPeerConnection({ iceServers });
      const log = (line: string) => {
        appendLogLine(line);
        void chrome.runtime.sendMessage({ type: 'BALE_APPEND_LOG', tabId, line }).catch(() => void 0);
      };
      pcA.addEventListener('connectionstatechange', () => log(`[pcA] ${pcA?.connectionState}`));
      pcA.addEventListener('iceconnectionstatechange', () => log(`[pcA] ice=${pcA?.iceConnectionState}`));
      pcA.addEventListener('icecandidateerror', e => {
        log(`[pcA] icecandidateerror code=${e.errorCode} text=${e.errorText ?? ''}`);
      });

      dcA = pcA.createDataChannel('bale-link');
      attachDc(dcA, 'A');

      const offer = await pcA.createOffer();
      await pcA.setLocalDescription(offer);
      await waitForIceGathering(pcA, log);

      const bundle: HandshakeBundle = { sdp: pcA.localDescription! };
      const offerB64 = b64encodeUtf8(JSON.stringify(bundle));
      ($('#offerOut') as HTMLTextAreaElement).value = offerB64;
      await mergePeerLinkUi(tabId, { offerOut: offerB64 });
      await persistLogLine(`[offer] done (candidates in SDP: ${countCandidatesInSdp(pcA.localDescription?.sdp)})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await persistLogLine(`[error] ${msg}`);
      closeLocalPeers();
    }
  });

  ($('#btnAnswer') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      const st = await getState();
      if (!st.ok) throw new Error(st.reason);
      const iceServers = await getIceServersOrThrow(st.state);
      const offerText = ($('#offerIn') as HTMLTextAreaElement).value;
      if (!offerText.trim()) throw new Error('Paste an offer first.');

      closeLocalPeers();
      await persistLogLine('[answer] creating…');

      const offerBundle = decodeBundle(offerText);
      const pc = new RTCPeerConnection({ iceServers });
      const log = (line: string) => {
        appendLogLine(line);
        void chrome.runtime.sendMessage({ type: 'BALE_APPEND_LOG', tabId, line }).catch(() => void 0);
      };
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
      await waitForIceGathering(pc, log);

      pcB = pc;
      const bundle: HandshakeBundle = { sdp: pc.localDescription! };
      const answerB64 = b64encodeUtf8(JSON.stringify(bundle));
      ($('#answerOut') as HTMLTextAreaElement).value = answerB64;
      await mergePeerLinkUi(tabId, { offerIn: offerText, answerOut: answerB64 });
      await persistLogLine(`[answer] done (candidates in SDP: ${countCandidatesInSdp(pc.localDescription?.sdp)})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await persistLogLine(`[error] ${msg}`);
      closeLocalPeers();
    }
  });

  ($('#btnApplyAnswer') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      const answerText = ($('#answerIn') as HTMLTextAreaElement).value;
      if (!answerText.trim()) throw new Error('Paste an answer first.');
      await ensureOffererReadyForAnswer(tabId);
      const answerBundle = decodeBundle(answerText);
      await pcA!.setRemoteDescription(answerBundle.sdp);
      await mergePeerLinkUi(tabId, { answerIn: answerText });
      await persistLogLine('[answer] applied');
    } catch (e) {
      await persistLogLine(`[error] ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  ($('#btnSend') as HTMLButtonElement).addEventListener('click', async () => {
    const text = ($('#msgIn') as HTMLTextAreaElement).value;
    const dc = dcA?.readyState === 'open' ? dcA : dcB?.readyState === 'open' ? dcB : null;
    if (!dc) {
      await persistLogLine('[send] DataChannel not open');
      return;
    }
    try {
      dc.send(text);
      await persistLogLine(`[me] ${text}`);
    } catch (e) {
      await persistLogLine(`[error] ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  ($('#btnReset') as HTMLButtonElement).addEventListener('click', async () => {
    closeLocalPeers();
    await persistLogLine('[local] peer connections closed');
  });
}

main().catch(e => {
  render();
  setLogText(`[fatal] ${e instanceof Error ? e.message : String(e)}`);
});
