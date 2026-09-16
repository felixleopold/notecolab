import assert from 'node:assert/strict';
import test from 'node:test';
import { inviteShareIds } from '../src/routes/notes.js';

test('an invite resolves to the exact link it was created against', () => {
  assert.deepEqual(
    inviteShareIds({ link_share_id: 'view-link', note_share_id: 'room-1' }),
    { shareId: 'view-link', noteShareId: 'view-link' },
  );
});

test('invites created before links carried identity fall back to the note room', () => {
  assert.deepEqual(
    inviteShareIds({ link_share_id: null, note_share_id: 'room-1' }),
    { shareId: 'room-1', noteShareId: 'room-1' },
  );
});

test('the deprecated noteShareId alias is still sent for pre-1.26 clients', () => {
  const response = inviteShareIds({ link_share_id: 'edit-link', note_share_id: 'room-1' });
  assert.equal(response.noteShareId, response.shareId);
});
