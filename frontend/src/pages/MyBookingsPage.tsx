import { useEffect, useState } from 'react';
import { api, money, when, type Booking } from '../api';
import { ErrorBox } from '../App';

export default function MyBookingsPage() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ bookings: Booking[] }>('/me/bookings')
      .then(({ data }) => setBookings(data.bookings))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">My bookings</h1>
      <ErrorBox error={error} />
      {bookings?.length === 0 && <p className="text-slate-500">No bookings yet.</p>}
      <div className="space-y-3">
        {bookings?.map((b) => (
          <div key={b.id} className="rounded-lg border bg-white p-4">
            <div className="flex flex-wrap justify-between gap-2">
              <div className="font-medium">{b.eventName}</div>
              <div className="font-semibold">{money(b.totalCents)}</div>
            </div>
            <div className="text-sm text-slate-500">{when(b.startsAt)}</div>
            <div className="mt-2 text-sm">{b.seatLabels.join(', ')}</div>
            <div className="mt-2 text-xs text-slate-400">
              Booking {b.id} · payment {b.paymentRef} · {when(b.createdAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
