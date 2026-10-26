import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { asyncHandler, getClientIp, requireUuidParam } from '../middleware/helpers.js';
import {
  adminActionLimiter,
  excelExportLimiter,
  excelImportLimiter,
  publicSubmitLimiter,
} from '../middleware/rateLimits.js';
import {
  PORTAL_SESSION_COOKIE,
  requireNormalPortalOpen,
  requirePasswordChanged,
  requirePortalRole,
  requirePortalUser,
  requireStoreSite,
} from '../middleware/portalAuth.js';
import { config } from '../config.js';
import { getStore } from '../services/stores.js';
import {
  createPortalSession,
  destroyPortalSession,
  normalizePortalUsername,
  verifySharedPassword,
  type PortalUserRow,
} from '../services/portalAuth.js';
import {
  createNormalSubmission,
  decideSubmission,
  getNormalSubmissionById,
  getReviewEvents,
  getStoreRouteConfig,
  insertNormalWorkflowRow,
  listRejectionReasons,
  listReviewerHistory,
  listReviewerQueue,
  listStoreNormalSubmissions,
  updateReviewRemark,
  validateNormalBusinessFields,
  assertNoActiveOrCooldown,
  assertReviewerScope,
  ActiveSubmissionConflictError,
  CooldownActiveError,
  ReviewDecisionError,
  SubmissionNotFoundError,
  WorkflowConfigurationError,
  WorkflowLockedError,
  WorkflowPermissionError,
  type NormalSubmissionListItem,
  type WorkflowRow,
} from '../services/ndrfWorkflow.js';
import { writeAuditEvent } from '../lib/audit.js';
import { normalizeText } from '../lib/fields.js';
import { toHKDateString, toHKString } from '../lib/time.js';
import { CSRF_COOKIE } from '../middleware/csrf.js';
import {
  EXCEL_UPLOAD_EXTENSION_ERROR,
  parseImportWorkbook,
} from '../lib/excelImport.js';
import { buildImportRecordBuffer } from '../lib/excelExport.js';
import { fingerprintPayload, getIdempotencyKey, hasInvalidIdempotencyKey } from '../lib/idempotency.js';
import { getUploadedFile, validateUploadedXlsx } from '../lib/upload.js';
import { createImportBatch, findPortalImportBatchByIdempotencyKey, getPortalImportBatchRecord, importBatchResponse, lockImportIdempotencyKey, type ImportBatchRow } from '../services/importBatches.js';
import { query, withTransaction } from '../db/pool.js';
import {
  listMyBatches as listMyZeroSalesBatches,
  listMyItems as listMyZeroSalesItems,
  listReasons as listZeroSalesReasons,
  replyItem as replyZeroSalesItem,
  ZeroSalesBatchClosedError,
  ZeroSalesReplyError,
} from '../services/zeroSales.js';
import { getShopStockForStore } from '../services/shopStock.js';
import { buildShopStockStoreBuffer } from '../services/shopStockExport.js';
import { buildZeroSalesStoreExportBuffer } from '../lib/zeroSales.js';
import {
  countPendingMatters as countDesignatedSkuPending,
  DesignatedSkuClosedError,
  DesignatedSkuError,
  DesignatedSkuForbiddenError,
  DesignatedSkuNotFoundError,
  getMyMatter as getDesignatedSkuMatter,
  listMyMatters as listDesignatedSkuMatters,
  submitMatterReply as submitDesignatedSkuReply,
  type DesignatedSkuMatter,
} from '../services/designatedSku.js';

export const portalRouter = Router();

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

/** Batch import preflight collected per-row errors; nothing was inserted. */
export class ImportPreflightError extends Error {
  constructor(readonly importErrors: Array<{ row: number; field: string; reason: string }>) {
    super('匯入失敗');
    this.name = 'ImportPreflightError';
  }
}

const businessFieldSchema = z.object({
  brand: z.string().max(500).optional().default(''),
  sku: z.string().trim().min(1, 'SKU 為必填').max(100),
  rp_type: z.string().max(100).optional().default(''),
  safety_stock: z.string().max(100).optional().default(''),
  nd_code: z.string().max(300).optional().default(''),
  remark: z.string().max(2000).optional().default(''),
});

const loginSchema = z.object({
  username: z.string().trim().min(1),
  // One shared password for every Portal account (default SASA1234): shops
  // enter their Site Code plus this same password.
  password: z.string().optional().default(''),
});

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

