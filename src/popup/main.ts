import {
  countCandidatesInSdp,
  countRelayCandidatesInSdp,
  waitForIceGathering,
} from '../lib/ice-gather';
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
      ui: {
        uiRole?: 'offer' | 'receive';
        offerOut?: string;
        offerIn?: string;
        answerOut?: string;
        answerIn?: string;
        logs?: string[];
      };
    }
  | { ok: false; reason: string };

type HandshakeBundle = { sdp: RTCSessionDescriptionInit };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T | null;

let activeTabId: number | null = null;

function setUiMode(mode: 'offer' | 'receive', persistTabId?: number) {
  const pOffer = $('#panelOffer') as HTMLElement | null;
  const pRecv = $('#panelReceive') as HTMLElement | null;
  const offerBtn = $('#modeOffer') as HTMLButtonElement | null;
  const recvBtn = $('#modeRecv') as HTMLButtonElement | null;
  if (!pOffer || !pRecv || !offerBtn || !recvBtn) return;
  const isOffer = mode === 'offer';
  pOffer.toggleAttribute('hidden', !isOffer);
  pRecv.toggleAttribute('hidden', isOffer);
  offerBtn.classList.toggle('pl-seg__btn--active', isOffer);
  recvBtn.classList.toggle('pl-seg__btn--active', !isOffer);
  offerBtn.setAttribute('aria-pressed', String(isOffer));
  recvBtn.setAttribute('aria-pressed', String(!isOffer));
  if (typeof persistTabId === 'number') void mergePeerLinkUi(persistTabId, { uiRole: mode });
}

