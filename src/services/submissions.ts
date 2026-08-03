import { query, withTransaction } from '../db/pool.js';
import { generateApplicationNo } from '../lib/applicationNo.js';
import { ipExpiryIso } from '../lib/ip.js';
import {
  normalizeText,
  type SubmissionBusinessFields,
  URGENT_QTY_MIN,
  URGENT_QTY_MAX,
} from '../lib/fields.js';
import { validateUrgentReason } from '../lib/validation.js';
import { toHKDateString, hkTodayForDateColumn } from '../lib/time.js';
import { normalizeSiteCode } from './stores.js';

export type SubmissionType = 'normal' | 'urgent';

export interface SubmissionRow {
  id: string;
  application_no: string;
  source: 'web' | 'excel';
  submission_type: SubmissionType;
  site_code: string;
  requested_by_email: string;
  application_date: string;
  submitted_at: string;
  brand: string | null;
  sku: string;
  rp_type: string | null;
  safety_stock: string | null;
  nd_code: string | null;
  remark: string | null;
  qty: number | null;
  urgent_reason: string | null;
  urgent_reason_other: string | null;
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
  submissionType?: SubmissionType;
  fields: SubmissionBusinessFields;
  qty?: number | null;
  urgentReason?: string | null;
  urgentReasonOther?: string | null;
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
    safety_stock: normalizeText(row.safety_stock),
    nd_code: normalizeText(row.nd_code),
    remark: normalizeText(row.remark),
  };
}

export function urgentFieldsFromRow(row: SubmissionRow): {
  site_code: string;
  sku: string;
  qty: number | null;
  urgent_reason: string | null;
  urgent_reason_other: string | null;
} {
  return {
    site_code: row.site_code,
    sku: normalizeText(row.sku),
    qty: row.qty,
    urgent_reason: normalizeText(row.urgent_reason) || null,
    urgent_reason_other: normalizeText(row.urgent_reason_other) || null,
  };
}

function toBusinessParams(fields: SubmissionBusinessFields): unknown[] {
  return [
    normalizeText(fields.brand) || null,
    normalizeText(fields.sku),
    normalizeText(fields.rp_type) || null,
    normalizeText(fields.safety_stock) || null,
    normalizeText(fields.nd_code) || null,
    normalizeText(fields.remark) || null,
  ];
}

async function nextApplicationNo(prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const no = generateApplicationNo(prefix);
    const existing = await query('SELECT 1 FROM submissions WHERE application_no = $1', [no]);
    if (!existing.rowCount) return no;
  }
  throw new Error('無法產生唯一申請編號');
}

interface DuplicateCheckClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Enforces the "one submission per Site Code + SKU + day" rule.
 * The same SKU + Site Code may only be submitted once per application_date
 * (HK date) within the same submission type. Re-application is allowed from
 * the next day because application_date changes.
 */
async function assertNoDuplicate(
  client: DuplicateCheckClient,
  params: { siteCode: string; sku: string; submissionType: SubmissionType; date: string; excludeId?: string },
): Promise<void> {
  const { siteCode, sku, submissionType, date, excludeId } = params;
  const result = await client.query(
    `SELECT 1 FROM submissions
     WHERE site_code = $1 AND sku = $2 AND submission_type = $3
       AND application_date = $4::date
       AND ($5::uuid IS NULL OR id <> $5)
     LIMIT 1`,
    [siteCode, normalizeText(sku), submissionType, date, excludeId ?? null],
  );
  if (result.rows.length > 0) {
    throw new DuplicateSubmissionError();
  }
}

