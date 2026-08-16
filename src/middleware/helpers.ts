import type { NextFunction, Request, Response } from 'express';

export function getClientIp(req: Request): string {
  // Express already applies the configured trust-proxy hop count and returns
  // the first untrusted address. Do not parse X-Forwarded-For manually: doing
  // so would allow clients to spoof the first header value.
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Rejects requests whose named path parameters are not UUIDs before they reach
 * the database (an unparseable uuid would otherwise surface as a 500).
 */
export function requireUuidParam(...names: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const name of names) {
      const value = req.params[name];
      if (!value || !UUID_PATTERN.test(value)) {
        res.status(400).json({ error: '參數格式無效' });
        return;
      }
    }
    next();
  };
}
