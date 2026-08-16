import type pg from 'pg';
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { generateApplicationNo } from '../lib/applicationNo.js';
import { ipExpiryIso } from '../lib/ip.js';
import { normalizeText, type SubmissionBusinessFields } from '../lib/fields.js';
import { validateBusinessFields, isValidSku, SKU_ERROR } from '../lib/validation.js';
import { hkTodayForDateColumn } from '../lib/time.js';
import { normalizeSiteCode } from './stores.js';
import type { SubmissionRow } from './submissions.js';

export const NDRF_ROUTES = ['buyer', 'sct', 'rp', 'legacy'] as const;
export const WORKFLOW_STATUSES = ['legacy', 'pending', 'ready_for_rp', 'accepted', 'rejected'] as const;
export type NdrfRoute = (typeof NDRF_ROUTES)[number];
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type ReviewActorRole = 'store' | 'buyer' | 'sct' | 'admin';

type Queryable = Pick<pg.PoolClient, 'query'>;

export interface StoreRouteConfig {
  site_code: string;
  sct_review_required: boolean;
  remark_required: boolean;
}

export const NDRF_ACTIVE_STATUSES: readonly WorkflowStatus[] = ['pending', 'ready_for_rp', 'accepted'];

export class WorkflowConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowConfigurationError';
  }
}

export class SubmissionNotFoundError extends Error {
  constructor() {
    super('找不到申報');
    this.name = 'SubmissionNotFoundError';
  }
}

/** Carries the offending form field so routes can report it to the client. */
export class FieldValidationError extends Error {
  constructor(
    message: string,
    readonly field: string | undefined,
  ) {
    super(message);
    this.name = 'FieldValidationError';
  }
}

export class ActiveSubmissionConflictError extends Error {
  constructor() {
    super('此 Site Code + SKU + RP Type 已有未匯出的有效申請，不可重複提交');
    this.name = 'ActiveSubmissionConflictError';
  }
}

export class CooldownActiveError extends Error {
  constructor(hours: number) {
    super(`此 Site Code + SKU + RP Type 曾被拒絕，須等待 ${hours} 小時後方可重新申請`);
    this.name = 'CooldownActiveError';
  }
}

export class WorkflowLockedError extends Error {
  constructor() {
    super('此申報已匯出並鎖定，不能修改或審批');
    this.name = 'WorkflowLockedError';
  }
}

export class ReviewDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewDecisionError';
  }
}

export class WorkflowPermissionError extends Error {
  constructor(message = '沒有權限處理此申請') {
    super(message);
    this.name = 'WorkflowPermissionError';
  }
}

export interface WorkflowRow extends SubmissionRow {
  ndrf_route: NdrfRoute | null;
  workflow_status: WorkflowStatus | null;
  active_workflow: boolean;
  rejected_at: string | null;
  review_round: number;
  round_started_at: string | null;
  current_review_remark: string | null;
  created_by_portal_user_id: string | null;
  shop_snapshot: string | null;
}

export interface ReviewEventRow {
  id: string;
  submission_id: string;
  review_round: number;
  event_type: 'remark' | 'accept' | 'reject' | 'override' | 'reopen';
  actor_role: ReviewActorRole;
  actor_user_id: string | null;
  actor: string;
  remark: string | null;
  reject_reason_code: string | null;
  reject_reason_label: string | null;
  reject_reason_note: string | null;
  reason: string | null;
  ip: string | null;
  created_at: string;
}

export async function getStoreRouteConfig(siteCode: string): Promise<StoreRouteConfig> {
  const result = await query<StoreRouteConfig>(
    'SELECT site_code, sct_review_required, remark_required FROM ndrf_store_routes WHERE site_code = $1',
    [normalizeSiteCode(siteCode)],
  );
  return result.rows[0] ?? {
    site_code: normalizeSiteCode(siteCode),
    sct_review_required: false,
    remark_required: false,
  };
}

export async function listStoreRouteConfigs(): Promise<StoreRouteConfig[]> {
  const result = await query<StoreRouteConfig>(
    'SELECT site_code, sct_review_required, remark_required FROM ndrf_store_routes ORDER BY site_code',
  );
  return result.rows;
}

