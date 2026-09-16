import assert from 'node:assert/strict';
import test from 'node:test';
import {
  editableCopyBasename,
  isRecipientImport,
  isReadOnlyRecipient,
  recipientNoteTitle,
  stripColabMetadata,
} from '../src/share/readOnlyMirror.ts';

test('only recipient read-only imports are treated as mirrors', () => {
  assert.equal(isReadOnlyRecipient({
    colab_share_id: 'room-1',
    colab_access: 'read_only',
    colab_owner: false,
  }), true);
  assert.equal(isReadOnlyRecipient({
    colab_share_id: 'room-1',
    colab_access: 'read_only',
    colab_owner: true,
  }), false);
  assert.equal(isReadOnlyRecipient({
    colab_share_id: 'room-1',
    colab_access: 'public_edit',
    colab_owner: false,
  }), false);
});

test('recipient imports include both read-only and editable shares', () => {
  for (const access of ['read_only', 'public_edit', 'invited_edit']) {
    assert.equal(isRecipientImport({
      colab_share_id: 'room-1',
      colab_access: access,
      colab_owner: false,
    }), true);
  }
  assert.equal(isRecipientImport({
    colab_share_id: 'room-1',
    colab_access: 'read_only',
    colab_owner: true,
  }), false);
});

test('editable copies discard tracking fields and preserve ordinary frontmatter', () => {
  const content = [
    '---',
    'tags: [shared]',
    'colab_share_id: room-1',
    'colab_link_id: link-1',
    'colab_owner: false',
    '---',
    '# Body',
  ].join('\n');

  assert.equal(stripColabMetadata(content), [
    '---',
    'tags: [shared]',
    '---',
    '# Body',
  ].join('\n'));
});

test('editable copies remove an otherwise empty tracking frontmatter block', () => {
  assert.equal(stripColabMetadata([
    '---',
    'colab_share_id: room-1',
    'colab_owner: false',
    '---',
    '',
    '# Body',
  ].join('\n')), '\n# Body');
});

test('editable copy names remove the recipient marker', () => {
  assert.equal(
    editableCopyBasename('Meeting notes — NoteColab · Ferdinand'),
    'Meeting notes (local copy)',
  );
  assert.equal(
    recipientNoteTitle('Meeting notes — NoteColab · Ferdinand'),
    'Meeting notes',
  );
});
