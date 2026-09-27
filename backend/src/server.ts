/**
 * API process entry point. Run as many of these as you like (see
 * docker-compose.yml `api` service, `--scale api=3`).
 */
import type { Server } from 'node:http';
import { config } from './config';
import { pool } from './db/pool';
import { runMigrations } from './db/migrate';
import { createApp } from './http/app';
import { redis } from './redis/client';

/** Starts the HTTP server. Returns a function that stops accepting requests. */
export async function startApi(): Promise<() => Promise<void>> {
  await runMigrations();
  const server: Server = createApp().listen(config.port, () => {
    console.log(
      `[api] listening on :${config.port}  strategy=${config.lockStrategy} mode=${config.checkoutMode} ` +
        `isolation="${config.bookingIsolation}" pool=${config.dbPoolSize}`,
    );
  });
  return () => new Promise((resolve) => server.close(() => resolve()));
}

if (require.main === module) {
  startApi()
    .then((stopApi) => {
      const shutdown = () => {
        console.log('[api] shutting down');
        setTimeout(() => process.exit(1), 5000).unref();
        void stopApi()
          .then(() => Promise.all([pool.end(), redis.quit()]))
          .finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[api] failed to start', err);
      process.exit(1);
    });
}
