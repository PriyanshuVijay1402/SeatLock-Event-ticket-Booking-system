# SeatLock: Event Ticket Booking System

A learning project about **concurrency control, system design and scalability**.
Users browse events, pick seats on a grid, hold them for 5 minutes, and confirm
with a mock payment. The main demo is a **ticket-drop simulation**: thousands of
concurrent requests for the same seats, followed by a report showing zero
double-bookings and the latency distribution.

- **Backend:** Node.js + Express + TypeScript, raw SQL via `pg` (no ORM around the locking code)
- **Database:** PostgreSQL 16 (row locks, version column, explicit isolation levels)
- **Redis:** distributed seat locks, rate limits, idempotency records, seat-map cache, pub/sub
- **Queue:** BullMQ (Redis-backed) for checkout under load
- **Frontend:** React + TypeScript + Tailwind (Vite)

**Read [DESIGN.md](DESIGN.md)** for the why: schema + ER diagram, the two
locking strategies, the isolation-level choice, queueing explained through OS
scheduling and semaphores, idempotency, the scalability plan, and measured results.

---

> **Step-by-step terminal guide, including free public deployment
> (Render + Neon + Redis Cloud): see [RUNNING.md](RUNNING.md).**

## Quick start (Docker)

Requires Docker Desktop.

```bash
docker compose up -d --build
docker compose exec api node dist/db/seed.js     # sample events + users
```

Open **http://localhost:8080**. Log in with any name:

- `alice` / `bob`: regular users
- `admin`: also gets the **Admin** tab (create events, run a ticket drop from the UI)

To see real-time updates, open the same event in two browser windows (e.g. alice
and bob). Holding a seat in one window turns it amber in the other within about
half a second.

Services:

| Service | What | Host port |
|---|---|---|
| `frontend` | nginx serving the SPA, proxying `/api` to all API replicas | 8080 |
| `api` | stateless HTTP API (scalable) | – (via nginx) |
| `worker` | queue consumer + hold-expiry sweeper (scalable) | – |
| `postgres` | PostgreSQL 16 | 5433 |
| `redis` | Redis 7 | 6379 |

Scale out (all state is in Postgres/Redis, so this works as-is):

```bash
docker compose up -d --scale api=3 --scale worker=2
curl localhost:8080/api/health     # "instance" shows which replica answered
```

## Run the ticket drop / load test

Inside the API container (fastest, no network hops):

```bash
docker compose exec api node dist/scripts/ticketDrop.js --url http://localhost:4000
```

Or from your machine through nginx (exercises the load balancer and every replica):

```bash
cd backend && npm install
npm run ticket-drop -- --url http://localhost:8080
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--requests` | 1000 | total hold attempts |
| `--concurrency` | 200 | requests in flight at once |
| `--users` | 500 | distinct simulated users |
| `--hot-seats` | 10 | size of the seat subset everyone fights over (1 = everyone wants the same seat) |
| `--seats-per-request` | 1 | seats per hold (1–4; >1 exercises lock ordering) |
| `--strategy` | pessimistic | `pessimistic` (SELECT FOR UPDATE) or `optimistic` (version column) |
| `--mode` | queue | `queue` (BullMQ) or `direct` (API hits the DB itself) |
| `--no-redis-lock` | off | skip the Redis pre-lock so the whole herd reaches Postgres |
| `--no-confirm` | off | skip the confirm/idempotency phase |
| `--compare` | off | run all 4 strategy × mode combos and print a summary table |
| `--json` | off | machine-readable report |

Each run creates a fresh event, logs in N users, and fires the drop. Each winner
then confirms **twice at the same instant with the same Idempotency-Key** (a
double-click) and once more afterwards (a retry). Finally the script checks
correctness client-side and with raw-SQL checks on the server. The exit code is
1 if any check fails.

```
----------------------------------------------------------------
 HOLD PHASE: 2373 ms total, ~843 req/s
   201 HOLD_CREATED                         5
   409 SEATS_UNAVAILABLE                    36
   409 SEAT_LOCKED                          1959
   latency: p50 272.6 ms | p95 891 ms | p99 910 ms | max 1274.4 ms  (n=2000)
----------------------------------------------------------------
 CONFIRM PHASE (each confirm double-clicked + retried with same Idempotency-Key)
   201 BOOKED                               5
   409 IDEMPOTENCY_IN_PROGRESS              5
   holds booked: 5   distinct booking ids: 5   late retry replayed same booking: true
----------------------------------------------------------------
 CORRECTNESS CHECKS
   seats granted to >1 hold (client view) : 0
   holds with >1 booking (client view)    : 0
   double-booked seats (SQL)              : 0
   seats with overlapping live holds (SQL): 0
   seat status / booking mismatches (SQL) : 0
----------------------------------------------------------------
 RESULT: PASS - zero double-bookings
```

