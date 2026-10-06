import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import {
  adminLoginLimiter,
  adminActionLimiter,
  excelImportLimiter,
  excelExportLimiter,
} from '../middleware/rateLimits.js';
import { asyncHandler, getClientIp, requireUuidParam } from '../middleware/helpers.js';
import { login, requireAdmin, destroySession, SESSION_COOKIE } from '../middleware/auth.js';
import { writeAuditEvent } from '../lib/audit.js';
import { config } from '../config.js';
import {
  getSubmissionById,
  listVersions,
  adminUpdateUrgentSubmission,
  adminUpdateSalesSubmission,
  adminUpdateReturnSubmission,
  LockedError,
  type SubmissionRow,
} from '../services/submissions.js';
import {
  adminEditWorkflowSubmission,
  adminWorkflowOverride,
  getReviewEvents,
  listPendingReviewSummary,
  runBuyerAutoApproveJob,
  getStoreRouteConfig,
  listRejectionReasons,
  WorkflowConfigurationError,
  WorkflowLockedError,
  ReviewDecisionError,
  SubmissionNotFoundError,
  ActiveSubmissionConflictError,
  CooldownActiveError,
  type WorkflowRow,
} from '../services/ndrfWorkflow.js';
import {
  createNormalSubmissionBatch,
  type CreateNormalSubmissionInput,
} from '../services/ndrfWorkflow.js';
import {
  createBuyerOrSctAccount,
  syncStorePortalAccounts,
} from '../services/storeAccounts.js';
import {
  assertBuyerHasNoSkus,
  assertSctHasNoPending,
  listSkuMaster,
  listSkuMasterBatches,
  replaceSkuMaster,
} from '../services/skuMaster.js';
import { query, withTransaction } from '../db/pool.js';
import {
  generateTemplateWorkbook,
  buildSapExportBuffer,
  buildAuditExportBuffer,
  generateUrgentTemplateWorkbook,
  buildUrgentExportBuffer,
  buildSalesExportBuffer,
  buildReturnExportBuffer,
  buildReviewPendingBuffer,
} from '../lib/excelExport.js';
import {
  parseImportWorkbook,
  parseUrgentImportWorkbook,
  EXCEL_UPLOAD_EXTENSION_ERROR,
} from '../lib/excelImport.js';
import { getStore, normalizeSiteCode, parseStoresCsv, decodeStoresCsvBuffer, replaceStores, listStores } from '../services/stores.js';
import { MASTER_RECOVERY_OM, setRecoveryCode, deleteRecoveryCode } from '../lib/recovery.js';
import { toHKString, toHKDateString, hkTodayForDateColumn } from '../lib/time.js';
import { generateApplicationNo } from '../lib/applicationNo.js';
import { ipExpiryIso } from '../lib/ip.js';
import {
  URGENT_QTY_MIN,
  URGENT_QTY_MAX,
  urgentReasonLabel,
  RETURN_QTY_MIN,
  RETURN_QTY_MAX,
  returnReasonLabel,
  resolveReturnReasonCode,
} from '../lib/fields.js';
import { isValidIsoDate, validateUrgentReason } from '../lib/validation.js';
import { getUploadedFile, validateUploadedXlsx } from '../lib/upload.js';
import { EXPORT_CONTENT_TYPE } from '../services/exportFiles.js';
import { requireCsrf } from '../middleware/csrf.js';
import {
  createLockedExport,
  exportFilename,
  findExportRows,
  type ExportDefinition,
  type ExportFilters,
  type ExportSubmissionType,
} from '../services/exportBatches.js';
import { createImportBatch, findImportBatchByContentHash } from '../services/importBatches.js';
import {
  buildZeroSalesExportBuffer,
  generateZeroSalesTemplateWorkbook,
  parseZeroSalesWorkbook,
} from '../lib/zeroSales.js';
import {
  createBatch as createZeroSalesBatch,
  getZeroSalesSummary as getZeroSalesSummaryStats,
  listBatches as listZeroSalesBatches,
  listBatchItems as listZeroSalesBatchItems,
  listItemsForExport as listZeroSalesForExport,
  listReasons as listZeroSalesReasons,
  listZeroSalesRepeats,
  deleteZeroSalesBatch,
  deleteZeroSalesBatchSite,
  deleteZeroSalesItem,
  adminReplyItem,
  ZeroSalesReplyError,
} from '../services/zeroSales.js';

export const adminRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
    parts: 12,
    fields: 10,
    fieldSize: 64 * 1024,
    fieldNameSize: 100,
    headerPairs: 200,
  },
});

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

adminRouter.post(
  '/login',
  adminLoginLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '請輸入使用者名稱及密碼' });
      return;
    }
    const result = await login(parsed.data.username, parsed.data.password, getClientIp(req));
    if (!result.ok || !result.token) {
      res.status(401).json({ error: result.reason ?? '登入失敗' });
      return;
    }
    res.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      secure: config.env === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: config.sessionTtlHours * 3600 * 1000,
    });
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/logout',
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      await destroySession(token);
      await writeAuditEvent({ eventType: 'logout', actorRole: 'admin', actor: req.adminUsername, ip: getClientIp(req) });
    }
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  }),
);

adminRouter.get('/me', requireAdmin, (req: Request, res: Response) => {
  res.json({ username: req.adminUsername });
});

const businessFieldsSchema = z.object({
  brand: z.string().max(500).optional().default(''),
  sku: z.string().trim().min(1, 'SKU 為必填').max(100),
  rp_type: z.string().max(100).optional().default(''),
  safety_stock: z.string().max(100).optional().default(''),
  nd_code: z.string().max(300).optional().default(''),
  remark: z.string().max(2000).optional().default(''),
});

function exportSubmissionType(filters: unknown): ExportSubmissionType {
  if (filters && typeof filters === 'object' && 'submission_type' in filters) {
    const type = (filters as { submission_type?: unknown }).submission_type;
    if (type === 'urgent' || type === 'sales' || type === 'return') return type;
  }
  return 'normal';
}

async function buildArchivedExportBuffer(type: ExportSubmissionType, rows: SubmissionRow[]): Promise<Buffer> {
  if (type === 'urgent') {
    return buildUrgentExportBuffer(rows.map((row) => ({
      application_no: row.application_no,
      site_code: row.site_code,
      sku: row.sku,
      qty: row.qty,
      urgent_reason: row.urgent_reason,
      urgent_reason_other: row.urgent_reason_other,
    })));
  }
  if (type === 'sales') {
    return buildSalesExportBuffer(rows.map((row) => ({
      application_date: row.application_date,
      requested_by_email: row.requested_by_email,
      site_code: row.site_code,
      sku: row.sku,
    })));
  }
  if (type === 'return') {
    return buildReturnExportBuffer(rows.map((row) => ({
      application_no: row.application_no,
      application_date: row.application_date,
      site_code: row.site_code,
      sku: row.sku,
      qty: row.return_qty,
      reason: row.return_reason,
      confirmer_name: row.return_confirmer_name,
      confirmer_phone: row.return_confirmer_phone,
    })));
  }
  return buildSapExportBuffer(rows);
}

function serializeAdminSubmission(row: SubmissionRow & { store_shop?: string | null; workflow_status?: string | null }, lastModifiedAt?: string | null) {
  const workflow = row.workflow_status
    ? {
        route: (row as SubmissionRow & { ndrf_route?: string | null }).ndrf_route ?? null,
        status: row.workflow_status,
        rejected_at: (row as SubmissionRow & { rejected_at?: string | null }).rejected_at
          ? toHKString((row as SubmissionRow & { rejected_at?: string | null }).rejected_at!)
          : null,
        review_round: (row as SubmissionRow & { review_round?: number }).review_round ?? 0,
        review_remark: (row as SubmissionRow & { current_review_remark?: string | null }).current_review_remark ?? null,
        auto_approved_at: (row as SubmissionRow & { auto_approved_at?: string | null }).auto_approved_at
          ? toHKString((row as SubmissionRow & { auto_approved_at?: string | null }).auto_approved_at!)
          : null,
      }
    : null;
  return {
    id: row.id,
    application_no: row.application_no,
    source: row.source,
    submission_type: row.submission_type,
    site_code: row.site_code,
    store_shop: row.store_shop ?? null,
    requested_by_email: row.requested_by_email,
    application_date: row.application_date,
    submitted_at: toHKString(row.submitted_at),
    updated_at: row.updated_at ? toHKString(row.updated_at) : null,
    last_modified_at: lastModifiedAt ? toHKString(lastModifiedAt) : null,
    locked: Boolean(row.locked_at || row.exported_at),
    locked_at: row.locked_at ? toHKString(row.locked_at) : null,
    exported_at: row.exported_at ? toHKString(row.exported_at) : null,
    brand: row.brand,
    sku: row.sku,
    rp_type: row.rp_type,
    safety_stock: row.safety_stock,
    nd_code: row.nd_code,
    remark: row.remark,
    qty: row.qty,
    urgent_reason: row.urgent_reason,
    urgent_reason_label: urgentReasonLabel(row.urgent_reason),
    urgent_reason_other: row.urgent_reason_other,
    return_qty: row.return_qty,
    return_reason: row.return_reason,
    return_reason_label: returnReasonLabel(row.return_reason),
    return_confirmer_name: row.return_confirmer_name,
    return_confirmer_phone: row.return_confirmer_phone,
    return_window_key: row.return_window_key,
    workflow,
  };
}

