import { Hono } from 'hono';
import { getDb } from '../db/schema.js';
import { generateUid, generateApiKey, hashApiKey, hashPassword, verifyPassword } from '../utils.js';
import { randomBytes, timingSafeEqual } from 'crypto';
import { authMiddleware, optionalAuthMiddleware } from './middleware.js';
import { getQuotaStatus, loadUserPlan, checkQuota } from '../quota.js';
import { registrationMode, verifyInviteCode } from '../access.js';
import { getDefaultPlan } from '../plans.js';
import { normalizeUsername } from '../usernames.js';
import { clientIp, createRateLimiter } from '../rate-limit.js';
import { accountSessionsAvailable, createAccountSession, revokeAccountSession } from '../account-sessions.js';
import {
  callbackDestination,
  createOAuthAttempt,
  fetchProviderSubject,
  getOAuthProvider,
  oauthProviders,
  sha256Base64Url,
  type OAuthClientKind,
  type OAuthIntent,
  type OAuthProviderId,
} from '../oauth.js';

// A wrapped note key is small (an AES key encrypted with the vault key, base64).
// Cap the field and the batch so this table can't be abused to park bulk data
// outside the quota accounting.
const MAX_VAULT_KEY_FIELD = 8 * 1024;
const MAX_VAULT_KEYS_PER_REQUEST = 2000;
import type { AppEnv } from '../env.js';

const auth = new Hono<AppEnv>();

export const REGISTRATION_LIMIT = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const registrationLimiter = createRateLimiter({
  name: 'registration',
  limit: REGISTRATION_LIMIT,
  windowMs: REGISTER_WINDOW_MS,
});
export const OAUTH_START_LIMIT = 20;
const oauthStartLimiter = createRateLimiter({
  name: 'oauth-start',
  limit: OAUTH_START_LIMIT,
  windowMs: 10 * 60 * 1000,
});

/** Test hook: drop all registration rate-limit state. */
export function resetRegistrationRateLimits(): void {
  registrationLimiter.reset();
}

/** Test hook: drop all OAuth start rate-limit state. */
export function resetOAuthStartRateLimits(): void {
  oauthStartLimiter.reset();
}

auth.post('/register', async (c) => {
  // Server-level access control (opt-in; default `open` = today's behavior).
  const mode = registrationMode();
  if (mode === 'closed') {
    return c.json({
      error: 'Registration is closed on this server — ask the server admin to provision an account.',
      code: 'registration_closed',
    }, 403);
  }

  const body = await c.req.json<{ publicKey?: string; inviteCode?: string }>()
    .catch(() => ({} as { publicKey?: string; inviteCode?: string }));

  if (mode === 'invite') {
    const provided = c.req.header('x-registration-secret') || body.inviteCode;
    if (!verifyInviteCode(provided)) {
      return c.json({
        error: 'A valid invite code is required to register on this server.',
        code: 'invite_required',
      }, 403);
    }
  }

  const rateDecision = registrationLimiter.check(clientIp(c));
  if (!rateDecision.allowed) {
    c.header('Retry-After', String(rateDecision.retryAfter));
    return c.json({ error: 'Too many registrations — try again later' }, 429);
  }

  const db = getDb();
  const uid = generateUid();
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);

  db.prepare('INSERT INTO users (uid, api_key_hash, public_key, plan) VALUES (?, ?, ?, ?)')
    .run(uid, keyHash, body.publicKey || null, getDefaultPlan(db).id);

  return c.json({ uid, apiKey });
});

// --- Upload/update public key (authenticated user) ---
auth.post('/public-key', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ publicKey: string }>();
  if (!body.publicKey) {
    return c.json({ error: 'publicKey is required' }, 400);
  }
  const db = getDb();
  db.prepare('UPDATE users SET public_key = ? WHERE uid = ?').run(body.publicKey, user.uid);
  return c.json({ ok: true });
});

// --- Get a user's public key by UID ---
auth.get('/public-key/:uid', async (c) => {
  const uid = c.req.param('uid');
  const db = getDb();
  const row = db.prepare('SELECT public_key, display_name FROM users WHERE uid = ?').get(uid) as any;
  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }
  if (!row.public_key) {
    return c.json({ error: 'User has no public key' }, 404);
  }
  return c.json({ publicKey: row.public_key, displayName: row.display_name });
});

