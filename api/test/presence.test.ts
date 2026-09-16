import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';

process.env.DATABASE_PATH = ':memory:';
const { getDb } = await import('../src/db/schema.js');
const { setupYjsWebSocket, rooms } = await import('../src/ws/yjs-relay.js');
const { hashApiKey } = await import('../src/utils.js');
type Roster = { selfId: string; participants: { id: string; name: string; client: string }[] };
function send(ws: WebSocket, value: unknown) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 4);
  encoding.writeVarString(encoder, JSON.stringify(value));
  ws.send(encoding.toUint8Array(encoder));
}
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for presence');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
test('presence binds room identities, deduplicates foreground leases, and protects presence-only readers', async t => {
  const db = getDb();
  db.prepare('INSERT INTO users (uid, api_key_hash, display_name) VALUES (?, ?, ?)')
    .run('private-owner-uid', hashApiKey('owner-key'), 'Agent Test 2026-09-16 presence');
  const owner = db.prepare('SELECT id FROM users WHERE uid = ?').get('private-owner-uid') as { id: number };
  for (const room of ['presence-room', 'other-room']) {
    db.prepare('INSERT INTO notes (user_id, share_id, room_token_hash) VALUES (?, ?, ?)').run(owner.id, room, hashApiKey('room-secret'));
    const note = db.prepare('SELECT id FROM notes WHERE share_id = ?').get(room) as { id: number };
    db.prepare('INSERT INTO share_links (note_id, share_id, access_mode) VALUES (?, ?, ?)').run(note.id, `${room}-link`, 'read_only');
  }
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  setupYjsWebSocket(wss);
  await once(wss, 'listening');
  const address = wss.address();
  assert.ok(address && typeof address !== 'string');
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    db.close();
  });
  async function connect(query: string, room = 'presence-room') {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/yjs/${room}?${query}`);
    sockets.push(ws);
    const state = { ws, roster: null as Roster | null, types: [] as number[] };
    ws.on('message', data => {
      const decoder = decoding.createDecoder(new Uint8Array(data as Buffer));
      const type = decoding.readVarUint(decoder);
      state.types.push(type);
      if (type === 4) state.roster = JSON.parse(decoding.readVarString(decoder)) as Roster;
    });
    await once(ws, 'open');
    return state;
  }
  const denied = await connect('link=presence-room-link&rt=wrong&presence=1');
  assert.equal((await once(denied.ws, 'close'))[0], 1008);
  const ownerTab = await connect('token=owner-key');
  const duplicate = await connect('token=owner-key&presence=1');
  const guest = await connect('link=presence-room-link&rt=room-secret&presence=1');
  const legacy = await connect('token=owner-key');
  send(ownerTab.ws, { active: true, client: 'web' });
  send(duplicate.ws, { active: true, client: 'obsidian' });
  send(guest.ws, { active: true, client: 'web' });
  await until(() => guest.roster?.participants.length === 2 && duplicate.roster?.participants.length === 2);
  assert.equal(ownerTab.roster?.selfId, duplicate.roster?.selfId);
  assert.ok(!JSON.stringify(guest.roster).includes('private-owner-uid'));
  assert.deepEqual(guest.roster?.participants.map(p => p.name).sort(), ['Agent Test 2026-09-16 presence', 'Guest']);
  assert.ok(guest.types.every(type => type === 4));
  assert.ok(duplicate.types.every(type => type === 4));
  assert.ok(!legacy.types.includes(4));
  send(ownerTab.ws, { active: false, client: 'web' });
  send(duplicate.ws, { active: false, client: 'obsidian' });
  await until(() => guest.roster?.participants.length === 1);
  send(ownerTab.ws, { active: true, client: 'web' });
  await until(() => guest.roster?.participants.length === 2);
  for (const conn of rooms.get('presence-room')!.connections) {
    if (conn.participantId === ownerTab.roster!.selfId && conn.presence) conn.presence.updatedAt -= 61_000;
  }
  send(guest.ws, { active: true, client: 'web' });
  await until(() => guest.roster?.participants.length === 1);
  const other = await connect('token=owner-key&presence=1', 'other-room');
  send(other.ws, { active: true, client: 'web' });
  await until(() => other.roster !== null);
  assert.notEqual(other.roster?.selfId, ownerTab.roster?.selfId);
  const spoofClosed = once(duplicate.ws, 'close');
  send(duplicate.ws, { active: true, client: 'obsidian', name: 'Someone else' });
  assert.equal((await spoofClosed)[0], 1008);
  db.prepare('DELETE FROM share_links WHERE share_id = ?').run('presence-room-link');
  const revoked = once(guest.ws, 'close');
  send(guest.ws, { active: true, client: 'web' });
  assert.equal((await revoked)[0], 1008);
  send(ownerTab.ws, { active: true, client: 'web' });
  await until(() => ownerTab.roster?.participants.length === 1);
  const watcher = await connect('token=owner-key&presence=1');
  const forbiddenDoc = new Y.Doc();
  forbiddenDoc.getText('content').insert(0, 'must not reach the relay');
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, 0);
  syncProtocol.writeUpdate(update, Y.encodeStateAsUpdate(forbiddenDoc));
  watcher.ws.send(encoding.toUint8Array(update));
  send(watcher.ws, { active: false, client: 'web' });
  await until(() => watcher.roster?.participants.length === 1);
  assert.equal(rooms.get('presence-room')!.doc.getText('content').toString(), '');
  forbiddenDoc.destroy();
  db.prepare('UPDATE users SET display_name = NULL WHERE id = ?').run(owner.id);
  send(watcher.ws, { active: false, client: 'web' });
  await until(() => watcher.roster?.participants[0]?.name === 'Participant');
  ownerTab.ws.close();
  await until(() => watcher.roster?.participants.length === 0);
  const rotated = once(other.ws, 'close');
  db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(hashApiKey('replacement-key'), owner.id);
  send(other.ws, { active: true, client: 'web' });
  assert.equal((await rotated)[0], 1008);
});
