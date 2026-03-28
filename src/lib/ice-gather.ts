export function countCandidatesInSdp(sdp?: string | null) {
  if (!sdp) return 0;
  return (sdp.match(/^a=candidate:/gm) ?? []).length;
}

export function countRelayCandidatesInSdp(sdp?: string | null) {
  if (!sdp) return 0;
  return (sdp.match(/^a=candidate:.*\btyp relay\b/gm) ?? []).length;
}

/**
 * @param opts.waitUntilComplete — wait for ICE gathering to finish so pasted SDP includes STUN/TURN
 *   (relay) candidates. Without this, resolving after minCandidates (default 1) often leaves only host.
 */
export async function waitForIceGathering(
  pc: RTCPeerConnection,
  log: (line: string) => void,
  opts?: { timeoutMs?: number; minCandidates?: number; waitUntilComplete?: boolean },
) {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const minCandidates = opts?.minCandidates ?? 1;
  const waitUntilComplete = opts?.waitUntilComplete ?? false;

  const already = countCandidatesInSdp(pc.localDescription?.sdp);
  if (pc.iceGatheringState === 'complete') return;
  if (!waitUntilComplete && already >= minCandidates) return;

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
        const sdp = pc.localDescription?.sdp;
        const relay = countRelayCandidatesInSdp(sdp);
        log(`[ice] gathering complete (${bestCount} candidate(s), relay=${relay})`);
        resolve();
        return;
      }
      if (!waitUntilComplete && bestCount >= minCandidates) {
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
