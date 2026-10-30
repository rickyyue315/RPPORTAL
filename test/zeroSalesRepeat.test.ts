import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import ExcelJS from 'exceljs';
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
  listZeroSalesRepeatSkus,
  getZeroSalesSummary,
} from '../src/services/zeroSales.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;
let w41Id = '';
let w42Id = '';
let w43Id = '';

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

/** supertest 預設不會解析未知二進制 content-type，需自帶 parser 收集原始位元組 */
function getXlsx(agent: Agent, url: string) {
  return agent.get(url).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql', '023_zero_sales_repeat_index.sql', '024_zero_sales_archive.sql', '025_zero_sales_auto_reply.sql', '026_shop_stock_snapshots.sql', '027_designated_sku_tasks.sql', '028_designated_sku_admin_edit.sql', '029_designated_sku_matters.sql', '030_designated_sku_due_at.sql', '031_zero_sales_no_reply.sql', '032_om_portal.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
    { site_code: 'ZB01', shop: '測試二店', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
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
  // W43：HA02 有 A1001（第三次上榜）
  const w43 = await createZeroSalesBatch({
    weekLabel: '2026-W43-repeat',
    note: 'test',
    rows: [{ siteCode: 'HA02', sku: 'A1001', data: { Brand: 'B1', 'SKU Desc': '重複SKU' } }],
    contentHash: `hash-w43-${Date.now()}`,
    createdBy: 'test',
  });
  w43Id = w43.batchId;
  // 保證 W41 早於 W42 早於 W43（避免同毫秒排序不穩）
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w41Id, '2026-09-01T00:00:00Z']);
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w42Id, '2026-09-08T00:00:00Z']);
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w43Id, '2026-09-15T00:00:00Z']);
  // W50 / W51：跨店重複 — X9001 在 HA02 + ZB01 兩間店都連續兩週上榜；X9002 只在 HA02 重複
  const w50 = await createZeroSalesBatch({
    weekLabel: '2026-W50-cross',
    note: 'test-cross',
    rows: [
      { siteCode: 'HA02', sku: 'X9001', data: { Brand: 'B2', 'SKU Desc': '跨店重複SKU' } },
      { siteCode: 'ZB01', sku: 'X9001', data: { Brand: 'B2', 'SKU Desc': '跨店重複SKU' } },
      { siteCode: 'HA02', sku: 'X9002', data: { Brand: 'B2', 'SKU Desc': '單店重複SKU' } },
    ],
    contentHash: `hash-w50-${Date.now()}`,
    createdBy: 'test',
  });
  const w51 = await createZeroSalesBatch({
    weekLabel: '2026-W51-cross',
    note: 'test-cross',
    rows: [
      { siteCode: 'HA02', sku: 'X9001', data: { Brand: 'B2', 'SKU Desc': '跨店重複SKU' } },
      { siteCode: 'ZB01', sku: 'X9001', data: { Brand: 'B2', 'SKU Desc': '跨店重複SKU' } },
      { siteCode: 'HA02', sku: 'X9002', data: { Brand: 'B2', 'SKU Desc': '單店重複SKU' } },
    ],
    contentHash: `hash-w51-${Date.now()}`,
    createdBy: 'test',
  });
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w50.batchId, '2026-09-22T00:00:00Z']);
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w51.batchId, '2026-09-29T00:00:00Z']);
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
    expect(repeat.prev_reason_code).toBe('seasonal');
    expect(repeat.prev_reason_label).toBe('4.季節性/非當季產品');
    expect(repeat.prev_reason_note).toBe('上週話季節性');
    const fresh = items.find((i) => i.sku === 'A1003')!;
    expect(fresh.occurrence_count).toBe(1);
    expect(fresh.is_repeat).toBe(false);
    expect(fresh.prev_week_label).toBeNull();
    expect(fresh.prev_reason_code).toBeNull();
  });

  it('resolves history relative to the viewed batch (older batch has no previous)', async () => {
    const items = await listZeroSalesMyItems('HA02', { batchId: w41Id });
    const first = items.find((i) => i.sku === 'A1001')!;
    // 睇緊 W41 時，W42/W43 尚未發生：截至該週只出現過 1 次，未算重複，上一次應為空
    expect(first.occurrence_count).toBe(1);
    expect(first.is_repeat).toBe(false);
    expect(first.prev_week_label).toBeNull();
  });

  it('counts occurrences as of each batch (第3次只計到該週為止)', async () => {
    const w43Items = await listZeroSalesMyItems('HA02', { batchId: w43Id });
    const third = w43Items.find((i) => i.sku === 'A1001')!;
    expect(third.occurrence_count).toBe(3);
    expect(third.is_repeat).toBe(true);
    expect(third.prev_week_label).toBe('2026-W42-repeat');
    // 上次（W42）未回覆 → 無原因 code 可帶入（快捷按鍵不應顯示）
    expect(third.prev_status).toBe('pending');
    expect(third.prev_reason_code).toBeNull();

    // 再對照 W42：截至 W42 只算 2 次
    const w42Items = await listZeroSalesMyItems('HA02', { batchId: w42Id });
    const second = w42Items.find((i) => i.sku === 'A1001')!;
    expect(second.occurrence_count).toBe(2);
  });
});