/** GET /api/admin/submissions — list with filters + pagination. */
adminRouter.get(
  '/submissions',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const {
      from,
      to,
      site_code,
      source,
      submission_type,
      exported,
      modified,
      workflow_status,
      auto_approved,
      sku,
      rp_type,
      nd_code,
      application_no,
      page = '1',
      page_size = '20',
    } = req.query as Record<string, string | undefined>;
     if ((from && !isValidIsoDate(from)) || (to && !isValidIsoDate(to)) || (from && to && from > to)) {
       res.status(400).json({ error: '日期範圍無效，請使用 YYYY-MM-DD 且由日期不可晚於至日期' });
       return;
     }
const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    // All filter columns are qualified with `s.` because the list query joins
    // `stores` (which also has a `site_code` column), so an unqualified
    // `site_code` would be ambiguous and raise a server error.
    if (from) {
      where.push(`s.application_date >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      where.push(`s.application_date <= $${idx++}`);
      params.push(to);
    }
    if (site_code) {
      where.push(`s.site_code = $${idx++}`);
      params.push(normalizeSiteCode(site_code));
    }
    if (source) {
      where.push(`s.source = $${idx++}`);
      params.push(source);
    }
    if (submission_type === 'normal' || submission_type === 'urgent' || submission_type === 'sales' || submission_type === 'return') {
      where.push(`s.submission_type = $${idx++}`);
      params.push(submission_type);
    }
    if (exported === 'yes') {
      where.push(`s.exported_at IS NOT NULL`);
    } else if (exported === 'no') {
      where.push(`s.exported_at IS NULL`);
    }
    if (workflow_status === 'pending' || workflow_status === 'ready_for_rp' || workflow_status === 'accepted' || workflow_status === 'rejected' || workflow_status === 'legacy') {
      where.push(`s.workflow_status = $${idx++}`);
      params.push(workflow_status);
    }
    if (auto_approved === 'yes') {
      where.push(`s.auto_approved_at IS NOT NULL`);
    } else if (auto_approved === 'no') {
      where.push(`s.auto_approved_at IS NULL`);
    }
    if (modified === 'yes') {
      where.push(`EXISTS (SELECT 1 FROM submission_versions v WHERE v.submission_id = s.id AND v.version > 1)`);
    } else if (modified === 'no') {
      where.push(`NOT EXISTS (SELECT 1 FROM submission_versions v WHERE v.submission_id = s.id AND v.version > 1)`);
    }
    if (sku) {
      where.push(`s.sku ILIKE $${idx++}`);
      params.push(`%${sku.trim()}%`);
    }
    if (rp_type) {
      const upper = rp_type.trim().toUpperCase();
      if (upper === 'ND' || upper === 'RF') {
        where.push(`s.rp_type = $${idx++}`);
        params.push(upper);
      }
    }
    if (nd_code) {
      where.push(`s.nd_code = $${idx++}`);
      params.push(nd_code.trim());
    }
    if (application_no) {
      where.push(`s.application_no = $${idx++}`);
      params.push(application_no.trim().toUpperCase());
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const pageNum = Math.max(1, Number(page) || 1);
    const size = Math.min(100, Math.max(1, Number(page_size) || 20));
    const offset = (pageNum - 1) * size;

    const countResult = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM submissions s ${whereSql}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? 0);

    const result = await query<SubmissionRow & { store_shop?: string | null }>(
      `SELECT s.*, st.shop AS store_shop
       FROM submissions s
       LEFT JOIN stores st ON st.site_code = s.site_code
       ${whereSql}
       ORDER BY s.submitted_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, size, offset],
    );

    const pageIds = result.rows.map((r) => r.id);
    const lastModified = new Map<string, string>();
    if (pageIds.length) {
      const modifiedRows = await query<{ submission_id: string; last_modified_at: string }>(
        `SELECT submission_id, max(changed_at) AS last_modified_at
         FROM submission_versions
         WHERE submission_id = ANY($1::uuid[]) AND version > 1
         GROUP BY submission_id`,
        [pageIds],
      );
      for (const r of modifiedRows.rows) {
        lastModified.set(r.submission_id, r.last_modified_at);
      }
    }

    res.json({
      total,
      page: pageNum,
      page_size: size,
      total_pages: Math.ceil(total / size),
      submissions: result.rows.map((row) => serializeAdminSubmission(row, lastModified.get(row.id) ?? null)),
    });
  }),
);

/** GET /api/admin/summary — submission counts for the dashboard preview. */
adminRouter.get(
  '/summary',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const today = hkTodayForDateColumn();
    const [y = 0, m = 0] = today.split('-').map(Number);
    const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
    const nextMonthStart =
      m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const rows = await query<{
      total: string;
      stores_today: string;
      stores_month: string;
      earliest_submission_today: { site_code: string; shop: string; time: string } | null;
      latest_submission_today: { site_code: string; shop: string; time: string } | null;
      normal_total: string;
      normal_exported: string;
      normal_today: string;
      normal_today_exported: string;
      normal_stores_today: string;
      urgent_total: string;
      urgent_exported: string;
      urgent_today: string;
       urgent_today_exported: string;
       urgent_stores_today: string;
       sales_total: string;
       sales_exported: string;
       sales_today: string;
       sales_today_exported: string;
       sales_stores_today: string;
       return_total: string;
       return_exported: string;
       return_today: string;
       return_today_exported: string;
       return_stores_today: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM submissions) AS total,
         (SELECT count(DISTINCT site_code)::text FROM submissions WHERE application_date = $1::date) AS stores_today,
         (SELECT count(DISTINCT site_code)::text FROM submissions WHERE application_date >= $2::date AND application_date < $3::date) AS stores_month,
         (SELECT jsonb_build_object('site_code', s.site_code, 'shop', COALESCE(st.shop, ''), 'time', to_char(s.submitted_at AT TIME ZONE $4, 'HH24:MI'))
            FROM submissions s
            LEFT JOIN stores st ON st.site_code = s.site_code
            WHERE s.application_date = $1::date
            ORDER BY s.submitted_at ASC LIMIT 1) AS earliest_submission_today,
         (SELECT jsonb_build_object('site_code', s.site_code, 'shop', COALESCE(st.shop, ''), 'time', to_char(s.submitted_at AT TIME ZONE $4, 'HH24:MI'))
            FROM submissions s
            LEFT JOIN stores st ON st.site_code = s.site_code
            WHERE s.application_date = $1::date
            ORDER BY s.submitted_at DESC LIMIT 1) AS latest_submission_today,
         (SELECT count(*)::text FROM submissions WHERE submission_type = 'normal') AS normal_total,
         (SELECT count(*)::text FROM submissions WHERE submission_type = 'normal' AND exported_at IS NOT NULL) AS normal_exported,
         (SELECT count(*)::text FROM submissions WHERE submission_type = 'normal' AND application_date = $1::date) AS normal_today,
         (SELECT count(*)::text FROM submissions WHERE submission_type = 'normal' AND application_date = $1::date AND exported_at IS NOT NULL) AS normal_today_exported,
          (SELECT count(DISTINCT site_code)::text FROM submissions WHERE submission_type = 'normal' AND application_date = $1::date) AS normal_stores_today,
          (SELECT count(*)::text FROM submissions WHERE submission_type = 'urgent') AS urgent_total,
          (SELECT count(*)::text FROM submissions WHERE submission_type = 'urgent' AND exported_at IS NOT NULL) AS urgent_exported,
          (SELECT count(*)::text FROM submissions WHERE submission_type = 'urgent' AND application_date = $1::date) AS urgent_today,
          (SELECT count(*)::text FROM submissions WHERE submission_type = 'urgent' AND application_date = $1::date AND exported_at IS NOT NULL) AS urgent_today_exported,
          (SELECT count(DISTINCT site_code)::text FROM submissions WHERE submission_type = 'urgent' AND application_date = $1::date) AS urgent_stores_today,
          (SELECT count(*)::text FROM submissions WHERE submission_type = 'sales') AS sales_total,
          (SELECT count(*)::text FROM submissions WHERE submission_type = 'sales' AND exported_at IS NOT NULL) AS sales_exported,
          (SELECT count(*)::text FROM submissions WHERE submission_type = 'sales' AND application_date = $1::date) AS sales_today,
          (SELECT count(*)::text FROM submissions WHERE submission_type = 'sales' AND application_date = $1::date AND exported_at IS NOT NULL) AS sales_today_exported,
           (SELECT count(DISTINCT site_code)::text FROM submissions WHERE submission_type = 'sales' AND application_date = $1::date) AS sales_stores_today,
           (SELECT count(*)::text FROM submissions WHERE submission_type = 'return') AS return_total,
           (SELECT count(*)::text FROM submissions WHERE submission_type = 'return' AND exported_at IS NOT NULL) AS return_exported,
           (SELECT count(*)::text FROM submissions WHERE submission_type = 'return' AND application_date = $1::date) AS return_today,
           (SELECT count(*)::text FROM submissions WHERE submission_type = 'return' AND application_date = $1::date AND exported_at IS NOT NULL) AS return_today_exported,
           (SELECT count(DISTINCT site_code)::text FROM submissions WHERE submission_type = 'return' AND application_date = $1::date) AS return_stores_today`,
      [today, monthStart, nextMonthStart, config.timezone],
    );
    const r = rows.rows[0]!;
    const submissionStoreInfo = (e: { site_code: string; shop: string; time: string } | null) =>
      e ? { site_code: e.site_code, shop: e.shop, time: e.time } : null;
    res.json({
      total: Number(r.total),
      stores_today: Number(r.stores_today),
      stores_month: Number(r.stores_month),
      earliest_submission_today: submissionStoreInfo(r.earliest_submission_today),
      latest_submission_today: submissionStoreInfo(r.latest_submission_today),
      normal: {
        total: Number(r.normal_total),
        exported: Number(r.normal_exported),
        today: Number(r.normal_today),
        today_exported: Number(r.normal_today_exported),
        stores_today: Number(r.normal_stores_today),
      },
      urgent: {
        total: Number(r.urgent_total),
        exported: Number(r.urgent_exported),
        today: Number(r.urgent_today),
        today_exported: Number(r.urgent_today_exported),
        stores_today: Number(r.urgent_stores_today),
      },
      sales: {
        total: Number(r.sales_total),
        exported: Number(r.sales_exported),
        today: Number(r.sales_today),
        today_exported: Number(r.sales_today_exported),
        stores_today: Number(r.sales_stores_today),
      },
      return: {
        total: Number(r.return_total),
        exported: Number(r.return_exported),
        today: Number(r.return_today),
        today_exported: Number(r.return_today_exported),
        stores_today: Number(r.return_stores_today),
      },
    });
  }),
);

/** GET /api/admin/submissions/:id — detail + versions + workflow events. */
adminRouter.get(
  '/submissions/:id',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const row = await getSubmissionById(req.params.id as string);
    if (!row) {
      res.status(404).json({ error: '找不到申報' });
      return;
    }
    const versions = await listVersions(row.id);
    const store = await getStore(row.site_code);
    const events = row.submission_type === 'normal' && (row as WorkflowRow).workflow_status
      ? await getReviewEvents(row.id)
      : [];
    res.json({
      submission: serializeAdminSubmission(row),
      store: store ?? null,
      rejectionReasons: await listRejectionReasons(true),
      reviewEvents: events.map((event) => ({
        event_type: event.event_type,
        actor_role: event.actor_role,
        actor: event.actor,
        review_round: event.review_round,
        remark: event.remark,
        reject_reason_code: event.reject_reason_code,
        reject_reason_label: event.reject_reason_label,
        reject_reason_note: event.reject_reason_note,
        reason: event.reason,
        ip: event.ip,
        created_at: toHKString(event.created_at),
      })),
      versions: versions.map((v) => ({
        version: v.version,
        actor_role: v.actor_role,
        actor: v.actor,
        ip: v.ip,
        change_source: v.change_source,
        changed_at: toHKString(v.changed_at as string),
        data_before: v.data_before,
        data_after: v.data_after,
      })),
    });
  }),
);

/** PUT /api/admin/submissions/:id — admin edits fields according to submission type. */
adminRouter.put(
  '/submissions/:id',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const row = await getSubmissionById(req.params.id as string);
    if (!row) {
      res.status(404).json({ error: '找不到申報' });
      return;
    }
    const ip = getClientIp(req);
    if (row.submission_type === 'return') {
      const returnSchema = z.object({
        sku: z.string().trim().min(1, 'SKU 為必填').max(100),
        return_qty: z.number({ invalid_type_error: 'QTY 必須為整數' }).int('QTY 必須為整數').min(RETURN_QTY_MIN).max(RETURN_QTY_MAX),
        return_reason: z.string().trim().min(1, 'REASON 為必填').max(200),
        return_confirmer_name: z.string().trim().min(1, '確認人姓名為必填').max(200),
        return_confirmer_phone: z.string().trim().min(1, '確認人電話為必填').max(200),
      });
      const parsed = returnSchema.safeParse(req.body);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        res.status(400).json({ error: first?.message ?? '輸入資料無效', field: first?.path[0] ?? null });
        return;
      }
      if (!resolveReturnReasonCode(parsed.data.return_reason)) {
        res.status(400).json({ error: 'REASON 選項無效', field: 'return_reason' });
        return;
      }
      try {
        const updated = await adminUpdateReturnSubmission({
          id: row.id,
          sku: parsed.data.sku,
          qty: parsed.data.return_qty,
          reason: parsed.data.return_reason,
          confirmerName: parsed.data.return_confirmer_name,
          confirmerPhone: parsed.data.return_confirmer_phone,
          ip,
          username: req.adminUsername!,
        });
        await writeAuditEvent({ eventType: 'admin_modified', actorRole: 'admin', actor: req.adminUsername, submissionId: row.id, applicationNo: row.application_no, ip, metadata: { submission_type: 'return' } });
        res.json({ submission: serializeAdminSubmission(updated) });
      } catch (err) {
        if (err instanceof LockedError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof Error && err.name === 'ReturnSubmissionConflictError') {
          res.status(409).json({ error: err.message, field: 'sku' });
          return;
        }
        throw err;
      }
      return;
    }
    if (row.submission_type === 'sales') {
      const salesSchema = z.object({
        sku: z.string().trim().min(1, 'SKU 為必填').max(100),
      });
      const parsed = salesSchema.safeParse(req.body);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        res.status(400).json({ error: first?.message ?? '輸入資料無效', field: first?.path[0] ?? null });
        return;
      }
      let updated: SubmissionRow;
      try {
        updated = await adminUpdateSalesSubmission({
          id: row.id,
          sku: parsed.data.sku,
          ip,
          username: req.adminUsername!,
        });
      } catch (err) {
        if (err instanceof LockedError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
      await writeAuditEvent({
        eventType: 'admin_modified',
        actorRole: 'admin',
        actor: req.adminUsername,
        submissionId: row.id,
        applicationNo: row.application_no,
        ip,
        metadata: { submission_type: 'sales' },
      });
      res.json({ submission: serializeAdminSubmission(updated) });
      return;
    }
    if (row.submission_type === 'urgent') {
      const urgentSchema = z.object({
        sku: z.string().trim().min(1, 'SKU 為必填').max(100),
        qty: z
          .number({ invalid_type_error: 'QTY 必須為整數' })
          .int('QTY 必須為整數')
          .min(URGENT_QTY_MIN, `QTY 最少為 ${URGENT_QTY_MIN}`)
          .max(URGENT_QTY_MAX, `QTY 最多為 ${URGENT_QTY_MAX}`),
        urgent_reason: z.string().trim().max(100).optional().default(''),
        urgent_reason_other: z.string().max(2000).optional().default(''),
      });
      const parsed = urgentSchema.safeParse(req.body);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        res.status(400).json({ error: first?.message ?? '輸入資料無效', field: first?.path[0] ?? null });
        return;
      }
      const reasonErrors = validateUrgentReason(parsed.data.urgent_reason, parsed.data.urgent_reason_other);
      if (reasonErrors.length) {
        res.status(400).json({
          error: reasonErrors[0]!.message,
          field: reasonErrors[0]!.field,
          errors: reasonErrors,
        });
        return;
      }
      let updated: SubmissionRow;
      try {
        updated = await adminUpdateUrgentSubmission({
          id: row.id,
          sku: parsed.data.sku,
          qty: parsed.data.qty,
          urgentReason: parsed.data.urgent_reason,
          urgentReasonOther: parsed.data.urgent_reason_other,
          ip,
          username: req.adminUsername!,
        });
      } catch (err) {
        if (err instanceof LockedError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
      await writeAuditEvent({
        eventType: 'admin_modified',
        actorRole: 'admin',
        actor: req.adminUsername,
        submissionId: row.id,
        applicationNo: row.application_no,
        ip,
      });
      res.json({ submission: serializeAdminSubmission(updated) });
      return;
    }

    const parsed = businessFieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({ error: first?.message ?? '輸入資料無效', field: first?.path[0] ?? null });
      return;
    }
    let updated: SubmissionRow;
    try {
      updated = await adminEditWorkflowSubmission({
        adminUsername: req.adminUsername!,
        submissionId: row.id,
        fields: parsed.data,
        ip,
      });
    } catch (err) {
      if (err instanceof LockedError || err instanceof WorkflowLockedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof ReviewDecisionError || err instanceof WorkflowConfigurationError || err instanceof ActiveSubmissionConflictError || err instanceof CooldownActiveError) {
        res.status(409).json({ error: err.message, field: (err as Error & { field?: string }).field ?? null });
        return;
      }
      if (err instanceof Error && (err as Error & { field?: string }).field) {
        res.status(400).json({ error: err.message, field: (err as Error & { field?: string }).field });
        return;
      }
      throw err;
    }
    await writeAuditEvent({
      eventType: 'admin_modified',
      actorRole: 'admin',
      actor: req.adminUsername,
      submissionId: row.id,
      applicationNo: row.application_no,
      ip,
    });
    res.json({ submission: serializeAdminSubmission(updated) });
  }),
);

/** GET /api/admin/template — download import template. */
adminRouter.get(
  '/template',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const buffer = await generateTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Safety Request.xlsx"`);
    res.send(buffer);
  }),
);

