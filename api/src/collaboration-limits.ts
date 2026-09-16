import type Database from 'better-sqlite3';
import { effectivePlan } from './plans.js';

/** Called after the base plans/users migration. Existing accounts retain access. */
export function migratePlanLimits(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(plans)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'collaborator_limit')) {
    db.transaction(() => {
      db.exec('ALTER TABLE plans ADD COLUMN collaborator_limit INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE users ADD COLUMN collaborator_limit_override INTEGER DEFAULT NULL');
      db.exec('UPDATE users SET collaborator_limit_override = 0');
      db.prepare("UPDATE plans SET collaborator_limit = 5 WHERE id = 'free'").run();
      db.prepare("UPDATE plans SET collaborator_limit = 10 WHERE id = 'basic'").run();
      db.prepare("UPDATE plans SET collaborator_limit = 20 WHERE id = 'pro'").run();
    })();
  }
}

/** Distinct named recipients across the owner's notes. Public link readers do not use seats. */
export function checkCollaboratorCapacity(db: Database.Database, ownerId: number, additions: string[], replacingNoteId?: number) {
  const owner = db.prepare('SELECT uid, plan, plan_expires_at, collaborator_limit_override FROM users WHERE id = ?')
    .get(ownerId) as { uid: string; plan: string; plan_expires_at: string | null; collaborator_limit_override: number | null };
  const plan = effectivePlan(db, owner.plan, owner.plan_expires_at);
  const limit = owner.collaborator_limit_override ?? plan.collaboratorLimit;
  const rows = db.prepare(`SELECT DISTINCT c.user_uid FROM collaborators c
    JOIN notes n ON n.id = c.note_id WHERE n.user_id = ? AND c.user_uid <> ?`).all(ownerId, owner.uid) as { user_uid: string }[];
  const existing = new Set(rows.map((row) => row.user_uid));
  const retained = replacingNoteId === undefined ? existing : new Set((db.prepare(`SELECT DISTINCT c.user_uid FROM collaborators c
    JOIN notes n ON n.id = c.note_id WHERE n.user_id = ? AND n.id <> ? AND c.user_uid <> ?`)
    .all(ownerId, replacingNoteId, owner.uid) as { user_uid: string }[]).map((row) => row.user_uid));
  const next = new Set([...retained, ...additions.filter((uid) => uid !== owner.uid)]);
  return {
    ok: limit <= 0 || next.size <= limit || next.size <= existing.size,
    limit,
    used: existing.size,
    requested: next.size,
    plan: plan.id,
  };
}

export function collaboratorLimitError(result: ReturnType<typeof checkCollaboratorCapacity>) {
  return {
    error: `This plan includes ${result.limit} named collaborators. Remove a collaborator or choose a larger plan.`,
    code: 'collaborator_limit',
    limit: result.limit,
    used: result.used,
    requested: result.requested,
    plan: result.plan,
  };
}
