/**
 * STRATEGY B — OPTIMISTIC CONCURRENCY CONTROL (version column)
 *
 * "Assume there WON'T be a conflict; detect it at write time and retry."
 *
 * Reads take NO locks. We remember each seat's `version`, and the write is a
 * compare-and-swap:
 *
 *   UPDATE seats SET ..., version = version + 1
 *    WHERE id = 7 AND version = <the version we read>
 *
 * If someone else changed the seat in between, their UPDATE bumped the
 * version, our WHERE matches 0 rows, and we know we lost the race. We ROLLBACK
 * and retry from the read — which will now show the seat as HELD, so the retry
 * fails fast with SEATS_UNAVAILABLE.
 *
 *   T1: read seat 7 (AVAILABLE, v=3)
 *   T2: read seat 7 (AVAILABLE, v=3)
 *   T1: UPDATE ... WHERE id=7 AND version=3  -> 1 row  (v becomes 4); COMMIT
 *   T2: UPDATE ... WHERE id=7 AND version=3  -> 0 rows -> conflict -> ROLLBACK, retry
 *   T2: read seat 7 (HELD, v=4) -> SEATS_UNAVAILABLE
 *
 * + No lock waits while reading/deciding; great when conflicts are RARE
 *   (e.g. normal browsing-and-booking, users picking different seats).
 * - Under heavy contention on the same rows most transactions do their work,
 *   then throw it away and retry => wasted DB work, and "livelock"-ish retry
 *   storms. That's the ticket-drop worst case, which is why a queue sits in
 *   front of it.
 *
 * ISOLATION LEVEL: READ COMMITTED is sufficient. The UPDATE's WHERE clause is
 * evaluated against the LATEST committed row (Postgres re-checks it after
 * waiting for any concurrent writer), so the version check can't be fooled
 * by a stale snapshot. The version column is what prevents the lost update —
 * we do NOT rely on the isolation level for correctness here.
 */
import { config } from '../config';
import { sleep, withTransaction } from '../db/tx';
import { OptimisticConflictError, findStaleHoldIds, insertBooking, insertHold, unavailableSeats } from './shared';
import type { ConfirmRequest, ConfirmResult, HoldRequest, HoldResult, LockStrategy, SeatRow } from './types';

/**
 * Compare-and-swap many seats in ONE statement. Returns the ids that matched;
 * if that's fewer than we asked for, at least one version was stale.
 */
const CAS_UPDATE_SEATS_SQL = `
  UPDATE seats AS s
     SET status = $3, current_hold_id = $4, version = s.version + 1
    FROM unnest($1::bigint[], $2::int[]) AS expected(id, version)
   WHERE s.id = expected.id
     AND s.version = expected.version        -- <== the optimistic check
  RETURNING s.id`;

/** Retry wrapper: run `attempt` until it doesn't throw OptimisticConflictError. */
async function withOptimisticRetry<T>(
  attempt: (n: number) => Promise<T>,
  onExhausted: (n: number) => T,
): Promise<T> {
  const maxAttempts = config.maxTxRetries + 1;
  for (let n = 1; n <= maxAttempts; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      if (!(err instanceof OptimisticConflictError)) throw err;
      // Jittered exponential backoff so retries don't collide in lockstep.
      if (n < maxAttempts) await sleep(Math.random() * 5 * 2 ** n);
    }
  }
  return onExhausted(maxAttempts);
}