/** POST /api/admin/import — batch Excel import. */
adminRouter.post(
  '/import',
  requireAdmin,
  excelImportLimiter,
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const file = getUploadedFile(req)!;
    const uploadError = validateUploadedXlsx(file, config.maxUploadBytes, EXCEL_UPLOAD_EXTENSION_ERROR);
    if (uploadError) {
      res.status(uploadError.status).json({ error: uploadError.message });
      return;
    }

    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));

    const parsed = await parseImportWorkbook(file.buffer, storeCodes, config.maxImportRows, { validateSku: false });
    if (!parsed.ok || !parsed.rows) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: file.originalname, errors: parsed.errors ?? [] },
      });
      res.status(400).json({
        error: '匯入失敗',
        totalRows: parsed.totalRows,
        errors: parsed.errors ?? [],
      });
      return;
    }

    const duplicateBatch = await findImportBatchByContentHash(
      parsed.contentHash ?? '',
      'normal',
      req.adminUsername!,
    );
    if (duplicateBatch) {
      await writeAuditEvent({
        eventType: 'excel_import_duplicate_rejected',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: file.originalname, submission_type: 'normal', existingBatchId: duplicateBatch.id },
      });
      res.status(409).json({ error: '此檔案已匯入過（相同內容），避免重複寫入', batchId: duplicateBatch.id });
      return;
    }

    const ip = getClientIp(req);
    const items: CreateNormalSubmissionInput[] = parsed.rows!.map((r) => ({
      siteCode: r.siteCode,
      source: 'excel',
      fields: r.fields,
      ip,
      changeSource: 'admin_excel_import',
      actorRole: 'admin',
      actor: req.adminUsername!,
      shopName: '',
    }));
    let rows: WorkflowRow[];
    try {
      rows = await createNormalSubmissionBatch(items);
    } catch (err) {
      if (err instanceof WorkflowConfigurationError || err instanceof ActiveSubmissionConflictError || err instanceof CooldownActiveError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof Error && (err as Error & { field?: string }).field) {
        res.status(400).json({ error: err.message, field: (err as Error & { field?: string }).field });
        return;
      }
      throw err;
    }
    const rowsOut = rows.map((row, index) => ({
      row: parsed.rows![index]!.rowNumber,
      application_no: row.application_no,
      site_code: row.site_code,
      sku: row.sku,
      rp_type: row.rp_type ?? '',
      safety_stock: row.safety_stock ?? '',
      nd_code: row.nd_code ?? '',
      remark: row.remark ?? '',
      submitted_at: toHKString(row.submitted_at),
    }));
    const results = await withTransaction(async (client) => {
      const batchId = await createImportBatch(client, {
        filename: file.originalname,
        sheetName: parsed.sheetName ?? '',
        rowCount: parsed.totalRows,
        successCount: rowsOut.length,
        failedCount: 0,
        results: rowsOut,
        contentHash: parsed.contentHash ?? '',
        createdBy: req.adminUsername!,
        submissionType: 'normal',
      });
      return { batchId, rows: rowsOut, successCount: rowsOut.length };
    });

    await writeAuditEvent({
      eventType: 'excel_import',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip,
      metadata: {
        filename: file.originalname,
        batchId: results.batchId,
        totalRows: parsed.totalRows,
        successCount: results.successCount,
      },
    });

    res.status(201).json({
      message: `成功匯入 ${results.successCount} 行`,
      totalRows: parsed.totalRows,
      successCount: results.successCount,
      rows: results.rows,
    });
  }),
);

const optionalIsoDate = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().refine(isValidIsoDate, '日期必須為有效的 YYYY-MM-DD').optional(),
);

const exportFiltersSchema = z.object({
  from: optionalIsoDate,
  to: optionalIsoDate,
  site_code: z.string().trim().optional(),
  include_exported: z.coerce.boolean().optional().default(false),
  preview: z.coerce.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '由日期不可晚於至日期' });
  }
});

