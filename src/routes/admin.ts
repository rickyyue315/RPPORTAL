import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import {
  adminLoginLimiter,
  adminActionLimiter,
  excelImportLimiter,
  excelExportLimiter,
} from '../middleware/rateLimits.js';
import { asyncHandler, getClientIp } from '../middleware/helpers.js';
import { login, requireAdmin, destroySession, SESSION_COOKIE } from '../middleware/auth.js';
import { writeAuditEvent } from '../lib/audit.js';
import { config } from '../config.js';
import {
  getSubmissionById,
  listVersions,
  adminUpdateSubmission,
  adminUpdateUrgentSubmission,
  adminUpdateSalesSubmission,
  adminUpdateReturnSubmission,
  LockedError,
  type SubmissionRow,
} from '../services/submissions.js';
import { query, withTransaction } from '../db/pool.js';
import {
  generateTemplateWorkbook,
  buildSapExportBuffer,
  buildAuditExportBuffer,
  generateUrgentTemplateWorkbook,
  buildUrgentExportBuffer,
  buildSalesExportBuffer,
  buildReturnExportBuffer,
} from '../lib/excelExport.js';
import {
  parseImportWorkbook,
  parseUrgentImportWorkbook,
  EXCEL_UPLOAD_EXTENSION_ERROR,
} from '../lib/excelImport.js';
import { getStore, normalizeSiteCode, parseStoresCsv, decodeStoresCsvBuffer, replaceStores, listStores } from '../services/stores.js';
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
import { validateBusinessFields, validateUrgentReason } from '../lib/validation.js';
import { archiveExportBatchFile, EXPORT_CONTENT_TYPE } from '../services/exportFiles.js';
import { CSRF_COOKIE } from '../middleware/csrf.js';

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

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value;
}

type ExportSubmissionType = 'normal' | 'urgent' | 'sales' | 'return';

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

