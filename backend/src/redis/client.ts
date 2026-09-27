/**
 * Shared Redis connections.
 *
 * Redis is where ALL cross-request state lives (locks, rate-limit counters,
 * idempotency records, the job queue, the seat cache). Because none of that
 * state is in the Node process's memory, any API replica can serve any
 * request — which is what makes the API horizontally scalable.
 */
import { Redis } from 'ioredis';
import { config } from '../config';

function makeClient(name: string): Redis {
  const client = new Redis(config.redisUrl, {
    // Required by BullMQ for blocking connections; harmless for the others.
    maxRetriesPerRequest: null,
    connectionName: name,
  });
  client.on('error', (err) => console.error(`[redis:${name}]`, err.message));
  return client;
}

/** General-purpose commands (locks, rate limits, cache, idempotency, publish). */
export const redis = makeClient('main');

/**
 * A SUBSCRIBE-mode connection can't run normal commands, so pub/sub listeners
 * get their own lazily-created connection.
 */
let subscriber: Redis | undefined;
export function getSubscriber(): Redis {
  subscriber ??= makeClient('subscriber');
  return subscriber;
}

/** New dedicated connection (BullMQ Worker/QueueEvents need their own). */
export function newRedisConnection(name: string): Redis {
  return makeClient(name);
}
