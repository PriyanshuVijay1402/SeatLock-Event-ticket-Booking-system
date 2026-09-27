/**
 * STRATEGY A — PESSIMISTIC LOCKING (SELECT ... FOR UPDATE)
 *
 * "Assume there WILL be a conflict, so lock first, then look."
 *
 * The transaction takes an exclusive row lock on every requested seat before
 * reading its status. Any other transaction that wants the same seat BLOCKS on
 * that lock until we COMMIT or ROLLBACK. So "check the seat is free" and "mark
 * it held" happen as one indivisible step with respect to other bookers.
 *
 *   T1: BEGIN; SELECT ... WHERE id=7 FOR UPDATE;   -- gets lock, sees AVAILABLE
 *   T2: BEGIN; SELECT ... WHERE id=7 FOR UPDATE;   -- BLOCKS here...
 *   T1: UPDATE seats SET status='HELD' ...; COMMIT; -- releases lock
 *   T2:                                            -- ...wakes up, sees HELD -> gives up
 *
 * + No wasted work: losers wait and then fail cleanly; nobody retries.
 * + Simple to reason about.
 * - Waiting transactions hold a DB connection while blocked. Under a huge
 *   herd on ONE seat, every pool connection can end up waiting on the same
 *   lock (that's why the Redis pre-lock + queue sit in front of this).
 * - Must lock in a consistent order (ORDER BY id) or two multi-seat bookings
 *   can deadlock: T1 locks 7 then wants 8, T2 locks 8 then wants 7.
 *
 * ISOLATION LEVEL (config.bookingIsolation, default READ COMMITTED):
 *   Under READ COMMITTED, when T2 wakes up after waiting on T1's lock, Postgres
 *   RE-READS the latest committed version of the locked row (it does not use
 *   T2's stale snapshot for locked rows). So T2 sees status='HELD' and bails.
 *   => FOR UPDATE + READ COMMITTED is already safe against the
 *      "lost update / double booking" race for the rows we lock.
 *   Under SERIALIZABLE / REPEATABLE READ, T2 would instead get error 40001
 *   ("could not serialize access due to concurrent update") and withTransaction
 *   retries it — also correct, just more aborted work. See DESIGN.md §3.
 */
import { config } from '../config';
import { withTransaction } from '../db/tx';
import { findStaleHoldIds, insertBooking, insertHold, unavailableSeats } from './shared';
import type { ConfirmRequest, ConfirmResult, HoldRequest, HoldResult, LockStrategy, SeatRow } from './types';

async function holdSeats(req: HoldRequest): Promise<HoldResult> {
  let attempts = 0;
  return withTransaction({ isolation: config.bookingIsolation, maxRetries: config.maxTxRetries }, async (client) => {
    attempts++;

    // 1) LOCK the seat rows. ORDER BY id => every transaction acquires locks in
    //    the same global order => no deadlocks between multi-seat requests.
    //    Only the seats table is locked; we deliberately don't join booking_holds
    //    here (FOR UPDATE + outer joins have surprising re-check semantics).
    const { rows: seats } = await client.query<SeatRow>(
      `SELECT id, status, version, price_cents, current_hold_id
         FROM seats
        WHERE event_id = $1
          AND id = ANY($2::bigint[])
        ORDER BY id
        FOR UPDATE`,
      [req.eventId, req.seatIds],
    );
    if (seats.length !== req.seatIds.length) {
      return { ok: false, reason: 'INVALID_SEATS', attempts } as const;
    }

    // 2) Now that we OWN these rows, nobody can change them until we finish.
    //    Decide availability. A HELD seat whose hold has expired counts as free
    //    (the sweeper may not have released it yet).
    const stale = await findStaleHoldIds(client, seats);
    const taken = unavailableSeats(seats, stale);
    if (taken.length > 0) {
      // Returning (=> COMMIT of a read-only txn) releases the locks.
      return { ok: false, reason: 'SEATS_UNAVAILABLE', unavailableSeatIds: taken, attempts } as const;
    }

    // 3) Create the hold and point the seats at it. No version check needed —
    //    the row lock already guarantees nobody changed them since step 1.
    //    (We still bump version so the OPTIMISTIC path notices our change.)
    const hold = await insertHold(client, req.userId, req.eventId, req.seatIds);
    await client.query(
      `UPDATE seats
          SET status = 'HELD', current_hold_id = $1, version = version + 1
        WHERE id = ANY($2::bigint[])`,
      [hold.id, req.seatIds],
    );

    return {
      ok: true,
      holdId: hold.id,
      expiresAt: hold.expires_at.toISOString(),
      seatIds: seats.map((s) => s.id),
      totalCents: seats.reduce((sum, s) => sum + s.price_cents, 0),
      attempts,
    } as const;
  });
}

async function confirmHold(req: ConfirmRequest): Promise<ConfirmResult> {
  return withTransaction({ isolation: config.bookingIsolation, maxRetries: config.maxTxRetries }, async (client) => {
    // 1) Lock the HOLD row first. Two concurrent confirms of the same hold
    //    (double-click with different idempotency keys, two tabs...) serialize
    //    here; the second one then sees status='CONFIRMED' and stops.
    //    It also stops the expiry sweeper from expiring this hold mid-confirm
    //    (the sweeper uses SKIP LOCKED and will simply skip it).
    //    Lock order everywhere: hold row -> seat rows (by id).
    const { rows: holds } = await client.query<{
      id: string;
      user_id: string;
      event_id: string;
      status: string;
      still_valid: boolean;
    }>(
      `SELECT id, user_id, event_id, status, (expires_at > now()) AS still_valid
         FROM booking_holds
        WHERE id = $1
        FOR UPDATE`,
      [req.holdId],
    );
    const hold = holds[0];
    if (!hold || hold.user_id !== req.userId) return { ok: false, reason: 'HOLD_NOT_FOUND' } as const;
    if (hold.status !== 'ACTIVE') return { ok: false, reason: 'HOLD_NOT_ACTIVE' } as const;
    if (!hold.still_valid) return { ok: false, reason: 'HOLD_EXPIRED' } as const;

    // 2) Lock the hold's seats (same ORDER BY id discipline as holdSeats).
    const { rows: seats } = await client.query<SeatRow>(
      `SELECT s.id, s.status, s.version, s.price_cents, s.current_hold_id
         FROM seats s
        WHERE s.id IN (SELECT seat_id FROM booking_hold_seats WHERE hold_id = $1)
        ORDER BY s.id
        FOR UPDATE`,
      [req.holdId],
    );
    // Every seat must still be HELD by *this* hold. If the hold expired and a
    // different user took a seat over in the gap, we must not sell it twice.
    if (seats.some((s) => s.status !== 'HELD' || s.current_hold_id !== req.holdId)) {
      return { ok: false, reason: 'SEATS_LOST' } as const;
    }

    // 3) Flip seats to BOOKED, record the booking, close the hold.
    await client.query(
      `UPDATE seats
          SET status = 'BOOKED', current_hold_id = NULL, version = version + 1
        WHERE id = ANY($1::bigint[])`,
      [seats.map((s) => s.id)],
    );
    const booking = await insertBooking(client, {
      userId: req.userId,
      eventId: hold.event_id,
      holdId: req.holdId,
      paymentRef: req.paymentRef,
      idempotencyKey: req.idempotencyKey,
      seats,
    });
    await client.query(`UPDATE booking_holds SET status = 'CONFIRMED' WHERE id = $1`, [req.holdId]);
    return { ok: true, booking } as const;
  });
}

export const pessimisticStrategy: LockStrategy = { name: 'pessimistic', holdSeats, confirmHold };
