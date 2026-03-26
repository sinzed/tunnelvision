type IceServer = RTCIceServer;

type TurnCaptureMessage =
  | {
      source: 'bale-webrtc-hook';
      type: 'BALE_ICE_SERVERS';
      iceServers: IceServer[];
      url: string;
      ts: number;
    }
  | {
      source: 'bale-webrtc-hook';
      type: 'BALE_RTCPC_ERROR';
      message: string;
      ts: number;
    };

const INJECTED_SRC = chrome.runtime.getURL('injected/bale-webrtc-hook.js');

function injectHookScript() {
  const existing = document.querySelector<HTMLScriptElement>('script[data-bale-webrtc-hook="1"]');
  if (existing) return;

  const s = document.createElement('script');
  s.src = INJECTED_SRC;
  s.async = false;
  s.dataset.baleWebrtcHook = '1';
  (document.head || document.documentElement).appendChild(s);
}

function isIceServerUseful(s: IceServer) {
  const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(Boolean) as string[];
  return urls.some(u => u.startsWith('turn:') || u.startsWith('turns:') || u.startsWith('stun:'));
}

function dedupeIceServers(servers: IceServer[]) {
  const seen = new Set<string>();
  const out: IceServer[] = [];
  for (const s of servers) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(Boolean) as string[];
    const key = JSON.stringify({
      urls: urls.slice().sort(),
      username: (s as any).username ?? null,
      credential: (s as any).credential ?? null,
      credentialType: (s as any).credentialType ?? null,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

let latestIceServers: IceServer[] = [];

function setLatestIceServers(iceServers: IceServer[]) {
  const filtered = dedupeIceServers(iceServers.filter(isIceServerUseful));
  if (filtered.length === 0) return;
  latestIceServers = filtered;
  chrome.runtime.sendMessage({ type: 'BALE_ICE_SERVERS', iceServers: latestIceServers, url: location.href }).catch(() => {
    // ignore if background not ready
  });
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as TurnCaptureMessage | undefined;
  if (!data || data.source !== 'bale-webrtc-hook') return;

  if (data.type === 'BALE_ICE_SERVERS') {
    setLatestIceServers(data.iceServers);
  } else if (data.type === 'BALE_RTCPC_ERROR') {
    chrome.runtime
      .sendMessage({ type: 'BALE_RTCPC_ERROR', message: data.message, url: location.href })
      .catch(() => void 0);
  }
});

// Also allow popup to ask the content script (tab) for the current capture.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'BALE_GET_ICE_SERVERS') {
    sendResponse({ iceServers: latestIceServers, url: location.href });
    return true;
  }
  return false;
});

injectHookScript();

