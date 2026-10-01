import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { validatePortalSession, type PortalUserRow } from '../services/portalAuth.js';

export const PORTAL_SESSION_COOKIE = 'portal_session';

declare global {
  namespace Express {
    interface Request {
      portalUser?: PortalUserRow;
    }
  }
}

export async function requirePortalUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[PORTAL_SESSION_COOKIE];
    if (!token) {
      res.status(401).json({ error: '未登入' });
      return;
    }
    const user = await validatePortalSession(token);
    if (!user) {
      res.clearCookie(PORTAL_SESSION_COOKIE);
      res.status(401).json({ error: '登入已過期' });
      return;
    }
    req.portalUser = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Portal logins use the shared password, so there is no per-account forced password-change gate. Kept in the auth chain as a pass-through. */
export function requirePasswordChanged(req: Request, res: Response, next: NextFunction): void {
  if (!req.portalUser) {
    res.status(401).json({ error: '未登入' });
    return;
  }
  next();
}

export function requirePortalRole(roles: ReadonlyArray<PortalUserRow['role']>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.portalUser;
    if (!user) {
      res.status(401).json({ error: '未登入' });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: '沒有權限執行此操作' });
      return;
    }
    next();
  };
}

/** Store accounts are bound to a fixed Site Code; enforce it server-side. */
export function requireStoreSite(req: Request, res: Response, next: NextFunction): void {
  const user = req.portalUser;
  if (!user || user.role !== 'store' || !user.site_code) {
    res.status(403).json({ error: '此操作只限已登入的店舖帳戶' });
    return;
  }
  // Store accounts are passwordless: no forced-change gate.
  req.storeSiteCode = user.site_code;
  next();
}

declare global {
  namespace Express {
    interface Request {
      storeSiteCode?: string;
    }
  }
}

/** Blocks Store web submit / import when the normal NDRF portal is disabled. */
export function requireNormalPortalOpen(_req: Request, res: Response, next: NextFunction): void {
  if (config.normalNdrfPortalEnabled) {
    next();
    return;
  }
  res.status(503).json({
    error: '一般 NDRF 網上申報尚未啟用，請聯絡 RP Team',
    code: 'NORMAL_NDRF_PORTAL_DISABLED',
  });
}
