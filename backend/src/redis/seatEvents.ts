/**
 * Seat-map read cache + change notifications.
 *
 * READ PATH (cache-aside): GET /events/:id/seats first looks in Redis. On a
 * miss it queries Postgres and stores the result for a couple of seconds.
 * During a ticket drop 10,000 browsers may refresh the same seat map; with a
 * 2s TTL Postgres sees ~0.5 queries/second for that event instead of
 * thousands. Correctness never depends on this cache: the booking path always
 * re-checks seat state under a lock in Postgres.
 *
 * WRITE PATH: whenever seats change we (1) delete the cache entry so the next
 * read is fresh and (2) PUBLISH on a Redis channel. Every API replica is
 * subscribed and forwards the event to its own SSE clients — that's how a
 * browser connected to replica A learns about a booking made on replica B.
 */
import { redis, getSubscriber } from './client';
import { config } from '../config';

const CHANNEL = 'seats:changed';
const cacheKey = (eventId: string) => `cache:seats:${eventId}`;

export async function getCachedSeats<T>(eventId: string, load: () => Promise<T>): Promise<{ data: T; cache: 'hit' | 'miss' }> {
  const cached = await redis.get(cacheKey(eventId));
  if (cached) return { data: JSON.parse(cached) as T, cache: 'hit' };
  const data = await load();
  await redis.set(cacheKey(eventId), JSON.stringify(data), 'EX', config.seatCacheTtlSec);
  return { data, cache: 'miss' };
}

/** Call after ANY committed change to seats of an event. */
export async function seatsChanged(eventId: string): Promise<void> {
  await redis.del(cacheKey(eventId));
  await redis.publish(CHANNEL, eventId);
}

type Listener = (eventId: string) => void;
const listeners = new Set<Listener>();
let subscribed = false;

/** Register an in-process listener; the first call subscribes to Redis. */
export function onSeatsChanged(listener: Listener): () => void {
  if (!subscribed) {
    subscribed = true;
    const sub = getSubscriber();
    void sub.subscribe(CHANNEL);
    sub.on('message', (_channel: string, eventId: string) => {
      for (const l of listeners) l(eventId);
    });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}
