// Bounded in-memory fixed-window rate limiter.
//
// Deliberately process-local and memory-bounded: expired buckets are swept and
// the map is capped, so a flood of distinct keys (spoofed X-Forwarded-For, many
// UIDs) can't grow it without limit. A multi-instance deployment should still
// put a shared limiter in front of the API — this is the per-process floor that
// makes token guessing infeasible on a single-node install. (issue #19)

import type { Context } from 'hono';

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the current window resets (0 when allowed). */
  retryAfter: number;
}

export interface RateLimiter {
  check(key: string): RateDecision;
  reset(): void;
}

const DEFAULT_MAX_ENTRIES = 10_000;

export function createRateLimiter(opts: {
  /** Shown in the abuse log line. */
  name: string;
  limit: number;
  windowMs: number;
  maxEntries?: number;
}): RateLimiter {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function sweep(now: number) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    // Still full of live buckets → drop the oldest ones. Map iterates in
    // insertion order, so this evicts the least recently created windows.
    if (buckets.size >= maxEntries) {
      const excess = buckets.size - maxEntries + 1;
      let dropped = 0;
      for (const key of buckets.keys()) {
        buckets.delete(key);
        if (++dropped >= excess) break;
      }
    }
  }

  return {
    check(key: string): RateDecision {
      const now = Date.now();
      const bucket = buckets.get(key);

      if (!bucket || bucket.resetAt <= now) {
        if (buckets.size >= maxEntries) sweep(now);
        buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
        return { allowed: true, retryAfter: 0 };
      }

      bucket.count++;
      if (bucket.count > opts.limit) {
        // Abuse monitoring: one line per key per window, not per request.
        if (bucket.count === opts.limit + 1) {
          console.warn(`[rate-limit] ${opts.name} exceeded (${opts.limit}/${opts.windowMs}ms) for ${key}`);
        }
        return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
      }
      return { allowed: true, retryAfter: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}

/**
 * Best-effort caller IP, matching what /auth/register already trusts. Behind a
 * reverse proxy this is the real client; on a directly exposed server the
 * header is client-controlled and the limit is only a speed bump — which is why
 * token entropy, not the limiter, is the primary defense against guessing.
 */
export function clientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('cf-connecting-ip')
    || 'unknown';
}
