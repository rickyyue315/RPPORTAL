import { query, withTransaction } from '../db/pool.js';
import { generateApplicationNo } from '../lib/applicationNo.js';
import { ipExpiryIso } from '../lib/ip.js';
import {
  normalizeText,
  type SubmissionBusinessFields,
  URGENT_QTY_MIN,
  URGENT_QTY_MAX,
  URGENT_WEB_MAX_ITEMS,
  resolveReturnReasonCode,
  resolveUrgentReasonCode,
} from '../lib/fields.js';
import { validateReturnFields, validateUrgentReason } from '../lib/validation.js';
import { toHKDateString, hkTodayForDateColumn } from '../lib/time.js';
import { getActiveReturnWindow, isReturnModificationOpen } from '../lib/returnSchedule.js';
import { normalizeSiteCode } from './stores.js';

interface IdempotencyQueryClient {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

export type SubmissionType = 'normal' | 'urgent' | 'sales' | 'return';

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
  return_qty: number | null;
  return_reason: string | null;
  return_confirmer_name: string | null;
  return_confirmer_phone: string | null;
  return_window_key: string | null;
  status: string;
  exported_at: string | null;
  export_batch_id: string | null;
  locked_at: string | null;
  created_ip: string | null;
  created_ip_expires_at: string | null;
  created_at: string;
  updated_at: string;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
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
  returnQty?: number | null;
  returnReason?: string | null;
  returnConfirmerName?: string | null;
  returnConfirmerPhone?: string | null;
  returnWindowKey?: string | null;
  ip: string;
  changeSource: string;
  actor?: string;
  applicationDateOverride?: string;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
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

export function salesFieldsFromRow(row: SubmissionRow): { site_code: string; sku: string } {
  return {
    site_code: row.site_code,
    sku: normalizeText(row.sku),
  };
}

export function returnFieldsFromRow(row: SubmissionRow): {
  site_code: string;
  sku: string;
  return_qty: number | null;
  return_reason: string | null;
  return_confirmer_name: string | null;
  return_confirmer_phone: string | null;
  return_window_key: string | null;
} {
  return {
    site_code: row.site_code,
    sku: normalizeText(row.sku),
    return_qty: row.return_qty,
    return_reason: normalizeText(row.return_reason) || null,
    return_confirmer_name: normalizeText(row.return_confirmer_name) || null,
    return_confirmer_phone: normalizeText(row.return_confirmer_phone) || null,
    return_window_key: normalizeText(row.return_window_key) || null,
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

async function nextApplicationNo(client: DuplicateCheckClient, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const no = generateApplicationNo(prefix);
    const existing = await client.query('SELECT 1 FROM submissions WHERE application_no = $1', [no]);
    if (existing.rows.length === 0) return no;
  }
  throw new Error('無法產生唯一申請編號');
}

export interface DuplicateCheckClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface DuplicateSubmissionKey {
  siteCode: string;
  sku: string;
  submissionType: SubmissionType;
  date: string;
}

export class ReturnWindowClosedError extends Error {
  constructor(message = '目前不在店舖申請退行貨日期內，暫停申請或修改') {
    super(message);
    this.name = 'ReturnWindowClosedError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('此提交重試鍵已用於不同資料，請重新整理頁面後再提交');
    this.name = 'IdempotencyConflictError';
  }
}

export class ReturnSubmissionConflictError extends Error {
  constructor() {
    super('同一店舖及 SKU 在此退行貨申請期已申請，請使用「查詢／修改」更正原申請');
    this.name = 'ReturnSubmissionConflictError';
  }
}

async function getIdempotentRow(
  client: IdempotencyQueryClient,
  input: CreateSubmissionInput,
  submissionType: SubmissionType,
): Promise<SubmissionRow | null> {
  if (!input.idempotencyKey) return null;
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 1)::bigint)',
    [`submission:${input.idempotencyKey}`],
  );
  const existing = await client.query<SubmissionRow>(
    'SELECT * FROM submissions WHERE idempotency_key = $1 FOR UPDATE',
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (
    row.idempotency_fingerprint !== input.idempotencyFingerprint
    || row.submission_type !== submissionType
    || row.site_code !== normalizeSiteCode(input.siteCode)
  ) {
    throw new IdempotencyConflictError();
  }
  return row;
}

