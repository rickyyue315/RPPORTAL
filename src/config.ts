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
  csrfEnabled: bool('CSRF_ENABLED', true),
  trustProxy: proxyTrust(),
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Hong_Kong',
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
  publicRecoveryCode: process.env.PUBLIC_RECOVERY_CODE ?? '',
  storesCsvPath: process.env.STORES_CSV_PATH ?? path.join(__dirname, '..', 'stores-template.csv'),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};
