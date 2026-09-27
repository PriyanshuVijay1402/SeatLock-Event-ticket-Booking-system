import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, when, type EventSummary } from '../api';
import { ErrorBox } from '../App';

export default function EventsPage() {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ events: EventSummary[] }>('/events')
      .then(({ data }) => setEvents(data.events))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Events</h1>
      <ErrorBox error={error} />
      {events?.length === 0 && <p className="text-slate-500">No events yet. Run the seed script or create one in Admin.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {events?.map((e) => (
          <Link key={e.id} to={`/events/${e.id}`} className="rounded-lg border bg-white p-4 hover:border-slate-400">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{e.kind === 'MOVIE' ? '🎬 Movie' : '🎤 Concert'}</div>
            <div className="mt-1 font-medium">{e.name}</div>
            <div className="mt-1 text-sm text-slate-500">
              {e.venue} · {when(e.starts_at)}
            </div>
            <div className="mt-3 text-sm">
              <span className={e.available ? 'text-emerald-700' : 'text-red-600'}>{e.available} available</span>
              <span className="text-slate-400"> / {e.total} seats</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
