/**
 * Booking service: the orchestration layer between HTTP/queue and the locking
 * strategies. Validates input, picks a strategy, runs the mock payment, and
 * publishes seat-change notifications after commits.
 */
import { config, type LockStrategyName } from '../config';
import { query } from '../db/pool';
import { pgErrorCode, withTransaction } from '../db/tx';
import { seatsChanged } from '../redis/seatEvents';
import { charge, refund, type PaymentOutcome } from './payment';
import { optimisticStrategy } from './optimistic';
import { pessimisticStrategy } from './pessimistic';
import type { BookingDto, ConfirmFailureReason, HoldRequest, HoldResult, LockStrategy } from './types';

const strategies: Record<LockStrategyName, LockStrategy> = {
  pessimistic: pessimisticStrategy,
  optimistic: optimisticStrategy,
};

export function getStrategy(name: LockStrategyName = config.lockStrategy): LockStrategy {
  return strategies[name];
}

export const MAX_SEATS_PER_HOLD = 10;

// ---------------------------------------------------------------------------
// HOLD
// ---------------------------------------------------------------------------

export async function holdSeats(req: HoldRequest, strategyName: LockStrategyName): Promise<HoldResult> {
  const result = await getStrategy(strategyName).holdSeats(req);
  if (result.ok) await seatsChanged(req.eventId);
  return result;
}

// ---------------------------------------------------------------------------
// CONFIRM (payment + booking)
// ---------------------------------------------------------------------------

export type ConfirmOutcome =
  | { status: 201 | 200; body: { booking: BookingDto; replayed?: boolean } }
  | { status: 402; body: { error: 'PAYMENT_FAILED'; message: string } }
  | { status: 404 | 409 | 410; body: { error: ConfirmFailureReason; message: string } };

const FAILURE_HTTP: Record<ConfirmFailureReason, { status: 404 | 409 | 410; message: string }> = {
  HOLD_NOT_FOUND: { status: 404, message: 'Hold not found.' },
  HOLD_EXPIRED: { status: 410, message: 'Your hold expired. Please select seats again.' },
  HOLD_NOT_ACTIVE: { status: 409, message: 'This hold was already confirmed or released.' },
  SEATS_LOST: { status: 409, message: 'Your hold expired and some seats were taken by someone else.' },
  CONFLICT_RETRIES_EXHAUSTED: { status: 409, message: 'Too much contention, please retry.' },
};

export async function confirmHold(args: {
  holdId: string;
  userId: string;
  idempotencyKey: string;
  paymentOutcome: PaymentOutcome;
  strategyName: LockStrategyName;
}): Promise<ConfirmOutcome> {
  // (a) Durable idempotency check: did this key already produce a booking?
  //     Covers the case where Redis lost the idempotency record.
  const existing = await findBookingByIdempotencyKey(args.userId, args.idempotencyKey);
  if (existing) return { status: 200, body: { booking: existing, replayed: true } };

  // (b) Cheap pre-check (no locks) so we don't charge a card for a dead hold.
  //     The real check happens again under lock inside the strategy.
  const [hold] = await query<{ user_id: string; status: string; still_valid: boolean; total_cents: number }>(
    `SELECT h.user_id, h.status, (h.expires_at > now()) AS still_valid,
            COALESCE((SELECT SUM(s.price_cents) FROM booking_hold_seats hs
                        JOIN seats s ON s.id = hs.seat_id WHERE hs.hold_id = h.id), 0)::int AS total_cents
       FROM booking_holds h WHERE h.id = $1`,
    [args.holdId],
  );
  const pre: ConfirmFailureReason | null =
    !hold || hold.user_id !== args.userId ? 'HOLD_NOT_FOUND'
    : hold.status !== 'ACTIVE' ? 'HOLD_NOT_ACTIVE'
    : !hold.still_valid ? 'HOLD_EXPIRED'
    : null;
  if (pre) return failure(pre);

  // (c) Charge OUTSIDE the transaction (never hold row locks across network I/O).
  const payment = await charge({ amountCents: hold.total_cents, idempotencyKey: args.idempotencyKey, outcome: args.paymentOutcome });
  if (!payment.ok) {
    // The hold stays ACTIVE: the user may retry payment (with a NEW key) until it expires.
    return { status: 402, body: { error: 'PAYMENT_FAILED', message: 'Payment was declined (mock). Your seats are still held.' } };
  }

  // (d) The locked, transactional part — strategy-specific.
  let result;
  try {
    result = await getStrategy(args.strategyName).confirmHold({
      holdId: args.holdId,
      userId: args.userId,
      idempotencyKey: args.idempotencyKey,
      paymentRef: payment.paymentRef,
    });
  } catch (err) {
    // A concurrent request with the SAME key committed first: the DB unique
    // constraint (user_id, idempotency_key) rejected us. Replay theirs.
    if (pgErrorCode(err) === '23505') {
      await refund(payment.paymentRef);
      const winner = await findBookingByIdempotencyKey(args.userId, args.idempotencyKey);
      if (winner) return { status: 200, body: { booking: winner, replayed: true } };
    }
    await refund(payment.paymentRef);
    throw err;
  }

  if (!result.ok) {
    // Charged but couldn't book (hold expired in the meantime, etc.) -> compensate.
    await refund(payment.paymentRef);
    return failure(result.reason);
  }

  await seatsChanged(result.booking.eventId);
  return { status: 201, body: { booking: result.booking } };
}

