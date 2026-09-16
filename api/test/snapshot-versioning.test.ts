import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'notecolab-snapshots-'));
process.env.DATABASE_PATH = join(dataDir, 'test.db');

test('encrypted snapshots reject stale replacement and retain recoverable history', async (t) => {
  const [{ closeDb, getDb }, { default: notes }, { hashApiKey }] = await Promise.all([
    import('../src/db/schema.js'),
    import('../src/routes/notes.js'),
    import('../src/utils.js'),
  ]);
  t.after(() => {
    closeDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const db = getDb();
  const apiKey = 'snapshot-test-key';
  const userId = Number(db.prepare(
    'INSERT INTO users (uid, api_key_hash) VALUES (?, ?)',
  ).run('snapshot-owner', hashApiKey(apiKey)).lastInsertRowid);
  const first = Buffer.from('encrypted-one');
  const noteId = Number(db.prepare(`
    INSERT INTO notes (user_id, share_id, encrypted_content)
    VALUES (?, 'snapshot-room', ?)
  `).run(userId, first).lastInsertRowid);
  db.prepare(`
    INSERT INTO share_links (note_id, share_id, label, access_mode)
    VALUES (?, 'snapshot-room', 'Original', 'public_edit')
  `).run(noteId);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const second = Buffer.from('encrypted-two').toString('base64');
  const crdt = Buffer.from('encrypted-crdt').toString('base64');
  const saved = await notes.request('/snapshot-room', {
    method: 'PATCH', headers,
    body: JSON.stringify({ encryptedContent: second, encryptedCrdt: crdt, baseVersion: 1 }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true, contentVersion: 2 });

  const stale = await notes.request('/snapshot-room', {
    method: 'PATCH', headers,
    body: JSON.stringify({
      encryptedContent: Buffer.from('stale').toString('base64'),
      encryptedCrdt: crdt,
      baseVersion: 1,
    }),
  });
  assert.equal(stale.status, 409);
  const conflict = await stale.json() as {
    code: string;
    current: { contentVersion: number; encryptedContent: string; encryptedCrdt: string };
  };
  assert.equal(conflict.code, 'snapshot_conflict');
  assert.equal(conflict.current.contentVersion, 2);
  assert.equal(conflict.current.encryptedContent, second);
  assert.equal(conflict.current.encryptedCrdt, crdt);

  const history = await notes.request('/snapshot-room/history', { headers });
  assert.equal(history.status, 200);
  const historyBody = await history.json() as {
    currentVersion: number;
    revisions: { contentVersion: number; encryptedContent: string }[];
  };
  assert.equal(historyBody.currentVersion, 2);
  assert.deepEqual(historyBody.revisions.map((revision) => revision.contentVersion), [1]);
  assert.equal(historyBody.revisions[0]?.encryptedContent, first.toString('base64'));
  db.prepare("UPDATE share_links SET access_mode = 'read_only' WHERE share_id = 'snapshot-room'").run();
  assert.equal((await notes.request('/snapshot-room/history')).status, 403);
  assert.equal((await notes.request('/snapshot-room/history', { headers })).status, 200);
  const legacy = await notes.request('/snapshot-room', { method: 'PATCH', headers,
    body: JSON.stringify({ encryptedContent: Buffer.from('legacy edit').toString('base64') }) });
  assert.equal(legacy.status, 200);
  const persisted = db.prepare('SELECT encrypted_content, encrypted_crdt FROM notes WHERE id = ?').get(noteId) as { encrypted_content: Buffer; encrypted_crdt: Buffer | null };
  assert.equal(persisted.encrypted_content.toString(), 'legacy edit');
  assert.equal(persisted.encrypted_crdt, null, 'old CRDT text must not replace a newer legacy body-only edit');
});
