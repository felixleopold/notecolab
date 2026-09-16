import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import {
  DirectoryKeyChangedError,
  directoryIdentityId,
  pinDirectoryPublicKey,
  publicKeyFingerprint,
} from '../src/crypto/identityTrust.ts';

function publicKey(): string {
  return Buffer.from(nacl.box.keyPair().publicKey).toString('base64');
}

test('directory keys are pinned per server origin and UID', () => {
  const pins: Record<string, string> = {};
  const key = publicKey();

  assert.equal(pinDirectoryPublicKey(pins, 'https://notes.example/path', 'alice', key), 'pinned');
  assert.equal(pinDirectoryPublicKey(pins, 'https://notes.example/', 'alice', key), 'trusted');
  assert.equal(pins[directoryIdentityId('https://notes.example', 'alice')], key);
});

test('a changed directory key fails closed with comparable fingerprints', () => {
  const pins: Record<string, string> = {};
  const first = publicKey();
  const replacement = publicKey();
  pinDirectoryPublicKey(pins, 'https://notes.example', 'alice', first);

  assert.throws(
    () => pinDirectoryPublicKey(pins, 'https://notes.example', 'alice', replacement),
    (error) => error instanceof DirectoryKeyChangedError
      && error.expectedFingerprint === publicKeyFingerprint(first)
      && error.receivedFingerprint === publicKeyFingerprint(replacement),
  );
});

test('malformed directory keys are rejected before pinning', () => {
  const pins: Record<string, string> = {};
  assert.throws(
    () => pinDirectoryPublicKey(pins, 'https://notes.example', 'alice', 'not-a-key'),
    /invalid public identity key/,
  );
  assert.deepEqual(pins, {});
});
