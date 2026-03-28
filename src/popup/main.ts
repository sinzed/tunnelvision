type BgStateResponse =
  | {
      ok: true;
      tabId: number;
      state: { url?: string; iceServers?: RTCIceServer[]; updatedAt?: number; lastError?: string };
      ui: { offerOut?: string; offerIn?: string; answerOut?: string; answerIn?: string; logs?: string[] };
      peer: {
        role: string;
        connectionState: string;
        iceConnectionState: string;
        dcState: string | null;
      } | null;
    }
  | { ok: false; reason: string };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T | null;

function render() {
  document.body.style.margin = '0';
  document.body.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  document.body.style.width = '360px';

  const root = $('#app')!;
  root.innerHTML = `
    <div style="padding:12px 12px 10px;border-bottom:1px solid #e9e9ee;">
      <div style="font-weight:650;font-size:14px;">Peer Link</div>
      <div id="status" style="margin-top:6px;font-size:12px;color:#555;line-height:1.35;"></div>
    </div>

    <div style="padding:12px;display:grid;gap:10px;">
      <div style="font-size:11px;color:#666;">WebRTC runs in the background while this popup is closed. ICE servers are saved per tab.</div>
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

      <div style="display:flex;gap:8px;">
        <button id="btnReset" style="flex:1;padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">Reset peer session</button>
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

function applyUiFromState(
  r: Extract<BgStateResponse, { ok: true }>,
  opts?: { fullLog?: boolean },
) {
  const ui = r.ui ?? {};
  if (ui.offerOut != null) ($('#offerOut') as HTMLTextAreaElement).value = ui.offerOut;
  if (ui.offerIn != null) ($('#offerIn') as HTMLTextAreaElement).value = ui.offerIn;
  if (ui.answerOut != null) ($('#answerOut') as HTMLTextAreaElement).value = ui.answerOut;
  if (ui.answerIn != null) ($('#answerIn') as HTMLTextAreaElement).value = ui.answerIn;

  if (opts?.fullLog && ui.logs?.length) {
    setLogText(ui.logs.join('\n'));
  }

  const peer = r.peer;
  const dcEl = $('#dcState')!;
  if (!peer) {
    dcEl.textContent = 'No active peer session (create offer or answer)';
  } else {
    dcEl.textContent = `role=${peer.role} pc=${peer.connectionState} ice=${peer.iceConnectionState} dc=${peer.dcState ?? '—'}`;
  }

  const sendOk = peer?.dcState === 'open';
  ($('#btnSend') as HTMLButtonElement).disabled = !sendOk;
}

function wireUiPersistence(tabId: number) {
  const save = debounce((patch: Record<string, string>) => {
    void chrome.runtime.sendMessage({ type: 'BALE_UI_SAVE', tabId, patch });
  }, 400);

  for (const id of ['offerOut', 'offerIn', 'answerOut', 'answerIn'] as const) {
    const el = $(`#${id}`) as HTMLTextAreaElement;
    el.addEventListener('input', () => save({ [id]: el.value }));
  }
}

