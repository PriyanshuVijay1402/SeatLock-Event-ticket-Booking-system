/**
 * Central configuration, read once from environment variables.
 *
 * Every knob that affects concurrency behaviour lives here so you can flip it
 * (in docker-compose.yml or your shell) and re-run the ticket drop to compare.
 */

export type LockStrategyName = 'pessimistic' | 'optimistic';
export type CheckoutMode = 'queue' | 'direct';
export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got "${raw}"`);
  return n;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[name] ?? fallback) as T;
  if (!allowed.includes(raw)) {
    throw new Error(`Env var ${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw;
}

export const LOCK_STRATEGIES = ['pessimistic', 'optimistic'] as const;
export const CHECKOUT_MODES = ['queue', 'direct'] as const;
export const ISOLATION_LEVELS = ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'] as const;

export const config = {
  port: int('PORT', 4000),
  databaseUrl: str('DATABASE_URL', 'postgres://ticketing:ticketing@localhost:5432/ticketing'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),

  /** Default seat-locking strategy (can be overridden per request for demos). */
  lockStrategy: oneOf<LockStrategyName>('LOCK_STRATEGY', LOCK_STRATEGIES, 'pessimistic'),
  /** queue = hold requests go through BullMQ; direct = API hits the DB itself. */
  checkoutMode: oneOf<CheckoutMode>('CHECKOUT_MODE', CHECKOUT_MODES, 'queue'),
  /** Isolation level for booking transactions. See DESIGN.md §3. */
  bookingIsolation: oneOf<IsolationLevel>('BOOKING_ISOLATION', ISOLATION_LEVELS, 'READ COMMITTED'),

  /**
   * Max DB connections PER PROCESS. The pool is a counting semaphore:
   * at most this many queries run concurrently from this process.
   * Total connections = DB_POOL_SIZE x number of processes; keep that under
   * Postgres' max_connections (100 by default). See DESIGN.md §5.
   */
  dbPoolSize: int('DB_POOL_SIZE', 10),
  /** How long a request may wait for a free connection before erroring. */
  dbPoolAcquireTimeoutMs: int('DB_POOL_ACQUIRE_TIMEOUT_MS', 5000),

  /** Parallel jobs per worker process. Must be <= dbPoolSize (else jobs just wait on the pool). */
  workerConcurrency: int('WORKER_CONCURRENCY', 8),
  /** Global dispatch rate across ALL workers (BullMQ limiter lives in Redis). */
  queueRatePerSec: int('QUEUE_RATE_PER_SEC', 500),
  /** Load shedding: reject with 503 when this many jobs are already waiting. */
  maxQueueDepth: int('MAX_QUEUE_DEPTH', 5000),
  /** How long the API waits for a queued job before answering 202 + jobId. */
  queueWaitTimeoutMs: int('QUEUE_WAIT_TIMEOUT_MS', 20000),

  /** How long a seat hold lasts before the sweeper releases it. */
  holdTtlSeconds: int('HOLD_TTL_SECONDS', 300),
  /** TTL of the Redis pre-lock; must cover queue wait + DB transaction. */
  redisLockTtlMs: int('REDIS_LOCK_TTL_MS', 30000),
  /**
   * Max retries for optimistic conflicts and 40001/40P01 errors. SERIALIZABLE
   * needs a generous budget: its predicate locks produce false-positive aborts
   * when many transactions touch the same index pages (see DESIGN.md §3).
   */
  maxTxRetries: int('MAX_TX_RETRIES', 5),

  rateLimitWindowSec: int('RATE_LIMIT_WINDOW_SEC', 10),
  rateLimitUserMax: int('RATE_LIMIT_USER_MAX', 20),
  /** High by default because the load test sends everything from one IP. */
  rateLimitIpMax: int('RATE_LIMIT_IP_MAX', 10000),

  /** Seat-map cache TTL. Short: correctness never depends on it, only load does. */
  seatCacheTtlSec: int('SEAT_CACHE_TTL_SEC', 2),
  /** Mock payment provider: simulated network latency. */
  mockPaymentLatencyMs: int('MOCK_PAYMENT_LATENCY_MS', 150),
} as const;

export type AppConfig = typeof config;
