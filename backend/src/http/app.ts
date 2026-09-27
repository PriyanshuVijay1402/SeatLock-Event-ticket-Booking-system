/**
 * Express app wiring. The app is STATELESS: no sessions, no in-memory caches
 * or counters that other replicas would need. Everything shared is in
 * Postgres or Redis, so you can run N copies behind a load balancer.
 */
import cors from 'cors';
import express from 'express';
import { hostname } from 'node:os';
import path from 'node:path';
import { config } from '../config';
import { poolStats } from '../db/pool';
import { getCheckoutQueue } from '../queue/checkoutQueue';
import { parseAuth } from './auth';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { eventsRouter } from './routes/events';
import { holdsRouter } from './routes/holds';
import { errorHandler } from './util';

export function createApp(): express.Express {
  const app = express();
  // Behind a proxy/load balancer, trust X-Forwarded-For so req.ip (used by
  // the per-IP rate limiter) is the real client, not the proxy.
  app.set('trust proxy', true);
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use(parseAuth);

  app.get('/api/health', async (_req, res) => {
    const counts = await getCheckoutQueue().getJobCounts('waiting', 'active', 'completed', 'failed');
    res.json({
      ok: true,
      // Container hostname = which replica answered (useful with --scale api=N).
      instance: hostname(),
      config: {
        lockStrategy: config.lockStrategy,
        checkoutMode: config.checkoutMode,
        bookingIsolation: config.bookingIsolation,
        dbPoolSize: config.dbPoolSize,
        workerConcurrency: config.workerConcurrency,
        holdTtlSeconds: config.holdTtlSeconds,
      },
      dbPool: poolStats(),
      queue: counts,
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', holdsRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint' }));

  // Single-service deployments (RUNNING.md "Deploy for free"): serve the built
  // React app from this process too, so one URL hosts both site and API.
  // In docker-compose nginx does this instead and STATIC_DIR is unset.
  if (process.env.STATIC_DIR) {
    const staticDir = path.resolve(process.env.STATIC_DIR);
    app.use(express.static(staticDir));
    // SPA fallback: any other GET returns index.html; React Router takes it from there.
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(staticDir, 'index.html')) : next()));
  }

  app.use(errorHandler);
  return app;
}
