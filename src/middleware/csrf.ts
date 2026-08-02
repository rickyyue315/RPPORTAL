import type { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

const CSRF_COOKIE = 'csrf_token';

/** Ensures a CSRF token cookie exists for the response. */
export function csrfTokenCookie(req: Request, res: Response, next: NextFunction): void {
  if (!req.cookies?.[CSRF_COOKIE]) {
    const token = randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: config.env === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 3600 * 1000,
    });
    req.csrfToken = token;
  } else {
    req.csrfToken = req.cookies[CSRF_COOKIE];
  }
  next();
}

declare global {
  namespace Express {
    interface Request {
      csrfToken?: string;
    }
  }
}

/** Double-submit CSRF check for state-changing requests. */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (!config.csrfEnabled) {
    next();
    return;
  }
  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    next();
    return;
  }
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    res.status(403).json({ error: 'CSRF token 無效' });
    return;
  }
  next();
}
