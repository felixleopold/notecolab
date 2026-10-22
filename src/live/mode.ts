/**
 * Live-mode rule (docs/LIVE-E2E-ENCRYPTION.md §6.1). The server's `liveMode` alone
 * can't downgrade a note: the encrypted CRDT carries an `e2e` marker, and clients pin
 * rooms they have seen encrypted.
 */
import type * as Y from 'yjs';

export type LiveMode = 'plain' | 'e2e';

/** Join encrypted if the server says so; refuse if only the marker or pin does; else plain. */
export function resolveLiveMode(server: LiveMode | undefined, marker: LiveMode, pinned: boolean): LiveMode | 'refuse' {
  if (server === 'e2e') return 'e2e';
  return marker === 'e2e' || pinned ? 'refuse' : 'plain';
}

/** An absent or unknown marker counts as plain, for legacy notes. */
export function readLiveMarker(doc: Y.Doc): LiveMode {
  return doc.getMap('notecolab').get('liveMode') === 'e2e' ? 'e2e' : 'plain';
}

/** One-way (§6.3): there is no call to clear it. */
export function setLiveMarker(doc: Y.Doc) {
  doc.getMap('notecolab').set('liveMode', 'e2e');
}
