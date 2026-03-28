/** UI + logs for Peer Link, keyed by browser tab (same keys as background). */

export type PeerLinkStoredUi = {
  /** Which handshake UX panel was last open. */
  uiRole?: 'offer' | 'receive';
  offerOut?: string;
  offerIn?: string;
  answerOut?: string;
  answerIn?: string;
  logs?: string[];
};

export function peerLinkUiKey(tabId: number): string {
  return `peerLink_ui_${tabId}`;
}

export async function loadPeerLinkUi(tabId: number): Promise<PeerLinkStoredUi> {
  const key = peerLinkUiKey(tabId);
  const r = await chrome.storage.local.get(key);
  const v = r[key] as PeerLinkStoredUi | undefined;
  return v && typeof v === 'object' ? v : {};
}

/** Merge into chrome.storage.local from the popup or background; await so data survives popup close. */
export async function mergePeerLinkUi(tabId: number, patch: Partial<PeerLinkStoredUi>): Promise<PeerLinkStoredUi> {
  const cur = await loadPeerLinkUi(tabId);
  const next: PeerLinkStoredUi = { ...cur, ...patch };
  if (next.logs && next.logs.length > 120) next.logs = next.logs.slice(-120);
  await chrome.storage.local.set({ [peerLinkUiKey(tabId)]: next });
  return next;
}