function serializeWorkflowRow(row: WorkflowRow | NormalSubmissionListItem) {  return {
    id: row.id,
    application_no: row.application_no,
    source: row.source,
    submission_type: row.submission_type,
    site_code: row.site_code,
    shop: 'shop_snapshot' in row ? (row.shop_snapshot ?? '') : '',
    application_date: row.application_date,
    submitted_at: toHKString(row.submitted_at),
    sku: row.sku,
    rp_type: row.rp_type,
    safety_stock: row.safety_stock,
    nd_code: row.nd_code,
    remark: row.remark,
    status: 'status' in row ? row.status : 'received',
    route: row.ndrf_route,
    workflow_status: row.workflow_status,
    rejected_at: 'rejected_at' in row && row.rejected_at ? toHKString(row.rejected_at) : null,
    review_round: 'review_round' in row ? row.review_round : 0,
    round_started_at: 'round_started_at' in row && row.round_started_at ? toHKString(row.round_started_at) : null,
    review_remark: 'current_review_remark' in row ? row.current_review_remark : null,
    locked: Boolean(row.exported_at || ('locked_at' in row ? row.locked_at : false)),
    exported_at: row.exported_at ? toHKString(row.exported_at) : null,
  };
}

async function storeReplaySubmission(
  key: string | undefined,
  fingerprint: string,
  siteCode: string,
  storeUserId: string,
  res: Response,
): Promise<boolean> {
  if (!key) return false;
  const existing = await query<WorkflowRow>(
    `SELECT * FROM submissions
      WHERE idempotency_key = $1 AND created_by_portal_user_id = $2 AND site_code = $3`,
    [key, storeUserId, siteCode],
  );
  const row = existing.rows[0];
  if (!row) return false;
  if (row.idempotency_fingerprint !== fingerprint || row.submission_type !== 'normal') {
    res.status(409).json({ error: '此提交重試鍵已用於不同資料，請重新整理頁面後再提交' });
    return true;
  }
  res.status(200).json({ submission: serializeWorkflowRow(row), replayed: true });
  return true;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

portalRouter.post(
  '/auth/login',
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    // Portal (Store / Buyer / SCT) login: Site Code (username) + one shared
    // password (PORTAL_SHARED_PASSWORD, default SASA1234). The account must
    // still exist and be active; the admin backend is unaffected and keeps its
    // own ADMIN_PASSWORD.
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '請輸入使用者名稱' });
      return;
    }
    if (!verifySharedPassword(parsed.data.password)) {
      res.status(401).json({ error: '密碼不正確' });
      return;
    }
    const normalized = normalizePortalUsername(parsed.data.username);
    if (!normalized) {
      res.status(400).json({ error: '請輸入使用者名稱' });
      return;
    }
    const found = await query<PortalUserRow>('SELECT * FROM portal_users WHERE username = $1', [normalized]);
    const user = found.rows[0];
    // No self-service: accounts are created by Admin (store sync / manual
    // creation), so an unknown or deactivated username is simply rejected.
    if (!user || !user.active) {
      // Same message either way so the response does not reveal whether
      // the username exists or is deactivated.
      res.status(401).json({ error: '使用者名稱不正確或帳戶已停用' });
      return;
    }
    const session = await createPortalSession(user.id);
    res.cookie(PORTAL_SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: config.env === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: config.sessionTtlHours * 3600 * 1000,
    });
    await writeAuditEvent({
      eventType: 'portal_login',
      actorRole: user.role,
      actor: user.username,
      ip: getClientIp(req),
      metadata: { role: user.role, site_code: user.site_code ?? null, shared_password: true },
    });
    res.json({
      ok: true,
      user: {
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        site_code: user.site_code,
        must_change_password: false,
      },
    });
  }),
);

portalRouter.post(
  '/auth/logout',
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const token = req.cookies?.[PORTAL_SESSION_COOKIE];
    if (token) {
      await destroyPortalSession(token);
      await writeAuditEvent({
        eventType: 'portal_logout',
        actorRole: req.portalUser?.role,
        actor: req.portalUser?.username,
        ip: getClientIp(req),
      });
    }
    res.clearCookie(PORTAL_SESSION_COOKIE);
    // Rotate the double-submit token so a stale page cannot reuse it.
    res.clearCookie(CSRF_COOKIE);
    res.json({ ok: true });
  }),
);

