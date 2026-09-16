import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./session-test-loader.mjs', import.meta.url);

const { TFile } = await import('obsidian');
const { getShareSync, publishSnapshot, startShareSync, stopShareSync } = await import('../src/session/sessions.ts');
const { decrypt, encrypt } = await import('../src/crypto/crypto.ts');
const Y = await import('yjs');

const providerSymbol = Symbol.for('notecolab.test.websocketProvider');
const initialYTextSymbol = Symbol.for('notecolab.test.initialYText');

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for session event')), 1_000);
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

function updateBase64(doc) {
  let binary = '';
  for (const byte of Y.encodeStateAsUpdate(doc)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function referenceSeedServerSnapshot(document, body, roomId, version) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(['notecolab-seed-v1', roomId, version, body]),
  )));
  const seedId = bytes.slice(0, 6).reduce((value, byte) => value * 256 + byte, 0);
  const seed = new Y.Doc();
  seed.clientID = seedId;
  seed.getText('content').insert(0, body);
  Y.applyUpdate(document, Y.encodeStateAsUpdate(seed));
  seed.destroy();
  return seedId;
}

async function startIndependentCheckpointFixture({
  roomId,
  serverBody,
  deviceBody,
  vaultBody,
  baselineBody = deviceBody,
  serverHasCrdt = true,
}) {
  globalThis.window = globalThis;
  const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const serverDoc = new Y.Doc();
  serverDoc.getText('content').insert(0, serverBody);
  const deviceDoc = new Y.Doc();
  deviceDoc.getText('content').insert(0, deviceBody);
  const baselineDoc = new Y.Doc();
  baselineDoc.getText('content').insert(0, baselineBody);
  const checkpoint = JSON.stringify({
    version: 2,
    document: updateBase64(deviceDoc),
    vaultBaseline: updateBase64(baselineDoc),
  });
  const storage = new Map([[
    `notecolab:crdt:v1:https://example.com:${roomId}`,
    await encrypt(checkpoint, key),
  ]]);
  globalThis.localStorage = {
    getItem: storageKey => storage.get(storageKey) ?? null,
    setItem: (storageKey, value) => storage.set(storageKey, value),
  };
  const encryptedContent = await encrypt(serverBody, key);
  const encryptedCrdt = serverHasCrdt ? await encrypt(updateBase64(serverDoc), key) : null;
  const api = {
    usesAccountCredentials: false,
    withWriteCapability() { return this; },
    async getNoteContent() { return { encryptedContent, encryptedCrdt, contentVersion: 1 }; },
    async updateSnapshot() { return { ok: true, contentVersion: 2 }; },
    async listImages() { return []; },
  };
  const frontmatter = `---\ncolab_share_id: ${roomId}\ncolab_link: https://example.com/s/${roomId}#${key}\ncolab_access: public_edit\n---\n`;
  const file = new TFile(`${roomId}.md`);
  let content = frontmatter + vaultBody;
  const app = {
    vault: {
      async read() { return content; },
      async modify(_file, value) { content = value; },
      on() { return {}; },
      offref() {},
    },
    metadataCache: { getFirstLinkpathDest: () => null },
  };

  await startShareSync(app, { serverUrl: 'https://example.com', apiKey: '' }, file, roomId, api, key);
  return {
    app,
    file,
    body: getShareSync(file.path)?.doc.getText('content').toString() ?? '',
    destroy() {
      stopShareSync(app, file.path);
      serverDoc.destroy();
      deviceDoc.destroy();
      baselineDoc.destroy();
    },
  };
}

async function createSession(roomId, initialBody, initialYText) {
  globalThis.window = globalThis;
  globalThis[initialYTextSymbol] = initialYText;
  const frontmatter = [
    '---',
    `colab_share_id: ${roomId}`,
    `colab_link: https://example.com/s/${roomId}#secret`,
    'colab_access: public_edit',
    '---',
    '',
  ].join('\n');
  const file = new TFile(`${roomId}.md`);
  let content = frontmatter + initialBody;
  let modifyListener;
  const pendingWrites = [];
  const vault = {
    async read() {
      return content;
    },
    modify(_file, value) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      pendingWrites.push({
        commit() {
          content = value;
          void modifyListener?.(file);
        },
        resolve,
      });
      return promise;
    },
    on(event, listener) {
      assert.equal(event, 'modify');
      modifyListener = listener;
      return { event };
    },
    offref() {},
  };
  const app = {
    vault,
    metadataCache: { getFirstLinkpathDest: () => null },
  };

  await startShareSync(app, { serverUrl: 'https://example.com', apiKey: '' }, file, roomId);
  const provider = globalThis[providerSymbol];
  const ytext = provider.doc.getText('content');
  return {
    app,
    file,
    frontmatter,
    pendingWrites,
    provider,
    ytext,
    content: () => content,
    notify: () => modifyListener(file),
    editBody(body) {
      content = frontmatter + body;
      return modifyListener(file);
    },
  };
}

