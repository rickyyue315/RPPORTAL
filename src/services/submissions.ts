import { query, withTransaction } from '../db/pool.js';
import { generateApplicationNo } from '../lib/applicationNo.js';
import { ipExpiryIso } from '../lib/ip.js';
import { normalizeText, type SubmissionBusinessFields } from '../lib/fields.js';
import { toHKDateString, hkTodayForDateColumn } from '../lib/time.js';
import { normalizeSiteCode } from './stores.js';

export interface SubmissionRow {
  id: string;
  application_no: string;
  source: 'web' | 'excel';
  site_code: string;
  requested_by_email: string;
  application_date: string;
  submitted_at: string;
  brand: string | null;
  sku: string;
  rp_type: string | null;
  supply_source: string | null;
  safety_stock: string | null;
  nd_code: string | null;
  rp_parameters_change_request: string | null;
  rp_type_completed_at: string | null;
  remark: string | null;
  status: string;
  exported_at: string | null;
  export_batch_id: string | null;
  locked_at: string | null;
  created_ip: string | null;
  created_ip_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ActorRole = 'applicant' | 'admin';

export interface CreateSubmissionInput {
  siteCode: string;
  shopName?: string;
  source: 'web' | 'excel';
  fields: SubmissionBusinessFields;
  ip: string;
  changeSource: string;
  actor?: string;
  applicationDateOverride?: string;
}

export interface ModifySubmissionInput {
  applicationNo: string;
  siteCode: string;
  fields: SubmissionBusinessFields;
  ip: string;
  actorRole: ActorRole;
  actor?: string;
  changeSource: string;
}

export function businessFieldsFromRow(row: SubmissionRow): SubmissionBusinessFields {
  return {
    brand: normalizeText(row.brand),
    sku: normalizeText(row.sku),
    rp_type: normalizeText(row.rp_type),
    supply_source: normalizeText(row.supply_source),
    safety_stock: normalizeText(row.safety_stock),
    nd_code: normalizeText(row.nd_code),
    rp_parameters_change_request: normalizeText(row.rp_parameters_change_request),
    rp_type_completed_at: normalizeText(row.rp_type_completed_at),
    remark: normalizeText(row.remark),
  };
}

function toBusinessParams(fields: SubmissionBusinessFields): unknown[] {
  return [
    normalizeText(fields.brand) || null,
    normalizeText(fields.sku),
    normalizeText(fields.rp_type) || null,
    normalizeText(fields.supply_source) || null,
    normalizeText(fields.safety_stock) || null,
    normalizeText(fields.nd_code) || null,
    normalizeText(fields.rp_parameters_change_request) || null,
    normalizeText(fields.rp_type_completed_at) || null,
    normalizeText(fields.remark) || null,
  ];
}

async function nextApplicationNo(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const no = generateApplicationNo();
    const existing = await query('SELECT 1 FROM submissions WHERE application_no = $1', [no]);
    if (!existing.rowCount) return no;
  }
  throw new Error('無法產生唯一申請編號');
}

