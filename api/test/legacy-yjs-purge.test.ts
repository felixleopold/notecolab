import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.ts';

test('migration purges legacy plaintext Yjs snapshots without deleting encrypted notes', () => {
  const db = new Database(':memory:');
  migrate(db);

  const user = db.prepare(
    "INSERT INTO users (uid, api_key_hash) VALUES ('owner', 'hash')",
  ).run();
  const note = db.prepare(
    "INSERT INTO notes (user_id, share_id, encrypted_content) VALUES (?, 'share', ?)",
  ).run(user.lastInsertRowid, Buffer.from('encrypted-rest-content'));
  db.prepare(
    'INSERT INTO yjs_state (note_id, doc_update) VALUES (?, ?)',
  ).run(note.lastInsertRowid, Buffer.from('recognizable plaintext'));

  migrate(db);

  const snapshots = db.prepare('SELECT COUNT(*) AS count FROM yjs_state').get() as { count: number };
  const storedNote = db.prepare('SELECT encrypted_content FROM notes WHERE id = ?')
    .get(note.lastInsertRowid) as { encrypted_content: Buffer };
  assert.equal(snapshots.count, 0);
  assert.equal(storedNote.encrypted_content.toString(), 'encrypted-rest-content');
  db.close();
});
