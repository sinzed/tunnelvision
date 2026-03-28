export function countCandidatesInSdp(sdp?: string | null) {
  if (!sdp) return 0;
  return (sdp.match(/^a=candidate:/gm) ?? []).length;
}

export async function waitForIceGathering(
  pc: RTCPeerConnection,
  log: (line: string) => void,
  opts?: { timeoutMs?: number; minCandidates?: number },
) {
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
