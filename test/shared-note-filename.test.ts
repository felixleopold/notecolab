import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sanitizeFilename,
  sharedNoteBasename,
  withFilenameCounter,
} from '../src/share/sharedNoteFilename.ts';

test('recipient filenames retain the title and identify the owner', () => {
  assert.equal(
    sharedNoteBasename('Meeting notes', 'Ferdinand'),
    'Meeting notes — NoteColab · Ferdinand',
  );
  assert.equal(
    sharedNoteBasename('Meeting notes', 'aabbccdd'),
    'Meeting notes — NoteColab · aabbccdd',
  );
  assert.equal(sharedNoteBasename('Meeting notes'), 'Meeting notes — NoteColab');
});

test('recipient filenames sanitize untrusted titles and contact labels', () => {
  assert.equal(sanitizeFilename('../../Meeting: notes'), 'Meeting notes');
  assert.equal(
    sharedNoteBasename('../../Meeting: notes', 'Work/Ferdinand?'),
    'Meeting notes — NoteColab · Work Ferdinand',
  );
});

test('recipient filenames preserve their marker and length through collisions', () => {
  const basename = sharedNoteBasename('A'.repeat(300), 'Ferdinand');
  const collision = withFilenameCounter(basename, 123);
  const byteLength = (value: string) => new TextEncoder().encode(value).length;

  assert.ok(byteLength(basename) <= 240);
  assert.ok(byteLength(collision) <= 240);
  assert.match(basename, / — NoteColab · Ferdinand$/);
  assert.match(collision, / \(123\) — NoteColab · Ferdinand$/);
});

test('recipient filenames truncate Unicode only at code-point boundaries', () => {
  const basename = sharedNoteBasename('Meeting', '😀'.repeat(200));
  const bytes = new TextEncoder().encode(basename).length;

  assert.ok(bytes <= 240);
  assert.equal(/\p{Surrogate}/u.test(basename), false);
});

test('collision counters stay within budget with a maximal owner label', () => {
  const basename = sharedNoteBasename('T', 'x'.repeat(400));
  const collision = withFilenameCounter(basename, 1);

  assert.ok(new TextEncoder().encode(collision).length <= 240);
  assert.match(collision, /^T \(1\) — NoteColab/);
});

test('a multibyte title survives a maximal owner label', () => {
  const basename = sharedNoteBasename('😀 title', 'x'.repeat(400));

  assert.ok(new TextEncoder().encode(basename).length <= 240);
  assert.match(basename, /^😀 — NoteColab/);
});
