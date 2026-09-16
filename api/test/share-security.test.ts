import assert from 'node:assert/strict';
import test from 'node:test';
import { generateShareId, hashApiKey, verifyApiKey } from '../src/utils.ts';

test('new share IDs carry 128 bits and remain URL-safe', () => {
  const ids = new Set(Array.from({ length: 100 }, generateShareId));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test('stored write capabilities accept only the original token', () => {
  const token = 'write-capability-token';
  const storedHash = hashApiKey(token);
  assert.equal(verifyApiKey(token, storedHash), true);
  assert.equal(verifyApiKey('wrong-capability-token', storedHash), false);
});
