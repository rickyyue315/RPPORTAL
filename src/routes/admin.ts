import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
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
  createSingleStoreAccount,
  StoreAccountError,
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
import { toHKString, toHKDateString, hkTodayForDateColumn, monthsBeforeDateOnly } from '../lib/time.js';
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
  buildZeroSalesRepeatExportBuffer,
  buildZeroSalesBuyerFollowupExportBuffer,
  generateZeroSalesTemplateWorkbook,
  parseZeroSalesWorkbook,
} from '../lib/zeroSales.js';
import {
  createBatch as createZeroSalesBatch,
  getZeroSalesSummary as getZeroSalesSummaryStats,
  listBatchesPage as listZeroSalesBatchesPage,
  listBatchOptions as listZeroSalesBatchOptions,
  listBatchItems as listZeroSalesBatchItems,
  listItemsForExport as listZeroSalesForExport,
  listReasons as listZeroSalesReasons,
  listZeroSalesRepeats,
  listZeroSalesRepeatSkus,
  listZeroSalesBuyerFollowup,
  listZeroSalesPendingStores,
  deleteZeroSalesBatch,
  deleteZeroSalesBatchSite,
  deleteZeroSalesItem,
  adminReplyItem,
  autoFillZeroSalesReplies,
  closeZeroSalesBatch,
  reopenZeroSalesBatch,
  ZeroSalesReplyError,
} from '../services/zeroSales.js';
import {
  deleteShopStockBatch,
  getShopStockSummary,
  getShopStockWeek,
  listShopStockBatches,
  updateShopStockBatch,
  upsertShopStockBatch,
  SHOP_STOCK_REPORT_KINDS,
  ShopStockDateConflictError,
  ShopStockImportError,
  type ShopStockWeek,
} from '../services/shopStock.js';
import {
  buildShopStockRfBuffer,
  buildShopStockTrendBuffer,
  buildShopStockWeekBuffer,
  filterAndSortWeekRows,
  normalizeWeekExportFilters,
} from '../services/shopStockExport.js';
import {
  buildDesignatedSkuExportBuffer,
  generateDesignatedSkuTemplateWorkbook,
  parseDesignatedSkuWorkbook,
} from '../lib/designatedSku.js';
import {
  addItem as addDesignatedSkuItem,
  adminSubmitMatterReply as adminSubmitDesignatedSkuReply,
  closeBatch as closeDesignatedSkuBatch,
  createBatch as createDesignatedSkuBatch,
  deleteBatch as deleteDesignatedSkuBatch,
  deleteItem as deleteDesignatedSkuItem,
  deleteMatter as deleteDesignatedSkuMatter,
  DesignatedSkuError,
  DesignatedSkuNotFoundError,
  findBatchByContentHash as findDesignatedSkuBatchByHash,
  getBatch as getDesignatedSkuBatch,
  getSummary as getDesignatedSkuSummary,
  listBatchesForSelect as listDesignatedSkuBatchOptions,
  listBatchesPage as listDesignatedSkuBatchesPage,
  listBatchMatters as listDesignatedSkuBatchMatters,
  listMattersForExport as listDesignatedSkuForExport,
  reopenBatch as reopenDesignatedSkuBatch,
  updateBatch as updateDesignatedSkuBatch,
  updateItem as updateDesignatedSkuItem,
  type DesignatedSkuMatter,
} from '../services/designatedSku.js';

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

/** Shared page/page_size clamp for admin list endpoints. */
function parsePagination(req: Request, defaultSize = 20): { page: number; size: number; offset: number } {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.page_size) || defaultSize));
  return { page, size, offset: (page - 1) * size };
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
  asyncHandler(async (req: Request, res: Response) => {
    const { page, size, offset } = parsePagination(req);
    const imports = await query(
      `SELECT id, filename, sheet_name, row_count, success_count, failed_count, created_by, submission_type, created_at
       FROM import_batches ORDER BY created_at DESC LIMIT 50`,
    );
    const exportCount = await query<{ count: string }>('SELECT count(*)::text AS count FROM export_batches');
    const exportsTotal = Number(exportCount.rows[0]?.count ?? 0);
    const exports = await query(
      `SELECT eb.id, eb.filename, eb.submission_count, eb.filters,
              eb.filters->>'submission_type' AS submission_type,
              eb.created_by, eb.created_at,
              (ebf.file_data IS NOT NULL AND ebf.expires_at > now()) AS archive_available,
              (ebf.export_batch_id IS NOT NULL AND (ebf.file_data IS NULL OR ebf.expires_at <= now())) AS archive_expired,
              ebf.file_size AS archive_file_size, ebf.expires_at AS archive_expires_at
         FROM export_batches eb
         LEFT JOIN export_batch_files ebf ON ebf.export_batch_id = eb.id
        ORDER BY eb.created_at DESC, eb.id DESC LIMIT $1 OFFSET $2`,
      [size, offset],
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
      exports_total: exportsTotal,
      exports_page: page,
      exports_page_size: size,
      exports_total_pages: Math.ceil(exportsTotal / size),
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
  asyncHandler(async (req: Request, res: Response) => {
    const { page, size, offset } = parsePagination(req);
    const countResult = await query<{ count: string }>('SELECT count(*)::text AS count FROM portal_users');
    const total = Number(countResult.rows[0]?.count ?? 0);
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
        ORDER BY role, site_code, username
        LIMIT $1 OFFSET $2`,
      [size, offset],
    );
    res.json({
      users: result.rows.map((row) => ({ ...row, created_at: toHKString(row.created_at) })),
      total,
      page,
      page_size: size,
      total_pages: Math.ceil(total / size),
    });
  }),
);

const portalUserCreateSchema = z.object({
  username: z.string().trim().max(40).optional().default(''),
  display_name: z.string().trim().max(200).optional().default(''),
  role: z.enum(['buyer', 'sct', 'store']),
  site_code: z.string().trim().max(20).optional().default(''),
});

/** POST /api/admin/portal/users — create Buyer / SCT, or a single Store (from store master). All log in with the shared portal password; no password is stored or returned. */
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
      if (parsed.data.role === 'store') {
        const siteCode = (parsed.data.site_code || parsed.data.username).trim().toUpperCase();
        if (!siteCode) {
          res.status(400).json({ error: '請選擇店舖' });
          return;
        }
        const account = await createSingleStoreAccount({
          siteCode,
          adminUsername: req.adminUsername!,
        });
        await writeAuditEvent({
          eventType: 'portal_user_created',
          actorRole: 'admin',
          actor: req.adminUsername,
          ip: getClientIp(req),
          metadata: { username: account.username, role: 'store', site_code: account.site_code, reactivated: account.reactivated },
        });
        res.status(201).json({ ...account });
        return;
      }
      if (!parsed.data.username) {
        res.status(400).json({ error: '請輸入使用者名稱' });
        return;
      }
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
      if (err instanceof StoreAccountError) {
        res.status(400).json({ error: err.message });
        return;
      }
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
  asyncHandler(async (req: Request, res: Response) => {
    const { page, size } = parsePagination(req);
    const [pageData, batchOptions] = await Promise.all([
      listZeroSalesBatchesPage({ page, pageSize: size }),
      listZeroSalesBatchOptions(),
    ]);
    res.json({
      batches: pageData.batches,
      batch_options: batchOptions,
      total: pageData.total,
      page,
      page_size: size,
      total_pages: Math.ceil(pageData.total / size),
    });
  }),
);

/** GET /api/admin/zero-sales/summary — 統計 (總覽卡 + 原因分佈 + 待回覆店舖)；不帶 batch_id 為跨批次，帶 batch_id 只統計該批次 */
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

/** GET /api/admin/zero-sales/pending-stores — 某 OM 待回覆店舖名單（OM 下鑽用）；不帶 om 為全部 OM，只回傳仍有 pending 的店 */
adminRouter.get(
  '/zero-sales/pending-stores',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { batch_id, om } = req.query as Record<string, string | undefined>;
    const batchId = batch_id?.trim() || undefined;
    if (batchId && !/^[0-9a-fA-F-]{36}$/.test(batchId)) {
      res.status(400).json({ error: '批次編號無效' });
      return;
    }
    const omFilter = om?.trim().slice(0, 100) || undefined;
    res.json({ stores: await listZeroSalesPendingStores({ batchId, om: omFilter }) });
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

/** GET /api/admin/zero-sales/repeats/export — 匯出各店重複明細（同店同 SKU 跨批次 ≥ minCount，最多 5000 行） */
adminRouter.get(
  '/zero-sales/repeats/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { site_code, q, min_count } = req.query as Record<string, string | undefined>;
    const siteCode = site_code?.trim() ? normalizeSiteCode(site_code) : undefined;
    const keyword = q?.trim().slice(0, 100) || undefined;
    const minCount = min_count === undefined || min_count === '' ? 2 : Number(min_count);
    if (!Number.isInteger(minCount) || minCount < 2 || minCount > 20) {
      res.status(400).json({ error: 'min_count 須為 2 至 20 的整數' });
      return;
    }
    const repeats = await listZeroSalesRepeats({ siteCode, q: keyword, minCount, limit: 5000 });
    if (!repeats.length) {
      res.status(404).json({ error: '沒有符合條件的重複上榜資料可以匯出' });
      return;
    }
    const buffer = await buildZeroSalesRepeatExportBuffer({
      pairs: repeats,
      meta: { minCount, q: keyword, siteCode, generatedAt: toHKString(new Date()) },
    });
    const stamp = toHKDateString(new Date()).replace(/-/g, '');
    await writeAuditEvent({
      eventType: 'zero_sales_repeat_detail_export',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { site_code: siteCode ?? null, q: keyword ?? null, min_count: minCount, count: repeats.length },
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Zero_Sales_Repeat_Detail_${stamp}.xlsx"`);
    res.send(buffer);
  }),
);

/** GET /api/admin/zero-sales/repeat-skus — 跨店重複上榜 SKU 排行（同一 SKU 在多間店舖重複上榜，按重複店數倒序） */
adminRouter.get(
  '/zero-sales/repeat-skus',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { site_code, q, min_count, limit } = req.query as Record<string, string | undefined>;
    const siteCode = site_code?.trim() ? normalizeSiteCode(site_code) : undefined;
    const keyword = q?.trim().slice(0, 100) || undefined;
    const minCount = min_count === undefined || min_count === '' ? 2 : Number(min_count);
    const lim = limit === undefined || limit === '' ? 10 : Number(limit);
    if (!Number.isInteger(minCount) || minCount < 2 || minCount > 20) {
      res.status(400).json({ error: 'min_count 須為 2 至 20 的整數' });
      return;
    }
    if (!Number.isInteger(lim) || lim < 1 || lim > 100) {
      res.status(400).json({ error: 'limit 須為 1 至 100 的整數' });
      return;
    }
    const skus = await listZeroSalesRepeatSkus({ siteCode, q: keyword, minCount, limit: lim });
    res.json({ skus });
  }),
);

