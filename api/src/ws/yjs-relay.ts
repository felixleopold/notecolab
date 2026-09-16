import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { createHmac, randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { getDb } from '../db/schema.js';
import { hashApiKey } from '../utils.js';
import { lookupAuthUser } from '../routes/middleware.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_PRESENCE = 4;
const PRESENCE_TTL = 60_000;

// --- Connection limits ---
const MAX_TOTAL_CONNECTIONS = parseInt(process.env.MAX_WS_CONNECTIONS || '200', 10);
const MAX_CONNECTIONS_PER_ROOM = parseInt(process.env.MAX_WS_PER_ROOM || '20', 10);
let totalConnections = 0;

export function getTotalConnections(): number {
  return totalConnections;
}

export function getRoomCount(): number {
  return rooms.size;
}

interface YjsConnection {
  ws: WebSocket;
  room: string;
  awareness: Set<number>;
  canWrite: boolean;
  presenceOnly: boolean;
  participantId: string;
  name: string;
  presence: { active: boolean; client: 'web' | 'obsidian'; updatedAt: number } | null;
  presenceWindow: number;
  presenceMessages: number;
  lastRoster: string;
  authorized: () => boolean;
  lastAuthorizationCheck: number;
}

// In-memory Yjs doc state per room
const rooms = new Map<string, {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  connections: Set<YjsConnection>;
  identitySalt: Buffer;
}>();

function getOrCreateRoom(roomId: string) {
  let room = rooms.get(roomId);
  if (!room) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    // Broadcast document updates to all peers except the origin
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const r = rooms.get(roomId);
      if (!r) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const msg = encoding.toUint8Array(encoder);

      for (const conn of r.connections) {
        if (!conn.presenceOnly && conn !== origin && conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(msg);
        }
      }
    });

    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changedClients = added.concat(updated, removed);
      const r = rooms.get(roomId);
      if (!r) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients));
      const msg = encoding.toUint8Array(encoder);

      for (const conn of r.connections) {
        if (!conn.presenceOnly && conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(msg);
        }
      }
    });

    room = { doc, awareness, connections: new Set(), identitySalt: randomBytes(32) };
    rooms.set(roomId, room);
  }
  return room;
}

function cleanupRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (room && room.connections.size === 0) {
    room.awareness.destroy();
    room.doc.destroy();
    rooms.delete(roomId);
  }
}

function broadcastPresence(room: ReturnType<typeof getOrCreateRoom>, acknowledgement?: YjsConnection) {
  const now = Date.now();
  const participants = new Map<string, { id: string; name: string; client: 'web' | 'obsidian' }>();
  const subscribers = [...room.connections].filter(conn => {
    if (!conn.presence || conn.ws.readyState !== WebSocket.OPEN) return false;
    if (!conn.authorized()) {
      conn.presence.active = false;
      conn.ws.close(1008, 'Access revoked');
      return false;
    }
    if (now - conn.presence.updatedAt >= PRESENCE_TTL) conn.presence.active = false;
    return true;
  });
  for (const conn of subscribers) {
    if (conn.presence?.active && !participants.has(conn.participantId)) {
      participants.set(conn.participantId, { id: conn.participantId, name: conn.name, client: conn.presence.client });
    }
  }
  for (const conn of subscribers) {
    const payload = JSON.stringify({ participants: [...participants.values()], selfId: conn.participantId });
    if (payload === conn.lastRoster && conn !== acknowledgement) continue;
    conn.lastRoster = payload;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_PRESENCE);
    encoding.writeVarString(encoder, payload);
    conn.ws.send(encoding.toUint8Array(encoder));
  }
}

