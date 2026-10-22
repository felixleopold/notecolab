/**
 * The REST CRDT checkpoint in both formats, and #31's deterministic seed.
 * Format 1 (#31): the base64 update encrypted as text, without associated data.
 * Format 2 (docs/LIVE-E2E-ENCRYPTION.md §3): the raw update, bound to the room by AAD.
 * Both travel as base64 in `encryptedCrdt`.
 */
import * as Y from 'yjs';
import { decrypt, encrypt } from '../crypto/crypto.ts';
import { decryptCheckpoint, encryptCheckpoint } from './keys.ts';
import { readLiveMarker } from './mode.ts';

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encryptCrdt(update: Uint8Array, noteKey: string, roomId: string, format: 1 | 2): Promise<string> {
  return format === 2
    ? bytesToBase64(await encryptCheckpoint(new Uint8Array(update), noteKey, roomId))
    : encrypt(bytesToBase64(update), noteKey);
}

/**
 * Either format; null when neither decrypts (wrong key, wrong room or damaged).
 * `encrypted`: the checkpoint is room-bound or carries the marker, so the note is in
 * encrypted live mode whatever the server reports (§6.1). Its history must never
 * reach a doc synced with the plain room.
 */
export async function decryptCrdt(
  encryptedCrdt: string,
  noteKey: string,
  roomId: string,
): Promise<{ update: Uint8Array; format: 1 | 2; encrypted: boolean } | null> {
  try {
    return { update: await decryptCheckpoint(base64ToBytes(encryptedCrdt), noteKey, roomId), format: 2, encrypted: true };
  } catch {
    // Not format 2; try #31's format.
  }
  try {
    const update = base64ToBytes(await decrypt(encryptedCrdt, noteKey));
    return { update, format: 1, encrypted: carriesLiveMarker(update) };
  } catch {
    return null;
  }
}

/** Whether `update` sets the `e2e` marker, read in a private doc. Malformed updates count as unmarked. */
export function carriesLiveMarker(update: Uint8Array): boolean {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return readLiveMarker(doc) === 'e2e';
  } catch {
    return false;
  } finally {
    doc.destroy();
  }
}

export function hasHistory(doc: Y.Doc): boolean {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).size > 0;
}

/** #31's seed ID: peers seeding the same body at the same version get identical Yjs items. */
export async function seedClientId(roomId: string, version: number, body: string): Promise<number> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(['notecolab-seed-v1', roomId, version, body]),
  )));
  return bytes.slice(0, 6).reduce((value, byte) => value * 256 + byte, 0);
}

export function seedUpdate(clientId: number, body: string): Uint8Array {
  const seed = new Y.Doc();
  try {
    seed.clientID = clientId;
    seed.getText('content').insert(0, body);
    return Y.encodeStateAsUpdate(seed);
  } finally {
    seed.destroy();
  }
}
