export function countCandidatesInSdp(sdp?: string | null) {
  if (!sdp) return 0;
  return (sdp.match(/^a=candidate:/gm) ?? []).length;
}

export function countRelayCandidatesInSdp(sdp?: string | null) {
  if (!sdp) return 0;
  return (sdp.match(/^a=candidate:.*\btyp relay\b/gm) ?? []).length;
}

/**
 * @param opts.waitUntilComplete — wait until `iceGatheringState === 'complete'` so the SDP is final.
 *   When true, we do **not** stop early on `timeoutMs` (that produced incomplete blobs and hung ICE).
 *   If gathering never completes, we reject after `hardTimeoutMs`.
 */
export async function waitForIceGathering(
  pc: RTCPeerConnection,
  log: (line: string) => void,
  opts?: {
    timeoutMs?: number;
    hardTimeoutMs?: number;
    minCandidates?: number;
    waitUntilComplete?: boolean;
  },
) {
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const hardTimeoutMs = opts?.hardTimeoutMs ?? 120_000;
  const minCandidates = opts?.minCandidates ?? 1;
  const waitUntilComplete = opts?.waitUntilComplete ?? false;

  const already = countCandidatesInSdp(pc.localDescription?.sdp);
  if (pc.iceGatheringState === 'complete') return;
  if (!waitUntilComplete && already >= minCandidates) return;

  return new Promise<void>((resolve, reject) => {
    let bestCount = already;
    const startedAt = Date.now();
    let slowGatherWarned = false;
    let lastLoggedCount = already;

    const maybeDone = () => {
      const nowCount = countCandidatesInSdp(pc.localDescription?.sdp);
      if (nowCount > bestCount) {
        bestCount = nowCount;
        const jump = nowCount - lastLoggedCount;
        if (nowCount <= 10 || jump >= 5) {
          log(`[ice] candidates so far: ${bestCount}`);
          lastLoggedCount = nowCount;
        }
      }

      const elapsed = Date.now() - startedAt;
      if (pc.iceGatheringState === 'complete') {
        cleanup();
        const sdp = pc.localDescription?.sdp;
        const relay = countRelayCandidatesInSdp(sdp);
        const srflx = (sdp?.match(/^a=candidate:.*\btyp srflx\b/gm) ?? []).length;
        log(`[ice] gathering complete (${bestCount} candidate(s), srflx=${srflx}, relay=${relay})`);
        if (relay === 0) {
          log(
            '[ice] no relay (TURN) candidates — fine on LAN; across NAT, both sides need srflx (STUN) or relay (TURN). If this fails, capture a tab that uses TURN (e.g. during a call).',
          );
        }
        resolve();
        return;
      }
      if (!waitUntilComplete && bestCount >= minCandidates) {
        cleanup();
        log(`[ice] got ${bestCount} candidate(s) (continuing without waiting for complete)`);
        resolve();
        return;
      }
      if (waitUntilComplete) {
        if (elapsed >= hardTimeoutMs) {
          cleanup();
          reject(
            new Error(
              `ICE gathering never reached "complete" within ${Math.round(hardTimeoutMs / 1000)}s (${bestCount} candidates in SDP). Do not copy the handshake until the log shows "gathering complete".`,
            ),
          );
          return;
        }
        if (!slowGatherWarned && elapsed >= timeoutMs && pc.iceGatheringState === 'gathering') {
          slowGatherWarned = true;
          log(
            `[ice] still gathering after ${Math.round(timeoutMs / 1000)}s (waiting for browser to finish — TURN can be slow). Do not copy the offer yet.`,
          );
        }
      } else if (elapsed >= timeoutMs) {
        cleanup();
        log(`[ice] timed out after ${Math.round(timeoutMs / 1000)}s with ${bestCount} candidate(s)`);
        resolve();
      }
    };

    const onIceCandidate = () => maybeDone();
    const onGatheringChange = () => maybeDone();

    const tickMs = 250;
    const to = setInterval(() => maybeDone(), tickMs);
    const cleanup = () => {
      clearInterval(to);
      pc.removeEventListener('icecandidate', onIceCandidate);
      pc.removeEventListener('icegatheringstatechange', onGatheringChange);
    };

    pc.addEventListener('icecandidate', onIceCandidate);
    pc.addEventListener('icegatheringstatechange', onGatheringChange);
    maybeDone();
  });
}