/** GET /api/admin/zero-sales/repeat-skus/export — 匯出跨店重複 SKU 排行（按重複店數倒序） */
adminRouter.get(
  '/zero-sales/repeat-skus/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { q, min_count, limit } = req.query as Record<string, string | undefined>;
    const keyword = q?.trim().slice(0, 100) || undefined;
    const minCount = min_count === undefined || min_count === '' ? 2 : Number(min_count);
    const lim = limit === undefined || limit === '' ? 10 : Number(limit);
    if (!Number.isInteger(minCount) || minCount < 2 || minCount > 20) {
      res.status(400).json({ error: 'min_count 須為 2 至 20 的整數' });
      return;
    }
    if (!Number.isInteger(lim) || lim < 1 || lim > 100) {
      res.status(400).json({ error: 'limit 須為 1 至 100 的整數' });
      return;
    }
    const skus = await listZeroSalesRepeatSkus({ q: keyword, minCount, limit: lim });
    if (!skus.length) {
      res.status(404).json({ error: '沒有符合條件的重複上榜 SKU 可以匯出' });
      return;
    }
    const buffer = await buildZeroSalesRepeatExportBuffer({
      skus,
      meta: { minCount, q: keyword, generatedAt: toHKString(new Date()) },
    });
    const stamp = toHKDateString(new Date()).replace(/-/g, '');
    await writeAuditEvent({
      eventType: 'zero_sales_repeat_sku_export',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { q: keyword ?? null, min_count: minCount, limit: lim, count: skus.length },
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Zero_Sales_Repeat_SKU_${stamp}.xlsx"`);
    res.send(buffer);
  }),
);

/** GET /api/admin/zero-sales/buyer-followup — Buyer 跟進一頁 JSON（跨店重複 SKU + 庫存 + Top 原因 + 店舖清單） */
adminRouter.get(
  '/zero-sales/buyer-followup',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { q, buyer, min_count, limit } = req.query as Record<string, string | undefined>;
    const keyword = q?.trim().slice(0, 100) || undefined;
    const buyerQ = buyer?.trim().slice(0, 100) || undefined;
    const minCount = min_count === undefined || min_count === '' ? 2 : Number(min_count);
    const lim = limit === undefined || limit === '' ? 50 : Number(limit);
    if (!Number.isInteger(minCount) || minCount < 2 || minCount > 20) {
      res.status(400).json({ error: 'min_count 須為 2 至 20 的整數' });
      return;
    }
    if (!Number.isInteger(lim) || lim < 1 || lim > 100) {
      res.status(400).json({ error: 'limit 須為 1 至 100 的整數' });
      return;
    }
    const rows = await listZeroSalesBuyerFollowup({ q: keyword, buyer: buyerQ, minCount, limit: lim });
    res.json({ rows });
  }),
);

