/**
 * SQL snippets used by BOTH locking strategies. The parts that differ between
 * pessimistic and optimistic (how seats are read and updated) live in their
 * own files; the rest (creating hold rows, inserting bookings) is identical.
 */
import type { PoolClient } from 'pg';
import { config } from '../config';
import type { BookingDto, SeatRow } from './types';

/**
 * Among HELD seats, which ones belong to a hold that is no longer valid
 * (expired but not yet swept, or already released)? Those seats are
 * effectively AVAILABLE and may be taken over.
 *
 * NOTE: we never UPDATE the old hold rows here. The confirm path locks
 * "hold row -> seat rows"; if the hold path locked "seat rows -> hold row" the
 * two could DEADLOCK. Consistent lock ordering (holds before seats, seats in
 * id order) is how we avoid that; the sweeper tidies up old hold rows later.
 */
export async function findStaleHoldIds(client: PoolClient, seats: SeatRow[]): Promise<Set<string>> {
  const holdIds = [...new Set(seats.filter((s) => s.status === 'HELD').map((s) => s.current_hold_id!))];
  if (holdIds.length === 0) return new Set();
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM booking_holds
      WHERE id = ANY($1::uuid[])
        AND (status <> 'ACTIVE' OR expires_at <= now())`,
    [holdIds],
  );
  return new Set(rows.map((r) => r.id));
}

/** Seats the requester can NOT have (booked, or held by someone's live hold). */
export function unavailableSeats(seats: SeatRow[], staleHolds: Set<string>): number[] {
  return seats
    .filter((s) => s.status === 'BOOKED' || (s.status === 'HELD' && !staleHolds.has(s.current_hold_id!)))
    .map((s) => s.id);
}

/** Insert the hold row + its seat list. Returns the new hold id and expiry. */
export async function insertHold(
  client: PoolClient,
  userId: string,
  eventId: string,
  seatIds: number[],
): Promise<{ id: string; expires_at: Date }> {
  const { rows } = await client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO booking_holds (user_id, event_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     RETURNING id, expires_at`,
    [userId, eventId, config.holdTtlSeconds],
  );
  const hold = rows[0];
  await client.query(
    `INSERT INTO booking_hold_seats (hold_id, seat_id)
     SELECT $1, unnest($2::bigint[])`,
    [hold.id, seatIds],
  );
  return hold;
}

/**
 * Insert the booking + booking_seats rows. booking_seats has UNIQUE(seat_id),
 * so if (despite everything) a seat were already booked, this INSERT fails
 * with 23505 and the whole transaction rolls back. It never silently succeeds.
 */
export async function insertBooking(
  client: PoolClient,
  args: { userId: string; eventId: string; holdId: string; paymentRef: string; idempotencyKey: string; seats: SeatRow[] },
): Promise<BookingDto> {
  const totalCents = args.seats.reduce((sum, s) => sum + s.price_cents, 0);
  const { rows } = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO bookings (user_id, event_id, hold_id, total_cents, payment_ref, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [args.userId, args.eventId, args.holdId, totalCents, args.paymentRef, args.idempotencyKey],
  );
  await client.query(
    `INSERT INTO booking_seats (booking_id, seat_id, price_cents)
     SELECT $1, x.seat_id, x.price
       FROM unnest($2::bigint[], $3::int[]) AS x(seat_id, price)`,
    [rows[0].id, args.seats.map((s) => s.id), args.seats.map((s) => s.price_cents)],
  );
  return {
    id: rows[0].id,
    holdId: args.holdId,
    eventId: args.eventId,
    userId: args.userId,
    seatIds: args.seats.map((s) => s.id),
    totalCents,
    paymentRef: args.paymentRef,
    createdAt: rows[0].created_at.toISOString(),
  };
}

/** Thrown inside a transaction to force a ROLLBACK and signal "retry me". */
export class OptimisticConflictError extends Error {
  constructor(message = 'version changed since read') {
    super(message);
    this.name = 'OptimisticConflictError';
  }
}
