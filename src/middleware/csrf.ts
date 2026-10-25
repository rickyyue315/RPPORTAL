import type { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

export const CSRF_COOKIE = 'csrf_token';

/**
 * Whether a request without a CSRF cookie should be given one.
 *
 * This middleware runs for every request, including static assets. On a cold
 * browser the HTML document and a dozen JS/CSS files are requested in
 * parallel, each arriving before the cookie is stored — so each one used to
 * mint its own token, and the browser keeps only the last `Set-Cookie` that
 * lands. If that is not the one the page's JS read from `/api/csrf`, every
 * write fails with `CSRF token 無效` until the page is reloaded.
 *
 * Minting is therefore limited to requests that establish the page itself
 * (documents) or ask for the token explicitly. Every other request waits for
 * that single cookie, which makes the value deterministic.
 */
function shouldMintToken(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (req.path === '/api/csrf') return true;
  return req.path.endsWith('.html') || req.path.endsWith('/');
}

/** Ensures a CSRF token cookie exists for the response. */
export function csrfTokenCookie(req: Request, res: Response, next: NextFunction): void {
  const existing = req.cookies?.[CSRF_COOKIE];
  if (existing) {
    req.csrfToken = existing;
    next();
    return;
  }
  if (!shouldMintToken(req)) {
    next();
    return;
  }
  const token = randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: config.env === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 3600 * 1000,
  });
  req.csrfToken = token;
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
  requireCsrf(req, res, next);
}

/**
 * Enforces the double-submit token on any request, including GET endpoints
 * that release sensitive content (used by the export download route).
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!config.csrfEnabled) {
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
