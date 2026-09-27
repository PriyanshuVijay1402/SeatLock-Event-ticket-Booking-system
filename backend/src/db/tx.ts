/**
 * Transaction helper with an EXPLICIT isolation level and retry on
 * "try again" errors.
 *
 * We deliberately do not hide this behind an ORM: every BEGIN / isolation
 * level / COMMIT / ROLLBACK is visible here, and the locking SQL lives in
 * src/booking/*.ts.
 */
import type { PoolClient } from 'pg';
import { pool } from './pool';
import type { IsolationLevel } from '../config';

/**
 * Postgres SQLSTATE codes that mean "the transaction lost a race; retrying
 * the WHOLE transaction from the start may succeed".
 *
 *   40001 serialization_failure — SERIALIZABLE / REPEATABLE READ detected that
 *         committing would violate serializability (or a concurrent update hit
 *         a row we read). Postgres aborts one of the contenders.
 *   40P01 deadlock_detected — two transactions each waited on a lock the other
 *         held. Postgres kills one. (We avoid this by locking seats in id
 *         order, but a retry is the correct reaction if it ever happens.)
 */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

export function isRetryablePgError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && RETRYABLE_SQLSTATES.has((err as { code?: string }).code ?? '');
}

export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

export interface TxOptions {
  isolation: IsolationLevel;
  /** Extra attempts after the first one for 40001/40P01 errors. */
  maxRetries?: number;
}

/**
 * Run `fn` inside BEGIN ... COMMIT at the given isolation level.
 *
 *   - Any thrown error => ROLLBACK (all-or-nothing).
 *   - Serialization failures / deadlocks => ROLLBACK, back off, retry fn.
 *
 * `fn` must be safe to re-run (it must not have side effects outside the DB
 * transaction), because a retry re-executes it from scratch.
 */
export async function withTransaction<T>(
  opts: TxOptions,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;

  for (let attempt = 0; ; attempt++) {
    // P() on the pool semaphore — may block until a connection is free.
    const client = await pool.connect();
    try {
      // Isolation level is set as part of BEGIN so it applies to this transaction only.
      await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isRetryablePgError(err) && attempt < maxRetries) {
        // Exponential backoff with full jitter so the losers of a race don't
        // all retry at the same instant and collide again.
        await sleep(Math.random() * 10 * 2 ** attempt);
        continue;
      }
      throw err;
    } finally {
      client.release(); // V() on the pool semaphore
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
