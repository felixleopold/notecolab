import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'notecolab-collaborators-'));
process.env.DATABASE_PATH = join(directory, 'test.db');

test('owner collaborator limit applies to creation, replacement, direct grants and invite acceptance', async (t) => {
  const [{ getDb, closeDb }, { default: notes }, { hashApiKey }] = await Promise.all([
    import('../src/db/schema.js'), import('../src/routes/notes.js'), import('../src/utils.js'),
  ]);
  t.after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });
  const db = getDb();
  const ownerId = Number(db.prepare('INSERT INTO users (uid, api_key_hash) VALUES (?, ?)')
    .run('owner', hashApiKey('owner-test-key')).lastInsertRowid);
  db.prepare('INSERT INTO users (uid, api_key_hash) VALUES (?, ?)').run('recipient', hashApiKey('recipient-test-key'));
  db.prepare("UPDATE plans SET collaborator_limit = 1 WHERE id = 'free'").run();
  const request = (path: string, body: object, method = 'POST', key = 'owner-test-key') => notes.request(path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
  const content = Buffer.from('ciphertext').toString('base64');
  const initial = await request('/share', { encryptedContent: content, collaborators: ['first'] });
  assert.equal(initial.status, 200);
  const { shareId } = await initial.json() as { shareId: string };
  const blocked = await request('/share', { encryptedContent: content, collaborators: ['second'] });
  assert.equal(blocked.status, 403);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM notes WHERE user_id = ?').get(ownerId) as { count: number }).count, 1);
  assert.equal((await request(`/${shareId}/collaborators`, { uid: 'second' })).status, 403);
  assert.equal((await request(`/${shareId}`, { collaborators: ['first', 'second'], encryptedContent: Buffer.from('unwanted').toString('base64') }, 'PATCH')).status, 403);
  assert.equal((db.prepare('SELECT encrypted_content FROM notes WHERE share_id = ?').get(shareId) as { encrypted_content: Buffer }).encrypted_content.toString(), 'ciphertext');
  // Replacing the only recipient at capacity is allowed.
  assert.equal((await request(`/${shareId}`, { collaborators: ['second'] }, 'PATCH')).status, 200);
  const noteId = (db.prepare('SELECT id FROM notes WHERE share_id = ?').get(shareId) as { id: number }).id;
  const token = 'a'.repeat(64);
  db.prepare('INSERT INTO invite_links (token, note_id, created_by_uid) VALUES (?, ?, ?)').run(token, noteId, 'owner');
  assert.equal((await request(`/invite/${token}/accept`, {}, 'POST', 'recipient-test-key')).status, 403);
  assert.equal((db.prepare('SELECT used_count FROM invite_links WHERE token = ?').get(token) as { used_count: number }).used_count, 0);
  await notes.request(`/${shareId}/collaborators/second`, { method: 'DELETE', headers: { Authorization: 'Bearer owner-test-key' } });
  assert.equal((await request(`/invite/${token}/accept`, {}, 'POST', 'recipient-test-key')).status, 200);
});