export async function getSubmissionByIdempotencyKey(key: string): Promise<SubmissionRow | null> {
  const result = await query<SubmissionRow>('SELECT * FROM submissions WHERE idempotency_key = $1', [key]);
  return result.rows[0] ?? null;
}
function duplicateKeyValue(key: DuplicateSubmissionKey): string {
  return [
    normalizeSiteCode(key.siteCode),
    normalizeText(key.sku),
    key.submissionType,
    key.date,
  ].join('|');
}

/** Serializes public duplicate checks for the lifetime of the current DB transaction. */
export async function lockDuplicateSubmissionKeys(
  client: DuplicateCheckClient,
  keys: DuplicateSubmissionKey[],
): Promise<void> {
  const uniqueKeys = [...new Set(keys.map(duplicateKeyValue))].sort();
  for (const key of uniqueKeys) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0)::bigint)',
      [key],
    );
  }
}

/**
 * Enforces the "one submission per Site Code + SKU + day" rule.
 * The same SKU + Site Code may only be submitted once per application_date
 * (HK date) within the same submission type. Re-application is allowed from
 * the next day because application_date changes.
 */
export async function assertNoDuplicate(
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

export async function assertNoDuplicateReturn(
  client: DuplicateCheckClient,
  params: { siteCode: string; sku: string; windowKey: string; excludeId?: string },
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM submissions
     WHERE site_code = $1 AND sku = $2 AND submission_type = 'return'
       AND return_window_key = $3
       AND ($4::uuid IS NULL OR id <> $4)
     LIMIT 1`,
    [params.siteCode, normalizeText(params.sku), params.windowKey, params.excludeId ?? null],
  );
  if (result.rows.length > 0) throw new ReturnSubmissionConflictError();
}

async function createReturnSubmission(input: CreateSubmissionInput): Promise<SubmissionRow> {
  const siteCode = normalizeSiteCode(input.siteCode);
  const applicationDate = input.applicationDateOverride ?? hkTodayForDateColumn();
  const activeWindow = getActiveReturnWindow(applicationDate);
  if (!activeWindow) throw new ReturnWindowClosedError('目前不在店舖申請退行貨日期內，暫停申請');
  if (input.returnWindowKey && input.returnWindowKey !== activeWindow.key) {
    throw new ReturnWindowClosedError('退行貨申請期已變更，請重新載入頁面後再提交');
  }

  const returnFields = {
    sku: normalizeText(input.fields.sku),
    qty: input.returnQty ?? NaN,
    reason: normalizeText(input.returnReason),
    confirmerName: normalizeText(input.returnConfirmerName),
    confirmerPhone: normalizeText(input.returnConfirmerPhone),
  };
  const fieldErrors = validateReturnFields(returnFields);
  if (fieldErrors.length) throw new Error(fieldErrors[0]!.message);
  const reason = resolveReturnReasonCode(returnFields.reason);

  return withTransaction(async (client) => {
    const replay = await getIdempotentRow(client, input, 'return');
    if (replay) return replay;

    await lockDuplicateSubmissionKeys(client, [{
      siteCode,
      sku: returnFields.sku,
      submissionType: 'return',
      date: activeWindow.key,
    }]);
    await assertNoDuplicateReturn(client, {
      siteCode,
      sku: returnFields.sku,
      windowKey: activeWindow.key,
    });
    const applicationNo = await nextApplicationNo(client, 'RETURN');
    const requestedByEmail = `${siteCode.toLowerCase()}@sasa.com`;
    const result = await client.query<SubmissionRow>(
      `INSERT INTO submissions (
         application_no, source, submission_type, site_code, requested_by_email, application_date,
         brand, sku, qty, urgent_reason, urgent_reason_other,
         return_qty, return_reason, return_confirmer_name, return_confirmer_phone, return_window_key,
          created_ip, created_ip_expires_at, idempotency_key, idempotency_fingerprint
        )
       VALUES ($1, $2, 'return', $3, $4, $5, '', $6, NULL, NULL, NULL, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        applicationNo,
        input.source,
        siteCode,
        requestedByEmail,
        applicationDate,
        returnFields.sku,
        returnFields.qty,
        reason,
        returnFields.confirmerName,
        returnFields.confirmerPhone,
        activeWindow.key,
        input.ip,
        input.ip ? ipExpiryIso() : null,
         input.idempotencyKey ?? null,
         input.idempotencyFingerprint ?? null,
       ],
    );
    const row = result.rows[0]!;
    await client.query(
      `INSERT INTO submission_versions
         (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
       VALUES ($1, 1, NULL, $2, 'applicant', $3, $4, $5)`,
      [
        row.id,
        JSON.stringify(returnFieldsFromRow(row)),
        input.actor ?? null,
        input.ip,
        input.changeSource,
      ],
    );
    return row;
  });
}