portalRouter.get(
  '/auth/me',
  requirePortalUser,
  (req: Request, res: Response) => {
    const user = req.portalUser!;
    res.json({
      user: {
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        site_code: user.site_code,
        must_change_password: false,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Store — options / submit / import / list / detail
// ---------------------------------------------------------------------------

portalRouter.get(
  '/store/options',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const siteCode = req.storeSiteCode!;
    const store = await getStore(siteCode);
    const route = await getStoreRouteConfig(siteCode);
    res.json({
      store: { site_code: siteCode, shop: store?.shop ?? '' },
      route: {
        sct_review_required: route.sct_review_required,
        remark_required: route.remark_required,
      },
      rejectionReasons: await listRejectionReasons(true),
    });
  }),
);

portalRouter.post(
  '/store/submit',
  requirePortalUser,
  requireStoreSite,
  requireNormalPortalOpen,
  publicSubmitLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = businessFieldSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({ error: first?.message ?? '輸入資料無效', field: first?.path[0] ?? null });
      return;
    }
    const data = parsed.data;
    const siteCode = req.storeSiteCode!;
    if (hasInvalidIdempotencyKey(req)) {
      res.status(400).json({ error: 'Idempotency-Key 格式無效' });
      return;
    }
    const idempotencyKey = getIdempotencyKey(req);
    // Fingerprint the normalized values so a retry that only differs by
    // whitespace/case still replays instead of failing with a 409.
    const idempotencyFingerprint = fingerprintPayload({
      brand: normalizeText(data.brand),
      sku: normalizeText(data.sku),
      rp_type: normalizeText(data.rp_type),
      safety_stock: normalizeText(data.safety_stock),
      nd_code: normalizeText(data.nd_code),
      remark: normalizeText(data.remark),
      site_code: siteCode,
    });
    if (await storeReplaySubmission(idempotencyKey, idempotencyFingerprint, siteCode, req.portalUser!.id, res)) return;
    const store = await getStore(siteCode);
    const ip = getClientIp(req);

    let row: WorkflowRow;
    try {
      row = await createNormalSubmission({
        siteCode,
        source: 'web',
        fields: data,
        ip,
        changeSource: 'portal_submit',
        actorRole: 'store',
        actor: req.portalUser!.username,
        actorUserId: req.portalUser!.id,
        shopName: store?.shop ?? '',
        idempotencyKey,
        idempotencyFingerprint,
      });
    } catch (err) {
      if (err instanceof WorkflowConfigurationError || err instanceof ActiveSubmissionConflictError || err instanceof CooldownActiveError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof Error && (err as Error & { field?: string }).field) {
        res.status(400).json({ error: err.message, field: (err as Error & { field?: string }).field });
        return;
      }
      // A concurrent duplicate submit loses the race on a unique index. When it
      // is the idempotency key the winner already holds this exact payload, so
      // replay it; an active-key race means another submission just won.
      if (isPgUniqueViolation(err)) {
        if (await storeReplaySubmission(idempotencyKey, idempotencyFingerprint, siteCode, req.portalUser!.id, res)) return;
        if ((err as { constraint?: string }).constraint === 'uq_submissions_active_workflow_key') {
          res.status(409).json({ error: new ActiveSubmissionConflictError().message });
          return;
        }
      }
      throw err;
    }

    await writeAuditEvent({
      eventType: 'portal_submission_created',
      actorRole: 'store',
      actor: req.portalUser!.username,
      submissionId: row.id,
      applicationNo: row.application_no,
      ip,
      metadata: { source: 'web', site_code: siteCode, route: row.ndrf_route, workflow_status: row.workflow_status },
    });
    res.status(201).json({ submission: serializeWorkflowRow(row), store: { shop: store?.shop ?? '' } });
  }),
);

portalRouter.get(
  '/store/template',
  requirePortalUser,
  requireStoreSite,
  excelExportLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const { generateTemplateWorkbook } = await import('../lib/excelExport.js');
    const buffer = await generateTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Safety Request.xlsx"`);
    res.send(buffer);
  }),
);

