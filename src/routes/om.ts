import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, getClientIp, requireUuidParam } from '../middleware/helpers.js';
import { adminActionLimiter } from '../middleware/rateLimits.js';
import { requirePortalUser } from '../middleware/portalAuth.js';
import { requireOm } from '../middleware/omAuth.js';
import { writeAuditEvent } from '../lib/audit.js';
import {
  DesignatedSkuClosedError,
  DesignatedSkuError,
  DesignatedSkuForbiddenError,
  DesignatedSkuNotFoundError,
} from '../services/designatedSku.js';
import {
  listReasons,
  ZeroSalesBatchClosedError,
  ZeroSalesReplyError,
  ZeroSalesReplyNotRequiredError,
} from '../services/zeroSales.js';
import {
  getOmDesignatedSkuMatters,
  getOmOverview,
  getOmStockSummary,
  getOmZeroSalesBatches,
  getOmZeroSalesItems,
  OmSiteAccessError,
  replyDesignatedSkuAsOm,
  replyZeroSalesAsOm,
} from '../services/omPortal.js';

export const omRouter = Router();

// 所有 OM API 都必須是已登入的 OM 帳戶；店舖／Buyer／SCT 一律 403。
omRouter.use(requirePortalUser, requireOm);

/** GET /api/portal/om/overview — OM 管轄店舖的全部待辦與走勢摘要 */
omRouter.get(
  '/overview',
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const data = await getOmOverview(req.omUsername!);
    res.json({ ok: true, ...data, om: req.omDisplayName || data.om, om_username: req.omUsername });
  }),
);

/** GET /api/portal/om/zero-sales/batches — 只含 OM 管轄店舖的週次 */
omRouter.get(
  '/zero-sales/batches',
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ batches: await getOmZeroSalesBatches(req.omUsername!) });
  }),
);

/** GET /api/portal/om/zero-sales/reasons — 與店舖相同的回覆原因 */
omRouter.get(
  '/zero-sales/reasons',
  adminActionLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ reasons: await listReasons(true) });
  }),
);

/** GET /api/portal/om/zero-sales/items — OM 管轄店舖的零銷售行 */
omRouter.get(
  '/zero-sales/items',
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const batchId = typeof req.query.batch_id === 'string' ? req.query.batch_id.trim() : '';
    if (batchId && !z.string().uuid().safeParse(batchId).success) {
      res.status(400).json({ error: '批次編號無效' });
      return;
    }
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (status && status !== 'pending' && status !== 'replied') {
      res.status(400).json({ error: '狀態篩選無效' });
      return;
    }
    const siteCode = typeof req.query.site_code === 'string' ? req.query.site_code.trim().toUpperCase() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    try {
      const items = await getOmZeroSalesItems(req.omUsername!, {
        batchId: batchId || undefined,
        status: status || undefined,
        siteCode: siteCode || undefined,
        q: q || undefined,
      });
      res.json({ items });
    } catch (err) {
      if (err instanceof OmSiteAccessError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

const zeroSalesReplySchema = z.object({
  reason_code: z.string().trim().min(1, '請選擇回覆原因'),
  reason_note: z.string().max(2000).optional().default(''),
});

/** PUT /api/portal/om/zero-sales/items/:id/reply — OM 代店舖回覆／修改 */
omRouter.put(
  '/zero-sales/items/:id/reply',
  requireUuidParam('id'),
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = zeroSalesReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '回覆資料無效' });
      return;
    }
    try {
      const result = await replyZeroSalesAsOm({
        username: req.omUsername!,
        userId: req.portalUser!.id,
        itemId: req.params.id as string,
        reasonCode: parsed.data.reason_code,
        reasonNote: parsed.data.reason_note ?? '',
      });
      await writeAuditEvent({
        eventType: 'om_zero_sales_reply',
        actorRole: 'om',
        actor: req.omUsername,
        ip: getClientIp(req),
        metadata: {
          om: req.omDisplayName || req.omUsername,
          site_code: result.site_code,
          sku: result.sku,
          item_id: result.item.id,
          entered: result.entered,
          reason_code: result.item.reason_code,
        },
      });
      res.json({ ok: true, entered: result.entered, item: result.item, site_code: result.site_code, sku: result.sku });
    } catch (err) {
      if (err instanceof OmSiteAccessError) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof ZeroSalesReplyNotRequiredError) {
        res.status(409).json({ error: err.message, code: 'REPLY_NOT_REQUIRED' });
        return;
      }
      if (err instanceof ZeroSalesBatchClosedError) {
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

/** GET /api/portal/om/designated-sku/matters — 只含 OM 管轄店舖的指定 SKU 事項 */
omRouter.get(
  '/designated-sku/matters',
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const batchId = typeof req.query.batch_id === 'string' ? req.query.batch_id.trim() : '';
    if (batchId && !z.string().uuid().safeParse(batchId).success) {
      res.status(400).json({ error: '批次編號無效' });
      return;
    }
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (status && status !== 'pending' && status !== 'replied') {
      res.status(400).json({ error: '狀態篩選無效' });
      return;
    }
    const siteCode = typeof req.query.site_code === 'string' ? req.query.site_code.trim().toUpperCase() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    try {
      const matters = await getOmDesignatedSkuMatters(req.omUsername!, {
        batchId: batchId || undefined,
        status: (status || undefined) as 'pending' | 'replied' | undefined,
        siteCode: siteCode || undefined,
        q: q || undefined,
      });
      res.json({ matters });
    } catch (err) {
      if (err instanceof OmSiteAccessError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

const designatedSkuMatterCodePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

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

/** PUT /api/portal/om/designated-sku/matters/:code/reply — OM 代店舖提交整份事項 */
omRouter.put(
  '/designated-sku/matters/:code/reply',
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
      const matter = await replyDesignatedSkuAsOm({
        username: req.omUsername!,
        userId: req.portalUser!.id,
        matterCode: code,
        items: parsed.data.items,
      });
      await writeAuditEvent({
        eventType: 'om_designated_sku_reply',
        actorRole: 'om',
        actor: req.omUsername,
        ip: getClientIp(req),
        metadata: {
          om: req.omDisplayName || req.omUsername,
          site_code: matter.site_code,
          matter_code: matter.matter_code,
          batch_code: matter.batch_code,
          item_count: matter.item_count,
          total: matter.reply_total,
        },
      });
      res.json({ ok: true, matter });
    } catch (err) {
      if (err instanceof OmSiteAccessError || err instanceof DesignatedSkuForbiddenError) {
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

/** GET /api/portal/om/stock — OM 合計走勢 + 每店最新一期；可指定管轄店舖 */
omRouter.get(
  '/stock',
  adminActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const siteCode = typeof req.query.site_code === 'string' ? req.query.site_code.trim().toUpperCase() : '';
    try {
      const data = await getOmStockSummary(req.omUsername!, siteCode);
      res.json({ ok: true, ...data });
    } catch (err) {
      if (err instanceof OmSiteAccessError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);
