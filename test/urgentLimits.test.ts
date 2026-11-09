import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles } from './migrateTest.js';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { createUrgentBatch } from '../src/services/submissions.js';
import { hkTodayForDateColumn, shiftDateOnly } from '../src/lib/time.js';

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

async function publicLimits() {
  const res = await request(app).get('/api/public/urgent/limits');
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toContain('no-store');
  return res.body as {
    phase: string;
    multiplier: number;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    note: string;
    qtyMax: number;
    peakQtyMax: number;
    limits: Array<{ label: string; limit: number }>;
  };
}

async function saveLimits(
  admin: Agent,
  payload: { multiplier: number; effectiveFrom: string | null; effectiveTo: string | null; note?: string },
) {
  return admin
    .put('/api/admin/urgent-limits')
    .set('x-csrf-token', admin._csrf!)
    .send({ note: '', ...payload });
}

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

describe('Urgent Order 旺季限額', () => {
  it('serves the base limits before any peak setting is saved', async () => {
    const limits = await publicLimits();
    expect(limits.phase).toBe('none');
    expect(limits.multiplier).toBe(1);
    expect(limits.qtyMax).toBe(1000);
    expect(limits.peakQtyMax).toBe(492);
    expect(limits.limits).toEqual([
      { label: '> 10,000', limit: 492 },
      { label: '> 5,000', limit: 192 },
      { label: '> 1,000', limit: 96 },
      { label: '> 500', limit: 24 },
      { label: '≤ 500', limit: 12 },
    ]);
  });

  it('requires an admin session to read or change the setting', async () => {
    expect((await request(app).get('/api/admin/urgent-limits')).status).toBe(401);
    const res = await request(app)
      .put('/api/admin/urgent-limits')
      .send({ multiplier: 2, effectiveFrom: null, effectiveTo: null });
    // 未登入時 CSRF 中介層可能先回 403；兩者都代表不可寫入。
    expect([401, 403]).toContain(res.status);
  });

  it('applies the multiplier only while the date range is active, with the end date inclusive', async () => {
    const admin = await adminAgent();
    const today = hkTodayForDateColumn();
    const saved = await saveLimits(admin, {
      multiplier: 2,
      effectiveFrom: today,
      effectiveTo: today,
      note: '測試旺季',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.phase).toBe('active');

    const limits = await publicLimits();
    expect(limits.phase).toBe('active');
    expect(limits.multiplier).toBe(2);
    expect(limits.note).toBe('測試旺季');
    // ×2 的最高一級為 984，低於基本 1000，所以每筆上限維持 1000。
    expect(limits.qtyMax).toBe(1000);
    expect(limits.peakQtyMax).toBe(984);
    expect(limits.limits.map((row) => row.limit)).toEqual([984, 384, 192, 48, 24]);

    const adminView = await admin.get('/api/admin/urgent-limits');
    expect(adminView.status).toBe(200);
    expect(adminView.body.tiers[0]).toMatchObject({ label: '> 10,000', baseLimit: 492, peakLimit: 984 });
    expect(adminView.body.updatedBy).toBe('admin');
  });

  it('raises the per-order QTY max with a 3x peak instead of capping at 1000', async () => {
    const admin = await adminAgent();
    const today = hkTodayForDateColumn();
    const saved = await saveLimits(admin, {
      multiplier: 3,
      effectiveFrom: shiftDateOnly(today, -1),
      effectiveTo: shiftDateOnly(today, 1),
    });
    expect(saved.status).toBe(200);

    const limits = await publicLimits();
    expect(limits.phase).toBe('active');
    expect(limits.limits[0]).toEqual({ label: '> 10,000', limit: 1476 });
    expect(limits.limits.map((row) => row.limit)).toEqual([1476, 576, 288, 72, 36]);
    expect(limits.qtyMax).toBe(1476);
    expect(limits.peakQtyMax).toBe(1476);

    const adminView = await admin.get('/api/admin/urgent-limits');
    expect(adminView.body.qtyMax).toBe(1476);
    expect(adminView.body.peakQtyMax).toBe(1476);
  });

  it('falls back to base limits before and after the active period', async () => {
    const admin = await adminAgent();
    const today = hkTodayForDateColumn();

    const future = await saveLimits(admin, {
      multiplier: 2,
      effectiveFrom: shiftDateOnly(today, 1),
      effectiveTo: shiftDateOnly(today, 10),
    });
    expect(future.status).toBe(200);
    expect(future.body.phase).toBe('scheduled');
    expect((await publicLimits()).qtyMax).toBe(1000);
    expect((await publicLimits()).limits.map((row) => row.limit)).toEqual([492, 192, 96, 24, 12]);

    const past = await saveLimits(admin, {
      multiplier: 2,
      effectiveFrom: shiftDateOnly(today, -10),
      effectiveTo: shiftDateOnly(today, -1),
    });
    expect(past.status).toBe(200);
    expect(past.body.phase).toBe('ended');
    expect((await publicLimits()).qtyMax).toBe(1000);
    expect((await publicLimits()).limits.map((row) => row.limit)).toEqual([492, 192, 96, 24, 12]);
  });

  it('rejects incomplete, reversed or out-of-range settings', async () => {
    const admin = await adminAgent();
    const today = hkTodayForDateColumn();

    expect((await saveLimits(admin, { multiplier: 2, effectiveFrom: null, effectiveTo: null })).status).toBe(400);
    expect((await saveLimits(admin, { multiplier: 2, effectiveFrom: today, effectiveTo: null })).status).toBe(400);
    expect(
      (await saveLimits(admin, {
        multiplier: 2,
        effectiveFrom: shiftDateOnly(today, 5),
        effectiveTo: shiftDateOnly(today, 1),
      })).status,
    ).toBe(400);
    expect(
      (await saveLimits(admin, {
        multiplier: 0.5,
        effectiveFrom: today,
        effectiveTo: today,
      })).status,
    ).toBe(400);
    expect(
      (await saveLimits(admin, {
        multiplier: 1,
        effectiveFrom: today,
        effectiveTo: today,
      })).status,
    ).toBe(400);
  });

  it('accepts a QTY above 1000 only when the caller passes the peak max', async () => {
    const base = createUrgentBatch({
      siteCode: 'HA02',
      items: [{ sku: '7654321', qty: 1200, urgentReason: '1', urgentReasonOther: '' }],
      ip: '',
      changeSource: 'test',
    });
    await expect(base).rejects.toThrow(/1000/);

    const peak = await createUrgentBatch({
      siteCode: 'HA02',
      items: [{ sku: '7654321', qty: 1200, urgentReason: '1', urgentReasonOther: '' }],
      maxQty: 1476,
      ip: '',
      changeSource: 'test',
    });
    expect(peak.rows[0]?.row.qty).toBe(1200);
  });

  it('clears the peak setting and records an audit event', async () => {
    const admin = await adminAgent();
    const today = hkTodayForDateColumn();
    await saveLimits(admin, {
      multiplier: 2,
      effectiveFrom: today,
      effectiveTo: today,
    });

    const cleared = await saveLimits(admin, {
      multiplier: 1,
      effectiveFrom: null,
      effectiveTo: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.phase).toBe('none');
    expect((await publicLimits()).limits.map((row) => row.limit)).toEqual([492, 192, 96, 24, 12]);

    const audit = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_events WHERE event_type = 'urgent_limits_updated'",
    );
    expect(Number(audit.rows[0]?.count)).toBeGreaterThan(0);
  });
});
