import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { mergeDeviceCheckpoint, seedServerSnapshot } from '../app/utils/checkpointMerge.ts';

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
