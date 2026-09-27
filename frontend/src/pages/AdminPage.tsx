import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, useAuth } from '../App';

export default function AdminPage() {
  const { user } = useAuth();
  if (!user?.isAdmin) return <p className="text-slate-500">Admins only. Log in as “admin”.</p>;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <CreateEvent />
      <TicketDrop />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface SectionForm {
  name: string;
  rows: number;
  seatsPerRow: number;
  price: number;
}

function CreateEvent() {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'CONCERT' | 'MOVIE'>('CONCERT');
  const [venue, setVenue] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [sections, setSections] = useState<SectionForm[]>([{ name: 'General', rows: 5, seatsPerRow: 10, price: 50 }]);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; seatCount: number } | null>(null);

  const update = (i: number, patch: Partial<SectionForm>) => setSections((s) => s.map((sec, j) => (j === i ? { ...sec, ...patch } : sec)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreated(null);
    try {
      const { data } = await api('/admin/events', {
        method: 'POST',
        body: {
          name,
          kind,
          venue,
          startsAt: new Date(startsAt).toISOString(),
          sections: sections.map((s) => ({ name: s.name, rows: s.rows, seatsPerRow: s.seatsPerRow, priceCents: Math.round(s.price * 100) })),
        },
      });
      setCreated(data.event);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const input = 'w-full rounded-md border px-2 py-1.5 text-sm';
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border bg-white p-5">
      <h2 className="font-semibold">Create event</h2>
      <input className={input} placeholder="Event name" value={name} onChange={(e) => setName(e.target.value)} required />
      <div className="grid grid-cols-2 gap-2">
        <select className={input} value={kind} onChange={(e) => setKind(e.target.value as 'CONCERT' | 'MOVIE')}>
          <option value="CONCERT">Concert</option>
          <option value="MOVIE">Movie</option>
        </select>
        <input className={input} placeholder="Venue" value={venue} onChange={(e) => setVenue(e.target.value)} required />
      </div>
      <input className={input} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />

      <div className="space-y-2">
        <div className="grid grid-cols-[1fr_4rem_4rem_4.5rem_1.5rem] gap-2 text-xs text-slate-500">
          <span>Section</span>
          <span>Rows</span>
          <span>Seats/row</span>
          <span>Price $</span>
          <span />
        </div>
        {sections.map((s, i) => (
          <div key={i} className="grid grid-cols-[1fr_4rem_4rem_4.5rem_1.5rem] gap-2">
            <input className={input} value={s.name} onChange={(e) => update(i, { name: e.target.value })} required />
            <input className={input} type="number" min={1} max={26} value={s.rows} onChange={(e) => update(i, { rows: +e.target.value })} />
            <input className={input} type="number" min={1} max={50} value={s.seatsPerRow} onChange={(e) => update(i, { seatsPerRow: +e.target.value })} />
            <input className={input} type="number" min={0} step="0.01" value={s.price} onChange={(e) => update(i, { price: +e.target.value })} />
            <button type="button" className="text-slate-400" onClick={() => setSections((x) => x.filter((_, j) => j !== i))} disabled={sections.length === 1}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-sm text-slate-600 underline"
          onClick={() => setSections((x) => [...x, { name: `Section ${x.length + 1}`, rows: 3, seatsPerRow: 10, price: 30 }])}
        >
          + Add section
        </button>
      </div>

      <ErrorBox error={error} />
      {created && (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Created with {created.seatCount} seats. <Link className="underline" to={`/events/${created.id}`}>Open it</Link>
        </div>
      )}
      <button className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white">Create event</button>
    </form>
  );
}

// ---------------------------------------------------------------------------

interface Latency {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
interface DropReport {
  eventId: string;
  durationMs: number;
  throughputRps: number;
  holdPhase: { statusCounts: Record<string, number>; successfulHolds: number; latencyMs: Latency };
  confirmPhase?: { confirmed: number; duplicateResponses: Record<string, number>; distinctBookingIds: number; replayMatched: boolean; latencyMs: Latency };
  checks: {
    seatsGrantedTwice: number[];
    holdsWithMultipleBookings: number;
    server: { doubleBookedSeats: number[]; seatsWithOverlappingHolds: number[]; statusMismatches: number; bookings: number; seatsBooked: number; seatsTotal: number };
    passed: boolean;
  };
}

function TicketDrop() {
  const [opts, setOpts] = useState({
    requests: 1000,
    concurrency: 200,
    users: 500,
    hotSeats: 10,
    seatsPerRequest: 1,
    strategy: 'pessimistic',
    mode: 'queue',
    redisLock: true,
    confirm: true,
  });
  const [report, setReport] = useState<DropReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const { data } = await api<{ report: DropReport }>('/admin/ticket-drop', { method: 'POST', body: opts });
      setReport(data.report);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const num = (key: keyof typeof opts, label: string) => (
    <label className="text-xs text-slate-500">
      {label}
      <input
        type="number"
        className="mt-0.5 w-full rounded-md border px-2 py-1.5 text-sm text-slate-900"
        value={opts[key] as number}
        onChange={(e) => setOpts({ ...opts, [key]: +e.target.value })}
      />
    </label>
  );

  return (
    <div className="space-y-3 rounded-lg border bg-white p-5">
      <h2 className="font-semibold">🔥 Ticket drop simulation</h2>
      <p className="text-sm text-slate-500">
        Creates a fresh event and fires concurrent hold requests at a few “hot” seats through the real API, then confirms winners with duplicate
        clicks and verifies no seat was double-booked.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {num('requests', 'Requests')}
        {num('concurrency', 'Concurrency')}
        {num('users', 'Users')}
        {num('hotSeats', 'Hot seats')}
        {num('seatsPerRequest', 'Seats / request')}
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label>
          Strategy{' '}
          <select className="rounded border px-1 py-0.5" value={opts.strategy} onChange={(e) => setOpts({ ...opts, strategy: e.target.value })}>
            <option value="pessimistic">pessimistic (FOR UPDATE)</option>
            <option value="optimistic">optimistic (version)</option>
          </select>
        </label>
        <label>
          Mode{' '}
          <select className="rounded border px-1 py-0.5" value={opts.mode} onChange={(e) => setOpts({ ...opts, mode: e.target.value })}>
            <option value="queue">queue</option>
            <option value="direct">direct</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={opts.redisLock} onChange={(e) => setOpts({ ...opts, redisLock: e.target.checked })} /> Redis pre-lock
        </label>
        <label>
          <input type="checkbox" checked={opts.confirm} onChange={(e) => setOpts({ ...opts, confirm: e.target.checked })} /> Confirm phase
        </label>
      </div>
      <button onClick={run} disabled={running} className="rounded-md bg-orange-600 px-4 py-2 text-sm text-white disabled:opacity-50">
        {running ? 'Dropping tickets…' : 'Run ticket drop'}
      </button>
      <ErrorBox error={error} />
      {report && <Report r={report} />}
    </div>
  );
}

function Report({ r }: { r: DropReport }) {
  const lat = (l: Latency) => `p50 ${l.p50} · p95 ${l.p95} · p99 ${l.p99} · max ${l.max} ms`;
  const s = r.checks.server;
  const rows: [string, number][] = [
    ['Seats granted to >1 hold (client)', r.checks.seatsGrantedTwice.length],
    ['Holds with >1 booking (client)', r.checks.holdsWithMultipleBookings],
    ['Double-booked seats (SQL)', s.doubleBookedSeats.length],
    ['Seats with overlapping live holds (SQL)', s.seatsWithOverlappingHolds.length],
    ['Seat status / booking mismatches (SQL)', s.statusMismatches],
  ];
  return (
    <div className="space-y-3 text-sm">
      <div className={`rounded-md px-3 py-2 font-semibold ${r.checks.passed ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>
        {r.checks.passed ? 'PASS — zero double-bookings' : 'FAIL — see checks'}
      </div>
      <div>
        <div className="font-medium">
          Hold phase — {r.durationMs} ms, ~{r.throughputRps} req/s
        </div>
        <Counts counts={r.holdPhase.statusCounts} />
        <div className="text-slate-500">{lat(r.holdPhase.latencyMs)}</div>
      </div>
      {r.confirmPhase && (
        <div>
          <div className="font-medium">Confirm phase (double-click + retry, same Idempotency-Key)</div>
          <Counts counts={r.confirmPhase.duplicateResponses} />
          <div className="text-slate-500">
            {r.confirmPhase.confirmed} holds booked · {r.confirmPhase.distinctBookingIds} distinct bookings · retry replayed same booking:{' '}
            {String(r.confirmPhase.replayMatched)}
          </div>
        </div>
      )}
      <table className="w-full">
        <tbody>
          {rows.map(([label, n]) => (
            <tr key={label} className="border-t">
              <td className="py-1">{label}</td>
              <td className={`py-1 text-right font-mono ${n === 0 ? 'text-emerald-700' : 'text-red-600'}`}>{n}</td>
            </tr>
          ))}
          <tr className="border-t">
            <td className="py-1">Bookings in DB / booked seats</td>
            <td className="py-1 text-right font-mono">
              {s.bookings} / {s.seatsBooked} of {s.seatsTotal}
            </td>
          </tr>
        </tbody>
      </table>
      <Link to={`/events/${r.eventId}`} className="underline">
        View the event's seat map
      </Link>
    </div>
  );
}

function Counts({ counts }: { counts: Record<string, number> }) {
  return (
    <ul className="my-1 font-mono text-xs">
      {Object.entries(counts)
        .sort()
        .map(([k, v]) => (
          <li key={k} className="flex justify-between">
            <span>{k}</span>
            <span>{v}</span>
          </li>
        ))}
    </ul>
  );
}
