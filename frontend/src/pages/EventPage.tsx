import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, money, when, type EventSummary, type Seat } from '../api';
import { ErrorBox } from '../App';

const MAX_SEATS = 10;

export default function EventPage() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const [event, setEvent] = useState<EventSummary | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);

  const loadSeats = useCallback(async () => {
    const { data } = await api<{ seats: Seat[] }>(`/events/${eventId}/seats`);
    setSeats(data.seats);
    // Drop selections that someone else just took.
    const free = new Set(data.seats.filter((s) => s.status === 'AVAILABLE').map((s) => s.id));
    setSelected((prev) => new Set([...prev].filter((id) => free.has(id))));
  }, [eventId]);

  useEffect(() => {
    api<{ event: EventSummary }>(`/events/${eventId}`)
      .then(({ data }) => setEvent(data.event))
      .catch((err) => setError(err.message));
    loadSeats().catch((err) => setError(err.message));

    // Real-time availability: the server pushes "seats changed" over SSE,
    // then we re-fetch the (Redis-cached) seat map.
    const source = new EventSource(`/api/events/${eventId}/stream`);
    source.addEventListener('hello', () => setLive(true));
    source.addEventListener('seats', () => void loadSeats());
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [eventId, loadSeats]);

  // section -> row -> seats
  const layout = useMemo(() => {
    const sections = new Map<string, Map<string, Seat[]>>();
    for (const s of seats) {
      if (!sections.has(s.section)) sections.set(s.section, new Map());
      const rows = sections.get(s.section)!;
      if (!rows.has(s.row)) rows.set(s.row, []);
      rows.get(s.row)!.push(s);
    }
    return sections;
  }, [seats]);

  const toggle = (seat: Seat) => {
    if (seat.status !== 'AVAILABLE') return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seat.id)) next.delete(seat.id);
      else if (next.size < MAX_SEATS) next.add(seat.id);
      return next;
    });
  };

  const selectedSeats = seats.filter((s) => selected.has(s.id));
  const total = selectedSeats.reduce((sum, s) => sum + s.priceCents, 0);

  const hold = async () => {
    setBusy(true);
    setError(null);
    try {
      let res = await api(`/events/${eventId}/holds`, { method: 'POST', body: { seatIds: [...selected] } });
      // 202 = still in the checkout queue; poll until a worker processes it.
      while (res.status === 202) {
        await new Promise((r) => setTimeout(r, 500));
        res = await api(`/hold-jobs/${res.data.jobId ?? ''}`);
      }
      navigate(`/checkout/${res.data.hold.holdId}`);
    } catch (err) {
      const e = err as ApiError;
      setError(
        e.code === 'SEAT_LOCKED' || e.code === 'SEATS_UNAVAILABLE'
          ? 'Sorry — someone grabbed one of those seats first. The map has been refreshed.'
          : e.message,
      );
      await loadSeats();
    } finally {
      setBusy(false);
    }
  };

  const seatClass = (s: Seat) => {
    if (selected.has(s.id)) return 'bg-blue-600 text-white border-blue-700';
    if (s.status === 'AVAILABLE') return 'bg-white hover:bg-emerald-100 border-emerald-500 text-emerald-800';
    if (s.status === 'HELD') return 'bg-amber-200 border-amber-300 text-amber-800 cursor-not-allowed';
    return 'bg-slate-300 border-slate-300 text-slate-500 cursor-not-allowed';
  };

  return (
    <div className="space-y-4">
      {event && (
        <div>
          <h1 className="text-xl font-semibold">{event.name}</h1>
          <p className="text-sm text-slate-500">
            {event.venue} · {when(event.starts_at)}
            <span className={`ml-3 ${live ? 'text-emerald-600' : 'text-slate-400'}`}>{live ? '● live' : '○ connecting…'}</span>
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-4 text-xs text-slate-600">
        <Legend cls="bg-white border-emerald-500" label="Available" />
        <Legend cls="bg-blue-600 border-blue-700" label="Selected" />
        <Legend cls="bg-amber-200 border-amber-300" label="Held (in someone's checkout)" />
        <Legend cls="bg-slate-300 border-slate-300" label="Booked" />
      </div>

      <div className="space-y-6 overflow-x-auto rounded-lg border bg-white p-4">
        <div className="mx-auto w-2/3 rounded bg-slate-200 py-1 text-center text-xs uppercase tracking-widest text-slate-500">
          {event?.kind === 'MOVIE' ? 'Screen' : 'Stage'}
        </div>
        {[...layout].map(([section, rows]) => (
          <div key={section}>
            <div className="mb-2 text-sm font-medium">
              {section} <span className="font-normal text-slate-400">· {money(rows.values().next().value![0].priceCents)}</span>
            </div>
            <div className="space-y-1">
              {[...rows].map(([row, rowSeats]) => (
                <div key={row} className="flex items-center gap-1">
                  <span className="w-5 text-xs text-slate-400">{row}</span>
                  {rowSeats.map((s) => (
                    <button
                      key={s.id}
                      title={`${section} ${row}${s.number} · ${money(s.priceCents)} · ${s.status}`}
                      onClick={() => toggle(s)}
                      className={`h-6 w-6 shrink-0 rounded border text-[10px] ${seatClass(s)}`}
                    >
                      {s.number}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <ErrorBox error={error} />

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-lg border bg-white p-4">
        <div className="text-sm">
          {selectedSeats.length === 0 ? (
            <span className="text-slate-500">Select up to {MAX_SEATS} seats.</span>
          ) : (
            <>
              <b>{selectedSeats.length}</b> seat(s): {selectedSeats.map((s) => `${s.section} ${s.row}${s.number}`).join(', ')} — <b>{money(total)}</b>
            </>
          )}
        </div>
        <button
          disabled={selected.size === 0 || busy}
          onClick={hold}
          className="ml-auto rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {busy ? 'Reserving…' : 'Hold seats & checkout'}
        </button>
      </div>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-3.5 w-3.5 rounded border ${cls}`} /> {label}
    </span>
  );
}
