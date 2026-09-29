import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function isoDate(name: string, fallback: string): string {
  const v = process.env[name] ?? fallback;
  if (!Number.isFinite(Date.parse(v))) {
    throw new Error(`Invalid ISO date environment variable: ${name}`);
  }
  return v;
}

function proxyTrust(): boolean | number {
  const raw = process.env.TRUST_PROXY?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    // A single trusted reverse proxy is the normal production topology. Do
    // not trust forwarded headers by default during local development.
    return process.env.NODE_ENV === 'production' ? 1 : false;
  }
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  if (['true', '1', 'yes', 'on'].includes(raw)) {
    return Math.max(0, int('TRUST_PROXY_HOPS', 1));
  }
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : false;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int('PORT', 3000),
  databaseUrl: process.env.DATABASE_URL ?? required('DATABASE_URL'),
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  sessionTtlHours: int('SESSION_TTL_HOURS', 8),
  loginLockThreshold: int('LOGIN_LOCK_THRESHOLD', 5),
  loginLockMinutes: int('LOGIN_LOCK_MINUTES', 15),
  // Per-username failures need a much higher count than per-IP so public store
  // usernames (Site Codes) cannot be used to remotely lock a specific account.
  loginUsernameLockThreshold: Math.max(1, int('LOGIN_USERNAME_LOCK_THRESHOLD', 50)),
  csrfEnabled: bool('CSRF_ENABLED', true),
  trustProxy: proxyTrust(),
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Hong_Kong',
  publicWriteSuspensionEnabled: bool('PUBLIC_WRITE_SUSPENSION_ENABLED', true),
  publicWriteSuspensionAt: isoDate('PUBLIC_WRITE_SUSPENSION_AT', '2026-08-11T23:59:59+08:00'),
  ipRetentionDays: int('IP_RETENTION_DAYS', 365),
  maxUploadBytes: int('MAX_UPLOAD_MB', 5) * 1024 * 1024,
  maxImportRows: int('MAX_IMPORT_ROWS', 1000),
  exportFileRetentionDays: Math.max(1, int('EXPORT_FILE_RETENTION_DAYS', 90)),
  auditRetentionDays: Math.max(1, int('AUDIT_RETENTION_DAYS', 730)),
  loginAttemptRetentionDays: Math.max(1, int('LOGIN_ATTEMPT_RETENTION_DAYS', 90)),
  importBatchRetentionDays: Math.max(1, int('IMPORT_BATCH_RETENTION_DAYS', 730)),
  exportBatchRetentionDays: Math.max(1, int('EXPORT_BATCH_RETENTION_DAYS', 730)),
  returnSchedulePath: process.env.RETURN_SCHEDULE_PATH ?? path.join(__dirname, '..', 'return-schedule.json'),
  returnEnforcementStart: process.env.RETURN_ENFORCEMENT_START ?? '2026-08-01',
  storesCsvPath: process.env.STORES_CSV_PATH ?? path.join(__dirname, '..', 'stores-template.csv'),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // General NDRF portal (Store/Buyer/SCT accounts) cutover switch. Only affects
  // new Store web submit/import; Admin management, review, export and override
  // remain available regardless of this flag.
  normalNdrfPortalEnabled: bool('NORMAL_NDRF_PORTAL_ENABLED', true),
  // Company rule: Buyer must review an ND within N days; no reply => system
  // auto-approves (default agreement) and flags the row for Admin follow-up.
  ndrfAutoApproveEnabled: bool('NDRF_AUTO_APPROVE_ENABLED', true),
  ndrfAutoApproveDays: Math.max(1, int('NDRF_AUTO_APPROVE_DAYS', 7)),
  // Reject cooldown before the same Site + SKU + RP Type can be re-applied.
  ndrfRejectCooldownHours: Math.max(1, int('NDRF_REJECT_COOLDOWN_HOURS', 30 * 24)),
};
