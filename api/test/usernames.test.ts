import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername } from '../src/usernames.js';

test('usernames are trimmed, optional, and bounded', () => {
  assert.equal(normalizeUsername('  Ferdinand  '), 'Ferdinand');
  assert.equal(normalizeUsername(null), null);
  assert.equal(normalizeUsername('x'), undefined);
  assert.equal(normalizeUsername('x'.repeat(41)), undefined);
  assert.equal(normalizeUsername('valid\nname'), undefined);
  assert.equal(normalizeUsername(undefined), undefined);
});
