import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import {
  publicSubmitLimiter,
  publicLookupLimiter,
  excelImportLimiter,
  excelExportLimiter,
} from '../middleware/rateLimits.js';
import { asyncHandler, getClientIp } from '../middleware/helpers.js';
import { getStore, normalizeSiteCode } from '../services/stores.js';
import {
  createSubmission,
  getSubmissionByApplicationNo,
  listVersions,
  modifySubmission,
  modifyUrgentSubmission,
  modifySalesSubmission,
  LockedError,
  NotSupportedError,
  DuplicateSubmissionError,
  lockDuplicateSubmissionKeys,
  assertNoDuplicate,
  type SubmissionRow,
} from '../services/submissions.js';
import { writeAuditEvent } from '../lib/audit.js';
import { toHKString, hkTodayForDateColumn, hkMinutesNow, hkHM } from '../lib/time.js';
import {
  parseImportWorkbook,
  parseUrgentImportWorkbook,
  parseSalesImportWorkbook,
  findDuplicateImportErrors,
  EXCEL_UPLOAD_EXTENSION_ERROR,
} from '../lib/excelImport.js';
import { generateTemplateWorkbook, generateUrgentTemplateWorkbook, generateSalesTemplateWorkbook, buildImportRecordBuffer, buildUrgentImportRecordBuffer, buildSalesImportRecordBuffer } from '../lib/excelExport.js';
import { URGENT_QTY_MIN, URGENT_QTY_MAX, urgentReasonLabel } from '../lib/fields.js';
import { RF_REMARK_REQUIRED_SITES, SKU_PATTERN, SKU_ERROR, validateBusinessFields, validateUrgentReason } from '../lib/validation.js';
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { generateApplicationNo } from '../lib/applicationNo.js';
import { ipExpiryIso } from '../lib/ip.js';

export const publicRouter = Router();

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

const URGENT_SUBMIT_CUTOFF_MINUTES = 14 * 60 + 30; // 每日 14:30（香港時間）後暫停收單
const URGENT_SUBMIT_CUTOFF_LABEL = '14:30';
const URGENT_WINDOW_CLOSED_ERROR = `Urgent Order 提交時間已截止（每日 ${URGENT_SUBMIT_CUTOFF_LABEL} 後暫停收單），請於翌日 ${URGENT_SUBMIT_CUTOFF_LABEL} 前提交`;
const URGENT_MODIFY_CLOSED_ERROR = `Urgent Order 修改時間已截止（每日 ${URGENT_SUBMIT_CUTOFF_LABEL} 後暫停修改），請於翌日 ${URGENT_SUBMIT_CUTOFF_LABEL} 前修改`;

function isUrgentWindowOpen(): boolean {
  return hkMinutesNow() < URGENT_SUBMIT_CUTOFF_MINUTES;
}

const businessFieldSchema = z.object({
  brand: z.string().max(500).optional().default(''),
  sku: z.string().trim().min(1, 'SKU 為必填').regex(SKU_PATTERN, SKU_ERROR),
  rp_type: z.string().max(100).optional().default(''),
  safety_stock: z.string().max(100).optional().default(''),
  nd_code: z.string().max(300).optional().default(''),
  remark: z.string().max(2000).optional().default(''),
});

const submitSchema = z.object({
  site_code: z.string().trim().min(1, 'Site Code 為必填').max(20),
  ...businessFieldSchema.shape,
});

function serializeSubmission(row: SubmissionRow) {
  return {
    application_no: row.application_no,
    site_code: row.site_code,
    requested_by_email: row.requested_by_email,
    application_date: row.application_date,
    submitted_at: toHKString(row.submitted_at),
    source: row.source,
    submission_type: row.submission_type,
    status: row.status,
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
  };
}

function serializeUrgentSubmission(row: SubmissionRow) {
  return {
    application_no: row.application_no,
    site_code: row.site_code,
    requested_by_email: row.requested_by_email,
    application_date: row.application_date,
    submitted_at: toHKString(row.submitted_at),
    source: row.source,
    submission_type: row.submission_type,
    status: row.status,
    locked: Boolean(row.locked_at || row.exported_at),
    locked_at: row.locked_at ? toHKString(row.locked_at) : null,
    exported_at: row.exported_at ? toHKString(row.exported_at) : null,
    sku: row.sku,
    qty: row.qty,
    urgent_reason: row.urgent_reason,
    urgent_reason_label: urgentReasonLabel(row.urgent_reason),
    urgent_reason_other: row.urgent_reason_other,
  };
}

