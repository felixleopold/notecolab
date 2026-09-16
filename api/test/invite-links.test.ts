// Invite-link hardening (issue #19): token entropy, dedicated rate limits,
// pre-accept metadata minimization, expiry/revocation, the bounded legacy-token
// compatibility window, and max_uses atomicity.
//
// Runs against a real temp SQLite database and the real Hono router, so the
// middleware order (auth → rate limit → handler) is exercised too. node:test
// gives each test file its own process, so DATABASE_PATH here is isolated.

import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

const dbDir = mkdtempSync(join(tmpdir(), 'notecolab-invites-'));
process.env.DATABASE_PATH = join(dbDir, 'test.db');
process.on('exit', () => rmSync(dbDir, { recursive: true, force: true }));

const { getDb } = await import('../src/db/schema.js');
const { default: notes } = await import('../src/routes/notes.js');
const { generateInviteToken, hashApiKey } = await import('../src/utils.js');
const { resetInviteRateLimits } = await import('../src/invites.js');

const app = new Hono().route('/api/v1/notes', notes);

const OWNER = { uid: 'owner-uid', key: 'owner-key' };
let noteId: number;
let noteShareId: string;

function seedUser(uid: string, key: string): void {
  getDb().prepare('INSERT INTO users (uid, api_key_hash) VALUES (?, ?)').run(uid, hashApiKey(key));
}

/** `ip` isolates each test from the shared per-IP rate-limit buckets. */
function request(path: string, opts: { method?: string; key?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip || '10.0.0.1' };
  if (opts.key) headers['Authorization'] = `Bearer ${opts.key}`;
  return app.request(`/api/v1/notes${path}`, {
    method: opts.method || 'GET',
    headers,
    ...(opts.method && opts.method !== 'GET' ? { body: '{}' } : {}),
  });
}

async function createInvite(body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.request(`/api/v1/notes/${noteShareId}/invite-links`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OWNER.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json() as { token: string }).token;
}

/** Insert a pre-#19 invite directly, as the migration would have left it. */
function seedLegacyInvite(token: string, graceOffset: string): void {
  getDb().prepare(`
    INSERT INTO invite_links (token, note_id, created_by_uid, max_uses, token_version, legacy_valid_until)
    VALUES (?, ?, ?, 1, 1, datetime('now', ?))
  `).run(token, noteId, OWNER.uid, graceOffset);
}

before(() => {
  const db = getDb();
  seedUser(OWNER.uid, OWNER.key);
  const owner = db.prepare('SELECT id FROM users WHERE uid = ?').get(OWNER.uid) as { id: number };
  noteShareId = 'abcdef01';
  db.prepare("INSERT INTO notes (user_id, share_id, title_enc) VALUES (?, ?, 'ZW5jLXRpdGxl')")
    .run(owner.id, noteShareId);
  noteId = (db.prepare('SELECT id FROM notes WHERE share_id = ?').get(noteShareId) as { id: number }).id;
});

beforeEach(() => resetInviteRateLimits());

test('new invite tokens carry at least 128 bits of entropy and are unique', async () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 200; i++) tokens.add(generateInviteToken());
  assert.equal(tokens.size, 200);

  const token = await createInvite();
  assert.ok(Buffer.from(token, 'base64url').length >= 16, `token decodes to ${Buffer.from(token, 'base64url').length} bytes`);
  assert.doesNotMatch(token, /^[0-9a-f]{8}$/i, 'must not be the legacy 32-bit format');

  // Unrelated id formats stay put.
  assert.match(noteShareId, /^[0-9a-f]{8}$/);
});

test('public lookup exposes only the pre-accept fields', async () => {
  const token = await createInvite();
  const res = await request(`/invite/${token}`, { ip: '10.1.0.1' });

  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['encryptedTitle', 'expiresAt', 'noteShareId', 'shareId']);
  assert.equal(body.encryptedTitle, 'ZW5jLXRpdGxl');
  assert.equal(body.shareId, noteShareId);
  assert.equal(body.noteShareId, noteShareId);
  // No sender identity, no plaintext title, no usage counters.
  for (const leaked of ['senderName', 'senderUid', 'title', 'label', 'maxUses', 'usedCount', 'createdBy']) {
    assert.ok(!(leaked in body), `${leaked} must not be exposed pre-accept`);
  }
});