/** GET /api/admin/zero-sales/buyer-followup/export — 匯出 Buyer 跟進一頁（單一工作表，重點標色） */
adminRouter.get(
  '/zero-sales/buyer-followup/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { q, buyer, min_count, limit } = req.query as Record<string, string | undefined>;
    const keyword = q?.trim().slice(0, 100) || undefined;
    const buyerQ = buyer?.trim().slice(0, 100) || undefined;
    const minCount = min_count === undefined || min_count === '' ? 2 : Number(min_count);
    const lim = limit === undefined || limit === '' ? 50 : Number(limit);
    if (!Number.isInteger(minCount) || minCount < 2 || minCount > 20) {
      res.status(400).json({ error: 'min_count 須為 2 至 20 的整數' });
      return;
    }
    if (!Number.isInteger(lim) || lim < 1 || lim > 100) {
      res.status(400).json({ error: 'limit 須為 1 至 100 的整數' });
      return;
    }
    const rows = await listZeroSalesBuyerFollowup({ q: keyword, buyer: buyerQ, minCount, limit: lim });
    if (!rows.length) {
      res.status(404).json({ error: '沒有符合條件的重複上榜 SKU 可以匯出' });
      return;
    }
    const buffer = await buildZeroSalesBuyerFollowupExportBuffer(
      rows,
      { minCount, q: keyword, buyer: buyerQ, generatedAt: toHKString(new Date()) },
    );
    const stamp = toHKDateString(new Date()).replace(/-/g, '');
    await writeAuditEvent({
      eventType: 'zero_sales_buyer_followup_export',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { q: keyword ?? null, buyer: buyerQ ?? null, min_count: minCount, limit: lim, count: rows.length },
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Zero_Sales_Buyer_Followup_${stamp}.xlsx"`);
    res.send(buffer);
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
    const reasonLabels = (await listZeroSalesReasons(false)).map((r) => r.label);
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
      is_open: i.is_open !== false,
      auto_filled_from_week: i.auto_filled ? (i.auto_filled_from_week || null) : null,
    })), reasonLabels);
    const stamp = toHKDateString(new Date()).replace(/-/g, '');
    // 跨批次匯出時不可用最新批次名作檔名，否則會被誤認為只匯出了最新一批
    const label = batchId
      ? (items[0]?.week_label ?? 'batch').replace(/[^\w\-]+/g, '_')
      : 'All_Batches';
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
    const autoFillRepeats = String(req.body.auto_fill_repeats ?? '1') !== '0';
    const { batchId, closedBatches, autoFilled } = await createZeroSalesBatch({
      weekLabel: meta.data.week_label,
      note: meta.data.note ?? '',
      rows: parsed.rows.map((r) => ({ siteCode: r.siteCode, sku: r.sku, data: r.data })),
      contentHash: parsed.contentHash ?? '',
      createdBy: req.adminUsername!,
      autoFillRepeats,
    });
    await writeAuditEvent({
      eventType: 'zero_sales_batch_created',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        filename: file.originalname,
        week_label: meta.data.week_label,
        batchId,
        totalRows: parsed.totalRows,
        auto_filled: autoFilled,
        auto_fill_repeats: autoFillRepeats,
        // 即時封存：記錄被自動封存的舊批次及當時未回覆行數，方便日後追查
        closed_batches: closedBatches.map((b) => ({ batch_id: b.id, week_label: b.week_label, pending: b.pending })),
      },
    });
    res.status(201).json({ ok: true, batchId, totalRows: parsed.totalRows, closedBatches, autoFilled });
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
    const reasonLabels = (await listZeroSalesReasons(false)).map((r) => r.label);
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
      is_open: i.is_open !== false,
      auto_filled_from_week: i.auto_filled ? (i.auto_filled_from_week || null) : null,
    })), reasonLabels);
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
      metadata: {
        scope: 'batch',
        batch_id: batchId,
        week_label: result.weekLabel,
        deleted_items: result.deletedItems,
        reopened_week_label: result.reopenedWeekLabel,
      },
    });
    res.json({ ok: true, deleted_items: result.deletedItems, reopened_week_label: result.reopenedWeekLabel });
  }),
);

/** PUT /api/admin/zero-sales/batches/:id/close — 手動封存某週次（店舖即時不可再回覆） */
adminRouter.put(
  '/zero-sales/batches/:id/close',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const batchId = req.params.id as string;
    const result = await closeZeroSalesBatch(batchId, req.adminUsername!);
    if (!result) {
      res.status(404).json({ error: '找不到此批次' });
      return;
    }
    if (!result.alreadyClosed) {
      await writeAuditEvent({
        eventType: 'zero_sales_batch_closed',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { batch_id: batchId, week_label: result.weekLabel, pending: result.pending, reason: 'manual' },
      });
    }
    res.json({
      ok: true,
      week_label: result.weekLabel,
      pending: result.pending,
      already_closed: result.alreadyClosed,
    });
  }),
);

/** PUT /api/admin/zero-sales/batches/:id/reopen — 例外重開舊週次讓店舖補答（新批次上載時會再自動封存） */
adminRouter.put(
  '/zero-sales/batches/:id/reopen',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const batchId = req.params.id as string;
    const result = await reopenZeroSalesBatch(batchId);
    if (!result) {
      res.status(404).json({ error: '找不到此批次' });
      return;
    }
    if (!result.wasOpen) {
      await writeAuditEvent({
        eventType: 'zero_sales_batch_reopened',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { batch_id: batchId, week_label: result.weekLabel },
      });
    }
    res.json({ ok: true, week_label: result.weekLabel, already_open: result.wasOpen });
  }),
);

const zeroSalesAutoFillSchema = z.object({
  /** 預設 true：只套用完全未有人手回覆的店舖（適合已派發中的週次，例如 2026-W43） */
  only_unreplied_stores: z.boolean().optional().default(true),
});

/** POST /api/admin/zero-sales/batches/:id/auto-fill — 為重複上榜 SKU 補套用上一次店舖回覆
 *  只會更新 pending 行；已回覆的店舖 / SKU 永不覆寫。 */
adminRouter.post(
  '/zero-sales/batches/:id/auto-fill',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = zeroSalesAutoFillSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '參數無效' });
      return;
    }
    const batchId = req.params.id as string;
    const result = await autoFillZeroSalesReplies(batchId, {
      onlyUnrepliedStores: parsed.data.only_unreplied_stores,
    });
    if (!result) {
      res.status(404).json({ error: '找不到此批次' });
      return;
    }
    await writeAuditEvent({
      eventType: 'zero_sales_auto_filled',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        batch_id: batchId,
        week_label: result.week_label,
        only_unreplied_stores: parsed.data.only_unreplied_stores,
        applied: result.applied,
        pending_before: result.pending_before,
        replied_before: result.replied_before,
        remaining_pending: result.remaining_pending,
      },
    });
    res.json({ ok: true, ...result });
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

/** PUT /api/admin/zero-sales/batches/:id/items/:itemId/reply — 管理員代改／代填店舖回覆
 *  （已回覆可改；已封存週次的 pending 行可由管理員代填，例如店舖截單後 email 補交） */
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
      const { before, item, entered } = await adminReplyItem({
        batchId: req.params.id as string,
        itemId: req.params.itemId as string,
        reasonCode: parsed.data.reason_code,
        reasonNote: parsed.data.reason_note ?? '',
        adminUser: req.adminUsername!,
      });
      await writeAuditEvent({
        eventType: entered ? 'zero_sales_reply_entered' : 'zero_sales_reply_edited',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: {
          item_id: item.id,
          batch_id: item.batch_id,
          site_code: item.site_code,
          sku: item.sku,
          entered,
          replied_by: item.replied_by,
          before: { reason_code: before.reason_code, reason_note: before.reason_note },
          after: { reason_code: item.reason_code, reason_note: item.reason_note },
        },
      });
      res.json({ ok: true, item, entered });
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

// ---------------------------------------------------------------------------
// 存貨 Dashboard：每週店舖不良存貨（By Shop 報表）
//
// 限流刻意分開：只有 POST 上載走 excelImportLimiter（30/小時），其餘
// GET / PUT / DELETE 一律 adminActionLimiter，否則 admin 開 tab、切口徑、
// 翻頁就會自己撞 429。
// ---------------------------------------------------------------------------

