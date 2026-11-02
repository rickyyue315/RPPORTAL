import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { portalRouter } from './routes/portal.js';
import { checkDatabase } from './db/pool.js';
import { csrfProtection, csrfTokenCookie } from './middleware/csrf.js';
import { asyncHandler } from './middleware/helpers.js';
import { requestLogger } from './middleware/requestLog.js';
import { toHKString } from './lib/time.js';
import {
  ND_CODE_OPTIONS,
  RETURN_QTY_MAX,
  RETURN_QTY_MIN,
  RETURN_REASONS,
  RP_TYPE_OPTIONS,
  URGENT_QTY_MAX,
  URGENT_QTY_MIN,
  URGENT_REASON_OTHER_CODE,
  URGENT_REASON_OTHER_MAX,
  URGENT_REASONS,
  URGENT_WEB_MAX_ITEMS,
} from './lib/fields.js';
import { SKU_PATTERN, RF_REMARK_REQUIRED_SITES } from './lib/validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_VERSION = (JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string }).version;
// Matches local JS/CSS URLs in HTML, with or without an existing ?v= query.
const LOCAL_ASSET_URL = /(\s(?:src|href)=")(\/(?!\/)[^"?]+\.(?:css|js))(?:\?[^"]*)?"/g;

function markHtmlNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/**
 * Versioned JS/CSS URLs change on every release, so browsers may keep them on
 * disk as long as they revalidate first. A matching file returns 304 (headers
 * only) instead of the full bundle, keeping Railway egress low.
 */
function markAssetRevalidate(res: Response): void {
  res.setHeader('Cache-Control', 'public, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export function createApp() {
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          imgSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'https://cdn.jsdelivr.net', 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false, credentials: true }));
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(csrfTokenCookie);
  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, private');
    next();
  });

  // Browser code consumes the same option source as the API validators. This
  // prevents labels and business options from drifting across hand-written JS
  // bundles.
  app.get('/js/options.js', (_req: Request, res: Response) => {
    res
      .type('application/javascript')
      .set('Cache-Control', 'no-store')
      .send(`globalThis.NDRF_OPTIONS = ${JSON.stringify({
        rpTypes: RP_TYPE_OPTIONS,
        skuPattern: SKU_PATTERN.source,
        ndCodes: ND_CODE_OPTIONS,
        rfRemarkRequiredSites: [...RF_REMARK_REQUIRED_SITES],
        urgentReasons: URGENT_REASONS,
        urgentQtyMin: URGENT_QTY_MIN,
        urgentQtyMax: URGENT_QTY_MAX,
        urgentWebMaxItems: URGENT_WEB_MAX_ITEMS,
        urgentReasonOtherCode: URGENT_REASON_OTHER_CODE,
        urgentReasonOtherMax: URGENT_REASON_OTHER_MAX,
        returnReasons: RETURN_REASONS,
        returnQtyMin: RETURN_QTY_MIN,
        returnQtyMax: RETURN_QTY_MAX,
        publicWriteSuspension: {
          enabled: config.publicWriteSuspensionEnabled,
          suspendAt: config.publicWriteSuspensionAt,
        },
      })};`);
  });

  // Store devices often keep a page open for days, and some mobile browsers /
  // in-app webviews reuse cached portal bundles after a deploy. HTML is never
  // stored, while JS/CSS URLs are stamped with the release version and must be
  // revalidated, so a new deployment always renders the latest store layout
  // without downloading unchanged bundles again.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    if (!req.path.endsWith('.html') && !req.path.endsWith('/')) return next();

    const relative = req.path.replace(/^\/+/, '');
    const filePath = path.resolve(
      PUBLIC_DIR,
      relative === '' || relative.endsWith('/') ? `${relative}index.html` : relative,
    );
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return next();

    void readFile(filePath, 'utf8')
      .then((html) => {
        markHtmlNoStore(res);
        res
          .type('html')
          .send(html.replace(LOCAL_ASSET_URL, `$1$2?v=${APP_VERSION}"`));
      })
      .catch(() => next());
  });

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        if (/\.html$/i.test(filePath)) markHtmlNoStore(res);
        else if (/\.(?:js|css)$/i.test(filePath)) markAssetRevalidate(res);
      },
    }),
  );

  app.get('/health', asyncHandler(async (_req: Request, res: Response) => {
    const dbOk = await checkDatabase();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      time: toHKString(new Date()),
    });
  }));

  // CSRF token endpoint for the admin SPA (needs a fresh token on reload).
  app.get('/api/csrf', (req: Request, res: Response) => {
    res.json({ token: req.csrfToken });
  });

  app.use('/api/public', publicRouter);
  app.use('/api/admin', csrfProtection, adminRouter);
  app.use('/api/portal', csrfProtection, portalRouter);

  // 404 for API
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // Central error handler — never leaks DB/config details.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? '檔案超過上載大小限制'
        : '上載表單格式或欄位數量超出限制';
      res.status(status).json({ error: message });
      return;
    }
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) {
      const requestId = (res.locals.requestId as string | undefined) ?? '-';
      console.error('[error]', requestId, req.method, req.originalUrl, err.message);
    }
    if (!res.headersSent) {
      res.status(status).json({
        error: status >= 500 ? '伺服器錯誤' : err.message,
      });
    }
  });

  return app;
}
