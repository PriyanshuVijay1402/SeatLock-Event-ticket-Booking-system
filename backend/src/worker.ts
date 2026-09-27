/**
 * Worker process entry point: consumes the checkout queue and runs the hold
 * expiry sweeper. Scale it independently of the API (`--scale worker=2`):
 * total DB concurrency for holds = workers x WORKER_CONCURRENCY.
 */
import { config } from './config';
import { pool } from './db/pool';
import { runMigrations } from './db/migrate';
import { sweepExpiredHolds } from './booking/service';
import { startCheckoutWorker } from './queue/checkoutQueue';

const SWEEP_INTERVAL_MS = 5000;

/** Starts the queue consumer + sweeper. Returns a function that stops both. */
export async function startWorker(): Promise<() => Promise<void>> {
  await runMigrations();
  const worker = startCheckoutWorker();
  console.log(`[worker] consuming checkout queue, concurrency=${config.workerConcurrency}, rate=${config.queueRatePerSec}/s`);

  // Expiry sweeper. Safe to run in every worker replica (FOR UPDATE SKIP LOCKED).
  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const n = await sweepExpiredHolds();
      if (n > 0) console.log(`[sweeper] expired ${n} hold(s)`);
    } catch (err) {
      console.error('[sweeper] error', err);
    } finally {
      sweeping = false;
    }
  }, SWEEP_INTERVAL_MS);

  return async () => {
    clearInterval(timer);
    await worker.close(); // waits for in-flight jobs
  };
}

if (require.main === module) {
  startWorker()
    .then((stopWorker) => {
      const shutdown = async () => {
        console.log('[worker] shutting down (finishing active jobs)');
        await stopWorker();
        await pool.end();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[worker] failed to start', err);
      process.exit(1);
    });
}
