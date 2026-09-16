// Per-user storage quota helpers.
//
// Storage always counts against the *owner* of a note (not whoever happens to
// be editing it). A note's charged footprint is its encrypted content, encrypted
// CRDT checkpoint and every encrypted image. Uploads that would push the owner
// over their effective quota are rejected with HTTP 413 (see routes/notes.ts).

import type Database from 'better-sqlite3';
import { effectivePlan, getPlan, isUnlimited, type PlanId } from './plans.js';

export interface UserPlanRow {
  id: number;
  plan?: string | null;
  plan_expires_at?: string | null;
}

/** Load just the columns needed to evaluate a user's plan + quota. */
export function loadUserPlan(db: Database.Database, userId: number): UserPlanRow {
  const row = db
    .prepare('SELECT id, plan, plan_expires_at FROM users WHERE id = ?')
    .get(userId) as UserPlanRow | undefined;
  return row || { id: userId, plan: 'free', plan_expires_at: null };
}

/**
 * Total stored bytes a user owns. Counts everything that grows with the account:
 * note content, encrypted CRDT checkpoints, retained revisions and images, plus the smaller
 * key-exchange blobs
 * (vault_keys keyed by user_id, and pending_shares this user sent). Including the
 * latter two closes a quota-bypass where a user parked bulk data in those tables,
 * which were previously invisible to enforcement.
 */
export function getUserUsedBytes(db: Database.Database, userId: number): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(LENGTH(encrypted_content) + LENGTH(COALESCE(encrypted_crdt, X''))) FROM notes WHERE user_id = ?), 0)
         + COALESCE((SELECT SUM(LENGTH(COALESCE(r.encrypted_content, X'')) + LENGTH(COALESCE(r.encrypted_crdt, X''))) FROM note_revisions r
                       JOIN notes n ON n.id = r.note_id WHERE n.user_id = ?), 0)
         + COALESCE((SELECT SUM(LENGTH(ni.encrypted_data)) FROM note_images ni
                       JOIN notes n ON ni.note_id = n.id WHERE n.user_id = ?), 0)
         + COALESCE((SELECT SUM(LENGTH(encrypted_key)) FROM vault_keys WHERE user_id = ?), 0)
         + COALESCE((SELECT SUM(LENGTH(ps.encrypted_key) + LENGTH(ps.nonce) + LENGTH(COALESCE(ps.title,'')))
                       FROM pending_shares ps
                       JOIN users u ON u.uid = ps.sender_uid WHERE u.id = ?), 0)
         AS used`,
    )
    .get(userId, userId, userId, userId, userId) as { used: number };
  return row.used || 0;
}

export interface QuotaStatus {
  plan: PlanId;
  planExpiresAt: string | null;
  usedBytes: number;
  limitBytes: number; // <= 0 means unlimited
  unlimited: boolean;
  usagePercent: number; // 0 when unlimited
}

export function getQuotaStatus(db: Database.Database, user: UserPlanRow): QuotaStatus {
  const plan = effectivePlan(db, user.plan, user.plan_expires_at);
  const limitBytes = plan.quotaBytes;
  const usedBytes = getUserUsedBytes(db, user.id);
  const unlimited = isUnlimited(limitBytes);
  return {
    plan: plan.id,
    planExpiresAt: plan.id === user.plan ? user.plan_expires_at ?? null : null,
    usedBytes,
    limitBytes,
    unlimited,
    usagePercent: unlimited ? 0 : Math.round((usedBytes / limitBytes) * 100),
  };
}

export interface QuotaCheck {
  ok: boolean;
  usedBytes: number;
  limitBytes: number;
  plan: PlanId;
}

/**
 * Check whether adding `deltaBytes` to the owner's storage stays within quota.
 * `deltaBytes` is the *net* change (new size minus the size being replaced), so
 * shrinking an existing note always passes.
 */
export function checkQuota(
  db: Database.Database,
  user: UserPlanRow,
  deltaBytes: number,
): QuotaCheck {
  const plan = effectivePlan(db, user.plan, user.plan_expires_at);
  const limitBytes = plan.quotaBytes;
  const usedBytes = getUserUsedBytes(db, user.id);
  const ok =
    isUnlimited(limitBytes) || deltaBytes <= 0 || usedBytes + deltaBytes <= limitBytes;
  return { ok, usedBytes, limitBytes, plan: plan.id };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GrantResult {
  plan: PlanId;
  planExpiresAt: string | null;
}

/**
 * Set a user's plan and record it in the subscriptions audit table. Used by both
 * the payment webhook and the admin API.
 *
 * For a non-default plan with a positive `durationDays`, the new expiry extends from the later
 * of *now* or the user's current (still-valid) expiry, so renewals stack cleanly.
 * `durationDays` of `null` or `<= 0` grants a permanent (non-expiring) plan.
 */
export function grantPlan(
  db: Database.Database,
  userId: number,
  plan: PlanId,
  opts: {
    durationDays?: number | null;
    source: 'webhook' | 'admin';
    provider?: string | null;
    providerRef?: string | null;
  },
): GrantResult {
  let expiresAt: string | null = null;
  const config = getPlan(db, plan);
  if (!config) throw new Error(`Unknown plan: ${plan}`);

  if (!config.isDefault) {
    const days = opts.durationDays === undefined ? config.durationDays : opts.durationDays;
    if (days !== null && days > 0) {
      const cur = db
        .prepare('SELECT plan, plan_expires_at FROM users WHERE id = ?')
        .get(userId) as { plan?: string; plan_expires_at?: string | null } | undefined;
      let base = Date.now();
      if (cur && effectivePlan(db, cur.plan, cur.plan_expires_at).id === plan && cur.plan_expires_at) {
        const curExp = new Date(cur.plan_expires_at).getTime();
        if (curExp > base) base = curExp;
      }
      expiresAt = new Date(base + days * DAY_MS).toISOString();
    }
  }

  const txn = db.transaction(() => {
    db.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?').run(plan, expiresAt, userId);
    db.prepare(
      `INSERT INTO subscriptions (user_id, plan, source, provider, provider_ref, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, plan, opts.source, opts.provider ?? null, opts.providerRef ?? null, expiresAt);
  });
  txn();

  return { plan, planExpiresAt: expiresAt };
}