test('first reliable join preserves both an offline vault edit and the server snapshot', async () => {
  globalThis.window = globalThis;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const roomId = 'room-offline-first-join';
  const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const serverDoc = new Y.Doc();
  serverDoc.getText('content').insert(0, 'server version');
  const update = Y.encodeStateAsUpdate(serverDoc);
  let binary = '';
  for (const byte of update) binary += String.fromCharCode(byte);
  const encryptedCrdt = await encrypt(btoa(binary), key);
  const encryptedContent = await encrypt('server version', key);

  const api = {
    usesAccountCredentials: false,
    withWriteCapability() { return this; },
    async getNoteContent() {
      return { encryptedContent, encryptedCrdt, contentVersion: 1 };
    },
    async updateSnapshot() { return { ok: true, contentVersion: 2 }; },
    async listImages() { return []; },
  };
  const frontmatter = [
    '---',
    `colab_share_id: ${roomId}`,
    `colab_link: https://example.com/s/${roomId}#${key}`,
    'colab_access: public_edit',
    '---',
    '',
  ].join('\n');
  const file = new TFile(`${roomId}.md`);
  let content = frontmatter + 'offline vault edit';
  let modifyListener;
  const app = {
    vault: {
      async read() { return content; },
      async modify(_file, value) { content = value; },
      on(_event, listener) { modifyListener = listener; return {}; },
      offref() {},
    },
    metadataCache: { getFirstLinkpathDest: () => null },
  };

  await startShareSync(
    app,
    { serverUrl: 'https://example.com', apiKey: '' },
    file,
    roomId,
    api,
    key,
  );
  const state = getShareSync(file.path);
  assert.ok(state);
  const merged = state.doc.getText('content').toString();
  assert.match(merged, /offline vault edit/);
  assert.match(merged, /server version/);

  stopShareSync(app, file.path);
  serverDoc.destroy();
  void modifyListener;
});

test('persisted CRDT does not duplicate against an independently seeded legacy live room', async () => {
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const roomId = 'room-legacy-live';
  const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const serverDoc = new Y.Doc();
  serverDoc.getText('content').insert(0, 'same body');
  let binary = '';
  for (const byte of Y.encodeStateAsUpdate(serverDoc)) binary += String.fromCharCode(byte);
  const api = {
    usesAccountCredentials: false,
    withWriteCapability() { return this; },
    async getNoteContent() {
      return {
        encryptedContent: await encrypt('same body', key),
        encryptedCrdt: await encrypt(btoa(binary), key),
        contentVersion: 1,
      };
    },
    async updateSnapshot() { return { ok: true, contentVersion: 2 }; },
    async listImages() { return []; },
  };
  const frontmatter = `---\ncolab_share_id: ${roomId}\ncolab_link: https://example.com/s/${roomId}#${key}\ncolab_access: public_edit\n---\n`;
  const file = new TFile(`${roomId}.md`);
  let content = frontmatter + 'same body';
  const app = {
    vault: {
      async read() { return content; },
      async modify(_file, value) { content = value; },
      on() { return {}; },
      offref() {},
    },
    metadataCache: { getFirstLinkpathDest: () => null },
  };
  globalThis[initialYTextSymbol] = 'same body';
  await startShareSync(app, { serverUrl: 'https://example.com', apiKey: '' }, file, roomId, api, key);
  const provider = globalThis[providerSymbol];
  try {
    assert.equal(provider.doc.getText('content').toString(), 'same bodysame body');
    await provider.emit('sync', true);
    assert.equal(provider.doc.getText('content').toString(), 'same body');
  } finally {
    stopShareSync(app, file.path);
    serverDoc.destroy();
  }
});

test('independent identical server and device checkpoints adopt one canonical body before an empty relay', async () => {
  const fixture = await startIndependentCheckpointFixture({
    roomId: 'room-independent-identical',
    serverBody: 'hello',
    deviceBody: 'hello',
    vaultBody: 'hello',
  });
  try {
    assert.equal(fixture.body, 'hello');
  } finally {
    fixture.destroy();
  }
});

