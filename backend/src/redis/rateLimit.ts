/**
 * Per-user and per-IP rate limiting (fixed window counter in Redis).
 *
 * Algorithm: key = rl:<scope>:<id>:<window-number>. INCR it; the first INCR
 * in a window also sets an expiry. If the count exceeds the limit -> 429.
 *
 * Fixed windows allow a burst of up to 2x the limit across a window boundary
 * (end of one window + start of the next). A sliding-window log or token
 * bucket fixes that at the cost of more Redis work; for "stop one client from
 * hammering the booking endpoint" the fixed window is plenty.
 *
 * Because the counters live in Redis, the limit is enforced GLOBALLY across
 * all API replicas — an in-memory limiter would give each replica its own
 * budget and the effective limit would grow with the number of servers.
 */
import type { NextFunction, Request, Response } from 'express';
import { redis } from './client';
import { config } from '../config';

const INCR_WITH_TTL_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n
`;

async function hit(scope: string, id: string, limit: number): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const windowSec = config.rateLimitWindowSec;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowNo = Math.floor(nowSec / windowSec);
  const key = `rl:${scope}:${id}:${windowNo}`;
  const count = Number(await redis.eval(INCR_WITH_TTL_LUA, 1, key, String(windowSec)));
  return { allowed: count <= limit, retryAfterSec: (windowNo + 1) * windowSec - nowSec };
}

/**
 * Express middleware for booking endpoints. Checks the IP budget first (cheap
 * protection against one machine spraying many fake user ids), then the
 * per-user budget.
 */
export async function bookingRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ip = req.ip ?? 'unknown';
    const ipCheck = await hit('ip', ip, config.rateLimitIpMax);
    const userCheck = req.user ? await hit('user', req.user.id, config.rateLimitUserMax) : { allowed: true, retryAfterSec: 0 };

    const blocked = !ipCheck.allowed ? ipCheck : !userCheck.allowed ? userCheck : null;
    if (blocked) {
      res.setHeader('Retry-After', String(blocked.retryAfterSec));
      res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many booking attempts, slow down.' });
      return;
    }
    next();
  } catch (err) {
    // Fail OPEN: if Redis is down we'd rather serve traffic than block everyone.
    // (The DB-level protections still guarantee correctness.)
    console.error('[rateLimit] redis error, allowing request', err);
    next();
  }
}
