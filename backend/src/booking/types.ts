/**
 * Shared types for the booking core. Both locking strategies implement
 * `LockStrategy`, so the rest of the app can swap them freely.
 */
import type { LockStrategyName } from '../config';

export interface HoldRequest {
  eventId: string;
  userId: string;
  seatIds: number[];
}

export type HoldFailureReason =
  | 'SEATS_UNAVAILABLE' // someone else holds/bought at least one seat
  | 'INVALID_SEATS' // a seat id doesn't exist or belongs to another event
  | 'CONFLICT_RETRIES_EXHAUSTED'; // optimistic: lost the race too many times in a row

export type HoldResult =
  | { ok: true; holdId: string; expiresAt: string; seatIds: number[]; totalCents: number; attempts: number }
  | { ok: false; reason: HoldFailureReason; unavailableSeatIds?: number[]; attempts: number };

export interface ConfirmRequest {
  holdId: string;
  userId: string;
  idempotencyKey: string;
  paymentRef: string;
}

export interface BookingDto {
  id: string;
  holdId: string;
  eventId: string;
  userId: string;
  seatIds: number[];
  totalCents: number;
  paymentRef: string;
  createdAt: string;
}

export type ConfirmFailureReason =
  | 'HOLD_NOT_FOUND'
  | 'HOLD_EXPIRED' // too late: the 5 minutes ran out
  | 'HOLD_NOT_ACTIVE' // already confirmed / released
  | 'SEATS_LOST' // hold expired and someone else grabbed a seat in the meantime
  | 'CONFLICT_RETRIES_EXHAUSTED';

export type ConfirmResult =
  | { ok: true; booking: BookingDto }
  | { ok: false; reason: ConfirmFailureReason };

export interface LockStrategy {
  name: LockStrategyName;
  holdSeats(req: HoldRequest): Promise<HoldResult>;
  confirmHold(req: ConfirmRequest): Promise<ConfirmResult>;
}

/** Row shape returned when we read seats inside a booking transaction. */
export interface SeatRow {
  id: number;
  status: 'AVAILABLE' | 'HELD' | 'BOOKED';
  version: number;
  price_cents: number;
  current_hold_id: string | null;
}