function serializeSalesSubmission(row: SubmissionRow) {
  return {
    application_no: row.application_no,
    site_code: row.site_code,
    requested_by_email: row.requested_by_email,
    application_date: row.application_date,
    submitted_at: toHKString(row.submitted_at),
    source: row.source,
    submission_type: row.submission_type,
    status: row.status,
    locked: Boolean(row.locked_at || row.exported_at),
    locked_at: row.locked_at ? toHKString(row.locked_at) : null,
    exported_at: row.exported_at ? toHKString(row.exported_at) : null,
    sku: row.sku,
    qty: row.qty,
  };
}

/** GET /api/public/stores?q=  — Site Code search with store name. */
publicRouter.get(
  '/stores',
  publicLookupLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').trim();
    const result = await query<{ site_code: string; shop: string }>(
      `SELECT site_code, shop FROM stores
       WHERE site_code ILIKE $1 OR shop ILIKE $1
       ORDER BY site_code LIMIT 50`,
      [`%${q.toUpperCase()}%`],
    );
    res.json({ stores: result.rows });
  }),
);

/** GET /api/public/stores/:site_code — validate one Site Code. */
publicRouter.get(
  '/stores/:siteCode',
  publicLookupLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const store = await getStore(req.params.siteCode as string);
    if (!store) {
      res.status(404).json({ error: 'Site Code 不存在' });
      return;
    }
    res.json({
      store: {
        site_code: store.site_code,
        shop: store.shop,
        requested_by_email: `${store.site_code.toLowerCase()}@sasa.com`,
      },
    });
  }),
);

/** GET /api/public/rf-remark-required-stores — stores requiring Remark for RF. */
publicRouter.get(
  '/rf-remark-required-stores',
  publicLookupLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const siteCodes = [...RF_REMARK_REQUIRED_SITES];
    const result = await query<{ site_code: string; shop: string }>(
      `SELECT site_code, shop FROM stores WHERE site_code = ANY($1::text[])`,
      [siteCodes],
    );
    const storesByCode = new Map(result.rows.map((store) => [store.site_code, store]));
    res.json({
      stores: siteCodes.map((siteCode) => storesByCode.get(siteCode) ?? { site_code: siteCode, shop: '' }),
    });
  }),
);

/** POST /api/public/submit — single web submission. */
publicRouter.post(
  '/submit',
  publicSubmitLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({
        error: first?.message ?? '輸入資料無效',
        field: first?.path[0] ?? null,
      });
      return;
    }
    const data = parsed.data;
    const siteCode = normalizeSiteCode(data.site_code);
    const store = await getStore(siteCode);
    if (!store) {
      res.status(400).json({ error: `Site Code「${siteCode}」不存在於門店主檔`, field: 'site_code' });
      return;
    }

    const businessFields = {
      brand: data.brand,
      sku: data.sku,
      rp_type: data.rp_type,
      safety_stock: data.safety_stock,
      nd_code: data.nd_code,
      remark: data.remark,
    };
    const businessErrors = validateBusinessFields(businessFields, siteCode);
    if (businessErrors.length) {
      res.status(400).json({
        error: businessErrors[0]!.message,
        field: businessErrors[0]!.field,
        errors: businessErrors,
      });
      return;
    }

    const ip = getClientIp(req);
    let row: SubmissionRow;
    try {
      row = await createSubmission({
        siteCode,
        source: 'web',
        fields: businessFields,
        ip,
        changeSource: 'web_submit',
      });
    } catch (err) {
      if (err instanceof DuplicateSubmissionError) {
        res.status(409).json({ error: err.message, field: 'sku' });
        return;
      }
      throw err;
    }

    await writeAuditEvent({
      eventType: 'submission_created',
      actorRole: 'applicant',
      submissionId: row.id,
      applicationNo: row.application_no,
      ip,
      metadata: { source: 'web', shop: store.shop },
    });

    res.status(201).json({ submission: serializeSubmission(row), store: { shop: store.shop } });
  }),
);

const salesSubmitSchema = z.object({
  site_code: z.string().trim().min(1, 'Site Code 為必填').max(20),
  sku: z.string().trim().min(1, 'SKU 為必填').regex(SKU_PATTERN, SKU_ERROR),
});

