import { query, withTransaction } from '../db/pool.js';
import { toHKDateString } from '../lib/time.js';
import { normalizeSiteCode } from './stores.js';
import { archiveExportBatchFile } from './exportFiles.js';
import type { SubmissionRow } from './submissions.js';

export type ExportSubmissionType = 'normal' | 'urgent' | 'sales' | 'return';

export interface ExportFilters {
  from?: string;
  to?: string;
  site_code?: string;
  include_exported: boolean;
  preview?: boolean;
}

export interface ExportDefinition {
  submissionType: ExportSubmissionType;
  filenamePrefix: string;
  buildBuffer: (rows: SubmissionRow[]) => Promise<Buffer>;
}

export interface ExportQuery {
  whereSql: string;
  params: unknown[];
}

export interface LockedExportResult {
  batchId: string;
  buffer: Buffer;
  count: number;
}

export function buildExportQuery(
  submissionType: ExportSubmissionType,
  filters: ExportFilters,
): ExportQuery {
  const where: string[] = ['submission_type = $1'];
  const params: unknown[] = [submissionType];
  let index = 2;
  if (filters.from) {
    where.push(`application_date >= $${index++}`);
    params.push(filters.from);
  }
  if (filters.to) {
    where.push(`application_date <= $${index++}`);
    params.push(filters.to);
  }
  if (filters.site_code) {
    where.push(`site_code = $${index++}`);
    params.push(normalizeSiteCode(filters.site_code));
  }
  if (!filters.include_exported) where.push('exported_at IS NULL');
  if (submissionType === 'normal') {
    // Only workflow-approved general NDRF may be handed to SAP. Pending,
    // rejected and legacy rows are excluded at the SQL layer, never by the UI.
    where.push(`workflow_status IN ('ready_for_rp', 'accepted')`);
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

export async function findExportRows(
  submissionType: ExportSubmissionType,
  filters: ExportFilters,
): Promise<SubmissionRow[]> {
  const { whereSql, params } = buildExportQuery(submissionType, filters);
  const result = await query<SubmissionRow>(
    `SELECT * FROM submissions ${whereSql} ORDER BY application_date ASC, submitted_at ASC`,
    params,
  );
  return result.rows;
}

export function exportFilename(definition: ExportDefinition, preview: boolean): string {
  return `${definition.filenamePrefix}_${preview ? 'Preview' : 'Export'}_${toHKDateString(new Date())}.xlsx`;
}

export async function createLockedExport(
  definition: ExportDefinition,
  filters: ExportFilters,
  createdBy: string,
  retentionDays: number,
): Promise<LockedExportResult | null> {
  if (filters.include_exported) {
    // Safe re-export: archive the rows again without touching exported_at,
    // locked_at, workflow status or review decisions. A re-download must never
    // become a second business export.
    return createArchiveExport(definition, filters, createdBy, retentionDays);
  }
  const { whereSql, params } = buildExportQuery(definition.submissionType, filters);
  return withTransaction(async (client) => {
    const lockedRows = await client.query<SubmissionRow>(
      `SELECT * FROM submissions ${whereSql} ORDER BY application_date ASC, submitted_at ASC FOR UPDATE`,
      params,
    );
    if (lockedRows.rows.length === 0) return null;

    const buffer = await definition.buildBuffer(lockedRows.rows);
    const filename = exportFilename(definition, false);
    const batch = await client.query<{ id: string }>(
      `INSERT INTO export_batches (filename, submission_count, submission_nos, filters, created_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id`,
      [
        filename,
        lockedRows.rows.length,
        JSON.stringify(lockedRows.rows.map((row) => row.application_no)),
        JSON.stringify({ ...filters, submission_type: definition.submissionType }),
        createdBy,
      ],
    );
    const batchId = batch.rows[0]!.id;
    await archiveExportBatchFile(client, batchId, filename, buffer, retentionDays);
    await client.query(
      `UPDATE submissions
          SET exported_at = now(), export_batch_id = $1, locked_at = now(),
              active_workflow = false, updated_at = now()
        WHERE id = ANY($2::uuid[])`,
      [batchId, lockedRows.rows.map((row) => row.id)],
    );
    return { batchId, buffer, count: lockedRows.rows.length };
  });
}

/**
 * Read-only re-export: creates a new export batch archive for the selected
 * rows (including previously exported ones) but never updates the underlying
 * submissions, so a re-download cannot change workflow state, cooldown or lock
 * timestamps.
 */
export async function createArchiveExport(
  definition: ExportDefinition,
  filters: ExportFilters,
  createdBy: string,
  retentionDays: number,
): Promise<LockedExportResult | null> {
  const { whereSql, params } = buildExportQuery(definition.submissionType, filters);
  return withTransaction(async (client) => {
    const rows = await client.query<SubmissionRow>(
      `SELECT * FROM submissions ${whereSql} ORDER BY application_date ASC, submitted_at ASC`,
      params,
    );
    if (rows.rows.length === 0) return null;

    const buffer = await definition.buildBuffer(rows.rows);
    const filename = exportFilename(definition, false);
    const batch = await client.query<{ id: string }>(
      `INSERT INTO export_batches (filename, submission_count, submission_nos, filters, created_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id`,
      [
        filename,
        rows.rows.length,
        JSON.stringify(rows.rows.map((row) => row.application_no)),
        JSON.stringify({ ...filters, submission_type: definition.submissionType, re_export: true }),
        createdBy,
      ],
    );
    const batchId = batch.rows[0]!.id;
    await archiveExportBatchFile(client, batchId, filename, buffer, retentionDays);
    return { batchId, buffer, count: rows.rows.length };
  });
}
