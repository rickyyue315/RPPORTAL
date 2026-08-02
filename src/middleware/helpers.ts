import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

export function getClientIp(req: Request): string {
  // When behind Zeabur/load balancer, trust the X-Forwarded-For value.
  const forwarded = req.headers['x-forwarded-for'];
  if (config.trustProxy && typeof forwarded === 'string') {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function maskIp(ip: string | null | undefined): string {
  if (!ip) return '';
  return ip.split('.').slice(0, 3).join('.') + '.xxx';
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
