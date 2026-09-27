-- =============================================================================
-- 001_schema.sql — core schema for the ticket booking system
-- =============================================================================
--
-- Design goals (see DESIGN.md §1 for the full discussion + ER diagram):
--
--   1. A seat must NEVER be double-booked. We enforce this at THREE layers:
--        a) Redis lock (fast filter, best-effort)            -> app code
--        b) Row locks / version checks in the transaction    -> app code (raw SQL)
--        c) Constraints in this file (UNIQUE / CHECK / FK)   -> the database itself
--      Layer (c) is the one that can't be bypassed by a bug in (a) or (b):
--      even if every piece of application code were wrong, the INSERT into
--      booking_seats for an already-booked seat would fail.
--
--   2. Normalized (3NF): each fact lives in one place. The only deliberate
--      "denormalization" is seats.status / seats.current_hold_id, which caches
--      "who currently owns this seat" on the seat row itself. We need that,
--      because the seat row is the thing we LOCK — the lock target and the
--      state it protects must be the same row.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- users — deliberately minimal mock user system (no passwords, no OAuth).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    is_admin    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- events — a concert or a movie screening.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('CONCERT', 'MOVIE')),
    venue       TEXT NOT NULL,
    starts_at   TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- booking_holds — a temporary reservation ("you have 5 minutes to pay").
--
-- Lifecycle:  ACTIVE --confirm--> CONFIRMED
--                   --timeout--> EXPIRED    (background sweeper)
--                   --cancel---> RELEASED   (user clicked "cancel")
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_holds (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id),
    event_id    UUID NOT NULL REFERENCES events(id),
    status      TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'CONFIRMED', 'EXPIRED', 'RELEASED')),
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sweeper's query is "ACTIVE holds whose expires_at has passed".
-- A PARTIAL index only contains ACTIVE rows, so it stays tiny even after
-- millions of historical (CONFIRMED/EXPIRED) holds accumulate.
CREATE INDEX IF NOT EXISTS idx_holds_active_expiry
    ON booking_holds (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_holds_user ON booking_holds (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- seats — one row per physical seat for one event.
--
--   status           : AVAILABLE | HELD | BOOKED   (current state)
--   version          : optimistic-concurrency counter; bumped on EVERY change.
--   current_hold_id  : which hold currently owns the seat (only when HELD).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seats (
    id               BIGSERIAL PRIMARY KEY,
    event_id         UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    section          TEXT NOT NULL,
    row_label        TEXT NOT NULL,
    seat_number      INT  NOT NULL CHECK (seat_number > 0),
    price_cents      INT  NOT NULL CHECK (price_cents >= 0),
    status           TEXT NOT NULL DEFAULT 'AVAILABLE'
                     CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED')),
    version          INT  NOT NULL DEFAULT 0,
    current_hold_id  UUID REFERENCES booking_holds(id),

    -- A physical seat exists once per event.
    CONSTRAINT uq_seat_position UNIQUE (event_id, section, row_label, seat_number),

    -- Invariant: "HELD" <=> "has an owning hold". Makes illegal states
    -- (HELD with no owner, or BOOKED but still pointing at a hold) unrepresentable.
    CONSTRAINT chk_hold_consistency CHECK ((status = 'HELD') = (current_hold_id IS NOT NULL))
);

-- THE index for the hot read path: "show me the available seats for event X".
--   SELECT ... FROM seats WHERE event_id = $1 AND status = 'AVAILABLE'
-- Without it, Postgres scans every seat of every event. With a composite
-- (event_id, status) B-tree it jumps straight to the matching slice.
-- event_id comes first because it is ALWAYS in the predicate (equality), and it
-- also serves plain "all seats for event X" queries via the leftmost prefix.
-- See DESIGN.md §4 for the scale discussion.
CREATE INDEX IF NOT EXISTS idx_seats_event_status ON seats (event_id, status);

-- Lets the sweeper / confirm path find "seats owned by hold H" without a scan.
CREATE INDEX IF NOT EXISTS idx_seats_current_hold ON seats (current_hold_id)
    WHERE current_hold_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- booking_hold_seats — which seats a hold asked for (junction table, M:N).
-- Kept separately from seats.current_hold_id because the hold must remember
-- its seats even after it expires and someone else grabs them.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_hold_seats (
    hold_id  UUID   NOT NULL REFERENCES booking_holds(id) ON DELETE CASCADE,
    seat_id  BIGINT NOT NULL REFERENCES seats(id),
    PRIMARY KEY (hold_id, seat_id)
);

-- -----------------------------------------------------------------------------
-- bookings — a confirmed, paid purchase.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id),
    event_id         UUID NOT NULL REFERENCES events(id),
    -- One hold can become at most one booking (double-confirm protection).
    hold_id          UUID NOT NULL UNIQUE REFERENCES booking_holds(id),
    total_cents      INT  NOT NULL CHECK (total_cents >= 0),
    payment_ref      TEXT NOT NULL,
    -- Idempotency: the same client key can never produce two bookings for the
    -- same user. This is the DURABLE half of idempotency (Redis is the fast half).
    idempotency_key  TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_booking_idempotency UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- booking_seats — which seats a booking bought.
--
-- *** THE LAST LINE OF DEFENSE AGAINST DOUBLE-BOOKING ***
-- UNIQUE (seat_id): a seat can appear in at most ONE booking, ever.
-- (There is no cancellation/refund feature in scope; if there were, this would
--  become a partial unique index on active bookings only.)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_seats (
    booking_id   UUID   NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    seat_id      BIGINT NOT NULL REFERENCES seats(id),
    price_cents  INT    NOT NULL,   -- price at purchase time (seat price may change later)
    PRIMARY KEY (booking_id, seat_id),
    CONSTRAINT uq_seat_booked_once UNIQUE (seat_id)
);
