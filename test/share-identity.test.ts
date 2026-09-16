import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasMatchingEditableShareIdentity,
  hasMatchingShareIdentity,
} from '../src/session/shareIdentity.ts';

const frontmatter = (lines: string[]) => `---\n${lines.join('\n')}\n---\n`;

test('live share identity requires the matching ID, link, and editable access', () => {
  assert.equal(hasMatchingEditableShareIdentity(frontmatter([
    'colab_share_id: abc123',
    'colab_link: https://example.com/s/abc123#key',
    'colab_access: invited_edit',
  ]), 'abc123'), true);

  assert.equal(hasMatchingEditableShareIdentity(frontmatter([
    'colab_share_id: other',
    'colab_link: https://example.com/s/other#key',
    'colab_access: invited_edit',
  ]), 'abc123'), false);
});

test('removing tracking metadata or making a share read-only invalidates the session', () => {
  assert.equal(hasMatchingEditableShareIdentity('', 'abc123'), false);
  assert.equal(hasMatchingEditableShareIdentity(frontmatter([
    'colab_share_id: abc123',
    'colab_link: https://example.com/s/abc123',
    'colab_access: invited_edit',
  ]), 'abc123'), false);
  assert.equal(hasMatchingEditableShareIdentity(frontmatter([
    'colab_share_id: abc123',
    'colab_link: https://example.com/s/abc123#key',
    'colab_access: read_only',
  ]), 'abc123'), false);
});

test('the encryption identity may come from frontmatter or the share-link fragment', () => {
  assert.equal(hasMatchingEditableShareIdentity(frontmatter([
    'colab_share_id: abc123',
    'colab_link: https://example.com/s/abc123',
    'colab_encryption_key: key',
    'colab_access: public_edit',
  ]), 'abc123'), true);
  assert.equal(hasMatchingEditableShareIdentity(frontmatter([
    'colab_share_id: abc123',
    'colab_link: https://example.com/s/abc123',
    'colab_access: public_edit',
  ]), 'abc123'), false);
});

test('snapshot identity accepts read-only shares but rejects missing metadata', () => {
  assert.equal(hasMatchingShareIdentity(frontmatter([
    'colab_share_id: abc123',
    'colab_link: https://example.com/s/abc123#key',
    'colab_access: read_only',
  ]), 'abc123', ['read_only', 'public_edit', 'invited_edit']), true);
  assert.equal(
    hasMatchingShareIdentity('', 'abc123', ['read_only', 'public_edit', 'invited_edit']),
    false,
  );
});
