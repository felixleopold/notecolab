import assert from 'node:assert/strict';
import test from 'node:test';
import { existingImportNotice } from '../src/share/duplicateImport.ts';

const mirror = {
  colab_share_id: 'room-1',
  colab_link_id: 'view-link',
  colab_access: 'read_only',
};

test('a second delivery through a different permission link explains what stayed', () => {
  assert.equal(
    existingImportNotice('Meeting notes — NoteColab · Ferdinand', mirror, {
      linkShareId: 'edit-link',
      accessMode: 'invited_edit',
    }),
    '"Meeting notes — NoteColab · Ferdinand" is already in your vault as view-only link'
      + ' and was opened unchanged. Delete it first to import the'
      + ' invited collaborators version.',
  );
});

test('re-importing the same link keeps the plain notice', () => {
  assert.equal(
    existingImportNotice('Meeting notes', mirror, {
      linkShareId: 'view-link',
      accessMode: 'read_only',
    }),
    'Opened existing note: Meeting notes',
  );
});

test('notes imported before links carried identity keep the plain notice', () => {
  assert.equal(
    existingImportNotice('Legacy note', { colab_share_id: 'room-1' }, {
      linkShareId: 'edit-link',
      accessMode: 'invited_edit',
    }),
    'Opened existing note: Legacy note',
  );
});
