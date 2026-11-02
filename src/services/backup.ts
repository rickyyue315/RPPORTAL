import { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { query } from '../db/pool.js';

/** backup_runs 的原始資料列；BIGINT 由 pg 以字串回傳。 */
interface BackupRunRow {
  id: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  status: 'running' | 'success' | 'failed';
  object_key: string | null;
  dump_bytes: string | number | null;
  duration_ms: number | null;
  error: string | null;
  host: string;
}

export interface BackupRunView {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'failed';
  object_key: string | null;
  dump_bytes: number | null;
  duration_ms: number | null;
  error: string | null;
  host: string;
}

/**
 * ok    = 在預期間隔內（兩次／日 → 14 小時）
 * late  = 錯過一次，但仍可能只是排程延遲
 * stale = 連續錯過，需要人手檢查 cron service
 */
export type BackupHealth = 'ok' | 'late' | 'stale' | 'never';

export interface BackupStatusPayload {
  configured: boolean;
  schedule_hours: number[];
  retention_days: number;
  health: BackupHealth;
  age_hours: number | null;
  /** 超過此小時數即顯示黃色（由排程密度推算，不是硬編碼） */
  late_after_hours: number;
  stale_after_hours: number;
  last_success: BackupRunView | null;
  last_failure: BackupRunView | null;
  recent: BackupRunView[];
}

const DEFAULT_SCHEDULE_HOURS = [2, 14];

function toIsoString(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toView(row: BackupRunRow): BackupRunView {
  return {
    id: row.id,
    started_at: toIsoString(row.started_at) ?? '',
    finished_at: toIsoString(row.finished_at),
    status: row.status,
    object_key: row.object_key,
    dump_bytes: toNumberOrNull(row.dump_bytes),
    duration_ms: toNumberOrNull(row.duration_ms),
    error: row.error,
    host: row.host ?? '',
  };
}

function scheduleHours(): number[] {
  return config.backupScheduleHours.length ? config.backupScheduleHours : DEFAULT_SCHEDULE_HOURS;
}

/**
 * 由排程密度推算容忍度：兩次／日 = 每 12 小時一次，所以 14 小時仍是正常，
 * 26 小時（等於連續錯過兩次）才算 stale。
 */
export function backupThresholds(hours: number[]): { late: number; stale: number } {
  const perDay = hours.length || DEFAULT_SCHEDULE_HOURS.length;
  const gap = 24 / perDay;
  return { late: gap + 2, stale: gap * 2 + 2 };
}

export function healthFor(ageHours: number | null, hours: number[]): BackupHealth {
  if (ageHours === null) return 'never';
  const { late, stale } = backupThresholds(hours);
  if (ageHours > stale) return 'stale';
  if (ageHours > late) return 'late';
  return 'ok';
}

export async function getBackupStatus(now: Date = new Date()): Promise<BackupStatusPayload> {
  const hours = scheduleHours();
  const { rows } = await query<BackupRunRow>(
    `SELECT id, started_at, finished_at, status, object_key, dump_bytes, duration_ms, error, host
       FROM backup_runs
      ORDER BY started_at DESC
      LIMIT 10`,
  );
  const recent = rows.map(toView);

  // 只認 status='success'：cron 被中斷時會留下永遠停喺 running 的紀錄，
  // 用「最新一筆」判斷會誤報成「有備份」。
  const lastSuccess = recent.find((row) => row.status === 'success') ?? null;
  const lastFailure = recent.find((row) => row.status === 'failed') ?? null;

  const ageHours = lastSuccess?.finished_at
    ? (now.getTime() - new Date(lastSuccess.finished_at).getTime()) / 3_600_000
    : null;

  return {
    configured: isBackupStorageConfigured(),
    schedule_hours: hours,
    retention_days: config.backupRetentionDays,
    health: healthFor(ageHours, hours),
    age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    late_after_hours: backupThresholds(hours).late,
    stale_after_hours: backupThresholds(hours).stale,
    last_success: lastSuccess,
    last_failure: lastFailure,
    recent,
  };
}

export async function getLatestSuccessfulBackup(): Promise<BackupRunView | null> {
  const { rows } = await query<BackupRunRow>(
    `SELECT id, started_at, finished_at, status, object_key, dump_bytes, duration_ms, error, host
       FROM backup_runs
      WHERE status = 'success' AND object_key IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1`,
  );
  return rows[0] ? toView(rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* Storage Bucket（S3 相容）讀取                                       */
/* ------------------------------------------------------------------ */

export function isBackupStorageConfigured(): boolean {
  const s = config.backupStorage;
  return Boolean(s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey);
}

export interface BackupObject {
  body: Readable;
  contentLength?: number;
}

type BackupObjectFetcher = (key: string) => Promise<BackupObject>;

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    const s = config.backupStorage;
    client = new S3Client({
      endpoint: s.endpoint,
      region: s.region,
      forcePathStyle: s.forcePathStyle,
      credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    });
  }
  return client;
}

async function fetchFromBucket(key: string): Promise<BackupObject> {
  const out = await getClient().send(
    new GetObjectCommand({ Bucket: config.backupStorage.bucket, Key: key }),
  );
  if (!out.Body) throw new Error('備份物件沒有內容');
  return { body: out.Body as Readable, contentLength: out.ContentLength };
}

let fetchObject: BackupObjectFetcher = fetchFromBucket;

/** 測試用：換入假的物件讀取器，避免測試依賴真實 bucket。 */
export function setBackupObjectFetcherForTesting(fn: BackupObjectFetcher | null): void {
  fetchObject = fn ?? fetchFromBucket;
}

export async function openBackupObject(key: string): Promise<BackupObject> {
  return fetchObject(key);
}

/** 物件金鑰只由備份腳本產生，但仍然過濾一次才寫入 Content-Disposition。 */
export function backupDownloadFilename(key: string): string {
  const base = key.split('/').pop() ?? '';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe || 'ndrf-backup.dump';
}
