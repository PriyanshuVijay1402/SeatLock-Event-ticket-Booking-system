/**
 * The full "hold seats" pipeline for one request, in the order a request
 * flows through the system's defenses:
 *
 *   [rate limiter] -> [Redis seat pre-lock] -> [queue | direct] -> [DB tx + row lock / version] -> [UNIQUE constraints]
 *      (HTTP mw)         cheap filter            admission/pacing      correctness                    last line of defense
 *
 * Each layer rejects as much as it can as cheaply as it can, so the expensive
 * layer (Postgres) only sees work that has a real chance of succeeding.
 */
import { config, type CheckoutMode, type LockStrategyName } from '../config';
import { acquireSeatLocks, releaseSeatLocks, type SeatLock } from '../redis/lock';
import { getCheckoutQueue, getQueueEvents, queueDepth } from '../queue/checkoutQueue';
import { holdSeats } from './service';
import type { HoldRequest, HoldResult } from './types';

export type CheckoutOutcome =
  | { kind: 'done'; result: HoldResult }
  | { kind: 'locked' } // Redis says someone else is mid-checkout for a seat
  | { kind: 'shed' } // queue too deep: 503, try again later
  | { kind: 'pending'; jobId: string }; // still queued after waiting; poll for it

export async function requestHold(
  req: HoldRequest,
  opts: { strategy: LockStrategyName; mode: CheckoutMode; useRedisLock: boolean },
): Promise<CheckoutOutcome> {
  // 1) Redis pre-lock. Of 5,000 requests for seat A1, exactly one passes this
  //    line; the rest are answered in well under a millisecond.
  //    (useRedisLock=false is a DEMO switch: it sends the whole herd to the DB
  //    so you can watch the Postgres locks hold the line on their own.)
  let lock: SeatLock | null = null;
  if (opts.useRedisLock) {
    lock = await acquireSeatLocks(req.eventId, req.seatIds, config.redisLockTtlMs);
    if (!lock) return { kind: 'locked' };
  }
  const release = async () => {
    if (lock) await releaseSeatLocks(lock);
  };

  if (opts.mode === 'direct') {
    // 2a) Direct: this API process runs the DB transaction itself. Its only
    //     protection against overload is the pool semaphore (DB_POOL_SIZE).
    try {
      return { kind: 'done', result: await holdSeats(req, opts.strategy) };
    } finally {
      await release();
    }
  }

  // 2b) Queued: admission control first. A bounded queue is better than an
  //     unbounded one: past some depth, requests would time out before being
  //     served anyway, so fail them fast and honestly.
  if ((await queueDepth()) >= config.maxQueueDepth) {
    await release();
    return { kind: 'shed' };
  }

  const job = await getCheckoutQueue().add('hold', { ...req, strategy: opts.strategy, lock });
  try {
    // Wait for a worker to process it. The HTTP connection waiting here costs
    // almost nothing (no DB connection, no thread) — that's the whole point.
    const result = await job.waitUntilFinished(getQueueEvents(), config.queueWaitTimeoutMs);
    return { kind: 'done', result };
  } catch (err) {
    if (err instanceof Error && /timed out/i.test(err.message)) return { kind: 'pending', jobId: job.id! };
    throw err;
  }
}

/** Result of a job that timed out in requestHold (client polls this). */
export async function getHoldJob(jobId: string): Promise<{ state: string; result?: HoldResult; userId?: string }> {
  const job = await getCheckoutQueue().getJob(jobId);
  if (!job) return { state: 'unknown' };
  const state = await job.getState();
  return { state, result: state === 'completed' ? job.returnvalue : undefined, userId: job.data.userId };
}
