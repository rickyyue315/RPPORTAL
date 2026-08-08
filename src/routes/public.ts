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
  createUrgentBatch,
  deriveUrgentBatchIdempotencyKeys,
  getSubmissionByApplicationNo,
  listVersions,
  modifySubmission,
  modifyUrgentSubmission,
  modifySalesSubmission,
  modifyReturnSubmission,
  LockedError,
  NotSupportedError,
  DuplicateSubmissionError,
  IdempotencyConflictError,
  UrgentBatchDuplicateError,
  getSubmissionByIdempotencyKey,
  ReturnSubmissionConflictError,
  ReturnWindowClosedError,
  lockDuplicateSubmissionKeys,
  assertNoDuplicate,
  assertNoDuplicateReturn,
  type SubmissionRow,
} from '../services/submissions.js';
import { writeAuditEvent } from '../lib/audit.js';
import { toHKString, hkTodayForDateColumn, hkMinutesNow, hkHM } from '../lib/time.js';
import {
  parseImportWorkbook,
  parseUrgentImportWorkbook,
  parseSalesImportWorkbook,
  parseReturnImportWorkbook,
  findDuplicateImportErrors,
  EXCEL_UPLOAD_EXTENSION_ERROR,
} from '../lib/excelImport.js';
import {
  generateTemplateWorkbook,
  generateUrgentTemplateWorkbook,
  generateSalesTemplateWorkbook,
  generateReturnTemplateWorkbook,
  buildImportRecordBuffer,
  buildUrgentImportRecordBuffer,
  buildSalesImportRecordBuffer,
  buildReturnImportRecordBuffer,
} from '../lib/excelExport.js';
import {
  RETURN_QTY_MIN,
  RETURN_QTY_MAX,
  returnReasonLabel,
  resolveReturnReasonCode,
  RETURN_REASONS,
  RETURN_SHEET,
  URGENT_QTY_MIN,
  URGENT_QTY_MAX,
  URGENT_WEB_MAX_ITEMS,
  urgentReasonLabel,
} from '../lib/fields.js';
import { isValidIsoDate, RF_REMARK_REQUIRED_SITES, SKU_PATTERN, SKU_ERROR, validateBusinessFields, validateUrgentReason } from '../lib/validation.js';
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { generateApplicationNo } from '../lib/applicationNo.js';
import { ipExpiryIso } from '../lib/ip.js';
import { RETURN_SCHEDULE, RETURN_WINDOWS, getActiveReturnWindow, isReturnModificationOpen } from '../lib/returnSchedule.js';
import { fingerprintPayload, getIdempotencyKey, hasInvalidIdempotencyKey } from '../lib/idempotency.js';
import { createImportBatch, findImportBatchByIdempotencyKey, findImportBatchByKey, getPublicImportBatchRecord, importBatchResponse, lockImportIdempotencyKey, type ImportSubmissionType } from '../services/importBatches.js';
import { isValidPublicRecoveryCode, parseRecoveryCodeHeader } from '../lib/recovery.js';
import { getUploadedFile, validateUploadedXlsx } from '../lib/upload.js';

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

/** Return false after writing a 400 response, otherwise the client key or undefined. */
function requestIdempotencyKey(req: Request, res: Response): string | undefined | false {
  if (hasInvalidIdempotencyKey(req)) {
    res.status(400).json({ error: 'Idempotency-Key 格式無效' });
    return false;
  }
  return getIdempotencyKey(req);
}

async function servePublicImportRecord(
  req: Request,
  res: Response,
  type: ImportSubmissionType,
  batchId: string,
  build: (rows: unknown[]) => Promise<Buffer>,
  fallbackName: string,
): Promise<void> {
  const key = requestIdempotencyKey(req, res);
  if (key === false) return;
  if (!key) {
    res.status(400).json({ error: '需要提供原匯入的 Idempotency-Key 才能下載記錄' });
    return;
  }
  const parsedBatchId = z.string().uuid().safeParse(batchId);
  if (!parsedBatchId.success) {
    res.status(400).json({ error: '匯入批次編號無效' });
    return;
  }
  const batch = await getPublicImportBatchRecord(batchId, key, type);
  if (!batch) {
    res.status(404).json({ error: '找不到匯入批次或重試鍵不符' });
    return;
  }
  const buffer = await build(batch.results);
  const stamp = toHKString(new Date()).replace(/[^0-9]/g, '');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fallbackName.replace('.xlsx', `_${stamp}.xlsx`)}"`);
  res.send(buffer);
}
async function replaySingleSubmission(
  key: string | undefined,
  fingerprint: string,
  submissionType: ImportSubmissionType,
  serialize: (row: SubmissionRow) => unknown,
  res: Response,
): Promise<boolean> {
  if (!key) return false;
  const existing = await getSubmissionByIdempotencyKey(key);
  if (!existing) return false;
  if (existing.idempotency_fingerprint !== fingerprint || existing.submission_type !== submissionType) {
    res.status(409).json({ error: '此提交重試鍵已用於不同資料，請重新整理頁面後再提交' });
    return true;
  }
  res.status(200).json({ submission: serialize(existing), replayed: true });
  return true;
}

