import assert from 'node:assert/strict';
import test from 'node:test';
import { isForeground, presenceLabel } from '../src/session/presence.ts';

test('presence labels explicitly include you only when the server lists you', () => {
  const self = { id: 'self', name: 'Felix', client: 'obsidian' as const };
  const peer = { id: 'peer', name: 'Guest', client: 'web' as const };
  assert.equal(presenceLabel(null), 'Connecting…');
  assert.equal(presenceLabel({ selfId: 'self', participants: [self] }), 'Only you here');
  assert.equal(presenceLabel({ selfId: 'self', participants: [self, peer] }), 'You + 1 other');
  assert.equal(presenceLabel({ selfId: 'self', participants: [peer] }), '1 person here');
  assert.equal(presenceLabel({ selfId: 'self', participants: [] }), 'No one here');
});

test('visible background Obsidian windows do not count as foreground', () => {
  assert.equal(isForeground({ visibilityState: 'visible', hasFocus: () => true }), true);
  assert.equal(isForeground({ visibilityState: 'visible', hasFocus: () => false }), false);
  assert.equal(isForeground({ visibilityState: 'hidden', hasFocus: () => true }), false);
});

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { NotePresence } from '../src/session/presence.ts';

test('only the connected relay can supply identities, and detach keeps background sync intact', () => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider('ws://localhost', 'test', doc, { connect: false, disableBc: true });
  const presence = new NotePresence(() => {});
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, JSON.stringify({
    selfId: 'self', participants: [{ id: 'self', name: 'Felix', client: 'obsidian' }],
  }));
  const deliver = (fromSocket: boolean) => provider.messageHandlers[4](
    encoding.createEncoder(), decoding.createDecoder(encoding.toUint8Array(encoder)), provider, fromSocket, 4,
  );
  try {
    presence.attach(provider);
    provider.wsconnected = true;
    deliver(false);
    assert.equal(presence.roster, null, 'ignore BroadcastChannel identity spoofing');
    provider.wsconnected = false;
    deliver(true);
    assert.equal(presence.roster, null, 'ignore stale disconnected transport');
    provider.wsconnected = true;
    deliver(true);
    assert.equal(presence.label, 'Only you here');
    presence.destroy();
    assert.equal(provider.wsconnected, true, 'presence never disconnects note synchronization');
    assert.equal(typeof provider.messageHandlers[4], 'function', 'late rosters are safely ignored');
    deliver(true);
    assert.equal(presence.roster, null);
  } finally {
    presence.destroy();
    provider.destroy();
    doc.destroy();
  }
});

test('read-only transport sends only presence, expires stale rosters, and stops retrying denied access', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  class Socket {
    static instances: Socket[] = [];
    readyState = 1;
    binaryType = '';
    closed = false;
    messages: Uint8Array[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    constructor() { Socket.instances.push(this); }
    send(message: Uint8Array) { this.messages.push(message); }
    close() { this.closed = true; this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const presence = new NotePresence(() => {});
  try {
    presence.setActive(true);
    presence.connect('ws://localhost/ws/yjs/test?presence=1');
    const socket = Socket.instances[0];
    socket.onopen?.();
    const sent = decoding.createDecoder(socket.messages[0]);
    assert.equal(decoding.readVarUint(sent), 4);
    assert.deepEqual(JSON.parse(decoding.readVarString(sent)), { active: true, client: 'obsidian' });
    const roster = encoding.createEncoder();
    encoding.writeVarUint(roster, 4);
    encoding.writeVarString(roster, JSON.stringify({ selfId: 'self', participants: [] }));
    const frame = encoding.toUint8Array(roster);
    socket.onmessage?.({ data: frame.slice().buffer });
    assert.equal(presence.label, 'No one here');
    t.mock.timers.tick(80_000);
    assert.equal(presence.roster, null);
    assert.equal(socket.closed, true);
    t.mock.timers.tick(5000);
    assert.equal(Socket.instances.length, 2);
    const replacement = Socket.instances[1];
    replacement.onclose?.({ code: 1008 });
    t.mock.timers.tick(20_000);
    assert.equal(Socket.instances.length, 2, 'denied access must not trigger another connection');
    presence.destroy();
    t.mock.timers.tick(20_000);
    assert.equal(Socket.instances.length, 2, 'unload must not reconnect');
  } finally {
    presence.destroy();
    globalThis.WebSocket = original;
    t.mock.timers.reset();
  }
});