/** POST /api/public/sales/submit — sudden sales single web submission. */
publicRouter.post(
  '/sales/submit',
  publicSubmitLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = salesSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({ error: first?.message ?? '輸入資料無效', field: first?.path[0] ?? null });
      return;
    }
    const siteCode = normalizeSiteCode(parsed.data.site_code);
    const store = await getStore(siteCode);
    if (!store) {
      res.status(400).json({ error: `Site Code「${siteCode}」不存在於門店主檔`, field: 'site_code' });
      return;
    }

    const ip = getClientIp(req);
    let row: SubmissionRow;
    try {
      row = await createSubmission({
        siteCode,
        source: 'web',
        submissionType: 'sales',
        fields: { brand: '', sku: parsed.data.sku, rp_type: '', safety_stock: '', nd_code: '', remark: '' },
        ip,
        changeSource: 'web_submit',
      });
    } catch (err) {
      if (err instanceof DuplicateSubmissionError) {
        res.status(409).json({ error: err.message, field: 'sku' });
        return;
      }
      throw err;
    }

    await writeAuditEvent({
      eventType: 'submission_created',
      actorRole: 'applicant',
      submissionId: row.id,
      applicationNo: row.application_no,
      ip,
      metadata: { source: 'web', submission_type: 'sales', shop: store.shop },
    });
    res.status(201).json({ submission: serializeSalesSubmission(row), store: { shop: store.shop } });
  }),
);

/** GET /api/public/sales/template — download sudden sales import template. */
publicRouter.get(
  '/sales/template',
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const buffer = await generateSalesTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Sudden_Sales_Template.xlsx"');
    res.send(buffer);
  }),
);

/** POST /api/public/sales/import — sudden sales Excel batch upload. */
publicRouter.post(
  '/sales/import',
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
    const parsed = await parseSalesImportWorkbook(file.buffer, storeCodes, config.maxImportRows);
    if (!parsed.ok || !parsed.rows) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'applicant',
        ip: getClientIp(req),
        metadata: { filename: file.originalname, submission_type: 'sales', errors: parsed.errors ?? [] },
      });
      res.status(400).json({ error: '匯入失敗', totalRows: parsed.totalRows, errors: parsed.errors ?? [] });
      return;
    }

    const existing = await query<{ site_code: string; sku: string }>(
      `SELECT site_code, sku FROM submissions
       WHERE application_date = $1::date AND submission_type = 'sales'`,
      [hkTodayForDateColumn()],
    );
    const existingKeys = new Set(existing.rows.map((s) => `${s.site_code}|${s.sku}`));
    const dupErrors = findDuplicateImportErrors(
      parsed.rows.map((r) => ({ rowNumber: r.rowNumber, siteCode: r.siteCode, sku: r.sku })),
      existingKeys,
    );
    if (dupErrors.length) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'applicant',
        ip: getClientIp(req),
        metadata: { filename: file.originalname, submission_type: 'sales', errors: dupErrors },
      });
      res.status(400).json({ error: '匯入失敗', totalRows: parsed.totalRows, errors: dupErrors });
      return;
    }

    const ip = getClientIp(req);
    const applicationDate = hkTodayForDateColumn();
    let results;
    try {
      results = await withTransaction(async (client) => {
        await lockDuplicateSubmissionKeys(client, parsed.rows!.map((r) => ({
          siteCode: r.siteCode,
          sku: r.sku,
          submissionType: 'sales' as const,
          date: applicationDate,
        })));
        const seen = new Set<string>();
        const rowsOut: Array<{
          row: number;
          application_no: string;
          site_code: string;
          sku: string;
          submitted_at: string;
        }> = [];
        for (const item of parsed.rows!) {
          const duplicateKey = `${item.siteCode}|${item.sku}`;
          if (seen.has(duplicateKey)) throw new DuplicateSubmissionError();
          seen.add(duplicateKey);
          await assertNoDuplicate(client, {
            siteCode: item.siteCode,
            sku: item.sku,
            submissionType: 'sales',
            date: applicationDate,
          });
          const appNo = generateApplicationNo('SALES');
          const requestedByEmail = `${item.siteCode.toLowerCase()}@sasa.com`;
          const insert = await client.query<SubmissionRow>(
            `INSERT INTO submissions (
               application_no, source, submission_type, site_code, requested_by_email, application_date,
               brand, sku, rp_type, safety_stock, nd_code, remark, qty, created_ip, created_ip_expires_at
             ) VALUES ($1, 'excel', 'sales', $2, $3, $4,
               '', $5, NULL, NULL, NULL, NULL, NULL, $6, $7)
             RETURNING *`,
            [appNo, item.siteCode, requestedByEmail, applicationDate, item.sku, ip, ip ? ipExpiryIso() : null],
          );
          const row = insert.rows[0]!;
          await client.query(
            `INSERT INTO submission_versions
               (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
             VALUES ($1, 1, NULL, $2, 'applicant', NULL, $3, 'excel_import')`,
            [row.id, JSON.stringify({ site_code: item.siteCode, sku: item.sku }), ip],
          );
          rowsOut.push({
            row: item.rowNumber,
            application_no: row.application_no,
            site_code: row.site_code,
            sku: row.sku,
            submitted_at: toHKString(row.submitted_at),
          });
        }
        const batch = await client.query<{ id: string }>(
          `INSERT INTO import_batches (filename, sheet_name, row_count, success_count, failed_count, results, content_hash, created_by)
           VALUES ($1, $2, $3, $4, 0, $5::jsonb, $6, 'applicant')
           RETURNING id`,
          [file.originalname, parsed.sheetName ?? '', parsed.totalRows, rowsOut.length, JSON.stringify(rowsOut), parsed.contentHash],
        );
        return { batchId: batch.rows[0]!.id, rows: rowsOut, successCount: rowsOut.length };
      });
    } catch (err) {
      if (err instanceof DuplicateSubmissionError) {
        res.status(409).json({ error: err.message, field: 'sku' });
        return;
      }
      throw err;
    }

    await writeAuditEvent({
      eventType: 'excel_import',
      actorRole: 'applicant',
      ip,
      metadata: {
        filename: file.originalname,
        submission_type: 'sales',
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

const salesImportRecordSchema = z.object({
  rows: z.array(z.object({
    row: z.number(),
    application_no: z.string().max(64),
    site_code: z.string().max(20),
    sku: z.string().max(100),
    submitted_at: z.string().max(64),
  })).min(1).max(config.maxImportRows),
});

/** POST /api/public/sales/import/record — download sudden sales import record. */
publicRouter.post(
  '/sales/import/record',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = salesImportRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '資料格式錯誤' });
      return;
    }
    const buffer = await buildSalesImportRecordBuffer(parsed.data.rows);
    const stamp = toHKString(new Date()).replace(/[^0-9]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Sudden_Sales_Import_Record_${stamp}.xlsx"`);
    res.send(buffer);
  }),
);

