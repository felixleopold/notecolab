import nacl from 'tweetnacl';

export type PinnedPublicKeys = Record<string, string>;

function decodePublicKey(publicKey: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(publicKey);
  } catch {
    throw new Error('The server returned an invalid public identity key');
  }
  const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (decoded.length !== nacl.box.publicKeyLength) {
    throw new Error('The server returned an invalid public identity key');
  }
  return decoded;
}

function serverOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl.replace(/\/+$/, '');
  }
}

export function directoryIdentityId(serverUrl: string, uid: string): string {
  return `${serverOrigin(serverUrl)}|${uid}`;
}

export function parseDirectoryIdentityId(id: string): { server: string; uid: string } {
  const separator = id.lastIndexOf('|');
  return separator === -1
    ? { server: '', uid: id }
    : { server: id.slice(0, separator), uid: id.slice(separator + 1) };
}

export function publicKeyFingerprint(publicKey: string): string {
  const digest = nacl.hash(decodePublicKey(publicKey)).slice(0, 16);
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{1,4}/g)?.join(' ') || hex;
}

export class DirectoryKeyChangedError extends Error {
  readonly uid: string;
  readonly expectedFingerprint: string;
  readonly receivedFingerprint: string;

  constructor(
    uid: string,
    expectedFingerprint: string,
    receivedFingerprint: string,
  ) {
    super(`Safety stop: the identity key for ${uid} changed (${expectedFingerprint} → ${receivedFingerprint})`);
    this.name = 'DirectoryKeyChangedError';
    this.uid = uid;
    this.expectedFingerprint = expectedFingerprint;
    this.receivedFingerprint = receivedFingerprint;
  }
}

/**
 * Trust on first use for the server-provided identity directory. This detects
 * later key substitution but cannot authenticate the first lookup by itself.
 */
export function pinDirectoryPublicKey(
  pins: PinnedPublicKeys,
  serverUrl: string,
  uid: string,
  publicKey: string,
): 'pinned' | 'trusted' {
  // Validate even a previously pinned key before it reaches nacl.box.
  const receivedFingerprint = publicKeyFingerprint(publicKey);
  const id = directoryIdentityId(serverUrl, uid);
  const pinned = pins[id];
  if (!pinned) {
    pins[id] = publicKey;
    return 'pinned';
  }
  if (pinned !== publicKey) {
    throw new DirectoryKeyChangedError(
      uid,
      publicKeyFingerprint(pinned),
      receivedFingerprint,
    );
  }
  return 'trusted';
}
