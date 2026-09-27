/**
 * Mock payment provider. No real money moves; this only exists so the
 * checkout flow has a realistic "external call that can fail" in it.
 *
 * Like real providers (Stripe etc.), it accepts an idempotency key: a real
 * provider dedupes charges with the same key on ITS side, so our retries can
 * never double-charge even if our own bookkeeping failed mid-flight.
 *
 * IMPORTANT DESIGN RULE: we call this OUTSIDE the DB transaction. Holding row
 * locks while waiting on a slow network call would block every other booker
 * of those seats for the duration of the call.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { sleep } from '../db/tx';

export type PaymentOutcome = 'success' | 'fail';

export interface ChargeResult {
  ok: boolean;
  paymentRef: string;
}

export async function charge(args: { amountCents: number; idempotencyKey: string; outcome: PaymentOutcome }): Promise<ChargeResult> {
  await sleep(config.mockPaymentLatencyMs);
  return { ok: args.outcome === 'success', paymentRef: `mockpay_${randomUUID().slice(0, 8)}` };
}

/** Compensating action when we charged but then couldn't finalize the booking. */
export async function refund(paymentRef: string): Promise<void> {
  await sleep(config.mockPaymentLatencyMs / 2);
  console.log(`[payment] refunded ${paymentRef}`);
}
