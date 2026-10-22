/**
 * The owner's switch of a note to encrypted live mode (docs/LIVE-E2E-ENCRYPTION.md §6.2,
 * steps 2–4). HTTP and the live doc are injected so the plugin and web share it.
 *
 * The marker, and a seed for a body-only note, are staged in a private doc and only
 * leave it as the format-2 checkpoint. The caller applies `update` to its live doc
 * only after it has left the plain room.
 */
import * as Y from 'yjs';
import { decrypt, encrypt } from '../crypto/crypto.ts';
import { decryptCrdt, encryptCrdt, hasHistory, seedClientId, seedUpdate } from './checkpoint.ts';
import { setLiveMarker, type LiveMode } from './mode.ts';

export interface EnableNote {
  liveMode?: LiveMode;
  contentVersion?: number;
  encryptedContent: string | null;
  encryptedCrdt?: string | null;
}

export interface LiveModeRequest {
  mode: 'e2e';
  encryptedContent: string;
  encryptedCrdt: string;
  crdtFormat: 2;
  baseVersion: number;
  seeded?: true;
}

/** No `status` (or a 5xx) means the response was lost: the switch may have committed. */
export type LiveModeResponse =
  | { ok: true; contentVersion: number }
  | { ok: false; status?: number; code?: string };

export interface EnableLiveE2EOptions {
  /** The owner's doc, synced with the plain room. Only server checkpoints are merged into it. */
  doc: Y.Doc;
  roomId: string;
  noteKey: string;
  getNote(): Promise<EnableNote | null>;
  putLiveMode(request: LiveModeRequest): Promise<LiveModeResponse>;
  /** After `live_room_not_empty`: wait for the room's history to reach `doc`; false to give up. */
  waitForRoom(): Promise<boolean>;
  attempts?: number;
}

export type EnableLiveE2EResult =
  | { status: 'enabled'; contentVersion: number; update: Uint8Array }
  | { status: 'already-e2e' }
  | { status: 'failed'; reason: 'offline' | 'uncertain' | 'damaged' | 'room-busy' | 'room-token' | 'quota' | 'forbidden' | 'conflict' };

export async function enableLiveE2E(options: EnableLiveE2EOptions): Promise<EnableLiveE2EResult> {
  const { doc, roomId, noteKey } = options;
  for (let attempt = 0; attempt < (options.attempts ?? 5); attempt++) {
    const note = await options.getNote();
    if (!note) return { status: 'failed', reason: 'offline' };
    if (note.liveMode === 'e2e') return { status: 'already-e2e' };
    const baseVersion = note.contentVersion || 1;

    // Step 2: an existing checkpoint is migrated, as #31 merges it, never reseeded.
    if (note.encryptedCrdt) {
      const restored = await decryptCrdt(note.encryptedCrdt, noteKey, roomId);
      if (!restored) return { status: 'failed', reason: 'damaged' };
      // The note is already encrypted, whatever the server reports; merging the
      // checkpoint would send its history to the plain room.
      if (restored.encrypted) return { status: 'already-e2e' };
      Y.applyUpdate(doc, restored.update);
    }
    // Step 3: stage privately. Only a note with no history at all is seeded.
    const staged = new Y.Doc();
    let request: LiveModeRequest;
    let update: Uint8Array;
    try {
      Y.applyUpdate(staged, Y.encodeStateAsUpdate(doc));
      let seeded = false;
      if (!hasHistory(staged)) {
        const body = note.encryptedContent ? await decrypt(note.encryptedContent, noteKey) : '';
        if (body) {
          Y.applyUpdate(staged, seedUpdate(await seedClientId(roomId, baseVersion, body), body));
          seeded = true;
        }
      }
      setLiveMarker(staged);
      update = Y.encodeStateAsUpdate(staged);
      request = {
        mode: 'e2e',
        encryptedContent: await encrypt(staged.getText('content').toString(), noteKey),
        encryptedCrdt: await encryptCrdt(update, noteKey, roomId, 2),
        crdtFormat: 2,
        baseVersion,
        ...(seeded ? { seeded: true as const } : {}),
      };
    } finally {
      staged.destroy();
    }

    // Step 4.
    const response = await options.putLiveMode(request);
    if (response.ok) return { status: 'enabled', contentVersion: response.contentVersion, update };
    if (response.status === 409) {
      if (response.code === 'snapshot_conflict') continue; // the re-read merges the newer checkpoint
      if (response.code === 'live_mode_already_e2e') return { status: 'already-e2e' };
      if (response.code === 'live_room_not_empty') {
        if (await options.waitForRoom()) continue;
        return { status: 'failed', reason: 'room-busy' };
      }
      if (response.code === 'room_token_required') return { status: 'failed', reason: 'room-token' };
      return { status: 'failed', reason: 'conflict' };
    }
    if (response.status === 413) return { status: 'failed', reason: 'quota' };
    if (response.status !== undefined && response.status < 500) return { status: 'failed', reason: 'forbidden' };

    // Lost response: `e2e` means a switch committed. It is ours only if the stored
    // checkpoint is the one we sent; otherwise another device won and our staged
    // seed must not be applied.
    const current = await options.getNote();
    if (!current) return { status: 'failed', reason: 'uncertain' };
    if (current.liveMode === 'e2e') {
      return current.encryptedCrdt === request.encryptedCrdt
        ? { status: 'enabled', contentVersion: current.contentVersion || baseVersion + 1, update }
        : { status: 'already-e2e' };
    }
    // As at the top of the loop: an encrypted checkpoint counts whatever the server reports.
    if (current.encryptedCrdt && (await decryptCrdt(current.encryptedCrdt, noteKey, roomId))?.encrypted) {
      return { status: 'already-e2e' };
    }
  }
  return { status: 'failed', reason: 'conflict' };
}
