/**
 * Client-side AES-256-GCM encryption/decryption using Web Crypto API.
 * Encryption key is 256-bit random, encoded as URL-safe base64 in the URL fragment.
 * The server never sees the key.
 */

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits for AES-GCM

/** Generate a new random 256-bit encryption key, returned as URL-safe base64 */
export async function generateKey(): Promise<string> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return uint8ArrayToBase64Url(key);
}

/** Encrypt plaintext with a base64url-encoded key. Returns base64-encoded ciphertext (iv + encrypted data). */
export async function encrypt(plaintext: string, keyBase64Url: string): Promise<string> {
  const keyBytes = base64UrlToUint8Array(keyBase64Url);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: ALGORITHM }, false, ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    cryptoKey,
    encoded
  );

  // Prepend IV to ciphertext
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return uint8ArrayToBase64(combined);
}

/** Decrypt base64-encoded ciphertext (iv + encrypted data) with a base64url-encoded key. */
export async function decrypt(ciphertextBase64: string, keyBase64Url: string): Promise<string> {
  const keyBytes = base64UrlToUint8Array(keyBase64Url);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: ALGORITHM }, false, ['decrypt']
  );

  const combined = base64ToUint8Array(ciphertextBase64);
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    cryptoKey,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

/** Decrypt base64-encoded ciphertext back to raw ArrayBuffer (for binary data like images). */
export async function decryptBinary(ciphertextBase64: string, keyBase64Url: string): Promise<ArrayBuffer> {
  const keyBytes = base64UrlToUint8Array(keyBase64Url);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: ALGORITHM }, false, ['decrypt']
  );

  const combined = base64ToUint8Array(ciphertextBase64);
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  return crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    cryptoKey,
    ciphertext
  );
}

/** Encrypt raw binary data (ArrayBuffer) with a base64url-encoded key. Returns base64-encoded ciphertext (iv + encrypted data). */
export async function encryptBinary(data: ArrayBuffer, keyBase64Url: string): Promise<string> {
  const keyBytes = base64UrlToUint8Array(keyBase64Url);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: ALGORITHM }, false, ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    cryptoKey,
    data
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return uint8ArrayToBase64(combined);
}

export async function deriveRoomToken(noteKeyBase64Url: string, roomId: string): Promise<string> {
  return deriveNoteCapability(noteKeyBase64Url, `yjs-room-token:v1:${roomId}`);
}

/** Domain-separated proof that possession of the note key authorizes REST writes. */
export async function deriveWriteCapability(noteKeyBase64Url: string, roomId: string): Promise<string> {
  return deriveNoteCapability(noteKeyBase64Url, `rest-write-token:v1:${roomId}`);
}

async function deriveNoteCapability(noteKeyBase64Url: string, info: string): Promise<string> {
  const ikm = base64UrlToUint8Array(noteKeyBase64Url);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', ikm, 'HKDF', false, ['deriveBits']
  );
  const encoder = new TextEncoder();
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('notecolab'),
      info: encoder.encode(info),
    },
    keyMaterial,
    256
  );
  return uint8ArrayToBase64Url(new Uint8Array(bits));
}

// --- Base64 utilities ---

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  return uint8ArrayToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return base64ToUint8Array(base64);
}

/**
 * Derive a 256-bit vault key from a password and salt using PBKDF2.
 * Must produce identical output to the plugin's deriveVaultKey.
 */
export async function deriveVaultKey(password: string, saltBase64: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const salt = base64ToUint8Array(saltBase64);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return uint8ArrayToBase64Url(new Uint8Array(bits));
}

/**
 * Decrypt a vault-encrypted note key using the vault key.
 */
export async function decryptVaultKey(encryptedKey: string, vaultKey: string): Promise<string> {
  return decrypt(encryptedKey, vaultKey);
}