async function copyToClipboard(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

function flashButtonLabel(btn: HTMLButtonElement, ok: boolean) {
  const prev = btn.textContent ?? '';
  btn.textContent = ok ? 'Copied!' : 'Failed';
  setTimeout(() => {
    btn.textContent = prev;
  }, 1500);
}

function render() {
  document.body.style.margin = '0';
  document.body.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  document.body.style.width = '400px';
  document.body.style.background = '#eef0f4';

  const root = $('#app')!;
  root.innerHTML = `
<style>
  .pl-card{background:var(--pl-card,#fff);border:1px solid var(--pl-border,#dfe3eb);border-radius:12px;padding:12px;margin:10px;box-shadow:0 1px 2px rgba(15,23,42,.04);}
  .pl-head{border-bottom:1px solid var(--pl-border,#dfe3eb);padding:12px 14px;margin:-10px -10px 12px -10px;background:linear-gradient(180deg,#fafbfd 0%,#fff 100%);border-radius:12px 12px 0 0;}
  .pl-title{font-weight:650;font-size:15px;color:#0f172a;letter-spacing:-0.02em;}
  .pl-status{margin-top:6px;font-size:11px;color:#64748b;line-height:1.45;white-space:pre-wrap;}
  .pl-seg{display:flex;padding:3px;background:#e8ecf2;border-radius:10px;gap:3px;margin-bottom:4px;}
  .pl-seg__btn{flex:1;border:none;background:transparent;padding:8px 10px;font-size:12px;font-weight:600;color:#475569;border-radius:8px;cursor:pointer;transition:background .15s,color .15s;}
  .pl-seg__btn:hover{color:#0f172a;}
  .pl-seg__btn--active{background:#fff;color:#1d4ed8;box-shadow:0 1px 2px rgba(15,23,42,.08);}
  .pl-hint{font-size:11px;color:#64748b;line-height:1.45;margin:0 0 10px;}
  .pl-label{display:block;font-size:11px;font-weight:600;color:#334155;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;}
  .pl-blob-row{display:flex;flex-direction:column;gap:8px;margin-bottom:12px;}
  .pl-blob{width:100%;min-height:88px;max-height:120px;padding:10px 11px;border:1px solid var(--pl-border,#dfe3eb);border-radius:10px;font-size:11px;line-height:1.45;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;box-sizing:border-box;}
  .pl-blob--out{background:#f1f5f9;color:#0f172a;cursor:default;user-select:text;}
  .pl-blob--in{background:#fff;color:#0f172a;}
  textarea.pl-blob--out:read-only{opacity:1;}
  .pl-btn{display:inline-flex;align-items:center;justify-content:center;padding:9px 14px;border-radius:10px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid transparent;transition:filter .12s;}
  .pl-btn:disabled{opacity:.45;cursor:not-allowed;}
  .pl-btn--primary{background:#1d4ed8;color:#fff;}
  .pl-btn--primary:hover:not(:disabled){filter:brightness(1.05);}
  .pl-btn--secondary{background:#fff;color:#334155;border-color:#cbd5e1;}
  .pl-btn--secondary:hover:not(:disabled){background:#f8fafc;}
  .pl-btn--ghost{background:transparent;color:#475569;border-color:#cbd5e1;}
  .pl-row-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px;}
  .pl-ice summary{cursor:pointer;font-size:12px;font-weight:600;color:#475569;padding:4px 0;}
  .pl-ice .pl-muted{font-size:11px;color:#64748b;margin:6px 0;}
  .pl-footer-actions{display:flex;gap:8px;margin-top:4px;}
  .pl-chat .pl-label{margin-top:4px;}
  body.pl-chat-only{background:#eef0f4;}
  body.pl-chat-only #pl-setup{display:none !important;}
  body.pl-chat-only .pl-chat{margin:8px;box-shadow:0 2px 8px rgba(15,23,42,.06);}
  body.pl-chat-only .pl-chat #msgIn{min-height:96px;max-height:220px;}
  body.pl-chat-only #pl-log-section{display:none !important;}
  .pl-transcript{display:none;max-height:200px;overflow-y:auto;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:10px;font-size:12px;line-height:1.45;}
  body.pl-chat-only .pl-transcript{display:block;}
  .pl-tr--me{margin:6px 0;padding:6px 10px;background:#dbeafe;border-radius:10px 10px 4px 10px;text-align:left;color:#1e3a8a;word-break:break-word;}
  .pl-tr--peer{margin:6px 0;padding:6px 10px;background:#fff;border:1px solid #e2e8f0;border-radius:10px 10px 10px 4px;color:#0f172a;word-break:break-word;}
</style>

<div id="pl-setup">
<div class="pl-head">
  <div class="pl-title">Peer Link</div>
  <div id="status" class="pl-status"></div>
</div>

<div class="pl-card">
  <div class="pl-seg" role="tablist" aria-label="Connection role">
    <button type="button" class="pl-seg__btn pl-seg__btn--active" id="modeOffer" role="tab" aria-selected="true" aria-pressed="true">Start — I send offer</button>
    <button type="button" class="pl-seg__btn" id="modeRecv" role="tab" aria-selected="false" aria-pressed="false">Join — I send answer</button>
  </div>
  <p class="pl-hint">Keep this window open while the link is active. Handshake text is saved per tab when you close the popup. Each blob waits until ICE gathering finishes so STUN/TURN candidates are inside the SDP — offer and answer are enough; no separate ICE trickle step.</p>

  <div id="panelOffer" class="pl-panel-offer">
    <div class="pl-row-actions">
      <button type="button" class="pl-btn pl-btn--primary" id="btnOffer">1. Create offer</button>
    </div>
    <label class="pl-label" for="offerOut">Your offer (read-only — copy to send)</label>
    <div class="pl-blob-row">
      <textarea id="offerOut" class="pl-blob pl-blob--out" readonly spellcheck="false" autocomplete="off" placeholder="Click “Create offer” first…"></textarea>
      <button type="button" class="pl-btn pl-btn--secondary" id="btnCopyOffer">Copy offer</button>
    </div>
    <label class="pl-label" for="answerIn">Peer’s answer (paste here)</label>
    <textarea id="answerIn" class="pl-blob pl-blob--in" spellcheck="false" autocomplete="off" placeholder="Paste the answer blob from your peer…" rows="4"></textarea>
    <button type="button" class="pl-btn pl-btn--primary" id="btnApplyAnswer" style="width:100%;margin-top:4px;">2. Apply answer</button>
  </div>

  <div id="panelReceive" class="pl-panel-receive" hidden>
    <label class="pl-label" for="offerIn">Peer’s offer (paste here)</label>
    <textarea id="offerIn" class="pl-blob pl-blob--in" spellcheck="false" autocomplete="off" placeholder="Paste the offer blob from your peer…" rows="4"></textarea>
    <div class="pl-row-actions">
      <button type="button" class="pl-btn pl-btn--primary" id="btnAnswer">1. Create answer</button>
    </div>
    <label class="pl-label" for="answerOut">Your answer (read-only — copy to send)</label>
    <div class="pl-blob-row">
      <textarea id="answerOut" class="pl-blob pl-blob--out" readonly spellcheck="false" autocomplete="off" placeholder="Create answer first…"></textarea>
      <button type="button" class="pl-btn pl-btn--secondary" id="btnCopyAnswer">Copy answer</button>
    </div>
  </div>
</div>

<details class="pl-card pl-ice">
  <summary>ICE servers (technical)</summary>
  <p class="pl-muted">From the open tab’s WebRTC. Credentials are secret — do not share this block.</p>
  <div class="pl-row-actions">
    <button type="button" class="pl-btn pl-btn--ghost" id="btnRefreshIce">Refresh from tab</button>
  </div>
  <pre id="iceSummary" style="margin:0 0 8px;padding:8px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-size:10px;max-height:88px;overflow:auto;white-space:pre-wrap;"></pre>
  <pre id="iceJson" style="margin:0;padding:8px;border:1px solid #e2e8f0;border-radius:8px;background:#f1f5f9;font-size:9px;line-height:1.35;max-height:140px;overflow:auto;"></pre>
</details>
</div>

<div class="pl-card pl-chat">
  <label class="pl-label" id="pl-chat-heading">Chat</label>
  <div id="dcState" style="font-size:12px;color:#475569;margin-bottom:8px;">Not connected</div>
  <div id="pl-transcript" class="pl-transcript" aria-live="polite"></div>
  <textarea id="msgIn" class="pl-blob pl-blob--in" placeholder="Type a message…" rows="2" style="min-height:52px;max-height:80px;"></textarea>
  <div class="pl-footer-actions">
    <button type="button" class="pl-btn pl-btn--primary" id="btnSend" disabled>Send</button>
    <button type="button" class="pl-btn pl-btn--ghost" id="btnReset">Clear local peers</button>
  </div>
  <div id="pl-log-section">
    <label class="pl-label" style="margin-top:12px;">Log</label>
    <pre id="log" style="white-space:pre-wrap;margin:0;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-size:11px;max-height:140px;overflow:auto;line-height:1.4;"></pre>
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

/** Resolves when the current “Create offer” click handler finishes (success or catch). */
let offerCreationInFlight: Promise<void> | null = null;

function setDcState(text: string) {
  ($('#dcState') as HTMLDivElement).textContent = text;
}

function setSendEnabled(enabled: boolean) {
  ($('#btnSend') as HTMLButtonElement).disabled = !enabled;
}

function appendChatLine(role: 'me' | 'peer', text: string) {
  const tr = $('#pl-transcript') as HTMLDivElement | null;
  if (!tr) return;
  const row = document.createElement('div');
  row.className = role === 'me' ? 'pl-tr--me' : 'pl-tr--peer';
  row.textContent = text;
  tr.appendChild(row);
  tr.scrollTop = tr.scrollHeight;
}

/** When the DataChannel is open, hide handshake/ICE and focus on chat. */
function setChatOnlyLayout(on: boolean) {
  document.body.classList.toggle('pl-chat-only', on);
  const h = $('#pl-chat-heading') as HTMLLabelElement | null;
  if (h) h.textContent = on ? 'Connected' : 'Chat';
  const tr = $('#pl-transcript') as HTMLDivElement | null;
  if (tr && on) tr.replaceChildren();
}

function closePeerBOnly() {
  try {
    dcB?.close();
  } catch {
    /* ignore */
  }
  try {
    pcB?.close();
  } catch {
    /* ignore */
  }
  dcB = null;
  pcB = null;
}

function closeLocalPeers() {
  try {
    dcA?.close();
  } catch {
    /* ignore */
  }
  closePeerBOnly();
  try {
    pcA?.close();
  } catch {
    /* ignore */
  }
  dcA = null;
  pcA = null;
  setDcState('Not connected');
  setSendEnabled(false);
  setChatOnlyLayout(false);
  ($('#pl-transcript') as HTMLDivElement | null)?.replaceChildren();
}

function attachDc(dc: RTCDataChannel, label: string) {
  dc.addEventListener('open', () => {
    setDcState(`Connected (${label})`);
    setSendEnabled(true);
    setChatOnlyLayout(true);
    void persistLogLine(`[dc] open (${label})`);
  });
  dc.addEventListener('close', () => {
    setDcState('Closed');
    setSendEnabled(false);
    setChatOnlyLayout(false);
    void persistLogLine(`[dc] close (${label})`);
  });
  dc.addEventListener('message', e => {
    const s = String(e.data);
    void persistLogLine(`[peer] ${s}`);
    appendChatLine('peer', s);
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
  if (!pc || pc.remoteDescription) return false;
  // have-local-offer is set once setLocalDescription(offer) completes; prefer it over localDescription alone.
  if (pc.signalingState === 'have-local-offer') return true;
  return pc.localDescription?.type === 'offer';
}

/** Peer A loses in-memory pcA when the popup closes; rebuild from the saved offer blob before setRemoteDescription(answer). */
async function ensureOffererReadyForAnswer(tabId: number): Promise<void> {
  if (offerCreationInFlight) {
    await offerCreationInFlight;
  }
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
  const prevBundle = decodeBundle(offerText);
  if (prevBundle.sdp.type && prevBundle.sdp.type !== 'offer') {
    throw new Error('Saved blob is not an offer. Copy a fresh offer from “Create offer”.');
  }

  closeLocalPeers();
  await persistLogLine('[offer] rebuilt local peer (in-memory connection was gone — e.g. popup closed or “Create answer” cleared it)');

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

  // Chrome requires setLocalDescription to use the SDP from createOffer() on this same RTCPeerConnection;
  // re-applying a serialized offer from an old PC throws “SDP does not match the previously generated SDP”.
  const fresh = await pcA.createOffer();
  await pcA.setLocalDescription(fresh);
  await waitForIceGathering(pcA, log, { waitUntilComplete: true });

  const bundle: HandshakeBundle = { sdp: pcA.localDescription! };
  const offerB64 = b64encodeUtf8(JSON.stringify(bundle));
  ($('#offerOut') as HTMLTextAreaElement).value = offerB64;
  await mergePeerLinkUi(tabId, { offerOut: offerB64 });
  await persistLogLine(
    '[offer] a new offer was generated (fingerprints/ICE differ from the saved blob). Share it with your peer, get a new answer, then click “Apply answer” again.',
  );
  throw new Error(
    'Local peer was recreated, so the old answer no longer matches. Copy the updated offer to your peer, paste the new answer, and click “Apply answer” again.',
  );
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
  setUiMode(ui.uiRole === 'receive' ? 'receive' : 'offer');
}

function wireUiPersistence(tabId: number) {
  const save = debounce((patch: Record<string, string>) => {
    void mergePeerLinkUi(tabId, patch);
  }, 300);

  for (const id of ['offerIn', 'answerIn'] as const) {
    const el = $(`#${id}`) as HTMLTextAreaElement;
    el.addEventListener('input', () => save({ [id]: el.value }));
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

  ($('#modeOffer') as HTMLButtonElement).addEventListener('click', () => setUiMode('offer', tabId));
  ($('#modeRecv') as HTMLButtonElement).addEventListener('click', () => setUiMode('receive', tabId));

  ($('#btnCopyOffer') as HTMLButtonElement).addEventListener('click', async () => {
    const ok = await copyToClipboard(($('#offerOut') as HTMLTextAreaElement).value);
    flashButtonLabel($('#btnCopyOffer') as HTMLButtonElement, ok);
  });
  ($('#btnCopyAnswer') as HTMLButtonElement).addEventListener('click', async () => {
    const ok = await copyToClipboard(($('#answerOut') as HTMLTextAreaElement).value);
    flashButtonLabel($('#btnCopyAnswer') as HTMLButtonElement, ok);
  });

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
    const run = async () => {
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
      await waitForIceGathering(pcA, log, { waitUntilComplete: true });

      const bundle: HandshakeBundle = { sdp: pcA.localDescription! };
      const offerB64 = b64encodeUtf8(JSON.stringify(bundle));
      ($('#offerOut') as HTMLTextAreaElement).value = offerB64;
      await mergePeerLinkUi(tabId, { offerOut: offerB64 });
      const sdpA = pcA.localDescription?.sdp;
      await persistLogLine(
        `[offer] done (candidates: ${countCandidatesInSdp(sdpA)}, relay: ${countRelayCandidatesInSdp(sdpA)})`,
      );
    };

    offerCreationInFlight = run()
      .catch(async e => {
        const msg = e instanceof Error ? e.message : String(e);
        await persistLogLine(`[error] ${msg}`);
        closeLocalPeers();
      })
      .finally(() => {
        offerCreationInFlight = null;
      });
    await offerCreationInFlight;
  });

  ($('#btnAnswer') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      const st = await getState();
      if (!st.ok) throw new Error(st.reason);
      const iceServers = await getIceServersOrThrow(st.state);
      const offerText = ($('#offerIn') as HTMLTextAreaElement).value;
      if (!offerText.trim()) throw new Error('Paste an offer first.');

      closePeerBOnly();
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
      await waitForIceGathering(pc, log, { waitUntilComplete: true });

      pcB = pc;
      const bundle: HandshakeBundle = { sdp: pc.localDescription! };
      const answerB64 = b64encodeUtf8(JSON.stringify(bundle));
      ($('#answerOut') as HTMLTextAreaElement).value = answerB64;
      await mergePeerLinkUi(tabId, { offerIn: offerText, answerOut: answerB64 });
      const sdpB = pc.localDescription?.sdp;
      await persistLogLine(
        `[answer] done (candidates: ${countCandidatesInSdp(sdpB)}, relay: ${countRelayCandidatesInSdp(sdpB)})`,
      );
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
      appendChatLine('me', text);
      await persistLogLine(`[me] ${text}`);
      ($('#msgIn') as HTMLTextAreaElement).value = '';
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