const EXPORT_DEFINITIONS: Record<ExportSubmissionType, ExportDefinition> = {
  normal: {
    submissionType: 'normal',
    filenamePrefix: 'NDRF_SAP',
    buildBuffer: (rows) => buildArchivedExportBuffer('normal', rows),
  },
  urgent: {
    submissionType: 'urgent',
    filenamePrefix: 'Urgent_Order',
    buildBuffer: (rows) => buildArchivedExportBuffer('urgent', rows),
  },
  sales: {
    submissionType: 'sales',
    filenamePrefix: 'Sudden_Sales',
    buildBuffer: (rows) => buildArchivedExportBuffer('sales', rows),
  },
  return: {
    submissionType: 'return',
    filenamePrefix: 'Return_Goods',
    buildBuffer: (rows) => buildArchivedExportBuffer('return', rows),
  },
};

/** POST /api/admin/export — SAP export + lock. */
adminRouter.post(
  '/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = exportFiltersSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '篩選條件無效' });
      return;
    }
    const definition = EXPORT_DEFINITIONS.normal;
    const filters = parsed.data as ExportFilters;
    const rows = await findExportRows(definition.submissionType, filters);
    if (rows.length === 0) {
      res.status(400).json({ error: '沒有符合條件的申報可以匯出' });
      return;
    }

    if (parsed.data.preview) {
      const buffer = await definition.buildBuffer(rows);
      const previewName = exportFilename(definition, true);
      await writeAuditEvent({
        eventType: 'export_preview',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: previewName, count: rows.length, filters: parsed.data, submission_type: 'normal' },
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${previewName}"`);
      res.send(buffer);
      return;
    }

    const filename = exportFilename(definition, false);
    const exportResult = await createLockedExport(
      definition,
      filters,
      req.adminUsername!,
      config.exportFileRetentionDays,
    );
    if (!exportResult) {
      res.status(400).json({ error: '沒有符合條件的申報可以匯出' });
      return;
    }
    const { batchId: batchResult, buffer } = exportResult;

    await writeAuditEvent({
      eventType: 'export_created',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batchId: batchResult, filename, count: exportResult.count },
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Batch-Id', batchResult);
    res.send(buffer);
  }),
);

/** GET /api/admin/urgent/template — download Urgent import template. */
adminRouter.get(
  '/urgent/template',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const buffer = await generateUrgentTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Urgent Order Template.xlsx"`);
    res.send(buffer);
  }),
);

/** POST /api/admin/urgent/import — batch Urgent Excel import. */
adminRouter.post(
  '/urgent/import',
  requireAdmin,
  excelImportLimiter,
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const file = getUploadedFile(req)!;
    const uploadError = validateUploadedXlsx(file, config.maxUploadBytes, EXCEL_UPLOAD_EXTENSION_ERROR);
    if (uploadError) {
      res.status(uploadError.status).json({ error: uploadError.message });
      return;
    }

    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));

    const parsed = await parseUrgentImportWorkbook(file.buffer, storeCodes, config.maxImportRows, { validateSku: false });
    if (!parsed.ok || !parsed.rows) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: file.originalname, submission_type: 'urgent', errors: parsed.errors ?? [] },
      });
      res.status(400).json({
        error: '匯入失敗',
        totalRows: parsed.totalRows,
        errors: parsed.errors ?? [],
      });
      return;
    }

    const duplicateBatch = await findImportBatchByContentHash(
      parsed.contentHash ?? '',
      'urgent',
      req.adminUsername!,
    );
    if (duplicateBatch) {
      await writeAuditEvent({
        eventType: 'excel_import_duplicate_rejected',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: file.originalname, submission_type: 'urgent', existingBatchId: duplicateBatch.id },
      });
      res.status(409).json({ error: '此檔案已匯入過（相同內容），避免重複寫入', batchId: duplicateBatch.id });
      return;
    }

    const ip = getClientIp(req);
    const applicationDate = hkTodayForDateColumn();
    const results = await withTransaction(async (client) => {
      const rowsOut: Array<{
        row: number;
        application_no: string;
        site_code: string;
        sku: string;
        qty: number;
        urgent_reason: string | null;
        urgent_reason_label: string;
        urgent_reason_other: string | null;
        submitted_at: string;
      }> = [];
      let successCount = 0;
      for (const r of parsed.rows!) {
        const appNo = generateApplicationNo('URGENT');
        const requestedByEmail = `${r.siteCode.toLowerCase()}@sasa.com`;
        const insert = await client.query<SubmissionRow>(
          `INSERT INTO submissions (
             application_no, source, submission_type, site_code, requested_by_email, application_date,
             brand, sku, qty, urgent_reason, urgent_reason_other, created_ip, created_ip_expires_at
           ) VALUES ($1,'excel','urgent',$2,$3,$4,
             '',$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [appNo, r.siteCode, requestedByEmail, applicationDate, r.sku, r.qty, r.urgentReason || null, r.urgentReasonOther || null, ip, ip ? ipExpiryIso() : null],
        );
        const row = insert.rows[0]!;
        await client.query(
          `INSERT INTO submission_versions
             (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
           VALUES ($1, 1, NULL, $2, 'admin', $3, $4, 'excel_import')`,
          [
            row.id,
            JSON.stringify({
              site_code: r.siteCode,
              sku: r.sku,
              qty: r.qty,
              urgent_reason: r.urgentReason || null,
              urgent_reason_other: r.urgentReasonOther || null,
            }),
            req.adminUsername,
            ip,
          ],
        );
        successCount++;
        rowsOut.push({
          row: r.rowNumber,
          application_no: row.application_no,
          site_code: row.site_code,
          sku: row.sku,
          qty: row.qty as number,
          urgent_reason: row.urgent_reason,
          urgent_reason_label: urgentReasonLabel(row.urgent_reason),
          urgent_reason_other: row.urgent_reason_other,
          submitted_at: toHKString(row.submitted_at),
        });
      }
      const batchId = await createImportBatch(client, {
        filename: file.originalname,
        sheetName: parsed.sheetName ?? '',
        rowCount: parsed.totalRows,
        successCount,
        failedCount: 0,
        results: rowsOut,
        contentHash: parsed.contentHash ?? '',
        createdBy: req.adminUsername!,
        submissionType: 'urgent',
      });
      return { batchId, rows: rowsOut, successCount };
    });

    await writeAuditEvent({
      eventType: 'excel_import',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip,
      metadata: {
        filename: file.originalname,
        submission_type: 'urgent',
        batchId: results.batchId,
        totalRows: parsed.totalRows,
        successCount: results.successCount,
      },
    });

    res.status(201).json({
      message: `成功匯入 ${results.successCount} 行`,
      totalRows: parsed.totalRows,
      successCount: results.successCount,
      rows: results.rows,
    });
  }),
);

/** POST /api/admin/urgent/export — Urgent export + lock. */
adminRouter.post(
  '/urgent/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = exportFiltersSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '篩選條件無效' });
      return;
    }
    const definition = EXPORT_DEFINITIONS.urgent;
    const filters = parsed.data as ExportFilters;
    const rows = await findExportRows(definition.submissionType, filters);
    if (rows.length === 0) {
      res.status(400).json({ error: '沒有符合條件的 Urgent Order 可以匯出' });
      return;
    }

    if (parsed.data.preview) {
      const buffer = await definition.buildBuffer(rows);
      const previewName = exportFilename(definition, true);
      await writeAuditEvent({
        eventType: 'export_preview',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: previewName, count: rows.length, filters: parsed.data, submission_type: 'urgent' },
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${previewName}"`);
      res.send(buffer);
      return;
    }

    const filename = exportFilename(definition, false);
    const exportResult = await createLockedExport(
      definition,
      filters,
      req.adminUsername!,
      config.exportFileRetentionDays,
    );
    if (!exportResult) {
      res.status(400).json({ error: '沒有符合條件的 Urgent Order 可以匯出' });
      return;
    }
    const { batchId: batchResult, buffer } = exportResult;

    await writeAuditEvent({
      eventType: 'export_created',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batchId: batchResult, filename, count: exportResult.count, submission_type: 'urgent' },
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Batch-Id', batchResult);
    res.send(buffer);
  }),
);

/** GET /api/admin/audit — export full audit report. */
adminRouter.get(
  '/audit',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const auditRows = await query<{
      application_no: string;
      version: number;
      actor_role: string;
      actor: string | null;
      ip: string | null;
      change_source: string;
      changed_at: string;
      data_before: unknown;
      data_after: unknown;
    }>(
      `SELECT s.application_no, v.version, v.actor_role, v.actor,
              CASE WHEN v.changed_at > now() - ($1::int * interval '1 day') THEN v.ip ELSE NULL END AS ip,
              v.change_source, v.changed_at,
              v.data_before, v.data_after,
              s.export_batch_id
       FROM submission_versions v
       JOIN submissions s ON s.id = v.submission_id
       ORDER BY v.changed_at ASC`,
      [config.ipRetentionDays],
    );
    const auditEvents = await query<{
      event_type: string;
      actor_role: string | null;
      actor: string | null;
      application_no: string | null;
      ip: string | null;
      metadata: unknown;
      created_at: string;
    }>(
      `SELECT event_type, actor_role, actor, application_no,
              CASE WHEN created_at > now() - ($1::int * interval '1 day') THEN ip ELSE NULL END AS ip,
              metadata, created_at
         FROM audit_events
        WHERE created_at > now() - ($1::int * interval '1 day')
        ORDER BY created_at ASC`,
      [config.auditRetentionDays],
    );
    const reviewEvents = await query<{
      application_no: string | null;
      event_type: string;
      actor_role: string;
      actor: string;
      review_round: number;
      reject_reason_label: string | null;
      reject_reason_note: string | null;
      remark: string | null;
      reason: string | null;
      ip: string | null;
      created_at: string;
    }>(
      `SELECT s.application_no, e.event_type, e.actor_role, e.actor, e.review_round,
              e.reject_reason_label, e.reject_reason_note, e.remark, e.reason,
              CASE WHEN e.created_at > now() - ($1::int * interval '1 day') THEN e.ip ELSE NULL END AS ip,
              e.created_at
         FROM ndrf_review_events e
         JOIN submissions s ON s.id = e.submission_id
        WHERE e.created_at > now() - ($1::int * interval '1 day')
        ORDER BY e.created_at ASC`,
      [config.ipRetentionDays],
    );
    const buffer = await buildAuditExportBuffer(auditRows.rows as never, auditEvents.rows, reviewEvents.rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="NDRF_Audit_Report_${toHKDateString(new Date())}.xlsx"`);
    res.send(buffer);
  }),
);

/** POST /api/admin/sales/export — sudden sales export + lock. */
adminRouter.post(
  '/sales/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = exportFiltersSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '篩選條件無效' });
      return;
    }
    const definition = EXPORT_DEFINITIONS.sales;
    const filters = parsed.data as ExportFilters;
    const rows = await findExportRows(definition.submissionType, filters);
    if (rows.length === 0) {
      res.status(400).json({ error: '沒有符合條件的突發性銷售申報可以匯出' });
      return;
    }

    if (parsed.data.preview) {
      const buffer = await definition.buildBuffer(rows);
      const previewName = exportFilename(definition, true);
      await writeAuditEvent({
        eventType: 'export_preview',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: previewName, count: rows.length, filters: parsed.data, submission_type: 'sales' },
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${previewName}"`);
      res.send(buffer);
      return;
    }

    const filename = exportFilename(definition, false);
    const exportResult = await createLockedExport(
      definition,
      filters,
      req.adminUsername!,
      config.exportFileRetentionDays,
    );
    if (!exportResult) {
      res.status(400).json({ error: '沒有符合條件的突發性銷售申報可以匯出' });
      return;
    }
    const { batchId: batchResult, buffer } = exportResult;

    await writeAuditEvent({
      eventType: 'export_created',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batchId: batchResult, filename, count: exportResult.count, submission_type: 'sales' },
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Batch-Id', batchResult);
    res.send(buffer);
  }),
);

