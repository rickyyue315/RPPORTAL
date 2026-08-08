import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const dir = path.join(__dirname, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  let lockHeld = false;
  try {
    // Serialize migration discovery and execution across all application
    // instances. The lock is session-scoped and is released on disconnect.
    await client.query(
      'SELECT pg_advisory_lock(hashtextextended($1, 0)::bigint)',
      ['ndrf:schema-migrations'],
    );
    lockHeld = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (applied.rowCount) continue;

      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] failed ${file}`, err);
        throw err;
      }
    }
  } finally {
    if (lockHeld) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)::bigint)',
          ['ndrf:schema-migrations'],
        );
      } catch (err) {
        console.error('[migrate] failed to release migration lock', err);
      }
    }
    client.release();
  }
}
