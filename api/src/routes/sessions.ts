import { Hono } from 'hono';
import { getDb } from '../db/schema.js';
import { generateRoomId } from '../utils.js';
import { authMiddleware } from './middleware.js';
import type { AppEnv } from '../env.js';

const sessions = new Hono<AppEnv>();

sessions.use('*', authMiddleware);

// Create a collab session
sessions.post('/create', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    type: 'fleeting' | 'persistent';
    shareId?: string; // link to existing note for persistent sessions
  }>();

  if (!body.type || !['fleeting', 'persistent'].includes(body.type)) {
    return c.json({ error: 'type must be "fleeting" or "persistent"' }, 400);
  }

  const db = getDb();
  const roomId = generateRoomId();
  let noteId: number | null = null;

  if (body.shareId) {
    const note = db.prepare(`
      SELECT n.id, u.uid as owner_uid FROM notes n JOIN users u ON n.user_id = u.id WHERE n.share_id = ?
    `).get(body.shareId) as any;

    if (!note) {
      return c.json({ error: 'Note not found' }, 404);
    }
    if (note.owner_uid !== user.uid) {
      return c.json({ error: 'Only the note owner can create a session' }, 403);
    }
    noteId = note.id;
  }

  db.prepare(`
    INSERT INTO sessions (note_id, creator_uid, type, room_id) VALUES (?, ?, ?, ?)
  `).run(noteId, user.uid, body.type, roomId);

  return c.json({ roomId, type: body.type });
});

// End a session
sessions.delete('/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const user = c.get('user');
  const db = getDb();

  const session = db.prepare('SELECT * FROM sessions WHERE room_id = ?').get(roomId) as any;
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  if (session.creator_uid !== user.uid) {
    return c.json({ error: 'Only the session creator can end it' }, 403);
  }

  db.prepare("UPDATE sessions SET ended_at = datetime('now') WHERE room_id = ?").run(roomId);

  return c.json({ ok: true });
});

// Get session info (public, for joining)
sessions.get('/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const db = getDb();

  const session = db.prepare(`
    SELECT s.room_id, s.type, s.created_at, s.ended_at, n.share_id
    FROM sessions s LEFT JOIN notes n ON s.note_id = n.id
    WHERE s.room_id = ?
  `).get(roomId) as any;

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  if (session.ended_at) {
    return c.json({ error: 'Session has ended' }, 410);
  }

  return c.json(session);
});

export default sessions;
