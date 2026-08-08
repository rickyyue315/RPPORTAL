import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Assigns a request id (echoing the caller's X-Request-Id when present) and
 * logs one line per request so individual operations can be traced across the
 * error logs. No request bodies or secrets are ever logged.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.get('x-request-id')?.trim() || randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.locals.requestId = requestId;
  const startedAt = performance.now();
  res.on('finish', () => {
    const durationMs = Math.round(performance.now() - startedAt);
    console.log(`[req] ${requestId} ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
  });
  next();
}
