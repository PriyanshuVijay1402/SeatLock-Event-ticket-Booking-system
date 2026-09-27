/**
 * Read path: browse events, view seat maps, subscribe to live seat changes.
 *
 * This is the path that would move to READ REPLICAS at scale (DESIGN.md §8):
 * none of these queries need to see a write within milliseconds of it
 * happening, and they vastly outnumber booking writes.
 */
import { Router } from 'express';
import { query } from '../../db/pool';
import { getCachedSeats, onSeatsChanged } from '../../redis/seatEvents';
import { HttpError, uuidParam } from '../util';

export const eventsRouter = Router();

eventsRouter.get('/', async (_req, res) => {
  // The LATERAL "available" count is the canonical (event_id, status) lookup:
  // with idx_seats_event_status Postgres answers it with an index-only scan
  // over just that event's AVAILABLE slice instead of reading every seat.
  const events = await query(
    `SELECT e.id, e.name, e.kind, e.venue, e.starts_at, a.available, t.total
       FROM events e
       CROSS JOIN LATERAL (SELECT count(*)::int AS available FROM seats s
                            WHERE s.event_id = e.id AND s.status = 'AVAILABLE') a
       CROSS JOIN LATERAL (SELECT count(*)::int AS total FROM seats s
                            WHERE s.event_id = e.id) t
      ORDER BY e.starts_at`,
  );
  res.json({ events });
});

eventsRouter.get('/:eventId', async (req, res) => {
  const eventId = uuidParam(req, 'eventId');
  const [event] = await query(`SELECT id, name, kind, venue, starts_at FROM events WHERE id = $1`, [eventId]);
  if (!event) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
  res.json({ event });
});

/**
 * Full seat map. Cached in Redis for a couple of seconds (cache-aside).
 * A seat HELD by an expired hold is reported as AVAILABLE — that's the truth
 * the booking path will act on, even if the sweeper hasn't run yet.
 */
eventsRouter.get('/:eventId/seats', async (req, res) => {
  const eventId = uuidParam(req, 'eventId');
  const { data, cache } = await getCachedSeats(eventId, () =>
    query(
      `SELECT s.id, s.section, s.row_label AS "row", s.seat_number AS "number", s.price_cents AS "priceCents",
              CASE WHEN s.status = 'HELD' AND (h.status <> 'ACTIVE' OR h.expires_at <= now())
                   THEN 'AVAILABLE' ELSE s.status END AS status
         FROM seats s
         LEFT JOIN booking_holds h ON h.id = s.current_hold_id
        WHERE s.event_id = $1
        ORDER BY s.section, s.row_label, s.seat_number`,
      [eventId],
    ),
  );
  res.setHeader('X-Cache', cache);
  res.json({ seats: data });
});

/**
 * Server-Sent Events: pushes "seats changed" to the browser in real time.
 * Change notifications arrive via Redis pub/sub, so it works no matter which
 * API replica processed the booking. Bursts are coalesced to at most one
 * message per 500 ms per client, so a ticket drop doesn't flood browsers.
 */
eventsRouter.get('/:eventId/stream', (req, res) => {
  const eventId = uuidParam(req, 'eventId');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
  });
  res.write(`event: hello\ndata: ${eventId}\n\n`);

  let pending: NodeJS.Timeout | undefined;
  const unsubscribe = onSeatsChanged((changedEventId) => {
    if (changedEventId !== eventId || pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      res.write(`event: seats\ndata: ${eventId}\n\n`);
    }, 500);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
    if (pending) clearTimeout(pending);
  });
});