const urgentSubmitSchema = z.object({
  site_code: z.string().trim().min(1, 'Site Code 為必填').max(20),
  sku: z.string().trim().min(1, 'SKU 為必填').regex(SKU_PATTERN, SKU_ERROR),
  qty: z
    .number({ invalid_type_error: 'QTY 必須為整數' })
    .int('QTY 必須為整數')
    .min(URGENT_QTY_MIN, `QTY 最少為 ${URGENT_QTY_MIN}`)
    .max(URGENT_QTY_MAX, `QTY 最多為 ${URGENT_QTY_MAX}`),
  urgent_reason: z.string().trim().max(100).optional().default(''),
  urgent_reason_other: z.string().max(2000).optional().default(''),
});

/** POST /api/public/urgent/submit — single Urgent Order web submission. */
publicRouter.post(
  '/urgent/submit',
  publicSubmitLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!isUrgentWindowOpen()) {
      res.status(400).json({ error: URGENT_WINDOW_CLOSED_ERROR, field: null });
      return;
    }
    const parsed = urgentSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({
        error: first?.message ?? '輸入資料無效',
        field: first?.path[0] ?? null,
      });
      return;
    }
    const data = parsed.data;
    const siteCode = normalizeSiteCode(data.site_code);
    const store = await getStore(siteCode);
    if (!store) {
      res.status(400).json({ error: `Site Code「${siteCode}」不存在於門店主檔`, field: 'site_code' });
      return;
    }

    const reasonErrors = validateUrgentReason(data.urgent_reason, data.urgent_reason_other);
    if (reasonErrors.length) {
      res.status(400).json({
        error: reasonErrors[0]!.message,
        field: reasonErrors[0]!.field,
        errors: reasonErrors,
      });
      return;
    }

    const ip = getClientIp(req);
    let row: SubmissionRow;
    try {
      row = await createSubmission({
        siteCode,
        source: 'web',
        submissionType: 'urgent',
        fields: { brand: '', sku: data.sku, rp_type: '', safety_stock: '', nd_code: '', remark: '' },
        qty: data.qty,
        urgentReason: data.urgent_reason,
        urgentReasonOther: data.urgent_reason_other,
        ip,
        changeSource: 'web_submit',
      });
    } catch (err) {
      if (err instanceof DuplicateSubmissionError) {
        res.status(409).json({ error: err.message, field: 'sku' });
        return;
      }
      throw err;
    }

    await writeAuditEvent({
      eventType: 'submission_created',
      actorRole: 'applicant',
      submissionId: row.id,
      applicationNo: row.application_no,
      ip,
      metadata: { source: 'web', submission_type: 'urgent', shop: store.shop },
    });

    res.status(201).json({ submission: serializeUrgentSubmission(row), store: { shop: store.shop } });
  }),
);