export async function createSubmission(
  input: CreateSubmissionInput,
): Promise<SubmissionRow> {
  const siteCode = normalizeSiteCode(input.siteCode);
  const fields = input.fields;
  const requestedByEmail = `${siteCode.toLowerCase()}@sasa.com`;
  const applicationDate = input.applicationDateOverride ?? hkTodayForDateColumn();

  return withTransaction(async (client) => {
    const applicationNo = await nextApplicationNo();
    const values = [
      applicationNo,
      input.source,
      siteCode,
      requestedByEmail,
      applicationDate,
      ...toBusinessParams(fields),
      input.ip,
      input.ip ? ipExpiryIso() : null,
    ];
    const result = await client.query<SubmissionRow>(
      `INSERT INTO submissions (
         application_no, source, site_code, requested_by_email, application_date,
         brand, sku, rp_type, supply_source, safety_stock, nd_code,
         rp_parameters_change_request, rp_type_completed_at, remark,
         created_ip, created_ip_expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      values,
    );
    const row = result.rows[0]!;

    await client.query(
      `INSERT INTO submission_versions
         (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
       VALUES ($1, 1, NULL, $2, $3, $4, $5, $6)`,
      [
        row.id,
        JSON.stringify(fields),
        input.source === 'web' ? 'applicant' : 'applicant',
        input.actor ?? null,
        input.ip,
        input.changeSource,
      ],
    );

    return row;
  });
}

export async function getSubmissionByApplicationNo(
  applicationNo: string,
  siteCode?: string,
): Promise<SubmissionRow | null> {
  const normNo = applicationNo.trim().toUpperCase();
  const result = await query<SubmissionRow>(
    `SELECT * FROM submissions WHERE application_no = $1 ${siteCode ? 'AND site_code = $2' : ''}`,
    siteCode ? [normNo, normalizeSiteCode(siteCode)] : [normNo],
  );
  return result.rows[0] ?? null;
}

export async function getSubmissionById(id: string): Promise<SubmissionRow | null> {
  const result = await query<SubmissionRow>('SELECT * FROM submissions WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function listVersions(
  submissionId: string,
): Promise<
  Array<{
    version: number;
    data_before: SubmissionBusinessFields | null;
    data_after: SubmissionBusinessFields;
    actor_role: string;
    actor: string | null;
    ip: string | null;
    change_source: string;
    changed_at: string;
  }>
> {
  const result = await query(
    `SELECT version, data_before, data_after, actor_role, actor, ip, change_source, changed_at
     FROM submission_versions
     WHERE submission_id = $1
     ORDER BY version ASC`,
    [submissionId],
  );
  return result.rows as never[];
}

export class LockedError extends Error {
  constructor(public lockedAt: Date | null) {
    super('此申報已匯出並鎖定，不能修改');
    this.name = 'LockedError';
  }
}

export async function modifySubmission(
  input: ModifySubmissionInput,
): Promise<SubmissionRow> {
  const siteCode = normalizeSiteCode(input.siteCode);
  const fields = input.fields;
  return withTransaction(async (client) => {
    const rowResult = await client.query<SubmissionRow>(
      'SELECT * FROM submissions WHERE application_no = $1 AND site_code = $2',
      [input.applicationNo.trim().toUpperCase(), siteCode],
    );
    const row = rowResult.rows[0];
    if (!row) {
      throw new Error('找不到申報');
    }
    if (row.locked_at || row.exported_at) {
      throw new LockedError(row.locked_at ? new Date(row.locked_at) : null);
    }

    const before = businessFieldsFromRow(row);
    const updated = await client.query<SubmissionRow>(
      `UPDATE submissions SET
         brand = $1, sku = $2, rp_type = $3, supply_source = $4, safety_stock = $5,
         nd_code = $6, rp_parameters_change_request = $7, rp_type_completed_at = $8,
         remark = $9, updated_at = now()
       WHERE id = $10
       RETURNING *`,
      [...toBusinessParams(fields), row.id],
    );
    const newRow = updated.rows[0]!;

    const versionResult = await client.query<{ max: number | null }>(
      'SELECT max(version) AS max FROM submission_versions WHERE submission_id = $1',
      [row.id],
    );
    const nextVersion = (versionResult.rows[0]?.max ?? 0) + 1;

    await client.query(
      `INSERT INTO submission_versions
         (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.id,
        nextVersion,
        JSON.stringify(before),
        JSON.stringify(fields),
        input.actorRole,
        input.actor ?? null,
        input.ip,
        input.changeSource,
      ],
    );

    return newRow;
  });
}

export async function adminUpdateSubmission(
  id: string,
  fields: SubmissionBusinessFields,
  ip: string,
  username: string,
): Promise<SubmissionRow> {
  return withTransaction(async (client) => {
    const rowResult = await client.query<SubmissionRow>(
      'SELECT * FROM submissions WHERE id = $1',
      [id],
    );
    const row = rowResult.rows[0];
    if (!row) throw new Error('找不到申報');

    const before = businessFieldsFromRow(row);
    const updated = await client.query<SubmissionRow>(
      `UPDATE submissions SET
         brand = $1, sku = $2, rp_type = $3, supply_source = $4, safety_stock = $5,
         nd_code = $6, rp_parameters_change_request = $7, rp_type_completed_at = $8,
         remark = $9, updated_at = now()
       WHERE id = $10
       RETURNING *`,
      [...toBusinessParams(fields), row.id],
    );
    const newRow = updated.rows[0]!;

    const versionResult = await client.query<{ max: number | null }>(
      'SELECT max(version) AS max FROM submission_versions WHERE submission_id = $1',
      [row.id],
    );
    const nextVersion = (versionResult.rows[0]?.max ?? 0) + 1;

    await client.query(
      `INSERT INTO submission_versions
         (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.id, nextVersion, JSON.stringify(before), JSON.stringify(fields), 'admin', username, ip, 'admin_edit'],
    );

    return newRow;
  });
}

export function toHKDateStringSafe(value: string | null): string {
  return value ? toHKDateString(value) : '';
}