export async function hasActiveSct(): Promise<boolean> {
  const result = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM portal_users WHERE role = 'sct' AND active`,
  );
  return Number(result.rows[0]?.cnt ?? 0) > 0;
}

export async function getBuyerForSku(sku: string): Promise<{ buyer_user_id: string; buyer_active: boolean } | null> {
  const result = await query<{ buyer_user_id: string; buyer_active: boolean }>(
    `SELECT m.buyer_user_id, u.active AS buyer_active
       FROM sku_master m
       JOIN portal_users u ON u.id = m.buyer_user_id
      WHERE m.sku = $1
      LIMIT 1`,
    [sku],
  );
  return result.rows[0] ?? null;
}

export function validateNormalBusinessFields(
  fields: SubmissionBusinessFields,
  siteCode: string,
  remarkRequired: boolean,
) {
  const sku = normalizeText(fields.sku);
  if (!isValidSku(sku)) {
    return [{ field: 'sku', message: SKU_ERROR }];
  }
  return validateBusinessFields(fields, siteCode, { remarkRequired });
}

/**
 * Resolves route + initial status for a general NDRF submission.
 * - Normal store RF: rp / ready_for_rp.
 * - Designated shop RF: sct / pending (requires an active SCT account).
 * - ND: buyer / pending (requires a current SKU Master mapping to an active Buyer).
 */
export async function resolveWorkflowRoute(
  client: Queryable,
  fields: SubmissionBusinessFields,
  siteCode: string,
): Promise<{ route: NdrfRoute; status: WorkflowStatus; remarkRequired: boolean; sctReviewRequired: boolean }> {
  const site = normalizeSiteCode(siteCode);
  const rpType = normalizeText(fields.rp_type);

  const routeResult = await client.query<StoreRouteConfig>(
    'SELECT site_code, sct_review_required, remark_required FROM ndrf_store_routes WHERE site_code = $1',
    [site],
  );
  const routeConfig = routeResult.rows[0] ?? {
    site_code: site,
    sct_review_required: false,
    remark_required: false,
  };

  if (rpType === 'RF') {
    if (routeConfig.sct_review_required) {
      const sctCount = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM portal_users WHERE role = 'sct' AND active`,
      );
      if (Number(sctCount.rows[0]?.cnt ?? 0) < 1) {
        throw new WorkflowConfigurationError('指定店的 RF 需要 SCT 審批，但系統目前沒有啟用中的 SCT 帳戶');
      }
      return {
        route: 'sct',
        status: 'pending',
        remarkRequired: routeConfig.remark_required,
        sctReviewRequired: true,
      };
    }
    return {
      route: 'rp',
      status: 'ready_for_rp',
      remarkRequired: routeConfig.remark_required,
      sctReviewRequired: false,
    };
  }

  // ND
  const buyer = await client.query<{ buyer_user_id: string; buyer_active: boolean }>(
    `SELECT m.buyer_user_id, u.active AS buyer_active
       FROM sku_master m
       JOIN portal_users u ON u.id = m.buyer_user_id
      WHERE m.sku = $1
      LIMIT 1`,
    [normalizeText(fields.sku)],
  );
  const mapping = buyer.rows[0];
  if (!mapping || !mapping.buyer_active) {
    throw new WorkflowConfigurationError(
      '此 SKU 尚未配置 Buyer 或所屬 Buyer 已停用，請先由 Admin 更新 SKU Master',
    );
  }
  return {
    route: 'buyer',
    status: 'pending',
    remarkRequired: routeConfig.remark_required,
    sctReviewRequired: false,
  };
}

function activeKey(siteCode: string, sku: string, rpType: string): string {
  return `ndrf:active:${normalizeSiteCode(siteCode)}|${normalizeText(sku)}|${rpType}`;
}

/** Serializes the active/cooldown check across concurrent submissions. */
export async function lockWorkflowSubmissionKey(
  client: Queryable,
  siteCode: string,
  sku: string,
  rpType: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0)::bigint)',
    [activeKey(siteCode, sku, rpType)],
  );
}

export async function assertNoActiveOrCooldown(
  client: Queryable,
  params: { siteCode: string; sku: string; rpType: string; excludeId?: string; checkCooldown?: boolean },
): Promise<void> {
  const { siteCode, sku, rpType, excludeId } = params;
  const checkCooldown = params.checkCooldown ?? true;
  const active = await client.query(
    `SELECT 1 FROM submissions
      WHERE site_code = $1 AND sku = $2 AND rp_type = $3 AND active_workflow
        AND exported_at IS NULL AND locked_at IS NULL
        AND ($4::uuid IS NULL OR id <> $4)
      LIMIT 1`,
    [siteCode, normalizeText(sku), rpType, excludeId ?? null],
  );
  if (active.rows.length > 0) throw new ActiveSubmissionConflictError();

  if (!checkCooldown) return;

  const cooldown = await client.query(
    `SELECT 1 FROM submissions
      WHERE site_code = $1 AND sku = $2 AND rp_type = $3
        AND workflow_status = 'rejected'
        AND rejected_at > now() - (interval '1 hour' * $4::int)
        AND ($5::uuid IS NULL OR id <> $5)
      LIMIT 1`,
    [siteCode, normalizeText(sku), rpType, config.ndrfRejectCooldownHours, excludeId ?? null],
  );
  if (cooldown.rows.length > 0) throw new CooldownActiveError(config.ndrfRejectCooldownHours);
}

export interface CreateNormalSubmissionInput {
  siteCode: string;
  source: 'web' | 'excel';
  fields: SubmissionBusinessFields;
  ip: string;
  changeSource: string;
  actorRole: ReviewActorRole;
  actor: string;
  actorUserId?: string | null;
  shopName?: string;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
}

export async function getSubmissionByIdempotencyKey(key: string): Promise<WorkflowRow | null> {
  const result = await query<WorkflowRow>('SELECT * FROM submissions WHERE idempotency_key = $1', [key]);
  return result.rows[0] ?? null;
}

/**
 * Inserts one general NDRF row inside an existing transaction. Used by the
 * Store web submit, Store Excel import and Admin import paths so every entry
 * point produces the same route/status/validation behaviour.
 */
