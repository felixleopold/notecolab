import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export function generateUid(): string {
  return randomBytes(16).toString('hex');
}

export function generateApiKey(): string {
  return randomBytes(32).toString('base64url');
}

export function generateShareId(): string {
  return randomBytes(16).toString('hex'); // 128 bits, 32 hex chars
}

export function generateRoomId(): string {
  return randomBytes(8).toString('hex'); // 16 hex chars
}

// Invite tokens are bearer secrets reachable by any unauthenticated caller, so
// they get full key-grade entropy rather than the 32 bits a share id carries.
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url'); // 256 bits, 43 URL-safe chars
}

/** Constant-time equality for two secret strings of unknown length. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export function verifyApiKey(apiKey: string, hash: string): boolean {
  const computed = hashApiKey(apiKey);
  // Constant-time comparison
  if (computed.length !== hash.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return result === 0;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}