function serializeAdminSubmission(row: SubmissionRow, lastModifiedAt?: string | null) {
  return {
    id: row.id,
    application_no: row.application_no,
    source: row.source,
    submission_type: row.submission_type,
    site_code: row.site_code,
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

    if (from) {
      where.push(`application_date >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      where.push(`application_date <= $${idx++}`);
      params.push(to);
    }
    if (site_code) {
      where.push(`site_code = $${idx++}`);
      params.push(normalizeSiteCode(site_code));
    }
    if (source) {
      where.push(`source = $${idx++}`);
      params.push(source);
    }
    if (submission_type === 'normal' || submission_type === 'urgent' || submission_type === 'sales' || submission_type === 'return') {
      where.push(`submission_type = $${idx++}`);
      params.push(submission_type);
    }
    if (exported === 'yes') {
      where.push(`exported_at IS NOT NULL`);
    } else if (exported === 'no') {
      where.push(`exported_at IS NULL`);
    }
    if (sku) {
      where.push(`sku ILIKE $${idx++}`);
      params.push(`%${sku.trim()}%`);
    }
    if (rp_type) {
      const upper = rp_type.trim().toUpperCase();
      if (upper === 'ND' || upper === 'RF') {
        where.push(`rp_type = $${idx++}`);
        params.push(upper);
      }
    }
    if (nd_code) {
      where.push(`nd_code = $${idx++}`);
      params.push(nd_code.trim());
    }
    if (application_no) {
      where.push(`application_no = $${idx++}`);
      params.push(application_no.trim().toUpperCase());
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const pageNum = Math.max(1, Number(page) || 1);
    const size = Math.min(100, Math.max(1, Number(page_size) || 20));
    const offset = (pageNum - 1) * size;

    const countResult = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM submissions ${whereSql}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? 0);

    const result = await query<SubmissionRow>(
      `SELECT * FROM submissions ${whereSql}
       ORDER BY submitted_at DESC
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
    const rows = await query<{
      total: string;
      stores_today: string;
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
      [today],
    );
    const r = rows.rows[0]!;
    res.json({
      total: Number(r.total),
      stores_today: Number(r.stores_today),
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

/** GET /api/admin/submissions/:id — detail + versions. */
adminRouter.get(
  '/submissions/:id',
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
    res.json({
      submission: serializeAdminSubmission(row),
      store: store ?? null,
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
    const businessErrors = validateBusinessFields(parsed.data, row.site_code);
    if (businessErrors.length) {
      res.status(400).json({
        error: businessErrors[0]!.message,
        field: businessErrors[0]!.field,
        errors: businessErrors,
      });
      return;
    }
    let updated: SubmissionRow;
    try {
      updated = await adminUpdateSubmission(
        row.id,
        parsed.data,
        ip,
        req.adminUsername!,
      );
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
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: '請上載 Excel 檔案' });
      return;
    }
    if (!/\.xlsx$/i.test(file.originalname)) {
      res.status(400).json({ error: EXCEL_UPLOAD_EXTENSION_ERROR });
      return;
    }
    if (file.size > config.maxUploadBytes) {
      res.status(400).json({ error: `檔案超過 ${config.maxUploadBytes / 1024 / 1024}MB 限制` });
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

    const ip = getClientIp(req);
    const applicationDate = hkTodayForDateColumn();
    const results = await withTransaction(async (client) => {
      const rowsOut: Array<{
        row: number;
        application_no: string;
        site_code: string;
        sku: string;
        rp_type: string;
        safety_stock: string;
        nd_code: string;
        remark: string;
        submitted_at: string;
      }> = [];
      let successCount = 0;
      for (const r of parsed.rows!) {
        const appNo = generateApplicationNo();
        const requestedByEmail = `${r.siteCode.toLowerCase()}@sasa.com`;
        const insert = await client.query<SubmissionRow>(
          `INSERT INTO submissions (
             application_no, source, site_code, requested_by_email, application_date,
             brand, sku, rp_type, safety_stock, nd_code, remark, created_ip, created_ip_expires_at
           ) VALUES ($1,'excel',$2,$3,$4,
             $5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [
            appNo,
            r.siteCode,
            requestedByEmail,
            applicationDate,
            r.fields.brand,
            r.fields.sku,
            r.fields.rp_type,
            r.fields.safety_stock,
            r.fields.nd_code,
            r.fields.remark,
            ip,
            ip ? ipExpiryIso() : null,
          ],
        );
        const row = insert.rows[0]!;
        await client.query(
          `INSERT INTO submission_versions
             (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
           VALUES ($1, 1, NULL, $2, 'admin', $3, $4, 'excel_import')`,
          [row.id, JSON.stringify(r.fields), req.adminUsername, ip],
        );
        successCount++;
        rowsOut.push({
          row: r.rowNumber,
          application_no: row.application_no,
          site_code: row.site_code,
          sku: row.sku,
          rp_type: r.fields.rp_type,
          safety_stock: r.fields.safety_stock,
          nd_code: r.fields.nd_code,
          remark: r.fields.remark,
          submitted_at: toHKString(row.submitted_at),
        });
      }
      const batchId = await client.query<{ id: string }>(
        `INSERT INTO import_batches (filename, sheet_name, row_count, success_count, failed_count, results, content_hash, created_by, submission_type)
         VALUES ($1, $2, $3, $4, 0, $5::jsonb, $6, $7, 'normal')
         RETURNING id`,
        [file.originalname, parsed.sheetName ?? '', parsed.totalRows, successCount, JSON.stringify(rowsOut), parsed.contentHash, req.adminUsername],
      );
      return { batchId: batchId.rows[0]!.id, rows: rowsOut, successCount };
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
    const { from, to, site_code, include_exported } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    where.push(`submission_type = 'normal'`);
    if (from) {
      where.push(`application_date >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      where.push(`application_date <= $${idx++}`);
      params.push(to);
    }
    if (site_code) {
      where.push(`site_code = $${idx++}`);
      params.push(normalizeSiteCode(site_code));
    }
    if (!include_exported) {
      where.push('exported_at IS NULL');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await query<SubmissionRow>(
      `SELECT * FROM submissions ${whereSql} ORDER BY application_date ASC, submitted_at ASC`,
      params,
    );
    if (rows.rows.length === 0) {
      res.status(400).json({ error: '沒有符合條件的申報可以匯出' });
      return;
    }

    if (parsed.data.preview) {
      const buffer = await buildSapExportBuffer(rows.rows);
      const previewName = `NDRF_SAP_Preview_${toHKDateString(new Date())}.xlsx`;
      await writeAuditEvent({
        eventType: 'export_preview',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: previewName, count: rows.rows.length, filters: parsed.data, submission_type: 'normal' },
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${previewName}"`);
      res.send(buffer);
      return;
    }

    const filename = `NDRF_SAP_Export_${toHKDateString(new Date())}.xlsx`;
    const exportResult = await withTransaction(async (client) => {
      const lockedRows = await client.query<SubmissionRow>(
        `SELECT * FROM submissions ${whereSql} ORDER BY application_date ASC, submitted_at ASC FOR UPDATE`,
        params,
      );
      if (lockedRows.rows.length === 0) return null;

      const buffer = await buildSapExportBuffer(lockedRows.rows);
      const batch = await client.query<{ id: string }>(
        `INSERT INTO export_batches (filename, submission_count, submission_nos, filters, created_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         RETURNING id`,
        [
          filename,
          lockedRows.rows.length,
          JSON.stringify(lockedRows.rows.map((r) => r.application_no)),
          JSON.stringify(parsed.data),
          req.adminUsername,
        ],
      );
      const batchId = batch.rows[0]!.id;
      await archiveExportBatchFile(client, batchId, filename, buffer, config.exportFileRetentionDays);
      await client.query(
        `UPDATE submissions SET exported_at = now(), export_batch_id = $1, locked_at = now(), updated_at = now()
         WHERE id = ANY($2::uuid[])`,
        [batchId, lockedRows.rows.map((r) => r.id)],
      );
      return { batchId, buffer, count: lockedRows.rows.length };
    });
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
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: '請上載 Excel 檔案' });
      return;
    }
    if (!/\.xlsx$/i.test(file.originalname)) {
      res.status(400).json({ error: EXCEL_UPLOAD_EXTENSION_ERROR });
      return;
    }
    if (file.size > config.maxUploadBytes) {
      res.status(400).json({ error: `檔案超過 ${config.maxUploadBytes / 1024 / 1024}MB 限制` });
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
      const batchId = await client.query<{ id: string }>(
        `INSERT INTO import_batches (filename, sheet_name, row_count, success_count, failed_count, results, content_hash, created_by, submission_type)
         VALUES ($1, $2, $3, $4, 0, $5::jsonb, $6, $7, 'urgent')
         RETURNING id`,
        [file.originalname, parsed.sheetName ?? '', parsed.totalRows, successCount, JSON.stringify(rowsOut), parsed.contentHash, req.adminUsername],
      );
      return { batchId: batchId.rows[0]!.id, rows: rowsOut, successCount };
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
    const { from, to, site_code, include_exported } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    where.push(`submission_type = 'urgent'`);
    if (from) {
      where.push(`application_date >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      where.push(`application_date <= $${idx++}`);
      params.push(to);
    }
    if (site_code) {
      where.push(`site_code = $${idx++}`);
      params.push(normalizeSiteCode(site_code));
    }
    if (!include_exported) {
      where.push('exported_at IS NULL');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await query<SubmissionRow>(
      `SELECT * FROM submissions ${whereSql} ORDER BY application_date ASC, submitted_at ASC`,
      params,
    );
    if (rows.rows.length === 0) {
      res.status(400).json({ error: '沒有符合條件的 Urgent Order 可以匯出' });
      return;
    }

    if (parsed.data.preview) {
      const buffer = await buildUrgentExportBuffer(
        rows.rows.map((r) => ({
          application_no: r.application_no,
          site_code: r.site_code,
          sku: r.sku,
          qty: r.qty,
          urgent_reason: r.urgent_reason,
          urgent_reason_other: r.urgent_reason_other,
        })),
      );
      const previewName = `Urgent_Order_Preview_${toHKDateString(new Date())}.xlsx`;
      await writeAuditEvent({
        eventType: 'export_preview',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: previewName, count: rows.rows.length, filters: parsed.data, submission_type: 'urgent' },
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${previewName}"`);
      res.send(buffer);
      return;
    }

    const filename = `Urgent_Order_Export_${toHKDateString(new Date())}.xlsx`;
    const exportResult = await withTransaction(async (client) => {
      const lockedRows = await client.query<SubmissionRow>(
        `SELECT * FROM submissions ${whereSql} ORDER BY application_date ASC, submitted_at ASC FOR UPDATE`,
        params,
      );
      if (lockedRows.rows.length === 0) return null;

      const buffer = await buildUrgentExportBuffer(
        lockedRows.rows.map((r) => ({
          application_no: r.application_no,
          site_code: r.site_code,
          sku: r.sku,
          qty: r.qty,
          urgent_reason: r.urgent_reason,
          urgent_reason_other: r.urgent_reason_other,
        })),
      );
      const batch = await client.query<{ id: string }>(
        `INSERT INTO export_batches (filename, submission_count, submission_nos, filters, created_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         RETURNING id`,
        [
          filename,
          lockedRows.rows.length,
          JSON.stringify(lockedRows.rows.map((r) => r.application_no)),
          JSON.stringify({ ...parsed.data, submission_type: 'urgent' }),
          req.adminUsername,
        ],
      );
      const batchId = batch.rows[0]!.id;
      await archiveExportBatchFile(client, batchId, filename, buffer, config.exportFileRetentionDays);
      await client.query(
        `UPDATE submissions SET exported_at = now(), export_batch_id = $1, locked_at = now(), updated_at = now()
         WHERE id = ANY($2::uuid[])`,
        [batchId, lockedRows.rows.map((r) => r.id)],
      );
      return { batchId, buffer, count: lockedRows.rows.length };
    });
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
    const buffer = await buildAuditExportBuffer(auditRows.rows as never);
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
    const { from, to, site_code, include_exported } = parsed.data;
    const where: string[] = [`submission_type = 'sales'`];
    const params: unknown[] = [];
    let idx = 1;
    if (from) {
      where.push(`application_date >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      where.push(`application_date <= $${idx++}`);
      params.push(to);
    }
    if (site_code) {
      where.push(`site_code = $${idx++}`);
      params.push(normalizeSiteCode(site_code));
    }
    if (!include_exported) where.push('exported_at IS NULL');

    const rows = await query<SubmissionRow>(
      `SELECT * FROM submissions WHERE ${where.join(' AND ')} ORDER BY application_date ASC, submitted_at ASC`,
      params,
    );
    if (rows.rows.length === 0) {
      res.status(400).json({ error: '沒有符合條件的突發性銷售申報可以匯出' });
      return;
    }

    if (parsed.data.preview) {
      const buffer = await buildSalesExportBuffer(rows.rows.map((row) => ({
        application_date: row.application_date,
        requested_by_email: row.requested_by_email,
        site_code: row.site_code,
        sku: row.sku,
      })));
      const previewName = `Sudden_Sales_Preview_${toHKDateString(new Date())}.xlsx`;
      await writeAuditEvent({
        eventType: 'export_preview',
        actorRole: 'admin',
        actor: req.adminUsername,
        ip: getClientIp(req),
        metadata: { filename: previewName, count: rows.rows.length, filters: parsed.data, submission_type: 'sales' },
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${previewName}"`);
      res.send(buffer);
      return;
    }

    const filename = `Sudden_Sales_Export_${toHKDateString(new Date())}.xlsx`;
    const exportResult = await withTransaction(async (client) => {
      const lockedRows = await client.query<SubmissionRow>(
        `SELECT * FROM submissions WHERE ${where.join(' AND ')} ORDER BY application_date ASC, submitted_at ASC FOR UPDATE`,
        params,
      );
      if (lockedRows.rows.length === 0) return null;

      const buffer = await buildSalesExportBuffer(lockedRows.rows.map((row) => ({
        application_date: row.application_date,
        requested_by_email: row.requested_by_email,
        site_code: row.site_code,
        sku: row.sku,
      })));
      const batch = await client.query<{ id: string }>(
        `INSERT INTO export_batches (filename, submission_count, submission_nos, filters, created_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         RETURNING id`,
        [
          filename,
          lockedRows.rows.length,
          JSON.stringify(lockedRows.rows.map((row) => row.application_no)),
          JSON.stringify({ ...parsed.data, submission_type: 'sales' }),
          req.adminUsername,
        ],
      );
      const batchId = batch.rows[0]!.id;
      await archiveExportBatchFile(client, batchId, filename, buffer, config.exportFileRetentionDays);
      await client.query(
        `UPDATE submissions SET exported_at = now(), export_batch_id = $1, locked_at = now(), updated_at = now()
         WHERE id = ANY($2::uuid[])`,
        [batchId, lockedRows.rows.map((row) => row.id)],
      );
      return { batchId, buffer, count: lockedRows.rows.length };
    });
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
    const { from, to, site_code, include_exported } = parsed.data;
    const where: string[] = [`submission_type = 'return'`];
    const params: unknown[] = [];
    let idx = 1;
    if (from) { where.push(`application_date >= $${idx++}`); params.push(from); }
    if (to) { where.push(`application_date <= $${idx++}`); params.push(to); }
    if (site_code) { where.push(`site_code = $${idx++}`); params.push(normalizeSiteCode(site_code)); }
    if (!include_exported) where.push('exported_at IS NULL');
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const rows = await query<SubmissionRow>(`SELECT * FROM submissions ${whereSql} ORDER BY application_date ASC, submitted_at ASC`, params);
    if (!rows.rows.length) {
      res.status(400).json({ error: '沒有符合條件的行貨退貨報數可以匯出' });
      return;
    }
    const exportRows = (items: SubmissionRow[]) => buildReturnExportBuffer(items.map((row) => ({
      application_no: row.application_no,
      application_date: row.application_date,
      site_code: row.site_code,
      sku: row.sku,
      qty: row.return_qty,
      reason: row.return_reason,
      confirmer_name: row.return_confirmer_name,
      confirmer_phone: row.return_confirmer_phone,
    })));
    if (parsed.data.preview) {
      const buffer = await exportRows(rows.rows);
      const filename = `Return_Goods_Preview_${toHKDateString(new Date())}.xlsx`;
      await writeAuditEvent({ eventType: 'export_preview', actorRole: 'admin', actor: req.adminUsername, ip: getClientIp(req), metadata: { filename, count: rows.rows.length, filters: parsed.data, submission_type: 'return' } });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
      return;
    }
    const filename = `Return_Goods_Export_${toHKDateString(new Date())}.xlsx`;
    const exportResult = await withTransaction(async (client) => {
      const lockedRows = await client.query<SubmissionRow>(`SELECT * FROM submissions ${whereSql} ORDER BY application_date ASC, submitted_at ASC FOR UPDATE`, params);
      if (!lockedRows.rows.length) return null;
      const buffer = await exportRows(lockedRows.rows);
      const batch = await client.query<{ id: string }>(
        `INSERT INTO export_batches (filename, submission_count, submission_nos, filters, created_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5) RETURNING id`,
        [filename, lockedRows.rows.length, JSON.stringify(lockedRows.rows.map((row) => row.application_no)), JSON.stringify({ ...parsed.data, submission_type: 'return' }), req.adminUsername],
      );
      const batchId = batch.rows[0]!.id;
      await archiveExportBatchFile(client, batchId, filename, buffer, config.exportFileRetentionDays);
      await client.query(
        `UPDATE submissions SET exported_at = now(), export_batch_id = $1, locked_at = now(), updated_at = now()
         WHERE id = ANY($2::uuid[])`,
        [batchId, lockedRows.rows.map((row) => row.id)],
      );
      return { batchId, buffer, count: lockedRows.rows.length };
    });
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
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.get('x-csrf-token');
    if (config.csrfEnabled && (!cookieToken || !headerToken || cookieToken !== headerToken)) {
      res.status(403).json({ error: 'CSRF token 無效' });
      return;
    }
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