test('plugin body-only bootstrap matches the web seed and concurrent first edits keep one baseline', async () => {
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const roomId = 'room-cross-client-first-load';
  const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const body = 'hello';
  const version = 7;
  const api = {
    usesAccountCredentials: false,
    withWriteCapability() { return this; },
    async getNoteContent() {
      return {
        encryptedContent: await encrypt(body, key),
        encryptedCrdt: null,
        contentVersion: version,
      };
    },
    async updateSnapshot() { return { ok: true, contentVersion: version + 1 }; },
    async listImages() { return []; },
  };
  const frontmatter = `---\ncolab_share_id: ${roomId}\ncolab_link: https://example.com/s/${roomId}#${key}\ncolab_access: public_edit\n---\n`;
  const file = new TFile(`${roomId}.md`);
  let content = frontmatter + body;
  const app = {
    vault: {
      async read() { return content; },
      async modify(_file, value) { content = value; },
      on() { return {}; },
      offref() {},
    },
    metadataCache: { getFirstLinkpathDest: () => null },
  };

  await startShareSync(app, { serverUrl: 'https://example.com', apiKey: '' }, file, roomId, api, key);
  const pluginDoc = getShareSync(file.path).doc;
  const webDoc = new Y.Doc();
  const seedId = await referenceSeedServerSnapshot(webDoc, body, roomId, version);
  try {
    assert.deepEqual(Y.encodeStateAsUpdate(pluginDoc), Y.encodeStateAsUpdate(webDoc));
    assert.notEqual(pluginDoc.clientID, seedId);

    pluginDoc.getText('content').insert(5, ' plugin');
    webDoc.getText('content').insert(5, ' web');
    Y.applyUpdate(pluginDoc, Y.encodeStateAsUpdate(webDoc));
    Y.applyUpdate(webDoc, Y.encodeStateAsUpdate(pluginDoc));
    const merged = pluginDoc.getText('content').toString();
    assert.equal(merged.match(/hello/g)?.length, 1);
    assert.match(merged, /plugin/);
    assert.match(merged, /web/);
    assert.equal(webDoc.getText('content').toString(), merged);
    const clients = Y.decodeStateVector(Y.encodeStateVector(pluginDoc));
    assert.ok(clients.has(seedId));
    assert.ok(clients.has(pluginDoc.clientID));
  } finally {
    stopShareSync(app, file.path);
    webDoc.destroy();
  }
});

test('independent differing checkpoints preserve server, device, and offline vault edits', async () => {
  const fixture = await startIndependentCheckpointFixture({
    roomId: 'room-independent-different',
    serverBody: 'server version',
    deviceBody: 'device version',
    baselineBody: 'device version',
    vaultBody: 'device version with offline edit',
  });
  try {
    assert.match(fixture.body, /device version/);
    assert.match(fixture.body, /offline edit/);
    assert.match(fixture.body, /NoteColab recovered server snapshot/);
    assert.match(fixture.body, /server version/);
    assert.equal(fixture.body.match(/device version/g)?.length, 1);
    assert.equal(fixture.body.match(/server version/g)?.length, 1);
  } finally {
    fixture.destroy();
  }
});

test('body-only server snapshots with cleared CRDT do not blindly restore an obsolete independent checkpoint', async () => {
  const fixture = await startIndependentCheckpointFixture({
    roomId: 'room-body-only-cleared-crdt',
    serverBody: 'fresh body-only version',
    deviceBody: 'obsolete device version',
    vaultBody: 'fresh body-only version',
    serverHasCrdt: false,
  });
  try {
    assert.match(fixture.body, /obsolete device version/);
    assert.match(fixture.body, /NoteColab recovered server snapshot/);
    assert.match(fixture.body, /fresh body-only version/);
    assert.equal(fixture.body.match(/obsolete device version/g)?.length, 1);
    assert.equal(fixture.body.match(/fresh body-only version/g)?.length, 1);
  } finally {
    fixture.destroy();
  }
});

