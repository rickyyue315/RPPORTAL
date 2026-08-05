import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';

const keyGenerator = (req: Request): string => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  return `${ip}:${req.path}`;
};

export const publicSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: '提交次數過多，請稍後再試' },
});

export const publicLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: '查詢次數過多，請稍後再試' },
});

export const excelImportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: '匯入次數過多，請稍後再試' },
});

export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: '登入嘗試次數過多，請稍後再試' },
});

export const adminActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: '操作次數過多，請稍後再試' },
});

export const excelExportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: '匯出次數過多，請稍後再試' },
});
