import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import {
  adminActionLimiter,
  excelImportLimiter,
  excelExportLimiter,
} from '../middleware/rateLimits.js';
import { asyncHandler, getClientIp } from '../middleware/helpers.js';
import { requireAdmin } from '../middleware/auth.js';
import { writeAuditEvent } from '../lib/audit.js';
import { config } from '../config.js';
import {
  getSubmissionById,
  listVersions,
  adminUpdateSubmission,
  adminUpdateUrgentSubmission,
  type SubmissionRow,
} from '../services/submissions.js';
import { query, withTransaction } from '../db/pool.js';
import {
  generateTemplateWorkbook,
  buildSapExportBuffer,
  buildAuditExportBuffer,
  generateUrgentTemplateWorkbook,
  buildUrgentExportBuffer,
} from '../lib/excelExport.js';
import { parseImportWorkbook, parseUrgentImportWorkbook } from '../lib/excelImport.js';
import { getStore, normalizeSiteCode, parseStoresCsv, replaceStores, listStores } from '../services/stores.js';
import { toHKString, hkTodayForDateColumn } from '../lib/time.js';
import { generateApplicationNo } from '../lib/applicationNo.js';
import { ipExpiryIso } from '../lib/ip.js';
import { URGENT_QTY_MIN, URGENT_QTY_MAX } from '../lib/fields.js';
import { validateBusinessFields } from '../lib/validation.js';

export const adminRouter = Router();

const upload = multer({ storage: multer.memoryStorage() });

adminRouter.get('/me', requireAdmin, (req: Request, res: Response) => {
  res.json({ username: req.adminUsername });
});

const businessFieldsSchema = z.object({
  brand: z.string().max(500).optional().default(''),
  sku: z.string().trim().min(1, 'SKU 為必填').max(100),
  rp_type: z.string().max(100).optional().default(''),
  supply_source: z.string().max(300).optional().default(''),
  safety_stock: z.string().max(100).optional().default(''),
  nd_code: z.string().max(300).optional().default(''),
  rp_parameters_change_request: z.string().max(300).optional().default(''),
  remark: z.string().max(2000).optional().default(''),
});