Experiments worth trying (see DESIGN.md §11 for our results):

```bash
# Compare all strategies/modes
npm run ticket-drop -- --compare --requests 2000 --concurrency 300 --users 1000 --seats-per-request 2

# Remove the Redis filter: are the DB locks enough on their own?
npm run ticket-drop -- --compare --no-redis-lock

# Worst case: 5,000 people, one seat. Look for 503 DB_OVERLOADED in direct mode.
npm run ticket-drop -- --hot-seats 1 --requests 5000 --concurrency 1000 --users 2500 \
  --no-redis-lock --strategy pessimistic --mode direct --no-confirm
```

To change the **isolation level** or other knobs, edit `x-backend-env` in
`docker-compose.yml` (e.g. `BOOKING_ISOLATION: SERIALIZABLE`) and run
`docker compose up -d`.

## Running without Docker for the app (dev mode)

Start only the infrastructure in Docker, then run the app with hot reload:

```bash
docker compose up -d postgres redis

cd backend
npm install
export DATABASE_URL=postgres://ticketing:ticketing@localhost:5433/ticketing   # PowerShell: $env:DATABASE_URL="..."
export RATE_LIMIT_IP_MAX=100000
npm run seed            # runs migrations + sample data
npm run dev:api         # terminal 1 -> http://localhost:4000
npm run dev:worker      # terminal 2

cd ../frontend
npm install
npm run dev             # http://localhost:5173 (proxies /api to :4000)
```

All configuration is in environment variables. See `backend/.env.example` and
`backend/src/config.ts` (each knob is commented).

## API overview

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{name}` → `{user, token}` (mock; send as `Authorization: Bearer <token>`) |
| GET | `/api/events` | list with available/total counts |
| GET | `/api/events/:id/seats` | seat map (Redis-cached, `X-Cache: hit/miss`) |
| GET | `/api/events/:id/stream` | Server-Sent Events: `seats` event whenever the map changes |
| POST | `/api/events/:id/holds` | `{seatIds}` → 201 hold / 409 taken / 202 still queued / 429 / 503 |
| GET | `/api/hold-jobs/:jobId` | poll a queued hold |
| GET | `/api/holds/:id` | hold details + expiry |
| POST | `/api/holds/:id/confirm` | **requires `Idempotency-Key`**; body `{paymentOutcome: "success" \| "fail"}` |
| DELETE | `/api/holds/:id` | cancel hold, release seats |
| GET | `/api/me/bookings` | the user's bookings |
| POST | `/api/admin/events` | create event + seat map (admin) |
| POST | `/api/admin/ticket-drop` | run the simulation (admin) |
| GET | `/api/admin/integrity/:eventId` | raw-SQL double-booking checks (admin) |
| GET | `/api/health` | pool (semaphore) stats, queue counts, active config |

Demo-only request headers: `X-Lock-Strategy: pessimistic|optimistic`,
`X-Checkout-Mode: queue|direct`, `X-Redis-Lock: off`.

## Project layout

```
backend/
  db/migrations/001_schema.sql   schema, constraints, indexes (commented)
  src/
    config.ts                    every knob, documented
    db/        pool.ts (semaphore) · tx.ts (isolation + retry) · migrate.ts · seed.ts
    booking/   pessimistic.ts · optimistic.ts · shared.ts · checkout.ts · service.ts · payment.ts · adminService.ts
    redis/     lock.ts · idempotency.ts · rateLimit.ts · seatEvents.ts (cache + pub/sub)
    queue/     checkoutQueue.ts (BullMQ producer + worker)
    http/      app.ts · auth.ts · util.ts · routes/
    sim/       ticketDrop.ts (simulation + report)
    scripts/   ticketDrop.ts (CLI)
    server.ts  API entry        worker.ts  worker entry
    all.ts     API + worker in one process (single-container free hosting)
frontend/      React app (events, seat grid, checkout with countdown, bookings, admin)
DESIGN.md      the write-up
RUNNING.md     step-by-step run + free deployment guide
Dockerfile.deploy  single-container image (site + API + worker) for Render/Koyeb
```

## Resetting

```bash
docker compose down -v    # removes the Postgres volume too
```
