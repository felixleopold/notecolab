import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hashApiKey } from './utils.js';

const SESSION_DAYS = 30;

export interface AccountSession {
  id: string;
  userId: number;
  token: string;
  expiresAt: string;
}

export function createAccountSession(
  db: Database.Database,
  userId: number,
  clientLabel?: string,
): AccountSession {
  db.prepare(`
    DELETE FROM account_sessions
    WHERE (revoked_at IS NOT NULL AND julianday(revoked_at) < julianday('now', '-30 days'))
       OR julianday(expires_at) < julianday('now', '-30 days')
  `).run();
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO account_sessions (id, user_id, token_hash, client_label, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, hashApiKey(token), clientLabel?.slice(0, 80) || null, expiresAt);
  return { id, userId, token, expiresAt };
}

export function revokeAccountSession(db: Database.Database, sessionId: string, userId: number): boolean {
  const result = db.prepare(`
    UPDATE account_sessions SET revoked_at = datetime('now')
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `).run(sessionId, userId);
  return result.changes === 1;
}

export function accountSessionsAvailable(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_sessions'").get();
}
