import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'notecolab-plugin-recovery-'));
process.env.DATABASE_PATH = join(dataDir, 'test.db');

test('plugin recovery rotates the device credential while preserving the account and plan', async (t) => {
  const [{ closeDb, getDb }, { default: auth }, { default: billing }, { hashApiKey, hashPassword }, { lookupAuthUser }] = await Promise.all([
    import('../src/db/schema.js'),
    import('../src/routes/auth.js'),
    import('../src/routes/billing.js'),
    import('../src/utils.js'),
    import('../src/routes/middleware.js'),
  ]);
  t.after(() => {
    closeDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const db = getDb();
  const oldApiKey = 'old-plugin-api-key';
  const userId = Number(db.prepare(`
    INSERT INTO users (uid, api_key_hash, password_hash, public_key, plan, plan_expires_at)
    VALUES (?, ?, ?, ?, 'pro', ?)
  `).run(
    'recoverable-user',
    hashApiKey(oldApiKey),
    hashPassword('correct horse battery staple'),
    'old-public-key',
    '2030-01-01T00:00:00.000Z',
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO notes (user_id, share_id, encrypted_content)
    VALUES (?, 'owned-note', X'010203')
  `).run(userId);
  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, source, provider, provider_ref, expires_at)
    VALUES (?, 'pro', 'webhook', 'stripe', 'cs_paid', '2030-01-01T00:00:00.000Z')
  `).run(userId);

  const rejected = await auth.request('/recover-plugin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid: 'recoverable-user',
      password: 'wrong password',
      publicKey: 'replacement-public-key',
    }),
  });
  assert.equal(rejected.status, 401);
  assert.equal(lookupAuthUser(oldApiKey).ok, true);

  const response = await auth.request('/recover-plugin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid: 'recoverable-user',
      password: 'correct horse battery staple',
      publicKey: 'replacement-public-key',
    }),
  });
  assert.equal(response.status, 200);
  const recovered = await response.json() as { uid: string; apiKey: string };
  assert.equal(recovered.uid, 'recoverable-user');
  assert.ok(recovered.apiKey);
  assert.equal(lookupAuthUser(oldApiKey).ok, false);
  assert.equal(lookupAuthUser(recovered.apiKey).ok, true);

  const account = db.prepare(`
    SELECT id, plan, plan_expires_at, public_key,
      (SELECT COUNT(*) FROM notes WHERE user_id = users.id) AS note_count,
      (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id) AS subscription_count
    FROM users WHERE uid = 'recoverable-user'
  `).get() as {
    id: number;
    plan: string;
    plan_expires_at: string;
    public_key: string;
    note_count: number;
    subscription_count: number;
  };
  assert.equal(account.id, userId);
  assert.equal(account.plan, 'pro');
  assert.equal(account.plan_expires_at, '2030-01-01T00:00:00.000Z');
  assert.equal(account.public_key, 'replacement-public-key');
  assert.equal(account.note_count, 1);
  assert.equal(account.subscription_count, 1);

  const billingResponse = await billing.request('/info', {
    headers: { Authorization: `Bearer ${recovered.apiKey}` },
  });
  assert.equal(billingResponse.status, 200);
  const billingInfo = await billingResponse.json() as { plan: string; recoveryConfigured: boolean };
  assert.equal(billingInfo.plan, 'pro');
  assert.equal(billingInfo.recoveryConfigured, true);
});
