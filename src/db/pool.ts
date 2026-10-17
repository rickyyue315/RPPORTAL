import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/** For tests only: swap in an in-memory / custom pool. */
export function setPoolForTesting(customPool: pg.Pool): void {
  pool = customPool;
}

export { pool };

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs one maintenance operation per database at a time. The session-level
 * advisory lock is released automatically if the process exits.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)::bigint) AS locked',
      [key],
    );
    locked = Boolean(result.rows[0]?.locked);
    if (!locked) return null;
    return await fn(client);
  } finally {
    if (locked) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)::bigint)',
          [key],
        );
      } catch (err) {
        console.error('[db] failed to release advisory lock', err);
      }
    }
    client.release();
  }
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for PostgreSQL before running migrations. Railway starts the web
 * service and its database concurrently, so the first connection can fail
 * while PostgreSQL is still provisioning.
 */
export async function waitForDatabase(): Promise<void> {
  const attempts = config.databaseStartupRetries;
  const delayMs = config.databaseStartupRetryMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      if (attempt > 1) {
        console.log(`[db] ready after ${attempt} attempts`);
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      console.warn(`[db] not ready (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Database did not become ready');
}