describe('zero-sales repeat SKUs (cross-store)', () => {
  it('ranks SKUs by number of stores with repeated listings', async () => {
    const rows = await listZeroSalesRepeatSkus({ minCount: 2, limit: 10 });
    expect(rows[0].sku).toBe('X9001');
    const hit = rows.find((r) => r.sku === 'X9001')!;
    expect(hit.repeat_store_count).toBe(2);
    expect(hit.listed_store_count).toBe(2);
    expect(hit.repeat_rate).toBe(1);
    expect(hit.repeat_rows).toBe(4);
    expect(hit.total_rows).toBe(4);
    expect(hit.max_occurrence).toBe(2);
    expect(hit.pending_count).toBe(4);
    expect(hit.replied_count).toBe(0);
    expect(hit.brand).toBe('B2');
    expect(hit.sku_desc).toBe('跨店重複SKU');
    expect(hit.last_week_label).toBe('2026-W51-cross');
    expect(hit.last_seen).toBe('2026-09-29');

    const single = rows.find((r) => r.sku === 'X9002')!;
    expect(single.repeat_store_count).toBe(1);
    expect(single.listed_store_count).toBe(1);
    expect(single.repeat_rate).toBe(1);
    // 2 店重複排先於 1 店重複
    expect(rows.findIndex((r) => r.sku === 'X9001')).toBeLessThan(rows.findIndex((r) => r.sku === 'X9002'));
  });

  it('supports minCount / site / keyword filters', async () => {
    expect((await listZeroSalesRepeatSkus({ minCount: 3 })).some((r) => r.sku === 'X9001')).toBe(false);
    const siteRows = await listZeroSalesRepeatSkus({ siteCode: 'ZB01', minCount: 2 });
    expect(siteRows).toHaveLength(1);
    expect(siteRows[0].sku).toBe('X9001');
    expect(siteRows[0].listed_store_count).toBe(1);
    const byQ = await listZeroSalesRepeatSkus({ q: 'X9001', minCount: 2 });
    expect(byQ).toHaveLength(1);
    expect(await listZeroSalesRepeatSkus({ q: 'NOPE-NOPE', minCount: 2 })).toHaveLength(0);
  });

  it('exposes repeat-skus via the admin API with validation', async () => {
    const agent = await adminAgent();
    const ok = await agent.get('/api/admin/zero-sales/repeat-skus?min_count=2&limit=10');
    expect(ok.status).toBe(200);
    expect(ok.body.skus[0].sku).toBe('X9001');

    const badMin = await agent.get('/api/admin/zero-sales/repeat-skus?min_count=1');
    expect(badMin.status).toBe(400);
    const badLimit = await agent.get('/api/admin/zero-sales/repeat-skus?limit=101');
    expect(badLimit.status).toBe(400);

    const anon = request.agent(app);
    expect((await anon.get('/api/admin/zero-sales/repeat-skus')).status).toBe(401);
  });
});

