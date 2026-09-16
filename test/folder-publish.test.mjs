import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./folder-test-loader.mjs', import.meta.url);

const { TFile, TFolder } = await import('obsidian');
const { decrypt, encrypt } = await import('../src/crypto/crypto.ts');
const { parseFolderManifest } = await import('../src/share/folderManifest.ts');
const { publishFolder } = await import('../src/share/folderShare.ts');

function fixture(contents) {
  const files = Object.keys(contents).map(path => new TFile(path));
  const cache = new Map();
  const folder = new TFolder('Project');
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: path => path === 'Project' ? folder : files.find(file => file.path === path) || null,
      read: async file => contents[file.path],
      readBinary: async () => new ArrayBuffer(0),
    },
    metadataCache: {
      getFileCache: file => ({ frontmatter: cache.get(file.path) }),
      getFirstLinkpathDest: () => null,
    },
    fileManager: {
      async processFrontMatter(file, mutate) {
        const value = { ...(cache.get(file.path) || {}) };
        mutate(value);
        cache.set(file.path, value);
      },
    },
  };
  return { app, cache, files };
}

function apiFixture({ failShareNumber } = {}) {
  let shares = 0;
  const created = [];
  const updates = [];
  const linkUpdates = [];
  return {
    created,
    updates,
    linkUpdates,
    api: {
      async shareNote(data) {
        shares++;
        if (shares === failShareNumber) throw new Error('simulated upload failure');
        const result = { id: `share-${shares}`, data };
        created.push(result);
        return { shareId: result.id, expiresAt: null };
      },
      async updateLink(shareId, data) { linkUpdates.push({ shareId, data }); return true; },
      async setRoomToken() { return true; },
      async uploadImage() { return true; },
      async updateNote(shareId, data) { updates.push({ shareId, data }); return true; },
      async getNoteContent() { return null; },
    },
  };
}

test('partial folder publication persists completed notes and withholds the index until retry succeeds', async () => {
  const { app } = fixture({ 'Project/A.md': 'alpha', 'Project/B.md': 'bravo' });
  const firstApi = apiFixture({ failShareNumber: 2 });
  let persisted;
  const first = await publishFolder(app, firstApi.api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'read_only',
    saveState: async state => { persisted = structuredClone(state); },
  });

  assert.equal(first.failed.length, 1);
  assert.equal(first.shareUrl, undefined);
  assert.equal(firstApi.created.length, 1);
  assert.ok(persisted.entries['A.md']);
  assert.equal(persisted.manifest, undefined);

  const retryApi = apiFixture();
  const retry = await publishFolder(app, retryApi.api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'read_only',
    previousState: persisted,
  });

  assert.equal(retry.failed.length, 0);
  assert.equal(retryApi.created.length, 2, 'only the failed child and encrypted index are created');
  const encryptedIndex = retryApi.created.at(-1).data.encryptedContent;
  const plaintextIndex = await decrypt(encryptedIndex, retry.state.manifest.encryptionKey);
  const manifest = parseFolderManifest(plaintextIndex, 'https://notes.example');
  assert.deepEqual(manifest.entries.map(entry => entry.path), ['A.md', 'B.md']);
  assert.ok(!encryptedIndex.includes('#'), 'child keys are not visible in the server-side ciphertext');
});

test('folder access transitions update child permissions without creating replacement shares', async () => {
  const contents = { 'Project/Access.md': 'same body' };
  const { app } = fixture(contents);
  const initial = await publishFolder(app, apiFixture().api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'read_only',
  });
  const transitionedApi = apiFixture();
  const transitioned = await publishFolder(app, transitionedApi.api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'public_edit',
    previousState: initial.state,
  });

  assert.equal(transitioned.failed.length, 0);
  assert.equal(transitioned.created, 0);
  assert.equal(transitioned.state.entries['Access.md'].accessMode, 'public_edit');
  assert.deepEqual(transitionedApi.linkUpdates, [{
    shareId: initial.state.entries['Access.md'].linkShareId,
    data: { accessMode: 'public_edit' },
  }]);
});

