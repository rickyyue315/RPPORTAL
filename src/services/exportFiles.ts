import type pg from 'pg';
import { query } from '../db/pool.js';

export const EXPORT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Store the exact formal export so a committed lock can always be recovered. */
export async function archiveExportBatchFile(
  client: pg.PoolClient,
  batchId: string,
  filename: string,
  buffer: Buffer,
  retentionDays: number,
): Promise<void> {
  await client.query(
    `INSERT INTO export_batch_files
       (export_batch_id, filename, content_type, file_data, file_size, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 day'))`,
    [batchId, filename, EXPORT_CONTENT_TYPE, buffer, buffer.length, retentionDays],
  );
}

/** Drop the large binary payload while keeping batch metadata and auditability. */
export async function cleanupExpiredExportFiles(): Promise<number> {
  const result = await query(
    `UPDATE export_batch_files
        SET file_data = NULL
      WHERE file_data IS NOT NULL
        AND expires_at <= now()
     RETURNING export_batch_id`,
  );
  return Math.max(result.rowCount ?? 0, result.rows.length);
}
