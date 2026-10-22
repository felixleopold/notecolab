/**
 * Keys for end-to-end encrypted live collaboration (docs/LIVE-E2E-ENCRYPTION.md §3).
 * Same derivation family as the room token and REST write token in crypto.ts:
 * HKDF-SHA256, salt "notecolab", info "<purpose>:v1:<roomId>".
 */
import { base64UrlToUint8Array } from '../crypto/crypto.ts';

const IV_LENGTH = 12;
const encoder = new TextEncoder();

/** HKDF key that can only derive per-sender frame keys; it never encrypts directly. */
export async function deriveLiveKey(noteKey: string, roomId: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', base64UrlToUint8Array(noteKey), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('notecolab'),
      info: encoder.encode(`yjs-live-key:v1:${roomId}`),
    },
    ikm,
    256
  );
  return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
}

/** Per-connection AES-256-GCM key, so the random-IV limit applies per sender instead of per note. */
export function deriveFrameKey(liveKey: CryptoKey, sender: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: sender, info: encoder.encode('yjs-live-frame:v1') },
    liveKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function checkpointAad(roomId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`notecolab-crdt:v2:${roomId}`);
}

async function noteAesKey(noteKey: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64UrlToUint8Array(noteKey), 'AES-GCM', false, [usage]);
}

/** Checkpoint format 2: `iv ‖ ciphertext`, bound to the room so it cannot move between notes. */
export async function encryptCheckpoint(
  data: Uint8Array<ArrayBuffer>,
  noteKey: string,
  roomId: string,
  iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await noteAesKey(noteKey, 'encrypt');
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: checkpointAad(roomId) }, key, data);
  const combined = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), IV_LENGTH);
  return combined;
}

/** Rejects (fails closed) on a wrong key, a wrong room, or any modified byte. */
export async function decryptCheckpoint(
  combined: Uint8Array<ArrayBuffer>,
  noteKey: string,
  roomId: string
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await noteAesKey(noteKey, 'decrypt');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: combined.subarray(0, IV_LENGTH), additionalData: checkpointAad(roomId) },
    key,
    combined.subarray(IV_LENGTH)
  );
  return new Uint8Array(decrypted);
}

/**
 * A local ID for a note's encryption pin (§6.1). Derived from the note key, which the
 * server never sees, so a server-reported room or link can't steer around the pin.
 */
export async function livePinId(noteKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`notecolab-live-pin-v1\n${noteKey}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
