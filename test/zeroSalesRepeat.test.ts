import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { replaceStores } from '../src/services/stores.js';
import {
  createBatch as createZeroSalesBatch,
  listMyItems as listZeroSalesMyItems,
  listZeroSalesRepeats,
  getZeroSalesSummary,
} from '../src/services/zeroSales.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;
let w41Id = '';
let w42Id = '';

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

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting({
    query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
    connect: async () => ({
      query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
      release: () => {},
    }),
  } as never);
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql', '023_zero_sales_repeat_index.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
  ]);
  app = createApp();

  // W41：HA02 有 A1001（已回覆季節性）+ A1002（單次）
  const w41 = await createZeroSalesBatch({
    weekLabel: '2026-W41-repeat',
    note: 'test',
    rows: [
      { siteCode: 'HA02', sku: 'A1001', data: { Brand: 'B1', 'SKU Desc': '重複SKU' } },
      { siteCode: 'HA02', sku: 'A1002', data: { Brand: 'B1', 'SKU Desc': '單次SKU' } },
    ],
    contentHash: `hash-w41-${Date.now()}`,
    createdBy: 'test',
  });
  w41Id = w41.batchId;
  // W42：HA02 有 A1001（重複）+ A1003（新）
  const w42 = await createZeroSalesBatch({
    weekLabel: '2026-W42-repeat',
    note: 'test',
    rows: [
      { siteCode: 'HA02', sku: 'A1001', data: { Brand: 'B1', 'SKU Desc': '重複SKU' } },
      { siteCode: 'HA02', sku: 'A1003', data: { Brand: 'B1', 'SKU Desc': '新SKU' } },
    ],
    contentHash: `hash-w42-${Date.now()}`,
    createdBy: 'test',
  });
  w42Id = w42.batchId;
  // 保證 W41 早於 W42（避免同毫秒排序不穩）
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w41Id, '2026-09-01T00:00:00Z']);
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w42Id, '2026-09-08T00:00:00Z']);
  // W41 的 A1001 已回覆季節性
  await db.query(
    `UPDATE zero_sales_items SET status = 'replied', reason_code = 'seasonal', reason_label = '4.季節性/非當季產品',
      reason_note = '上週話季節性', replied_at = now(), replied_by = '測試店舖', reply_count = 1
      WHERE batch_id = $1 AND sku = $2`,
    [w41Id, 'A1001'],
  );
});

describe('zero-sales repeat history (store)', () => {
  it('attaches occurrence_count and previous reply to latest-week items', async () => {
    const items = await listZeroSalesMyItems('HA02', { batchId: w42Id });
    expect(items).toHaveLength(2);
    const repeat = items.find((i) => i.sku === 'A1001')!;
    expect(repeat.occurrence_count).toBe(2);
    expect(repeat.is_repeat).toBe(true);
    expect(repeat.prev_week_label).toBe('2026-W41-repeat');
    expect(repeat.prev_status).toBe('replied');
    expect(repeat.prev_reason_label).toBe('4.季節性/非當季產品');
    expect(repeat.prev_reason_note).toBe('上週話季節性');
    const fresh = items.find((i) => i.sku === 'A1003')!;
    expect(fresh.occurrence_count).toBe(1);
    expect(fresh.is_repeat).toBe(false);
    expect(fresh.prev_week_label).toBeNull();
  });

  it('resolves history relative to the viewed batch (older batch has no previous)', async () => {
    const items = await listZeroSalesMyItems('HA02', { batchId: w41Id });
    const first = items.find((i) => i.sku === 'A1001')!;
    // 睇緊 W41 時，W42 尚未發生，上一次應為空
    expect(first.occurrence_count).toBe(2);
    expect(first.prev_week_label).toBeNull();
  });
});

describe('zero-sales repeats (admin)', () => {
  it('groups same site+sku across batches', async () => {
    const rows = await listZeroSalesRepeats({ minCount: 2 });
    const hit = rows.find((r) => r.site_code === 'HA02' && r.sku === 'A1001');
    expect(hit).toBeDefined();
    expect(hit!.occurrence_count).toBe(2);
    expect(hit!.weeks).toEqual(['2026-W42-repeat', '2026-W41-repeat']);
    expect(hit!.replied_count).toBe(1);
    expect(hit!.pending_count).toBe(1);
    expect(hit!.brand).toBe('B1');
  });

  it('supports minCount / site / keyword filters', async () => {
    expect(await listZeroSalesRepeats({ minCount: 3 })).toHaveLength(0);
    expect(await listZeroSalesRepeats({ siteCode: 'ZZ99', minCount: 2 })).toHaveLength(0);
    const byQ = await listZeroSalesRepeats({ q: 'A1001', minCount: 2 });
    expect(byQ.some((r) => r.sku === 'A1001')).toBe(true);
    const missQ = await listZeroSalesRepeats({ q: 'NOPE-NOPE', minCount: 2 });
    expect(missQ).toHaveLength(0);
  });

  it('exposes repeats via the admin API with validation', async () => {
    const agent = await adminAgent();
    const ok = await agent.get('/api/admin/zero-sales/repeats?min_count=2&limit=200');
    expect(ok.status).toBe(200);
    expect(ok.body.repeats.some((r: { sku: string }) => r.sku === 'A1001')).toBe(true);

    const badMin = await agent.get('/api/admin/zero-sales/repeats?min_count=1');
    expect(badMin.status).toBe(400);
    const badLimit = await agent.get('/api/admin/zero-sales/repeats?limit=0');
    expect(badLimit.status).toBe(400);

    const anon = request.agent(app);
    const denied = await anon.get('/api/admin/zero-sales/repeats');
    expect(denied.status).toBe(401);
  });

  it('includes repeat counts in the summary', async () => {
    const s = await getZeroSalesSummary();
    expect(s.repeat_groups).toBeGreaterThanOrEqual(1);
    expect(s.repeat_rows).toBeGreaterThanOrEqual(2);
  });
});