/** GET /api/public/urgent/window — current Urgent Order submission window status. */
publicRouter.get(
  '/urgent/window',
  publicLookupLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      open: isUrgentWindowOpen(),
      cutoff: URGENT_SUBMIT_CUTOFF_LABEL,
      timezone: config.timezone,
      now: hkHM(),
      message: URGENT_WINDOW_CLOSED_ERROR,
    });
  }),
);

/** GET /api/public/urgent/template — download Urgent import template. */
publicRouter.get(
  '/urgent/template',
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const buffer = await generateUrgentTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Urgent Order Template.xlsx"`);
    res.send(buffer);
  }),
);

/** POST /api/public/urgent/import — Excel batch upload for Urgent Orders. */
publicRouter.post(
  '/urgent/import',
  excelImportLimiter,
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isUrgentWindowOpen()) {
      res.status(400).json({ error: URGENT_WINDOW_CLOSED_ERROR, field: null });
      return;
    }
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

    const parsed = await parseUrgentImportWorkbook(file.buffer, storeCodes, config.maxImportRows);
    if (!parsed.ok || !parsed.rows) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'applicant',
        ip: getClientIp(req),
        metadata: {
          filename: file.originalname,
          submission_type: 'urgent',
          errors: parsed.errors ?? [],
        },
      });
      res.status(400).json({
        error: '匯入失敗',
        totalRows: parsed.totalRows,
        errors: parsed.errors ?? [],
      });
      return;
    }

    const existing = await query<{ site_code: string; sku: string }>(
      `SELECT site_code, sku FROM submissions
       WHERE application_date = $1::date AND submission_type = 'urgent'`,
      [hkTodayForDateColumn()],
    );
    const existingKeys = new Set(existing.rows.map((s) => `${s.site_code}|${s.sku}`));
    const dupErrors = findDuplicateImportErrors(
      parsed.rows.map((r) => ({ rowNumber: r.rowNumber, siteCode: r.siteCode, sku: r.sku })),
      existingKeys,
    );
    if (dupErrors.length) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'applicant',
        ip: getClientIp(req),
        metadata: { filename: file.originalname, submission_type: 'urgent', errors: dupErrors },
      });
      res.status(400).json({
        error: '匯入失敗',
        totalRows: parsed.totalRows,
        errors: dupErrors,
      });
      return;
    }

    const ip = getClientIp(req);
    const applicationDate = hkTodayForDateColumn();
    let results;
    try {
      results = await withTransaction(async (client) => {
        await lockDuplicateSubmissionKeys(client, parsed.rows!.map((r) => ({
          siteCode: r.siteCode,
          sku: r.sku,
          submissionType: 'urgent' as const,
          date: applicationDate,
        })));
        const seen = new Set<string>();
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
          const duplicateKey = `${r.siteCode}|${r.sku}`;
          if (seen.has(duplicateKey)) throw new DuplicateSubmissionError();
          seen.add(duplicateKey);
          await assertNoDuplicate(client, {
            siteCode: r.siteCode,
            sku: r.sku,
            submissionType: 'urgent',
            date: applicationDate,
          });
          const appNo = generateApplicationNo('URGENT');
          const requestedByEmail = `${r.siteCode.toLowerCase()}@sasa.com`;
          const insert = await client.query<SubmissionRow>(
            `INSERT INTO submissions (
               application_no, source, submission_type, site_code, requested_by_email, application_date,
               brand, sku, qty, urgent_reason, urgent_reason_other, created_ip, created_ip_expires_at
             ) VALUES ($1,'excel','urgent',$2,$3,$4,'',$5,$6,$7,$8,$9,$10)
             RETURNING *`,
            [appNo, r.siteCode, requestedByEmail, applicationDate, r.sku, r.qty, r.urgentReason || null, r.urgentReasonOther || null, ip, ip ? ipExpiryIso() : null],
          );
          const row = insert.rows[0]!;
          await client.query(
            `INSERT INTO submission_versions
               (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
             VALUES ($1, 1, NULL, $2, 'applicant', NULL, $3, 'excel_import')`,
            [
              row.id,
              JSON.stringify({
                site_code: r.siteCode,
                sku: r.sku,
                qty: r.qty,
                urgent_reason: r.urgentReason || null,
                urgent_reason_other: r.urgentReasonOther || null,
              }),
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
          `INSERT INTO import_batches (filename, sheet_name, row_count, success_count, failed_count, results, content_hash, created_by)
           VALUES ($1, $2, $3, $4, 0, $5::jsonb, $6, 'applicant')
           RETURNING id`,
          [file.originalname, parsed.sheetName ?? '', parsed.totalRows, successCount, JSON.stringify(rowsOut), parsed.contentHash],
        );
        return { batchId: batchId.rows[0]!.id, rows: rowsOut, successCount };
      });
    } catch (err) {
      if (err instanceof DuplicateSubmissionError) {
        res.status(409).json({ error: err.message, field: 'sku' });
        return;
      }
      throw err;
    }

    await writeAuditEvent({
      eventType: 'excel_import',
      actorRole: 'applicant',
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

const urgentImportRecordSchema = z.object({
  rows: z
    .array(
      z.object({
        row: z.number(),
        application_no: z.string().max(64),
        site_code: z.string().max(20),
        sku: z.string().max(100),
        qty: z.number(),
        urgent_reason: z.string().max(100).optional().default(''),
        urgent_reason_other: z.string().max(2000).optional().default(''),
        submitted_at: z.string().max(64),
      }),
    )
    .min(1)
    .max(config.maxImportRows),
});

/** POST /api/public/urgent/import/record — download the just-imported urgent rows as an Excel record (one sheet per store). */
publicRouter.post(
  '/urgent/import/record',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = urgentImportRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '資料格式錯誤' });
      return;
    }
    const buffer = await buildUrgentImportRecordBuffer(parsed.data.rows);
    const stamp = toHKString(new Date()).replace(/[^0-9]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Urgent_Import_Record_${stamp}.xlsx"`);
    res.send(buffer);
  }),
);