async function main() {
  render();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (typeof tabId !== 'number') {
    ($('#status')!).textContent = 'No active tab';
    return;
  }

  const port = chrome.runtime.connect({ name: 'peer-link' });
  port.postMessage({ type: 'subscribe', tabId });

  port.onMessage.addListener((msg: { type?: string; line?: string; patch?: Record<string, string>; ui?: any }) => {
    if (msg?.type === 'log' && typeof msg.line === 'string') {
      appendLogLine(msg.line);
    }
    if (msg?.type === 'ui' && msg.patch) {
      const p = msg.patch;
      if (typeof p.offerOut === 'string') ($('#offerOut') as HTMLTextAreaElement).value = p.offerOut;
      if (typeof p.offerIn === 'string') ($('#offerIn') as HTMLTextAreaElement).value = p.offerIn;
      if (typeof p.answerOut === 'string') ($('#answerOut') as HTMLTextAreaElement).value = p.answerOut;
      if (typeof p.answerIn === 'string') ($('#answerIn') as HTMLTextAreaElement).value = p.answerIn;
    }
    if (msg?.type === 'init' && msg.ui) {
      const u = msg.ui;
      if (typeof u.offerOut === 'string') ($('#offerOut') as HTMLTextAreaElement).value = u.offerOut;
      if (typeof u.offerIn === 'string') ($('#offerIn') as HTMLTextAreaElement).value = u.offerIn;
      if (typeof u.answerOut === 'string') ($('#answerOut') as HTMLTextAreaElement).value = u.answerOut;
      if (typeof u.answerIn === 'string') ($('#answerIn') as HTMLTextAreaElement).value = u.answerIn;
      if (u.logs?.length) setLogText(u.logs.join('\n'));
    }
  });

  const r = await getState();
  const status = $('#status')!;
  if (!r.ok) {
    status.textContent = `Active tab: unavailable (${r.reason})`;
    return;
  }

  const age = r.state.updatedAt ? `${Math.round((Date.now() - r.state.updatedAt) / 1000)}s ago` : 'never';
  const count = r.state.iceServers?.length ?? 0;
  status.textContent = `Active tab: ${r.state.url ?? '(unknown)'}\nCaptured iceServers: ${count} (updated: ${age})${
    r.state.lastError ? `\nLast hook error: ${r.state.lastError}` : ''
  }`;

  applyUiFromState(r, { fullLog: true });
  wireUiPersistence(tabId);

  ($('#btnOffer') as HTMLButtonElement).addEventListener('click', async () => {
    const res = (await chrome.runtime.sendMessage({ type: 'BALE_PC_CREATE_OFFER' })) as { ok: boolean; error?: string; offerOut?: string };
    if (!res.ok) appendLogLine(`[error] ${res.error ?? 'unknown'}`);
    else if (res.offerOut) ($('#offerOut') as HTMLTextAreaElement).value = res.offerOut;
    const st = await getState();
    if (st.ok) applyUiFromState(st);
  });

  ($('#btnAnswer') as HTMLButtonElement).addEventListener('click', async () => {
    const offerIn = ($('#offerIn') as HTMLTextAreaElement).value;
    const res = (await chrome.runtime.sendMessage({ type: 'BALE_PC_CREATE_ANSWER', offerIn })) as {
      ok: boolean;
      error?: string;
      answerOut?: string;
    };
    if (!res.ok) appendLogLine(`[error] ${res.error ?? 'unknown'}`);
    else if (res.answerOut) ($('#answerOut') as HTMLTextAreaElement).value = res.answerOut;
    const st = await getState();
    if (st.ok) applyUiFromState(st);
  });

  ($('#btnApplyAnswer') as HTMLButtonElement).addEventListener('click', async () => {
    const answerIn = ($('#answerIn') as HTMLTextAreaElement).value;
    const res = (await chrome.runtime.sendMessage({ type: 'BALE_PC_APPLY_ANSWER', answerIn })) as { ok: boolean; error?: string };
    if (!res.ok) appendLogLine(`[error] ${res.error ?? 'unknown'}`);
    const st = await getState();
    if (st.ok) applyUiFromState(st);
  });

  ($('#btnSend') as HTMLButtonElement).addEventListener('click', async () => {
    const text = ($('#msgIn') as HTMLTextAreaElement).value;
    const res = (await chrome.runtime.sendMessage({ type: 'BALE_PC_SEND', text })) as { ok: boolean; error?: string };
    if (!res.ok) appendLogLine(`[error] ${res.error ?? 'unknown'}`);
  });

  ($('#btnReset') as HTMLButtonElement).addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'BALE_PC_RESET' });
    const st = await getState();
    if (st.ok) applyUiFromState(st);
  });
}

main().catch(e => {
  render();
  setLogText(`[fatal] ${e instanceof Error ? e.message : String(e)}`);
});
