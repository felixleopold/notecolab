import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'notecolab-plans-'));
process.env.DATABASE_PATH = join(dataDir, 'test.db');

test('database-backed plans drive grants and quota status', async (t) => {
  const { closeDb, getDb } = await import('../src/db/schema.js');
  const { getQuotaStatus, grantPlan, loadUserPlan } = await import('../src/quota.js');
  const { listPlans } = await import('../src/plans.js');
  t.after(() => {
    closeDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const db = getDb();
  assert.deepEqual(listPlans(db).map((plan) => plan.id), ['free', 'pro']);

  db.prepare(`
    INSERT INTO plans (id, name, description, quota_bytes, price_label, duration_days, active, sort_order)
    VALUES ('team', 'Team', 'Shared team storage', 1048576, '€20 / year', 365, 1, 20)
  `).run();
  const userId = Number(db.prepare("INSERT INTO users (uid, api_key_hash) VALUES ('test-user', 'hash')").run().lastInsertRowid);
  const grant = grantPlan(db, userId, 'team', { source: 'admin' });
  const status = getQuotaStatus(db, loadUserPlan(db, userId));

  assert.equal(grant.plan, 'team');
  assert.ok(grant.planExpiresAt);
  assert.equal(status.plan, 'team');
  assert.equal(status.limitBytes, 1048576);
  assert.equal(listPlans(db).find((plan) => plan.id === 'team')?.description, 'Shared team storage');
});