/** Replays a completed web batch submission so a lost response can recover all application numbers. */
async function replayUrgentBatch(
  key: string,
  fingerprint: string,
  siteCode: string,
  itemCount: number,
  res: Response,
): Promise<boolean> {
  const derivedKeys = deriveUrgentBatchIdempotencyKeys(key, itemCount);
  const existing = await query<SubmissionRow>(
    'SELECT * FROM submissions WHERE idempotency_key = ANY($1::text[])',
    [derivedKeys],
  );
  if (existing.rows.length === 0) return false;
  const byKey = new Map(existing.rows.map((row) => [row.idempotency_key, row]));
  if (existing.rows.length !== derivedKeys.length) {
    res.status(409).json({ error: '此提交重試鍵已用於不同資料，請重新整理頁面後再提交' });
    return true;
  }
  const ordered: SubmissionRow[] = [];
  for (const derived of derivedKeys) {
    const row = byKey.get(derived);
    if (
      !row
      || row.idempotency_fingerprint !== fingerprint
      || row.submission_type !== 'urgent'
      || row.site_code !== normalizeSiteCode(siteCode)
    ) {
      res.status(409).json({ error: '此提交重試鍵已用於不同資料，請重新整理頁面後再提交' });
      return true;
    }
    ordered.push(row);
  }
  const store = await getStore(siteCode);
  const submissions = ordered.map(serializeUrgentSubmission);
  res.status(200).json({
    submissions,
    submission: submissions.length === 1 ? submissions[0] : undefined,
    store: { shop: store?.shop ?? '' },
    replayed: true,
  });
  return true;
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

function serializeReturnSubmission(row: SubmissionRow) {
  const window = RETURN_WINDOWS.find((item) => item.key === row.return_window_key) ?? null;
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
    qty: row.return_qty,
    return_qty: row.return_qty,
    return_reason: row.return_reason,
    return_reason_label: returnReasonLabel(row.return_reason),
    return_confirmer_name: row.return_confirmer_name,
    return_confirmer_phone: row.return_confirmer_phone,
    return_window_key: row.return_window_key,
    return_window: window,
    return_window_open: isReturnModificationOpen(row.return_window_key, hkTodayForDateColumn()),
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
    const idempotencyKey = requestIdempotencyKey(req, res);
    if (idempotencyKey === false) return;
    const idempotencyFingerprint = fingerprintPayload(data);
    if (await replaySingleSubmission(idempotencyKey, idempotencyFingerprint, 'normal', serializeSubmission, res)) return;
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
        idempotencyKey,
        idempotencyFingerprint,
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
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
    const idempotencyKey = requestIdempotencyKey(req, res);
    if (idempotencyKey === false) return;
    const idempotencyFingerprint = fingerprintPayload(parsed.data);
    if (await replaySingleSubmission(idempotencyKey, idempotencyFingerprint, 'sales', serializeSalesSubmission, res)) return;
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
        idempotencyKey,
        idempotencyFingerprint,
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
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
    const file = getUploadedFile(req)!;
    const uploadError = validateUploadedXlsx(file, config.maxUploadBytes, EXCEL_UPLOAD_EXTENSION_ERROR);
    if (uploadError) {
      res.status(uploadError.status).json({ error: uploadError.message });
      return;
    }

    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));
    const parsed = await parseSalesImportWorkbook(file.buffer, storeCodes, config.maxImportRows);
    const idempotencyKey = requestIdempotencyKey(req, res);
    if (idempotencyKey === false) return;
    if (idempotencyKey) {
      const replay = await findImportBatchByKey(idempotencyKey, 'sales');
      if (replay) {
        if (replay.content_hash !== parsed.contentHash) {
          res.status(409).json({ error: '此重試鍵已用於另一個 Excel 檔案' });
          return;
        }
        res.status(200).json(importBatchResponse(replay));
        return;
      }
    }
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
        if (idempotencyKey) {
          await lockImportIdempotencyKey(client, idempotencyKey, 'sales');
          const replay = await findImportBatchByIdempotencyKey(client, idempotencyKey, 'sales');
          if (replay) {
            if (replay.content_hash !== parsed.contentHash) throw new IdempotencyConflictError();
            return { batchId: replay.id, rows: replay.results, successCount: replay.success_count, replayed: true };
          }
        }
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
        const batchId = await createImportBatch(client, {
          filename: file.originalname,
          sheetName: parsed.sheetName ?? '',
          rowCount: parsed.totalRows,
          successCount: rowsOut.length,
          failedCount: 0,
          results: rowsOut,
          contentHash: parsed.contentHash ?? '',
          createdBy: 'applicant',
          submissionType: 'sales',
          idempotencyKey,
        });
        return { batchId, rows: rowsOut, successCount: rowsOut.length };
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
         res.status(409).json({ error: err.message });
         return;
       }
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
      batchId: results.batchId,
      rows: results.rows,
    });
  }),
);

