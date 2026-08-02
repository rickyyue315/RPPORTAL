import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'node:path';
import { config } from './config.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { checkDatabase } from './db/pool.js';
import { csrfProtection, csrfTokenCookie } from './middleware/csrf.js';
import { asyncHandler } from './middleware/helpers.js';
import { toHKString } from './lib/time.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
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
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(csrfTokenCookie);

  app.use(
    express.static(path.join(process.cwd(), 'public'), {
      index: 'index.html',
      maxAge: '1h',
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) {
      console.error('[error]', req.method, req.originalUrl, err.message);
    }
    if (!res.headersSent) {
      res.status(status).json({
        error: status >= 500 ? '伺服器錯誤' : err.message,
      });
    }
  });

  return app;
}
