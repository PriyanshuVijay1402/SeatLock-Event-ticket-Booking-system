import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { isRetryablePgError } from '../db/tx';
import { CHECKOUT_MODES, LOCK_STRATEGIES, config, type CheckoutMode, type LockStrategyName } from '../config';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a UUID path param before it reaches Postgres (avoids 22P02 errors). */
export function uuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new HttpError(404, 'NOT_FOUND', `Unknown ${name}`);
  return value;
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

/**
 * DEMO KNOBS: the ticket-drop script compares strategies/modes by sending
 * these headers. In a real system you'd pick one and not expose this.
 */
export function strategyFor(req: Request): LockStrategyName {
  const h = req.header('x-lock-strategy') as LockStrategyName | undefined;
  return h && LOCK_STRATEGIES.includes(h) ? h : config.lockStrategy;
}
export function modeFor(req: Request): CheckoutMode {
  const h = req.header('x-checkout-mode') as CheckoutMode | undefined;
  return h && CHECKOUT_MODES.includes(h) ? h : config.checkoutMode;
}

/** X-Redis-Lock: off  -> skip the Redis pre-lock (demo only; DB locks still apply). */
export function redisLockFor(req: Request): boolean {
  return req.header('x-redis-lock') !== 'off';
}

/** Final error handler: known errors -> clean JSON, pool exhaustion -> 503, rest -> 500. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  // pg-pool's error when no connection frees up within connectionTimeoutMillis:
  // the semaphore stayed at zero too long. That's overload, not a bug -> 503.
  if (/timeout exceeded when trying to connect/i.test(message)) {
    res.setHeader('Retry-After', '1');
    res.status(503).json({ error: 'DB_OVERLOADED', message: 'All database connections are busy. Retry shortly.' });
    return;
  }
  // Serialization failure / deadlock that survived all retries: contention,
  // not a bug. Nothing was committed, so the client can safely retry.
  if (isRetryablePgError(err)) {
    res.setHeader('Retry-After', '1');
    res.status(409).json({ error: 'TX_CONFLICT', message: 'High contention, nothing was saved. Please retry.' });
    return;
  }
  console.error('[http] unhandled error', err);
  res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong.' });
}