function failure(reason: ConfirmFailureReason): ConfirmOutcome {
  const { status, message } = FAILURE_HTTP[reason];
  return { status, body: { error: reason, message } };
}

export async function findBookingByIdempotencyKey(userId: string, idemKey: string): Promise<BookingDto | null> {
  const rows = await query<BookingRow>(`${BOOKING_SELECT} WHERE b.user_id = $1 AND b.idempotency_key = $2 GROUP BY b.id`, [
    userId,
    idemKey,
  ]);
  return rows[0] ? toBookingDto(rows[0]) : null;
}

export async function listBookingsForUser(userId: string): Promise<(BookingDto & { eventName: string; startsAt: string; seatLabels: string[] })[]> {
  const rows = await query<BookingRow & { event_name: string; starts_at: Date; seat_labels: string[] }>(
    `SELECT b.id, b.hold_id, b.event_id, b.user_id, b.total_cents, b.payment_ref, b.created_at,
            e.name AS event_name, e.starts_at,
            array_agg(s.id ORDER BY s.id) AS seat_ids,
            array_agg(s.section || ' ' || s.row_label || s.seat_number ORDER BY s.id) AS seat_labels
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       JOIN booking_seats bs ON bs.booking_id = b.id
       JOIN seats s ON s.id = bs.seat_id
      WHERE b.user_id = $1
      GROUP BY b.id, e.id
      ORDER BY b.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ ...toBookingDto(r), eventName: r.event_name, startsAt: r.starts_at.toISOString(), seatLabels: r.seat_labels }));
}

interface BookingRow extends Record<string, unknown> {
  id: string;
  hold_id: string;
  event_id: string;
  user_id: string;
  total_cents: number;
  payment_ref: string;
  created_at: Date;
  seat_ids: number[];
}

const BOOKING_SELECT = `
  SELECT b.id, b.hold_id, b.event_id, b.user_id, b.total_cents, b.payment_ref, b.created_at,
         array_agg(bs.seat_id ORDER BY bs.seat_id) AS seat_ids
    FROM bookings b
    JOIN booking_seats bs ON bs.booking_id = b.id`;

function toBookingDto(r: BookingRow): BookingDto {
  return {
    id: r.id,
    holdId: r.hold_id,
    eventId: r.event_id,
    userId: r.user_id,
    seatIds: r.seat_ids.map(Number),
    totalCents: r.total_cents,
    paymentRef: r.payment_ref,
    createdAt: r.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CANCEL (user gives the seats back before paying)
// ---------------------------------------------------------------------------

export async function releaseHold(holdId: string, userId: string): Promise<'released' | 'not_found' | 'not_active'> {
  const outcome = await withTransaction({ isolation: config.bookingIsolation }, async (client) => {
    // Same lock order as confirm: hold row first, then its seats.
    const { rows } = await client.query<{ user_id: string; event_id: string; status: string }>(
      `SELECT user_id, event_id, status FROM booking_holds WHERE id = $1 FOR UPDATE`,
      [holdId],
    );
    const hold = rows[0];
    if (!hold || hold.user_id !== userId) return { kind: 'not_found' as const };
    if (hold.status !== 'ACTIVE') return { kind: 'not_active' as const };
    await client.query(`UPDATE booking_holds SET status = 'RELEASED' WHERE id = $1`, [holdId]);
    await client.query(
      `UPDATE seats SET status = 'AVAILABLE', current_hold_id = NULL, version = version + 1
        WHERE current_hold_id = $1`,
      [holdId],
    );
    return { kind: 'released' as const, eventId: hold.event_id };
  });
  if (outcome.kind === 'released') await seatsChanged(outcome.eventId);
  return outcome.kind;
}

// ---------------------------------------------------------------------------
// EXPIRY SWEEPER (runs in the worker process on a timer)
// ---------------------------------------------------------------------------

/**
 * Release seats of holds whose 5 minutes are up.
 *
 * FOR UPDATE SKIP LOCKED is the classic "many workers, one work table" trick:
 * each sweeper instance locks a batch of expired holds and SKIPS rows another
 * instance (or an in-flight confirm, which also locks the hold row) already
 * holds. So you can run N worker replicas and they never double-process or
 * block each other.
 */
export async function sweepExpiredHolds(batchSize = 500): Promise<number> {
  const result = await withTransaction({ isolation: 'READ COMMITTED' }, async (client) => {
    const { rows } = await client.query<{ id: string; event_id: string }>(
      `UPDATE booking_holds
          SET status = 'EXPIRED'
        WHERE id IN (
              SELECT id FROM booking_holds
               WHERE status = 'ACTIVE' AND expires_at <= now()
               ORDER BY expires_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED)
        RETURNING id, event_id`,
      [batchSize],
    );
    if (rows.length > 0) {
      // Only seats STILL pointing at these holds; a seat that was already taken
      // over by a newer hold is left alone.
      await client.query(
        `UPDATE seats SET status = 'AVAILABLE', current_hold_id = NULL, version = version + 1
          WHERE current_hold_id = ANY($1::uuid[])`,
        [rows.map((r) => r.id)],
      );
    }
    return rows;
  });
  for (const eventId of new Set(result.map((r) => r.event_id))) await seatsChanged(eventId);
  return result.length;
}