const stockUploadSchema = z.object({
  report_date: z.string().trim().refine(isValidIsoDate, '報表日期格式應為 YYYY-MM-DD'),
  // 只接受 migration 026 CHECK 的三個值（weekly / month_end / ad_hoc），不接受別名
  report_kind: z.enum(SHOP_STOCK_REPORT_KINDS).optional().default('weekly'),
  note: z.string().max(1000).optional().default(''),
});

/** POST /api/admin/stock/batches — 上載 By Shop 報表；同一 report_date = 直接取代該批 */
adminRouter.post(
  '/stock/batches',
  requireAdmin,
  excelImportLimiter,
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const file = getUploadedFile(req);
    const uploadError = validateUploadedXlsx(file, config.maxUploadBytes, EXCEL_UPLOAD_EXTENSION_ERROR);
    if (uploadError) {
      res.status(uploadError.status).json({ error: uploadError.message });
      return;
    }
    const meta = stockUploadSchema.safeParse(req.body);
    if (!meta.success) {
      res.status(400).json({ error: meta.error.issues[0]?.message ?? '上載資料無效' });
      return;
    }
    try {
      const result = await upsertShopStockBatch({
        buffer: file!.buffer,
        reportDate: meta.data.report_date,
        reportKind: meta.data.report_kind ?? 'weekly',
        note: meta.data.note ?? '',
        uploadedBy: req.adminUsername ?? '',
        maxRows: config.maxImportRows,
      });
      if (!result.noop) {
        await writeAuditEvent({
          eventType: 'shop_stock_batch_created',
          actorRole: 'admin',
          actor: req.adminUsername,
          ip: getClientIp(req),
          metadata: {
            filename: file!.originalname,
            batch_id: result.batch.id,
            report_date: result.batch.report_date,
            report_kind: result.batch.report_kind,
            replaced: result.replaced,
            // 同日重上會刪掉舊批次，舊 id / 行數 / hash 是唯一可回溯的痕跡
            replaced_batch_id: result.replacedBatch?.id ?? null,
            replaced_row_count: result.replacedBatch?.rowCount ?? null,
            replaced_content_hash: result.replacedBatch?.contentHash ?? null,
            row_count: result.batch.row_count,
            store_count: result.batch.store_count,
            skipped: result.skipped,
            unknown_sites: result.unknownSites,
            content_hash: result.contentHash,
          },
        });
      }
      res.status(result.replaced || result.noop ? 200 : 201).json({
        ok: true,
        batch: result.batch,
        replaced: result.replaced,
        replaced_batch_id: result.replacedBatch?.id ?? null,
        noop: result.noop,
        skipped: result.skipped,
        warnings: result.warnings,
        unknown_sites: result.unknownSites,
      });
    } catch (err) {
      if (err instanceof ShopStockImportError) {
        await writeAuditEvent({
          eventType: 'shop_stock_import_error',
          actorRole: 'admin',
          actor: req.adminUsername,
          ip: getClientIp(req),
          metadata: {
            filename: file!.originalname,
            report_date: meta.data.report_date,
            errors: err.parsed.errors ?? [],
            skipped: err.parsed.skipped,
          },
        });
        res.status(400).json({
          error: '匯入失敗',
          totalRows: err.parsed.totalRows,
          sourceRows: err.parsed.sourceRows,
          skipped: err.parsed.skipped,
          warnings: err.parsed.warnings,
          errors: err.parsed.errors ?? [],
        });
        return;
      }
      throw err;
    }
  }),
);

const stockPageSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/admin/stock/batches — 批次列表（新到舊，按 report_date） */
adminRouter.get(
  '/stock/batches',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = stockPageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: '分頁參數無效' });
      return;
    }
    const result = await listShopStockBatches({
      page: parsed.data.page ?? 1,
      pageSize: parsed.data.size ?? 20,
    });
    res.json({
      ok: true,
      batches: result.batches,
      // 前端（admin-stock.js）沿用 rows 命名
      rows: result.batches,
      total: result.total,
      page: result.page,
      page_size: result.pageSize,
    });
  }),
);

const stockUpdateSchema = z
  .object({
    report_date: z.string().trim().refine(isValidIsoDate, '報表日期格式應為 YYYY-MM-DD').optional(),
    note: z.string().max(1000).optional(),
  })
  .refine((data) => data.report_date !== undefined || data.note !== undefined, {
    message: '沒有需要更新的欄位',
  });

/** PUT /api/admin/stock/batches/:id — 改報表日期／備註（日期揀錯時用，毋須刪除重上） */
adminRouter.put(
  '/stock/batches/:id',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = stockUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '更新資料無效' });
      return;
    }
    try {
      const batch = await updateShopStockBatch(req.params.id as string, {
        reportDate: parsed.data.report_date,
        note: parsed.data.note,
      });
      if (!batch) {
        res.status(404).json({ error: '找不到此批次' });
        return;
      }
      await writeAuditEvent({
        eventType: 'shop_stock_batch_updated',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: {
          batch_id: batch.id,
          report_date: batch.report_date,
          note: batch.note,
          changed: { report_date: parsed.data.report_date ?? null, note: parsed.data.note ?? null },
        },
      });
      res.json({ ok: true, batch });
    } catch (err) {
      if (err instanceof ShopStockDateConflictError) {
        res.status(409).json({ error: err.message, code: 'DATE_CONFLICT' });
        return;
      }
      throw err;
    }
  }),
);

/** DELETE /api/admin/stock/batches/:id — 刪除整批（hard delete；audit 保留唯一痕跡） */
adminRouter.delete(
  '/stock/batches/:id',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const batchId = req.params.id as string;
    const result = await deleteShopStockBatch(batchId);
    if (!result) {
      res.status(404).json({ error: '找不到此批次' });
      return;
    }
    await writeAuditEvent({
      eventType: 'shop_stock_batch_deleted',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        batch_id: batchId,
        report_date: result.reportDate,
        week_label: result.weekLabel,
        deleted_rows: result.deletedRows,
        deleted_stores: result.deletedStores,
        content_hash: result.contentHash,
      },
    });
    res.json({ ok: true, deleted_rows: result.deletedRows, deleted_stores: result.deletedStores });
  }),
);

const stockRangeSchema = z.object({
  from: z.string().trim().refine(isValidIsoDate, '起始日期格式應為 YYYY-MM-DD').optional(),
  to: z.string().trim().refine(isValidIsoDate, '結束日期格式應為 YYYY-MM-DD').optional(),
});

/** 匯出窗口（月）：與圖表上的 3 / 6 / 12 / 24 對齊；上限跟圖表一樣 24 */
const stockExportSchema = z.object({
  months: z.coerce
    .number()
    .int('顯示期間應為整數月')
    .min(1, '顯示期間至少 1 個月')
    .max(24, '顯示期間最多 24 個月')
    .default(12),
});

/** GET /api/admin/stock/summary — 全公司趨勢（加權比率）＋ 最新一期 KPI */
adminRouter.get(
  '/stock/summary',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = stockRangeSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '日期範圍無效' });
      return;
    }
    const summary = await getShopStockSummary({ from: parsed.data.from, to: parsed.data.to });
    res.json({ ok: true, ...summary });
  }),
);

