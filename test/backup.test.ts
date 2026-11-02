import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { listMigrationFiles } from './migrateTest.js';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import {
  backupThresholds,
  backupDownloadFilename,
  healthFor,
  setBackupObjectFetcherForTesting,
} from '../src/services/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;

type Agent = ReturnType<typeof request.agent> & { _csrf?: string };

async function csrf(agent: Agent): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token as string;
}

async function adminAgent(): Promise<Agent> {
  const agent = request.agent(app) as Agent;
  const token = await csrf(agent);
  const res = await agent
    .post('/api/admin/login')
    .set('x-csrf-token', token)
    .send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  agent._csrf = await csrf(agent);
  return agent;
}

/** 直接寫入 backup_runs，模擬 cron service 的兩種結局。 */
async function insertRun(opts: {
  status: 'success' | 'failed' | 'running';
  hoursAgo: number;
  objectKey?: string | null;
  dumpBytes?: number | null;
  durationMs?: number | null;
  error?: string | null;
}) {
  const finished = opts.status === 'running' ? null : `now() - interval '${opts.hoursAgo} hours'`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backup_runs (started_at, finished_at, status, object_key, dump_bytes, duration_ms, error, host)
     VALUES (now() - interval '${opts.hoursAgo} hours' - interval '40 seconds',
             ${finished ?? 'NULL'}, $1, $2, $3, $4, $5, 'cron-test')
     RETURNING id`,
    [opts.status, opts.objectKey ?? null, opts.dumpBytes ?? null, opts.durationMs ?? null, opts.error ?? null],
  );
  return rows[0]!.id;
}

const DUMP_BODY = Buffer.from('PGDMP-fake-dump-for-tests');
const DUMP_KEY = 'db/2026/11/ndrf-20261102T060000Z.dump';

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting({
    query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
    connect: async () => ({
      query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
      release: () => {},
    }),
  } as never);

  const migrationFiles = await listMigrationFiles();
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  app = createApp();
});

afterAll(() => {
  setBackupObjectFetcherForTesting(null);
});

describe('備份健康度門檻', () => {
  it('由排程密度推算：兩次／日 → 14 / 26 小時', () => {
    expect(backupThresholds([2, 14])).toEqual({ late: 14, stale: 26 });
  });

  it('四次／日會收窄容忍度', () => {
    expect(backupThresholds([0, 6, 12, 18])).toEqual({ late: 8, stale: 14 });
  });

  it('沒有紀錄一律當 never，不會當成正常', () => {
    expect(healthFor(null, [2, 14])).toBe('never');
    expect(healthFor(3, [2, 14])).toBe('ok');
    expect(healthFor(14.1, [2, 14])).toBe('late');
    expect(healthFor(26.1, [2, 14])).toBe('stale');
  });

  it('下載檔名只保留安全字元', () => {
    expect(backupDownloadFilename(DUMP_KEY)).toBe('ndrf-20261102T060000Z.dump');
    expect(backupDownloadFilename('db/../evil name;.dump')).toBe('evil_name_.dump');
  });
});

describe('GET /api/admin/backup/status', () => {
  it('未登入不可讀取', async () => {
    const res = await request(app).get('/api/admin/backup/status');
    expect(res.status).toBe(401);
  });

  it('未有任何紀錄時 health = never', async () => {
    await db.query('DELETE FROM backup_runs');
    const agent = await adminAgent();
    const res = await agent.get('/api/admin/backup/status');
    expect(res.status).toBe(200);
    expect(res.body.health).toBe('never');
    expect(res.body.age_hours).toBeNull();
    expect(res.body.last_success).toBeNull();
    expect(res.body.recent).toEqual([]);
    expect(res.body.retention_days).toBe(config.backupRetentionDays);
    expect(res.body.schedule_hours).toEqual(config.backupScheduleHours);
  });

  it('回傳上次成功、上次失敗與最近紀錄', async () => {
    await db.query('DELETE FROM backup_runs');
    await insertRun({ status: 'success', hoursAgo: 3, objectKey: DUMP_KEY, dumpBytes: 987_654, durationMs: 41_000 });
    await insertRun({ status: 'failed', hoursAgo: 30, error: 'failed at upload' });
    await insertRun({ status: 'running', hoursAgo: 1 });

    const agent = await adminAgent();
    const res = await agent.get('/api/admin/backup/status');

    expect(res.body.health).toBe('ok');
    expect(res.body.age_hours).toBeGreaterThan(2.5);
    expect(res.body.age_hours).toBeLessThan(3.5);
    expect(res.body.last_success.object_key).toBe(DUMP_KEY);
    expect(res.body.last_success.dump_bytes).toBe(987_654);
    expect(res.body.last_failure.error).toBe('failed at upload');
    expect(res.body.recent).toHaveLength(3);
  });

  it('未完成的 running 紀錄不會當成有備份', async () => {
    await db.query('DELETE FROM backup_runs');
    await insertRun({ status: 'success', hoursAgo: 40, objectKey: DUMP_KEY, dumpBytes: DUMP_BODY.length });
    await insertRun({ status: 'running', hoursAgo: 1 });

    const agent = await adminAgent();
    const res = await agent.get('/api/admin/backup/status');

    // 最新一筆是 running，但「上次成功」仍然是 40 小時前那份。
    expect(res.body.recent[0].status).toBe('running');
    expect(res.body.health).toBe('stale');
    expect(res.body.age_hours).toBeGreaterThan(39);
  });
});

describe('GET /api/admin/backup/latest', () => {
  const original = { ...config.backupStorage };

  afterAll(() => {
    Object.assign(config.backupStorage, original);
    setBackupObjectFetcherForTesting(null);
  });

  it('未接駁儲存空間時回 503', async () => {
    Object.assign(config.backupStorage, {
      endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '',
    });
    await db.query('DELETE FROM backup_runs');
    await insertRun({ status: 'success', hoursAgo: 2, objectKey: DUMP_KEY, dumpBytes: DUMP_BODY.length });

    const agent = await adminAgent();
    const res = await agent.get('/api/admin/backup/latest');
    expect(res.status).toBe(503);
  });

  it('未有成功紀錄時回 404', async () => {
    Object.assign(config.backupStorage, {
      endpoint: 'https://bucket.example.invalid', bucket: 'ndrf', accessKeyId: 'key', secretAccessKey: 'secret',
    });
    await db.query('DELETE FROM backup_runs');
    await insertRun({ status: 'failed', hoursAgo: 1, error: 'failed at dump' });

    const agent = await adminAgent();
    const res = await agent.get('/api/admin/backup/latest');
    expect(res.status).toBe(404);
  });

  it('串流最新一份 dump 並寫入審計事件', async () => {
    Object.assign(config.backupStorage, {
      endpoint: 'https://bucket.example.invalid', bucket: 'ndrf', accessKeyId: 'key', secretAccessKey: 'secret',
    });
    await db.query('DELETE FROM backup_runs');
    await insertRun({ status: 'success', hoursAgo: 2, objectKey: DUMP_KEY, dumpBytes: DUMP_BODY.length, durationMs: 12_000 });

    let requestedKey = '';
    setBackupObjectFetcherForTesting(async (key) => {
      requestedKey = key;
      return { body: Readable.from([DUMP_BODY]) };
    });

    const agent = await adminAgent();
    const res = await agent.get('/api/admin/backup/latest').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(requestedKey).toBe(DUMP_KEY);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="ndrf-20261102T060000Z.dump"');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).equals(DUMP_BODY)).toBe(true);

    const audit = await db.query<{ cnt: number }>(
      "SELECT count(*)::int AS cnt FROM audit_events WHERE event_type = 'backup_downloaded'",
    );
    expect(audit.rows[0]!.cnt).toBeGreaterThan(0);
  });

  it('物件已被保留期清掉時回 404，而不是 500', async () => {
    Object.assign(config.backupStorage, {
      endpoint: 'https://bucket.example.invalid', bucket: 'ndrf', accessKeyId: 'key', secretAccessKey: 'secret',
    });
    await db.query('DELETE FROM backup_runs');
    await insertRun({ status: 'success', hoursAgo: 2, objectKey: DUMP_KEY, dumpBytes: DUMP_BODY.length });

    setBackupObjectFetcherForTesting(async () => {
      const err = new Error('The specified key does not exist.');
      err.name = 'NoSuchKey';
      throw err;
    });

    const agent = await adminAgent();
    const res = await agent.get('/api/admin/backup/latest');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('保留期');
  });
});
