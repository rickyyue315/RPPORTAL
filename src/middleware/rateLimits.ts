import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { PostgresRateLimitStore } from './postgresRateLimitStore.js';

const keyGenerator = (req: Request): string => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  return `${ip}:${req.path}`;
};

function createLimiter(windowMs: number, limit: number, message: string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    store: new PostgresRateLimitStore(windowMs),
    skip: () => process.env.NODE_ENV === 'test',
    message: { error: message },
  });
}

export const publicSubmitLimiter = createLimiter(15 * 60 * 1000, 50, '提交次數過多，請稍後再試');

export const publicLookupLimiter = createLimiter(15 * 60 * 1000, 120, '查詢次數過多，請稍後再試');

export const excelImportLimiter = createLimiter(60 * 60 * 1000, 30, '匯入次數過多，請稍後再試');

export const adminLoginLimiter = createLimiter(15 * 60 * 1000, 20, '登入嘗試次數過多，請稍後再試');

export const adminActionLimiter = createLimiter(15 * 60 * 1000, 200, '操作次數過多，請稍後再試');

export const excelExportLimiter = createLimiter(60 * 60 * 1000, 60, '匯出次數過多，請稍後再試');