// --- Set password (authenticated user) ---
auth.post('/set-password', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ password: string; displayName?: string | null }>();

  if (!body.password || body.password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }
  const displayName = body.displayName === undefined ? undefined : normalizeUsername(body.displayName);
  if (body.displayName !== undefined && displayName === undefined) {
    return c.json({ error: 'Username must be between 2 and 40 characters' }, 400);
  }

  const db = getDb();
  const passwordHash = hashPassword(body.password);

  // Generate vault_salt if not already set
  const existing = db.prepare('SELECT vault_salt FROM users WHERE uid = ?').get(user.uid) as any;
  const vaultSalt = existing?.vault_salt || randomBytes(32).toString('base64');

  db.transaction(() => {
    if (displayName !== undefined) {
      db.prepare('UPDATE users SET password_hash = ?, display_name = ?, vault_salt = ?, web_api_key_hash = NULL, web_api_key_expires_at = NULL WHERE uid = ?')
        .run(passwordHash, displayName, vaultSalt, user.uid);
    } else {
      db.prepare('UPDATE users SET password_hash = ?, vault_salt = ?, web_api_key_hash = NULL, web_api_key_expires_at = NULL WHERE uid = ?')
        .run(passwordHash, vaultSalt, user.uid);
    }

    // Keep the initiating account session alive so the browser can rewrap and
    // upload its vault keys. Plugin and legacy-web callers revoke every browser
    // session because neither identifies a modern session to preserve.
    db.prepare(`
      UPDATE account_sessions SET revoked_at = datetime('now')
      WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id <> ?)
    `).run(user.id, user.sessionId || null, user.sessionId || null);
  })();

  return c.json({ ok: true, vaultSalt });
});

// --- Login with UID + password (returns API key) ---
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const recoveryLimiter = createRateLimiter({
  name: 'plugin-recovery',
  limit: 10,
  windowMs: 15 * 60 * 1000,
});

auth.post('/login', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('cf-connecting-ip')
    || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= LOGIN_LIMIT) {
      return c.json({ error: 'Too many login attempts — try again later' }, 429);
    }
    entry.count++;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  }

  const body = await c.req.json<{ uid: string; password: string }>();
  if (!body.uid || !body.password) {
    return c.json({ error: 'uid and password are required' }, 400);
  }

  const db = getDb();
  const user = db.prepare('SELECT id, uid, password_hash, display_name, api_key_hash, vault_salt FROM users WHERE uid = ?')
    .get(body.uid) as any;

  if (!user || !user.password_hash) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  if (!verifyPassword(body.password, user.password_hash)) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // Account sessions are independent so signing in on one browser does not
  // invalidate another. Keep a legacy fallback until the account migration is
  // wired into startup on every deployment.
  let newApiKey: string;
  if (accountSessionsAvailable(db)) {
    newApiKey = createAccountSession(db, user.id, 'Password login').token;
  } else {
    newApiKey = generateApiKey();
    const newKeyHash = hashApiKey(newApiKey);
    db.prepare("UPDATE users SET web_api_key_hash = ?, web_api_key_expires_at = datetime('now', '+30 days') WHERE uid = ?")
      .run(newKeyHash, user.uid);
  }

  return c.json({
    uid: user.uid,
    apiKey: newApiKey,
    displayName: user.display_name,
    vaultSalt: user.vault_salt,
  });
});

// --- OAuth discovery and browser handoff ---

auth.get('/oauth/providers', (c) => c.json({
  providers: oauthProviders().map(({ id, name }) => ({ id, name })),
}));

