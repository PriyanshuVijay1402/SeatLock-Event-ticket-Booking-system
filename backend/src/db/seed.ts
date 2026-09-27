/**
 * Seed script: an admin, a couple of demo users, and sample events with seat
 * maps so you can click around immediately.   Usage: npm run seed
 *
 * Idempotent-ish: events are only created if no events exist yet.
 */
import { createEvent } from '../booking/adminService';
import { pool, query } from './pool';
import { runMigrations } from './migrate';

const day = 864e5;
const inDays = (d: number, hour: number) => {
  const t = new Date(Date.now() + d * day);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};

async function seed() {
  await runMigrations();

  // Users. "admin" can create events and run the ticket drop from the UI.
  await query(
    `INSERT INTO users (name, is_admin) VALUES ('admin', true), ('alice', false), ('bob', false)
     ON CONFLICT (name) DO UPDATE SET is_admin = EXCLUDED.is_admin`,
  );
  console.log('[seed] users: admin (admin), alice, bob');

  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM events');
  if (n > 0) {
    console.log(`[seed] ${n} events already exist, skipping event creation`);
    return;
  }

  const events = [
    {
      name: 'The Midnight Echoes — World Tour',
      kind: 'CONCERT' as const,
      venue: 'Riverside Arena',
      startsAt: inDays(14, 19),
      sections: [
        { name: 'VIP', rows: 3, seatsPerRow: 10, priceCents: 25000 },
        { name: 'Floor', rows: 8, seatsPerRow: 20, priceCents: 12000 },
        { name: 'Balcony', rows: 6, seatsPerRow: 16, priceCents: 6000 },
      ],
    },
    {
      name: 'Interstellar (IMAX re-release)',
      kind: 'MOVIE' as const,
      venue: 'Cineplex Screen 1',
      startsAt: inDays(3, 20),
      sections: [
        { name: 'Standard', rows: 10, seatsPerRow: 14, priceCents: 1500 },
        { name: 'Recliner', rows: 2, seatsPerRow: 10, priceCents: 2800 },
      ],
    },
    {
      name: 'Jazz Night at the Blue Room',
      kind: 'CONCERT' as const,
      venue: 'The Blue Room',
      startsAt: inDays(7, 21),
      sections: [{ name: 'Tables', rows: 5, seatsPerRow: 8, priceCents: 4500 }],
    },
  ];
  for (const e of events) {
    const { id, seatCount } = await createEvent({ ...e });
    console.log(`[seed] event "${e.name}" -> ${id} (${seatCount} seats)`);
  }
}

seed()
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
