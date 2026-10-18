// A thin database layer over node-postgres (production) or PGlite (local development and tests).
// Both take the same SQL with $1, $2 placeholders and return { rows }.
import { MIGRATIONS } from './schema.mjs';

const LOCK = 734211; // advisory lock id for migrations

export function wrap(client) {
  const db = {
    async query(sql, params = []) {
      return (await client.query(sql, params)).rows;
    },
    async one(sql, params = []) {
      return (await client.query(sql, params)).rows[0] || null;
    },
    // Several statements, no parameters.
    async exec(sql) {
      if (client.exec) await client.exec(sql);
      else await client.query(sql);
    },
    close: () => client.end?.() ?? client.close?.(),
    raw: client,
  };
  return db;
}

export async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query('SELECT version FROM schema_migrations')).map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.exec(`BEGIN;
SELECT pg_advisory_xact_lock(${LOCK});
${m.sql}
INSERT INTO schema_migrations (version) VALUES (${m.version}) ON CONFLICT DO NOTHING;
COMMIT;`);
  }
}

// Production: one small pool per function instance, released cleanly when the instance is suspended.
export async function poolFromUrl(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(1082, (v) => v); // DATE stays 'YYYY-MM-DD'
  const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 });
  pool.on('error', (e) => console.error('database pool error:', e.message));
  try {
    const { attachDatabasePool } = await import('@vercel/functions');
    attachDatabasePool(pool);
  } catch {}
  return wrap(pool);
}
