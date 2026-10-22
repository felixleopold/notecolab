import * as Y from 'yjs';

/**
 * Whether history merged since `baseVector` started independently of it: it
 * adds a root item (no left or right origin) to a text that already had
 * history. Map entries such as the live-mode marker always look like roots,
 * so only text items count. Detection only informs the user; the merged
 * document is never rewritten, because Yjs keeps every character and any
 * rewrite risks deletion.
 */
export function mergedIndependentHistory(document: Y.Doc, baseVector: Uint8Array): boolean {
  if (Y.decodeStateVector(baseVector).size === 0) return false;
  return Y.decodeUpdate(Y.encodeStateAsUpdate(document, baseVector)).structs
    .some(struct => struct instanceof Y.Item && struct.parentSub === null && struct.origin === null && struct.rightOrigin === null);
}

/** Whether a server snapshot already holds exactly this document's history and body. */
export function documentMatchesSnapshot(document: Y.Doc, update: Uint8Array, body: string): boolean {
  if (document.getText('content').toString() !== body) return false;
  const snapshot = new Y.Doc();
  try {
    Y.applyUpdate(snapshot, update);
    const ours = Y.decodeStateVector(Y.encodeStateVector(document));
    const theirs = Y.decodeStateVector(Y.encodeStateVector(snapshot));
    return snapshot.getText('content').toString() === body
      && ours.size === theirs.size
      && [...ours].every(([client, clock]) => theirs.get(client) === clock);
  } finally {
    snapshot.destroy();
  }
}
