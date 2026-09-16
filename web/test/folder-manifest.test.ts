import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFolderManifest } from '../app/utils/folderManifest.ts';

test('ordinary Markdown and JSON notes are not treated as folder manifests', () => {
  for (const content of ['# Hello', 'null', '42', '[]', '{}', '"hello"']) {
    assert.equal(parseFolderManifest(content, 'https://notes.example'), null);
  }
});

test('folder reader rejects same-looking cross-origin child links and duplicate paths', () => {
  const manifest = { kind: 'notecolab-folder', version: 1, name: 'Project', entries: [
    { path: 'A.md', shareUrl: 'https://notes.example/s/id#key' },
  ] };
  assert.equal(parseFolderManifest(JSON.stringify(manifest), 'https://notes.example')?.entries.length, 1);
  assert.throws(() => parseFolderManifest(JSON.stringify(manifest), 'https://other.example'), /Unsafe/);
  manifest.entries.push(manifest.entries[0]!);
  assert.throws(() => parseFolderManifest(JSON.stringify(manifest), 'https://notes.example'), /Duplicate/);
});