/** POST /api/admin/return/export — return-goods Buyer export + lock. */
adminRouter.post(
  '/return/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = exportFiltersSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '篩選條件無效' });
      return;
    }
    const definition = EXPORT_DEFINITIONS.return;
    const filters = parsed.data as ExportFilters;
    const rows = await findExportRows(definition.submissionType, filters);
    if (!rows.length) {
      res.status(400).json({ error: '沒有符合條件的行貨退貨報數可以匯出' });
      return;
    }
    if (parsed.data.preview) {
      const buffer = await definition.buildBuffer(rows);
      const filename = exportFilename(definition, true);
      await writeAuditEvent({ eventType: 'export_preview', actorRole: 'admin', actor: req.adminUsername, ip: getClientIp(req), metadata: { filename, count: rows.length, filters: parsed.data, submission_type: 'return' } });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
      return;
    }
    const filename = exportFilename(definition, false);
    const exportResult = await createLockedExport(
      definition,
      filters,
      req.adminUsername!,
      config.exportFileRetentionDays,
    );
    if (!exportResult) {
      res.status(400).json({ error: '沒有符合條件的行貨退貨報數可以匯出' });
      return;
    }
    await writeAuditEvent({ eventType: 'export_created', actorRole: 'admin', actor: req.adminUsername, ip: getClientIp(req), metadata: { batchId: exportResult.batchId, filename, count: exportResult.count, submission_type: 'return' } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Batch-Id', exportResult.batchId);
    res.send(exportResult.buffer);
  }),
);

/** GET /api/admin/export-batches/:id/download — download an archived export. */
adminRouter.get(
  '/export-batches/:id/download',
  requireAdmin,
  requireCsrf,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsedId = z.string().uuid().safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: '匯出批次編號無效' });
      return;
    }

    const result = await query<{
      id: string;
      filename: string;
      submission_nos: unknown;
      filters: unknown;
      file_data: Buffer | null;
      content_type: string | null;
      expires_at: string | null;
      archive_exists: boolean;
    }>(
      `SELECT eb.id, eb.filename, eb.submission_nos, eb.filters,
              ebf.file_data, ebf.content_type, ebf.expires_at,
              (ebf.export_batch_id IS NOT NULL) AS archive_exists
         FROM export_batches eb
         LEFT JOIN export_batch_files ebf ON ebf.export_batch_id = eb.id
        WHERE eb.id = $1`,
      [parsedId.data],
    );
    const batch = result.rows[0];
    if (!batch) {
      res.status(404).json({ error: '找不到匯出批次' });
      return;
    }

    let buffer: Buffer;
    let regenerated = false;
    const expiresAt = batch.expires_at ? new Date(batch.expires_at).getTime() : null;
    if (batch.file_data && expiresAt !== null && expiresAt > Date.now()) {
      buffer = Buffer.from(batch.file_data);
    } else if (batch.archive_exists) {
      res.status(410).json({ error: '此匯出檔案已超過三個月保存期限' });
      return;
    } else {
      // Batches created before archive migration have metadata and locked rows,
      // so rebuild them without changing any submission data.
      const applicationNos = Array.isArray(batch.submission_nos)
        ? batch.submission_nos.filter((value): value is string => typeof value === 'string')
        : [];
      if (!applicationNos.length) {
        res.status(404).json({ error: '此舊匯出批次沒有可重建的申報資料' });
        return;
      }
      const rows = await query<SubmissionRow>(
        `SELECT * FROM submissions
          WHERE application_no = ANY($1::text[])
          ORDER BY application_date ASC, submitted_at ASC`,
        [applicationNos],
      );
      if (rows.rows.length !== applicationNos.length) {
        res.status(409).json({ error: '此舊匯出批次的申報資料不完整，無法重建 Excel' });
        return;
      }
      buffer = await buildArchivedExportBuffer(exportSubmissionType(batch.filters), rows.rows);
      regenerated = true;
    }

    await writeAuditEvent({
      eventType: 'export_download',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batchId: batch.id, filename: batch.filename, regenerated },
    });
    const safeFilename = batch.filename.replace(/["\r\n]/g, '_');
    res.setHeader('Content-Type', batch.content_type ?? EXPORT_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('X-Export-Batch-Id', batch.id);
    res.send(buffer);
  }),
);

/** GET /api/admin/batches — list import & export batches. */
adminRouter.get(
  '/batches',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const imports = await query(
      `SELECT id, filename, sheet_name, row_count, success_count, failed_count, created_by, submission_type, created_at
       FROM import_batches ORDER BY created_at DESC LIMIT 50`,
    );
    const exports = await query(
      `SELECT eb.id, eb.filename, eb.submission_count, eb.filters,
              eb.filters->>'submission_type' AS submission_type,
              eb.created_by, eb.created_at,
              (ebf.file_data IS NOT NULL AND ebf.expires_at > now()) AS archive_available,
              (ebf.export_batch_id IS NOT NULL AND (ebf.file_data IS NULL OR ebf.expires_at <= now())) AS archive_expired,
              ebf.file_size AS archive_file_size, ebf.expires_at AS archive_expires_at
         FROM export_batches eb
         LEFT JOIN export_batch_files ebf ON ebf.export_batch_id = eb.id
        ORDER BY eb.created_at DESC LIMIT 50`,
    );
    const archiveUsage = await query<{ bytes: string; files: string }>(
      `SELECT COALESCE(sum(file_size), 0)::text AS bytes, count(*)::text AS files
         FROM export_batch_files
        WHERE file_data IS NOT NULL`,
    );
    res.json({
      imports: imports.rows.map((r) => ({ ...r, created_at: toHKString(r.created_at as string) })),
      exports: exports.rows.map((r) => ({
        ...r,
        created_at: toHKString(r.created_at as string),
        archive_expires_at: r.archive_expires_at ? toHKString(r.archive_expires_at as string) : null,
        archive_file_size: r.archive_file_size === null || r.archive_file_size === undefined ? null : Number(r.archive_file_size),
      })),
      archive_usage: {
        bytes: Number(archiveUsage.rows[0]?.bytes ?? 0),
        files: Number(archiveUsage.rows[0]?.files ?? 0),
        retention_days: config.exportFileRetentionDays,
      },
    });
  }),
);

/** GET /api/admin/stores — list stores (for admin UI). */
adminRouter.get(
  '/stores',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const stores = await listStores(String(req.query.q ?? ''));
    res.json({ stores });
  }),
);

/** PUT /api/admin/stores — replace store master from CSV. */
adminRouter.put(
  '/stores',
  requireAdmin,
  adminActionLimiter,
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: '請上載門店主檔 CSV' });
      return;
    }
    if (!/\.csv$/i.test(file.originalname)) {
      res.status(400).json({ error: '只接受 .csv 檔案' });
      return;
    }
    if (file.size > config.maxUploadBytes) {
      res.status(413).json({ error: `檔案超過 ${config.maxUploadBytes / 1024 / 1024}MB 限制` });
      return;
    }
    const content = decodeStoresCsvBuffer(file.buffer);
    const parsed = parseStoresCsv(content);
    if (!parsed.ok || !parsed.stores) {
      res.status(400).json({ error: '門店主檔無效', errors: parsed.errors ?? [] });
      return;
    }
    const count = await replaceStores(parsed.stores);
    await writeAuditEvent({
      eventType: 'store_master_updated',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { filename: file.originalname, count },
    });
    res.json({ ok: true, count });
  }),
);

/** POST /api/admin/stores/sync-accounts — synchronise Store portal accounts with the store master. */
adminRouter.post(
  '/stores/sync-accounts',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await syncStorePortalAccounts(req.adminUsername!);
    await writeAuditEvent({
      eventType: 'store_accounts_synced',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        created: result.created.length,
        reactivated: result.reactivated.length,
        deactivated: result.deactivated.length,
        unchanged: result.unchanged,
      },
    });
    res.json(result);
  }),
);

/** GET /api/admin/portal/users — list portal accounts (includes admin-viewable initial passwords). */
adminRouter.get(
  '/portal/users',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query<{
      id: string;
      username: string;
      display_name: string;
      role: string;
      site_code: string | null;
      must_change_password: boolean;
      active: boolean;
      created_at: string;
      initial_password: string | null;
    }>(
      `SELECT id, username, display_name, role, site_code, must_change_password, active, created_at, initial_password
         FROM portal_users
        ORDER BY role, site_code, username`,
    );
    res.json({ users: result.rows.map((row) => ({ ...row, created_at: toHKString(row.created_at) })) });
  }),
);

const portalUserCreateSchema = z.object({
  username: z.string().trim().min(1).max(40),
  display_name: z.string().trim().max(200).optional().default(''),
  role: z.enum(['buyer', 'sct']),
});

/** POST /api/admin/portal/users — create a passwordless Buyer or SCT account. */
adminRouter.post(
  '/portal/users',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = portalUserCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '帳戶資料無效' });
      return;
    }
    try {
      const account = await createBuyerOrSctAccount({
        username: parsed.data.username,
        displayName: parsed.data.display_name,
        role: parsed.data.role,
        adminUsername: req.adminUsername!,
      });
      await writeAuditEvent({
        eventType: 'portal_user_created',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { username: account.username, role: parsed.data.role },
      });
      res.status(201).json({ ...account });
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code === '23505') {
        if ((err as { constraint?: string }).constraint === 'uq_portal_users_active_sct') {
          res.status(409).json({ error: '系統目前已有啟用中的 SCT 帳號，請先停用現有帳號' });
          return;
        }
        res.status(409).json({ error: '此使用者名稱已存在' });
        return;
      }
      throw err;
    }
  }),
);