auth.post('/oauth/start', optionalAuthMiddleware, async (c) => {
  if (!accountSessionsAvailable(getDb())) {
    return c.json({ error: 'OAuth account storage is not initialized', code: 'oauth_unavailable' }, 503);
  }
  type OAuthStartBody = {
    provider?: OAuthProviderId;
    intent?: OAuthIntent;
    clientKind?: OAuthClientKind;
    clientProofHash?: string;
    inviteCode?: string;
  };
  const body = await c.req.json<OAuthStartBody>().catch(() => ({} as OAuthStartBody));
  if (!body.provider || !getOAuthProvider(body.provider)) {
    return c.json({ error: 'OAuth provider is not configured', code: 'provider_unavailable' }, 400);
  }
  if (body.intent !== 'login' && body.intent !== 'link') {
    return c.json({ error: 'intent must be login or link' }, 400);
  }
  if (body.clientKind !== 'web' && body.clientKind !== 'plugin') {
    return c.json({ error: 'clientKind must be web or plugin' }, 400);
  }
  if (!body.clientProofHash || !/^[A-Za-z0-9_-]{43}$/.test(body.clientProofHash)) {
    return c.json({ error: 'A SHA-256 client proof challenge is required' }, 400);
  }
  const user = c.get('user');
  if (body.intent === 'link' && !user) {
    return c.json({ error: 'Sign in before linking a provider' }, 401);
  }

  const rate = oauthStartLimiter.check(clientIp(c));
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfter));
    return c.json({ error: 'Too many OAuth attempts, try again later', code: 'oauth_rate_limited' }, 429);
  }

  const bearer = c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1];

  const mode = registrationMode();
  const registrationAllowed = mode === 'open'
    || (mode === 'invite' && verifyInviteCode(body.inviteCode));
  const attempt = createOAuthAttempt(getDb(), {
    provider: body.provider,
    intent: body.intent,
    clientKind: body.clientKind,
    clientProofHash: body.clientProofHash,
    initiatingUserId: user?.id,
    initiatingKeyType: user?.keyType,
    initiatingCredentialHash: bearer ? hashApiKey(bearer) : undefined,
    initiatingSessionId: user?.sessionId,
    registrationAllowed,
    initiatingIp: clientIp(c),
  });
  return c.json(attempt);
});

