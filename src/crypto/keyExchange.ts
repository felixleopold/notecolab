/**
 * X25519 key exchange using tweetnacl (nacl.box).
 * Used to encrypt AES-256 note keys so only the intended recipient can decrypt.
 */
import nacl from 'tweetnacl';

/** Generate a new X25519 keypair. Returns base64-encoded strings. */
export function generateKeyPair(): { publicKey: string; secretKey: string } {
  const kp = nacl.box.keyPair();
  return {
    publicKey: uint8ToBase64(kp.publicKey),
    secretKey: uint8ToBase64(kp.secretKey),
  };
}

/**
 * Encrypt a note's AES key for a specific recipient.
 * Uses nacl.box (X25519 + XSalsa20-Poly1305).
 */
export function encryptKeyForRecipient(
  noteKey: string, // base64url-encoded AES key
  recipientPublicKey: string, // base64
  senderSecretKey: string // base64
): { encryptedKey: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const message = new TextEncoder().encode(noteKey);
  const encrypted = nacl.box(
    message,
    nonce,
    base64ToUint8(recipientPublicKey),
    base64ToUint8(senderSecretKey)
  );
  return {
    encryptedKey: uint8ToBase64(encrypted),
    nonce: uint8ToBase64(nonce),
  };
}

/**
 * Decrypt a note's AES key that was encrypted for us.
 * Returns the original base64url-encoded AES key string.
 */
export function decryptKeyFromSender(
  encryptedKey: string, // base64
  nonce: string, // base64
  senderPublicKey: string, // base64
  recipientSecretKey: string // base64
): string | null {
  const decrypted = nacl.box.open(
    base64ToUint8(encryptedKey),
    base64ToUint8(nonce),
    base64ToUint8(senderPublicKey),
    base64ToUint8(recipientSecretKey)
  );
  if (!decrypted) return null;
  return new TextDecoder().decode(decrypted);
}

// --- Base64 helpers ---

function uint8ToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i);
  }
  return arr;
}