const portalUserUpdateSchema = z.object({
  display_name: z.string().trim().max(200).optional(),
  active: z.boolean().optional(),
});

/** PUT /api/admin/portal/users/:id — update display name or activate/deactivate. */
adminRouter.put(
  '/portal/users/:id',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = portalUserUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '帳戶資料無效' });
      return;
    }
    const userId = req.params.id as string;
    const existing = await query<{ id: string; username: string; role: string; active: boolean }>(
      'SELECT id, username, role, active FROM portal_users WHERE id = $1',
      [userId],
    );
    const user = existing.rows[0];
    if (!user) {
      res.status(404).json({ error: '找不到帳戶' });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (parsed.data.display_name !== undefined) {
      sets.push(`display_name = $${idx++}`);
      params.push(parsed.data.display_name);
    }
    if (parsed.data.active !== undefined) {
      try {
        if (parsed.data.active === false && user.role === 'buyer') {
          await assertBuyerHasNoSkus(userId);
        }
        if (parsed.data.active === false && user.role === 'sct') {
          await assertSctHasNoPending(userId);
        }
      } catch (err) {
        if (err instanceof WorkflowConfigurationError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
      sets.push(`active = $${idx++}`);
      params.push(parsed.data.active);
    }
    if (sets.length === 0) {
      res.status(400).json({ error: '沒有需要更新的欄位' });
      return;
    }
    sets.push(`updated_at = now()`);
    params.push(userId);
    await query(`UPDATE portal_users SET ${sets.join(', ')} WHERE id = $${idx}`, params);
    if (parsed.data.active === false) {
      await query('DELETE FROM portal_sessions WHERE user_id = $1', [userId]);
    }
    await writeAuditEvent({
      eventType: 'portal_user_updated',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { username: user.username, changes: parsed.data },
    });
    res.json({ ok: true });
  }),
);

/** DELETE /api/admin/portal/users/:id — permanently delete an account. */
adminRouter.delete(
  '/portal/users/:id',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.id as string;
    const existing = await query<{ id: string; username: string; role: string }>(
      'SELECT id, username, role FROM portal_users WHERE id = $1',
      [userId],
    );
    const user = existing.rows[0];
    if (!user) {
      res.status(404).json({ error: '找不到帳戶' });
      return;
    }
    try {
      // Same safety guards as deactivation: a Buyer holding SKUs or an SCT
      // with pending reviews must be reassigned first (also protects the
      // sku_master foreign key). Store accounts have no FK constraints;
      // deleting one whose Site is still in the master means the next sync
      // will recreate it, so admins should remove the Site first if intended.
      if (user.role === 'buyer') {
        await assertBuyerHasNoSkus(userId);
      }
      if (user.role === 'sct') {
        await assertSctHasNoPending(userId);
      }
    } catch (err) {
      if (err instanceof WorkflowConfigurationError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    await query('DELETE FROM portal_users WHERE id = $1', [userId]);
    // Portal sessions cascade via FK; historical UUID references in
    // submissions / review events / import batches are retained as-is.
    await writeAuditEvent({
      eventType: 'portal_user_deleted',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { username: user.username, role: user.role },
    });
    res.json({ ok: true });
  }),
);

const portalUsersBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(['activate', 'deactivate', 'delete']),
});

/** POST /api/admin/portal/users/bulk — batch activate / deactivate / delete. */
adminRouter.post(
  '/portal/users/bulk',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = portalUsersBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '批量操作無效' });
      return;
    }
    const actionLabels = { activate: '啟用', deactivate: '停用', delete: '刪除' } as const;
    const results: Array<{ id: string; username?: string; ok: boolean; error?: string }> = [];
    for (const userId of new Set(parsed.data.ids)) {
      const existing = await query<{ id: string; username: string; role: string; active: boolean }>(
        'SELECT id, username, role, active FROM portal_users WHERE id = $1',
        [userId],
      );
      const user = existing.rows[0];
      if (!user) {
        results.push({ id: userId, ok: false, error: '找不到帳戶' });
        continue;
      }
      try {
        if (parsed.data.action === 'delete') {
          if (user.role === 'buyer') {
            await assertBuyerHasNoSkus(userId);
          }
          if (user.role === 'sct') {
            await assertSctHasNoPending(userId);
          }
          await query('DELETE FROM portal_users WHERE id = $1', [userId]);
        } else {
          const active = parsed.data.action === 'activate';
          if (!active) {
            if (user.role === 'buyer') {
              await assertBuyerHasNoSkus(userId);
            }
            if (user.role === 'sct') {
              await assertSctHasNoPending(userId);
            }
          }
          await query('UPDATE portal_users SET active = $1, updated_at = now() WHERE id = $2', [active, userId]);
          if (!active) {
            await query('DELETE FROM portal_sessions WHERE user_id = $1', [userId]);
          }
        }
        results.push({ id: userId, username: user.username, ok: true });
      } catch (err) {
        if (err instanceof WorkflowConfigurationError) {
          results.push({ id: userId, username: user.username, ok: false, error: err.message });
          continue;
        }
        throw err;
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    await writeAuditEvent({
      eventType: 'portal_user_updated',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        bulk_action: parsed.data.action,
        requested: parsed.data.ids.length,
        succeeded,
        failed: results.length - succeeded,
        failures: results.filter((r) => !r.ok).map((r) => ({ username: r.username ?? r.id, error: r.error })),
      },
    });
    res.json({
      ok: true,
      action: parsed.data.action,
      label: actionLabels[parsed.data.action],
      succeeded,
      failed: results.length - succeeded,
      results,
    });
  }),
);

/** GET /api/admin/sku-master — list current SKU Master and change batches. */
adminRouter.get(
  '/sku-master',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const [rows, batches] = await Promise.all([listSkuMaster(), listSkuMasterBatches()]);
    res.json({
      rows: rows.map((row) => ({ ...row, updated_at: toHKString(row.updated_at) })),
      batches: batches.map((batch) => ({ ...batch, created_at: toHKString(batch.created_at) })),
    });
  }),
);

function parseSkuMasterCsv(content: string): { ok: boolean; rows?: Array<{ sku: string; buyerUsername: string }>; errors?: string[] } {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return { ok: false, errors: ['CSV 沒有資料列'] };
  const header = lines[0]!.split(',').map((h) => h.trim().replace(/^"|"$/g, '').toUpperCase());
  const skuIdx = header.indexOf('SKU');
  const buyerIdx = header.findIndex((h) => h.includes('BUYER') || h === 'BUYER USERNAME' || h === 'BUYER_USERNAME' || h === 'USERNAME');
  if (skuIdx < 0 || buyerIdx < 0) {
    return { ok: false, errors: ['CSV 欄名必須包含 SKU 及 Buyer（Buyer Username）'] };
  }
  const errors: string[] = [];
  const rows: Array<{ sku: string; buyerUsername: string }> = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r]!.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
    if (!cells[skuIdx] && !cells[buyerIdx]) continue;
    const sku = cells[skuIdx] ?? '';
    const buyer = cells[buyerIdx] ?? '';
    if (!sku || !buyer) {
      errors.push(`列 ${r + 1}: SKU 及 Buyer 均為必填`);
      continue;
    }
    rows.push({ sku, buyerUsername: buyer });
  }
  if (errors.length) return { ok: false, errors };
  if (!rows.length) return { ok: false, errors: ['CSV 沒有有效資料列'] };
  return { ok: true, rows };
}

/** PUT /api/admin/sku-master — replace the whole SKU Master from CSV (validated, fail-closed). */
adminRouter.put(
  '/sku-master',
  requireAdmin,
  adminActionLimiter,
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: '請上載 SKU Master CSV' });
      return;
    }
    if (!/\.csv$/i.test(file.originalname)) {
      res.status(400).json({ error: '只接受 .csv 檔案' });
      return;
    }
    const content = new TextDecoder('utf-8', { fatal: false }).decode(file.buffer);
    const parsed = parseSkuMasterCsv(content);
    if (!parsed.ok || !parsed.rows) {
      res.status(400).json({ error: 'SKU Master 無效', errors: parsed.errors ?? [] });
      return;
    }
    try {
      const result = await replaceSkuMaster({
        rows: parsed.rows,
        adminUsername: req.adminUsername!,
      });
      await writeAuditEvent({
        eventType: 'sku_master_updated',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: file.originalname, count: result.count },
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof WorkflowConfigurationError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

/** GET /api/admin/store-routes — list designated store routing settings. */
adminRouter.get(
  '/store-routes',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query<{
      site_code: string;
      shop: string | null;
      sct_review_required: boolean;
      remark_required: boolean;
      updated_by: string;
      updated_at: string;
    }>(
      `SELECT r.site_code, st.shop, r.sct_review_required, r.remark_required, r.updated_by, r.updated_at
         FROM ndrf_store_routes r
         LEFT JOIN stores st ON st.site_code = r.site_code
        ORDER BY r.site_code`,
    );
    res.json({
      routes: result.rows.map((row) => ({ ...row, updated_at: toHKString(row.updated_at) })),
    });
  }),
);

const storeRouteSchema = z.object({
  site_code: z.string().trim().min(1).max(20),
  sct_review_required: z.boolean().optional(),
  remark_required: z.boolean().optional(),
});

