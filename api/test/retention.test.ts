import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { cleanupExpiredData } from '../src/cron/cleanup.js';

test('cleanup honors unexpired old content while explicit link expiry still removes content', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO users (uid, api_key_hash, plan, plan_expires_at) VALUES ('paid', 'test', 'pro', datetime('now', '+30 days'))").run();
    const insert = db.prepare("INSERT INTO notes (user_id, share_id, updated_at, expires_at) VALUES (1, ?, datetime('now', '-500 days'), ?)");
    insert.run('unexpired', null);
    insert.run('expired', new Date(Date.now() - 60_000).toISOString());
    insert.run('future', new Date(Date.now() + 60_000).toISOString());
    cleanupExpiredData(db);
    assert.deepEqual(db.prepare('SELECT share_id FROM notes ORDER BY share_id').all(), [{ share_id: 'future' }, { share_id: 'unexpired' }]);
  } finally { db.close(); }
});