function handleMessage(conn: YjsConnection, data: Uint8Array) {
  const room = rooms.get(conn.room);
  if (!room) return;

  const decoder = decoding.createDecoder(data);
  const msgType = decoding.readVarUint(decoder);

  switch (msgType) {
    case MSG_SYNC: {
      if (conn.presenceOnly) break;
      const syncMessageType = decoding.readVarUint(decoder);
      if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.readSyncStep1(decoder, encoder, room.doc);
        conn.ws.send(encoding.toUint8Array(encoder));
      } else if ((syncMessageType === syncProtocol.messageYjsSyncStep2 || syncMessageType === syncProtocol.messageYjsUpdate)
          && Date.now() - conn.lastAuthorizationCheck >= 5_000) {
        conn.lastAuthorizationCheck = Date.now();
        if (!conn.authorized()) {
          conn.ws.close(1008, 'Access revoked');
          break;
        }
        if (syncMessageType === syncProtocol.messageYjsSyncStep2 && conn.canWrite) {
          syncProtocol.readSyncStep2(decoder, room.doc, conn);
        } else if (syncMessageType === syncProtocol.messageYjsUpdate && conn.canWrite) {
          syncProtocol.readUpdate(decoder, room.doc, conn);
        }
      } else if (syncMessageType === syncProtocol.messageYjsSyncStep2 && conn.canWrite) {
        syncProtocol.readSyncStep2(decoder, room.doc, conn);
      } else if (syncMessageType === syncProtocol.messageYjsUpdate && conn.canWrite) {
        syncProtocol.readUpdate(decoder, room.doc, conn);
      }
      break;
    }
    case MSG_PRESENCE: {
      if (data.byteLength > 256) throw new Error('Presence message too large');
      const now = Date.now();
      if (now - conn.presenceWindow >= 10_000) {
        conn.presenceWindow = now;
        conn.presenceMessages = 0;
      }
      if (++conn.presenceMessages > 40) throw new Error('Presence rate limit');
      const payload: unknown = JSON.parse(decoding.readVarString(decoder));
      if (!payload || typeof payload !== 'object' ||
          !('active' in payload) || typeof payload.active !== 'boolean' ||
          !('client' in payload) || (payload.client !== 'web' && payload.client !== 'obsidian') ||
          Object.keys(payload).some(key => key !== 'active' && key !== 'client') ||
          decoding.hasContent(decoder)) throw new Error('Invalid presence');
      conn.presence = { active: payload.active, client: payload.client, updatedAt: now };
      broadcastPresence(room, conn);
      break;
    }
    case MSG_AWARENESS: {
      if (conn.presenceOnly) break;
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn);
      break;
    }
  }
}

interface NoteRow {
  id: number;
  user_id: number;
  share_id: string;
  access_mode: string;
  expires_at: string | null;
  room_token_hash: string | null;
}

interface UserRow {
  id: number;
  uid: string;
}

function isPast(value: string | null): boolean {
  return !!value && new Date(value) < new Date();
}

function isNoteExpiredForUser(note: NoteRow, user: UserRow | null): boolean {
  if (!isPast(note.expires_at)) return false;
  if (user && note.user_id === user.id) return false;
  if (note.access_mode === 'invited_edit') return false;
  return true;
}