/** PUT /api/admin/store-routes — upsert designated store routing settings. */
adminRouter.put(
  '/store-routes',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = storeRouteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '路由設定無效' });
      return;
    }
    const siteCode = normalizeSiteCode(parsed.data.site_code);
    const existing = await getStoreRouteConfig(siteCode);
    await query(
      `INSERT INTO ndrf_store_routes (site_code, sct_review_required, remark_required, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (site_code) DO UPDATE SET
         sct_review_required = COALESCE($2, ndrf_store_routes.sct_review_required),
         remark_required = COALESCE($3, ndrf_store_routes.remark_required),
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        siteCode,
        parsed.data.sct_review_required ?? false,
        parsed.data.remark_required ?? false,
        req.adminUsername,
      ],
    );
    await writeAuditEvent({
      eventType: 'store_routes_updated',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { site_code: siteCode, before: existing, after: parsed.data },
    });
    res.json({ ok: true });
  }),
);

/** DELETE /api/admin/store-routes/:siteCode — remove a designated store (new submissions revert to normal routing). */
adminRouter.delete(
  '/store-routes/:siteCode',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const siteCode = normalizeSiteCode(req.params.siteCode as string);
    if (!siteCode) {
      res.status(400).json({ error: 'Site Code 無效' });
      return;
    }
    const before = await getStoreRouteConfig(siteCode);
    const deleted = await query(
      'DELETE FROM ndrf_store_routes WHERE site_code = $1 RETURNING site_code',
      [siteCode],
    );
    if (deleted.rows.length === 0) {
      res.status(404).json({ error: `「${siteCode}」不是指定店` });
      return;
    }
    await writeAuditEvent({
      eventType: 'store_routes_updated',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { site_code: siteCode, action: 'delete', before },
    });
    res.json({ ok: true });
  }),
);


/** GET /api/admin/review-pending — Buyer pending ND review reminder (counts + SKU list). */
adminRouter.get(
  '/review-pending',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const data = await listPendingReviewSummary();
    res.json({
      ...data,
      buyers: data.buyers.map((buyer) => ({ ...buyer })),
      items: data.items.map((item) => ({
        ...item,
        submitted_at: toHKString(item.submitted_at),
      })),
      unassigned: data.unassigned.map((item) => ({
        ...item,
        submitted_at: toHKString(item.submitted_at),
      })),
    });
  }),
);

/** GET /api/admin/review-pending/export — downloadable Buyer reminder workbook. */
adminRouter.get(
  '/review-pending/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const data = await listPendingReviewSummary();
    const buffer = await buildReviewPendingBuffer(data);
    const stamp = toHKString(new Date()).replace(/[^0-9]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Buyer_Pending_Review_${stamp}.xlsx"`);
    res.send(buffer);
  }),
);

/** POST /api/admin/review-pending/auto-approve — run the Buyer SLA auto-approval now. */
adminRouter.post(
  '/review-pending/auto-approve',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!config.ndrfAutoApproveEnabled) {
      res.status(409).json({ error: 'Buyer SLA 自動批准已停用（NDRF_AUTO_APPROVE_ENABLED）' });
      return;
    }
    const result = await runBuyerAutoApproveJob();
    await writeAuditEvent({
      eventType: 'buyer_auto_approved',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { triggered: 'manual', ...result },
    });
    res.json({ ok: true, ...result });
  }),
);
const rejectionReasonSchema = z.object({
  code: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(300),
  sort_order: z.number().int().optional(),
  active: z.boolean().optional(),
});

/** GET /api/admin/rejection-reasons — list reject reason catalogue. */
adminRouter.get(
  '/rejection-reasons',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query<{
      code: string;
      label: string;
      sort_order: number;
      active: boolean;
      updated_by: string;
      updated_at: string;
    }>('SELECT code, label, sort_order, active, updated_by, updated_at FROM ndrf_rejection_reasons ORDER BY sort_order, code');
    res.json({ reasons: result.rows.map((row) => ({ ...row, updated_at: toHKString(row.updated_at) })) });
  }),
);

/** PUT /api/admin/rejection-reasons — upsert a reject reason category. */
adminRouter.put(
  '/rejection-reasons',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = rejectionReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '原因設定無效' });
      return;
    }
    const before = await query<{ code: string }>('SELECT code FROM ndrf_rejection_reasons WHERE code = $1', [parsed.data.code]);
    await query(
      `INSERT INTO ndrf_rejection_reasons (code, label, sort_order, active, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (code) DO UPDATE SET
         label = EXCLUDED.label,
         sort_order = EXCLUDED.sort_order,
         active = EXCLUDED.active,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        parsed.data.code,
        parsed.data.label,
        parsed.data.sort_order ?? 0,
        parsed.data.active ?? true,
        req.adminUsername,
      ],
    );
    await writeAuditEvent({
      eventType: 'rejection_reason_updated',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { code: parsed.data.code, created: before.rows.length === 0 },
    });
    res.json({ ok: true });
  }),
);

const overrideSchema = z.object({
  action: z.enum(['override_ready', 'override_accept', 'override_reject', 'reopen']),
  reason: z.string().trim().min(1).max(2000),
});

/** POST /api/admin/submissions/:id/override — workflow override/reopen with mandatory reason. */
adminRouter.post(
  '/submissions/:id/override',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Override 輸入無效' });
      return;
    }
    try {
      const row = await adminWorkflowOverride({
        adminUsername: req.adminUsername!,
        submissionId: req.params.id as string,
        action: parsed.data.action,
        reason: parsed.data.reason,
        ip: getClientIp(req),
      });
      await writeAuditEvent({
        eventType: 'workflow_override',
        actorRole: 'admin',
        actor: req.adminUsername,
        submissionId: row.id,
        applicationNo: row.application_no,
        ip: getClientIp(req),
        metadata: { action: parsed.data.action, reason: parsed.data.reason },
      });
      res.json({ submission: serializeAdminSubmission(row) });
    } catch (err) {
      if (err instanceof WorkflowLockedError || err instanceof ReviewDecisionError || err instanceof WorkflowConfigurationError || err instanceof ActiveSubmissionConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof SubmissionNotFoundError) {
        res.status(404).json({ error: '找不到申報' });
        return;
      }
      throw err;
    }
  }),
);

const recoveryCodeSchema = z.object({
  code: z.string().regex(/^[\x21-\x7E]{12,128}$/, 'Recovery Code 必須為 12 至 128 位可顯示 ASCII 字符（不含空格）'),
});

function resolveRecoveryScope(raw: unknown): string {
  const trimmed = String(raw ?? '').trim();
  if (trimmed.toLowerCase() === 'master') return MASTER_RECOVERY_OM;
  return trimmed;
}

/** GET /api/admin/recovery-codes — list configured recovery code scopes (master + per-OM) with plaintext codes. */
adminRouter.get(
  '/recovery-codes',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const [omRows, codeRows] = await Promise.all([
      query<{ om: string }>(`SELECT DISTINCT om FROM stores WHERE om <> '' ORDER BY om`),
      query<{ om: string; code: string | null; updated_by: string; updated_at: string }>(
        'SELECT om, code, updated_by, updated_at FROM om_recovery_codes WHERE om <> $1 ORDER BY om',
        [MASTER_RECOVERY_OM],
      ),
    ]);
    const masterRows = await query<{ code: string | null; updated_by: string; updated_at: string }>(
      'SELECT code, updated_by, updated_at FROM om_recovery_codes WHERE om = $1',
      [MASTER_RECOVERY_OM],
    );

    const codes = new Map(codeRows.rows.map((row) => [row.om, row]));
    const scopes = new Set(omRows.rows.map((r) => r.om));
    codeRows.rows.forEach((row) => scopes.add(row.om));

    const masterRow = masterRows.rows[0];
    res.json({
      master: {
        set: Boolean(masterRow),
        code: masterRow?.code ?? null,
        updated_at: masterRow ? toHKString(masterRow.updated_at) : null,
        updated_by: masterRow?.updated_by ?? null,
      },
      om_codes: [...scopes]
        .sort()
        .map((om) => {
          const row = codes.get(om);
          return {
            om,
            set: Boolean(row),
            code: row?.code ?? null,
            updated_at: row ? toHKString(row.updated_at) : null,
            updated_by: row?.updated_by ?? null,
          };
        }),
    });
  }),
);

/** PUT /api/admin/recovery-codes/:scope — set or rotate the recovery code for an OM group or 'master'. */
adminRouter.put(
  '/recovery-codes/:scope',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = recoveryCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Recovery Code 無效' });
      return;
    }
    const scope = resolveRecoveryScope(req.params.scope);
    if (!scope || scope.length > 64) {
      res.status(400).json({ error: '範圍（OM / master）為必填且不可超過 64 字符' });
      return;
    }
    await setRecoveryCode(scope, parsed.data.code, req.adminUsername ?? 'admin');
    await writeAuditEvent({
      eventType: 'recovery_code_set',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { scope, chars: parsed.data.code.length },
    });
    res.json({ ok: true, scope });
  }),
);

/** DELETE /api/admin/recovery-codes/:scope — remove the recovery code for an OM group or 'master'. */
adminRouter.delete(
  '/recovery-codes/:scope',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const scope = resolveRecoveryScope(req.params.scope);
    if (!scope || scope.length > 64) {
      res.status(400).json({ error: '範圍（OM / master）為必填且不可超過 64 字符' });
      return;
    }
    const removed = await deleteRecoveryCode(scope);
    if (!removed) {
      res.status(404).json({ error: '該範圍未有設定 Recovery Code' });
      return;
    }
    await writeAuditEvent({
      eventType: 'recovery_code_deleted',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { scope },
    });
    res.json({ ok: true, scope });
  }),
);

// ---------------------------------------------------------------------------
// 90日零銷售 SKU 店舖回覆 (Admin 派發 / 跟進)
// ---------------------------------------------------------------------------

/** GET /api/admin/zero-sales/template — 下載上載模板 */
adminRouter.get(
  '/zero-sales/template',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const buffer = await generateZeroSalesTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Zero_Sales_Template.xlsx"');
    res.send(buffer);
  }),
);

/** GET /api/admin/zero-sales/batches — 批次列表 (含回覆進度) */
adminRouter.get(
  '/zero-sales/batches',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ batches: await listZeroSalesBatches() });
  }),
);

/** GET /api/admin/zero-sales/summary — 跨批次統計 (總覽卡 + 原因分佈 + 待回覆店舖) */
adminRouter.get(
  '/zero-sales/summary',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { batch_id } = req.query as Record<string, string | undefined>;
    const trimmed = batch_id?.trim();
    if (trimmed && !/^[0-9a-fA-F-]{36}$/.test(trimmed)) {
      res.status(400).json({ error: '批次編號無效' });
      return;
    }
    res.json(await getZeroSalesSummaryStats(trimmed || undefined));
  }),
);

/** GET /api/admin/zero-sales/repeats — 重複上榜 SKU 統計（同店同 SKU 跨批次 ≥2 次，按次數倒序） */
adminRouter.get(
  '/zero-sales/repeats',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { site_code, q, min_count, limit } = req.query as Record<string, string | undefined>;
    const siteCode = site_code?.trim() ? normalizeSiteCode(site_code) : undefined;
    const keyword = q?.trim().slice(0, 100) || undefined;
    const minCount = min_count === undefined || min_count === '' ? 2 : Number(min_count);
    const lim = limit === undefined || limit === '' ? 200 : Number(limit);
    if (!Number.isInteger(minCount) || minCount < 2 || minCount > 20) {
      res.status(400).json({ error: 'min_count 須為 2 至 20 的整數' });
      return;
    }
    if (!Number.isInteger(lim) || lim < 1 || lim > 500) {
      res.status(400).json({ error: 'limit 須為 1 至 500 的整數' });
      return;
    }
    const repeats = await listZeroSalesRepeats({ siteCode, q: keyword, minCount, limit: lim });
    res.json({ repeats });
  }),
);

/** GET /api/admin/zero-sales/export — 統一匯出 (可按 batch_id / site_code / status / reason_code 篩選) */
adminRouter.get(
  '/zero-sales/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { batch_id, site_code, status, reason_code } = req.query as Record<string, string | undefined>;
    const batchId = batch_id?.trim() || undefined;
    if (batchId && !/^[0-9a-fA-F-]{36}$/.test(batchId)) {
      res.status(400).json({ error: '批次編號無效' });
      return;
    }
    if (status && status !== 'pending' && status !== 'replied') {
      res.status(400).json({ error: '狀態篩選無效' });
      return;
    }
    const siteCode = site_code?.trim() ? normalizeSiteCode(site_code) : undefined;
    const reasonCode = reason_code?.trim() || undefined;
    const items = await listZeroSalesForExport({
      batchId,
      siteCode,
      status: status === 'pending' || status === 'replied' ? status : undefined,
      reasonCode,
    });
    if (!items.length) {
      res.status(404).json({ error: '沒有符合條件的零銷售資料可以匯出' });
      return;
    }
    const buffer = await buildZeroSalesExportBuffer(items.map((i) => ({
      site_code: i.site_code,
      sku: i.sku,
      payload: i.payload,
      status: i.status,
      reason_code: i.reason_code,
      reason_label: i.reason_label,
      reason_note: i.reason_note,
      replied_at: i.replied_at,
      replied_by: i.replied_by,
      batch_label: i.week_label ?? '',
      reply_count: i.reply_count ?? (i.status === 'replied' ? 1 : 0),
    })));
    const stamp = toHKDateString(new Date()).replace(/-/g, '');
    const label = (items[0]?.week_label ?? 'all').replace(/[^\w\-]+/g, '_');
    await writeAuditEvent({
      eventType: 'zero_sales_export',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batch_id: batchId ?? null, site_code: siteCode ?? null, status: status ?? null, reason_code: reasonCode ?? null, count: items.length },
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Zero_Sales_${label}_${stamp}.xlsx"`);
    res.send(buffer);
  }),
);

