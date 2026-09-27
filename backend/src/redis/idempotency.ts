/**
 * Idempotency keys for POST /holds/:id/confirm (DESIGN.md §7).
 *
 * The client generates a random key ONCE per checkout attempt and sends it on
 * every retry of that attempt (header `Idempotency-Key`). The server promises:
 * "the same key produces the same effect and the same response, at most once".
 *
 * Two layers:
 *   1. Redis (this file) — fast path. Records the request as PROCESSING while
 *      it runs, then stores the final response for 24h. A duplicate that
 *      arrives while the first is still running gets 409 "in progress"; one
 *      that arrives later gets the stored response replayed verbatim.
 *   2. Postgres — durable path. bookings has UNIQUE (user_id, idempotency_key),
 *      so even if Redis lost the record, a second booking row cannot exist.
 *
 * The record also stores a FINGERPRINT of the request (which hold it was for).
 * Reusing a key for a DIFFERENT request is a client bug -> 422.
 */
import { redis } from './client';

const PROCESSING_TTL_SEC = 60; // crash safety: a dead request's claim expires
const RESULT_TTL_SEC = 24 * 60 * 60;

interface ProcessingRecord {
  state: 'processing';
  fingerprint: string;
}
interface DoneRecord {
  state: 'done';
  fingerprint: string;
  statusCode: number;
  body: unknown;
}
type IdemRecord = ProcessingRecord | DoneRecord;

export type BeginResult =
  | { kind: 'new' } // first time we see this key: go ahead
  | { kind: 'in_progress' } // same key is being processed right now
  | { kind: 'replay'; statusCode: number; body: unknown } // already done: return stored response
  | { kind: 'mismatch' }; // key reused for a different request

function key(userId: string, idemKey: string): string {
  return `idem:${userId}:${idemKey}`;
}

export async function beginIdempotent(userId: string, idemKey: string, fingerprint: string): Promise<BeginResult> {
  const record: ProcessingRecord = { state: 'processing', fingerprint };
  // SET NX is atomic: of N concurrent duplicates exactly one gets 'OK'.
  const claimed = await redis.set(key(userId, idemKey), JSON.stringify(record), 'EX', PROCESSING_TTL_SEC, 'NX');
  if (claimed === 'OK') return { kind: 'new' };

  const raw = await redis.get(key(userId, idemKey));
  if (!raw) return beginIdempotent(userId, idemKey, fingerprint); // expired between SET and GET; try again
  const existing = JSON.parse(raw) as IdemRecord;
  if (existing.fingerprint !== fingerprint) return { kind: 'mismatch' };
  if (existing.state === 'processing') return { kind: 'in_progress' };
  return { kind: 'replay', statusCode: existing.statusCode, body: existing.body };
}

/** Store the final response so retries get exactly the same answer. */
export async function completeIdempotent(
  userId: string,
  idemKey: string,
  fingerprint: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  const record: DoneRecord = { state: 'done', fingerprint, statusCode, body };
  await redis.set(key(userId, idemKey), JSON.stringify(record), 'EX', RESULT_TTL_SEC);
}

/**
 * Unexpected crash (500): forget the claim so the client's retry can run.
 * Safe because nothing was committed — or if something WAS committed, the DB
 * unique constraint catches the retry and we replay the stored booking.
 */
export async function abandonIdempotent(userId: string, idemKey: string): Promise<void> {
  await redis.del(key(userId, idemKey));
}