test('checkpoint keeps pending remote text separate from the acknowledged vault baseline across restart', async () => {
  globalThis.window = globalThis;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const roomId = 'room-pending-vault-checkpoint';
  const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const checkpointKey = `notecolab:crdt:v1:https://example.com:${roomId}`;
  const serverDoc = new Y.Doc();
  serverDoc.getText('content').insert(0, 'hello');
  const encryptedCrdt = await encrypt(updateBase64(serverDoc), key);
  const encryptedContent = await encrypt('hello', key);
  const api = {
    usesAccountCredentials: false,
    withWriteCapability() { return this; },
    async getNoteContent() {
      return { encryptedContent, encryptedCrdt, contentVersion: 1 };
    },
    async updateSnapshot() { return { ok: true, contentVersion: 2 }; },
    async listImages() { return []; },
  };
  const frontmatter = `---\ncolab_share_id: ${roomId}\ncolab_link: https://example.com/s/${roomId}#${key}\ncolab_access: public_edit\n---\n`;
  const file = new TFile(`${roomId}.md`);
  let content = frontmatter + 'hello';
  let modifyListener;
  const pendingWrites = [];
  const app = {
    vault: {
      async read() { return content; },
      modify(_file, value) {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        pendingWrites.push({ value, resolve });
        return promise;
      },
      on(_event, listener) { modifyListener = listener; return {}; },
      offref() {},
    },
    metadataCache: { getFirstLinkpathDest: () => null },
  };

  await startShareSync(app, { serverUrl: 'https://example.com', apiKey: '' }, file, roomId, api, key);
  let provider = globalThis[providerSymbol];
  await provider.emit('sync', true);
  provider.doc.getText('content').insert(5, ' remote');

  await waitFor(() => storage.has(checkpointKey));
  await waitFor(() => pendingWrites.length === 1);
  const stored = JSON.parse(await decrypt(storage.get(checkpointKey), key));
  const storedDoc = new Y.Doc();
  const storedBaseline = new Y.Doc();
  Y.applyUpdate(storedDoc, Uint8Array.from(atob(stored.document), char => char.charCodeAt(0)));
  Y.applyUpdate(storedBaseline, Uint8Array.from(atob(stored.vaultBaseline), char => char.charCodeAt(0)));
  assert.equal(storedDoc.getText('content').toString(), 'hello remote');
  assert.equal(storedBaseline.getText('content').toString(), 'hello');

  // Simulate exit before the delayed mirror write resolves, followed by an
  // offline edit to the still-older vault file.
  stopShareSync(app, file.path);
  await new Promise(resolve => setTimeout(resolve, 20));
  const stoppedCheckpoint = JSON.parse(await decrypt(storage.get(checkpointKey), key));
  assert.equal(stoppedCheckpoint.version, 2);
  assert.equal(stoppedCheckpoint.pendingVault.body, 'hello remote');
  content = frontmatter + 'hello local';

  await startShareSync(app, { serverUrl: 'https://example.com', apiKey: '' }, file, roomId, api, key);
  provider = globalThis[providerSymbol];
  const restored = provider.doc.getText('content').toString();
  assert.match(restored, /remote/);
  assert.match(restored, /local/);
  assert.equal(restored.match(/remote/g)?.length, 1);
  assert.equal(restored.match(/local/g)?.length, 1);

  stopShareSync(app, file.path);
  storedDoc.destroy();
  storedBaseline.destroy();
  serverDoc.destroy();
  void modifyListener;
});

test('legacy raw v1 local checkpoints remain readable', async () => {
  globalThis.window = globalThis;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const roomId = 'room-legacy-local-checkpoint';
  const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const legacyDoc = new Y.Doc();
  legacyDoc.getText('content').insert(0, 'legacy body');
  storage.set(
    `notecolab:crdt:v1:https://example.com:${roomId}`,
    await encrypt(updateBase64(legacyDoc), key),
  );
  const encryptedCrdt = await encrypt(updateBase64(legacyDoc), key);
  const encryptedContent = await encrypt('legacy body', key);
  const api = {
    usesAccountCredentials: false,
    withWriteCapability() { return this; },
    async getNoteContent() { return { encryptedContent, encryptedCrdt, contentVersion: 1 }; },
    async updateSnapshot() { return { ok: true, contentVersion: 2 }; },
    async listImages() { return []; },
  };
  const frontmatter = `---\ncolab_share_id: ${roomId}\ncolab_link: https://example.com/s/${roomId}#${key}\ncolab_access: public_edit\n---\n`;
  const file = new TFile(`${roomId}.md`);
  let content = frontmatter + 'legacy body';
  const app = {
    vault: {
      async read() { return content; },
      async modify(_file, value) { content = value; },
      on() { return {}; },
      offref() {},
    },
    metadataCache: { getFirstLinkpathDest: () => null },
  };

  await startShareSync(app, { serverUrl: 'https://example.com', apiKey: '' }, file, roomId, api, key);
  assert.equal(getShareSync(file.path)?.doc.getText('content').toString(), 'legacy body');
  stopShareSync(app, file.path);
  legacyDoc.destroy();
});

test('manual snapshot mode is enforced inside the publisher', async () => {
  globalThis.window = globalThis;
  const file = new TFile('manual-snapshot.md');
  let requests = 0;
  const app = {
    vault: { async read() { return '---\ncolab_share_id: manual\ncolab_access: read_only\ncolab_update_mode: snapshot\n---\nbody'; } },
  };
  const api = { async getNoteContent() { requests++; throw new Error('must not publish'); } };
  publishSnapshot(app, api, file, 'manual', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 0);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requests, 0);
});