/** Download a server-backed sales import record. The idempotency key prevents guessing a batch UUID from exposing data. */
publicRouter.get(
  '/sales/import/record/:batchId',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    await servePublicImportRecord(req, res, 'sales', req.params.batchId as string, (rows) => buildSalesImportRecordBuffer(rows as never), 'Sudden_Sales_Import_Record.xlsx');
  }),
);

publicRouter.post(
  '/sales/import/record',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z.object({ batch_id: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '需要提供有效的 batch_id' });
      return;
    }
    await servePublicImportRecord(req, res, 'sales', parsed.data.batch_id, (rows) => buildSalesImportRecordBuffer(rows as never), 'Sudden_Sales_Import_Record.xlsx');
  }),
);
const returnSubmitSchema = z.object({
  site_code: z.string().trim().min(1, 'Site Code 為必填').max(20),
  sku: z.string().trim().min(1, 'SKU 為必填').regex(SKU_PATTERN, SKU_ERROR),
  qty: z.number({ invalid_type_error: 'QTY 必須為整數' }).int('QTY 必須為整數').min(RETURN_QTY_MIN).max(RETURN_QTY_MAX),
  reason: z.string().trim().min(1, 'REASON 為必填').max(200),
  confirmer_name: z.string().trim().min(1, '確認人姓名為必填').max(200),
  confirmer_phone: z.string().trim().min(1, '確認人電話為必填').max(200),
});

function returnWindowStatus() {
  const today = hkTodayForDateColumn();
  const activeWindow = getActiveReturnWindow(today);
  return {
    open: Boolean(activeWindow),
    today,
    timezone: config.timezone,
    window: activeWindow,
    windows: RETURN_SCHEDULE,
    reasons: RETURN_REASONS,
    message: activeWindow
      ? ''
      : '目前不在店舖申請退行貨日期內，暫停申請；請參考 2026 年店舖申請退行貨時間表',
  };
}

/** GET /api/public/return/schedule — return-goods processing schedule. */
publicRouter.get(
  '/return/schedule',
  publicLookupLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(returnWindowStatus());
  }),
);

/** GET /api/public/return/window — current return-goods application window. */
publicRouter.get(
  '/return/window',
  publicLookupLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const status = returnWindowStatus();
    res.json({
      open: status.open,
      today: status.today,
      timezone: status.timezone,
      window: status.window,
      message: status.message,
    });
  }),
);

/** POST /api/public/return/submit — single return-goods report. */
publicRouter.post(
  '/return/submit',
  publicSubmitLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = returnSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({ error: first?.message ?? '輸入資料無效', field: first?.path[0] ?? null });
      return;
    }
    const data = parsed.data;
    const idempotencyKey = requestIdempotencyKey(req, res);
    if (idempotencyKey === false) return;
    const idempotencyFingerprint = fingerprintPayload(data);
    if (await replaySingleSubmission(idempotencyKey, idempotencyFingerprint, 'return', serializeReturnSubmission, res)) return;
    const siteCode = normalizeSiteCode(data.site_code);
    const store = await getStore(siteCode);
    if (!store) {
      res.status(400).json({ error: `Site Code「${siteCode}」不存在於門店主檔`, field: 'site_code' });
      return;
    }
    const reason = resolveReturnReasonCode(data.reason);
    if (!reason) {
      res.status(400).json({ error: 'REASON 選項無效', field: 'reason' });
      return;
    }
    const ip = getClientIp(req);
    let row: SubmissionRow;
    try {
      row = await createSubmission({
        siteCode,
        source: 'web',
        submissionType: 'return',
        fields: { brand: '', sku: data.sku, rp_type: '', safety_stock: '', nd_code: '', remark: '' },
        returnQty: data.qty,
        returnReason: reason,
        returnConfirmerName: data.confirmer_name,
        returnConfirmerPhone: data.confirmer_phone,
        ip,
        changeSource: 'web_submit',
        idempotencyKey,
        idempotencyFingerprint,
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof ReturnWindowClosedError) {
        res.status(400).json({ error: err.message, field: null });
        return;
      }
      if (err instanceof ReturnSubmissionConflictError) {
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
      metadata: { source: 'web', submission_type: 'return', shop: store.shop },
    });
    res.status(201).json({ submission: serializeReturnSubmission(row), store: { shop: store.shop } });
  }),
);

