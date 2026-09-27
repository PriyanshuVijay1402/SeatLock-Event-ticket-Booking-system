/**
 * PostgreSQL connection pool.
 *
 * A connection pool is a COUNTING SEMAPHORE in disguise:
 *   - the semaphore's initial value  = `max` (DB_POOL_SIZE)
 *   - pool.connect()                  = P()/wait(): take a permit, or block until one frees up
 *   - client.release()                = V()/signal(): give the permit back
 *
 * Why not just open a connection per request? Each Postgres connection is a
 * whole OS process on the DB server (~5-10 MB RAM, plus context-switch cost).
 * 5,000 simultaneous connections would thrash the DB far worse than 5,000
 * requests politely queueing for 10 connections. See DESIGN.md §5.
 */
import { Pool, types } from 'pg';
import { config } from '../config';

// Return BIGINT (int8) columns as JS numbers. Seat ids are BIGSERIAL but will
// never exceed 2^53 in this project, and numbers are far easier to work with.
types.setTypeParser(types.builtins.INT8, (v) => Number.parseInt(v, 10));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolSize,
  // If all permits are taken for this long, fail instead of waiting forever.
  // In "direct" checkout mode under a ticket drop you will SEE these errors —
  // that is the thundering herd hitting the semaphore. The queue mode avoids it.
  connectionTimeoutMillis: config.dbPoolAcquireTimeoutMs,
  idleTimeoutMillis: 30_000,
  application_name: `ticketing-${process.env.PROCESS_ROLE ?? 'app'}`,
});

pool.on('error', (err) => {
  // Errors on IDLE clients (e.g. DB restarted). Log, don't crash.
  console.error('[pg pool] idle client error', err.message);
});

/** Small helper for one-off queries that don't need a transaction. */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

/** Snapshot of the semaphore state — exposed on /api/health for the demo. */
export function poolStats() {
  return {
    max: config.dbPoolSize,
    total: pool.totalCount, // connections open
    idle: pool.idleCount, // permits available right now
    waiting: pool.waitingCount, // callers blocked in P()
  };
}