describe('zero-sales repeat exports', () => {
  it('exports the cross-store repeat SKU ranking', async () => {
    const agent = await adminAgent();
    const res = await getXlsx(agent, '/api/admin/zero-sales/repeat-skus/export?min_count=2&limit=10');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('跨店重複 SKU');
    expect(ws).toBeDefined();
    const headers = (ws!.getRow(1).values as unknown[]).slice(1);
    expect(headers).toContain('重複店數');
    expect(headers).toContain('Buyer');
    expect(headers).toContain('判斷（參考）');

    let found: ExcelJS.Row | null = null;
    ws!.eachRow((row) => {
      if (row.getCell(2).value === 'X9001') found = row;
    });
    expect(found).not.toBeNull();
    const hit = found as unknown as ExcelJS.Row;
    expect(hit.getCell(1).value).toBe(1);
    expect(hit.getCell(6).value).toBe(2);
    expect(hit.getCell(8).value).toBe(1);
    expect(hit.getCell(16).value).toBe('疑似 SKU');
  });

  it('exports the per-store repeat detail', async () => {
    const agent = await adminAgent();
    const res = await getXlsx(agent, '/api/admin/zero-sales/repeats/export?min_count=2');
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('各店明細');
    expect(ws).toBeDefined();
    const headers = (ws!.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual([
      'Site Code', '店舖', 'By OM', 'SKU', 'Brand', 'SKU 描述',
      '出現次數', '未回覆', '已回覆', '首次出現', '最後出現', '最後週次',
      '週次（新→舊）', '上次回覆', '上次回覆時間',
    ]);
    const skus: string[] = [];
    const omBySku = new Map<string, string>();
    ws!.eachRow((row, n) => {
      if (n > 1) {
        skus.push(String(row.getCell(4).value ?? ''));
        omBySku.set(String(row.getCell(4).value ?? ''), String(row.getCell(3).value ?? ''));
      }
    });
    expect(skus).toContain('X9001');
    expect(skus).toContain('A1001');
    expect(skus).toContain('X9002');
    expect(omBySku.get('X9001')).toBe('Ivy');
  });

  it('rejects export when nothing matches or the caller is anonymous', async () => {
    const agent = await adminAgent();
    expect((await agent.get('/api/admin/zero-sales/repeat-skus/export?q=NOPE-NOPE')).status).toBe(404);
    expect((await agent.get('/api/admin/zero-sales/repeats/export?q=NOPE-NOPE')).status).toBe(404);

    const anon = request.agent(app);
    expect((await anon.get('/api/admin/zero-sales/repeat-skus/export')).status).toBe(401);
    expect((await anon.get('/api/admin/zero-sales/repeats/export')).status).toBe(401);
  });
});

describe('zero-sales repeats (admin)', () => {
  it('groups same site+sku across batches', async () => {
    const rows = await listZeroSalesRepeats({ minCount: 2 });
    const hit = rows.find((r) => r.site_code === 'HA02' && r.sku === 'A1001');
    expect(hit).toBeDefined();
    expect(hit!.occurrence_count).toBe(3);
    expect(hit!.weeks).toEqual(['2026-W43-repeat', '2026-W42-repeat', '2026-W41-repeat']);
    expect(hit!.replied_count).toBe(1);
    expect(hit!.pending_count).toBe(2);
    expect(hit!.brand).toBe('B1');
    expect(hit!.om).toBe('Ivy');
  });

  it('supports minCount / site / keyword filters', async () => {
    expect(await listZeroSalesRepeats({ minCount: 3 })).toHaveLength(1);
    expect(await listZeroSalesRepeats({ minCount: 4 })).toHaveLength(0);
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

  it('scopes the summary to a single batch when batch_id is given (不跨批次)', async () => {
    const agent = await adminAgent();
    const res = await agent.get(`/api/admin/zero-sales/summary?batch_id=${w42Id}`);
    expect(res.status).toBe(200);
    const s = res.body;
    // W42 只有 2 行（A1001 + A1003，均未回覆），而非跨批次的全部 4 行
    expect(s.total).toBe(2);
    expect(s.replied).toBe(0);
    expect(s.pending).toBe(2);
    expect(s.batches).toBeGreaterThanOrEqual(2); // batches 恆為全部批次數
    // 重複上榜只在跨批次總覽計算，單一批次內 site+sku 唯一必為 0
    expect(s.repeat_groups).toBe(0);
    expect(s.repeat_rows).toBe(0);
    // 原因分佈 / 待回覆店舖只含該批次資料（W42 無已回覆 → 分佈為空）
    expect(s.by_reason).toHaveLength(0);
    const store = (s.pending_by_store ?? []).find((r: { site_code: string }) => r.site_code === 'HA02');
    expect(store?.total).toBe(2);
    expect(store?.pending).toBe(2);

    const bad = await agent.get('/api/admin/zero-sales/summary?batch_id=not-a-uuid');
    expect(bad.status).toBe(400);
  });
});
