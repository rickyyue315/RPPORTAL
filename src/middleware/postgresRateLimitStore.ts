import type { Store, ClientRateLimitInfo, IncrementResponse } from 'express-rate-limit';
import { query } from '../db/pool.js';

/**
 * PostgreSQL-backed rate-limit store. Every application instance shares the
 * same atomic counter, so limits remain effective when the service scales out.
 */
export class PostgresRateLimitStore implements Store {
  public readonly localKeys = false;

  constructor(private readonly windowMs: number) {}

  async increment(key: string): Promise<IncrementResponse> {
    const result = await query<{ hits: number; reset_at: string }>(
      `INSERT INTO rate_limit_counters (key, hits, reset_at)
       VALUES ($1, 1, now() + ($2::int * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE
       SET hits = CASE
                    WHEN rate_limit_counters.reset_at <= now() THEN 1
                    ELSE rate_limit_counters.hits + 1
                  END,
           reset_at = CASE
                        WHEN rate_limit_counters.reset_at <= now() THEN EXCLUDED.reset_at
                        ELSE rate_limit_counters.reset_at
                      END,
           updated_at = now()
       RETURNING hits, reset_at`,
      [key, this.windowMs],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Rate-limit counter was not returned');
    return {
      totalHits: Number(row.hits),
      resetTime: new Date(row.reset_at),
    };
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const result = await query<{ hits: number; reset_at: string }>(
      `SELECT hits, reset_at
         FROM rate_limit_counters
        WHERE key = $1 AND reset_at > now()`,
      [key],
    );
    const row = result.rows[0];
    return row
      ? { totalHits: Number(row.hits), resetTime: new Date(row.reset_at) }
      : undefined;
  }

  async decrement(key: string): Promise<void> {
    await query(
      `UPDATE rate_limit_counters
          SET hits = GREATEST(hits - 1, 0), updated_at = now()
        WHERE key = $1 AND reset_at > now()`,
      [key],
    );
  }

  async resetKey(key: string): Promise<void> {
    await query('DELETE FROM rate_limit_counters WHERE key = $1', [key]);
  }

  async resetAll(): Promise<void> {
    await query('DELETE FROM rate_limit_counters');
  }
}