/** GET /api/public/return/template — download return-goods import template. */
publicRouter.get(
  '/return/template',
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const buffer = await generateReturnTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Return_Goods_Template.xlsx"`);
    res.send(buffer);
  }),
);

/** POST /api/public/return/import — return-goods Excel batch upload. */
publicRouter.post(
  '/return/import',
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
    const storeCodes = new Set(stores.rows.map((store) => store.site_code));
    const parsed = await parseReturnImportWorkbook(file.buffer, storeCodes, config.maxImportRows);
    const idempotencyKey = requestIdempotencyKey(req, res);
    if (idempotencyKey === false) return;
    if (idempotencyKey) {
      const replay = await findImportBatchByKey(idempotencyKey, 'return');
      if (replay) {
        if (replay.content_hash !== parsed.contentHash) {
          res.status(409).json({ error: '此重試鍵已用於另一個 Excel 檔案' });
          return;
        }
        res.status(200).json(importBatchResponse(replay));
        return;
      }
    }
    const activeWindow = getActiveReturnWindow(hkTodayForDateColumn());
    if (!activeWindow) {
      res.status(400).json({ error: '目前不在店舖申請退行貨日期內，暫停申請', field: null });
      return;
    }
    if (!parsed.ok || !parsed.rows) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'applicant',
        ip: getClientIp(req),
        metadata: { filename: file.originalname, submission_type: 'return', errors: parsed.errors ?? [] },
      });
      res.status(400).json({ error: '匯入失敗', totalRows: parsed.totalRows, errors: parsed.errors ?? [] });
      return;
    }

    const existing = await query<{ site_code: string; sku: string }>(
      `SELECT site_code, sku FROM submissions
       WHERE submission_type = 'return' AND return_window_key = $1`,
      [activeWindow.key],
    );
    const existingKeys = new Set(existing.rows.map((row) => `${row.site_code}|${row.sku}`));
    const duplicateErrors: Array<{ row: number; field: string; reason: string; siteCode?: string }> = [];
    const seen = new Set<string>();
    for (const row of parsed.rows) {
      const key = `${row.siteCode}|${row.sku}`;
      if (seen.has(key) || existingKeys.has(key)) {
        duplicateErrors.push({ row: row.rowNumber, field: 'SKU', reason: '同一退行貨申請期已申報相同 SKU 或與檔案內其他行重複', siteCode: row.siteCode });
      }
      seen.add(key);
    }
    if (duplicateErrors.length) {
      res.status(400).json({ error: '匯入失敗', totalRows: parsed.totalRows, errors: duplicateErrors });
      return;
    }

    const ip = getClientIp(req);
    try {
      const results = await withTransaction(async (client) => {
         if (idempotencyKey) {
            await lockImportIdempotencyKey(client, idempotencyKey, 'return');
           const replay = await findImportBatchByIdempotencyKey(client, idempotencyKey, 'return');
           if (replay) {
             if (replay.content_hash !== parsed.contentHash) throw new IdempotencyConflictError();
             return { batchId: replay.id, rows: replay.results, successCount: replay.success_count, replayed: true };
           }
         }
        await lockDuplicateSubmissionKeys(client, parsed.rows!.map((row) => ({
          siteCode: row.siteCode,
          sku: row.sku,
          submissionType: 'return' as const,
          date: activeWindow.key,
        })));
        const rowsOut: Array<{
          row: number;
          application_no: string;
          site_code: string;
          sku: string;
          qty: number;
          reason: string;
          confirmer_name: string;
          confirmer_phone: string;
          submitted_at: string;
        }> = [];
        for (const item of parsed.rows!) {
          await assertNoDuplicateReturn(client, {
            siteCode: item.siteCode,
            sku: item.sku,
            windowKey: activeWindow.key,
          });
          const appNo = generateApplicationNo('RETURN');
          const insert = await client.query<SubmissionRow>(
            `INSERT INTO submissions (
               application_no, source, submission_type, site_code, requested_by_email, application_date,
               brand, sku, return_qty, return_reason, return_confirmer_name, return_confirmer_phone,
               return_window_key, created_ip, created_ip_expires_at
             ) VALUES ($1, 'excel', 'return', $2, $3, $4, '', $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [
              appNo,
              item.siteCode,
              `${item.siteCode.toLowerCase()}@sasa.com`,
              hkTodayForDateColumn(),
              item.sku,
              item.qty,
              item.reason,
              item.confirmerName,
              item.confirmerPhone,
              activeWindow.key,
              ip,
              ip ? ipExpiryIso() : null,
            ],
          );
          const row = insert.rows[0]!;
          await client.query(
            `INSERT INTO submission_versions
               (submission_id, version, data_before, data_after, actor_role, actor, ip, change_source)
             VALUES ($1, 1, NULL, $2, 'applicant', NULL, $3, 'excel_import')`,
            [row.id, JSON.stringify({ site_code: row.site_code, sku: row.sku, return_qty: row.return_qty, return_reason: row.return_reason, return_confirmer_name: row.return_confirmer_name, return_confirmer_phone: row.return_confirmer_phone, return_window_key: row.return_window_key }), ip],
          );
          rowsOut.push({
            row: item.rowNumber,
            application_no: row.application_no,
            site_code: row.site_code,
            sku: row.sku,
            qty: row.return_qty as number,
            reason: row.return_reason as string,
            confirmer_name: row.return_confirmer_name as string,
            confirmer_phone: row.return_confirmer_phone as string,
            submitted_at: toHKString(row.submitted_at),
          });
        }
        const batchId = await createImportBatch(client, {
          filename: file.originalname,
          sheetName: parsed.sheetName ?? RETURN_SHEET,
          rowCount: parsed.totalRows,
          successCount: rowsOut.length,
          failedCount: 0,
          results: rowsOut,
          contentHash: parsed.contentHash ?? '',
          createdBy: 'applicant',
          submissionType: 'return',
          idempotencyKey,
        });
        return { batchId, rows: rowsOut, successCount: rowsOut.length };
      });
      await writeAuditEvent({ eventType: 'excel_import', actorRole: 'applicant', ip, metadata: { filename: file.originalname, submission_type: 'return', batchId: results.batchId, totalRows: parsed.totalRows, successCount: results.successCount } });
      res.status(201).json({ message: `成功匯入 ${results.successCount} 行`, totalRows: parsed.totalRows, successCount: results.successCount, batchId: results.batchId, rows: results.rows });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
         res.status(409).json({ error: err.message });
         return;
       }
       if (err instanceof ReturnSubmissionConflictError || err instanceof DuplicateSubmissionError) {
        res.status(409).json({ error: err.message, field: 'SKU' });
        return;
      }
      throw err;
    }
  }),
);

/** Download a server-backed return-goods import record. */
publicRouter.get(
  '/return/import/record/:batchId',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    await servePublicImportRecord(req, res, 'return', req.params.batchId as string, (rows) => buildReturnImportRecordBuffer(rows as never), 'Return_Goods_Import_Record.xlsx');
  }),
);

publicRouter.post(
  '/return/import/record',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z.object({ batch_id: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '需要提供有效的 batch_id' });
      return;
    }
    await servePublicImportRecord(req, res, 'return', parsed.data.batch_id, (rows) => buildReturnImportRecordBuffer(rows as never), 'Return_Goods_Import_Record.xlsx');
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

const urgentBatchItemSchema = z.object({
  sku: z.string().trim().min(1, 'SKU 為必填').regex(SKU_PATTERN, SKU_ERROR),
  qty: z
    .number({ invalid_type_error: 'QTY 必須為整數' })
    .int('QTY 必須為整數')
    .min(URGENT_QTY_MIN, `QTY 最少為 ${URGENT_QTY_MIN}`)
    .max(URGENT_QTY_MAX, `QTY 最多為 ${URGENT_QTY_MAX}`),
  urgent_reason: z.string().trim().max(100).optional().default(''),
  urgent_reason_other: z.string().max(2000).optional().default(''),
});

/** POST /api/public/urgent/submit — single or 1-5 SKU Urgent Order web submission. */
publicRouter.post(
  '/urgent/submit',
  publicSubmitLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const rawBody = req.body;
    const isBatch = Boolean(
      rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) && 'items' in rawBody,
    );
    const idempotencyKey = requestIdempotencyKey(req, res);
    if (idempotencyKey === false) return;

    if (isBatch) {
      const topLevel = z.object({
        site_code: z.string().trim().min(1, 'Site Code 為必填').max(20),
        items: z.array(z.unknown()).min(1, '至少需要填寫 1 個 SKU').max(URGENT_WEB_MAX_ITEMS, `最多填寫 ${URGENT_WEB_MAX_ITEMS} 個 SKU`),
      }).safeParse(rawBody);
      const topLevelData = topLevel.success ? topLevel.data : null;

      // Validate every row independently so schema and business errors are
      // reported together instead of stopping at the first invalid row.
      const errors: Array<{ item: number | null; field: string; message: string }> = [];
      if (!topLevel.success) {
        for (const issue of topLevel.error.issues) {
          errors.push({ item: null, field: String(issue.path[0] ?? ''), message: issue.message });
        }
      }
      const rawItems = Array.isArray(rawBody.items) ? rawBody.items : [];
      const parsedItems: z.infer<typeof urgentBatchItemSchema>[] = [];
      rawItems.forEach((rawItem: unknown, index: number) => {
        const parsedItem = urgentBatchItemSchema.safeParse(rawItem);
        if (!parsedItem.success) {
          for (const issue of parsedItem.error.issues) {
            errors.push({ item: index + 1, field: String(issue.path[0] ?? ''), message: issue.message });
          }
          return;
        }
        const reasonErrors = validateUrgentReason(parsedItem.data.urgent_reason, parsedItem.data.urgent_reason_other);
        if (reasonErrors.length) {
          for (const err of reasonErrors) {
            errors.push({
              item: index + 1,
              field: err.field === 'urgent_reason' ? 'urgent_reason' : 'urgent_reason_other',
              message: err.message,
            });
          }
          return;
        }
        parsedItems.push(parsedItem.data);
      });

      if (errors.length || !topLevelData || parsedItems.length !== rawItems.length) {
        const first = errors[0];
        res.status(400).json({
          error: first ? (first.item ? `第 ${first.item} 行的資料有誤` : first.message) : '輸入資料無效',
          item: first?.item ?? null,
          field: first?.field ?? null,
          errors,
        });
        return;
      }

      const data = { site_code: topLevelData.site_code, items: parsedItems };
      const idempotencyFingerprint = fingerprintPayload(data);
      if (idempotencyKey && await replayUrgentBatch(idempotencyKey, idempotencyFingerprint, data.site_code, data.items.length, res)) return;
      if (!isUrgentWindowOpen()) {
        res.status(400).json({ error: URGENT_WINDOW_CLOSED_ERROR, field: null });
        return;
      }
      const siteCode = normalizeSiteCode(data.site_code);
      const store = await getStore(siteCode);
      if (!store) {
        res.status(400).json({ error: `Site Code「${siteCode}」不存在於門店主檔`, field: 'site_code' });
        return;
      }

      const ip = getClientIp(req);
      let result;
      try {
        result = await createUrgentBatch({
          siteCode,
          items: data.items.map((item) => ({
            sku: item.sku,
            qty: item.qty,
            urgentReason: item.urgent_reason,
            urgentReasonOther: item.urgent_reason_other,
          })),
          ip,
          changeSource: 'web_submit',
          idempotencyKey,
          idempotencyFingerprint,
        });
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof UrgentBatchDuplicateError) {
          res.status(409).json({
            error: err.message,
            errors: err.errors.map((e) => ({
              item: e.item,
              field: 'sku',
              message: `SKU「${e.sku}」同日已申報或與本批其他行重複`,
            })),
          });
          return;
        }
        throw err;
      }

      for (const rowResult of result.rows) {
        await writeAuditEvent({
          eventType: 'submission_created',
          actorRole: 'applicant',
          submissionId: rowResult.row.id,
          applicationNo: rowResult.row.application_no,
          ip,
          metadata: {
            source: 'web',
            submission_type: 'urgent',
            shop: store.shop,
            batch_size: result.rows.length,
            batch_index: rowResult.item,
          },
        });
      }

      const submissions = result.rows.map((rowResult) => serializeUrgentSubmission(rowResult.row));
      res.status(201).json({
        submissions,
        submission: submissions.length === 1 ? submissions[0] : undefined,
        store: { shop: store.shop },
      });
      return;
    }

    const parsed = urgentSubmitSchema.safeParse(rawBody);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({
        error: first?.message ?? '輸入資料無效',
        field: first?.path[0] ?? null,
      });
      return;
    }
    const data = parsed.data as z.infer<typeof urgentSubmitSchema>;
    const idempotencyFingerprint = fingerprintPayload(data);
    if (await replaySingleSubmission(idempotencyKey, idempotencyFingerprint, 'urgent', serializeUrgentSubmission, res)) return;
    if (!isUrgentWindowOpen()) {
      res.status(400).json({ error: URGENT_WINDOW_CLOSED_ERROR, field: null });
      return;
    }
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
        idempotencyKey,
        idempotencyFingerprint,
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
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
    const file = getUploadedFile(req)!;
    const uploadError = validateUploadedXlsx(file, config.maxUploadBytes, EXCEL_UPLOAD_EXTENSION_ERROR);
    if (uploadError) {
      res.status(uploadError.status).json({ error: uploadError.message });
      return;
    }

    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));

    const parsed = await parseUrgentImportWorkbook(file.buffer, storeCodes, config.maxImportRows);
    const idempotencyKey = requestIdempotencyKey(req, res);
    if (idempotencyKey === false) return;
    if (idempotencyKey) {
      const replay = await findImportBatchByKey(idempotencyKey, 'urgent');
      if (replay) {
        if (replay.content_hash !== parsed.contentHash) {
          res.status(409).json({ error: '此重試鍵已用於另一個 Excel 檔案' });
          return;
        }
        res.status(200).json(importBatchResponse(replay));
        return;
      }
    }
    if (!isUrgentWindowOpen()) {
      res.status(400).json({ error: URGENT_WINDOW_CLOSED_ERROR, field: null });
      return;
    }
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
        if (idempotencyKey) {
          await lockImportIdempotencyKey(client, idempotencyKey, 'urgent');
          const replay = await findImportBatchByIdempotencyKey(client, idempotencyKey, 'urgent');
          if (replay) {
            if (replay.content_hash !== parsed.contentHash) throw new IdempotencyConflictError();
            return { batchId: replay.id, rows: replay.results, successCount: replay.success_count, replayed: true };
          }
        }
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
        const batchId = await createImportBatch(client, {
          filename: file.originalname,
          sheetName: parsed.sheetName ?? '',
          rowCount: parsed.totalRows,
          successCount,
          failedCount: 0,
          results: rowsOut,
          contentHash: parsed.contentHash ?? '',
          createdBy: 'applicant',
          submissionType: 'urgent',
          idempotencyKey,
        });
        return { batchId, rows: rowsOut, successCount };
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
         res.status(409).json({ error: err.message });
         return;
       }
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
      batchId: results.batchId,
      rows: results.rows,
    });
  }),
);

/** Download a server-backed Urgent import record. */
publicRouter.get(
  '/urgent/import/record/:batchId',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    await servePublicImportRecord(req, res, 'urgent', req.params.batchId as string, (rows) => buildUrgentImportRecordBuffer(rows as never), 'Urgent_Import_Record.xlsx');
  }),
);

publicRouter.post(
  '/urgent/import/record',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z.object({ batch_id: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '需要提供有效的 batch_id' });
      return;
    }
    await servePublicImportRecord(req, res, 'urgent', parsed.data.batch_id, (rows) => buildUrgentImportRecordBuffer(rows as never), 'Urgent_Import_Record.xlsx');
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
    const file = getUploadedFile(req)!;
    const uploadError = validateUploadedXlsx(file, config.maxUploadBytes, EXCEL_UPLOAD_EXTENSION_ERROR);
    if (uploadError) {
      res.status(uploadError.status).json({ error: uploadError.message });
      return;
    }

    const stores = await query<{ site_code: string }>('SELECT site_code FROM stores');
    const storeCodes = new Set(stores.rows.map((s) => s.site_code));

    const parsed = await parseImportWorkbook(file.buffer, storeCodes, config.maxImportRows);
    const idempotencyKey = requestIdempotencyKey(req, res);
    if (idempotencyKey === false) return;
    if (idempotencyKey) {
      const replay = await findImportBatchByKey(idempotencyKey, 'normal');
      if (replay) {
        if (replay.content_hash !== parsed.contentHash) {
          res.status(409).json({ error: '此重試鍵已用於另一個 Excel 檔案' });
          return;
        }
        res.status(200).json(importBatchResponse(replay));
        return;
      }
    }
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
        if (idempotencyKey) {
          await lockImportIdempotencyKey(client, idempotencyKey, 'normal');
          const replay = await findImportBatchByIdempotencyKey(client, idempotencyKey, 'normal');
          if (replay) {
            if (replay.content_hash !== parsed.contentHash) throw new IdempotencyConflictError();
            return { batchId: replay.id, rows: replay.results, successCount: replay.success_count, replayed: true };
          }
        }
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
        const batchId = await createImportBatch(client, {
          filename: file.originalname,
          sheetName: parsed.sheetName ?? '',
          rowCount: parsed.totalRows,
          successCount,
          failedCount: 0,
          results: rowsOut,
          contentHash: parsed.contentHash ?? '',
          createdBy: 'applicant',
          submissionType: 'normal',
          idempotencyKey,
        });
        return { batchId, rows: rowsOut, successCount };
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
         res.status(409).json({ error: err.message });
         return;
       }
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
      batchId: results.batchId,
      rows: results.rows,
    });
  }),
);

/** Download a server-backed normal NDRF import record. */
publicRouter.get(
  '/import/record/:batchId',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    await servePublicImportRecord(req, res, 'normal', req.params.batchId as string, (rows) => buildImportRecordBuffer(rows as never), 'NDRF_Import_Record.xlsx');
  }),
);

publicRouter.post(
  '/import/record',
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z.object({ batch_id: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '需要提供有效的 batch_id' });
      return;
    }
    await servePublicImportRecord(req, res, 'normal', parsed.data.batch_id, (rows) => buildImportRecordBuffer(rows as never), 'NDRF_Import_Record.xlsx');
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
            : row.submission_type === 'return'
              ? serializeReturnSubmission(row)
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

/** GET /api/public/my-applications?site_code=&from=&to=&sku= — recover application numbers by Site Code + date range. */
publicRouter.get(
  '/my-applications',
  publicLookupLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const siteCode = normalizeSiteCode(String(req.query.site_code ?? ''));
    const rawFrom = String(req.query.from ?? '').trim();
    const rawTo = String(req.query.to ?? '').trim();
    const rawSku = String(req.query.sku ?? '').trim();
    const recoveryCode = parseRecoveryCodeHeader(req.get('x-recovery-code'));

    if (!config.publicRecoveryCode) {
      res.status(503).json({ error: '申請編號恢復功能尚未設定' });
      return;
    }
    if (!isValidPublicRecoveryCode(recoveryCode)) {
      res.status(403).json({ error: 'Recovery Code 無效' });
      return;
    }

    if (!siteCode) {
      res.status(400).json({ error: 'Site Code 為必填' });
      return;
    }
    const store = await getStore(siteCode);
    if (!store) {
      res.status(400).json({ error: `Site Code「${siteCode}」不存在於門店主檔` });
      return;
    }

    let from: string | null = null;
    let to: string | null = null;
    for (const [label, raw] of [['from', rawFrom], ['to', rawTo]] as const) {
      if (!raw) continue;
      if (!isValidIsoDate(raw)) {
        res.status(400).json({ error: `${label === 'from' ? '由' : '至'}日期格式無效，請使用 YYYY-MM-DD` });
        return;
      }
      if (label === 'from') from = raw;
      else to = raw;
    }
    if (from && to && from > to) {
      res.status(400).json({ error: '由日期不能晚於至日期' });
      return;
    }
    if (!from) from = to ?? hkTodayForDateColumn();
    if (!to) to = from;

    const daySpan = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (daySpan < 0 || daySpan > 31) {
      res.status(400).json({ error: '查詢日期範圍最多為 31 天' });
      return;
    }

    let skuFilter: string | null = null;
    if (rawSku) {
      if (!SKU_PATTERN.test(rawSku)) {
        res.status(400).json({ error: SKU_ERROR });
        return;
      }
      skuFilter = rawSku;
    }

    const params: unknown[] = [siteCode, from, to];
    let sql = `
      SELECT application_no, submission_type, site_code, application_date, submitted_at, source, sku, locked_at, exported_at
      FROM submissions
      WHERE site_code = $1 AND application_date >= $2 AND application_date <= $3`;
    if (skuFilter) {
      params.push(skuFilter);
      sql += ` AND sku = $${params.length}`;
    }
    sql += ` ORDER BY submitted_at DESC LIMIT 100`;

    const result = await query<{
      application_no: string;
      submission_type: string;
      site_code: string;
      application_date: string;
      submitted_at: string;
      source: string;
      sku: string;
      locked_at: string | null;
      exported_at: string | null;
    }>(sql, params);

    await writeAuditEvent({
      eventType: 'application_no_recovered',
      actorRole: 'applicant',
      ip: getClientIp(req),
      metadata: { site_code: siteCode, from, to, count: result.rows.length },
    });

    res.json({
      store: { shop: store.shop },
      rows: result.rows.map((row) => ({
        application_no: row.application_no,
        submission_type: row.submission_type,
        submitted_at: toHKString(row.submitted_at),
        application_date: row.application_date,
        source: row.source,
        sku: row.sku,
        locked: Boolean(row.locked_at || row.exported_at),
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
  return_qty: z.number({ invalid_type_error: 'QTY 必須為整數' }).int('QTY 必須為整數').min(RETURN_QTY_MIN).max(RETURN_QTY_MAX).optional(),
  return_reason: z.string().trim().max(200).optional().default(''),
  return_confirmer_name: z.string().trim().max(200).optional().default(''),
  return_confirmer_phone: z.string().trim().max(200).optional().default(''),
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

    if (existing.submission_type === 'return' && !isReturnModificationOpen(existing.return_window_key, hkTodayForDateColumn())) {
      res.status(400).json({ error: '此申請所屬的店舖申請退行貨日期已結束，現時只可查詢', field: null });
      return;
    }

    const ip = getClientIp(req);

    if (existing.submission_type === 'return') {
      if (typeof data.return_qty !== 'number') {
        res.status(400).json({ error: 'QTY 必須為整數', field: 'return_qty' });
        return;
      }
      try {
        const row = await modifyReturnSubmission({
          applicationNo: data.application_no,
          siteCode,
          sku: data.sku,
          qty: data.return_qty,
          reason: data.return_reason,
          confirmerName: data.return_confirmer_name,
          confirmerPhone: data.return_confirmer_phone,
          ip,
          changeSource: 'web_modify',
        });
        await writeAuditEvent({
          eventType: 'submission_modified',
          actorRole: 'applicant',
          submissionId: row.id,
          applicationNo: row.application_no,
          ip,
          metadata: { submission_type: 'return' },
        });
        res.json({ submission: serializeReturnSubmission(row) });
      } catch (err) {
        if (err instanceof LockedError || err instanceof ReturnWindowClosedError || err instanceof ReturnSubmissionConflictError) {
          res.status(err instanceof LockedError || err instanceof ReturnSubmissionConflictError ? 409 : 400).json({
            error: err.message,
            field: err instanceof ReturnSubmissionConflictError ? 'sku' : null,
          });
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
