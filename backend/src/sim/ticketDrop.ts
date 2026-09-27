/**
 * TICKET DROP SIMULATION — the centerpiece demo.
 *
 * Simulates "tickets go on sale at 10:00:00": thousands of users hit the SAME
 * small set of hot seats at the same instant, through the real HTTP API.
 *
 * Phases:
 *   1. Create a fresh event (so every run starts clean).
 *   2. Log in N simulated users.
 *   3. THE DROP: fire all hold requests concurrently at a handful of hot seats.
 *   4. Winners confirm — each confirm is sent TWICE at once with the same
 *      Idempotency-Key (a double-click), then once more afterwards (a retry).
 *   5. Verify: client-side (no seat granted to two holders, one booking per
 *      hold) AND server-side (raw SQL integrity checks).
 *   6. Report status breakdown + latency p50/p95/p99.
 *
 * Uses plain node:http(s) with a keep-alive agent capped at `concurrency`
 * sockets, so "concurrency" really means "requests in flight at once".
 */
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { CheckoutMode, LockStrategyName } from '../config';

export interface TicketDropOptions {
  baseUrl: string;
  /** Total hold attempts fired during the drop. */
  requests: number;
  /** Max requests in flight at the same time. */
  concurrency: number;
  /** Distinct simulated users (requests are spread across them round-robin). */
  users: number;
  /** Size of the "hot" subset everyone fights over. 1 = everyone wants the same seat. */
  hotSeats: number;
  /** Seats per hold request (1-4). Multi-seat requests exercise lock ordering. */
  seatsPerRequest: number;
  strategy: LockStrategyName;
  mode: CheckoutMode;
  /** false = bypass the Redis pre-lock so every request reaches Postgres. */
  redisLock: boolean;
  /** Run the confirm phase (with duplicate confirms to test idempotency). */
  confirm: boolean;
  /** Admin user name used to create the event. */
  adminName?: string;
}

export const DEFAULT_DROP_OPTIONS: Omit<TicketDropOptions, 'baseUrl'> = {
  requests: 1000,
  concurrency: 200,
  users: 500,
  hotSeats: 10,
  seatsPerRequest: 1,
  strategy: 'pessimistic',
  mode: 'queue',
  redisLock: true,
  confirm: true,
};

export interface LatencyStats {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface TicketDropReport {
  options: Omit<TicketDropOptions, 'baseUrl'>;
  eventId: string;
  durationMs: number;
  throughputRps: number;
  holdPhase: {
    statusCounts: Record<string, number>; // e.g. "201 created", "409 SEAT_LOCKED"
    successfulHolds: number;
    latencyMs: LatencyStats;
  };
  confirmPhase?: {
    confirmed: number;
    duplicateResponses: Record<string, number>;
    distinctBookingIds: number;
    replayMatched: boolean;
    latencyMs: LatencyStats;
  };
  checks: {
    /** Client-side: seats granted to >1 successful hold during the drop. */
    seatsGrantedTwice: number[];
    /** Client-side: holds that produced more than one distinct booking id. */
    holdsWithMultipleBookings: number;
    /** Server-side raw-SQL integrity report. */
    server: unknown;
    passed: boolean;
  };
}

// ---------------------------------------------------------------------------
// tiny HTTP client
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  ms: number;
}

function makeClient(baseUrl: string, maxSockets: number) {
  const base = new URL(baseUrl);
  // https for deployed sites (e.g. https://your-app.onrender.com), http locally.
  const transport = base.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets });

  return function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const started = performance.now();
    return new Promise((resolve) => {
      const req = transport.request(
        {
          agent,
          host: base.hostname,
          port: base.port || (base.protocol === 'https:' ? 443 : 80),
          method,
          path,
          headers: { 'content-type': 'application/json', ...headers, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let parsed: unknown = data;
            try {
              parsed = data ? JSON.parse(data) : null;
            } catch {
              /* non-JSON body */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, ms: performance.now() - started });
          });
        },
      );
      // Network errors are recorded as status 0 rather than crashing the run.
      req.on('error', (err) => resolve({ status: 0, body: { error: 'NETWORK', message: err.message }, ms: performance.now() - started }));
      if (payload) req.write(payload);
      req.end();
    });
  };
}

