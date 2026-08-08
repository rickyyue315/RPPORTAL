import type pg from 'pg';
import { query } from '../db/pool.js';

export type ImportSubmissionType = 'normal' | 'urgent' | 'sales' | 'return';

type Queryable = Pick<pg.PoolClient, 'query'>;

export interface ImportBatchRow {
  id: string;
  filename: string;
  sheet_name: string;
  row_count: number;
  success_count: number;
  failed_count: number;
  results: unknown[];
  content_hash: string;
  created_by: string;
  submission_type: ImportSubmissionType;
  idempotency_key: string | null;
  created_at: string;
}

export interface CreateImportBatchInput {
  filename: string;
  sheetName: string;
  rowCount: number;
  successCount: number;
  failedCount: number;
  results: unknown[];
  contentHash: string;
  createdBy: string;
  submissionType: ImportSubmissionType;
  idempotencyKey?: string | null;
}

export async function createImportBatch(
  executor: Queryable,
  input: CreateImportBatchInput,
): Promise<string> {
  const result = await executor.query<{ id: string }>(
    `INSERT INTO import_batches
       (filename, sheet_name, row_count, success_count, failed_count, results,
        content_hash, created_by, submission_type, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     RETURNING id`,
    [
      input.filename,
      input.sheetName,
      input.rowCount,
      input.successCount,
      input.failedCount,
      JSON.stringify(input.results),
      input.contentHash,
      input.createdBy,
      input.submissionType,
      input.idempotencyKey ?? null,
    ],
  );
  return result.rows[0]!.id;
}

/** Serialize the idempotent result using the same response contract as a new import. */
export function importBatchResponse(batch: ImportBatchRow) {
  return {
    batchId: batch.id,
    message: `成功匯入 ${batch.success_count} 行`,
    totalRows: batch.row_count,
    successCount: batch.success_count,
    rows: batch.results,
    replayed: true,
  };
}

export async function lockImportIdempotencyKey(
  client: Queryable,
  key: string,
  submissionType: ImportSubmissionType,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 1)::bigint)',
    [`import:${submissionType}:${key}`],
  );
}

export async function findImportBatchByIdempotencyKey(
  executor: Queryable,
  key: string,
  submissionType: ImportSubmissionType,
): Promise<ImportBatchRow | null> {
  const result = await executor.query<ImportBatchRow>(
    `SELECT id, filename, sheet_name, row_count, success_count, failed_count,
            results, content_hash, created_by, submission_type, idempotency_key, created_at
       FROM import_batches
      WHERE idempotency_key = $1 AND submission_type = $2
      LIMIT 1`,
    [key, submissionType],
  );
  return result.rows[0] ?? null;
}

export async function findImportBatchByKey(
  key: string,
  submissionType: ImportSubmissionType,
): Promise<ImportBatchRow | null> {
  const result = await query<ImportBatchRow>(
    `SELECT id, filename, sheet_name, row_count, success_count, failed_count,
            results, content_hash, created_by, submission_type, idempotency_key, created_at
       FROM import_batches
      WHERE idempotency_key = $1 AND submission_type = $2
      LIMIT 1`,
    [key, submissionType],
  );
  return result.rows[0] ?? null;
}
export async function getPublicImportBatchRecord(
  batchId: string,
  key: string,
  submissionType: ImportSubmissionType,
): Promise<ImportBatchRow | null> {
  const result = await query<ImportBatchRow>(
    `SELECT id, filename, sheet_name, row_count, success_count, failed_count,
            results, content_hash, created_by, submission_type, idempotency_key, created_at
       FROM import_batches
      WHERE id = $1 AND idempotency_key = $2 AND submission_type = $3 AND created_by = 'applicant'`,
    [batchId, key, submissionType],
  );
  return result.rows[0] ?? null;
}
