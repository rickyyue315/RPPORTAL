import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
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
import { RF_REMARK_REQUIRED_SITES, SKU_PATTERN } from './lib/validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      })};`);
  });

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store');
        }
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