export async function createSubmission(
  input: CreateSubmissionInput,
): Promise<SubmissionRow> {
  if ((input.submissionType ?? 'normal') === 'return') {
    return createReturnSubmission(input);
  }
  const siteCode = normalizeSiteCode(input.siteCode);
  const fields = input.fields;
  const submissionType: SubmissionType = input.submissionType ?? 'normal';
  const isUrgent = submissionType === 'urgent';
  const qty = isUrgent ? (input.qty ?? null) : null;
  const urgentReason = isUrgent && normalizeText(input.urgentReason)
    ? resolveUrgentReasonCode(input.urgentReason)
    : null;
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
  const appNoPrefix = isUrgent ? 'URGENT' : submissionType === 'sales' ? 'SALES' : 'NDRF';

  return withTransaction(async (client) => {
    const replay = await getIdempotentRow(client, input, submissionType);
    if (replay) return replay;

    await lockDuplicateSubmissionKeys(client, [{
      siteCode,
      sku: fields.sku,
      submissionType,
      date: applicationDate,
    }]);
    await assertNoDuplicate(client, { siteCode, sku: fields.sku, submissionType, date: applicationDate });
    const applicationNo = await nextApplicationNo(client, appNoPrefix);
    const values = [
      applicationNo,
      input.source,
      submissionType,
      siteCode,
      requestedByEmail,
      applicationDate,
      ...toBusinessParams(fields),
      qty,
      urgentReason,
      isUrgent ? (normalizeText(input.urgentReasonOther) || null) : null,
      input.ip,
      input.ip ? ipExpiryIso() : null,
       input.idempotencyKey ?? null,
       input.idempotencyFingerprint ?? null,
     ];
    const result = await client.query<SubmissionRow>(
      `INSERT INTO submissions (
         application_no, source, submission_type, site_code, requested_by_email, application_date,
         brand, sku, rp_type, safety_stock, nd_code, remark,
         qty, urgent_reason, urgent_reason_other, created_ip, created_ip_expires_at,
          idempotency_key, idempotency_fingerprint
        )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      values,
    );
    const row = result.rows[0]!;

     const snapshot = isUrgent
       ? {
           site_code: siteCode,
           sku: normalizeText(fields.sku),
           qty,
           urgent_reason: urgentReason,
           urgent_reason_other: normalizeText(input.urgentReasonOther) || null,
         }
       : submissionType === 'sales'
         ? { site_code: siteCode, sku: normalizeText(fields.sku) }
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

export class UrgentBatchDuplicateError extends Error {
  constructor(public errors: Array<{ item: number; sku: string }>) {
    super('批內有 SKU 重複或同日已申報，整批未提交');
    this.name = 'UrgentBatchDuplicateError';
  }
}

export interface UrgentBatchItemInput {
  sku: string;
  qty: number;
  urgentReason: string | null | undefined;
  urgentReasonOther: string | null | undefined;
}

export interface CreateUrgentBatchInput {
  siteCode: string;
  items: UrgentBatchItemInput[];
  ip: string;
  changeSource: string;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
}

export interface UrgentBatchResultRow {
  item: number;
  row: SubmissionRow;
}

export interface UrgentBatchResult {
  rows: UrgentBatchResultRow[];
  replayed: boolean;
}

/** Derives the deterministic per-row idempotency keys for a web batch submission. */
export function deriveUrgentBatchIdempotencyKeys(idempotencyKey: string, itemCount: number): string[] {
  return Array.from({ length: itemCount }, (_, index) => `${idempotencyKey}:${index + 1}`);
}

/**
 * Creates several Urgent Order submissions inside one transaction. The whole
 * batch is all-or-nothing: any validation, duplicate or idempotency conflict
 * rolls back everything. Each row keeps an independent application number and
 * stores the shared batch idempotency fingerprint.
 */
export async function createUrgentBatch(
  input: CreateUrgentBatchInput,
): Promise<UrgentBatchResult> {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > URGENT_WEB_MAX_ITEMS) {
    throw new Error(`每個批次必須填寫 1 至 ${URGENT_WEB_MAX_ITEMS} 個 SKU`);
  }
  const siteCode = normalizeSiteCode(input.siteCode);
  const applicationDate = hkTodayForDateColumn();
  const items = input.items.map((item) => ({
    sku: normalizeText(item.sku),
    qty: item.qty,
    urgentReason: normalizeText(item.urgentReason),
    urgentReasonOther: normalizeText(item.urgentReasonOther) || null,
  }));

  // Defense in depth: mirror the route-level item validation before opening a transaction.
  for (const item of items) {
    if (!(Number.isInteger(item.qty) && item.qty >= URGENT_QTY_MIN && item.qty <= URGENT_QTY_MAX)) {
      throw new Error(`QTY 必須為 ${URGENT_QTY_MIN} 至 ${URGENT_QTY_MAX} 的整數`);
    }
    const reasonErrors = validateUrgentReason(item.urgentReason, item.urgentReasonOther);
    if (reasonErrors.length) throw new Error(reasonErrors[0]!.message);
  }

  const requestedByEmail = `${siteCode.toLowerCase()}@sasa.com`;
  const derivedKeys = input.idempotencyKey
    ? deriveUrgentBatchIdempotencyKeys(input.idempotencyKey, items.length)
    : null;

  return withTransaction(async (client) => {
    if (input.idempotencyKey && derivedKeys) {
      for (const key of derivedKeys) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 1)::bigint)',
          [`submission:${key}`],
        );
      }
      const existing = await client.query<SubmissionRow>(
        'SELECT * FROM submissions WHERE idempotency_key = ANY($1::text[]) FOR UPDATE',
        [derivedKeys],
      );
      if (existing.rows.length > 0) {
        if (existing.rows.length !== derivedKeys.length) throw new IdempotencyConflictError();
        const byKey = new Map(existing.rows.map((row) => [row.idempotency_key, row]));
        for (const key of derivedKeys) {
          const row = byKey.get(key);
          if (
            !row
            || row.idempotency_fingerprint !== input.idempotencyFingerprint
            || row.submission_type !== 'urgent'
            || row.site_code !== siteCode
          ) {
            throw new IdempotencyConflictError();
          }
        }
        const ordered = derivedKeys.map((key) => byKey.get(key)!);
        return { rows: ordered.map((row, index) => ({ item: index + 1, row })), replayed: true };
      }
    }

    await lockDuplicateSubmissionKeys(client, items.map((item) => ({
      siteCode,
      sku: item.sku,
      submissionType: 'urgent' as const,
      date: applicationDate,
    })));

    const seen = new Set<string>();
    const duplicateErrors: Array<{ item: number; sku: string }> = [];
    for (const [index, item] of items.entries()) {
      const key = `${siteCode}|${item.sku}`;
      if (seen.has(key)) duplicateErrors.push({ item: index + 1, sku: item.sku });
      seen.add(key);
    }
    const existingDuplicates = await client.query<{ sku: string }>(
      `SELECT sku FROM submissions
       WHERE site_code = $1 AND submission_type = 'urgent' AND application_date = $2::date
         AND sku = ANY($3::text[])`,
      [siteCode, applicationDate, items.map((item) => item.sku)],
    );
    const existingSkuSet = new Set(existingDuplicates.rows.map((row) => row.sku));
    for (const [index, item] of items.entries()) {
      if (existingSkuSet.has(item.sku)) duplicateErrors.push({ item: index + 1, sku: item.sku });
    }
    if (duplicateErrors.length) throw new UrgentBatchDuplicateError(duplicateErrors);

    const rows: UrgentBatchResultRow[] = [];
    for (const [index, item] of items.entries()) {
      const urgentReason = item.urgentReason ? resolveUrgentReasonCode(item.urgentReason) : null;
      const applicationNo = await nextApplicationNo(client, 'URGENT');
      const idempotencyKey = derivedKeys ? derivedKeys[index] : null;
      const insert = await client.query<SubmissionRow>(
        `INSERT INTO submissions (
           application_no, source, submission_type, site_code, requested_by_email, application_date,
           brand, sku, qty, urgent_reason, urgent_reason_other, created_ip, created_ip_expires_at,
           idempotency_key, idempotency_fingerprint
         )
         VALUES ($1, 'web', 'urgent', $2, $3, $4, '', $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          applicationNo,
          siteCode,
          requestedByEmail,
          applicationDate,
          item.sku,
          item.qty,
          urgentReason,
          item.urgentReasonOther,
          input.ip,
          input.ip ? ipExpiryIso() : null,
          idempotencyKey ?? null,
          input.idempotencyKey ? input.idempotencyFingerprint ?? null : null,
        ],
      );
      const row = insert.rows[0]!;
      await client.query(
        `INSERT INTO submission_versions
           (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
         VALUES ($1, 1, NULL, $2, 'applicant', NULL, $3, $4)`,
        [
          row.id,
          JSON.stringify({
            site_code: siteCode,
            sku: item.sku,
            qty: item.qty,
            urgent_reason: urgentReason,
            urgent_reason_other: item.urgentReasonOther,
          }),
          input.ip,
          input.changeSource,
        ],
      );
      rows.push({ item: index + 1, row });
    }

    return { rows, replayed: false };
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
      'SELECT * FROM submissions WHERE application_no = $1 AND site_code = $2 FOR UPDATE',
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

    await lockDuplicateSubmissionKeys(client, [{
      siteCode,
      sku: fields.sku,
      submissionType: row.submission_type,
      date: row.application_date,
    }]);
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

export interface ModifySalesSubmissionInput {
  applicationNo: string;
  siteCode: string;
  sku: string;
  ip: string;
  changeSource: string;
}

export interface ModifyReturnSubmissionInput {
  applicationNo: string;
  siteCode: string;
  sku: string;
  qty: number;
  reason: string;
  confirmerName: string;
  confirmerPhone: string;
  ip: string;
  changeSource: string;
}

export async function modifyReturnSubmission(input: ModifyReturnSubmissionInput): Promise<SubmissionRow> {
  const siteCode = normalizeSiteCode(input.siteCode);
  const fieldErrors = validateReturnFields({
    sku: input.sku,
    qty: input.qty,
    reason: input.reason,
    confirmerName: input.confirmerName,
    confirmerPhone: input.confirmerPhone,
  });
  if (fieldErrors.length) throw new Error(fieldErrors[0]!.message);
  const reason = resolveReturnReasonCode(input.reason);

  return withTransaction(async (client) => {
    const rowResult = await client.query<SubmissionRow>(
      'SELECT * FROM submissions WHERE application_no = $1 AND site_code = $2 FOR UPDATE',
      [input.applicationNo.trim().toUpperCase(), siteCode],
    );
    const row = rowResult.rows[0];
    if (!row) throw new Error('找不到申報');
    if (row.submission_type !== 'return') throw new NotSupportedError('此申報不是行貨退貨報數');
    if (row.locked_at || row.exported_at) {
      throw new LockedError(row.locked_at ? new Date(row.locked_at) : null);
    }
    if (!isReturnModificationOpen(row.return_window_key, hkTodayForDateColumn())) {
      throw new ReturnWindowClosedError();
    }
    await lockDuplicateSubmissionKeys(client, [{
      siteCode,
      sku: input.sku,
      submissionType: 'return',
      date: row.return_window_key ?? '',
    }]);
    await assertNoDuplicateReturn(client, {
      siteCode,
      sku: input.sku,
      windowKey: row.return_window_key ?? '',
      excludeId: row.id,
    });

    const before = returnFieldsFromRow(row);
    const updated = await client.query<SubmissionRow>(
      `UPDATE submissions SET
         sku = $1, return_qty = $2, return_reason = $3,
         return_confirmer_name = $4, return_confirmer_phone = $5, updated_at = now()
       WHERE id = $6
       RETURNING *`,
      [normalizeText(input.sku), input.qty, reason, normalizeText(input.confirmerName), normalizeText(input.confirmerPhone), row.id],
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
       VALUES ($1, $2, $3, $4, 'applicant', NULL, $5, $6)`,
      [row.id, nextVersion, JSON.stringify(before), JSON.stringify(returnFieldsFromRow(newRow)), input.ip, input.changeSource],
    );
    return newRow;
  });
}

export async function modifySalesSubmission(input: ModifySalesSubmissionInput): Promise<SubmissionRow> {
  const siteCode = normalizeSiteCode(input.siteCode);
  return withTransaction(async (client) => {
    const rowResult = await client.query<SubmissionRow>(
      'SELECT * FROM submissions WHERE application_no = $1 AND site_code = $2 FOR UPDATE',
      [input.applicationNo.trim().toUpperCase(), siteCode],
    );
    const row = rowResult.rows[0];
    if (!row) throw new Error('找不到申報');
    if (row.submission_type !== 'sales') throw new NotSupportedError('此申報不是突發性銷售申報');
    if (row.locked_at || row.exported_at) {
      throw new LockedError(row.locked_at ? new Date(row.locked_at) : null);
    }

    await lockDuplicateSubmissionKeys(client, [{
      siteCode,
      sku: input.sku,
      submissionType: row.submission_type,
      date: row.application_date,
    }]);
    await assertNoDuplicate(client, {
      siteCode,
      sku: input.sku,
      submissionType: row.submission_type,
      date: row.application_date,
      excludeId: row.id,
    });

    const before = salesFieldsFromRow(row);
    const updated = await client.query<SubmissionRow>(
      `UPDATE submissions SET sku = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [normalizeText(input.sku), row.id],
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
       VALUES ($1, $2, $3, $4, 'applicant', NULL, $5, $6)`,
      [row.id, nextVersion, JSON.stringify(before), JSON.stringify(salesFieldsFromRow(newRow)), input.ip, input.changeSource],
    );
    return newRow;
  });
}

export interface ModifyUrgentSubmissionInput {
  applicationNo: string;
  siteCode: string;
  sku: string;
  qty: number;
  urgentReason: string | null;
  urgentReasonOther: string | null;
  ip: string;
  changeSource: string;
}

export async function modifyUrgentSubmission(
  input: ModifyUrgentSubmissionInput,
): Promise<SubmissionRow> {
  const siteCode = normalizeSiteCode(input.siteCode);
  if (!(Number.isInteger(input.qty) && input.qty >= URGENT_QTY_MIN && input.qty <= URGENT_QTY_MAX)) {
    throw new Error(`QTY 必須為 ${URGENT_QTY_MIN} 至 ${URGENT_QTY_MAX} 的整數`);
  }
  const reasonErrors = validateUrgentReason(input.urgentReason, input.urgentReasonOther);
  if (reasonErrors.length) {
    throw new Error(reasonErrors[0]!.message);
  }
  const urgentReason = normalizeText(input.urgentReason) ? resolveUrgentReasonCode(input.urgentReason) : null;
  const urgentReasonOther = normalizeText(input.urgentReasonOther) || null;
  return withTransaction(async (client) => {
    const rowResult = await client.query<SubmissionRow>(
      'SELECT * FROM submissions WHERE application_no = $1 AND site_code = $2 FOR UPDATE',
      [input.applicationNo.trim().toUpperCase(), siteCode],
    );
    const row = rowResult.rows[0];
    if (!row) {
      throw new Error('找不到申報');
    }
    if (row.submission_type !== 'urgent') {
      throw new NotSupportedError('此申報不是 Urgent Order');
    }
    if (row.locked_at || row.exported_at) {
      throw new LockedError(row.locked_at ? new Date(row.locked_at) : null);
    }

    await lockDuplicateSubmissionKeys(client, [{
      siteCode,
      sku: input.sku,
      submissionType: row.submission_type,
      date: row.application_date,
    }]);
    await assertNoDuplicate(client, {
      siteCode,
      sku: input.sku,
      submissionType: row.submission_type,
      date: row.application_date,
      excludeId: row.id,
    });

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
      [row.id, nextVersion, JSON.stringify(before), JSON.stringify(after), 'applicant', null, input.ip, input.changeSource],
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
      'SELECT * FROM submissions WHERE id = $1 FOR UPDATE',
      [id],
    );
    const row = rowResult.rows[0];
    if (!row) throw new Error('找不到申報');
    if (row.locked_at || row.exported_at) {
      throw new LockedError(row.locked_at ? new Date(row.locked_at) : null);
    }

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
  const urgentReason = normalizeText(input.urgentReason) ? resolveUrgentReasonCode(input.urgentReason) : null;
  const urgentReasonOther = normalizeText(input.urgentReasonOther) || null;
  return withTransaction(async (client) => {
    const rowResult = await client.query<SubmissionRow>(
      'SELECT * FROM submissions WHERE id = $1 FOR UPDATE',
      [input.id],
    );
    const row = rowResult.rows[0];
    if (!row) throw new Error('找不到申報');
    if (row.submission_type !== 'urgent') throw new Error('此申報不是 Urgent Order');
    if (row.locked_at || row.exported_at) {
      throw new LockedError(row.locked_at ? new Date(row.locked_at) : null);
    }

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

export async function adminUpdateSalesSubmission(input: {
  id: string;
  sku: string;
  ip: string;
  username: string;
}): Promise<SubmissionRow> {
  return withTransaction(async (client) => {
    const rowResult = await client.query<SubmissionRow>('SELECT * FROM submissions WHERE id = $1 FOR UPDATE', [input.id]);
    const row = rowResult.rows[0];
    if (!row) throw new Error('找不到申報');
    if (row.submission_type !== 'sales') throw new Error('此申報不是突發性銷售申報');
    if (row.locked_at || row.exported_at) {
      throw new LockedError(row.locked_at ? new Date(row.locked_at) : null);
    }

    const before = salesFieldsFromRow(row);
    const updated = await client.query<SubmissionRow>(
      `UPDATE submissions SET sku = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [normalizeText(input.sku), row.id],
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
       VALUES ($1, $2, $3, $4, 'admin', $5, $6, 'admin_edit')`,
      [row.id, nextVersion, JSON.stringify(before), JSON.stringify(salesFieldsFromRow(newRow)), input.username, input.ip],
    );
    return newRow;
  });
}

export async function adminUpdateReturnSubmission(input: {
  id: string;
  sku: string;
  qty: number;
  reason: string;
  confirmerName: string;
  confirmerPhone: string;
  ip: string;
  username: string;
}): Promise<SubmissionRow> {
  const fieldErrors = validateReturnFields({
    sku: input.sku,
    qty: input.qty,
    reason: input.reason,
    confirmerName: input.confirmerName,
    confirmerPhone: input.confirmerPhone,
  });
  if (fieldErrors.length) throw new Error(fieldErrors[0]!.message);
  const reason = resolveReturnReasonCode(input.reason);
  return withTransaction(async (client) => {
    const rowResult = await client.query<SubmissionRow>('SELECT * FROM submissions WHERE id = $1 FOR UPDATE', [input.id]);
    const row = rowResult.rows[0];
    if (!row) throw new Error('找不到申報');
    if (row.submission_type !== 'return') throw new Error('此申報不是行貨退貨報數');
    if (row.locked_at || row.exported_at) {
      throw new LockedError(row.locked_at ? new Date(row.locked_at) : null);
    }
    await lockDuplicateSubmissionKeys(client, [{
      siteCode: row.site_code,
      sku: input.sku,
      submissionType: 'return',
      date: row.return_window_key ?? '',
    }]);
    await assertNoDuplicateReturn(client, {
      siteCode: row.site_code,
      sku: input.sku,
      windowKey: row.return_window_key ?? '',
      excludeId: row.id,
    });
    const before = returnFieldsFromRow(row);
    const updated = await client.query<SubmissionRow>(
      `UPDATE submissions SET
         sku = $1, return_qty = $2, return_reason = $3,
         return_confirmer_name = $4, return_confirmer_phone = $5, updated_at = now()
       WHERE id = $6
       RETURNING *`,
      [normalizeText(input.sku), input.qty, reason, normalizeText(input.confirmerName), normalizeText(input.confirmerPhone), row.id],
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
       VALUES ($1, $2, $3, $4, 'admin', $5, $6, 'admin_edit')`,
      [row.id, nextVersion, JSON.stringify(before), JSON.stringify(returnFieldsFromRow(newRow)), input.username, input.ip],
    );
    return newRow;
  });
}

export function toHKDateStringSafe(value: string | null): string {
  return value ? toHKDateString(value) : '';
}
