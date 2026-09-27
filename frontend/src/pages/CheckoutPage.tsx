import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, money, type Hold } from '../api';
import { ErrorBox } from '../App';

export default function CheckoutPage() {
  const { holdId } = useParams();
  const navigate = useNavigate();
  const [hold, setHold] = useState<Hold | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<{ id: string; replayed: boolean } | null>(null);

  // ONE idempotency key per payment attempt. Double-clicks and network retries
  // reuse it, so the server processes the payment at most once. After a
  // declined payment we mint a new key: that's a genuinely new attempt.
  const idemKey = useRef(crypto.randomUUID());

  useEffect(() => {
    api<{ hold: Hold }>(`/holds/${holdId}`)
      .then(({ data }) => setHold(data.hold))
      .catch((err) => setError(err.message));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [holdId]);

  const msLeft = hold ? new Date(hold.expiresAt).getTime() - now : 0;
  const expired = hold !== null && hold.status === 'ACTIVE' && msLeft <= 0;
  const mm = Math.max(0, Math.floor(msLeft / 60000));
  const ss = Math.max(0, Math.floor((msLeft % 60000) / 1000));

  const pay = async (paymentOutcome: 'success' | 'fail') => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api(`/holds/${holdId}/confirm`, {
        method: 'POST',
        body: { paymentOutcome },
        headers: { 'Idempotency-Key': idemKey.current },
      });
      setBooked({ id: data.booking.id, replayed: Boolean(data.replayed) });
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'PAYMENT_FAILED') idemKey.current = crypto.randomUUID();
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await api(`/holds/${holdId}`, { method: 'DELETE' });
    } catch {
      /* already gone */
    }
    navigate(hold ? `/events/${hold.eventId}` : '/');
  };

  if (booked) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border bg-white p-6 text-center">
        <div className="text-3xl">✅</div>
        <h1 className="mt-2 text-lg font-semibold">Booking confirmed</h1>
        <p className="mt-1 text-sm text-slate-500">Booking id {booked.id}</p>
        <Link to="/bookings" className="mt-4 inline-block text-sm underline">
          View my bookings
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 rounded-lg border bg-white p-6">
      <h1 className="text-lg font-semibold">Checkout</h1>
      {hold && (
        <>
          <div className={`rounded-md px-3 py-2 text-sm ${expired || hold.status !== 'ACTIVE' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
            {hold.status !== 'ACTIVE'
              ? `This hold is ${hold.status.toLowerCase()}.`
              : expired
                ? 'Your hold expired — the seats have been released.'
                : `Seats held for you for ${mm}:${String(ss).padStart(2, '0')}`}
          </div>
          <ul className="divide-y text-sm">
            {hold.seats.map((s) => (
              <li key={s.id} className="flex justify-between py-1.5">
                <span>
                  {s.section} · Row {s.row} · Seat {s.number}
                </span>
                <span>{money(s.priceCents)}</span>
              </li>
            ))}
            <li className="flex justify-between py-1.5 font-semibold">
              <span>Total</span>
              <span>{money(hold.totalCents)}</span>
            </li>
          </ul>
          <ErrorBox error={error} />
          <div className="space-y-2">
            <button
              disabled={busy || expired || hold.status !== 'ACTIVE'}
              onClick={() => pay('success')}
              className="w-full rounded-md bg-emerald-600 py-2 text-white disabled:opacity-40"
            >
              {busy ? 'Processing…' : 'Pay (mock: succeeds)'}
            </button>
            <button
              disabled={busy || expired || hold.status !== 'ACTIVE'}
              onClick={() => pay('fail')}
              className="w-full rounded-md border border-red-300 py-2 text-red-700 disabled:opacity-40"
            >
              Pay (mock: card declined)
            </button>
            <button onClick={cancel} className="w-full py-2 text-sm text-slate-500 underline">
              Cancel and release seats
            </button>
          </div>
          <p className="text-xs text-slate-400">Idempotency-Key for this attempt: {idemKey.current}</p>
        </>
      )}
      {!hold && <ErrorBox error={error} />}
    </div>
  );
}
