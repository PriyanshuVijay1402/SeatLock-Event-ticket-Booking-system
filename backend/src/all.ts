/**
 * API + worker in ONE process — for free hosting tiers that give you a single
 * web service (see RUNNING.md "Deploy for free").
 *
 * Architecturally nothing changes: the API still enqueues jobs in Redis and
 * the worker still pulls them from Redis; they just happen to share a Node
 * process (and its DB pool). For real scale, run server.ts and worker.ts as
 * separate, independently scaled processes instead.
 */
import { pool } from './db/pool';
import { redis } from './redis/client';
import { startApi } from './server';
import { startWorker } from './worker';

async function main() {
  const stopWorker = await startWorker();
  const stopApi = await startApi();

  const shutdown = async () => {
    console.log('[all] shutting down');
    setTimeout(() => process.exit(1), 8000).unref();
    await stopApi();
    await stopWorker();
    await Promise.all([pool.end(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[all] failed to start', err);
  process.exit(1);
});
