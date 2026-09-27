/**
 * Minimal migration runner: applies every db/migrations/*.sql file in name
 * order, once, recording what ran in a schema_migrations table.
 *
 * Usage: npm run migrate   (the API also calls runMigrations() on startup)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './pool';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // An advisory lock makes this safe when several API replicas boot at once:
    // only one of them runs migrations, the others wait and then see them done.
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
    client.release();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => console.log('[migrate] done'))
    .catch((err) => {
      console.error('[migrate] failed', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