auth.get('/oauth/callback/:provider', async (c) => {
  const provider = getOAuthProvider(c.req.param('provider'));
  const state = c.req.query('state');
  const code = c.req.query('code');
  if (!provider || !state) return c.text('OAuth callback is incomplete.', 400);

  const db = getDb();
  const attempt = db.prepare(`
    SELECT id, provider, intent, client_kind, code_verifier, initiating_user_id,
      initiating_key_type, initiating_credential_hash, initiating_session_id,
      registration_allowed, initiating_ip
    FROM oauth_attempts
    WHERE state_hash = ? AND provider = ? AND status = 'pending'
      AND julianday(expires_at) > julianday('now')
  `).get(sha256Base64Url(state), provider.id) as {
    id: string;
    provider: OAuthProviderId;
    intent: OAuthIntent;
    client_kind: OAuthClientKind;
    code_verifier: string;
    initiating_user_id: number | null;
    initiating_key_type: 'plugin' | 'web' | 'session' | null;
    initiating_credential_hash: string | null;
    initiating_session_id: string | null;
    registration_allowed: number;
    initiating_ip: string;
  } | undefined;
  if (!attempt) return c.text('This OAuth request is invalid, expired, or already used.', 400);

  const claimed = db.prepare(`
    UPDATE oauth_attempts SET status = 'failed', error_code = 'processing'
    WHERE id = ? AND status = 'pending'
  `).run(attempt.id);
  if (claimed.changes !== 1) return c.text('This OAuth request was already used.', 400);

  const finishFailure = (errorCode: string) => {
    db.prepare("UPDATE oauth_attempts SET error_code = ?, completed_at = datetime('now') WHERE id = ?")
      .run(errorCode, attempt.id);
    const destination = callbackDestination(attempt.client_kind, false);
    return destination ? c.redirect(destination) : c.text('Sign-in failed. Return to Note Colab and try again.', 400);
  };
  if (!code) return finishFailure(c.req.query('error') === 'access_denied' ? 'access_denied' : 'authorization_denied');

  try {
    const subject = await fetchProviderSubject(provider, code, attempt.code_verifier);
    const existing = db.prepare(`
      SELECT user_id FROM account_identities WHERE provider = ? AND provider_subject = ?
    `).get(provider.id, subject) as { user_id: number } | undefined;

    let userId: number;
    if (attempt.intent === 'link') {
      if (!attempt.initiating_user_id) return finishFailure('authentication_required');
      const credentialStillValid = attempt.initiating_key_type === 'plugin'
        ? db.prepare('SELECT 1 FROM users WHERE id = ? AND api_key_hash = ?')
          .get(attempt.initiating_user_id, attempt.initiating_credential_hash)
        : attempt.initiating_key_type === 'web'
          ? db.prepare(`
              SELECT 1 FROM users
              WHERE id = ? AND web_api_key_hash = ?
                AND (web_api_key_expires_at IS NULL OR julianday(web_api_key_expires_at) > julianday('now'))
            `).get(attempt.initiating_user_id, attempt.initiating_credential_hash)
          : attempt.initiating_key_type === 'session'
            ? db.prepare(`
                SELECT 1 FROM account_sessions
                WHERE id = ? AND user_id = ? AND token_hash = ? AND revoked_at IS NULL
                  AND julianday(expires_at) > julianday('now')
              `).get(attempt.initiating_session_id, attempt.initiating_user_id, attempt.initiating_credential_hash)
            : undefined;
      if (!credentialStillValid) return finishFailure('initiating_credential_revoked');
      if (existing && existing.user_id !== attempt.initiating_user_id) {
        return finishFailure('provider_already_linked');
      }
      userId = attempt.initiating_user_id;
      if (!existing) {
        try {
          db.prepare(`
            INSERT INTO account_identities (user_id, provider, provider_subject) VALUES (?, ?, ?)
          `).run(userId, provider.id, subject);
        } catch {
          return finishFailure('provider_already_linked');
        }
      }
    } else if (existing) {
      userId = existing.user_id;
    } else {
      if (!attempt.registration_allowed) {
        return finishFailure(registrationMode() === 'closed' ? 'registration_closed' : 'invite_required');
      }
      const rate = registrationLimiter.check(attempt.initiating_ip);
      if (!rate.allowed) return finishFailure('registration_rate_limited');
      try {
        userId = db.transaction(() => {
          const uid = generateUid();
          const inaccessiblePluginKey = hashApiKey(generateApiKey());
          const createdUserId = Number(db.prepare(`
            INSERT INTO users (uid, api_key_hash, public_key, plan) VALUES (?, ?, NULL, ?)
          `).run(uid, inaccessiblePluginKey, getDefaultPlan(db).id).lastInsertRowid);
          db.prepare(`
            INSERT INTO account_identities (user_id, provider, provider_subject) VALUES (?, ?, ?)
          `).run(createdUserId, provider.id, subject);
          return createdUserId;
        })();
      } catch {
        return finishFailure('provider_already_linked');
      }
    }

    db.prepare(`
      UPDATE oauth_attempts
      SET status = 'complete', error_code = NULL, completed_user_id = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(userId, attempt.id);
    const destination = callbackDestination(attempt.client_kind, true);
    return destination ? c.redirect(destination) : c.text('Account linked. You can return to Note Colab.');
  } catch (error) {
    console.warn('OAuth callback failed:', error instanceof Error ? error.message : error);
    return finishFailure('provider_error');
  }
});

auth.post('/oauth/complete', async (c) => {
  type OAuthCompleteBody = { attemptId?: string; clientProof?: string };
  const body = await c.req.json<OAuthCompleteBody>().catch(() => ({} as OAuthCompleteBody));
  if (!body.attemptId || !body.clientProof) return c.json({ error: 'attemptId and clientProof are required' }, 400);
  const proofHash = sha256Base64Url(body.clientProof);
  const db = getDb();
  const attempt = db.prepare(`
    SELECT id, provider, intent, client_proof_hash, completed_user_id, error_code,
      julianday(expires_at) <= julianday('now') AS expired
    FROM oauth_attempts WHERE id = ?
  `).get(body.attemptId) as {
    id: string;
    provider: OAuthProviderId;
    intent: OAuthIntent;
    client_proof_hash: string;
    completed_user_id: number | null;
    error_code: string | null;
    expired: number;
  } | undefined;
  if (!attempt || attempt.expired
    || attempt.client_proof_hash.length !== proofHash.length
    || !timingSafeEqual(Buffer.from(attempt.client_proof_hash), Buffer.from(proofHash))) {
    return c.json({ error: 'OAuth completion proof is invalid or expired' }, 401);
  }

  const status = db.prepare('SELECT status, error_code FROM oauth_attempts WHERE id = ?').get(attempt.id) as {
    status: 'pending' | 'complete' | 'failed' | 'consumed';
    error_code: string | null;
  };
  if (status.status === 'pending' || status.error_code === 'processing') return c.json({ status: 'pending' }, 202);
  if (status.status === 'failed') return c.json({ error: status.error_code || 'oauth_failed' }, 400);
  if (status.status === 'consumed' || !attempt.completed_user_id) {
    return c.json({ error: 'OAuth completion was already used', code: 'completion_consumed' }, 409);
  }

  if (attempt.intent === 'link') {
    const consumed = db.prepare("UPDATE oauth_attempts SET status = 'consumed' WHERE id = ? AND status = 'complete'")
      .run(attempt.id);
    if (consumed.changes !== 1) {
      return c.json({ error: 'OAuth completion was already used', code: 'completion_consumed' }, 409);
    }
    return c.json({ ok: true, linkedProvider: attempt.provider });
  }

  const user = db.prepare(`
    SELECT uid, display_name, password_hash IS NOT NULL AS has_password, vault_salt IS NOT NULL AS has_vault
    FROM users WHERE id = ?
  `).get(attempt.completed_user_id) as {
    uid: string;
    display_name: string | null;
    has_password: number;
    has_vault: number;
  };
  const result = db.transaction(() => {
    const consumed = db.prepare("UPDATE oauth_attempts SET status = 'consumed' WHERE id = ? AND status = 'complete'")
      .run(attempt.id);
    if (consumed.changes !== 1) return null;
    return createAccountSession(db, attempt.completed_user_id!, `${attempt.provider} OAuth`);
  })();
  if (!result) return c.json({ error: 'OAuth completion was already used', code: 'completion_consumed' }, 409);
  return c.json({
    ok: true,
    uid: user.uid,
    apiKey: result.token,
    displayName: user.display_name,
    hasPassword: !!user.has_password,
    vaultLocked: !!user.has_vault,
  });
});

// --- Transfer the account to a replacement plugin installation ---
//
// This deliberately keeps a single active plugin credential. Recovering the
// account rotates that credential and public key while preserving the user row,
// notes, storage plan, vault keys, collaborators, and billing history.
auth.post('/recover-plugin', async (c) => {
  const body = await c.req.json<{ uid?: string; password?: string; publicKey?: string }>()
    .catch(() => ({} as { uid?: string; password?: string; publicKey?: string }));
  if (typeof body.uid !== 'string' || typeof body.password !== 'string'
    || typeof body.publicKey !== 'string' || !body.uid || !body.password || !body.publicKey) {
    return c.json({ error: 'uid, password, and publicKey are required' }, 400);
  }
  if (body.uid.length > 128 || body.password.length > 1024 || body.publicKey.length > 256) {
    return c.json({ error: 'Recovery credentials are too large' }, 400);
  }

  const attemptKey = `${clientIp(c)}:${body.uid}`;
  const rate = recoveryLimiter.check(attemptKey);
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfter));
    return c.json({ error: 'Too many recovery attempts — try again later' }, 429);
  }

  const db = getDb();
  const user = db.prepare(`
    SELECT id, uid, password_hash, display_name, vault_salt
    FROM users WHERE uid = ?
  `).get(body.uid) as {
    id: number;
    uid: string;
    password_hash: string | null;
    display_name: string | null;
    vault_salt: string | null;
  } | undefined;

  // Keep account existence and recovery setup indistinguishable to callers.
  if (!user?.password_hash || !verifyPassword(body.password, user.password_hash)) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  db.prepare('UPDATE users SET api_key_hash = ?, public_key = ? WHERE id = ?')
    .run(keyHash, body.publicKey, user.id);

  return c.json({
    uid: user.uid,
    apiKey,
    displayName: user.display_name,
    vaultSalt: user.vault_salt,
  });
});

// --- Get current user profile ---
auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = getDb();
  const profile = db.prepare('SELECT uid, display_name, password_hash IS NOT NULL as has_password, vault_salt, created_at FROM users WHERE uid = ?')
    .get(user.uid) as any;

  const status = getQuotaStatus(db, loadUserPlan(db, user.id));

  return c.json({
    uid: profile.uid,
    displayName: profile.display_name,
    hasPassword: !!profile.has_password,
    hasVaultKeys: !!profile.vault_salt,
    createdAt: profile.created_at,
    plan: status.plan,
    planExpiresAt: status.planExpiresAt,
    storage: {
      usedBytes: status.usedBytes,
      limitBytes: status.limitBytes,
      unlimited: status.unlimited,
      usagePercent: status.usagePercent,
    },
  });
});

// OAuth proves account ownership, not knowledge of the vault password. This
// endpoint releases the existing salt only after the signed-in user supplies
// that password, allowing the browser to derive the vault key locally.
auth.post('/unlock', authMiddleware, async (c) => {
  type UnlockBody = { password?: string };
  const body = await c.req.json<UnlockBody>().catch(() => ({} as UnlockBody));
  if (!body.password || body.password.length > 1024) return c.json({ error: 'Password is required' }, 400);
  const row = getDb().prepare('SELECT password_hash, vault_salt FROM users WHERE id = ?').get(c.get('user').id) as {
    password_hash: string | null;
    vault_salt: string | null;
  } | undefined;
  if (!row?.password_hash || !verifyPassword(body.password, row.password_hash)) {
    return c.json({ error: 'Invalid password' }, 401);
  }
  return c.json({ vaultSalt: row.vault_salt });
});

auth.get('/identities', authMiddleware, (c) => {
  if (!accountSessionsAvailable(getDb())) return c.json({ providers: [] });
  const rows = getDb().prepare(`
    SELECT provider, created_at FROM account_identities WHERE user_id = ? ORDER BY provider
  `).all(c.get('user').id) as { provider: string; created_at: string }[];
  return c.json({ providers: rows.map((row) => ({ provider: row.provider, linkedAt: row.created_at })) });
});

auth.delete('/identities/:provider', authMiddleware, (c) => {
  const user = c.get('user');
  const provider = c.req.param('provider');
  if (provider !== 'google' && provider !== 'github') return c.json({ error: 'Unknown provider' }, 404);
  const db = getDb();
  const account = db.prepare(`
    SELECT password_hash IS NOT NULL AS has_password,
      (SELECT COUNT(*) FROM account_identities WHERE user_id = users.id) AS identity_count
    FROM users WHERE id = ?
  `).get(user.id) as { has_password: number; identity_count: number };
  if (user.keyType !== 'plugin' && !account.has_password && account.identity_count <= 1) {
    return c.json({ error: 'Add another sign-in method or a password before removing the only provider' }, 409);
  }
  const removed = db.prepare('DELETE FROM account_identities WHERE user_id = ? AND provider = ?')
    .run(user.id, provider);
  if (!removed.changes) return c.json({ error: 'Provider is not linked' }, 404);
  return c.json({ ok: true });
});

auth.get('/sessions', authMiddleware, (c) => {
  const user = c.get('user');
  if (!accountSessionsAvailable(getDb())) return c.json({ sessions: [] });
  const sessions = getDb().prepare(`
    SELECT id, client_label, created_at, last_used_at, expires_at
    FROM account_sessions
    WHERE user_id = ? AND revoked_at IS NULL AND julianday(expires_at) > julianday('now')
    ORDER BY created_at DESC
  `).all(user.id) as {
    id: string;
    client_label: string | null;
    created_at: string;
    last_used_at: string;
    expires_at: string;
  }[];
  return c.json({ sessions: sessions.map((session) => ({
    id: session.id,
    clientLabel: session.client_label,
    createdAt: session.created_at,
    lastUsedAt: session.last_used_at,
    expiresAt: session.expires_at,
    current: session.id === user.sessionId,
  })) });
});

auth.delete('/sessions/:id', authMiddleware, (c) => {
  const sessionId = c.req.param('id');
  if (!sessionId || !revokeAccountSession(getDb(), sessionId, c.get('user').id)) {
    return c.json({ error: 'Session not found' }, 404);
  }
  return c.json({ ok: true });
});

// --- Set or remove the public username shown for UID lookups ---
auth.patch('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ username?: string | null }>()
    .catch(() => ({} as { username?: string | null }));
  const username = normalizeUsername(body.username);
  if (username === undefined) {
    return c.json({ error: 'Username must be between 2 and 40 characters' }, 400);
  }
  const db = getDb();
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(username, user.id);
  return c.json({ ok: true, username });
});

// --- Logout web session ---
auth.post('/logout', authMiddleware, async (c) => {
  const user = c.get('user');
  if (user.keyType === 'session' && user.sessionId) {
    revokeAccountSession(getDb(), user.sessionId, user.id);
    return c.json({ ok: true });
  }
  if (user.keyType !== 'web') {
    return c.json({ error: 'Plugin API keys are account credentials and cannot be logged out' }, 400);
  }

  const db = getDb();
  db.prepare('UPDATE users SET web_api_key_hash = NULL, web_api_key_expires_at = NULL WHERE id = ?')
    .run(user.id);
  return c.json({ ok: true });
});

// --- Rotate plugin identity key ---
auth.post('/rotate-key', authMiddleware, async (c) => {
  const user = c.get('user');
  if (user.keyType !== 'plugin') {
    return c.json({ error: 'Only the plugin identity key can rotate itself' }, 403);
  }

  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const db = getDb();
  db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(keyHash, user.id);
  return c.json({ apiKey });
});

// --- Vault keys: encrypted note AES keys for web dashboard ---

// GET /vault-keys — list all encrypted keys for the current user
auth.get('/vault-keys', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = getDb();
  const userId = (db.prepare('SELECT id FROM users WHERE uid = ?').get(user.uid) as any)?.id;
  if (!userId) return c.json({ error: 'User not found' }, 404);

  const keys = db.prepare(
    'SELECT note_share_id, encrypted_key FROM vault_keys WHERE user_id = ?'
  ).all(userId) as { note_share_id: string; encrypted_key: string }[];

  return c.json({ keys });
});

// POST /vault-keys — bulk upsert encrypted keys
auth.post('/vault-keys', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ keys: { noteShareId: string; encryptedKey: string }[] }>();

  if (!body.keys || !Array.isArray(body.keys)) {
    return c.json({ error: 'keys array is required' }, 400);
  }
  if (body.keys.length > MAX_VAULT_KEYS_PER_REQUEST) {
    return c.json({ error: `Too many keys (max ${MAX_VAULT_KEYS_PER_REQUEST})` }, 400);
  }

  const db = getDb();
  const userId = (db.prepare('SELECT id FROM users WHERE uid = ?').get(user.uid) as any)?.id;
  if (!userId) return c.json({ error: 'User not found' }, 404);

  // Validate each row and bound field sizes so wrapped keys stay small.
  let addedBytes = 0;
  for (const k of body.keys) {
    if (!k?.noteShareId || typeof k.noteShareId !== 'string' || k.noteShareId.length > 128) {
      return c.json({ error: 'Each key needs a valid noteShareId' }, 400);
    }
    if (!k.encryptedKey || typeof k.encryptedKey !== 'string' || k.encryptedKey.length > MAX_VAULT_KEY_FIELD) {
      return c.json({ error: 'encryptedKey missing or too large' }, 400);
    }
    addedBytes += k.encryptedKey.length;
  }

  // Vault-key storage now counts toward the quota; block growth over limit.
  const vkQuota = checkQuota(db, loadUserPlan(db, userId), addedBytes);
  if (!vkQuota.ok) {
    return c.json({ error: 'Storage limit reached — free up space or check whether this server offers upgrades.', code: 'quota_exceeded' }, 413);
  }

  const upsert = db.prepare(`
    INSERT INTO vault_keys (user_id, note_share_id, encrypted_key)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, note_share_id) DO UPDATE SET encrypted_key = excluded.encrypted_key
  `);

  const insertMany = db.transaction((keys: { noteShareId: string; encryptedKey: string }[]) => {
    for (const k of keys) {
      upsert.run(userId, k.noteShareId, k.encryptedKey);
    }
  });

  insertMany(body.keys);
  return c.json({ ok: true, count: body.keys.length });
});

// DELETE /vault-keys — clear all vault keys (for password change re-encryption)
auth.delete('/vault-keys', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = getDb();
  const userId = (db.prepare('SELECT id FROM users WHERE uid = ?').get(user.uid) as any)?.id;
  if (!userId) return c.json({ error: 'User not found' }, 404);

  db.prepare('DELETE FROM vault_keys WHERE user_id = ?').run(userId);
  return c.json({ ok: true });
});

export default auth;
