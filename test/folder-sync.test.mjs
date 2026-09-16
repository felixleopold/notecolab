import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./folder-test-loader.mjs', import.meta.url);

const { TFile, TFolder } = await import('obsidian');
const { FolderShareSync } = await import('../src/share/folderSync.ts');

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for folder sync')), 1_000);
    const poll = () => {
      if (predicate()) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(poll, 1);
      }
    };
    poll();
  });
}

test('stopped owner folder watches ignore vault changes and stay stopped across restart', async () => {
  const listeners = new Map();
  globalThis.window = {
    setTimeout,
    clearTimeout,
  };
  const app = {
    vault: {
      on(event, callback) {
        listeners.set(event, callback);
        return { event };
      },
      offref() {},
    },
  };
  const state = {
    version: 1,
    folderPath: 'Project',
    watching: false,
    folderName: 'Project',
    accessMode: 'read_only',
    entries: {},
  };
  let apiCalls = 0;
  const options = {
    getServerUrl: () => 'https://notes.example',
    getOwnerUid: () => 'owner',
    getStates: () => [state],
    saveState: async () => {},
    debounceMs: 0,
  };

  for (let restart = 0; restart < 2; restart++) {
    const sync = new FolderShareSync(app, () => { apiCalls++; return {}; }, options);
    sync.start();
    listeners.get('create')({ path: 'Project/New.md' });
    await new Promise(resolve => setTimeout(resolve, 10));
    sync.stop();
  }

  assert.equal(apiCalls, 0);
  assert.equal(state.watching, false);
});

test('stopping an in-flight watch preserves the paused state and withholds the index', async () => {
  const listeners = new Map();
  globalThis.window = { setTimeout, clearTimeout };
  const file = new TFile('Project/A.md');
  const folder = new TFolder('Project');
  const frontmatter = new Map();
  const app = {
    vault: {
      on(event, callback) { listeners.set(event, callback); return { event }; },
      offref() {},
      getMarkdownFiles: () => [file],
      getAbstractFileByPath: path => path === 'Project' ? folder : path === file.path ? file : null,
      read: async () => 'alpha',
      readBinary: async () => new ArrayBuffer(0),
    },
    metadataCache: {
      getFileCache: target => ({ frontmatter: frontmatter.get(target.path) }),
      getFirstLinkpathDest: () => null,
    },
    fileManager: {
      async processFrontMatter(target, mutate) {
        const value = { ...(frontmatter.get(target.path) || {}) };
        mutate(value);
        frontmatter.set(target.path, value);
      },
    },
  };
  const state = {
    version: 1,
    folderPath: 'Project',
    watching: true,
    serverUrl: 'https://notes.example',
    ownerUid: 'owner',
    folderName: 'Project',
    accessMode: 'read_only',
    entries: {},
  };
  let releaseShare;
  let shareCalls = 0;
  const api = {
    async shareNote() {
      shareCalls++;
      await new Promise(resolve => { releaseShare = resolve; });
      return { shareId: `share-${shareCalls}`, expiresAt: null };
    },
    async setRoomToken() { return true; },
    async uploadImage() { return true; },
  };
  let result;
  const sync = new FolderShareSync(app, () => api, {
    getServerUrl: () => 'https://notes.example',
    getOwnerUid: () => 'owner',
    getStates: () => [state],
    saveState: async saved => {
      const watching = state.watching;
      Object.assign(state, structuredClone(saved));
      state.watching = watching;
    },
    onResult: value => { result = value; },
    debounceMs: 0,
  });

  sync.start();
  listeners.get('modify')(file);
  await waitFor(() => !!releaseShare);
  state.watching = false;
  sync.setWatching('Project', false);
  releaseShare();
  await waitFor(() => !!result);

  assert.equal(result.cancelled, true);
  assert.equal(state.watching, false);
  assert.equal(shareCalls, 1, 'the encrypted folder index was not created');
  assert.ok(state.entries['A.md'], 'the completed child remains resumable');
  sync.stop();
});
