/**
 * Best-effort fixed-window rate limiter (per server instance). On Vercel each
 * instance keeps its own counts, so this bounds abuse rather than enforcing an
 * exact global quota — enough to stop one browser from draining the API key.
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
      const t = now();
      if (hits.size > 5_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        hits.set(key, { count: 1, resetAt: t + opts.windowMs });
        return { allowed: true, remaining: opts.limit - 1, retryAfterSec: 0 };
      }
      if (entry.count >= opts.limit) {
        return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((entry.resetAt - t) / 1000) };
      }
      entry.count++;
      return { allowed: true, remaining: opts.limit - entry.count, retryAfterSec: 0 };
    },
  };
}

/** Client IP for rate-limit keys. Vercel sets x-forwarded-for; the first entry is the client. */
export function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}