/** GET /api/admin/stock/summary/export — 把佔比趨勢圖的數字匯出成 Excel（PPT 用） */
adminRouter.get(
  '/stock/summary/export',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = stockExportSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '匯出參數無效' });
      return;
    }
    const months = parsed.data.months;
    const summary = await getShopStockSummary();
    const latest = summary.series[summary.series.length - 1];
    // 與前端圖表同一個窗口：以最新一期回推 N 個月
    const cutoff = latest ? monthsBeforeDateOnly(latest.report_date, months) : '';
    const rows = cutoff
      ? summary.series.filter((point) => point.report_date >= cutoff)
      : summary.series;

    const buffer = await buildShopStockTrendBuffer({
      rows,
      kpi: summary.kpi,
      companyAvgRatio: summary.company_avg_ratio,
      months,
      generatedAt: toHKString(new Date()),
    });

    const stamp = hkTodayForDateColumn().replace(/-/g, '');
    const filename = `Shop_Stock_Ratio_${months}M_${stamp}.xlsx`;
    await writeAuditEvent({
      eventType: 'shop_stock_trend_export',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { filename, months, periods: rows.length, latest: latest?.report_date ?? null },
    });
    res.setHeader('Content-Type', EXPORT_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

/** GET /api/admin/stock/weeks/:reportDate — 某一期每店明細（含與上一期的百分點差） */
adminRouter.get(
  '/stock/weeks/:reportDate',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const reportDate = req.params.reportDate as string;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !isValidIsoDate(reportDate)) {
      res.status(400).json({ error: '報表日期格式應為 YYYY-MM-DD' });
      return;
    }
    const week = await getShopStockWeek(reportDate);
    if (!week) {
      res.status(404).json({ error: '找不到此報表日期的批次' });
      return;
    }
    res.json({ ok: true, ...week });
  }),
);

/**
 * GET /api/admin/stock/weeks/:reportDate/export — 某一期每店明細匯出
 * 篩選／排序同畫面一致（q / sort / only），即「匯出 = 畫面所見」。
 * ⚠️ 篩選規則與 public/js/admin-stock.js 的 filteredWeekRows() 必須同步。
 */
adminRouter.get(
  '/stock/weeks/:reportDate/export',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const reportDate = req.params.reportDate as string;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !isValidIsoDate(reportDate)) {
      res.status(400).json({ error: '報表日期格式應為 YYYY-MM-DD' });
      return;
    }
    const week = await getShopStockWeek(reportDate);
    if (!week) {
      res.status(404).json({ error: '找不到此報表日期的批次' });
      return;
    }
    const filters = normalizeWeekExportFilters({
      q: String(req.query.q ?? ''),
      sort: String(req.query.sort ?? ''),
      only: String(req.query.only ?? ''),
    });
    const rows = filterAndSortWeekRows(week.rows, filters);
    const buffer = await buildShopStockWeekBuffer({
      week,
      filters,
      rows,
      generatedAt: toHKString(new Date()),
    });
    const stamp = hkTodayForDateColumn().replace(/-/g, '');
    const filename = `Shop_Stock_Detail_${reportDate}_${stamp}.xlsx`;
    await writeAuditEvent({
      eventType: 'shop_stock_detail_export',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        filename,
        report_date: reportDate,
        rows: rows.length,
        total_rows: week.rows.length,
        filters,
      },
    });
    res.setHeader('Content-Type', EXPORT_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

/**
 * GET /api/admin/stock/rf/export — No. of RF SKU Dashboard 匯出
 * 工作表：RF SKU 走勢 + RF SKU 店舖排名 + 不良÷店內貨品 排名 + 匯出說明。
 * 走勢窗口與圖表一致（months，3/6/12/24）；排名用 report_date 指定期（預設最新一期）。
 */
adminRouter.get(
  '/stock/rf/export',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = stockExportSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '匯出參數無效' });
      return;
    }
    const months = parsed.data.months;
    const summary = await getShopStockSummary();
    const latest = summary.series[summary.series.length - 1];
    const cutoff = latest ? monthsBeforeDateOnly(latest.report_date, months) : '';
    const series = cutoff
      ? summary.series.filter((point) => point.report_date >= cutoff)
      : summary.series;

    // 排名期別：優先用畫面揀選嗰期，否則用最新一期
    const requested = String(req.query.report_date ?? '').slice(0, 10);
    let week: ShopStockWeek | null = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(requested) && isValidIsoDate(requested)) {
      week = await getShopStockWeek(requested);
    }
    if (!week && latest) week = await getShopStockWeek(latest.report_date);

    const buffer = await buildShopStockRfBuffer({
      series,
      kpi: summary.kpi,
      week,
      months,
      generatedAt: toHKString(new Date()),
    });
    const stamp = hkTodayForDateColumn().replace(/-/g, '');
    const filename = `Shop_Stock_RF_SKU_${months}M_${stamp}.xlsx`;
    await writeAuditEvent({
      eventType: 'shop_stock_rf_export',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        filename,
        months,
        periods: series.length,
        rank_report_date: week?.report_date ?? null,
        ranked_rf_shops: week ? week.rows.filter((row) => row.rf_sku_count !== null).length : 0,
      },
    });
    res.setHeader('Content-Type', EXPORT_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);


// ---------------------------------------------------------------------------
// 指定 SKU 回覆（Designated SKU Reply）
//
// 上載一份 Excel，按 Site Code 建立「事項」；同店多個 SKU 歸入同一事項，
// 店舖一次過回覆每個 SKU 的年期及可調撥件數。
// ---------------------------------------------------------------------------

const designatedSkuUploadSchema = z.object({
  subject: z.string().trim().min(1, '事項主題為必填').max(200),
  matter_type: z.string().trim().max(60).optional().default('stock_year_breakdown'),
  instructions: z.string().max(4000).optional().default(''),
  due_at: z.string().trim().optional().default(''),
  reference: z.string().max(100).optional().default(''),
  note: z.string().max(1000).optional().default(''),
});

/**
 * 截止時間輸入：一律當香港時間（GMT+8）。
 * 接受 `2026-11-10T18:00`、`2026-11-10 18:00`、`2026-11-10`（= 當日 23:59）
 * 或完整 ISO（自帶時區則依該時區）。回傳 UTC ISO 字串供 timestamptz 使用。
 */
function parseDueAtInput(raw: string): { ok: true; value: string | null } | { ok: false } {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: null };
  let iso = text;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(text);
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  if (dateOnly) iso = `${dateOnly[1]}T23:59:00+08:00`;
  else if (local) iso = `${local[1]}T${local[2]}:${local[3] ?? '00'}+08:00`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, value: date.toISOString() };
}

/** 匯出用：把事項攤平為每個 SKU 一行 */
function designatedSkuExportRows(matters: DesignatedSkuMatter[]) {
  const rows: Array<{
    matter_code: string;
    matter_status: import('../lib/designatedSku.js').DesignatedSkuExportItem['matter_status'];
    batch_code: string;
    subject: string;
    matter_type: string;
    site_code: string;
    shop: string;
    sku: string;
    description: string;
    stock_qty: number | null;
    status: string;
    no_transfer: boolean;
    reply_total: number | null;
    reply_note: string;
    replied_by: string | null;
    replied_at: string | null;
    reply_count: number;
    admin_edited_by: string;
    admin_edited_at: string | null;
    is_open: boolean;
    created_at: string;
    lines: Array<{ year_code: string; qty: number }>;
  }> = [];
  for (const matter of matters) {
    for (const item of matter.items) {
      rows.push({
        matter_code: matter.matter_code,
        matter_status: matter.status,
        batch_code: matter.batch_code,
        subject: matter.subject,
        matter_type: matter.matter_type,
        site_code: matter.site_code,
        shop: matter.shop,
        sku: item.sku,
        description: item.description,
        stock_qty: item.stock_qty,
        status: item.status,
        no_transfer: item.no_transfer,
        reply_total: item.reply_total,
        reply_note: item.reply_note,
        replied_by: item.replied_by,
        replied_at: item.replied_at,
        reply_count: item.reply_count,
        admin_edited_by: item.admin_edited_by,
        admin_edited_at: item.admin_edited_at,
        is_open: matter.is_open,
        created_at: matter.batch_created_at,
        lines: item.lines,
      });
    }
  }
  return rows;
}

