// Runs in the page context (injected via <script src=...>), so it can observe
// the site's RTCPeerConnection configs and extract TURN credentials.

type IceServer = RTCIceServer;

function extractIceServers(config: RTCConfiguration | undefined | null): IceServer[] {
  const servers = (config?.iceServers ?? []) as IceServer[];
  return Array.isArray(servers) ? servers : [];
}

function postIceServers(iceServers: IceServer[]) {
  try {
    window.postMessage(
      {
        source: 'bale-webrtc-hook',
        type: 'BALE_ICE_SERVERS',
        iceServers,
        url: location.href,
        ts: Date.now(),
      },
      '*',
    );
  } catch {
    // ignore
  }
}

function postError(message: string) {
  try {
    window.postMessage(
      {
        source: 'bale-webrtc-hook',
        type: 'BALE_RTCPC_ERROR',
        message,
        ts: Date.now(),
      },
      '*',
    );
  } catch {
    // ignore
  }
}

function main() {
  const w = window as any;
  const Original = w.RTCPeerConnection as typeof RTCPeerConnection | undefined;
  if (!Original) {
    postError('RTCPeerConnection not found on window');
    return;
  }

  if (w.__BALE_RTCPC_PATCHED__) return;
  w.__BALE_RTCPC_PATCHED__ = true;

  const Patched: any = function RTCPeerConnectionPatched(this: RTCPeerConnection, config?: RTCConfiguration) {
    const iceServers = extractIceServers(config);
    if (iceServers.length) postIceServers(iceServers);

    // @ts-expect-error - we are proxying constructor call
    return new Original(config);
  };

  // Preserve prototype chain and static props
  Patched.prototype = Original.prototype;
  Object.setPrototypeOf(Patched, Original);

  // Some sites call new RTCPeerConnection(...) and some call RTCPeerConnection(...)
  // (the latter should throw in modern browsers, but we keep behavior consistent).
  w.RTCPeerConnection = new Proxy(Patched, {
    construct(target, args, newTarget) {
      try {
        const cfg = args?.[0] as RTCConfiguration | undefined;
        const iceServers = extractIceServers(cfg);
        if (iceServers.length) postIceServers(iceServers);
      } catch {
        // ignore
      }
      return Reflect.construct(Original as any, args, newTarget);
    },
    apply(_target, _thisArg, args) {
      // @ts-expect-error - emulate direct call by forwarding to constructor
      return new (Original as any)(...(args ?? []));
    },
  });
}

try {
  main();
} catch (e) {
  postError(e instanceof Error ? e.message : String(e));
}

