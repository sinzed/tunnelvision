export type HandshakeBundle = { sdp: RTCSessionDescriptionInit };

export function b64encodeUtf8(text: string) {
  return btoa(unescape(encodeURIComponent(text)));
}

export function b64decodeUtf8(b64: string) {
  return decodeURIComponent(escape(atob(b64)));
}

export function decodeBundle(text: string): HandshakeBundle {
  const raw = b64decodeUtf8(text.trim());
  return JSON.parse(raw) as HandshakeBundle;
}

export function encodeBundle(bundle: HandshakeBundle): string {
  return b64encodeUtf8(JSON.stringify(bundle));
}
