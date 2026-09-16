import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./folder-test-loader.mjs', import.meta.url);
const { TFile } = await import('obsidian');
const { shareNote } = await import('../src/share/shareNote.ts');

test('clipboard failure preserves a created share without waiting for the metadata cache', async () => {
  const frontmatter = {};
  let creates = 0;
  const app = {
    vault: { read: async () => 'A note' },
    fileManager: { processFrontMatter: async (_file, mutate) => mutate(frontmatter) },
  };
  const api = {
    shareNote: async () => { creates++; return { shareId: 'created-note', expiresAt: null }; },
    setRoomToken: async () => true,
  };
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error('Clipboard denied'); } } },
  });
  try {
    const result = await shareNote(app, api, { serverUrl: 'https://notes.example' }, new TFile('Note.md'), { accessMode: 'read_only' });
    assert.equal(creates, 1);
    assert.equal(result.shareId, 'created-note');
    assert.equal(result.shareUrl, frontmatter.colab_link);
    assert.equal(frontmatter.colab_owner, true);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});