export async function insertNormalWorkflowRow(
  client: Queryable,
  input: CreateNormalSubmissionInput,
): Promise<WorkflowRow> {
  const siteCode = normalizeSiteCode(input.siteCode);
  const rpType = normalizeText(input.fields.rp_type);

  // Validate field format before route resolution so an invalid SKU/RP Type is
  // reported as a field error instead of a configuration error.
  const configResult = await client.query<StoreRouteConfig>(
    'SELECT site_code, sct_review_required, remark_required FROM ndrf_store_routes WHERE site_code = $1',
    [siteCode],
  );
  const remarkRequired = configResult.rows[0]?.remark_required ?? false;
  const fieldErrors = validateNormalBusinessFields(input.fields, siteCode, remarkRequired);
  if (fieldErrors.length) {
    throw new FieldValidationError(fieldErrors[0]!.message, fieldErrors[0]!.field);
  }

  const route = await resolveWorkflowRoute(client, input.fields, siteCode);

  await lockWorkflowSubmissionKey(client, siteCode, input.fields.sku, rpType);
  await assertNoActiveOrCooldown(client, { siteCode, sku: input.fields.sku, rpType });

  const applicationNo = await nextApplicationNo(client, 'NDRF');
  const requestedByEmail = `${siteCode.toLowerCase()}@sasa.com`;
  const applicationDate = hkTodayForDateColumn();

  const result = await client.query<WorkflowRow>(
    `INSERT INTO submissions (
       application_no, source, submission_type, site_code, requested_by_email, application_date,
       brand, sku, rp_type, safety_stock, nd_code, remark,
       status, ndrf_route, workflow_status, active_workflow, review_round,
       created_by_portal_user_id, shop_snapshot,
       created_ip, created_ip_expires_at, idempotency_key, idempotency_fingerprint
     ) VALUES ($1, $2, 'normal', $3, $4, $5, $6, $7, $8, $9, $10, $11,
       'received', $12, $13, true, 1, $14, $15, $16, $17, $18, $19)
     RETURNING *`,
    [
      applicationNo,
      input.source,
      siteCode,
      requestedByEmail,
      applicationDate,
      normalizeText(input.fields.brand) || null,
      normalizeText(input.fields.sku),
      rpType,
      normalizeText(input.fields.safety_stock) || null,
      normalizeText(input.fields.nd_code) || null,
      normalizeText(input.fields.remark) || null,
      route.route,
      route.status,
      input.actorUserId ?? null,
      input.shopName ?? null,
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
     VALUES ($1, 1, NULL, $2, $3, $4, $5, $6)`,
    [
      row.id,
      JSON.stringify({
        site_code: siteCode,
        ...input.fields,
        ndrf_route: route.route,
        workflow_status: route.status,
      }),
      input.actorRole,
      input.actor,
      input.ip,
      input.changeSource,
    ],
  );

  return row;
}

async function nextApplicationNo(client: Queryable, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const no = generateApplicationNo(prefix);
    const existing = await client.query('SELECT 1 FROM submissions WHERE application_no = $1', [no]);
    if (existing.rows.length === 0) return no;
  }
  throw new Error('無法產生唯一申請編號');
}

export async function createNormalSubmission(input: CreateNormalSubmissionInput): Promise<WorkflowRow> {
  return withTransaction((client) => insertNormalWorkflowRow(client, input));
}

export async function createNormalSubmissionBatch(
  items: CreateNormalSubmissionInput[],
): Promise<WorkflowRow[]> {
  return withTransaction(async (client) => {
    const rows: WorkflowRow[] = [];
    for (const item of items) {
      rows.push(await insertNormalWorkflowRow(client, item));
    }
    return rows;
  });
}

export interface NormalSubmissionListItem {
  id: string;
  application_no: string;
  submission_type: string;
  site_code: string;
  shop_snapshot: string | null;
  application_date: string;
  submitted_at: string;
  source: string;
  sku: string;
  rp_type: string | null;
  safety_stock: string | null;
  nd_code: string | null;
  remark: string | null;
  status: string;
  ndrf_route: NdrfRoute | null;
  workflow_status: WorkflowStatus | null;
  locked: boolean;
  locked_at: string | null;
  exported_at: string | null;
  current_review_remark: string | null;
}

const LIST_COLUMNS = `
  SELECT id, application_no, submission_type, site_code, shop_snapshot, application_date, submitted_at, source,
         sku, rp_type, safety_stock, nd_code, remark, status,
         ndrf_route, workflow_status, exported_at, locked_at, current_review_remark
    FROM submissions`;

export async function listStoreNormalSubmissions(_storeUserId: string, siteCode: string): Promise<NormalSubmissionListItem[]> {
  const result = await query<NormalSubmissionListItem>(
    `${LIST_COLUMNS}
      WHERE submission_type = 'normal'
        AND site_code = $1
      ORDER BY submitted_at DESC`,
    [siteCode],
  );
  return result.rows.map((row) => ({ ...row, locked: Boolean(row.exported_at || row.locked_at) }));
}

export async function listReviewerQueue(
  userId: string,
  role: 'buyer' | 'sct',
): Promise<NormalSubmissionListItem[]> {
  const buyerScope = role === 'buyer'
    ? `AND sku IN (SELECT sku FROM sku_master WHERE buyer_user_id = $1)`
    : `AND ndrf_route = 'sct'`;
  const params: unknown[] = role === 'buyer' ? [userId] : [];
  const result = await query<NormalSubmissionListItem>(
    `${LIST_COLUMNS}
      WHERE submission_type = 'normal'
        AND workflow_status = 'pending'
        AND ndrf_route = ${role === 'buyer' ? "'buyer'" : "'sct'"}
        ${buyerScope}
      ORDER BY submitted_at ASC`,
    params,
  );
  return result.rows.map((row) => ({ ...row, locked: Boolean(row.exported_at || row.locked_at) }));
}

export async function listReviewerHistory(
  userId: string,
  role: 'buyer' | 'sct',
  options: { limit?: number; offset?: number } = {},
): Promise<NormalSubmissionListItem[]> {
  // Both values are coerced to integers and clamped before interpolation.
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 200)));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const buyerScope = role === 'buyer'
    ? `AND sku IN (SELECT sku FROM sku_master WHERE buyer_user_id = $1)`
    : `AND ndrf_route = 'sct'`;
  const result = await query<NormalSubmissionListItem>(
    `${LIST_COLUMNS}
      WHERE submission_type = 'normal'
        AND workflow_status IN ('ready_for_rp', 'accepted', 'rejected')
        AND ndrf_route = ${role === 'buyer' ? "'buyer'" : "'sct'"}
        ${buyerScope}
      ORDER BY submitted_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    role === 'buyer' ? [userId] : [],
  );
  return result.rows.map((row) => ({ ...row, locked: Boolean(row.exported_at || row.locked_at) }));
}

export async function getNormalSubmissionById(id: string): Promise<WorkflowRow | null> {
  const result = await query<WorkflowRow>('SELECT * FROM submissions WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function getReviewEvents(submissionId: string): Promise<ReviewEventRow[]> {
  const result = await query<ReviewEventRow>(
    `SELECT id, submission_id, review_round, event_type, actor_role, actor_user_id, actor,
            remark, reject_reason_code, reject_reason_label, reject_reason_note, reason, ip, created_at
       FROM ndrf_review_events
      WHERE submission_id = $1
      ORDER BY created_at ASC, id ASC`,
    [submissionId],
  );
  return result.rows;
}

/**
 * Verifies that the acting reviewer currently owns the submission according to
 * the live SKU Master (buyer) or the route snapshot (SCT).
 */
export async function assertReviewerScope(
  client: Queryable,
  user: { id: string; role: 'buyer' | 'sct' },
  row: WorkflowRow,
): Promise<void> {
  if (user.role === 'sct') {
    if (row.ndrf_route !== 'sct') {
      throw new WorkflowPermissionError('此申請不是指定店 SCT 審批的申請');
    }
    return;
  }
  if (row.ndrf_route !== 'buyer') {
    throw new WorkflowPermissionError('此申請不是 Buyer 審批的申請');
  }
  const mapping = await client.query<{ buyer_user_id: string }>(
    'SELECT buyer_user_id FROM sku_master WHERE sku = $1',
    [row.sku],
  );
  if (mapping.rows[0]?.buyer_user_id !== user.id) {
    throw new WorkflowPermissionError('此 SKU 現時不由你負責');
  }
}

async function loadReviewerRow(
  client: Queryable,
  user: { id: string; role: 'buyer' | 'sct' },
  submissionId: string,
): Promise<WorkflowRow> {
  const result = await client.query<WorkflowRow>('SELECT * FROM submissions WHERE id = $1 FOR UPDATE', [submissionId]);
  const row = result.rows[0];
  if (!row) throw new SubmissionNotFoundError();
  if (row.submission_type !== 'normal' || !row.workflow_status) {
    throw new ReviewDecisionError('此申報不支援一般 NDRF 審批流程');
  }
  await assertReviewerScope(client, user, row);
  return row;
}

export interface UpdateRemarkInput {
  user: { id: string; role: 'buyer' | 'sct'; username: string };
  submissionId: string;
  remark: string;
  ip: string;
}

export async function updateReviewRemark(input: UpdateRemarkInput): Promise<WorkflowRow> {
  const remark = normalizeText(input.remark);
  return withTransaction(async (client) => {
    const row = await loadReviewerRow(client, input.user, input.submissionId);
    if (row.workflow_status !== 'pending') {
      throw new ReviewDecisionError('只有 Pending 狀態的申請可以修改 Review Remark');
    }
    await client.query(
      `INSERT INTO ndrf_review_events
         (submission_id, review_round, event_type, actor_role, actor_user_id, actor, remark, ip, ip_expires_at)
       VALUES ($1, $2, 'remark', $3, $4, $5, $6, $7, $8)`,
      [row.id, row.review_round, input.user.role, input.user.id, input.user.username, remark || null, input.ip, input.ip ? ipExpiryIso() : null],
    );
    const updated = await client.query<WorkflowRow>(
      'UPDATE submissions SET current_review_remark = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [remark || null, row.id],
    );
    return updated.rows[0]!;
  });
}

export interface DecisionInput {
  user: { id: string; role: 'buyer' | 'sct'; username: string };
  submissionId: string;
  decision: 'accept' | 'reject';
  remark?: string;
  rejectReasonCode?: string;
  rejectReasonNote?: string;
  ip: string;
}

export interface DecisionResult {
  row: WorkflowRow;
  event: ReviewEventRow;
  replayed: boolean;
}

/**
 * Applies the single reviewer decision. A retry of the same decision for the
 * same review round returns the original result; the DB unique index on
 * (submission_id, review_round) guarantees only one effective decision.
 */
export async function decideSubmission(input: DecisionInput): Promise<DecisionResult> {
  return withTransaction(async (client) => {
    const row = await loadReviewerRow(client, input.user, input.submissionId);
    if (row.locked_at || row.exported_at) throw new WorkflowLockedError();

    // Idempotency first: a retry of the same round's decision replays the
    // original result even though the submission is no longer pending.
    const existing = await client.query<ReviewEventRow>(
      `SELECT id, submission_id, review_round, event_type, actor_role, actor_user_id, actor,
              remark, reject_reason_code, reject_reason_label, reject_reason_note, reason, ip, created_at
         FROM ndrf_review_events
        WHERE submission_id = $1 AND review_round = $2
          AND event_type IN ('accept', 'reject')
        FOR UPDATE`,
      [row.id, row.review_round],
    );
    const previous = existing.rows[0];
    if (previous && previous.event_type !== input.decision) {
      throw new ReviewDecisionError('此申請已有決定，不能重複審批');
    }
    if (previous && row.workflow_status !== 'pending') {
      return { row, event: previous, replayed: true };
    }
    if (!previous && row.workflow_status !== 'pending') {
      throw new ReviewDecisionError('此申請已決定或不在 Pending 狀態');
    }

    // `previous` on a still-pending row means the round's decision was recorded
    // but the status update was lost (legacy of a mid-round edit); re-apply the
    // recorded decision so the row can leave pending instead of replaying it.

    let rejectReasonCode: string | null = null;
    let rejectReasonLabel: string | null = null;
    let rejectReasonNote: string | null = null;
    let remark: string | null;
    let event: ReviewEventRow;

    if (previous) {
      remark = previous.remark;
      event = previous;
    } else {
      if (input.decision === 'reject') {
        const code = normalizeText(input.rejectReasonCode);
        if (!code) throw new ReviewDecisionError('Reject 必須選擇原因類別');
        const reason = await client.query<{ code: string; label: string; active: boolean }>(
          'SELECT code, label, active FROM ndrf_rejection_reasons WHERE code = $1',
          [code],
        );
        const reasonRow = reason.rows[0];
        if (!reasonRow || !reasonRow.active) throw new ReviewDecisionError('Reject 原因類別無效');
        rejectReasonCode = reasonRow.code;
        rejectReasonLabel = reasonRow.label;
        rejectReasonNote = normalizeText(input.rejectReasonNote) || null;
        if (code === 'other' && !rejectReasonNote) {
          throw new ReviewDecisionError('選擇「其他」時必須填寫補充說明');
        }
        if (!rejectReasonNote) {
          throw new ReviewDecisionError('Reject 必須填寫補充說明');
        }
      }
      remark = normalizeText(input.remark) || null;
      const inserted = await client.query<ReviewEventRow>(
        `INSERT INTO ndrf_review_events
           (submission_id, review_round, event_type, actor_role, actor_user_id, actor,
            remark, reject_reason_code, reject_reason_label, reject_reason_note, ip, ip_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, submission_id, review_round, event_type, actor_role, actor_user_id, actor,
                   remark, reject_reason_code, reject_reason_label, reject_reason_note, reason, ip, created_at`,
        [
          row.id,
          row.review_round,
          input.decision,
          input.user.role,
          input.user.id,
          input.user.username,
          remark,
          rejectReasonCode,
          rejectReasonLabel,
          rejectReasonNote,
          input.ip,
          input.ip ? ipExpiryIso() : null,
        ],
      );
      event = inserted.rows[0]!;
    }

    const updated = await client.query<WorkflowRow>(
      `UPDATE submissions
          SET workflow_status = $1,
              rejected_at = CASE WHEN $1 = 'rejected' THEN now() ELSE rejected_at END,
              active_workflow = CASE WHEN $1 = 'rejected' THEN false ELSE active_workflow END,
              current_review_remark = $2,
              updated_at = now()
        WHERE id = $3
        RETURNING *`,
      [input.decision === 'accept' ? 'accepted' : 'rejected', remark, row.id],
    );
    return { row: updated.rows[0]!, event, replayed: false };
  });
}

export interface OverrideInput {
  adminUsername: string;
  submissionId: string;
  action: 'override_ready' | 'override_accept' | 'override_reject' | 'reopen';
  reason: string;
  ip: string;
}

export async function adminWorkflowOverride(input: OverrideInput): Promise<WorkflowRow> {
  const reason = normalizeText(input.reason);
  if (!reason) throw new ReviewDecisionError('Override/Reopen 必須填寫原因');

  return withTransaction(async (client) => {
    const result = await client.query<WorkflowRow>('SELECT * FROM submissions WHERE id = $1 FOR UPDATE', [input.submissionId]);
    const row = result.rows[0];
    if (!row) throw new SubmissionNotFoundError();
    if (row.submission_type !== 'normal' || !row.workflow_status || row.workflow_status === 'legacy') {
      throw new ReviewDecisionError('此申報不支援 workflow override');
    }
    if (row.locked_at || row.exported_at) throw new WorkflowLockedError();

    // Restoring an active row must not collide with the Site+SKU+RP Type
    // uniqueness guard (e.g. the store re-submitted after the cooldown while
    // this row was still rejected). The advisory lock serialises against a
    // concurrent store submit; the cooldown itself is irrelevant for override.
    if (input.action !== 'override_reject') {
      await lockWorkflowSubmissionKey(client, row.site_code, row.sku, row.rp_type ?? '');
      await assertNoActiveOrCooldown(client, {
        siteCode: row.site_code,
        sku: row.sku,
        rpType: row.rp_type ?? '',
        excludeId: row.id,
        checkCooldown: false,
      });
    }

    let nextStatus: WorkflowStatus;
    let nextRound = row.review_round;
    if (input.action === 'reopen') {
      if (row.workflow_status !== 'rejected') {
        throw new ReviewDecisionError('只有 Rejected 的申請可以 Reopen');
      }
      nextStatus = 'pending';
      nextRound = row.review_round + 1;
    } else if (input.action === 'override_ready') {
      nextStatus = 'ready_for_rp';
    } else if (input.action === 'override_accept') {
      nextStatus = 'accepted';
    } else {
      nextStatus = 'rejected';
    }

    await client.query(
      `INSERT INTO ndrf_review_events
         (submission_id, review_round, event_type, actor_role, actor, reason, ip, ip_expires_at)
       VALUES ($1, $2, $3, 'admin', $4, $5, $6, $7)`,
      [
        row.id,
        nextRound,
        input.action === 'reopen' ? 'reopen' : 'override',
        input.adminUsername,
        reason,
        input.ip,
        input.ip ? ipExpiryIso() : null,
      ],
    );

    try {
      const updated = await client.query<WorkflowRow>(
        `UPDATE submissions
            SET workflow_status = $1,
                review_round = $2,
                active_workflow = $3,
                rejected_at = CASE WHEN $1 = 'rejected' THEN now() ELSE NULL END,
                auto_approved_at = NULL,
                current_review_remark = NULL,
                round_started_at = CASE WHEN $5 THEN now() ELSE round_started_at END,
                updated_at = now()
          WHERE id = $4
          RETURNING *`,
        [
          nextStatus,
          nextRound,
          nextStatus === 'rejected' ? false : true,
          row.id,
          input.action === 'reopen',
        ],
      );
      return updated.rows[0]!;
    } catch (err) {
      // Last-resort guard: the partial unique index on active rows can still
      // reject a race we did not foresee; translate it into a clean 409.
      if ((err as { code?: string }).code === '23505') {
        throw new ActiveSubmissionConflictError();
      }
      throw err;
    }
  });
}

export async function listRejectionReasons(activeOnly = true): Promise<Array<{ code: string; label: string }>> {
  const result = await query<{ code: string; label: string }>(
    `SELECT code, label FROM ndrf_rejection_reasons
      ${activeOnly ? 'WHERE active' : ''}
      ORDER BY sort_order ASC, code ASC`,
  );
  return result.rows;
}

export interface AdminEditInput {
  adminUsername: string;
  submissionId: string;
  fields: SubmissionBusinessFields;
  ip: string;
}

/**
 * Admin business edit for general NDRF.
 * - pending: fields are updated and the route/status are recomputed in the
 *   same transaction (a changed SKU / RP Type may move the item to a new
 *   Buyer / SCT or to Ready for RP).
 * - decided (accepted / ready_for_rp / rejected): direct edits are refused;
 *   the admin must use override/reopen to start a new review round so the
 *   original decision is never silently kept against new data.
 * - legacy rows fall back to the old field-only edit.
 */
export async function adminEditWorkflowSubmission(input: AdminEditInput): Promise<WorkflowRow> {
  return withTransaction(async (client) => {
    const result = await client.query<WorkflowRow>('SELECT * FROM submissions WHERE id = $1 FOR UPDATE', [input.submissionId]);
    const row = result.rows[0];
    if (!row) throw new SubmissionNotFoundError();
    if (row.submission_type !== 'normal') throw new ReviewDecisionError('此申報不支援一般 NDRF workflow 編輯');

    if (row.workflow_status === 'legacy' || row.workflow_status === null) {
      // Legacy / manual rows keep the field-only behaviour, but exported rows
      // are still immutable (the SAP export must always match the database).
      if (row.locked_at || row.exported_at) throw new WorkflowLockedError();
      const before = {
        brand: row.brand,
        sku: row.sku,
        rp_type: row.rp_type,
        safety_stock: row.safety_stock,
        nd_code: row.nd_code,
        remark: row.remark,
      };
      const updated = await client.query<WorkflowRow>(
        `UPDATE submissions SET
           brand = $1, sku = $2, rp_type = $3, safety_stock = $4, nd_code = $5, remark = $6,
           updated_at = now()
         WHERE id = $7
         RETURNING *`,
        [
          normalizeText(input.fields.brand) || null,
          normalizeText(input.fields.sku),
          normalizeText(input.fields.rp_type) || null,
          normalizeText(input.fields.safety_stock) || null,
          normalizeText(input.fields.nd_code) || null,
          normalizeText(input.fields.remark) || null,
          row.id,
        ],
      );
      const newRow = updated.rows[0]!;
      await appendVersion(client, row, newRow, before, input.fields, input.adminUsername, input.ip, 'admin_edit', 'admin');
      return newRow;
    }

    if (row.locked_at || row.exported_at) throw new WorkflowLockedError();
    if (row.workflow_status !== 'pending' && row.workflow_status !== 'ready_for_rp') {
      throw new ReviewDecisionError(
        '此申請已有決定，請先使用 Override/Reopen 開啟新審批回合後再修改，原決定不會被覆寫',
      );
    }

    const siteCode = row.site_code;
    const configResult = await client.query<StoreRouteConfig>(
      'SELECT site_code, sct_review_required, remark_required FROM ndrf_store_routes WHERE site_code = $1',
      [siteCode],
    );
    const remarkRequired = configResult.rows[0]?.remark_required ?? false;
    const fieldErrors = validateNormalBusinessFields(input.fields, siteCode, remarkRequired);
    if (fieldErrors.length) {
      throw new FieldValidationError(fieldErrors[0]!.message, fieldErrors[0]!.field);
    }
    const route = await resolveWorkflowRoute(client, input.fields, siteCode);
    await lockWorkflowSubmissionKey(client, siteCode, input.fields.sku, input.fields.rp_type || '');
    await assertNoActiveOrCooldown(client, {
      siteCode,
      sku: input.fields.sku,
      rpType: normalizeText(input.fields.rp_type),
      excludeId: row.id,
    });

    const before = {
      brand: row.brand,
      sku: row.sku,
      rp_type: row.rp_type,
      safety_stock: row.safety_stock,
      nd_code: row.nd_code,
      remark: row.remark,
    };

    // An edit that moves the row back into review must start a fresh round:
    // the per-round decision uniqueness would otherwise collide with the
    // previous round's accept/reject/auto_accept event and leave the row
    // permanently pending, and the SLA clock must not carry over either.
    const reopensReview = route.status === 'pending' && row.workflow_status !== 'pending';
    const nextRound = reopensReview ? row.review_round + 1 : row.review_round;

    const updated = await client.query<WorkflowRow>(
      `UPDATE submissions SET
         brand = $1, sku = $2, rp_type = $3, safety_stock = $4, nd_code = $5, remark = $6,
         ndrf_route = $7, workflow_status = $8,
         review_round = $9,
         round_started_at = CASE WHEN $10 THEN now() ELSE round_started_at END,
         current_review_remark = CASE WHEN $10 THEN NULL ELSE current_review_remark END,
         updated_at = now()
       WHERE id = $11
       RETURNING *`,
      [
        normalizeText(input.fields.brand) || null,
        normalizeText(input.fields.sku),
        normalizeText(input.fields.rp_type) || null,
        normalizeText(input.fields.safety_stock) || null,
        normalizeText(input.fields.nd_code) || null,
        normalizeText(input.fields.remark) || null,
        route.route,
        route.status,
        nextRound,
        reopensReview,
        row.id,
      ],
    );
    const newRow = updated.rows[0]!;
    if (reopensReview) {
      await client.query(
        `INSERT INTO ndrf_review_events
           (submission_id, review_round, event_type, actor_role, actor, reason, ip, ip_expires_at)
         VALUES ($1, $2, 'override', 'admin', $3, $4, $5, $6)`,
        [
          row.id,
          nextRound,
          input.adminUsername,
          'Admin 編輯欄位後重新送審，開啟新審批回合',
          input.ip,
          input.ip ? ipExpiryIso() : null,
        ],
      );
    }
    await appendVersion(client, row, newRow, before, input.fields, input.adminUsername, input.ip, 'admin_edit', 'admin');
    return newRow;
  });
}

async function appendVersion(
  client: Queryable,
  row: WorkflowRow,
  newRow: WorkflowRow,
  before: Record<string, unknown>,
  after: SubmissionBusinessFields,
  actor: string,
  ip: string,
  changeSource: string,
  actorRole: ReviewActorRole,
): Promise<void> {
  const versionResult = await client.query<{ max: number | null }>(
    'SELECT max(version) AS max FROM submission_versions WHERE submission_id = $1',
    [row.id],
  );
  const nextVersion = (versionResult.rows[0]?.max ?? 0) + 1;
  await client.query(
    `INSERT INTO submission_versions
       (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.id, nextVersion, JSON.stringify(before), JSON.stringify(after), actorRole, actor, ip, changeSource],
  );
  void newRow;
}

export interface PendingReviewItem {
  application_no: string;
  site_code: string;
  shop_snapshot: string | null;
  sku: string;
  rp_type: string | null;
  safety_stock: string | null;
  nd_code: string | null;
  remark: string | null;
  submitted_at: string;
  review_round: number;
  current_review_remark: string | null;
  buyer_user_id: string | null;
  buyer_username: string | null;
  buyer_display_name: string | null;
  buyer_active: boolean | null;
}

export interface PendingReviewBuyerSummary {
  buyer_user_id: string;
  buyer_username: string;
  buyer_display_name: string;
  buyer_active: boolean;
  pending_submissions: number;
  pending_skus: number;
  skus: string[];
}

export interface PendingReviewSummary {
  buyers: PendingReviewBuyerSummary[];
  items: PendingReviewItem[];
  unassigned: PendingReviewItem[];
  total_pending_submissions: number;
  total_pending_skus: number;
}

/**
 * Admin reminder data: every pending ND submission and the Buyer who currently
 * owns the SKU (via the live SKU Master). Unassigned pending items (no Buyer or
 * deactivated Buyer) are reported separately so Admin can chase the config.
 */
export async function listPendingReviewSummary(): Promise<PendingReviewSummary> {
  const result = await query<PendingReviewItem>(
    `SELECT s.application_no, s.site_code, s.shop_snapshot, s.sku, s.rp_type,
            s.safety_stock, s.nd_code, s.remark, s.submitted_at,
            s.review_round, s.current_review_remark,
            m.buyer_user_id, u.username AS buyer_username,
            u.display_name AS buyer_display_name, u.active AS buyer_active
       FROM submissions s
       LEFT JOIN sku_master m ON m.sku = s.sku
       LEFT JOIN portal_users u ON u.id = m.buyer_user_id
      WHERE s.submission_type = 'normal'
        AND s.ndrf_route = 'buyer'
        AND s.workflow_status = 'pending'
      ORDER BY u.username NULLS LAST, s.sku ASC, s.submitted_at ASC`,
  );
  const items = result.rows;
  const unassigned = items.filter((row) => !row.buyer_user_id || row.buyer_active === false);

  const byBuyer = new Map<string, PendingReviewBuyerSummary>();
  const skuByBuyer = new Map<string, Set<string>>();
  for (const row of items) {
    if (!row.buyer_user_id || row.buyer_active === false) continue;
    let summary = byBuyer.get(row.buyer_user_id);
    if (!summary) {
      summary = {
        buyer_user_id: row.buyer_user_id,
        buyer_username: row.buyer_username ?? '',
        buyer_display_name: row.buyer_display_name ?? '',
        buyer_active: row.buyer_active ?? false,
        pending_submissions: 0,
        pending_skus: 0,
        skus: [],
      };
      byBuyer.set(row.buyer_user_id, summary);
      skuByBuyer.set(row.buyer_user_id, new Set());
    }
    summary.pending_submissions++;
    skuByBuyer.get(row.buyer_user_id)!.add(row.sku);
  }
  for (const summary of byBuyer.values()) {
    summary.skus = [...skuByBuyer.get(summary.buyer_user_id)!].sort();
    summary.pending_skus = summary.skus.length;
  }
  const buyers = [...byBuyer.values()].sort((a, b) => a.buyer_username.localeCompare(b.buyer_username));
  return {
    buyers,
    items,
    unassigned,
    total_pending_submissions: items.length,
    total_pending_skus: new Set(items.map((row) => row.sku)).size,
  };
}
export const AUTO_APPROVE_REMARK = 'Buyer 未有回復，默認同意';

export interface BuyerAutoApproveResult {
  approved: number;
  skipped: number;
}

/**
 * Company SLA rule: pending ND submissions whose Buyer has not replied within
 * `ndrfAutoApproveDays` are auto-approved (default agreement). Each approval
 * writes an immutable `auto_accept` review event (actor_role = system) with the
 * remark "Buyer 未有回復，默認同意" and marks `auto_approved_at` so Admin can
 * follow up. Rows that already have a decision for the round are never touched.
 */
export async function runBuyerAutoApproveJob(): Promise<BuyerAutoApproveResult> {
  return withTransaction(async (client) => {
    const rows = await client.query<WorkflowRow>(
      `SELECT * FROM submissions
        WHERE submission_type = 'normal'
          AND ndrf_route = 'buyer'
          AND workflow_status = 'pending'
          AND locked_at IS NULL
          AND exported_at IS NULL
          AND COALESCE(round_started_at, submitted_at) <= now() - ($1::int * interval '1 day')
        FOR UPDATE SKIP LOCKED`,
      [config.ndrfAutoApproveDays],
    );
    let approved = 0;
    let skipped = 0;
    for (const row of rows.rows) {
      const decided = await client.query(
        `SELECT 1 FROM ndrf_review_events
          WHERE submission_id = $1 AND review_round = $2
            AND event_type IN ('accept', 'reject', 'auto_accept')
          LIMIT 1`,
        [row.id, row.review_round],
      );
      if (decided.rows.length > 0) {
        skipped++;
        continue;
      }
      await client.query(
        `INSERT INTO ndrf_review_events
           (submission_id, review_round, event_type, actor_role, actor, remark, ip, ip_expires_at)
         VALUES ($1, $2, 'auto_accept', 'system', 'auto-approve', $3, NULL, NULL)`,
        [row.id, row.review_round, AUTO_APPROVE_REMARK],
      );
      await client.query(
        `UPDATE submissions
            SET workflow_status = 'accepted',
                current_review_remark = $1,
                auto_approved_at = now(),
                updated_at = now()
          WHERE id = $2`,
        [AUTO_APPROVE_REMARK, row.id],
      );
      approved++;
    }
    return { approved, skipped };
  });
}