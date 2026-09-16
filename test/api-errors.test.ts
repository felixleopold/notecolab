import assert from 'node:assert/strict';
import test from 'node:test';
import { requestErrorMessage, requestErrorStatus } from '../src/api/errors.ts';

test('extracts server errors from failed Obsidian requests', () => {
  const error = {
    status: 429,
    json: { error: 'Too many registrations — try again later' },
  };

  assert.equal(requestErrorStatus(error), 429);
  assert.equal(requestErrorMessage(error), 'Too many registrations — try again later');
});

test('ignores malformed request errors', () => {
  assert.equal(requestErrorStatus({ status: '429' }), undefined);
  assert.equal(requestErrorMessage({ json: { error: 429 } }), undefined);
  assert.equal(requestErrorMessage(null), undefined);
});
