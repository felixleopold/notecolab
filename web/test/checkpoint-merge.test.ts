import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import {
  initializeCollaborationDocument,
  mergeDeviceCheckpoint,
  refreshReadOnlySnapshot,
  seedServerSnapshot,
} from '../app/utils/checkpointMerge.ts';

test('independent device and server checkpoints do not duplicate text with an empty relay', () => {
  const server = new Y.Doc();
  const device = new Y.Doc();
  try {
    server.getText('content').insert(0, 'hello');
    device.getText('content').insert(0, 'hello');
    mergeDeviceCheckpoint(server, Y.encodeStateAsUpdate(device));
    assert.equal(server.getText('content').toString(), 'hello');
    device.getText('content').insert(5, ' offline');
    mergeDeviceCheckpoint(server, Y.encodeStateAsUpdate(device));
    assert.equal(server.getText('content').toString(), 'hello offline\n\n<<<<<<< NoteColab recovered server snapshot\nhello\n>>>>>>>');
  } finally { server.destroy(); device.destroy(); }
});

test('checkpoints with shared history retain concurrent changes', () => {
  const server = new Y.Doc();
  const device = new Y.Doc();
  try {
    server.getText('content').insert(0, 'hello');
    Y.applyUpdate(device, Y.encodeStateAsUpdate(server));
    server.getText('content').insert(0, 'remote ');
    device.getText('content').insert(5, ' offline');
    mergeDeviceCheckpoint(server, Y.encodeStateAsUpdate(device));
    assert.equal(server.getText('content').toString(), 'remote hello offline');
  } finally { server.destroy(); device.destroy(); }
});


test('simultaneous first-load peers seed one baseline and retain independent edits', async () => {
  const left = new Y.Doc();
  const right = new Y.Doc();
  try {
    await Promise.all([seedServerSnapshot(left, 'hello', 'room', 1), seedServerSnapshot(right, 'hello', 'room', 1)]);
    left.getText('content').insert(0, 'left ');
    right.getText('content').insert(5, ' right');
    const leftUpdate = Y.encodeStateAsUpdate(left);
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, leftUpdate);
    assert.equal(left.getText('content').toString(), 'left hello right');
    assert.equal(right.getText('content').toString(), 'left hello right');
  } finally { left.destroy(); right.destroy(); }
});

test('read-only initialization ignores a stale editable device checkpoint', async () => {
  const server = new Y.Doc();
  const staleDevice = new Y.Doc();
  const reader = new Y.Doc();
  try {
    server.getText('content').insert(0, 'owner update');
    staleDevice.getText('content').insert(0, 'stale reader copy');

    await initializeCollaborationDocument(reader, {
      body: 'owner update',
      roomId: 'room',
      version: 2,
      serverUpdate: Y.encodeStateAsUpdate(server),
      deviceUpdate: Y.encodeStateAsUpdate(staleDevice),
      editable: false,
    });

    assert.equal(reader.getText('content').toString(), 'owner update');
    assert.deepEqual(
      [...Y.decodeStateVector(Y.encodeStateVector(reader)).keys()],
      [...Y.decodeStateVector(Y.encodeStateVector(server)).keys()],
    );
  } finally { server.destroy(); staleDevice.destroy(); reader.destroy(); }
});

test('malformed editable device checkpoint does not abort initialization', async () => {
  const document = new Y.Doc();
  try {
    const result = await initializeCollaborationDocument(document, {
      body: 'server body',
      roomId: 'room',
      version: 1,
      deviceUpdate: new Uint8Array([255]),
      editable: true,
    });

    assert.equal(document.getText('content').toString(), 'server body');
    assert.equal(result.invalidDeviceCheckpoint, true);
  } finally { document.destroy(); }
});

test('read-only refresh replaces stale text without producing a relay update', async () => {
  const reader = new Y.Doc();
  const providerOrigin = {};
  const relayedUpdates: Uint8Array[] = [];
  try {
    await seedServerSnapshot(reader, 'old snapshot', 'room', 1);
    reader.on('update', (update, origin) => {
      if (origin !== providerOrigin) relayedUpdates.push(update);
    });

    refreshReadOnlySnapshot(reader, 'new owner snapshot', null, providerOrigin);

    assert.equal(reader.getText('content').toString(), 'new owner snapshot');
    assert.equal(relayedUpdates.length, 0);
  } finally { reader.destroy(); }
});

test('read-only refresh accepts a newer compatible encrypted CRDT snapshot', async () => {
  const owner = new Y.Doc();
  const reader = new Y.Doc();
  const providerOrigin = {};
  const relayedUpdates: Uint8Array[] = [];
  try {
    await seedServerSnapshot(owner, 'shared', 'room', 1);
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(owner));
    owner.getText('content').insert(6, ' update');
    reader.on('update', (update, origin) => {
      if (origin !== providerOrigin) relayedUpdates.push(update);
    });

    refreshReadOnlySnapshot(reader, 'shared update', Y.encodeStateAsUpdate(owner), providerOrigin);

    assert.equal(reader.getText('content').toString(), 'shared update');
    assert.equal(relayedUpdates.length, 0);
  } finally { owner.destroy(); reader.destroy(); }
});

test('read-only refresh preserves live edits newer than a compatible REST snapshot', async () => {
  const owner = new Y.Doc();
  const reader = new Y.Doc();
  const peer = new Y.Doc();
  try {
    await seedServerSnapshot(owner, 'shared', 'room', 1);
    owner.getText('content').insert(6, ' saved');
    const restSnapshot = Y.encodeStateAsUpdate(owner);
    Y.applyUpdate(reader, restSnapshot);
    Y.applyUpdate(peer, restSnapshot);

    peer.getText('content').insert(peer.getText('content').length, ' live');
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(peer));
    refreshReadOnlySnapshot(reader, 'shared saved', restSnapshot, {});

    assert.equal(reader.getText('content').toString(), 'shared saved live');
  } finally { owner.destroy(); reader.destroy(); peer.destroy(); }
});
