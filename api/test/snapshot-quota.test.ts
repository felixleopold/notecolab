import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'notecolab-history-quota-'));
process.env.DATABASE_PATH = join(directory, 'test.db');

test('recovery revisions cannot bypass owner quota and expired links cannot upload images', async (t) => {
  const [{ getDb, closeDb }, { default: notes }, { hashApiKey }, { getUserUsedBytes }] = await Promise.all([
    import('../src/db/schema.js'), import('../src/routes/notes.js'), import('../src/utils.js'), import('../src/quota.js'),
  ]);
  t.after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (uid, api_key_hash) VALUES ('owner', ?)").run(hashApiKey('test-key')).lastInsertRowid);
  db.prepare("UPDATE plans SET quota_bytes = 10 WHERE id = 'free'").run();
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' };
  const payload = (length: number) => Buffer.alloc(length, 65).toString('base64');
  const create = () => notes.request('/share', { method: 'POST', headers, body: JSON.stringify({ encryptedContent: payload(8), accessMode: 'public_edit' }) });
  const first = await create();
  assert.equal(first.status, 200);
  const { shareId } = await first.json() as { shareId: string };
  const update = (length: number) => notes.request(`/${shareId}`, { method: 'PATCH', headers, body: JSON.stringify({ encryptedContent: payload(length) }) });
  assert.equal((await update(1)).status, 200);
  assert.equal(getUserUsedBytes(db, userId), 9, 'eight-byte previous revision still counts');
  assert.equal((await create()).status, 413, 'cannot repeat large-to-small writes to hide retained data');
  assert.equal((await update(10)).status, 200, 'optional history is discarded when the current note fits without it');
  assert.equal(getUserUsedBytes(db, userId), 10);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM note_revisions').get() as { n: number }).n, 0);
  assert.equal((await update(11)).status, 413);
  db.prepare("UPDATE share_links SET expires_at = datetime('now', '-1 day') WHERE share_id = ?").run(shareId);
  const app = new Hono().route('/api/v1/notes', notes);
  const expired = await app.request(`/api/v1/notes/${shareId}/images`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'image.png', encryptedData: payload(1) }),
  });
  assert.equal(expired.status, 410);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM note_images').get() as { n: number }).n, 0);
});