portalRouter.post(
  '/store/import',
  requirePortalUser,
  requireStoreSite,
  requireNormalPortalOpen,
  excelImportLimiter,
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const file = getUploadedFile(req)!;
    const uploadError = validateUploadedXlsx(file, config.maxUploadBytes, EXCEL_UPLOAD_EXTENSION_ERROR);
    if (uploadError) {
      res.status(uploadError.status).json({ error: uploadError.message });
      return;
    }
    const siteCode = req.storeSiteCode!;
    const storeUserId = req.portalUser!.id;
    const store = await getStore(siteCode);
    if (!store) {
      res.status(400).json({ error: `Site Code「${siteCode}」不存在於門店主檔` });
      return;
    }

    const parsed = await parseImportWorkbook(file.buffer, new Set([siteCode]), config.maxImportRows);
    const idempotencyKey = getIdempotencyKey(req);
    if (hasInvalidIdempotencyKey(req)) {
      res.status(400).json({ error: 'Idempotency-Key 格式無效' });
      return;
    }
    if (idempotencyKey) {
      const replay = await query<ImportBatchRow>(
        `SELECT id, filename, sheet_name, row_count, success_count, failed_count,
                results, content_hash, created_by, submission_type, idempotency_key, portal_user_id, site_code, created_at
           FROM import_batches
          WHERE idempotency_key = $1 AND submission_type = 'normal' AND portal_user_id = $2
          LIMIT 1`,
        [idempotencyKey, storeUserId],
      );
      const replayRow = replay.rows[0];
      if (replayRow) {
        if (replayRow.content_hash !== parsed.contentHash) {
          res.status(409).json({ error: '此重試鍵已用於另一個 Excel 檔案' });
          return;
        }
        res.status(200).json(importBatchResponse(replayRow));
        return;
      }
    }
    if (!parsed.ok || !parsed.rows) {
      await writeAuditEvent({
        eventType: 'excel_import_error',
        actorRole: 'store',
        actor: req.portalUser!.username,
        ip: getClientIp(req),
        metadata: { filename: file.originalname, site_code: siteCode, errors: parsed.errors ?? [] },
      });
      res.status(400).json({ error: '匯入失敗', totalRows: parsed.totalRows, errors: parsed.errors ?? [] });
      return;
    }

    const ip = getClientIp(req);
    let results;
    try {
      results = await withTransaction(async (client) => {
        if (idempotencyKey) {
          await lockImportIdempotencyKey(client, idempotencyKey, 'normal');
          const replay = await findPortalImportBatchByIdempotencyKey(client, idempotencyKey, storeUserId);
          if (replay) {
            if (replay.content_hash !== parsed.contentHash) throw new Error('此重試鍵已用於另一個 Excel 檔案');
            return { batchId: replay.id, rows: replay.results, successCount: replay.success_count, replayed: true };
          }
        }

        // Preflight: collect every field/active/cooldown error before inserting
        // anything so the batch is all-or-nothing with per-row reasons.
        const preflightErrors: Array<{ row: number; field: string; reason: string }> = [];
        // Read the remark requirement through the transaction client so the
        // check is consistent with the inserts that follow.
        const routeResult = await client.query<{ remark_required: boolean }>(
          'SELECT remark_required FROM ndrf_store_routes WHERE site_code = $1',
          [siteCode],
        );
        const remarkRequired = routeResult.rows[0]?.remark_required ?? false;
        const seenKeys = new Set<string>();
        for (const item of parsed.rows!) {
          for (const fe of validateNormalBusinessFields(item.fields, siteCode, remarkRequired)) {
            preflightErrors.push({ row: item.rowNumber, field: fe.field === 'sku' ? 'SKU' : fe.field, reason: fe.message });
          }
          const batchKey = `${siteCode}|${normalizeText(item.fields.sku)}|${normalizeText(item.fields.rp_type)}`;
          if (seenKeys.has(batchKey)) {
            preflightErrors.push({ row: item.rowNumber, field: 'SKU', reason: '同一 Excel 內 Site Code + SKU + RP Type 重複' });
          } else {
            seenKeys.add(batchKey);
          }
          try {
            await assertNoActiveOrCooldown(client, {
              siteCode,
              sku: item.fields.sku,
              rpType: item.fields.rp_type,
            });
          } catch (err) {
            if (err instanceof ActiveSubmissionConflictError || err instanceof CooldownActiveError) {
              preflightErrors.push({ row: item.rowNumber, field: 'SKU', reason: err.message });
            } else {
              throw err;
            }
          }
        }
        if (preflightErrors.length > 0) {
          throw new ImportPreflightError(preflightErrors);
        }

        const rowsOut: Array<{ row: number; application_no: string; site_code: string; sku: string; submitted_at: string }> = [];
        for (const item of parsed.rows!) {
          const row = await insertNormalWorkflowRow(client, {
            siteCode,
            source: 'excel',
            fields: item.fields,
            ip,
            changeSource: 'portal_import',
            actorRole: 'store',
            actor: req.portalUser!.username,
            actorUserId: storeUserId,
            shopName: store.shop,
          });
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
          createdBy: req.portalUser!.username,
          submissionType: 'normal',
          idempotencyKey,
          portalUserId: storeUserId,
          siteCode,
        });
        return { batchId, rows: rowsOut, successCount: rowsOut.length };
      });
    } catch (err) {
      if (err instanceof ActiveSubmissionConflictError || err instanceof CooldownActiveError || err instanceof WorkflowConfigurationError) {
        await writeAuditEvent({
          eventType: 'excel_import_error',
          actorRole: 'store',
          actor: req.portalUser!.username,
          ip,
          metadata: { filename: file.originalname, site_code: siteCode, error: err.message },
        });
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof ImportPreflightError) {
        await writeAuditEvent({
          eventType: 'excel_import_error',
          actorRole: 'store',
          actor: req.portalUser!.username,
          ip,
          metadata: { filename: file.originalname, site_code: siteCode, errors: err.importErrors },
        });
        res.status(400).json({
          error: '匯入失敗',
          totalRows: parsed.totalRows,
          errors: err.importErrors,
        });
        return;
      }
      if (err instanceof Error && err.message === '此重試鍵已用於另一個 Excel 檔案') {
        res.status(409).json({ error: err.message });
        return;
      }
      // Two different imports submitting the same rows concurrently: the loser
      // hits the active-submission unique index after the winner commits.
      if (isPgUniqueViolation(err) && (err as { constraint?: string }).constraint === 'uq_submissions_active_workflow_key') {
        res.status(409).json({ error: new ActiveSubmissionConflictError().message });
        return;
      }
      throw err;
    }

    await writeAuditEvent({
      eventType: 'excel_import',
      actorRole: 'store',
      actor: req.portalUser!.username,
      ip,
      metadata: {
        filename: file.originalname,
        site_code: siteCode,
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

portalRouter.get(
  '/store/import/record/:batchId',
  requirePortalUser,
  requireStoreSite,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsedId = z.string().uuid().safeParse(req.params.batchId);
    if (!parsedId.success) {
      res.status(400).json({ error: '匯入批次編號無效' });
      return;
    }
    const key = getIdempotencyKey(req);
    if (!key) {
      res.status(400).json({ error: '需要提供原匯入的 Idempotency-Key 才能下載記錄' });
      return;
    }
    const batch = await getPortalImportBatchRecord(parsedId.data, key, req.portalUser!.id);
    if (!batch) {
      res.status(404).json({ error: '找不到匯入批次或重試鍵不符' });
      return;
    }
    const buffer = await buildImportRecordBuffer(batch.results as never);
    const stamp = toHKString(new Date()).replace(/[^0-9]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="NDRF_Import_Record_${stamp}.xlsx"`);
    res.send(buffer);
  }),
);

portalRouter.get(
  '/store/submissions',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const rows = await listStoreNormalSubmissions(req.portalUser!.id, req.storeSiteCode!);
    res.json({ submissions: rows.map(serializeWorkflowRow) });
  }),
);

portalRouter.get(
  '/store/submissions/:id',
  requireUuidParam('id'),
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const row = await getNormalSubmissionById(req.params.id as string);
    if (!row || row.site_code !== req.storeSiteCode! || row.submission_type !== 'normal') {
      res.status(404).json({ error: '找不到申報' });
      return;
    }
    const events = await getReviewEvents(row.id);
    res.json({
      submission: serializeWorkflowRow(row),
      events: events.map((event) => ({
        event_type: event.event_type,
        actor_role: event.actor_role,
        actor: event.actor,
        review_round: event.review_round,
        remark: event.remark,
        reject_reason_code: event.reject_reason_code,
        reject_reason_label: event.reject_reason_label,
        reject_reason_note: event.reject_reason_note,
        created_at: toHKString(event.created_at),
      })),
    });
  }),
);

// ---------------------------------------------------------------------------
// Reviewer (Buyer / SCT) — queue / history / detail / remark / decision
// ---------------------------------------------------------------------------

const reviewerAuth = [requirePortalUser, requirePasswordChanged, requirePortalRole(['buyer', 'sct'])] as const;

portalRouter.get(
  '/reviewer/queue',
  ...reviewerAuth,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.portalUser!;
    const rows = await listReviewerQueue(user.id, user.role as 'buyer' | 'sct');
    res.json({ submissions: rows.map(serializeWorkflowRow) });
  }),
);

portalRouter.get(
  '/reviewer/history',
  ...reviewerAuth,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.portalUser!;
    const parsed = historyPageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: '分頁參數無效' });
      return;
    }
    const rows = await listReviewerHistory(user.id, user.role as 'buyer' | 'sct', {
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    res.json({ submissions: rows.map(serializeWorkflowRow) });
  }),
);

portalRouter.get(
  '/reviewer/submissions/:id',
  requireUuidParam('id'),
  ...reviewerAuth,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const row = await getNormalSubmissionById(req.params.id as string);
    if (!row || row.submission_type !== 'normal' || !row.workflow_status) {
      res.status(404).json({ error: '找不到申報' });
      return;
    }
    try {
      // Same ownership check as the decision/remark endpoints: buyers may only
      // read submissions for SKUs they currently own, SCT only SCT-routed rows.
      await withTransaction((client) =>
        assertReviewerScope(client, {
          id: req.portalUser!.id,
          role: req.portalUser!.role as 'buyer' | 'sct',
        }, row),
      );
    } catch (err) {
      if (err instanceof WorkflowPermissionError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }
    const events = await getReviewEvents(row.id);
    res.json({
      submission: serializeWorkflowRow(row),
      rejectionReasons: await listRejectionReasons(true),
      events: events.map((event) => ({
        event_type: event.event_type,
        actor_role: event.actor_role,
        actor: event.actor,
        review_round: event.review_round,
        remark: event.remark,
        reject_reason_code: event.reject_reason_code,
        reject_reason_label: event.reject_reason_label,
        reject_reason_note: event.reject_reason_note,
        created_at: toHKString(event.created_at),
      })),
    });
  }),
);

const historyPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

const remarkSchema = z.object({
  remark: z.string().max(4000).optional().default(''),
});

portalRouter.put(
  '/reviewer/submissions/:id/remark',
  requireUuidParam('id'),
  ...reviewerAuth,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = remarkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Review Remark 無效' });
      return;
    }
    try {
      const row = await updateReviewRemark({
        user: {
          id: req.portalUser!.id,
          role: req.portalUser!.role as 'buyer' | 'sct',
          username: req.portalUser!.username,
        },
        submissionId: req.params.id as string,
        remark: parsed.data.remark,
        ip: getClientIp(req),
      });
      await writeAuditEvent({
        eventType: 'portal_review_remark',
        actorRole: req.portalUser!.role,
        actor: req.portalUser!.username,
        submissionId: row.id,
        applicationNo: row.application_no,
        ip: getClientIp(req),
      });
      res.json({ submission: serializeWorkflowRow(row) });
    } catch (err) {
      if (err instanceof WorkflowPermissionError || err instanceof ReviewDecisionError) {
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

const decisionSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  remark: z.string().max(4000).optional().default(''),
  reject_reason_code: z.string().max(100).optional().default(''),
  reject_reason_note: z.string().max(4000).optional().default(''),
});

portalRouter.post(
  '/reviewer/submissions/:id/decision',
  requireUuidParam('id'),
  ...reviewerAuth,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({ error: first?.message ?? '審批輸入無效', field: first?.path[0] ?? null });
      return;
    }
    try {
      const result = await decideSubmission({
        user: {
          id: req.portalUser!.id,
          role: req.portalUser!.role as 'buyer' | 'sct',
          username: req.portalUser!.username,
        },
        submissionId: req.params.id as string,
        decision: parsed.data.decision,
        remark: parsed.data.remark,
        rejectReasonCode: parsed.data.reject_reason_code,
        rejectReasonNote: parsed.data.reject_reason_note,
        ip: getClientIp(req),
      });
      await writeAuditEvent({
        eventType: 'portal_review_decision',
        actorRole: req.portalUser!.role,
        actor: req.portalUser!.username,
        submissionId: result.row.id,
        applicationNo: result.row.application_no,
        ip: getClientIp(req),
        metadata: { decision: parsed.data.decision, replayed: result.replayed },
      });
      res.status(result.replayed ? 200 : 201).json({
        submission: serializeWorkflowRow(result.row),
        event: {
          event_type: result.event.event_type,
          actor: result.event.actor,
          reject_reason_code: result.event.reject_reason_code,
          reject_reason_label: result.event.reject_reason_label,
          reject_reason_note: result.event.reject_reason_note,
        },
        replayed: result.replayed,
      });
    } catch (err) {
      if (err instanceof WorkflowPermissionError || err instanceof ReviewDecisionError || err instanceof WorkflowLockedError) {
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

// ---------------------------------------------------------------------------
// 90日零銷售 SKU 店舖回覆
// ---------------------------------------------------------------------------

/** GET /api/portal/zero-sales/reasons — 啟用中的回覆原因 */
portalRouter.get(
  '/zero-sales/reasons',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ reasons: await listZeroSalesReasons(true) });
  }),
);

/** GET /api/portal/zero-sales/batches — 本店可見週次 (新到舊，預設第一個 = 最新一週) */
portalRouter.get(
  '/zero-sales/batches',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const batches = await listMyZeroSalesBatches(req.storeSiteCode!);
    res.json({ site_code: req.storeSiteCode, batches });
  }),
);

/** GET /api/portal/zero-sales/my — 本店被指派的 SKU (可按 status / batch_id 篩選) */
portalRouter.get(
  '/zero-sales/my',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { status, batch_id } = req.query as Record<string, string | undefined>;
    const items = await listMyZeroSalesItems(req.storeSiteCode!, {
      status: status === 'pending' || status === 'replied' ? status : undefined,
      batchId: batch_id?.trim() || undefined,
    });
    const store = await getStore(req.storeSiteCode!);
    res.json({ site_code: req.storeSiteCode, shop: store?.shop ?? '', items });
  }),
);

/** GET /api/portal/zero-sales/my/export — 匯出本舖的零銷售清單 (只含本店 SKU；篩選與列表一致：status / batch_id / repeat / q) */
portalRouter.get(
  '/zero-sales/my/export',
  requirePortalUser,
  requireStoreSite,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { status, batch_id, repeat, q } = req.query as Record<string, string | undefined>;
    const batchId = batch_id?.trim() || undefined;
    if (batchId && !/^[0-9a-fA-F-]{36}$/.test(batchId)) {
      res.status(400).json({ error: '批次編號無效' });
      return;
    }
    if (status && status !== 'pending' && status !== 'replied') {
      res.status(400).json({ error: '狀態篩選無效' });
      return;
    }
    // 與店舖頁列表同一資料來源：以登入店舖的 site_code 限定，只可能取得本舖被派發的 SKU
    let items = await listMyZeroSalesItems(req.storeSiteCode!, {
      status: status === 'pending' || status === 'replied' ? status : undefined,
      batchId,
    });
    if (repeat === '1') items = items.filter((it) => (it.occurrence_count ?? 1) >= 2);
    // 搜尋語意與前端一致：SKU / Brand / 描述 不分大小寫包含
    const needle = (q ?? '').trim().toUpperCase();
    if (needle) {
      items = items.filter((it) =>
        `${it.sku} ${it.payload?.['Brand'] ?? ''} ${it.payload?.['SKU Desc'] ?? ''}`.toUpperCase().includes(needle),
      );
    }
    if (!items.length) {
      res.status(404).json({ error: '沒有符合條件的零銷售資料可以匯出' });
      return;
    }
    const buffer = await buildZeroSalesStoreExportBuffer(items.map((it) => ({
      week_label: it.week_label ?? '',
      sku: it.sku,
      payload: it.payload,
      status: it.status,
      reason_label: it.reason_label,
      reason_note: it.reason_note,
      batch_date: it.batch_date ?? (it.batch_created_at ?? '').slice(0, 10),
      is_open: it.is_open !== false,
      occurrence_count: it.occurrence_count ?? 1,
      prev_week_label: it.prev_week_label ?? null,
      prev_status: it.prev_status ?? null,
      prev_reason_label: it.prev_reason_label ?? null,
      auto_filled_from_week: it.auto_filled ? (it.auto_filled_from_week || null) : null,
    })));
    const stamp = toHKDateString(new Date()).replace(/-/g, '');
    const label = (items[0]?.week_label ?? 'all').replace(/[^\w\-]+/g, '_');
    await writeAuditEvent({
      eventType: 'zero_sales_store_export',
      actorRole: 'store',
      actor: req.portalUser!.username,
      ip: getClientIp(req),
      metadata: {
        site_code: req.storeSiteCode,
        batch_id: batchId ?? null,
        status: status ?? null,
        repeat: repeat === '1',
        q: needle || null,
        count: items.length,
      },
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Zero_Sales_${req.storeSiteCode}_${label}_${stamp}.xlsx"`);
    res.send(buffer);
  }),
);

const zeroSalesReplySchema = z.object({
  reason_code: z.string().trim().min(1, '請選擇回覆原因'),
  reason_note: z.string().max(2000).optional().default(''),
});

/** PUT /api/portal/zero-sales/items/:id/reply — 店舖回覆指定 SKU */
portalRouter.put(
  '/zero-sales/items/:id/reply',
  requireUuidParam('id'),
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = zeroSalesReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '回覆資料無效' });
      return;
    }
    try {
      const item = await replyZeroSalesItem({
        itemId: req.params.id as string,
        siteCode: req.storeSiteCode!,
        reasonCode: parsed.data.reason_code,
        reasonNote: parsed.data.reason_note ?? '',
        repliedBy: req.portalUser!.username,
        repliedByUserId: req.portalUser!.id,
      });
      await writeAuditEvent({
        eventType: 'zero_sales_replied',
        actorRole: 'store',
        actor: req.portalUser!.username,
        ip: getClientIp(req),
        metadata: { item_id: item.id, batch_id: item.batch_id, site_code: item.site_code, sku: item.sku, reason_code: item.reason_code },
      });
      res.json({ ok: true, item });
    } catch (err) {
      if (err instanceof ZeroSalesBatchClosedError) {
        // 409 = 週次已封存，前端據 code 自動跳去最新一週
        res.status(409).json({ error: err.message, code: 'BATCH_CLOSED' });
        return;
      }
      if (err instanceof ZeroSalesReplyError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// 存貨走勢（店舖端，唯讀）
//
// 數據隔離：site_code 一律取自 portal session（requireStoreSite 寫入
// req.storeSiteCode），**絕不接受** query / body 傳入的 site_code；
// 回傳只有「本店數據 + 全公司加權平均比率」，不含任何其他店的數字。
// 冇數據時回 200 { has_data: false }，不用 404（前端要畫空狀態而非錯誤）。
// ---------------------------------------------------------------------------
portalRouter.get(
  '/stock/summary',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const siteCode = req.storeSiteCode!;
    const view = await getShopStockForStore(siteCode);
    res.json({ ok: true, ...view });
  }),
);