/** GET /api/admin/designated-sku/template — 下載上載模板 */
adminRouter.get(
  '/designated-sku/template',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const buffer = await generateDesignatedSkuTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Designated_SKU_Template.xlsx"');
    res.send(buffer);
  }),
);

/** POST /api/admin/designated-sku/batches — 上載 Excel 建立一批事項 */
adminRouter.post(
  '/designated-sku/batches',
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
    const meta = designatedSkuUploadSchema.safeParse(req.body);
    if (!meta.success) {
      res.status(400).json({ error: meta.error.issues[0]?.message ?? '上載資料無效' });
      return;
    }
    const due = parseDueAtInput(meta.data.due_at);
    if (!due.ok) {
      res.status(400).json({ error: '截止時間格式無效（例：2026-11-10T18:00，香港時間）' });
      return;
    }

    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));
    const parsed = await parseDesignatedSkuWorkbook(file.buffer, storeCodes, config.maxImportRows);
    if (!parsed.ok || !parsed.rows) {
      await writeAuditEvent({
        eventType: 'designated_sku_import_error',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: file.originalname, errors: parsed.errors ?? [] },
      });
      res.status(400).json({
        error: '匯入失敗',
        totalRows: parsed.totalRows,
        errors: parsed.errors ?? [],
        warnings: parsed.warnings ?? [],
      });
      return;
    }

    // 同一檔案重複上載：直接提示既有批次，避免重複派發（可用 force=1 強制）
    const force = String(req.body.force ?? '') === '1';
    if (!force) {
      const existing = await findDesignatedSkuBatchByHash(parsed.contentHash ?? '');
      if (existing) {
        res.status(409).json({
          error: `此檔案已於 ${existing.created_at} 上載（批次 ${existing.batch_code}），如要重新派發請勾選「仍要重新上載」`,
          code: 'DUPLICATE_FILE',
          existing,
        });
        return;
      }
    }

    const { batchId, batchCode, matterCodes } = await createDesignatedSkuBatch({
      subject: meta.data.subject,
      matterType: meta.data.matter_type,
      instructions: meta.data.instructions ?? '',
      dueAt: due.value,
      reference: meta.data.reference ?? '',
      note: meta.data.note ?? '',
      sourceFilename: file.originalname,
      rows: parsed.rows.map((r) => ({
        siteCode: r.siteCode,
        sku: r.sku,
        hierarchy: r.hierarchy,
        description: r.description,
        stockQty: r.stockQty,
        data: r.data,
      })),
      skippedRows: parsed.skippedRows,
      warnCount: (parsed.warnings ?? []).length,
      contentHash: parsed.contentHash ?? '',
      createdBy: req.adminUsername!,
    });

    const storeCount = new Set(parsed.rows.map((r) => r.siteCode)).size;
    await writeAuditEvent({
      eventType: 'designated_sku_batch_created',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        filename: file.originalname,
        batch_code: batchCode,
        batch_id: batchId,
        subject: meta.data.subject,
        matter_count: storeCount,
        item_count: parsed.rows.length,
        store_count: storeCount,
        skipped_rows: parsed.skippedRows,
        warn_count: (parsed.warnings ?? []).length,
        forced: force,
      },
    });

    res.status(201).json({
      ok: true,
      batchId,
      batchCode,
      matterCount: storeCount,
      itemCount: parsed.rows.length,
      storeCount,
      totalRows: parsed.totalRows,
      skippedRows: parsed.skippedRows,
      warnings: parsed.warnings ?? [],
      matterCodes: matterCodes.slice(0, 5),
    });
  }),
);

const designatedSkuManualRowSchema = z.object({
  site_code: z.string().trim().min(1, '請選擇店舖').max(20),
  sku: z.string().trim().min(1, '請填寫 SKU').max(60),
  description: z.string().max(200).optional().default(''),
  hierarchy: z.string().max(120).optional().default(''),
  stock_qty: z.union([z.string(), z.number(), z.null()]).optional(),
});

const designatedSkuManualSchema = z.object({
  subject: z.string().trim().min(1, '事項主題為必填').max(200),
  matter_type: z.string().trim().max(60).optional().default('stock_year_breakdown'),
  instructions: z.string().max(4000).optional().default(''),
  due_at: z.string().trim().optional().default(''),
  reference: z.string().max(100).optional().default(''),
  note: z.string().max(1000).optional().default(''),
  rows: z.array(designatedSkuManualRowSchema).min(1, '請至少加入一行 SKU').max(2000),
  force: z.string().optional().default(''),
});

/** 人手輸入的存貨：空白 → null（不代表 0）；非數字直接擋 */
function parseManualStock(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const text = String(raw).trim().replace(/,/g, '');
  if (!text) return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false };
  return { ok: true, value: Number(text) };
}

/**
 * POST /api/admin/designated-sku/batches/manual
 * 人手輸入建立批次：與 Excel 上載同一資料模型，只是來源不是檔案。
 */
adminRouter.post(
  '/designated-sku/batches/manual',
  requireAdmin,
  excelImportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = designatedSkuManualSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '輸入資料無效' });
      return;
    }
    const due = parseDueAtInput(parsed.data.due_at);
    if (!due.ok) {
      res.status(400).json({ error: '截止時間格式無效（例：2026-11-10T18:00，香港時間）' });
      return;
    }
    if (parsed.data.rows.length > config.maxImportRows) {
      res.status(400).json({ error: `一次最多只可輸入 ${config.maxImportRows} 行` });
      return;
    }

    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));
    const rows: Array<{
      siteCode: string;
      sku: string;
      hierarchy: string;
      description: string;
      stockQty: number | null;
      data: Record<string, string>;
    }> = [];
    const errors: Array<{ row: number; siteCode: string; field: string; reason: string }> = [];
    const seen = new Set<string>();

    parsed.data.rows.forEach((row, index) => {
      const siteCode = normalizeSiteCode(row.site_code);
      const sku = row.sku.trim();
      const line = index + 1;
      if (!storeCodes.has(siteCode)) {
        errors.push({ row: line, siteCode, field: 'Site', reason: '不存在於門店主檔' });
        return;
      }
      const key = `${siteCode}|${sku}`;
      if (seen.has(key)) {
        errors.push({ row: line, siteCode, field: 'SKU', reason: '同一店舖重複填寫同一 SKU' });
        return;
      }
      seen.add(key);
      const stock = parseManualStock(row.stock_qty);
      if (!stock.ok) {
        errors.push({ row: line, siteCode, field: '存貨', reason: '必須為整數（留空代表未提供）' });
        return;
      }
      rows.push({
        siteCode,
        sku,
        hierarchy: row.hierarchy ?? '',
        description: row.description ?? '',
        stockQty: stock.value,
        data: {},
      });
    });

    if (errors.length) {
      res.status(400).json({ error: '輸入資料有誤', errors, warnings: [] });
      return;
    }

    // 用人手輸入的內容做指紋，重複提交同一份清單一樣會提示（可用 force 強制）
    const fingerprint = createHash('sha256')
      .update(rows.map((r) => `${r.siteCode}|${r.sku}|${r.stockQty ?? ''}`).sort().join('\n'))
      .digest('hex');
    const force = parsed.data.force === '1';
    if (!force) {
      const existing = await findDesignatedSkuBatchByHash(fingerprint);
      if (existing) {
        res.status(409).json({
          error: `相同清單已於 ${existing.created_at} 建立（批次 ${existing.batch_code}），如要重新派發請勾選「仍要重新派發」`,
          code: 'DUPLICATE_FILE',
          existing,
        });
        return;
      }
    }

    const { batchId, batchCode, matterCodes } = await createDesignatedSkuBatch({
      subject: parsed.data.subject,
      matterType: parsed.data.matter_type,
      instructions: parsed.data.instructions ?? '',
      dueAt: due.value,
      reference: parsed.data.reference ?? '',
      note: parsed.data.note ?? '',
      sourceFilename: '（人手輸入）',
      rows,
      skippedRows: 0,
      warnCount: rows.filter((r) => r.stockQty === null).length,
      contentHash: fingerprint,
      createdBy: req.adminUsername!,
    });
    const storeCount = new Set(rows.map((r) => r.siteCode)).size;
    await writeAuditEvent({
      eventType: 'designated_sku_batch_created',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        source: 'manual',
        batch_code: batchCode,
        batch_id: batchId,
        subject: parsed.data.subject,
        matter_count: storeCount,
        item_count: rows.length,
        store_count: storeCount,
        due_at: due.value,
        forced: force,
      },
    });
    res.status(201).json({
      ok: true,
      batchId,
      batchCode,
      matterCount: storeCount,
      itemCount: rows.length,
      storeCount,
      totalRows: rows.length,
      skippedRows: 0,
      warnings: [],
      matterCodes: matterCodes.slice(0, 5),
    });
  }),
);

