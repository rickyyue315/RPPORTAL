import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

export const PUBLIC_WRITE_SUSPENDED_CODE = 'PUBLIC_WRITES_SUSPENDED';
export const PUBLIC_WRITE_SUSPENDED_MESSAGE = '此平台已暫停提交、修改及 Excel 一次過上載服務，謝謝。';

/**
 * `return` covers 行貨退貨（網頁提交／Excel 匯入／申請期內修改）。它有自己的
 * 申請期時間表，所以重開後不再受平台暫停攔截；其餘服務一律用 `default`。
 */
export type PublicWriteScope = 'default' | 'return';

export type PublicWriteSuspensionSettings = Readonly<{
  enabled: boolean;
  suspendAt: string;
  /** 行貨退貨已重開：只跟隨退行貨申請期，平台暫停對它無效。 */
  returnReopened: boolean;
}>;

export const publicWriteSuspensionSettings: PublicWriteSuspensionSettings = {
  enabled: config.publicWriteSuspensionEnabled,
  suspendAt: config.publicWriteSuspensionAt,
  returnReopened: config.publicReturnWritesReopened,
};

export function isPublicWriteSuspended(
  now: Date = new Date(),
  settings: PublicWriteSuspensionSettings = publicWriteSuspensionSettings,
): boolean {
  if (!settings.enabled) return false;
  const cutoff = Date.parse(settings.suspendAt);
  if (!Number.isFinite(cutoff)) {
    throw new Error('Invalid public write suspension time');
  }
  return now.getTime() >= cutoff;
}

/** 行貨退貨重開後，退貨相關寫入只看申請期，不看平台暫停。 */
export function isPublicWriteSuspendedFor(
  scope: PublicWriteScope,
  now: Date = new Date(),
  settings: PublicWriteSuspensionSettings = publicWriteSuspensionSettings,
): boolean {
  if (scope === 'return' && settings.returnReopened) return false;
  return isPublicWriteSuspended(now, settings);
}

export function sendPublicWriteSuspended(res: Response): void {
  res
    .set('Cache-Control', 'no-store, private')
    .set('X-Public-Write-Suspended', '1')
    .status(503)
    .json({
      error: PUBLIC_WRITE_SUSPENDED_MESSAGE,
      code: PUBLIC_WRITE_SUSPENDED_CODE,
      suspended_at: publicWriteSuspensionSettings.suspendAt,
    });
}

function guardPublicWrites(scope: PublicWriteScope) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!isPublicWriteSuspendedFor(scope)) {
      next();
      return;
    }
    sendPublicWriteSuspended(res);
  };
}

/** Blocks public writes independently of Urgent Order's daily 14:30 window. */
export const requirePublicWritesOpen = guardPublicWrites('default');

/** 行貨退貨：平台暫停時仍可提交／匯入，實際開放期由退行貨時間表控制。 */
export const requireReturnWritesOpen = guardPublicWrites('return');
