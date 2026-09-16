import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { checkCollaboratorCapacity, migratePlanLimits } from '../src/collaboration-limits.js';

test('named collaborator capacity deduplicates notes, preserves existing grants and grandfathers accounts', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE plans (id TEXT PRIMARY KEY, name TEXT, description TEXT, quota_bytes INTEGER,
        price_label TEXT, duration_days INTEGER, checkout_url TEXT, stripe_payment_link_id TEXT,
        active INTEGER, is_default INTEGER, sort_order INTEGER);
      INSERT INTO plans VALUES ('free', 'Free', NULL, 1000000, NULL, NULL, NULL, NULL, 1, 1, 0);
      CREATE TABLE users (id INTEGER PRIMARY KEY, uid TEXT, plan TEXT, plan_expires_at TEXT);
      INSERT INTO users VALUES (1, 'old-owner', 'free', NULL);
      CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER);
      CREATE TABLE collaborators (note_id INTEGER, user_uid TEXT);
    `);
    migratePlanLimits(db);
    migratePlanLimits(db);
    db.exec(`INSERT INTO users (id, uid, plan) VALUES (2, 'new-owner', 'free');
      INSERT INTO notes VALUES (10, 2), (11, 2);
      INSERT INTO collaborators VALUES (10, 'a'), (11, 'a'), (10, 'b'), (10, 'c'), (10, 'd'), (10, 'e');`);
    assert.equal(checkCollaboratorCapacity(db, 2, ['a']).ok, true);
    assert.equal(checkCollaboratorCapacity(db, 2, ['new-owner']).used, 5);
    assert.equal(checkCollaboratorCapacity(db, 2, ['f']).ok, false);
    assert.equal(checkCollaboratorCapacity(db, 1, ['a', 'b', 'c', 'd', 'e', 'f']).ok, true);
    db.exec("UPDATE plans SET collaborator_limit = 3 WHERE id = 'free'");
    assert.equal(checkCollaboratorCapacity(db, 2, ['a']).ok, true);
    assert.equal(checkCollaboratorCapacity(db, 2, ['f']).ok, false);
  } finally { db.close(); }
});
