import type { Context, Next } from 'hono';
import { clientIp, createRateLimiter } from './rate-limit.js';

const LEGACY_SHARE_ID = /^[0-9a-f]{8}$/i;
const WINDOW_MS = 60_000;

// Kept deliberately above normal editor traffic. These only apply to legacy
// 32-bit IDs; current 128-bit IDs do not touch the limiter at all.
const legacyReadLimiter = createRateLimiter({
  name: 'legacy-share-read',
  limit: 120,
  windowMs: WINDOW_MS,
});
const legacyWriteLimiter = createRateLimiter({
  name: 'legacy-share-write',
  limit: 300,
  windowMs: WINDOW_MS,
});

export async function legacyShareRateLimit(c: Context, next: Next) {
  const shareId = c.req.param('shareId') || '';
  if (!LEGACY_SHARE_ID.test(shareId)) {
    await next();
    return;
  }

  const limiter = c.req.method === 'GET' ? legacyReadLimiter : legacyWriteLimiter;
  const decision = limiter.check(clientIp(c));
  if (!decision.allowed) {
    c.header('Retry-After', String(decision.retryAfter));
    return c.json({ error: 'Too many legacy share requests — please try again shortly' }, 429);
  }
  await next();
}

export function resetLegacyShareRateLimits() {
  legacyReadLimiter.reset();
  legacyWriteLimiter.reset();
}
