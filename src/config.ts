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

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int('PORT', 3000),
  databaseUrl: process.env.DATABASE_URL ?? required('DATABASE_URL'),
  adminUsername: required('ADMIN_USERNAME'),
  adminPasswordHash: required('ADMIN_PASSWORD_HASH'),
  sessionSecret: required('SESSION_SECRET'),
  sessionTtlHours: int('SESSION_TTL_HOURS', 8),
  csrfEnabled: bool('CSRF_ENABLED', true),
  trustProxy: bool('TRUST_PROXY', true),
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Hong_Kong',
  ipRetentionDays: int('IP_RETENTION_DAYS', 365),
  maxUploadBytes: int('MAX_UPLOAD_MB', 5) * 1024 * 1024,
  maxImportRows: int('MAX_IMPORT_ROWS', 1000),
  loginLockThreshold: int('LOGIN_LOCK_THRESHOLD', 5),
  loginLockMinutes: int('LOGIN_LOCK_MINUTES', 15),
  storesCsvPath: process.env.STORES_CSV_PATH ?? path.join(__dirname, '..', 'stores-template.csv'),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  logBody: bool('LOG_BODY', false),
};