function resolveGrant(
  note: NoteRow,
  token: string | null,
  linkShareId: string | null,
  rt: string | null,
): { ok: true; canWrite: boolean } | { ok: false; reason: string } {
  const db = getDb();

  let user: UserRow | null = null;
  if (token) {
    const auth = lookupAuthUser(token);
    user = auth.ok ? auth.user : null;

    if (user) {
      if (isNoteExpiredForUser(note, user)) {
        return { ok: false, reason: 'Share expired' };
      }
      if (note.user_id === user.id) {
        return { ok: true, canWrite: true };
      }
      const collab = db.prepare(
        'SELECT can_edit FROM collaborators WHERE note_id = ? AND user_uid = ?'
      ).get(note.id, user.uid) as { can_edit: number } | undefined;
      if (collab) {
        return { ok: true, canWrite: !!collab.can_edit };
      }
    }
  }

  // Account-authenticated owners and collaborators are already authorized
  // above. This intentionally keeps invited-edit shares compatible with older
  // plugin versions, which send their API token but predate key-derived room
  // tokens. Anonymous link access still requires the room token.
  if (note.room_token_hash) {
    if (!rt || hashApiKey(rt) !== note.room_token_hash) {
      return { ok: false, reason: 'Room token required' };
    }
  }

  if (isNoteExpiredForUser(note, user)) {
    return { ok: false, reason: 'Share expired' };
  }

  if (linkShareId) {
    const link = db.prepare(`
      SELECT access_mode
      FROM share_links
      WHERE note_id = ?
        AND share_id = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(note.id, linkShareId) as { access_mode: string } | undefined;

    if (link) {
      if (link.access_mode === 'public_edit') {
        return { ok: true, canWrite: true };
      }
      if (link.access_mode === 'read_only') {
        return { ok: true, canWrite: false };
      }
    }
  }

  if (!note.room_token_hash) {
    const legacy = db.prepare(`
      SELECT
        COUNT(*) AS readable,
        SUM(CASE WHEN access_mode = 'public_edit' THEN 1 ELSE 0 END) AS writable
      FROM share_links
      WHERE note_id = ?
        AND access_mode != 'invited_edit'
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(note.id) as { readable: number; writable: number | null };

    if (legacy.readable > 0) {
      return { ok: true, canWrite: (legacy.writable || 0) > 0 };
    }
  }

  return { ok: false, reason: 'Access denied' };
}

export function setupYjsWebSocket(wss: WebSocketServer) {
  const sweep = setInterval(() => {
    for (const room of rooms.values()) broadcastPresence(room);
  }, 10_000);
  sweep.unref();
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => { clearInterval(sweep); clearInterval(heartbeat); });
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathParts = url.pathname.split('/');
    // Expected: /ws/yjs/:roomId
    const roomId = pathParts[pathParts.length - 1];

    if (!roomId) {
      ws.close(1008, 'Missing room ID');
      return;
    }

    // Validate note exists
    const db = getDb();
    const note = db.prepare(`
      SELECT n.id, n.user_id, n.share_id, n.access_mode, n.expires_at, n.room_token_hash, u.uid AS owner_uid
      FROM notes n
      JOIN users u ON n.user_id = u.id
      WHERE n.share_id = ?
    `).get(roomId) as NoteRow | undefined;
    if (!note) {
      ws.close(1008, 'Note not found');
      return;
    }

    const grant = resolveGrant(
      note,
      url.searchParams.get('token'),
      url.searchParams.get('link'),
      url.searchParams.get('rt'),
    );
    if (!grant.ok) {
      ws.close(1008, grant.reason);
      return;
    }

    // Enforce connection limits
    if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
      ws.close(1013, 'Server at capacity — please try again later');
      return;
    }
    const existingRoom = rooms.get(roomId);
    if (existingRoom && existingRoom.connections.size >= MAX_CONNECTIONS_PER_ROOM) {
      ws.close(1013, 'Room is full — please try again later');
      return;
    }

    totalConnections++;
    const room = getOrCreateRoom(roomId);
    const token = url.searchParams.get('token');
    const auth = token ? lookupAuthUser(token) : null;
    const user = auth?.ok ? auth.user : null;
    const profile = user ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(user.id) as { display_name: string | null } | undefined : undefined;
    const conn: YjsConnection = {
      ws, room: roomId, awareness: new Set(), canWrite: grant.canWrite,
      presenceOnly: url.searchParams.get('presence') === '1',
      participantId: user
        ? createHmac('sha256', room.identitySalt).update(String(user.id)).digest('base64url')
        : randomBytes(16).toString('base64url'),
      name: user ? profile?.display_name?.trim().slice(0, 40) || 'Participant' : 'Guest',
      presence: null, presenceWindow: 0, presenceMessages: 0, lastRoster: '',
      lastAuthorizationCheck: Date.now(),
      authorized: () => {
        // Recheck the original credential and grant before disclosing a roster.
        if (user) {
          if (!token || !lookupAuthUser(token).ok) return false;
          const currentProfile = db.prepare('SELECT display_name FROM users WHERE id = ?').get(user.id) as { display_name: string | null } | undefined;
          conn.name = currentProfile?.display_name?.trim().slice(0, 40) || 'Participant';
        }
        const currentNote = db.prepare(`
          SELECT id, user_id, share_id, access_mode, expires_at, room_token_hash
          FROM notes WHERE id = ?
        `).get(note.id) as NoteRow | undefined;
        if (!currentNote) return false;
        const currentGrant = resolveGrant(currentNote, token, url.searchParams.get('link'), url.searchParams.get('rt'));
        if (!currentGrant.ok) return false;
        conn.canWrite = currentGrant.canWrite;
        return true;
      },
    };
    room.connections.add(conn);

    if (!conn.presenceOnly) {
      // Send initial sync step 1
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, room.doc);
      ws.send(encoding.toUint8Array(encoder));

      // Send awareness states
      const awarenessStates = room.awareness.getStates();
      if (awarenessStates.size > 0) {
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
        encoding.writeVarUint8Array(
          awarenessEncoder,
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(awarenessStates.keys()))
        );
        ws.send(encoding.toUint8Array(awarenessEncoder));
      }
    }

    ws.on('message', (data: Buffer) => {
      try {
        handleMessage(conn, new Uint8Array(data));
      } catch {
        ws.close(1008, 'Invalid message');
      }
    });

    ws.on('close', () => {
      totalConnections = Math.max(0, totalConnections - 1);
      room.connections.delete(conn);
      // Remove awareness state for this connection
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(conn.awareness), null);
      broadcastPresence(room);
      cleanupRoom(roomId);
    });

    ws.on('error', () => {
      ws.close();
    });
  });
}

export { rooms };