test('adopted notes update the permission link without replacing their canonical room ID', async () => {
  const contents = { 'Project/Access.md': 'same body' };
  const { app, cache } = fixture(contents);
  const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  cache.set('Project/Access.md', {
    colab_share_id: 'canonical-room',
    colab_link_id: 'editable-link',
    colab_link: `https://notes.example/s/editable-link#${key}`,
    colab_access: 'public_edit',
    colab_encryption_key: key,
    colab_owner: true,
  });
  const api = apiFixture();
  api.api.getNoteContent = async shareId => {
    assert.equal(shareId, 'canonical-room');
    return { encryptedContent: await encrypt('same body', key) };
  };

  const result = await publishFolder(app, api.api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'read_only',
    canPublishEditable: () => true,
  });

  assert.equal(result.failed.length, 0);
  assert.deepEqual(api.linkUpdates, [{ shareId: 'editable-link', data: { accessMode: 'read_only' } }]);
  assert.equal(api.updates[0].shareId, 'canonical-room');
  assert.equal(result.state.entries['Access.md'].roomId, 'canonical-room');
  assert.equal(result.state.entries['Access.md'].linkShareId, 'editable-link');
  assert.equal(cache.get('Project/Access.md').colab_link_id, 'editable-link');
});

test('cancellation after a child operation persists the child but never publishes the folder index', async () => {
  const { app } = fixture({ 'Project/A.md': 'alpha' });
  const api = apiFixture();
  let running = true;
  let persisted;
  api.api.setRoomToken = async () => {
    running = false;
    return true;
  };

  const result = await publishFolder(app, api.api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'read_only',
    shouldContinue: () => running,
    saveState: async state => { persisted = structuredClone(state); },
  });

  assert.equal(result.cancelled, true);
  assert.equal(api.created.length, 1, 'only the child note was created');
  assert.ok(persisted.entries['A.md'], 'created identity remains resumable');
  assert.equal(persisted.manifest, undefined);
});

test('editable child changes cannot be published by folder reconciliation without normal live sync', async () => {
  const contents = { 'Project/Edit.md': 'initial' };
  const { app } = fixture(contents);
  const initialApi = apiFixture();
  const initial = await publishFolder(app, initialApi.api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'public_edit',
  });
  assert.equal(initial.failed.length, 0);

  contents['Project/Edit.md'] = 'stale local replacement';
  const retryApi = apiFixture();
  const retry = await publishFolder(app, retryApi.api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'public_edit',
    previousState: initial.state,
    canPublishEditable: () => false,
  });

  assert.equal(retry.failed.length, 1);
  assert.match(retry.failed[0].message, /wait for NoteColab sync/);
  assert.equal(retryApi.updates.length, 0, 'folder reconciliation never PATCHes the stale body or index');
  assert.equal(retry.shareUrl, undefined);
});

test('connected editable children still wait for the per-note snapshot before the folder index advances', async () => {
  const contents = { 'Project/Edit.md': 'initial' };
  const { app } = fixture(contents);
  const initial = await publishFolder(app, apiFixture().api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'public_edit',
  });
  contents['Project/Edit.md'] = 'local after remote edits';
  const retryApi = apiFixture();
  const key = initial.state.entries['Edit.md'].encryptionKey;
  retryApi.api.getNoteContent = async () => ({
    encryptedContent: await encrypt('server is still different', key),
  });

  const retry = await publishFolder(app, retryApi.api, {
    folderPath: 'Project',
    serverUrl: 'https://notes.example',
    accessMode: 'public_edit',
    previousState: initial.state,
    canPublishEditable: () => true,
  });

  assert.equal(retry.failed.length, 1);
  assert.match(retry.failed[0].message, /normal per-note sync/);
  assert.equal(retryApi.updates.length, 0);
  assert.equal(retry.shareUrl, undefined);
});
