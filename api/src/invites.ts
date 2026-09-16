// Invite-link policy: token format, resolution (expiry / revocation / use
// count), the bounded compatibility window for pre-#19 tokens, and the
// dedicated rate limits for the two invite routes a stranger can reach with a
// guessed token.
//
// Threat model: `GET /notes/invite/:token` is unauthenticated and
// `POST /notes/invite/:token/accept` grants collaborator access, so the token
// is a bearer credential. New tokens carry 256 bits of entropy
// (`generateInviteToken`); the rate limits below cap what an enumerator can do
// even against the old 32-bit ones during their grace period.

import type Database from 'better-sqlite3';
import type { Context, Next } from 'hono';
import { timingSafeEqualStrings } from './utils.js';
import { createRateLimiter, clientIp } from './rate-limit.js';
import type { AppEnv } from './env.js';

/** Tokens minted before issue #19 were `randomBytes(4).toString('hex')`. */
const LEGACY_TOKEN_RE = /^[0-9a-f]{8}$/i;

export function isLegacyInviteToken(token: string): boolean {
  return LEGACY_TOKEN_RE.test(token);
}

/**
 * How long already-issued 32-bit invites keep resolving after this server first
 * runs the #19 migration. The deadline is stamped onto each legacy row at
 * migration time, so changing this later doesn't move existing links. `0`
 * retires them immediately.
 */
export function legacyInviteGraceDays(): number {
  const raw = Number.parseInt(process.env.INVITE_LEGACY_GRACE_DAYS ?? '', 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 30;
}

// --- Resolution -------------------------------------------------------------

export interface InviteRow {
  id: number;
  note_id: number;
  created_by_uid: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  token_version: number;
  link_share_id: string | null;
  note_share_id: string;
  title_enc: string | null;
}

export type InviteLookup =
  | { ok: true; invite: InviteRow }
  | { ok: false; status: 404 | 410; error: string; code?: string };

const NOT_FOUND: InviteLookup = { ok: false, status: 404, error: 'Invite not found' };

/**
 * Resolve a token to a usable invite, applying every gate in one place so the
 * public lookup and the authenticated accept agree:
 *
 *   revoked (row deleted) → 404, indistinguishable from never existed
 *   past `expires_at`     → 410
 *   legacy token past its migration deadline → 410 `invite_token_retired`
 *   `used_count >= max_uses` → 410
 */
export function lookupInvite(db: Database.Database, token: string): InviteLookup {
  const row = db.prepare(`
    SELECT il.id, il.token, il.note_id, il.created_by_uid, il.max_uses, il.used_count,
           il.expires_at, il.token_version, il.link_share_id,
           -- datetime() normalizes both the ISO-8601 strings the API writes and
           -- SQLite's own 'YYYY-MM-DD HH:MM:SS' to comparable UTC; a raw string
           -- compare between the two formats is wrong on the expiry day.
           COALESCE(datetime(il.expires_at) <= datetime('now'), 0) AS is_expired,
           COALESCE(datetime(il.legacy_valid_until) > datetime('now'), 0) AS within_legacy_grace,
           n.share_id AS note_share_id, n.title_enc
    FROM invite_links il
    JOIN notes n ON il.note_id = n.id
    WHERE il.token = ?
  `).get(token) as (InviteRow & {
    token: string;
    is_expired: number;
    within_legacy_grace: number;
  }) | undefined;

  // The unique index already did the matching; the explicit constant-time
  // compare keeps "the token is a secret" a local, checkable invariant.
  if (!row || !timingSafeEqualStrings(row.token, token)) return NOT_FOUND;

  if (row.is_expired) return { ok: false, status: 410, error: 'Invite expired' };

  if (row.token_version < 2 && !row.within_legacy_grace) {
    return {
      ok: false,
      status: 410,
      error: 'This invite link uses a retired token format — ask the sender for a new link.',
      code: 'invite_token_retired',
    };
  }

  if (row.used_count >= row.max_uses) {
    return { ok: false, status: 410, error: 'Invite link has been used' };
  }

  return { ok: true, invite: row };
}

// --- Rate limits ------------------------------------------------------------

// A legitimate recipient opens a link a handful of times; these ceilings are far
// above that and far below what enumeration needs.
const LOOKUP_LIMIT = 30;          // per IP per minute, any token
const LEGACY_LOOKUP_LIMIT = 5;    // per IP per minute, 32-bit tokens only
const ACCEPT_LIMIT = 10;          // per IP *and* per account per minute
const WINDOW_MS = 60_000;

const lookupLimiter = createRateLimiter({ name: 'invite-lookup', limit: LOOKUP_LIMIT, windowMs: WINDOW_MS });
const legacyLookupLimiter = createRateLimiter({ name: 'invite-lookup-legacy', limit: LEGACY_LOOKUP_LIMIT, windowMs: WINDOW_MS });
const acceptLimiter = createRateLimiter({ name: 'invite-accept', limit: ACCEPT_LIMIT, windowMs: WINDOW_MS });

function tooMany(c: Context, retryAfter: number) {
  return c.json(
    { error: 'Too many invite requests — try again later', code: 'rate_limited' },
    429,
    { 'Retry-After': String(Math.max(retryAfter, 1)) },
  );
}

/** Guards the unauthenticated `GET /notes/invite/:token`. */
export async function inviteLookupRateLimit(c: Context, next: Next) {
  const ip = clientIp(c);

  const overall = lookupLimiter.check(ip);
  if (!overall.allowed) return tooMany(c, overall.retryAfter);

  // Guessable legacy tokens get a much tighter budget for as long as they live.
  if (isLegacyInviteToken(c.req.param('token') || '')) {
    const legacy = legacyLookupLimiter.check(ip);
    if (!legacy.allowed) return tooMany(c, legacy.retryAfter);
  }

  await next();
}

/** Guards `POST /notes/invite/:token/accept` (runs after auth). */
export async function inviteAcceptRateLimit(c: Context<AppEnv>, next: Next) {
  const uid = c.get('user')?.uid;
  for (const key of [`ip:${clientIp(c)}`, ...(uid ? [`uid:${uid}`] : [])]) {
    const decision = acceptLimiter.check(key);
    if (!decision.allowed) return tooMany(c, decision.retryAfter);
  }
  await next();
}

/** Test hook: drop all invite rate-limit state. */
export function resetInviteRateLimits() {
  lookupLimiter.reset();
  legacyLookupLimiter.reset();
  acceptLimiter.reset();
}