test('unauthenticated lookup is rate limited per IP', async () => {
  const token = await createInvite();
  const ip = '10.1.0.2';

  for (let i = 0; i < 30; i++) {
    assert.equal((await request(`/invite/${token}`, { ip })).status, 200, `request ${i + 1} should pass`);
  }
  const blocked = await request(`/invite/${token}`, { ip });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json() as { code: string }).code, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

  // The limit is per IP, not global.
  assert.equal((await request(`/invite/${token}`, { ip: '10.1.0.3' })).status, 200);
});

test('guessing legacy-format tokens hits a much tighter limit', async () => {
  const ip = '10.1.0.4';
  for (let i = 0; i < 5; i++) {
    assert.equal((await request(`/invite/0000000${i}`, { ip })).status, 404);
  }
  assert.equal((await request('/invite/deadbeef', { ip })).status, 429);
});

test('authenticated accept is rate limited per account, not just per IP', async () => {
  seedUser('accepter-rl', 'accepter-rl-key');
  // Rotating the source IP isolates the per-account bucket.
  const accept = (i: number) => request(`/invite/${generateInviteToken()}/accept`, {
    method: 'POST', key: 'accepter-rl-key', ip: `10.3.${i}.1`,
  });

  for (let i = 0; i < 10; i++) {
    assert.equal((await accept(i)).status, 404, `guess ${i + 1} should be rejected as not-found, not throttled`);
  }
  assert.equal((await accept(99)).status, 429);
});

test('expired and revoked invites stop resolving on both routes', async () => {
  // Written in the same ISO-8601 form the create route uses, so this also pins
  // that expiry comparison works across the two timestamp formats in the DB.
  const expired = await createInvite({ expiresIn: 3600 });
  getDb().prepare('UPDATE invite_links SET expires_at = ? WHERE token = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), expired);

  const live = await createInvite({ expiresIn: 3600 });
  assert.equal((await request(`/invite/${live}`, { ip: '10.1.0.6' })).status, 200);

  seedUser('expired-accepter', 'expired-accepter-key');
  assert.equal((await request(`/invite/${expired}`, { ip: '10.1.0.6' })).status, 410);
  assert.equal(
    (await request(`/invite/${expired}/accept`, { method: 'POST', key: 'expired-accepter-key', ip: '10.1.0.6' })).status,
    410,
  );

  const revoked = await createInvite();
  const del = await request(`/${noteShareId}/invite-links/${revoked}`, { method: 'DELETE', key: OWNER.key, ip: '10.1.0.6' });
  assert.equal(del.status, 200);
  assert.equal((await request(`/invite/${revoked}`, { ip: '10.1.0.6' })).status, 404);
});

test('legacy 32-bit invites work inside the grace window and are retired after it', async () => {
  seedLegacyInvite('aabbccdd', '+30 days');
  seedLegacyInvite('11223344', '-1 day');

  assert.equal((await request('/invite/aabbccdd', { ip: '10.1.0.7' })).status, 200);

  const retired = await request('/invite/11223344', { ip: '10.1.0.8' });
  assert.equal(retired.status, 410);
  assert.equal((await retired.json() as { code: string }).code, 'invite_token_retired');

  seedUser('legacy-accepter', 'legacy-accepter-key');
  const acceptRetired = await request('/invite/11223344/accept', {
    method: 'POST', key: 'legacy-accepter-key', ip: '10.1.0.9',
  });
  assert.equal(acceptRetired.status, 410);
});

test('max_uses is never exceeded when several accounts race the same invite', async () => {
  const token = await createInvite({ maxUses: 2 });
  const keys = ['racer-a', 'racer-b', 'racer-c', 'racer-d'];
  for (const k of keys) seedUser(k, `${k}-key`);

  const results = await Promise.all(
    keys.map((k, i) => request(`/invite/${token}/accept`, { method: 'POST', key: `${k}-key`, ip: `10.2.0.${i}` })),
  );
  const statuses = results.map((r) => r.status).sort();

  assert.deepEqual(statuses, [200, 200, 410, 410]);
  const row = getDb().prepare('SELECT used_count, max_uses FROM invite_links WHERE token = ?')
    .get(token) as { used_count: number; max_uses: number };
  assert.equal(row.used_count, 2);
  assert.ok(row.used_count <= row.max_uses);

  const collaborators = getDb()
    .prepare('SELECT COUNT(*) AS n FROM collaborators WHERE note_id = ?').get(noteId) as { n: number };
  assert.equal(collaborators.n, 2);
});
