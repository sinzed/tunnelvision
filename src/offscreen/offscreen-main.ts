/**
 * Holds offer-side RTCPeerConnection + DataChannel so they survive extension popup teardown
 * (popups close when focus leaves — e.g. copying the offer to another window).
 */
import { countCandidatesInSdp, waitForIceGathering } from '../lib/ice-gather';

const IN = 'BALE_OFFSCREEN_OFFERER';

type TabEntry = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
};

const sessions = new Map<number, TabEntry>();

function b64encodeUtf8(text: string) {
  return btoa(unescape(encodeURIComponent(text)));
}

function broadcast(kind: string, tabId: number, extra?: Record<string, unknown>) {
  void chrome.runtime.sendMessage({ type: 'BALE_OFFERER_EVENT', tabId, kind, ...extra });
}

function attachDc(tabId: number, dc: RTCDataChannel) {
  const entry = sessions.get(tabId);
  if (entry) entry.dc = dc;

  dc.addEventListener('open', () => broadcast('dc_open', tabId));
  dc.addEventListener('close', () => {
    broadcast('dc_close', tabId);
    if (entry) entry.dc = null;
  });
  dc.addEventListener('message', ev => {
    broadcast('dc_message', tabId, { text: String(ev.data) });
  });
  dc.addEventListener('error', () => {
    broadcast('log', tabId, { line: '[dc] error (A)' });
  });
}

function offererStillNeedsAnswer(entry: TabEntry | undefined): boolean {
  if (!entry) return false;
  const { pc } = entry;
  if (pc.remoteDescription) return false;
  if (pc.signalingState === 'have-local-offer') return true;
  return pc.localDescription?.type === 'offer';
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.type !== IN) return false;

  const done = (r: unknown) => {
    try {
      sendResponse(r);
    } catch {
      /* channel closed */
    }
  };

  void (async () => {
    const tabId = msg.tabId as number;
    if (typeof tabId !== 'number') {
      done({ ok: false, error: 'missing tabId' });
      return;
    }

    try {
      switch (msg.op as string) {
        case 'reset': {
          const cur = sessions.get(tabId);
          if (cur) {
            try {
              cur.dc?.close();
            } catch {
              /* ignore */
            }
            try {
              cur.pc.close();
            } catch {
              /* ignore */
            }
          }
          sessions.delete(tabId);
          if (sessions.size === 0) {
            try {
              await chrome.offscreen.closeDocument();
            } catch {
              /* ignore */
            }
          }
          done({ ok: true });
          break;
        }

        case 'getState': {
          const cur = sessions.get(tabId);
          if (!cur) {
            done({ ok: true, hasPc: false });
            break;
          }
          const dcOpen = cur.dc?.readyState === 'open';
          done({
            ok: true,
            hasPc: true,
            waitingForAnswer: offererStillNeedsAnswer(cur),
            hasRemoteAnswer: Boolean(cur.pc.remoteDescription),
            dcOpen,
            connectionState: cur.pc.connectionState,
            iceConnectionState: cur.pc.iceConnectionState,
          });
          break;
        }

        case 'createOffer': {
          const iceServers = msg.iceServers as RTCIceServer[];
          if (!Array.isArray(iceServers) || iceServers.length === 0) {
            done({ ok: false, error: 'No ICE servers' });
            break;
          }

          const prev = sessions.get(tabId);
          if (prev) {
            try {
              prev.dc?.close();
            } catch {
              /* ignore */
            }
            try {
              prev.pc.close();
            } catch {
              /* ignore */
            }
            sessions.delete(tabId);
          }

          const log = (line: string) => broadcast('log', tabId, { line });
          const pc = new RTCPeerConnection({ iceServers });
          sessions.set(tabId, { pc, dc: null });

          pc.addEventListener('connectionstatechange', () => log(`[pcA] ${pc.connectionState}`));
          pc.addEventListener('iceconnectionstatechange', () => log(`[pcA] ice=${pc.iceConnectionState}`));
          pc.addEventListener('icecandidateerror', e => {
            log(`[pcA] icecandidateerror code=${e.errorCode} text=${e.errorText ?? ''}`);
          });

          const dc = pc.createDataChannel('bale-link');
          attachDc(tabId, dc);

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await waitForIceGathering(pc, log);

          const bundle = { sdp: pc.localDescription! };
          const offerB64 = b64encodeUtf8(JSON.stringify(bundle));
          done({
            ok: true,
            offerOut: offerB64,
            candidateCount: countCandidatesInSdp(pc.localDescription?.sdp),
          });
          break;
        }

        case 'applyAnswer': {
          const answer = msg.answer as RTCSessionDescriptionInit | undefined;
          if (!answer) {
            done({ ok: false, error: 'missing answer' });
            break;
          }
          const entry = sessions.get(tabId);
          if (!entry || !offererStillNeedsAnswer(entry)) {
            done({ ok: false, error: 'No local offer waiting for answer. Click “Create offer” again.' });
            break;
          }
          await entry.pc.setRemoteDescription(answer);
          done({ ok: true });
          break;
        }

        case 'sendDc': {
          const text = msg.text as string;
          const entry = sessions.get(tabId);
          if (!entry?.dc || entry.dc.readyState !== 'open') {
            done({ ok: false, error: 'Data channel not open' });
            break;
          }
          entry.dc.send(text);
          done({ ok: true });
          break;
        }

        default:
          done({ ok: false, error: 'unknown op' });
      }
    } catch (e) {
      done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();

  return true;
});
