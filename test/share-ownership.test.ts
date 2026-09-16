import assert from 'node:assert/strict';
import test from 'node:test';
import { mayPublishAsOwner, shareOwnership } from '../src/share/shareOwnership.ts';

test('ownership is only known when the marker was written', () => {
  assert.equal(shareOwnership({ colab_owner: true }), 'owner');
  assert.equal(shareOwnership({ colab_owner: false }), 'recipient');
  // Notes shared or imported before plugin 1.24.2 carry no marker at all.
  assert.equal(shareOwnership({ colab_share_id: 'room-1' }), 'unknown');
  assert.equal(shareOwnership(undefined), 'unknown');
});

test('legacy notes keep publishing while recipient mirrors never do', () => {
  assert.equal(mayPublishAsOwner({ colab_owner: true }), true);
  assert.equal(mayPublishAsOwner({ colab_share_id: 'room-1' }), true);
  assert.equal(mayPublishAsOwner({ colab_owner: false }), false);
});
