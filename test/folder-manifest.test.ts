import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFolderManifest, serializeFolderManifest } from '../src/share/folderManifest.ts';

test('folder index round-trips relative Markdown structure and sorts paths', () => {
  const serialized = serializeFolderManifest('Project', [
    { path: 'Research/Zeta.md', shareUrl: 'https://notes.example/s/z#key-z' },
    { path: 'Brief.md', shareUrl: 'https://notes.example/s/b#key-b' },
  ], '2026-09-16T10:00:00.000Z');

  const manifest = parseFolderManifest(serialized, 'https://notes.example');
  assert.equal(manifest.name, 'Project');
  assert.deepEqual(manifest.entries.map((entry) => entry.path), ['Brief.md', 'Research/Zeta.md']);
});

test('folder index rejects traversal, absolute paths, duplicates, and child links on another origin', () => {
  const base = {
    kind: 'notecolab-folder',
    version: 1,
    name: 'Project',
    publishedAt: '2026-09-16T10:00:00.000Z',
  };
  const parseEntries = (entries: unknown[]) => parseFolderManifest(
    JSON.stringify({ ...base, entries }),
    'https://notes.example',
  );

  assert.throws(() => parseEntries([{ path: '../secret.md', shareUrl: 'https://notes.example/s/a#key' }]));
  assert.throws(() => parseEntries([{ path: '/absolute.md', shareUrl: 'https://notes.example/s/a#key' }]));
  assert.throws(() => parseEntries([{ path: 'Safe.md', shareUrl: 'https://evil.example/s/a#key' }]));
  assert.throws(() => parseEntries([
    { path: 'Same.md', shareUrl: 'https://notes.example/s/a#key' },
    { path: 'Same.md', shareUrl: 'https://notes.example/s/b#key' },
  ]));
});

test('folder index requires complete keyed NoteColab share links', () => {
  const parseLink = (shareUrl: string) => parseFolderManifest(JSON.stringify({
    kind: 'notecolab-folder',
    version: 1,
    name: 'Project',
    publishedAt: '',
    entries: [{ path: 'Note.md', shareUrl }],
  }), 'https://notes.example');

  assert.throws(() => parseLink('https://notes.example/s/note'));
  assert.throws(() => parseLink('https://notes.example/not-a-share#key'));
  assert.doesNotThrow(() => parseLink('https://notes.example/s/note#key'));
});
