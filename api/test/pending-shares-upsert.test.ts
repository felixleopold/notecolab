import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { PENDING_SHARE_UPSERT_SQL } from '../src/routes/notes.js';

test('resending to the same recipient refreshes one pending invitation in place', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE pending_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      share_id TEXT NOT NULL,
      recipient_uid TEXT NOT NULL,
      sender_uid TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      nonce TEXT NOT NULL,
      title TEXT,
      title_enc TEXT,
      dismissed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(share_id, recipient_uid)
    )
  `);

  const upsert = db.prepare(PENDING_SHARE_UPSERT_SQL);
  upsert.run(1, 'note-1', 'recipient-1', 'sender-1', 'key-1', 'nonce-1', null, 'title-1');
  const first = db.prepare('SELECT id FROM pending_shares').get() as { id: number };
  db.prepare('UPDATE pending_shares SET dismissed = 1 WHERE id = ?').run(first.id);

  upsert.run(1, 'note-1', 'recipient-1', 'sender-1', 'key-2', 'nonce-2', null, 'title-2');

  const rows = db.prepare(`
    SELECT id, encrypted_key, nonce, title_enc, dismissed
    FROM pending_shares
  `).all() as {
    id: number;
    encrypted_key: string;
    nonce: string;
    title_enc: string;
    dismissed: number;
  }[];

  assert.deepEqual(rows, [{
    id: first.id,
    encrypted_key: 'key-2',
    nonce: 'nonce-2',
    title_enc: 'title-2',
    dismissed: 0,
  }]);
});

test('different permission links can be delivered independently to the same recipient', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE pending_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      share_id TEXT NOT NULL,
      recipient_uid TEXT NOT NULL,
      sender_uid TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      nonce TEXT NOT NULL,
      title TEXT,
      title_enc TEXT,
      dismissed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(share_id, recipient_uid)
    )
  `);

  const upsert = db.prepare(PENDING_SHARE_UPSERT_SQL);
  upsert.run(1, 'view-link', 'recipient-1', 'sender-1', 'key', 'nonce', null, 'title');
  upsert.run(1, 'edit-link', 'recipient-1', 'sender-1', 'key', 'nonce', null, 'title');

  assert.deepEqual(
    db.prepare('SELECT share_id FROM pending_shares ORDER BY share_id').all(),
    [{ share_id: 'edit-link' }, { share_id: 'view-link' }],
  );
});