function serializeAdminSubmission(row: SubmissionRow) {
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
    locked: Boolean(row.locked_at || row.exported_at),
    locked_at: row.locked_at ? toHKString(row.locked_at) : null,
    exported_at: row.exported_at ? toHKString(row.exported_at) : null,
    brand: row.brand,
    sku: row.sku,
    rp_type: row.rp_type,
    supply_source: row.supply_source,
    safety_stock: row.safety_stock,
    nd_code: row.nd_code,
    rp_parameters_change_request: row.rp_parameters_change_request,
    remark: row.remark,
    qty: row.qty,
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
      application_no,
      page = '1',
      page_size = '20',
    } = req.query as Record<string, string | undefined>;

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
    if (submission_type === 'normal' || submission_type === 'urgent') {
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

    res.json({
      total,
      page: pageNum,
      page_size: size,
      total_pages: Math.ceil(total / size),
      submissions: result.rows.map(serializeAdminSubmission),
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
      today: string;
      normal: string;
      urgent: string;
      exported: string;
      unexported: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM submissions) AS total,
         (SELECT count(*)::text FROM submissions WHERE application_date = $1::date) AS today,
         (SELECT count(*)::text FROM submissions WHERE submission_type = 'normal') AS normal,
         (SELECT count(*)::text FROM submissions WHERE submission_type = 'urgent') AS urgent,
         (SELECT count(*)::text FROM submissions WHERE exported_at IS NOT NULL) AS exported,
         (SELECT count(*)::text FROM submissions WHERE exported_at IS NULL) AS unexported`,
      [today],
    );
    const r = rows.rows[0]!;
    res.json({
      total: Number(r.total),
      today: Number(r.today),
      normal: Number(r.normal),
      urgent: Number(r.urgent),
      exported: Number(r.exported),
      unexported: Number(r.unexported),
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

/** PUT /api/admin/submissions/:id — admin edits business fields (normal) or SKU/QTY (urgent). */
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
    if (row.submission_type === 'urgent') {
      const urgentSchema = z.object({
        sku: z.string().trim().min(1, 'SKU 為必填').max(100),
        qty: z
          .number({ invalid_type_error: 'QTY 必須為整數' })
          .int('QTY 必須為整數')
          .min(URGENT_QTY_MIN, `QTY 最少為 ${URGENT_QTY_MIN}`)
          .max(URGENT_QTY_MAX, `QTY 最多為 ${URGENT_QTY_MAX}`),
      });
      const parsed = urgentSchema.safeParse(req.body);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        res.status(400).json({ error: first?.message ?? '輸入資料無效', field: first?.path[0] ?? null });
        return;
      }
      const updated = await adminUpdateUrgentSubmission(row.id, parsed.data.sku, parsed.data.qty, ip, req.adminUsername!);
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
    const updated = await adminUpdateSubmission(
      row.id,
      parsed.data,
      ip,
      req.adminUsername!,
    );
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
    res.setHeader('Content-Disposition', `attachment; filename="00.RP Team_NDRF Request.xlsx"`);
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
      res.status(400).json({ error: '只接受 .xlsx 檔案' });
      return;
    }
    if (file.size > config.maxUploadBytes) {
      res.status(400).json({ error: `檔案超過 ${config.maxUploadBytes / 1024 / 1024}MB 限制` });
      return;
    }

    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));

    const parsed = await parseImportWorkbook(file.buffer, storeCodes, config.maxImportRows);
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
    const results = await withTransaction(async (client) => {
      const rowsOut: Array<{ row: number; application_no: string; site_code: string; sku: string; submitted_at: string }> = [];
      let successCount = 0;
      for (const r of parsed.rows!) {
        const appNo = generateApplicationNo();
        const requestedByEmail = `${r.siteCode.toLowerCase()}@sasa.com`;
        const insert = await client.query<SubmissionRow>(
          `INSERT INTO submissions (
             application_no, source, site_code, requested_by_email, application_date,
             brand, sku, rp_type, supply_source, safety_stock, nd_code,
             rp_parameters_change_request, remark, created_ip, created_ip_expires_at
           ) VALUES ($1,'excel',$2,$3,to_char(now() AT TIME ZONE 'Asia/Hong_Kong','YYYY-MM-DD')::date,
             $4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
          [
            appNo,
            r.siteCode,
            requestedByEmail,
            r.fields.brand,
            r.fields.sku,
            r.fields.rp_type,
            r.fields.supply_source,
            r.fields.safety_stock,
            r.fields.nd_code,
            r.fields.rp_parameters_change_request,
            r.fields.remark,
            ip,
            ip ? ipExpiryIso() : null,
          ],
        );
        const row = insert.rows[0]!;
        await client.query(
          `INSERT INTO submission_versions
             (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
           VALUES ($1, 1, NULL, $2, 'applicant', $3, $4, 'excel_import')`,
          [row.id, JSON.stringify(r.fields), req.adminUsername, ip],
        );
        successCount++;
        rowsOut.push({
          row: r.rowNumber,
          application_no: row.application_no,
          site_code: row.site_code,
          sku: row.sku,
          submitted_at: toHKString(row.submitted_at),
        });
      }
      const batchId = await client.query<{ id: string }>(
        `INSERT INTO import_batches (filename, sheet_name, row_count, success_count, failed_count, results, content_hash, created_by)
         VALUES ($1, $2, $3, $4, 0, $5::jsonb, $6, $7)
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

const exportFiltersSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  site_code: z.string().optional(),
  include_exported: z.coerce.boolean().optional().default(false),
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

    // Generate the file first; only lock on success.
    const buffer = await buildSapExportBuffer(rows.rows);

    const filename = `NDRF_SAP_Export_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const batchResult = await withTransaction(async (client) => {
      const batch = await client.query<{ id: string }>(
        `INSERT INTO export_batches (filename, submission_count, submission_nos, filters, created_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         RETURNING id`,
        [
          filename,
          rows.rows.length,
          JSON.stringify(rows.rows.map((r) => r.application_no)),
          JSON.stringify(parsed.data),
          req.adminUsername,
        ],
      );
      await client.query(
        `UPDATE submissions SET exported_at = now(), export_batch_id = $1, locked_at = now(), updated_at = now()
         WHERE id = ANY($2::uuid[])`,
        [batch.rows[0]!.id, rows.rows.map((r) => r.id)],
      );
      return batch.rows[0]!.id;
    });

    await writeAuditEvent({
      eventType: 'export_created',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batchId: batchResult, filename, count: rows.rows.length },
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
      res.status(400).json({ error: '只接受 .xlsx 檔案' });
      return;
    }
    if (file.size > config.maxUploadBytes) {
      res.status(400).json({ error: `檔案超過 ${config.maxUploadBytes / 1024 / 1024}MB 限制` });
      return;
    }

    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));

    const parsed = await parseUrgentImportWorkbook(file.buffer, storeCodes, config.maxImportRows);
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
    const results = await withTransaction(async (client) => {
      const rowsOut: Array<{ row: number; application_no: string; site_code: string; sku: string; qty: number; submitted_at: string }> = [];
      let successCount = 0;
      for (const r of parsed.rows!) {
        const appNo = generateApplicationNo('URGENT');
        const requestedByEmail = `${r.siteCode.toLowerCase()}@sasa.com`;
        const insert = await client.query<SubmissionRow>(
          `INSERT INTO submissions (
             application_no, source, submission_type, site_code, requested_by_email, application_date,
             brand, sku, qty, created_ip, created_ip_expires_at
           ) VALUES ($1,'excel','urgent',$2,$3,to_char(now() AT TIME ZONE 'Asia/Hong_Kong','YYYY-MM-DD')::date,
             '',$4,$5,$6,$7)
           RETURNING *`,
          [appNo, r.siteCode, requestedByEmail, r.sku, r.qty, ip, ip ? ipExpiryIso() : null],
        );
        const row = insert.rows[0]!;
        await client.query(
          `INSERT INTO submission_versions
             (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
           VALUES ($1, 1, NULL, $2, 'admin', $3, $4, 'excel_import')`,
          [row.id, JSON.stringify({ site_code: r.siteCode, sku: r.sku, qty: r.qty }), req.adminUsername, ip],
        );
        successCount++;
        rowsOut.push({
          row: r.rowNumber,
          application_no: row.application_no,
          site_code: row.site_code,
          sku: row.sku,
          qty: row.qty as number,
          submitted_at: toHKString(row.submitted_at),
        });
      }
      const batchId = await client.query<{ id: string }>(
        `INSERT INTO import_batches (filename, sheet_name, row_count, success_count, failed_count, results, content_hash, created_by)
         VALUES ($1, $2, $3, $4, 0, $5::jsonb, $6, $7)
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

    const buffer = await buildUrgentExportBuffer(
      rows.rows.map((r) => ({
        application_no: r.application_no,
        site_code: r.site_code,
        sku: r.sku,
        qty: r.qty,
      })),
    );

    const filename = `Urgent_Order_Export_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const batchResult = await withTransaction(async (client) => {
      const batch = await client.query<{ id: string }>(
        `INSERT INTO export_batches (filename, submission_count, submission_nos, filters, created_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         RETURNING id`,
        [
          filename,
          rows.rows.length,
          JSON.stringify(rows.rows.map((r) => r.application_no)),
          JSON.stringify({ ...parsed.data, submission_type: 'urgent' }),
          req.adminUsername,
        ],
      );
      await client.query(
        `UPDATE submissions SET exported_at = now(), export_batch_id = $1, locked_at = now(), updated_at = now()
         WHERE id = ANY($2::uuid[])`,
        [batch.rows[0]!.id, rows.rows.map((r) => r.id)],
      );
      return batch.rows[0]!.id;
    });

    await writeAuditEvent({
      eventType: 'export_created',
      actorRole: 'admin',
      actor: req.adminUsername,
      ip: getClientIp(req),
      metadata: { batchId: batchResult, filename, count: rows.rows.length, submission_type: 'urgent' },
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
    res.setHeader('Content-Disposition', `attachment; filename="NDRF_Audit_Report_${new Date().toISOString().slice(0, 10)}.xlsx"`);
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
      `SELECT id, filename, sheet_name, row_count, success_count, failed_count, created_by, created_at
       FROM import_batches ORDER BY created_at DESC LIMIT 50`,
    );
    const exports = await query(
      `SELECT id, filename, submission_count, filters, created_by, created_at
       FROM export_batches ORDER BY created_at DESC LIMIT 50`,
    );
    res.json({
      imports: imports.rows,
      exports: exports.rows.map((r) => ({ ...r, created_at: toHKString(r.created_at as string) })),
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
    const content = file.buffer.toString('utf8');
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