/**
 * GET /api/portal/stock/summary/export — 匯出本舖的存貨走勢 Excel
 * 數據隔離同 /stock/summary 一樣：site_code 只取自 portal session，
 * 絕不接受 query 參數；內容只有「本店數字 + 全公司加權平均線」，無其他店舖明細。
 */
portalRouter.get(
  '/stock/summary/export',
  requirePortalUser,
  requireStoreSite,
  excelExportLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const siteCode = req.storeSiteCode!;
    const view = await getShopStockForStore(siteCode);
    if (!view.series.length) {
      res.status(404).json({ error: '未有可匯出的存貨數據' });
      return;
    }
    const buffer = await buildShopStockStoreBuffer({
      view,
      generatedAt: toHKString(new Date()),
    });
    const stamp = toHKDateString(new Date()).replace(/-/g, '');
    const filename = `Stock_Trend_${siteCode}_${stamp}.xlsx`;
    await writeAuditEvent({
      eventType: 'shop_stock_store_export',
      actorRole: 'store',
      actor: req.portalUser!.username,
      ip: getClientIp(req),
      metadata: {
        filename,
        site_code: siteCode,
        periods: view.series.length,
      },
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

// ---------------------------------------------------------------------------
// 指定 SKU 回覆（店舖端）
//
// 一個事項內含多個 SKU；店舖一次過回覆整份清單。
// 隔離：site_code 一律取自 portal session，直 link 只帶事項編號，
// 伺服器仍會核對擁有權，不屬於該店舖回 403。
// ---------------------------------------------------------------------------

const designatedSkuMatterCodePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

/**
 * 店舖端只需要顯示及回覆欄位：原文 payload、批次內部備註 settings
 * 一律不回傳，避免日後新增內部欄位時意外外洩。
 */
function serializeStoreMatter(matter: DesignatedSkuMatter) {
  const { settings: _settings, batch_note: _batchNote, items, ...rest } = matter;
  return {
    ...rest,
    items: items.map(({ payload: _payload, ...item }) => item),
  };
}

/** GET /api/portal/designated-sku/pending-count — 導覽列徽章用（只回數字） */
portalRouter.get(
  '/designated-sku/pending-count',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ pending_count: await countDesignatedSkuPending(req.storeSiteCode!) });
  }),
);