test('revoked snapshot writes stop instead of entering the retry loop', async () => {
  globalThis.window = globalThis;
  const file = new TFile('revoked-snapshot.md');
  let requests = 0;
  const app = {
    vault: { async read() { return '---\ncolab_share_id: revoked\ncolab_link: https://example.com/s/revoked#key\ncolab_access: read_only\n---\nbody'; } },
    metadataCache: { getFirstLinkpathDest: () => null },
  };
  const api = {
    async getNoteContent() { return { contentVersion: 1, encryptedCrdt: null }; },
    async updateSnapshot() { requests++; return { ok: false, status: 403 }; },
  };
  publishSnapshot(app, api, file, 'revoked', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 0);
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.equal(requests, 1);
});

test('a stale vault write cannot echo back and delete newer remote typing', async () => {
  const session = await createSession('room-queued', 'hello');
  const { app, file, frontmatter, pendingWrites, provider, ytext } = session;
  ytext.insert(0, 'hello');
  await provider.emit('sync', true);

  ytext.insert(ytext.length, 'A');
  await waitFor(() => pendingWrites.length === 1);
  ytext.insert(ytext.length, 'B');
  await new Promise(resolve => setTimeout(resolve, 60));

  ytext.insert(ytext.length, 'C');

  pendingWrites[0].commit();
  pendingWrites[0].resolve();
  await waitFor(() => pendingWrites.length === 2);

  pendingWrites[1].commit();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(ytext.toString(), 'helloABC');
  assert.equal(session.content(), frontmatter + 'helloABC');

  pendingWrites[1].resolve();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(session.content(), frontmatter + 'helloABC');

  stopShareSync(app, file.path);
  assert.equal(getShareSync(file.path), undefined);
});

test('a notification after a completed mirror write cannot delete newer typing', async () => {
  const session = await createSession('room-late-event', 'hello');
  const { app, file, pendingWrites, provider, ytext } = session;
  try {
    ytext.insert(0, 'hello');
    await provider.emit('sync', true);
    ytext.insert(ytext.length, 'A');
    await waitFor(() => pendingWrites.length === 1);
    pendingWrites[0].commit();
    pendingWrites[0].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));

    ytext.insert(ytext.length, 'B');
    await session.notify();
    assert.equal(ytext.toString(), 'helloAB');
  } finally {
    stopShareSync(app, file.path);
  }
});

test('a local file edit preserves remote typing absent from its saved baseline', async () => {
  const session = await createSession('room-concurrent-file', 'hello');
  const { app, file, provider, ytext } = session;
  try {
    ytext.insert(0, 'hello');
    await provider.emit('sync', true);
    ytext.insert(ytext.length, ' remote');
    await session.editBody('local hello');
    assert.equal(ytext.toString(), 'local hello remote');
  } finally {
    stopShareSync(app, file.path);
  }
});

test('relative cursor positions survive remote edits while the vault mirror is delayed', async () => {
  const session = await createSession('room-relative-cursor', 'hello');
  const { app, file, pendingWrites, provider, ytext } = session;
  try {
    ytext.insert(0, 'hello');
    await provider.emit('sync', true);
    const cursor = Y.createRelativePositionFromTypeIndex(ytext, 5);

    ytext.insert(0, 'X');
    await waitFor(() => pendingWrites.length === 1);
    const resolved = Y.createAbsolutePositionFromRelativePosition(cursor, provider.doc);
    assert.equal(resolved?.type, ytext);
    assert.equal(resolved?.index, 6);

    pendingWrites[0].commit();
    pendingWrites[0].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(session.content(), /Xhello$/);
  } finally {
    stopShareSync(app, file.path);
  }
});

test('initial sync cannot finish after and overwrite queued remote typing', async () => {
  const session = await createSession('room-initial', 'local', 'server');
  const { app, file, frontmatter, pendingWrites, provider, ytext } = session;
  const initialSync = provider.emit('sync', true);
  await waitFor(() => pendingWrites.length === 1);

  ytext.insert(ytext.length, 'A');
  await new Promise(resolve => setTimeout(resolve, 60));
  ytext.insert(ytext.length, 'B');

  pendingWrites[0].commit();
  pendingWrites[0].resolve();
  await waitFor(() => pendingWrites.length === 2);

  pendingWrites[1].commit();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ytext.toString(), 'serverAB');
  assert.equal(session.content(), frontmatter + 'serverAB');

  pendingWrites[1].resolve();
  await initialSync;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(session.content(), frontmatter + 'serverAB');

  stopShareSync(app, file.path);
});
