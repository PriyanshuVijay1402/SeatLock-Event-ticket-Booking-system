/**
 * Queue-based checkout — taming the thundering herd (DESIGN.md §5).
 *
 * OS analogy:
 *   - HTTP requests arriving during a ticket drop  = processes becoming READY
 *   - this Redis-backed queue                        = the scheduler's ready queue
 *   - worker processes x WORKER_CONCURRENCY          = CPU cores (dispatch slots)
 *   - DB connection pool                             = a counting semaphore guarding
 *                                                      the contended resource (Postgres)
 *   - the limiter (QUEUE_RATE_PER_SEC)                = a scheduler time budget
 *   - MAX_QUEUE_DEPTH -> 503                          = admission control: refuse new
 *                                                      work rather than thrash
 *
 * Without the queue, 5,000 simultaneous requests would all try to grab one of
 * 10 DB connections at once: most time out, lock waits pile up, latency
 * explodes (like an OS thrashing when too many processes compete for RAM).
 * With the queue, the DB sees a steady, bounded stream of work it can actually
 * complete, and excess requests wait cheaply in Redis (FIFO) instead.
 */
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import type { LockStrategyName } from '../config';
import { config } from '../config';
import { newRedisConnection } from '../redis/client';
import { releaseSeatLocks, type SeatLock } from '../redis/lock';
import { holdSeats } from '../booking/service';
import type { HoldResult } from '../booking/types';

export const CHECKOUT_QUEUE = 'checkout-holds';

export interface HoldJobData {
  eventId: string;
  userId: string;
  seatIds: number[];
  strategy: LockStrategyName;
  /** Redis pre-lock taken by the API; the worker releases it when done. */
  lock: SeatLock | null;
}

let queue: Queue<HoldJobData, HoldResult> | undefined;
let queueEvents: QueueEvents | undefined;

/** Producer side (API process). */
export function getCheckoutQueue(): Queue<HoldJobData, HoldResult> {
  queue ??= new Queue<HoldJobData, HoldResult>(CHECKOUT_QUEUE, {
    connection: newRedisConnection('queue-producer'),
    defaultJobOptions: {
      attempts: 1, // business failures are RESULTS, not errors; don't retry them
      removeOnComplete: { age: 300, count: 10_000 },
      removeOnFail: { age: 3600 },
    },
  });
  return queue;
}

/** Completion notifications, so the API can await a job's result. */
export function getQueueEvents(): QueueEvents {
  queueEvents ??= new QueueEvents(CHECKOUT_QUEUE, { connection: newRedisConnection('queue-events') });
  return queueEvents;
}

/** How many jobs are waiting to be dispatched (for admission control). */
export async function queueDepth(): Promise<number> {
  return getCheckoutQueue().getWaitingCount();
}

/**
 * Consumer side (worker process). `concurrency` jobs run in parallel per
 * process; the limiter caps dispatch rate across ALL worker processes because
 * its counter lives in Redis.
 */
export function startCheckoutWorker(): Worker<HoldJobData, HoldResult> {
  const worker = new Worker<HoldJobData, HoldResult>(
    CHECKOUT_QUEUE,
    async (job: Job<HoldJobData, HoldResult>) => {
      const { eventId, userId, seatIds, strategy, lock } = job.data;
      try {
        return await holdSeats({ eventId, userId, seatIds }, strategy);
      } finally {
        // The DB now holds the truth (seat is HELD or not); drop the pre-lock.
        if (lock) await releaseSeatLocks(lock);
      }
    },
    {
      connection: newRedisConnection('queue-worker'),
      // Keep concurrency <= DB pool size: extra concurrency would only wait on
      // the pool semaphore while holding a job lease.
      concurrency: config.workerConcurrency,
      limiter: { max: config.queueRatePerSec, duration: 1000 },
    },
  );
  worker.on('failed', (job, err) => console.error(`[worker] job ${job?.id} failed:`, err.message));
  return worker;
}
