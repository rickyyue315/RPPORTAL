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
