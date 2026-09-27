/**
 * Distributed seat lock in Redis — the FIRST line of defense.
 *
 * Pattern: single-instance Redis lock (SET key token NX PX ttl), the building
 * block of Redlock. Extended here to lock SEVERAL seats all-or-nothing with a
 * Lua script, because a customer usually buys adjacent seats together.
 *
 * WHY IN FRONT OF THE DB LOCK, NOT INSTEAD OF IT (DESIGN.md §6):
 *   - In front: during a ticket drop, 5,000 people click the same "best" seat.
 *     Redis answers "already taken" in ~0.1 ms without touching the queue or
 *     a Postgres connection. Only the ONE winner per seat proceeds to the DB.
 *     It's a cheap filter that protects the expensive, scarce resource.
 *   - Not instead: a Redis lock is a LEASE, not a guarantee. It expires after
 *     its TTL even if the holder is still working (GC pause, slow queue), and
 *     a Redis failover can lose a key that was never replicated. Either way
 *     two workers could believe they own the seat. Postgres' row lock / version
 *     check + UNIQUE constraint are what actually make double-booking
 *     impossible. Redis only makes contention cheap.
 */
import { randomUUID } from 'node:crypto';
import { redis } from './client';

/**
 * Keys share a Redis Cluster "hash tag" ({evt:<id>}) so all seats of one event
 * live in the same slot — multi-key Lua scripts require that in Redis Cluster.
 */
function seatLockKey(eventId: string, seatId: number): string {
  return `lock:{evt:${eventId}}:seat:${seatId}`;
}

/**
 * Acquire ALL keys or NONE, atomically (Lua scripts run without interleaving).
 * Returns 1 on success, 0 if any key is already held (nothing is set then).
 * No waiting/retrying: a held seat is an immediate "no" — which also means no
 * deadlocks are possible between two multi-seat requests.
 */
const ACQUIRE_ALL_LUA = `
for i, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then
    return 0
  end
end
for i, key in ipairs(KEYS) do
  redis.call('SET', key, ARGV[1], 'PX', ARGV[2])
end
return 1
`;

/**
 * Release only keys that still hold OUR token. Without this check we could
 * delete a lock that expired and was re-acquired by someone else:
 *   A locks (ttl 30s) -> A stalls 31s -> lock expires -> B locks -> A "releases" B's lock!
 */
const RELEASE_OWNED_LUA = `
local released = 0
for i, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[1] then
    redis.call('DEL', key)
    released = released + 1
  end
end
return released
`;

export interface SeatLock {
  eventId: string;
  seatIds: number[];
  token: string;
}

export async function acquireSeatLocks(
  eventId: string,
  seatIds: number[],
  ttlMs: number,
): Promise<SeatLock | null> {
  const token = randomUUID(); // unique per acquisition = proof of ownership
  const keys = [...seatIds].sort((a, b) => a - b).map((id) => seatLockKey(eventId, id));
  const ok = await redis.eval(ACQUIRE_ALL_LUA, keys.length, ...keys, token, String(ttlMs));
  return ok === 1 ? { eventId, seatIds, token } : null;
}

export async function releaseSeatLocks(lock: SeatLock): Promise<void> {
  const keys = lock.seatIds.map((id) => seatLockKey(lock.eventId, id));
  await redis.eval(RELEASE_OWNED_LUA, keys.length, ...keys, lock.token);
}
