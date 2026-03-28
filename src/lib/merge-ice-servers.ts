/**
 * Extra STUN servers so PeerConnection can gather server-reflexive (srflx) candidates
 * across NAT even when the host page only passed TURN or an incomplete list.
 * Symmetric NAT / strict firewalls still need TURN relay from the page (or another source).
 */
const PUBLIC_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

function serverKey(s: RTCIceServer): string {
  const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(Boolean).map(String).sort();
  const o = s as RTCIceServer & { credentialType?: string };
  return JSON.stringify({
    urls,
    username: o.username ?? null,
    credential: o.credential ?? null,
    credentialType: o.credentialType ?? null,
  });
}

/** Deduped list: captured servers first, then public STUN entries not already present. */
export function mergeIceServersWithPublicStun(captured: RTCIceServer[]): RTCIceServer[] {
  const seen = new Set<string>();
  const out: RTCIceServer[] = [];
  for (const s of captured) {
    const k = serverKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  for (const s of PUBLIC_STUN_SERVERS) {
    const k = serverKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
