import type { Context, Next } from 'hono';
import { getDb } from '../db/schema.js';
import { hashApiKey } from '../utils.js';
import { accountSessionsAvailable } from '../account-sessions.js';

export interface AuthUser {
  id: number;
  uid: string;
  keyType?: 'plugin' | 'web' | 'session';
  sessionId?: string;
}

export type AuthLookupResult =
  | { ok: true; user: AuthUser }
  | { ok: false; expired: true }
  | { ok: false; expired: false };

export function lookupAuthUser(apiKey: string): AuthLookupResult {
  const keyHash = hashApiKey(apiKey);
  const db = getDb();
  const row = db.prepare(`
    SELECT id, uid, api_key_hash, web_api_key_hash, web_api_key_expires_at
    FROM users
    WHERE api_key_hash = ? OR web_api_key_hash = ?
  `).get(keyHash, keyHash) as {
    id: number;
    uid: string;
    api_key_hash: string;
    web_api_key_hash: string | null;
    web_api_key_expires_at: string | null;
  } | undefined;

  if (!row && accountSessionsAvailable(db)) {
    const session = db.prepare(`
      SELECT s.id AS session_id, s.user_id AS id, u.uid,
        s.revoked_at, s.expires_at,
        julianday(s.expires_at) <= julianday('now') AS expired
      FROM account_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(keyHash) as {
      session_id: string;
      id: number;
      uid: string;
      revoked_at: string | null;
      expires_at: string;
      expired: number;
    } | undefined;
    if (!session || session.revoked_at) return { ok: false, expired: false };
    if (session.expired) return { ok: false, expired: true };
    return {
      ok: true,
      user: { id: session.id, uid: session.uid, keyType: 'session', sessionId: session.session_id },
    };
  }

  if (!row) return { ok: false, expired: false };

  if (row.web_api_key_hash === keyHash && row.api_key_hash !== keyHash) {
    if (row.web_api_key_expires_at) {
      const expired = db.prepare("SELECT ? <= datetime('now') AS expired")
        .get(row.web_api_key_expires_at) as { expired: number };
      if (expired.expired) return { ok: false, expired: true };
    }
    return { ok: true, user: { id: row.id, uid: row.uid, keyType: 'web' } };
  }

  return { ok: true, user: { id: row.id, uid: row.uid, keyType: 'plugin' } };
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const result = lookupAuthUser(authHeader.slice(7));

  if (!result.ok) {
    if (result.expired) {
      return c.json({ error: 'Session expired — please log in again', code: 'session_expired' }, 401);
    }
    return c.json({ error: 'Invalid API key' }, 401);
  }

  // Record real authenticated use without writing on every sync request.
  getDb().prepare(`
    UPDATE users SET last_seen_at = datetime('now')
    WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-15 minutes'))
  `).run(result.user.id);
  if (result.user.sessionId) {
    getDb().prepare(`
      UPDATE account_sessions SET last_used_at = datetime('now')
      WHERE id = ? AND last_used_at < datetime('now', '-15 minutes')
    `).run(result.user.sessionId);
  }
  c.set('user', result.user);
  await next();
}

export async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const result = lookupAuthUser(authHeader.slice(7));
    if (result.ok) {
      c.set('user', result.user);
    }
  }
  await next();
}
