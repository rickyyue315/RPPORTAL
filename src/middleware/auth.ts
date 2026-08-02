import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

declare global {
  namespace Express {
    interface Request {
      adminUsername?: string;
      adminToken?: string;
    }
  }
}

/**
 * Password login has been removed. Admin routes are open; identity is fixed
 * for audit purposes.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  req.adminUsername = config.adminUsername;
  next();
}
