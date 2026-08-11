import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

export const PUBLIC_WRITE_SUSPENDED_CODE = 'PUBLIC_WRITES_SUSPENDED';
export const PUBLIC_WRITE_SUSPENDED_MESSAGE = '此平台已暫停提交、修改及 Excel 批量上載服務，謝謝。';

export type PublicWriteSuspensionSettings = Readonly<{
  enabled: boolean;
  suspendAt: string;
}>;

export const publicWriteSuspensionSettings: PublicWriteSuspensionSettings = {
  enabled: config.publicWriteSuspensionEnabled,
  suspendAt: config.publicWriteSuspensionAt,
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

/** Blocks public writes independently of Urgent Order's daily 14:30 window. */
export function requirePublicWritesOpen(_req: Request, res: Response, next: NextFunction): void {
  if (!isPublicWriteSuspended()) {
    next();
    return;
  }

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
