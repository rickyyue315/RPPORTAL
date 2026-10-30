import type { NextFunction, Request, Response } from 'express';

/**
 * OM（區域主管）專用：
 *   * 只接受 role = 'om' 的 Portal session。
 *   * 可管理的店舖一律以 username 對應最新上載存貨報表的 OM
 *     （無報表時 fallback stores.om，不分大小寫），不接受前端傳入的
 *     「我是哪個 OM」。
 */
export function requireOm(req: Request, res: Response, next: NextFunction): void {
  const user = req.portalUser;
  if (!user) {
    res.status(401).json({ error: '未登入' });
    return;
  }
  if (user.role !== 'om') {
    res.status(403).json({ error: '此頁只限 OM 主管登入' });
    return;
  }
  req.omUsername = user.username;
  req.omDisplayName = user.display_name || user.username;
  next();
}

declare global {
  namespace Express {
    interface Request {
      /** 已驗證的 OM username（= stores.om 的大寫） */
      omUsername?: string;
      /** OM 顯示名稱（來自 portal_users.display_name） */
      omDisplayName?: string;
    }
  }
}