/** Run async tasks with at most `limit` in flight. */
async function runPool<T>(items: number, limit: number, task: (i: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(items);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items) }, async () => {
    while (next < items) {
      const i = next++;
      results[i] = await task(i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank percentile.
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    count: sorted.length,
    min: round(sorted[0]),
    p50: round(pct(50)),
    p95: round(pct(95)),
    p99: round(pct(99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// the simulation
// ---------------------------------------------------------------------------

export async function runTicketDrop(opts: TicketDropOptions, log: (msg: string) => void = () => {}): Promise<TicketDropReport> {
  const request = makeClient(opts.baseUrl, opts.concurrency);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const knobs = { 'x-lock-strategy': opts.strategy, 'x-checkout-mode': opts.mode, 'x-redis-lock': opts.redisLock ? 'on' : 'off' };

  // --- 1. fresh event -------------------------------------------------------
  const admin = await request('POST', '/api/auth/login', { name: opts.adminName ?? 'admin' });
  if (admin.status !== 200 || !admin.body.user.isAdmin) throw new Error('Could not log in as admin (did you run the seed?)');
  const adminToken: string = admin.body.token;

  const seatsNeeded = Math.max(opts.hotSeats, opts.seatsPerRequest);
  const rows = Math.max(1, Math.ceil(seatsNeeded / 20));
  const created = await request(
    'POST',
    '/api/admin/events',
    {
      name: `Ticket Drop ${new Date().toISOString().slice(11, 19)} (${opts.strategy}/${opts.mode}${opts.redisLock ? '' : '/no-redis'})`,
      kind: 'CONCERT',
      venue: 'Load Test Arena',
      startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      sections: [{ name: 'Floor', rows, seatsPerRow: Math.min(20, seatsNeeded), priceCents: 9900 }],
    },
    auth(adminToken),
  );
  if (created.status !== 201) throw new Error(`Event creation failed: ${JSON.stringify(created.body)}`);
  const eventId: string = created.body.event.id;
  const seatsRes = await request('GET', `/api/events/${eventId}/seats`);
  const hotSeatIds: number[] = seatsRes.body.seats.slice(0, opts.hotSeats).map((s: { id: number }) => s.id);
  log(`event ${eventId} created; ${hotSeatIds.length} hot seats`);

  // --- 2. users -------------------------------------------------------------
  const runTag = randomUUID().slice(0, 6);
  const tokens = await runPool(opts.users, 50, async (i) => {
    const r = await request('POST', '/api/auth/login', { name: `drop-${runTag}-${i}` });
    return r.body.token as string;
  });
  log(`${tokens.length} users logged in`);

  // Each request wants `seatsPerRequest` ADJACENT hot seats starting at a random offset.
  const pickSeats = () => {
    const n = Math.min(opts.seatsPerRequest, hotSeatIds.length);
    const start = Math.floor(Math.random() * (hotSeatIds.length - n + 1));
    return hotSeatIds.slice(start, start + n);
  };

  // --- 3. THE DROP ----------------------------------------------------------
  log(`firing ${opts.requests} hold requests (concurrency ${opts.concurrency}, ${opts.strategy}, ${opts.mode})...`);
  const holdStatus: Record<string, number> = {};
  const holdLatencies: number[] = [];
  const holds: { token: string; holdId: string; seatIds: number[] }[] = [];
  const dropStart = performance.now();

  await runPool(opts.requests, opts.concurrency, async (i) => {
    const token = tokens[i % tokens.length];
    let r = await request('POST', `/api/events/${eventId}/holds`, { seatIds: pickSeats() }, { ...auth(token), ...knobs });
    let total = r.ms;
    // Queued request outlived the API's wait timeout: poll until it resolves.
    while (r.status === 202 && r.body?.jobId) {
      await new Promise((res) => setTimeout(res, 250));
      const jobId = r.body.jobId;
      r = await request('GET', `/api/hold-jobs/${jobId}`, undefined, auth(token));
      total += r.ms + 250;
      if (r.status === 202) r.body = { jobId };
    }
    holdLatencies.push(total);
    bump(holdStatus, `${r.status} ${r.status === 201 ? 'HOLD_CREATED' : (r.body?.error ?? '')}`.trim());
    if (r.status === 201) holds.push({ token, holdId: r.body.hold.holdId, seatIds: r.body.hold.seatIds });
  });
  const dropMs = performance.now() - dropStart;
  log(`drop finished in ${Math.round(dropMs)} ms; ${holds.length} holds granted`);

  // Client-side check #1: was any seat handed to two different holds?
  const seatOwners = new Map<number, number>();
  for (const h of holds) for (const s of h.seatIds) seatOwners.set(s, (seatOwners.get(s) ?? 0) + 1);
  const seatsGrantedTwice = [...seatOwners].filter(([, n]) => n > 1).map(([s]) => s);

  // --- 4. confirm with duplicate clicks -------------------------------------
  let confirmPhase: TicketDropReport['confirmPhase'];
  let holdsWithMultipleBookings = 0;
  if (opts.confirm && holds.length > 0) {
    const dupResponses: Record<string, number> = {};
    const confirmLatencies: number[] = [];
    const bookingIds = new Set<string>();
    let confirmed = 0;
    let replayMatched = true;

    await runPool(holds.length, opts.concurrency, async (i) => {
      const h = holds[i];
      const idemKey = randomUUID(); // ONE key per checkout attempt, reused on every retry
      const send = () =>
        request('POST', `/api/holds/${h.holdId}/confirm`, { paymentOutcome: 'success' }, { ...auth(h.token), 'idempotency-key': idemKey, ...knobs });

      // Double-click: two identical requests at the same instant.
      const [a, b] = await Promise.all([send(), send()]);
      for (const r of [a, b]) {
        confirmLatencies.push(r.ms);
        bump(dupResponses, `${r.status} ${r.body?.error ?? (r.body?.replayed ? 'REPLAYED' : 'BOOKED')}`);
      }
      // Late retry (e.g. client never saw the response): must replay, not re-book.
      let retry = await send();
      while (retry.status === 409 && retry.body?.error === 'IDEMPOTENCY_IN_PROGRESS') {
        await new Promise((res) => setTimeout(res, 100));
        retry = await send();
      }
      const ids = new Set([a, b, retry].filter((r) => r.body?.booking).map((r) => r.body.booking.id as string));
      if (ids.size > 1) holdsWithMultipleBookings++;
      if (ids.size >= 1) confirmed++;
      ids.forEach((id) => bookingIds.add(id));
      const first = [a, b].find((r) => r.status === 201);
      if (first && retry.body?.booking?.id !== first.body.booking.id) replayMatched = false;
    });

    confirmPhase = {
      confirmed,
      duplicateResponses: dupResponses,
      distinctBookingIds: bookingIds.size,
      replayMatched,
      latencyMs: latencyStats(confirmLatencies),
    };
    log(`confirm phase: ${confirmed}/${holds.length} holds booked, ${bookingIds.size} distinct bookings`);
  }

  // --- 5. server-side integrity --------------------------------------------
  const integrity = await request('GET', `/api/admin/integrity/${eventId}`, undefined, auth(adminToken));
  const serverOk = integrity.status === 200 && integrity.body.integrity.ok === true;
  const bookingsMatch = !confirmPhase || confirmPhase.distinctBookingIds === integrity.body?.integrity?.bookings;

  const { baseUrl: _omit, ...optionsForReport } = opts;
  return {
    options: optionsForReport,
    eventId,
    durationMs: Math.round(dropMs),
    throughputRps: Math.round((opts.requests / dropMs) * 1000),
    holdPhase: { statusCounts: holdStatus, successfulHolds: holds.length, latencyMs: latencyStats(holdLatencies) },
    confirmPhase,
    checks: {
      seatsGrantedTwice,
      holdsWithMultipleBookings,
      server: integrity.body?.integrity ?? integrity.body,
      passed: seatsGrantedTwice.length === 0 && holdsWithMultipleBookings === 0 && serverOk && bookingsMatch,
    },
  };
}

/** Human-readable console report. */
export function formatReport(r: TicketDropReport): string {
  const o = r.options;
  const lines: string[] = [];
  const hr = '-'.repeat(64);
  const lat = (l: LatencyStats) => `p50 ${l.p50} ms | p95 ${l.p95} ms | p99 ${l.p99} ms | max ${l.max} ms  (n=${l.count})`;
  lines.push(hr, ' TICKET DROP REPORT', hr);
  lines.push(` strategy=${o.strategy}  mode=${o.mode}  redisLock=${o.redisLock ? 'on' : 'OFF'}  requests=${o.requests}  concurrency=${o.concurrency}`);
  lines.push(` users=${o.users}  hotSeats=${o.hotSeats}  seatsPerRequest=${o.seatsPerRequest}  event=${r.eventId}`);
  lines.push(hr, ` HOLD PHASE: ${r.durationMs} ms total, ~${r.throughputRps} req/s`);
  for (const [k, v] of Object.entries(r.holdPhase.statusCounts).sort()) lines.push(`   ${k.padEnd(40)} ${v}`);
  lines.push(`   latency: ${lat(r.holdPhase.latencyMs)}`);
  if (r.confirmPhase) {
    const c = r.confirmPhase;
    lines.push(hr, ' CONFIRM PHASE (each confirm double-clicked + retried with same Idempotency-Key)');
    for (const [k, v] of Object.entries(c.duplicateResponses).sort()) lines.push(`   ${k.padEnd(40)} ${v}`);
    lines.push(`   holds booked: ${c.confirmed}   distinct booking ids: ${c.distinctBookingIds}   late retry replayed same booking: ${c.replayMatched}`);
    lines.push(`   latency: ${lat(c.latencyMs)}`);
  }
  const s = r.checks.server as Record<string, unknown>;
  lines.push(hr, ' CORRECTNESS CHECKS');
  lines.push(`   seats granted to >1 hold (client view) : ${r.checks.seatsGrantedTwice.length}`);
  lines.push(`   holds with >1 booking (client view)    : ${r.checks.holdsWithMultipleBookings}`);
  lines.push(`   double-booked seats (SQL)              : ${(s.doubleBookedSeats as unknown[] | undefined)?.length ?? '?'}`);
  lines.push(`   seats with overlapping live holds (SQL): ${(s.seatsWithOverlappingHolds as unknown[] | undefined)?.length ?? '?'}`);
  lines.push(`   seat status / booking mismatches (SQL) : ${s.statusMismatches ?? '?'}`);
  lines.push(`   bookings in DB: ${s.bookings}  booked seats: ${s.seatsBooked}/${s.seatsTotal}`);
  lines.push(hr, r.checks.passed ? ' RESULT: PASS - zero double-bookings' : ' RESULT: FAIL - see checks above', hr);
  return lines.join('\n');
}