const designatedSkuItemSchema = z.object({
  site_code: z.string().trim().min(1, '請選擇店舖').max(20),
  sku: z.string().trim().min(1, '請填寫 SKU').max(60),
  description: z.string().max(200).optional(),
  hierarchy: z.string().max(120).optional(),
  stock_qty: z.union([z.string(), z.number(), z.null()]).optional(),
});

/** POST /api/admin/designated-sku/batches/:id/items — 在既有批次補加 SKU */
adminRouter.post(
  '/designated-sku/batches/:id/items',
  requireUuidParam('id'),
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = designatedSkuItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'SKU 資料無效' });
      return;
    }
    const stock = parseManualStock(parsed.data.stock_qty);
    if (!stock.ok) {
      res.status(400).json({ error: '存貨必須為整數（留空代表未提供）' });
      return;
    }
    try {
      const result = await addDesignatedSkuItem({
        batchId: req.params.id as string,
        siteCode: normalizeSiteCode(parsed.data.site_code),
        sku: parsed.data.sku,
        description: parsed.data.description ?? '',
        hierarchy: parsed.data.hierarchy ?? '',
        stockQty: stock.value,
      });
      await writeAuditEvent({
        eventType: 'designated_sku_item_added',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: {
          matter_code: result.matterCode,
          matter_created: result.matterCreated,
          site_code: normalizeSiteCode(parsed.data.site_code),
          sku: parsed.data.sku,
          stock_qty: stock.value,
        },
      });
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof DesignatedSkuNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof DesignatedSkuError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

const designatedSkuItemUpdateSchema = z.object({
  site_code: z.string().trim().min(1).max(20).optional(),
  sku: z.string().trim().min(1, 'SKU 不可留空').max(60).optional(),
  description: z.string().max(200).optional(),
  hierarchy: z.string().max(120).optional(),
  stock_qty: z.union([z.string(), z.number(), z.null()]).optional(),
});

/** PUT /api/admin/designated-sku/batches/:id/items/:itemId — 修改 SKU／存貨／所屬店舖 */
adminRouter.put(
  '/designated-sku/batches/:id/items/:itemId',
  requireUuidParam('id', 'itemId'),
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = designatedSkuItemUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'SKU 資料無效' });
      return;
    }
    let stockQty: number | null | undefined;
    if (parsed.data.stock_qty !== undefined) {
      const stock = parseManualStock(parsed.data.stock_qty);
      if (!stock.ok) {
        res.status(400).json({ error: '存貨必須為整數（留空代表未提供）' });
        return;
      }
      stockQty = stock.value;
    }
    try {
      const result = await updateDesignatedSkuItem({
        batchId: req.params.id as string,
        itemId: req.params.itemId as string,
        siteCode: parsed.data.site_code === undefined ? undefined : normalizeSiteCode(parsed.data.site_code),
        sku: parsed.data.sku,
        description: parsed.data.description,
        hierarchy: parsed.data.hierarchy,
        stockQty,
      });
      await writeAuditEvent({
        eventType: 'designated_sku_item_updated',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: {
          matter_code: result.matterCode,
          moved: result.moved,
          site_code: parsed.data.site_code ?? null,
          sku: parsed.data.sku ?? null,
          stock_qty: stockQty === undefined ? null : stockQty,
        },
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof DesignatedSkuNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof DesignatedSkuError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

/** DELETE /api/admin/designated-sku/batches/:id/items/:itemId — 移除單一 SKU */
adminRouter.delete(
  '/designated-sku/batches/:id/items/:itemId',
  requireUuidParam('id', 'itemId'),
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await deleteDesignatedSkuItem({
      batchId: req.params.id as string,
      itemId: req.params.itemId as string,
    });
    if (!result) {
      res.status(404).json({ error: '找不到此 SKU' });
      return;
    }
    await writeAuditEvent({
      eventType: 'designated_sku_item_deleted',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        matter_code: result.matterCode,
        site_code: result.siteCode,
        sku: result.sku,
        matter_deleted: result.matterDeleted,
      },
    });
    res.json({ ok: true, ...result });
  }),
);

const designatedSkuBatchUpdateSchema = z.object({
  subject: z.string().trim().min(1).max(200).optional(),
  matter_type: z.string().trim().max(60).optional(),
  instructions: z.string().max(4000).optional(),
  due_at: z.string().trim().optional(),
  reference: z.string().max(100).optional(),
  note: z.string().max(1000).optional(),
});

/** PUT /api/admin/designated-sku/batches/:id — 修改批次資料（例：延長截止時間） */
adminRouter.put(
  '/designated-sku/batches/:id',
  requireUuidParam('id'),
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = designatedSkuBatchUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '批次資料無效' });
      return;
    }
    let dueAt: string | null | undefined;
    if (parsed.data.due_at !== undefined) {
      const due = parseDueAtInput(parsed.data.due_at);
      if (!due.ok) {
        res.status(400).json({ error: '截止時間格式無效（例：2026-11-10T18:00，香港時間）' });
        return;
      }
      dueAt = due.value;
    }
    const batch = await updateDesignatedSkuBatch({
      batchId: req.params.id as string,
      subject: parsed.data.subject,
      matterType: parsed.data.matter_type,
      instructions: parsed.data.instructions,
      dueAt,
      reference: parsed.data.reference,
      note: parsed.data.note,
    });
    if (!batch) {
      res.status(404).json({ error: '找不到批次' });
      return;
    }
    await writeAuditEvent({
      eventType: 'designated_sku_batch_updated',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        batch_code: batch.batch_code,
        due_at: batch.due_at,
        subject: batch.subject,
      },
    });
    res.json({ ok: true, batch });
  }),
);