const zeroSalesUploadSchema = z.object({
  week_label: z.string().trim().min(1, '週次為必填').max(60),
  note: z.string().max(1000).optional().default(''),
});

/** POST /api/admin/zero-sales/batches — 上載 Excel 開新一週批次 */
adminRouter.post(
  '/zero-sales/batches',
  requireAdmin,
  excelImportLimiter,
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const file = getUploadedFile(req)!;
    const uploadError = validateUploadedXlsx(file, config.maxUploadBytes, EXCEL_UPLOAD_EXTENSION_ERROR);
    if (uploadError) {
      res.status(uploadError.status).json({ error: uploadError.message });
      return;
    }
    const meta = zeroSalesUploadSchema.safeParse(req.body);
    if (!meta.success) {
      res.status(400).json({ error: meta.error.issues[0]?.message ?? '週次無效' });
      return;
    }
    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));
    const parsed = await parseZeroSalesWorkbook(file.buffer, storeCodes, config.maxImportRows);
    if (!parsed.ok || !parsed.rows) {
      await writeAuditEvent({
        eventType: 'zero_sales_import_error',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: file.originalname, errors: parsed.errors ?? [] },
      });
      res.status(400).json({ error: '匯入失敗', totalRows: parsed.totalRows, errors: parsed.errors ?? [] });
      return;
    }
    const { batchId } = await createZeroSalesBatch({
      weekLabel: meta.data.week_label,
      note: meta.data.note ?? '',
      rows: parsed.rows.map((r) => ({ siteCode: r.siteCode, sku: r.sku, data: r.data })),
      contentHash: parsed.contentHash ?? '',
      createdBy: req.adminUsername!,
    });
    await writeAuditEvent({
      eventType: 'zero_sales_batch_created',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { filename: file.originalname, week_label: meta.data.week_label, batchId, totalRows: parsed.totalRows },
    });
    res.status(201).json({ ok: true, batchId, totalRows: parsed.totalRows });
  }),
);

/** GET /api/admin/zero-sales/batches/:id/items — 批次明細 (可按 site_code / status 篩選) */
adminRouter.get(
  '/zero-sales/batches/:id/items',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { site_code, status } = req.query as Record<string, string | undefined>;
    const items = await listZeroSalesBatchItems(req.params.id as string, {
      siteCode: site_code?.trim() ? normalizeSiteCode(site_code) : undefined,
      status: status === 'pending' || status === 'replied' ? status : undefined,
    });
    res.json({ items });
  }),
);

/** GET /api/admin/zero-sales/batches/:id/export — 匯出批次 (原文 + 店舖回覆) */
adminRouter.get(
  '/zero-sales/batches/:id/export',
  requireUuidParam('id'),
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const items = await listZeroSalesBatchItems(req.params.id as string, {});
    if (!items.length) {
      res.status(404).json({ error: '此批次沒有資料' });
      return;
    }
    const buffer = await buildZeroSalesExportBuffer(items.map((i) => ({
      site_code: i.site_code,
      sku: i.sku,
      payload: i.payload,
      status: i.status,
      reason_code: i.reason_code,
      reason_label: i.reason_label,
      reason_note: i.reason_note,
      replied_at: i.replied_at,
      replied_by: i.replied_by,
      batch_label: i.week_label ?? '',
      reply_count: i.reply_count ?? (i.status === 'replied' ? 1 : 0),
    })));
    const label = (items[0]?.week_label ?? 'batch').replace(/[^\w\-]+/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Zero_Sales_${label}.xlsx"`);
    res.send(buffer);
  }),
);

/** DELETE /api/admin/zero-sales/batches/:id — 刪除整個批次（含全部行，上載錯誤時用；已回覆紀錄一併清除） */
adminRouter.delete(
  '/zero-sales/batches/:id',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const batchId = req.params.id as string;
    const result = await deleteZeroSalesBatch(batchId);
    if (!result) {
      res.status(404).json({ error: '找不到此批次' });
      return;
    }
    await writeAuditEvent({
      eventType: 'zero_sales_deleted',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { scope: 'batch', batch_id: batchId, week_label: result.weekLabel, deleted_items: result.deletedItems },
    });
    res.json({ ok: true, deleted_items: result.deletedItems });
  }),
);

/** DELETE /api/admin/zero-sales/batches/:id/sites/:siteCode — 刪除某批次內某店舖的全部行 */
adminRouter.delete(
  '/zero-sales/batches/:id/sites/:siteCode',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const batchId = req.params.id as string;
    const siteCode = normalizeSiteCode(req.params.siteCode as string);
    if (!siteCode) {
      res.status(400).json({ error: 'Site Code 無效' });
      return;
    }
    const result = await deleteZeroSalesBatchSite(batchId, siteCode);
    if (!result) {
      res.status(404).json({ error: '找不到此批次' });
      return;
    }
    if (!result.deletedItems) {
      res.status(404).json({ error: `此批次沒有「${siteCode}」的資料` });
      return;
    }
    await writeAuditEvent({
      eventType: 'zero_sales_deleted',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { scope: 'batch_site', batch_id: batchId, site_code: siteCode, deleted_items: result.deletedItems },
    });
    res.json({ ok: true, deleted_items: result.deletedItems });
  }),
);

/** DELETE /api/admin/zero-sales/batches/:id/items/:itemId — 刪除某批次內單一 SKU 行 */
adminRouter.delete(
  '/zero-sales/batches/:id/items/:itemId',
  requireUuidParam('id', 'itemId'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const batchId = req.params.id as string;
    const itemId = req.params.itemId as string;
    const result = await deleteZeroSalesItem(batchId, itemId);
    if (!result) {
      res.status(404).json({ error: '找不到此 SKU 行（可能已被刪除）' });
      return;
    }
    await writeAuditEvent({
      eventType: 'zero_sales_deleted',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { scope: 'batch_item', batch_id: batchId, item_id: itemId, site_code: result.siteCode, sku: result.sku },
    });
    res.json({ ok: true });
  }),
);

const zeroSalesAdminReplySchema = z.object({
  reason_code: z.string().trim().min(1, '請選擇回覆原因'),
  reason_note: z.string().max(2000).optional().default(''),
});

/** PUT /api/admin/zero-sales/batches/:id/items/:itemId/reply — 管理員代改店舖回覆（不受鎖定限制，不佔用店舖修改次數） */
adminRouter.put(
  '/zero-sales/batches/:id/items/:itemId/reply',
  requireUuidParam('id', 'itemId'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = zeroSalesAdminReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '回覆資料無效' });
      return;
    }
    try {
      const { before, item } = await adminReplyItem({
        batchId: req.params.id as string,
        itemId: req.params.itemId as string,
        reasonCode: parsed.data.reason_code,
        reasonNote: parsed.data.reason_note ?? '',
      });
      await writeAuditEvent({
        eventType: 'zero_sales_reply_edited',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: {
          item_id: item.id,
          batch_id: item.batch_id,
          site_code: item.site_code,
          sku: item.sku,
          before: { reason_code: before.reason_code, reason_note: before.reason_note },
          after: { reason_code: item.reason_code, reason_note: item.reason_note },
        },
      });
      res.json({ ok: true, item });
    } catch (err) {
      if (err instanceof ZeroSalesReplyError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

/** GET /api/admin/zero-sales/reasons — 原因選項 */
adminRouter.get(
  '/zero-sales/reasons',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ reasons: await listZeroSalesReasons(false) });
  }),
);

const zeroSalesReasonSchema = z.object({
  code: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(300),
  sort_order: z.number().int().optional(),
  active: z.boolean().optional(),
  require_note: z.boolean().optional(),
});

/** PUT /api/admin/zero-sales/reasons — 新增/更新原因 */
adminRouter.put(
  '/zero-sales/reasons',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = zeroSalesReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '原因設定無效' });
      return;
    }
    await query(
      `INSERT INTO zero_sales_reasons (code, label, sort_order, active, require_note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
         active = EXCLUDED.active, require_note = EXCLUDED.require_note,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [parsed.data.code, parsed.data.label, parsed.data.sort_order ?? 0, parsed.data.active ?? true, parsed.data.require_note ?? false, req.adminUsername],
    );
    await writeAuditEvent({ eventType: 'zero_sales_reason_updated', actorRole: 'admin', actor: req.adminUsername, ip: getClientIp(req), metadata: { code: parsed.data.code } });
    res.json({ ok: true });
  }),
);