/** GET /api/public/template — download import template. */
publicRouter.get(
  '/template',
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const buffer = await generateTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Safety Request.xlsx"`);
    res.send(buffer);
  }),
);

/** POST /api/public/import — Excel batch upload. */
publicRouter.post(
  '/import',
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

    const parsed = await parseImportWorkbook(file.buffer, storeCodes, config.maxImportRows);
    if (!parsed.ok || !parsed.rows) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'applicant',
        ip: getClientIp(req),
        metadata: {
          filename: file.originalname,
          errors: parsed.errors ?? [],
        },
      });
      res.status(400).json({
        error: '匯入失敗',
        totalRows: parsed.totalRows,
        errors: parsed.errors ?? [],
      });
      return;
    }

    const existing = await query<{ site_code: string; sku: string }>(
      `SELECT site_code, sku FROM submissions
       WHERE application_date = $1::date AND submission_type = 'normal'`,
      [hkTodayForDateColumn()],
    );
    const existingKeys = new Set(existing.rows.map((s) => `${s.site_code}|${s.sku}`));
    const dupErrors = findDuplicateImportErrors(
      parsed.rows.map((r) => ({ rowNumber: r.rowNumber, siteCode: r.siteCode, sku: r.fields.sku })),
      existingKeys,
    );
    if (dupErrors.length) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'applicant',
        ip: getClientIp(req),
        metadata: { filename: file.originalname, errors: dupErrors },
      });
      res.status(400).json({
        error: '匯入失敗',
        totalRows: parsed.totalRows,
        errors: dupErrors,
      });
      return;
    }

    const ip = getClientIp(req);
    const applicationDate = hkTodayForDateColumn();
    let results;
    try {
      results = await withTransaction(async (client) => {
        await lockDuplicateSubmissionKeys(client, parsed.rows!.map((r) => ({
          siteCode: r.siteCode,
          sku: r.fields.sku,
          submissionType: 'normal' as const,
          date: applicationDate,
        })));
        const seen = new Set<string>();
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
          const duplicateKey = `${r.siteCode}|${r.fields.sku}`;
          if (seen.has(duplicateKey)) throw new DuplicateSubmissionError();
          seen.add(duplicateKey);
          await assertNoDuplicate(client, {
            siteCode: r.siteCode,
            sku: r.fields.sku,
            submissionType: 'normal',
            date: applicationDate,
          });
          const appNo = generateApplicationNo();
          const requestedByEmail = `${r.siteCode.toLowerCase()}@sasa.com`;
          const insert = await client.query<SubmissionRow>(
            `INSERT INTO submissions (
               application_no, source, site_code, requested_by_email, application_date,
               brand, sku, rp_type, safety_stock, nd_code, remark, created_ip, created_ip_expires_at
             ) VALUES ($1,'excel',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
             VALUES ($1, 1, NULL, $2, 'applicant', NULL, $3, 'excel_import')`,
            [row.id, JSON.stringify(r.fields), ip],
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
          `INSERT INTO import_batches (filename, sheet_name, row_count, success_count, failed_count, results, content_hash, created_by)
           VALUES ($1, $2, $3, $4, 0, $5::jsonb, $6, 'applicant')
           RETURNING id`,
          [
            file.originalname,
            parsed.sheetName ?? '',
            parsed.totalRows,
            successCount,
            JSON.stringify(rowsOut),
            parsed.contentHash,
          ],
        );
        return { batchId: batchId.rows[0]!.id, rows: rowsOut, successCount };
      });
    } catch (err) {
      if (err instanceof DuplicateSubmissionError) {
        res.status(409).json({ error: err.message, field: 'sku' });
        return;
      }
      throw err;
    }

    await writeAuditEvent({
      eventType: 'excel_import',
      actorRole: 'applicant',
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

const importRecordSchema = z.object({
  rows: z
    .array(
      z.object({
        row: z.number(),
        application_no: z.string().max(64),
        site_code: z.string().max(20),
        sku: z.string().max(100),
        rp_type: z.string().max(100).optional().default(''),
        safety_stock: z.string().max(100).optional().default(''),
        nd_code: z.string().max(300).optional().default(''),
        remark: z.string().max(2000).optional().default(''),
        submitted_at: z.string().max(64),
      }),
    )
    .min(1)
    .max(config.maxImportRows),
});

/** POST /api/public/import/record — download the just-imported rows as an Excel record (one sheet per store). */
publicRouter.post(
  '/import/record',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = importRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '資料格式錯誤' });
      return;
    }
    const buffer = await buildImportRecordBuffer(parsed.data.rows);
    const stamp = toHKString(new Date()).replace(/[^0-9]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="NDRF_Import_Record_${stamp}.xlsx"`);
    res.send(buffer);
  }),
);

/** GET /api/public/query?application_no=&site_code= — view submission. */
publicRouter.get(
  '/query',
  publicLookupLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const applicationNo = String(req.query.application_no ?? '').trim().toUpperCase();
    const siteCode = normalizeSiteCode(String(req.query.site_code ?? ''));

    if (!applicationNo || !siteCode) {
      res.status(400).json({ error: '申請編號及 Site Code 為必填' });
      return;
    }

    const row = await getSubmissionByApplicationNo(applicationNo, siteCode);
    if (!row) {
      // Do not reveal whether an application number exists.
      await writeAuditEvent({
        eventType: 'submission_queried',
        actorRole: 'applicant',
        ip: getClientIp(req),
        metadata: { found: false },
      });
      res.status(404).json({ error: '找不到相符申報，請檢查申請編號及 Site Code' });
      return;
    }

    const store = await getStore(row.site_code);
    const versions = await listVersions(row.id);
    await writeAuditEvent({
      eventType: 'submission_queried',
      actorRole: 'applicant',
      submissionId: row.id,
      applicationNo: row.application_no,
      ip: getClientIp(req),
      metadata: { found: true, submission_type: row.submission_type },
    });

    res.json({
      submission:
        row.submission_type === 'urgent'
          ? serializeUrgentSubmission(row)
          : row.submission_type === 'sales'
            ? serializeSalesSubmission(row)
            : serializeSubmission(row),
      store: { shop: store?.shop ?? '', requested_by_email: row.requested_by_email },
      versions: versions.map((v) => ({
        version: v.version,
        actor_role: v.actor_role,
        change_source: v.change_source,
        changed_at: toHKString(v.changed_at as string),
        data_before: v.data_before,
        data_after: v.data_after,
      })),
    });
  }),
);

const modifySchema = z.object({
  application_no: z.string().trim().min(1).max(40),
  site_code: z.string().trim().min(1).max(20),
  ...businessFieldSchema.shape,
  qty: z
    .number({ invalid_type_error: 'QTY 必須為整數' })
    .int('QTY 必須為整數')
    .min(URGENT_QTY_MIN, `QTY 最少為 ${URGENT_QTY_MIN}`)
    .max(URGENT_QTY_MAX, `QTY 最多為 ${URGENT_QTY_MAX}`)
    .optional(),
  urgent_reason: z.string().trim().max(100).optional().default(''),
  urgent_reason_other: z.string().max(2000).optional().default(''),
});

/** POST /api/public/modify — modify before export lock. */
publicRouter.post(
  '/modify',
  publicSubmitLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = modifySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({ error: first?.message ?? '輸入資料無效', field: first?.path[0] ?? null });
      return;
    }
    const data = parsed.data;
    const siteCode = normalizeSiteCode(data.site_code);
    const store = await getStore(siteCode);
    if (!store) {
      res.status(400).json({ error: `Site Code「${siteCode}」不存在於門店主檔`, field: 'site_code' });
      return;
    }

    const businessFields = {
      brand: data.brand,
      sku: data.sku,
      rp_type: data.rp_type,
      safety_stock: data.safety_stock,
      nd_code: data.nd_code,
      remark: data.remark,
    };
    const existing = await getSubmissionByApplicationNo(data.application_no, siteCode);
    if (!existing) {
      res.status(404).json({ error: '找不到相符申報' });
      return;
    }
    if (existing.locked_at || existing.exported_at) {
      res.status(409).json({ error: '此申報已匯出並鎖定，不能修改' });
      return;
    }

    const ip = getClientIp(req);

    if (existing.submission_type === 'sales') {
      try {
        const row = await modifySalesSubmission({
          applicationNo: data.application_no,
          siteCode,
          sku: data.sku,
          ip,
          changeSource: 'web_modify',
        });
        await writeAuditEvent({
          eventType: 'submission_modified',
          actorRole: 'applicant',
          submissionId: row.id,
          applicationNo: row.application_no,
          ip,
          metadata: { submission_type: 'sales' },
        });
        res.json({ submission: serializeSalesSubmission(row) });
      } catch (err) {
        if (err instanceof LockedError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof DuplicateSubmissionError) {
          res.status(409).json({ error: err.message, field: 'sku' });
          return;
        }
        if (err instanceof NotSupportedError || (err instanceof Error && err.message === '找不到申報')) {
          res.status(err instanceof NotSupportedError ? 400 : 404).json({ error: err.message === '找不到申報' ? '找不到相符申報' : err.message });
          return;
        }
        throw err;
      }
      return;
    }

    if (existing.submission_type === 'urgent') {
      if (!isUrgentWindowOpen()) {
        res.status(400).json({ error: URGENT_MODIFY_CLOSED_ERROR, field: null });
        return;
      }
      if (typeof data.qty !== 'number' || !Number.isInteger(data.qty)) {
        res.status(400).json({ error: 'QTY 必須為整數', field: 'qty' });
        return;
      }
      const reasonErrors = validateUrgentReason(data.urgent_reason, data.urgent_reason_other);
      if (reasonErrors.length) {
        res.status(400).json({
          error: reasonErrors[0]!.message,
          field: reasonErrors[0]!.field,
          errors: reasonErrors,
        });
        return;
      }
      try {
        const row = await modifyUrgentSubmission({
          applicationNo: data.application_no,
          siteCode,
          sku: data.sku,
          qty: data.qty,
          urgentReason: data.urgent_reason,
          urgentReasonOther: data.urgent_reason_other,
          ip,
          changeSource: 'web_modify',
        });

        await writeAuditEvent({
          eventType: 'submission_modified',
          actorRole: 'applicant',
          submissionId: row.id,
          applicationNo: row.application_no,
          ip,
          metadata: { submission_type: 'urgent' },
        });

        res.json({ submission: serializeUrgentSubmission(row) });
      } catch (err) {
        if (err instanceof LockedError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof DuplicateSubmissionError) {
          res.status(409).json({ error: err.message, field: 'sku' });
          return;
        }
        if (err instanceof Error && err.message === '找不到申報') {
          res.status(404).json({ error: '找不到相符申報' });
          return;
        }
        throw err;
      }
      return;
    }

    const businessErrors = validateBusinessFields(businessFields, siteCode);
    if (businessErrors.length) {
      res.status(400).json({
        error: businessErrors[0]!.message,
        field: businessErrors[0]!.field,
        errors: businessErrors,
      });
      return;
    }

    try {
      const row = await modifySubmission({
        applicationNo: data.application_no,
        siteCode,
        fields: businessFields,
        ip,
        actorRole: 'applicant',
        changeSource: 'web_modify',
      });

      await writeAuditEvent({
        eventType: 'submission_modified',
        actorRole: 'applicant',
        submissionId: row.id,
        applicationNo: row.application_no,
        ip,
      });

      res.json({ submission: serializeSubmission(row) });
    } catch (err) {
      if (err instanceof LockedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof NotSupportedError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof DuplicateSubmissionError) {
        res.status(409).json({ error: err.message, field: 'sku' });
        return;
      }
      if (err instanceof Error && err.message === '找不到申報') {
        res.status(404).json({ error: '找不到相符申報' });
        return;
      }
      throw err;
    }
  }),
);