export async function createSubmission(
  input: CreateSubmissionInput,
): Promise<SubmissionRow> {
  const siteCode = normalizeSiteCode(input.siteCode);
  const fields = input.fields;
  const submissionType: SubmissionType = input.submissionType ?? 'normal';
  const isUrgent = submissionType === 'urgent';
  const qty = isUrgent ? (input.qty ?? null) : null;
  if (isUrgent) {
    if (!(typeof qty === 'number' && Number.isInteger(qty) && qty >= URGENT_QTY_MIN && qty <= URGENT_QTY_MAX)) {
      throw new Error(`QTY 必須為 ${URGENT_QTY_MIN} 至 ${URGENT_QTY_MAX} 的整數`);
    }
    const reasonErrors = validateUrgentReason(input.urgentReason, input.urgentReasonOther);
    if (reasonErrors.length) {
      throw new Error(reasonErrors[0]!.message);
    }
  }
  const requestedByEmail = `${siteCode.toLowerCase()}@sasa.com`;
  const applicationDate = input.applicationDateOverride ?? hkTodayForDateColumn();
  const appNoPrefix = isUrgent ? 'URGENT' : 'NDRF';

  return withTransaction(async (client) => {
    await assertNoDuplicate(client, { siteCode, sku: fields.sku, submissionType, date: applicationDate });
    const applicationNo = await nextApplicationNo(appNoPrefix);
    const values = [
      applicationNo,
      input.source,
      submissionType,
      siteCode,
      requestedByEmail,
      applicationDate,
      ...toBusinessParams(fields),
      qty,
      isUrgent ? (normalizeText(input.urgentReason) || null) : null,
      isUrgent ? (normalizeText(input.urgentReasonOther) || null) : null,
      input.ip,
      input.ip ? ipExpiryIso() : null,
    ];
    const result = await client.query<SubmissionRow>(
      `INSERT INTO submissions (
         application_no, source, submission_type, site_code, requested_by_email, application_date,
         brand, sku, rp_type, safety_stock, nd_code, remark,
         qty, urgent_reason, urgent_reason_other, created_ip, created_ip_expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      values,
    );
    const row = result.rows[0]!;

    const snapshot = isUrgent
      ? {
          site_code: siteCode,
          sku: normalizeText(fields.sku),
          qty,
          urgent_reason: normalizeText(input.urgentReason) || null,
          urgent_reason_other: normalizeText(input.urgentReasonOther) || null,
        }
      : fields;

    await client.query(
      `INSERT INTO submission_versions
         (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
       VALUES ($1, 1, NULL, $2, $3, $4, $5, $6)`,
      [
        row.id,
        JSON.stringify(snapshot),
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

export class NotSupportedError extends Error {
  constructor(message = '此申報不支援此操作') {
    super(message);
    this.name = 'NotSupportedError';
  }
}

export class DuplicateSubmissionError extends Error {
  constructor() {
    super('同日已申報相同 SKU，請使用「查詢／修改」更正現有申報，或明日再申報');
    this.name = 'DuplicateSubmissionError';
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
    if (row.submission_type !== 'normal') {
      throw new NotSupportedError('此申報不支援網頁查詢／修改');
    }
    if (row.locked_at || row.exported_at) {
      throw new LockedError(row.locked_at ? new Date(row.locked_at) : null);
    }

    await assertNoDuplicate(client, {
      siteCode,
      sku: fields.sku,
      submissionType: row.submission_type,
      date: row.application_date,
      excludeId: row.id,
    });

    const before = businessFieldsFromRow(row);
    const updated = await client.query<SubmissionRow>(
      `UPDATE submissions SET
         brand = $1, sku = $2, rp_type = $3, safety_stock = $4,
         nd_code = $5, remark = $6, updated_at = now()
       WHERE id = $7
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
         brand = $1, sku = $2, rp_type = $3, safety_stock = $4,
         nd_code = $5, remark = $6, updated_at = now()
       WHERE id = $7
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

export async function adminUpdateUrgentSubmission(input: {
  id: string;
  sku: string;
  qty: number;
  urgentReason: string | null;
  urgentReasonOther: string | null;
  ip: string;
  username: string;
}): Promise<SubmissionRow> {
  if (!Number.isInteger(input.qty) || input.qty < URGENT_QTY_MIN || input.qty > URGENT_QTY_MAX) {
    throw new Error(`QTY 必須為 ${URGENT_QTY_MIN} 至 ${URGENT_QTY_MAX} 的整數`);
  }
  const reasonErrors = validateUrgentReason(input.urgentReason, input.urgentReasonOther);
  if (reasonErrors.length) {
    throw new Error(reasonErrors[0]!.message);
  }
  const urgentReason = normalizeText(input.urgentReason) || null;
  const urgentReasonOther = normalizeText(input.urgentReasonOther) || null;
  return withTransaction(async (client) => {
    const rowResult = await client.query<SubmissionRow>(
      'SELECT * FROM submissions WHERE id = $1',
      [input.id],
    );
    const row = rowResult.rows[0];
    if (!row) throw new Error('找不到申報');
    if (row.submission_type !== 'urgent') throw new Error('此申報不是 Urgent Order');

    const before = urgentFieldsFromRow(row);
    const updated = await client.query<SubmissionRow>(
      `UPDATE submissions SET
         sku = $1, qty = $2, urgent_reason = $3, urgent_reason_other = $4, updated_at = now()
       WHERE id = $5
       RETURNING *`,
      [normalizeText(input.sku), input.qty, urgentReason, urgentReasonOther, row.id],
    );
    const newRow = updated.rows[0]!;

    const versionResult = await client.query<{ max: number | null }>(
      'SELECT max(version) AS max FROM submission_versions WHERE submission_id = $1',
      [row.id],
    );
    const nextVersion = (versionResult.rows[0]?.max ?? 0) + 1;
    const after = urgentFieldsFromRow(newRow);

    await client.query(
      `INSERT INTO submission_versions
         (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.id, nextVersion, JSON.stringify(before), JSON.stringify(after), 'admin', input.username, input.ip, 'admin_edit'],
    );

    return newRow;
  });
}

export function toHKDateStringSafe(value: string | null): string {
  return value ? toHKDateString(value) : '';
}