/** GET /api/portal/designated-sku/matters — 本店事項（未回覆排先） */
portalRouter.get(
  '/designated-sku/matters',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { status } = req.query as Record<string, string | undefined>;
    const siteCode = req.storeSiteCode!;
    const [matters, store, pending] = await Promise.all([
      listDesignatedSkuMatters(siteCode, {
        status: status === 'pending' || status === 'replied' ? status : undefined,
      }),
      getStore(siteCode),
      countDesignatedSkuPending(siteCode),
    ]);
    res.json({
      site_code: siteCode,
      shop: store?.shop ?? '',
      pending_count: pending,
      matters: matters.map(serializeStoreMatter),
    });
  }),
);

/** GET /api/portal/designated-sku/matters/:code — 單一事項（直 link 用，只限涉及店舖） */
portalRouter.get(
  '/designated-sku/matters/:code',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const code = String(req.params.code ?? '').trim();
    if (!designatedSkuMatterCodePattern.test(code)) {
      res.status(400).json({ error: '事項編號格式無效' });
      return;
    }
    try {
      const matter = await getDesignatedSkuMatter(req.storeSiteCode!, code);
      res.json({ matter: serializeStoreMatter(matter) });
    } catch (err) {
      if (err instanceof DesignatedSkuForbiddenError) {
        res.status(403).json({ error: err.message, code: 'MATTER_FORBIDDEN' });
        return;
      }
      if (err instanceof DesignatedSkuNotFoundError) {
        res.status(404).json({ error: err.message, code: 'MATTER_NOT_FOUND' });
        return;
      }
      throw err;
    }
  }),
);