/** GET /api/admin/designated-sku/batches — 批次列表（含回覆進度） */
adminRouter.get(
  '/designated-sku/batches',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.page_size ?? 20);
    const [result, options] = await Promise.all([
      listDesignatedSkuBatchesPage({ page, pageSize }),
      listDesignatedSkuBatchOptions(),
    ]);
    res.json({
      ...result,
      total_pages: result.totalPages,
      batch_options: options,
    });
  }),
);

/** GET /api/admin/designated-sku/summary — KPI 總覽 */
adminRouter.get(
  '/designated-sku/summary',
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getDesignatedSkuSummary());
  }),
);

/** GET /api/admin/designated-sku/batches/:id/matters — 批次內事項明細（含每個 SKU） */
adminRouter.get(
  '/designated-sku/batches/:id/matters',
  requireUuidParam('id'),
  requireAdmin,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { site_code, status } = req.query as Record<string, string | undefined>;
    const batch = await getDesignatedSkuBatch(req.params.id as string);
    if (!batch) {
      res.status(404).json({ error: '找不到批次' });
      return;
    }
    const matters = await listDesignatedSkuBatchMatters(req.params.id as string, {
      siteCode: site_code?.trim() ? normalizeSiteCode(site_code) : undefined,
      status: status === 'pending' || status === 'replied' ? status : undefined,
    });
    res.json({ batch, matters });
  }),
);

/** GET /api/admin/designated-sku/export — 匯出（可按批次 / Site / 狀態篩選） */
adminRouter.get(
  '/designated-sku/export',
  requireAdmin,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { batch_id, site_code, status } = req.query as Record<string, string | undefined>;
    const batchId = batch_id?.trim() || undefined;
    if (batchId && !/^[0-9a-fA-F-]{36}$/.test(batchId)) {
      res.status(400).json({ error: '批次編號無效' });
      return;
    }
    if (status && status !== 'pending' && status !== 'replied') {
      res.status(400).json({ error: '狀態篩選無效' });
      return;
    }
    const matters = await listDesignatedSkuForExport({
      batchId,
      siteCode: site_code?.trim() ? normalizeSiteCode(site_code) : undefined,
      status: status === 'pending' || status === 'replied' ? status : undefined,
    });
    const rows = designatedSkuExportRows(matters);
    if (!rows.length) {
      res.status(404).json({ error: '沒有符合條件的事項可以匯出' });
      return;
    }
    const buffer = await buildDesignatedSkuExportBuffer(rows);
    const label = matters[0]?.batch_code ?? 'All';
    const stamp = hkTodayForDateColumn().replace(/-/g, '');
    const filename = `Designated_SKU_${label}_${stamp}.xlsx`;
    await writeAuditEvent({
      eventType: 'designated_sku_export',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        filename,
        batch_id: batchId ?? null,
        site_code: site_code ?? null,
        status: status ?? null,
        matter_count: matters.length,
        item_count: rows.length,
      },
    });
    res.setHeader('Content-Type', EXPORT_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

/** PUT /api/admin/designated-sku/batches/:id/close — 封存（店舖只可查閱） */
adminRouter.put(
  '/designated-sku/batches/:id/close',
  requireUuidParam('id'),
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await closeDesignatedSkuBatch(req.params.id as string, req.adminUsername!);
    if (!result) {
      res.status(404).json({ error: '找不到批次' });
      return;
    }
    await writeAuditEvent({
      eventType: 'designated_sku_batch_closed',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batch_code: result.batchCode },
    });
    res.json({ ok: true, ...result });
  }),
);

/** PUT /api/admin/designated-sku/batches/:id/reopen — 重開（讓店舖補答） */
adminRouter.put(
  '/designated-sku/batches/:id/reopen',
  requireUuidParam('id'),
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await reopenDesignatedSkuBatch(req.params.id as string, req.adminUsername!);
    if (!result) {
      res.status(404).json({ error: '找不到批次' });
      return;
    }
    await writeAuditEvent({
      eventType: 'designated_sku_batch_reopened',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batch_code: result.batchCode },
    });
    res.json({ ok: true, ...result });
  }),
);

/** DELETE /api/admin/designated-sku/batches/:id — 刪除整個批次（含回覆紀錄） */
adminRouter.delete(
  '/designated-sku/batches/:id',
  requireUuidParam('id'),
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await deleteDesignatedSkuBatch(req.params.id as string);
    if (!result) {
      res.status(404).json({ error: '找不到批次' });
      return;
    }
    await writeAuditEvent({
      eventType: 'designated_sku_batch_deleted',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batch_code: result.batchCode, matter_count: result.matterCount },
    });
    res.json({ ok: true, ...result });
  }),
);

/** DELETE /api/admin/designated-sku/batches/:id/matters/:matterId — 刪除單一事項 */
adminRouter.delete(
  '/designated-sku/batches/:id/matters/:matterId',
  requireUuidParam('id', 'matterId'),
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await deleteDesignatedSkuMatter(req.params.id as string, req.params.matterId as string);
    if (!result) {
      res.status(404).json({ error: '找不到此事項' });
      return;
    }
    await writeAuditEvent({
      eventType: 'designated_sku_item_deleted',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: {
        matter_code: result.matterCode,
        site_code: result.siteCode,
        item_count: result.itemCount,
      },
    });
    res.json({ ok: true, ...result });
  }),
);

const designatedSkuAdminReplySchema = z.object({
  items: z
    .array(
      z.object({
        item_id: z.string().uuid('SKU 明細編號無效'),
        lines: z
          .array(
            z.object({
              year_code: z.union([z.string(), z.number()]),
              qty: z.union([z.string(), z.number()]),
            }),
          )
          .max(20)
          .optional()
          .default([]),
        note: z.string().max(2000).optional().default(''),
        no_transfer: z.boolean().optional().default(false),
      }),
    )
    .min(1, '請為事項內每個 SKU 填寫回覆')
    .max(200),
});

/**
 * PUT /api/admin/designated-sku/batches/:id/matters/:matterId/reply
 * 管理員代店舖輸入／修改整個事項（多個 SKU），不受封存限制、不佔用店舖修改次數。
 */
adminRouter.put(
  '/designated-sku/batches/:id/matters/:matterId/reply',
  requireUuidParam('id', 'matterId'),
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = designatedSkuAdminReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '回覆資料無效' });
      return;
    }
    try {
      const { matter, entered } = await adminSubmitDesignatedSkuReply({
        batchId: req.params.id as string,
        matterId: req.params.matterId as string,
        items: parsed.data.items,
        actor: req.adminUsername!,
      });
      await writeAuditEvent({
        eventType: 'designated_sku_reply_admin_edited',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: {
          matter_code: matter.matter_code,
          batch_code: matter.batch_code,
          site_code: matter.site_code,
          entered,
          item_count: matter.item_count,
          total: matter.reply_total,
          items: matter.items.map((item) => ({
            sku: item.sku,
            status: item.status,
            no_transfer: item.no_transfer,
            total: item.reply_total,
            lines: item.lines,
            replied_by: item.replied_by,
            reply_count: item.reply_count,
          })),
        },
      });
      res.json({ ok: true, matter, entered });
    } catch (err) {
      if (err instanceof DesignatedSkuNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof DesignatedSkuError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);