async function holdSeats(req: HoldRequest): Promise<HoldResult> {
  return withOptimisticRetry<HoldResult>(
    (attempts) =>
      withTransaction({ isolation: config.bookingIsolation, maxRetries: config.maxTxRetries }, async (client) => {
        // 1) Plain read — NO "FOR UPDATE". Other transactions can change these
        //    rows right after we read them; we'll find out at write time.
        const { rows: seats } = await client.query<SeatRow>(
          `SELECT id, status, version, price_cents, current_hold_id
             FROM seats
            WHERE event_id = $1
              AND id = ANY($2::bigint[])
            ORDER BY id`,
          [req.eventId, req.seatIds],
        );
        if (seats.length !== req.seatIds.length) return { ok: false, reason: 'INVALID_SEATS', attempts } as const;

        const stale = await findStaleHoldIds(client, seats);
        const taken = unavailableSeats(seats, stale);
        if (taken.length > 0) {
          // A definite "no" — no point retrying.
          return { ok: false, reason: 'SEATS_UNAVAILABLE', unavailableSeatIds: taken, attempts } as const;
        }

        // 2) Create the hold, then CAS every seat to HELD in one statement.
        const hold = await insertHold(client, req.userId, req.eventId, req.seatIds);
        const { rows: updated } = await client.query(CAS_UPDATE_SEATS_SQL, [
          seats.map((s) => s.id),
          seats.map((s) => s.version),
          'HELD',
          hold.id,
        ]);

        // 3) Lost the race on at least one seat => throw => ROLLBACK undoes the
        //    hold row AND any seats we did update (all-or-nothing), then retry.
        if (updated.length !== seats.length) throw new OptimisticConflictError();

        return {
          ok: true,
          holdId: hold.id,
          expiresAt: hold.expires_at.toISOString(),
          seatIds: seats.map((s) => s.id),
          totalCents: seats.reduce((sum, s) => sum + s.price_cents, 0),
          attempts,
        } as const;
      }),
    (attempts) => ({ ok: false, reason: 'CONFLICT_RETRIES_EXHAUSTED', attempts }),
  );
}

async function confirmHold(req: ConfirmRequest): Promise<ConfirmResult> {
  return withOptimisticRetry<ConfirmResult>(
    () =>
      withTransaction({ isolation: config.bookingIsolation, maxRetries: config.maxTxRetries }, async (client) => {
        // 1) Read the hold and its seats without locking.
        const { rows: holds } = await client.query<{ user_id: string; event_id: string; status: string; still_valid: boolean }>(
          `SELECT user_id, event_id, status, (expires_at > now()) AS still_valid
             FROM booking_holds WHERE id = $1`,
          [req.holdId],
        );
        const hold = holds[0];
        if (!hold || hold.user_id !== req.userId) return { ok: false, reason: 'HOLD_NOT_FOUND' } as const;
        if (hold.status !== 'ACTIVE') return { ok: false, reason: 'HOLD_NOT_ACTIVE' } as const;
        if (!hold.still_valid) return { ok: false, reason: 'HOLD_EXPIRED' } as const;

        const { rows: seats } = await client.query<SeatRow>(
          `SELECT s.id, s.status, s.version, s.price_cents, s.current_hold_id
             FROM seats s
            WHERE s.id IN (SELECT seat_id FROM booking_hold_seats WHERE hold_id = $1)
            ORDER BY s.id`,
          [req.holdId],
        );
        if (seats.some((s) => s.status !== 'HELD' || s.current_hold_id !== req.holdId)) {
          return { ok: false, reason: 'SEATS_LOST' } as const;
        }

        // 2) Conditional state transition on the hold: ACTIVE -> CONFIRMED only
        //    if it is STILL active and unexpired. This is a CAS on the status
        //    column; a concurrent confirm/sweeper that got there first makes
        //    this match 0 rows. (Same lock order as pessimistic: hold, then seats.)
        const { rowCount: holdUpdated } = await client.query(
          `UPDATE booking_holds SET status = 'CONFIRMED'
            WHERE id = $1 AND status = 'ACTIVE' AND expires_at > now()`,
          [req.holdId],
        );
        if (holdUpdated !== 1) throw new OptimisticConflictError('hold changed since read');

        // 3) CAS the seats HELD -> BOOKED using the versions we read.
        const { rows: updated } = await client.query(CAS_UPDATE_SEATS_SQL, [
          seats.map((s) => s.id),
          seats.map((s) => s.version),
          'BOOKED',
          null,
        ]);
        if (updated.length !== seats.length) throw new OptimisticConflictError();

        const booking = await insertBooking(client, {
          userId: req.userId,
          eventId: hold.event_id,
          holdId: req.holdId,
          paymentRef: req.paymentRef,
          idempotencyKey: req.idempotencyKey,
          seats,
        });
        return { ok: true, booking } as const;
      }),
    () => ({ ok: false, reason: 'CONFLICT_RETRIES_EXHAUSTED' }),
  );
}

export const optimisticStrategy: LockStrategy = { name: 'optimistic', holdSeats, confirmHold };
