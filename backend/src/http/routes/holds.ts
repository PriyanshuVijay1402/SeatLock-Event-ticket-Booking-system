/**
 * Write path: hold seats -> confirm (pay) or cancel.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { getHoldJob, requestHold } from '../../booking/checkout';
import { MAX_SEATS_PER_HOLD, confirmHold, listBookingsForUser, releaseHold } from '../../booking/service';
import type { HoldResult } from '../../booking/types';
import { abandonIdempotent, beginIdempotent, completeIdempotent } from '../../redis/idempotency';
import { bookingRateLimit } from '../../redis/rateLimit';
import { requireUser } from '../auth';
import { HttpError, modeFor, parseBody, redisLockFor, strategyFor, uuidParam } from '../util';

export const holdsRouter = Router();

const HoldBody = z.object({
  seatIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_SEATS_PER_HOLD)
    .refine((ids) => new Set(ids).size === ids.length, 'seat ids must be unique'),
});

/** Maps a HoldResult to an HTTP response. */
function sendHoldResult(res: import('express').Response, result: HoldResult): void {
  if (result.ok) {
    res.status(201).json({ hold: result });
  } else if (result.reason === 'INVALID_SEATS') {
    res.status(400).json({ error: result.reason, message: 'Some seats do not exist for this event.' });
  } else {
    res.status(409).json({ error: result.reason, message: 'Some seats are no longer available.', unavailableSeatIds: result.unavailableSeatIds });
  }
}

/**
 * POST /api/events/:eventId/holds  { seatIds: [..] }
 * Headers (demo knobs): X-Lock-Strategy: pessimistic|optimistic, X-Checkout-Mode: queue|direct
 */
holdsRouter.post('/events/:eventId/holds', requireUser, bookingRateLimit, async (req, res) => {
  const eventId = uuidParam(req, 'eventId');
  const { seatIds } = parseBody(HoldBody, req.body);
  const outcome = await requestHold({ eventId, userId: req.user!.id, seatIds }, { strategy: strategyFor(req), mode: modeFor(req), useRedisLock: redisLockFor(req) });

  switch (outcome.kind) {
    case 'locked':
      res.status(409).json({ error: 'SEAT_LOCKED', message: 'Someone else is checking out one of these seats right now.' });
      return;
    case 'shed':
      res.setHeader('Retry-After', '2');
      res.status(503).json({ error: 'QUEUE_FULL', message: 'Too many people are booking right now. Please retry.' });
      return;
    case 'pending':
      res.status(202).json({ jobId: outcome.jobId, message: 'Still in the queue. Poll /api/hold-jobs/:jobId.' });
      return;
    case 'done':
      sendHoldResult(res, outcome.result);
  }
});

/** Poll a queued hold request that didn't finish within the wait timeout. */
holdsRouter.get('/hold-jobs/:jobId', requireUser, async (req, res) => {
  const job = await getHoldJob(String(req.params.jobId));
  if (job.state === 'unknown' || job.userId !== req.user!.id) throw new HttpError(404, 'NOT_FOUND', 'Unknown job');
  if (job.state !== 'completed' || !job.result) {
    res.status(202).json({ state: job.state });
    return;
  }
  sendHoldResult(res, job.result);
});

/** Hold details (used by the checkout page, e.g. after a refresh). */
holdsRouter.get('/holds/:holdId', requireUser, async (req, res) => {
  const holdId = uuidParam(req, 'holdId');
  const [hold] = await query(
    `SELECT h.id, h.event_id AS "eventId", h.status, h.expires_at AS "expiresAt",
            array_agg(s.id ORDER BY s.id) AS "seatIds",
            json_agg(json_build_object('id', s.id, 'section', s.section, 'row', s.row_label,
                                       'number', s.seat_number, 'priceCents', s.price_cents) ORDER BY s.id) AS seats,
            sum(s.price_cents)::int AS "totalCents"
       FROM booking_holds h
       JOIN booking_hold_seats hs ON hs.hold_id = h.id
       JOIN seats s ON s.id = hs.seat_id
      WHERE h.id = $1 AND h.user_id = $2
      GROUP BY h.id`,
    [holdId, req.user!.id],
  );
  if (!hold) throw new HttpError(404, 'NOT_FOUND', 'Hold not found');
  res.json({ hold });
});

const ConfirmBody = z.object({
  /** Mock payment result to simulate. */
  paymentOutcome: z.enum(['success', 'fail']).default('success'),
});

/**
 * POST /api/holds/:holdId/confirm   Header: Idempotency-Key: <client-generated uuid>
 *
 * Idempotency flow (DESIGN.md §7):
 *   new key          -> process, store response, return it
 *   same key, running-> 409 IDEMPOTENCY_IN_PROGRESS (client should retry shortly)
 *   same key, done   -> replay the stored response (no second charge, no second booking)
 *   same key, other hold -> 422 (client bug)
 */
holdsRouter.post('/holds/:holdId/confirm', requireUser, bookingRateLimit, async (req, res) => {
  const holdId = uuidParam(req, 'holdId');
  const idemKey = req.header('idempotency-key');
  if (!idemKey || idemKey.length < 8 || idemKey.length > 100) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-100 chars).');
  }
  const { paymentOutcome } = parseBody(ConfirmBody, req.body ?? {});
  const userId = req.user!.id;
  const fingerprint = `confirm:${holdId}`;

  const begin = await beginIdempotent(userId, idemKey, fingerprint);
  if (begin.kind === 'replay') {
    res.setHeader('Idempotent-Replayed', 'true');
    res.status(begin.statusCode).json(begin.body);
    return;
  }
  if (begin.kind === 'in_progress') {
    res.setHeader('Retry-After', '1');
    res.status(409).json({ error: 'IDEMPOTENCY_IN_PROGRESS', message: 'This request is already being processed.' });
    return;
  }
  if (begin.kind === 'mismatch') {
    res.status(422).json({ error: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was used for a different request.' });
    return;
  }

  try {
    const outcome = await confirmHold({ holdId, userId, idempotencyKey: idemKey, paymentOutcome, strategyName: strategyFor(req) });
    await completeIdempotent(userId, idemKey, fingerprint, outcome.status, outcome.body);
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    await abandonIdempotent(userId, idemKey);
    throw err;
  }
});

/** Cancel a hold: seats go straight back to AVAILABLE. */
holdsRouter.delete('/holds/:holdId', requireUser, async (req, res) => {
  const holdId = uuidParam(req, 'holdId');
  const result = await releaseHold(holdId, req.user!.id);
  if (result === 'not_found') throw new HttpError(404, 'NOT_FOUND', 'Hold not found');
  if (result === 'not_active') throw new HttpError(409, 'HOLD_NOT_ACTIVE', 'Hold is no longer active');
  res.status(204).end();
});

holdsRouter.get('/me/bookings', requireUser, async (req, res) => {
  const bookings = await listBookingsForUser(req.user!.id);
  res.json({ bookings });
});
