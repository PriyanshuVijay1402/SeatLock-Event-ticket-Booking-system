/**
 * Admin operations: create events with a seat map, and verify booking
 * integrity (used by the ticket-drop report to PROVE no double-booking).
 */
import { config } from '../config';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';

export interface SectionSpec {
  name: string;
  rows: number; // rows are labelled A, B, C, ...
  seatsPerRow: number;
  priceCents: number;
}

export interface CreateEventInput {
  name: string;
  kind: 'CONCERT' | 'MOVIE';
  venue: string;
  startsAt: string;
  sections: SectionSpec[];
}

export async function createEvent(input: CreateEventInput): Promise<{ id: string; seatCount: number }> {
  return withTransaction({ isolation: config.bookingIsolation }, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO events (name, kind, venue, starts_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.name, input.kind, input.venue, input.startsAt],
    );
    const eventId = rows[0].id;
    // Generate the whole seat grid in ONE set-based statement instead of one
    // INSERT per seat: sections x generate_series(rows) x generate_series(seats).
    const { rowCount } = await client.query(
      `INSERT INTO seats (event_id, section, row_label, seat_number, price_cents)
       SELECT $1, sec.name, chr(64 + r), n, sec.price_cents
         FROM json_to_recordset($2::json) AS sec(name text, rows int, seats_per_row int, price_cents int)
         CROSS JOIN LATERAL generate_series(1, sec.rows) AS r
         CROSS JOIN LATERAL generate_series(1, sec.seats_per_row) AS n`,
      [
        eventId,
        JSON.stringify(input.sections.map((s) => ({ name: s.name, rows: s.rows, seats_per_row: s.seatsPerRow, price_cents: s.priceCents }))),
      ],
    );
    return { id: eventId, seatCount: rowCount ?? 0 };
  });
}

export interface IntegrityReport {
  eventId: string;
  seatsTotal: number;
  seatsBooked: number;
  seatsHeld: number;
  bookings: number;
  bookingSeatRows: number;
  /** Seats that appear in more than one booking. MUST be empty. */
  doubleBookedSeats: number[];
  /** Seats claimed by more than one live (active+unexpired or confirmed) hold. MUST be empty. */
  seatsWithOverlappingHolds: number[];
  /** Seats marked BOOKED with no booking row, or booked seats not marked BOOKED. MUST be 0. */
  statusMismatches: number;
  ok: boolean;
}

/**
 * Independent checks that don't trust the application code: they look at the
 * raw tables. The first check can never fire thanks to UNIQUE(seat_id), but the
 * second (hold overlap) is NOT enforced by any constraint — it's purely the
 * locking logic's job, so it's the one that really tests the strategies.
 */
export async function checkIntegrity(eventId: string): Promise<IntegrityReport> {
  const [counts] = await query<{ total: number; booked: number; held: number; bookings: number; booking_seat_rows: number }>(
    `SELECT (SELECT count(*) FROM seats WHERE event_id = $1)::int AS total,
            (SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'BOOKED')::int AS booked,
            (SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'HELD')::int AS held,
            (SELECT count(*) FROM bookings WHERE event_id = $1)::int AS bookings,
            (SELECT count(*) FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id WHERE s.event_id = $1)::int AS booking_seat_rows`,
    [eventId],
  );

  const doubleBooked = await query<{ seat_id: number }>(
    `SELECT bs.seat_id FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id
      WHERE s.event_id = $1 GROUP BY bs.seat_id HAVING count(*) > 1`,
    [eventId],
  );

  const overlapping = await query<{ seat_id: number }>(
    `SELECT hs.seat_id
       FROM booking_hold_seats hs
       JOIN booking_holds h ON h.id = hs.hold_id
      WHERE h.event_id = $1
        AND (h.status = 'CONFIRMED' OR (h.status = 'ACTIVE' AND h.expires_at > now()))
      GROUP BY hs.seat_id HAVING count(*) > 1`,
    [eventId],
  );

  const [mismatch] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM seats s
      WHERE s.event_id = $1
        AND (s.status = 'BOOKED') <> EXISTS (SELECT 1 FROM booking_seats bs WHERE bs.seat_id = s.id)`,
    [eventId],
  );

  const report: IntegrityReport = {
    eventId,
    seatsTotal: counts.total,
    seatsBooked: counts.booked,
    seatsHeld: counts.held,
    bookings: counts.bookings,
    bookingSeatRows: counts.booking_seat_rows,
    doubleBookedSeats: doubleBooked.map((r) => r.seat_id),
    seatsWithOverlappingHolds: overlapping.map((r) => r.seat_id),
    statusMismatches: mismatch.n,
    ok: false,
  };
  report.ok = report.doubleBookedSeats.length === 0 && report.seatsWithOverlappingHolds.length === 0 && report.statusMismatches === 0;
  return report;
}
