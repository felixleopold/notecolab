import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { PENDING_SHARE_DELIVERY_SQL } from '../src/routes/notes.js';

function seedDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      share_id TEXT NOT NULL,
      access_mode TEXT NOT NULL
    );
    CREATE TABLE share_links (
      id INTEGER PRIMARY KEY,
      note_id INTEGER NOT NULL,
      share_id TEXT NOT NULL,
      access_mode TEXT NOT NULL
    );
    CREATE TABLE pending_shares (
      id INTEGER PRIMARY KEY,
      note_id INTEGER NOT NULL,
      share_id TEXT NOT NULL,
      recipient_uid TEXT NOT NULL
    );
    INSERT INTO notes (id, share_id, access_mode) VALUES (1, 'room-1', 'invited_edit');
    INSERT INTO share_links (id, note_id, share_id, access_mode) VALUES
      (1, 1, 'view-link', 'read_only'),
      (2, 1, 'edit-link', 'invited_edit');
    INSERT INTO pending_shares (id, note_id, share_id, recipient_uid) VALUES
      (10, 1, 'view-link', 'recipient-1'),
      (11, 1, 'edit-link', 'recipient-1'),
      (12, 1, 'room-1', 'recipient-1');
  `);
  return db;
}

const deliveryMode = (db: Database.Database, id: number) =>
  (db.prepare(PENDING_SHARE_DELIVERY_SQL).get(id, 'recipient-1') as { access_mode: string }).access_mode;

test('a delivery reports the access mode of the link it was sent through', () => {
  const db = seedDb();
  assert.equal(deliveryMode(db, 10), 'read_only');
  assert.equal(deliveryMode(db, 11), 'invited_edit');
});

test('a delivery sent before link identity falls back to the note access mode', () => {
  const db = seedDb();
  assert.equal(deliveryMode(db, 12), 'invited_edit');
});

test('dismissing a delivery only revokes collaborator access for invited_edit', () => {
  const db = seedDb();
  // Mirrors the route: a read-only delivery must not revoke edit access the
  // recipient holds through a separate invited_edit link on the same note.
  const revoked = [10, 11].filter((id) => deliveryMode(db, id) === 'invited_edit');
  assert.deepEqual(revoked, [11]);
});
