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

function envBool(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function bool(name: string, fallback = false): boolean {
  return envBool(process.env, name, fallback);
}

/**
 * Values that used to be shipped as defaults, plus obvious placeholders.
 * They are rejected in production so a missing Railway variable can never
 * silently fall back to a publicly known password.
 */
const KNOWN_WEAK_PORTAL_SECRETS = new Set([
  'SASA1234',
  'SASAOM178',
  'change-me',
  'change-me-to-a-long-password',
  'local-dev-password-change-me',
  'test-password',
  'password',
  'admin',
]);

/** True when a Portal secret is missing, too short, or a known default. */
export function isWeakPortalSecret(value: string): boolean {
  const normalized = value.trim();
  return !normalized || normalized.length < 16 || KNOWN_WEAK_PORTAL_SECRETS.has(normalized);
}

function requireStrongPortalSecret(name: string, value: string): void {
  if (isWeakPortalSecret(value)) {
    throw new Error(
      `${name} 必須設定為至少 16 個字元的唯一密碼；空白、預設值及常見密碼一律拒絕`,
    );
  }
}

/**
 * Production guard: fail closed instead of silently using a default password.
 *
 * Store / OM shared login is opt-in (default false). If an operator re-enables
 * it, the corresponding shared secret must be explicitly configured and strong.
 * A weak leftover value is ignored at runtime even when shared login is off.
 */
export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.NODE_ENV ?? 'development') !== 'production') return;

  const storeSharedEnabled = envBool(env, 'PORTAL_STORE_SHARED_PASSWORD_ENABLED', false);
  const omSharedEnabled = envBool(env, 'PORTAL_OM_SHARED_PASSWORD_ENABLED', false);
  const shared = (env.PORTAL_SHARED_PASSWORD ?? '').trim();
  const om = (env.PORTAL_OM_PASSWORD ?? '').trim();

  if (storeSharedEnabled) {
    requireStrongPortalSecret('PORTAL_SHARED_PASSWORD', shared);
  } else if (shared && isWeakPortalSecret(shared)) {
    console.warn(
      '[security] PORTAL_SHARED_PASSWORD 仍是預設／弱密碼；Store 共用登入已停用，Buyer/SCT 亦不會接受此值。請移除或改為強密碼。',
    );
  }

  if (omSharedEnabled) {
    requireStrongPortalSecret('PORTAL_OM_PASSWORD', om);
  } else if (om && isWeakPortalSecret(om)) {
    console.warn(
      '[security] PORTAL_OM_PASSWORD 仍是預設／弱密碼；OM 共用登入已停用，此值不會被接受。請移除或改為強密碼。',
    );
  }
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
  // Railway can start the container before PostgreSQL is accepting
  // connections (especially on a first deploy). Wait before migrating.
  databaseStartupRetries: Math.max(1, int('DB_STARTUP_RETRIES', 20)),
  databaseStartupRetryMs: Math.max(100, int('DB_STARTUP_RETRY_MS', 2000)),
  // Keep this below Railway's draining window so the process can close the
  // HTTP server and database pool cleanly before SIGKILL.
  shutdownTimeoutMs: Math.max(1000, int('SHUTDOWN_TIMEOUT_MS', 25_000)),
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  // 沒有硬編碼預設值。production 由 assertProductionSecrets() 把關。
  // Buyer／SCT 仍使用此共用密碼；Store／OM 只在對應 shared 開關為 true
  // 且尚未發放個人密碼時才會用到。
  portalSharedPassword: (process.env.PORTAL_SHARED_PASSWORD ?? '').trim(),
  // OM（營運經理）專用密碼；只在 PORTAL_OM_SHARED_PASSWORD_ENABLED=true
  // 且該 OM 尚未發放個人密碼時使用。沒有硬編碼預設值。
  portalOmPassword: (process.env.PORTAL_OM_PASSWORD ?? '').trim(),
  // 逐帳戶密碼的相容開關。false（預設）= 未發放個人密碼的 Store／OM 一律
  // 不可登入，杜絕任何共用密碼 fallback。true 只應在過渡期短暫開啟。
  // Buyer／SCT 不受這兩個開關影響。
  portalStoreSharedPasswordEnabled: bool('PORTAL_STORE_SHARED_PASSWORD_ENABLED', false),
  portalOmSharedPasswordEnabled: bool('PORTAL_OM_SHARED_PASSWORD_ENABLED', false),
  // 登入防爆破：以「最後一次成功登入之後」的失敗次數計算。
  portalLoginFailWindowMinutes: Math.max(1, int('PORTAL_LOGIN_FAIL_WINDOW_MINUTES', 30)),
  portalLoginFailPerUserIp: Math.max(1, int('PORTAL_LOGIN_FAIL_PER_USER_IP', 10)),
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
  // 每日備份：Railway cron service 用 pg_dump 寫入 Storage Bucket。應用程式只需
  // 讀取權限（後台「下載最新備份」），上傳由 cron container 負責，所以這裡沒有
  // 任何寫入路徑。BACKUP_S3_* 留空 = 未啟用，後台會顯示「未設定」而不是報錯。
  backupScheduleHours: (process.env.BACKUP_SCHEDULE_HOURS ?? '2,14')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23)
    .sort((a, b) => a - b),
  backupRetentionDays: Math.max(1, int('BACKUP_RETENTION_DAYS', 7)),
  backupStorage: {
    endpoint: (process.env.BACKUP_S3_ENDPOINT ?? '').trim(),
    region: (process.env.BACKUP_S3_REGION ?? 'auto').trim() || 'auto',
    bucket: (process.env.BACKUP_S3_BUCKET ?? '').trim(),
    accessKeyId: (process.env.BACKUP_S3_ACCESS_KEY_ID ?? '').trim(),
    secretAccessKey: (process.env.BACKUP_S3_SECRET_ACCESS_KEY ?? '').trim(),
    // Railway 新 bucket 用 virtual-hosted style；較舊的 bucket 才需要 path-style。
    forcePathStyle: bool('BACKUP_S3_FORCE_PATH_STYLE', false),
  },
  returnSchedulePath: process.env.RETURN_SCHEDULE_PATH ?? path.join(__dirname, '..', 'return-schedule.json'),
  returnEnforcementStart: process.env.RETURN_ENFORCEMENT_START ?? '2026-08-01',
  storesCsvPath: process.env.STORES_CSV_PATH ?? path.join(__dirname, '..', 'stores-template.csv'),
  // 每次啟動都把內建 stores-template.csv upsert 入資料庫（不刪除任何店舖）。
  // 關掉之後，主檔只會經後台上載／「重新同步內建主檔」更新。
  storesMasterSyncOnBoot: bool('STORES_MASTER_SYNC_ON_BOOT', true),
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

// Run once at import time. In production this refuses to start with a
// missing/default shared secret when the corresponding shared login is on.
assertProductionSecrets();