const designatedSkuReplySchema = z.object({
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

/** PUT /api/portal/designated-sku/matters/:code/reply — 店舖提交／更新整份事項 */
portalRouter.put(
  '/designated-sku/matters/:code/reply',
  requirePortalUser,
  requireStoreSite,
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const code = String(req.params.code ?? '').trim();
    if (!designatedSkuMatterCodePattern.test(code)) {
      res.status(400).json({ error: '事項編號格式無效' });
      return;
    }
    const parsed = designatedSkuReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '回覆資料無效' });
      return;
    }
    try {
      const matter = await submitDesignatedSkuReply({
        siteCode: req.storeSiteCode!,
        matterCode: code,
        items: parsed.data.items,
        repliedBy: req.portalUser!.username,
        repliedByUserId: req.portalUser!.id,
      });
      await writeAuditEvent({
        eventType: 'designated_sku_replied',
        actorRole: 'store',
        actor: req.portalUser!.username,
        ip: getClientIp(req),
        metadata: {
          matter_code: matter.matter_code,
          batch_code: matter.batch_code,
          site_code: matter.site_code,
          item_count: matter.item_count,
          total: matter.reply_total,
          items: matter.items.map((item) => ({
            sku: item.sku,
            no_transfer: item.no_transfer,
            total: item.reply_total,
            lines: item.lines,
            reply_count: item.reply_count,
          })),
        },
      });
      res.json({ ok: true, matter: serializeStoreMatter(matter) });
    } catch (err) {
      if (err instanceof DesignatedSkuForbiddenError) {
        res.status(403).json({ error: err.message, code: 'MATTER_FORBIDDEN' });
        return;
      }
      if (err instanceof DesignatedSkuNotFoundError) {
        res.status(404).json({ error: err.message, code: 'MATTER_NOT_FOUND' });
        return;
      }
      if (err instanceof DesignatedSkuClosedError) {
        res.status(409).json({ error: err.message, code: 'MATTER_CLOSED' });
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
