import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { replaceStores } from '../src/services/stores.js';
import { syncOmPortalAccounts, syncStorePortalAccounts } from '../src/services/storeAccounts.js';
import { createBatch as createZeroSalesBatch } from '../src/services/zeroSales.js';
import { createBatch as createDesignatedSkuBatch } from '../src/services/designatedSku.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');

let app: Express;
let db: PGlite;
let zeroBatchId: string;
let zeroHa02ItemId: string;
let zeroHa19ItemId: string;
let designatedBatchId: string;
let designatedHa02MatterCode: string;
let designatedHa19MatterCode: string;

type Agent = ReturnType<typeof request.agent> & { _csrf?: string };

async function csrf(agent: Agent): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token as string;
}

async function omAgent(name = 'Ivy', password = 'SASAOM178'): Promise<Agent> {
  const agent = request.agent(app) as Agent;
  const token = await csrf(agent);
  const res = await agent
    .post('/api/portal/auth/login')
    .set('x-csrf-token', token)
    .send({ username: name, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.user.role).toBe('om');
  agent._csrf = await csrf(agent);
  return agent;
}

async function storeAgent(site: string): Promise<Agent> {
  const agent = request.agent(app) as Agent;
  const token = await csrf(agent);
  const res = await agent
    .post('/api/portal/auth/login')
    .set('x-csrf-token', token)
    .send({ username: site, password: 'SASA1234' });
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

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    let sql = await readFile(path.join(migrationsDir, file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }

  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
    { site_code: 'HA06', shop: '北角', regional: 'HK', class1: 'B', class2: 'B2', size: 'M', om: 'Ivy', type: 'M' },
    { site_code: 'HA19', shop: '康山', regional: 'HK', class1: 'C', class2: 'C2', size: 'S', om: 'Violet', type: 'L' },
  ]);
  await syncStorePortalAccounts('test');
  await syncOmPortalAccounts('test');

  const zero = await createZeroSalesBatch({
    weekLabel: '2026-W44-OM',
    note: 'OM test',
    rows: [
      { siteCode: 'HA02', sku: '1000001', data: { Brand: 'B1', 'SKU Desc': 'Ivy SKU' } },
      { siteCode: 'HA06', sku: '1000002', data: { Brand: 'B1', 'SKU Desc': 'Ivy SKU 2' } },
      { siteCode: 'HA19', sku: '1000003', data: { Brand: 'B2', 'SKU Desc': 'Violet SKU' } },
    ],
    contentHash: 'om-test-zero',
    createdBy: 'test',
  });
  zeroBatchId = zero.batchId;
  const zeroItems = await db.query<{ id: string; site_code: string }>(
    'SELECT id, site_code FROM zero_sales_items WHERE batch_id = $1 ORDER BY site_code',
    [zeroBatchId],
  );
  zeroHa02ItemId = zeroItems.rows.find((row) => row.site_code === 'HA02')!.id;
  zeroHa19ItemId = zeroItems.rows.find((row) => row.site_code === 'HA19')!.id;

  const designated = await createDesignatedSkuBatch({
    subject: 'OM 指定 SKU 測試',
    sourceFilename: 'om-test.xlsx',
    rows: [
      { siteCode: 'HA02', sku: '107668017004', hierarchy: 'DRG', description: 'Ivy SKU', stockQty: 5, data: {} },
      { siteCode: 'HA19', sku: '107668017005', hierarchy: 'DRG', description: 'Violet SKU', stockQty: 5, data: {} },
    ],
    skippedRows: 0,
    warnCount: 0,
    contentHash: 'om-test-dsku',
    createdBy: 'test',
  });
  designatedBatchId = designated.batchId;
  const matters = await db.query<{ matter_code: string; site_code: string }>(
    'SELECT matter_code, site_code FROM designated_sku_matters WHERE batch_id = $1',
    [designatedBatchId],
  );
  designatedHa02MatterCode = matters.rows.find((row) => row.site_code === 'HA02')!.matter_code;
  designatedHa19MatterCode = matters.rows.find((row) => row.site_code === 'HA19')!.matter_code;

  app = createApp();
});

describe('OM portal', () => {
  it('logs an OM in with the OM password and rejects the store password', async () => {
    const agent = await omAgent('Ivy');
    const me = await agent.get('/api/portal/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('om');
    expect(me.body.user.username).toBe('IVY');

    const wrongStorePassword = request.agent(app) as Agent;
    const token = await csrf(wrongStorePassword);
    const bad = await wrongStorePassword
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'Ivy', password: 'SASA1234' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toContain('OM 專用密碼');

    const unknownOm = request.agent(app) as Agent;
    const token2 = await csrf(unknownOm);
    const unknown = await unknownOm
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token2)
      .send({ username: 'Nobody', password: 'SASAOM178' });
    expect(unknown.status).toBe(401);
  });

  it('only lists stores managed by the logged-in OM', async () => {
    const agent = await omAgent('Ivy');
    const res = await agent.get('/api/portal/om/overview');
    expect(res.status).toBe(200);
    expect(res.body.stores.map((s: { site_code: string }) => s.site_code)).toEqual(['HA02', 'HA06']);

    const dsku = await agent.get('/api/portal/om/designated-sku/matters');
    expect(dsku.status).toBe(200);
    expect(dsku.body.matters).toHaveLength(1);
    expect(dsku.body.matters[0].site_code).toBe('HA02');
    expect(dsku.body.matters[0].matter_code).toBe(designatedHa02MatterCode);
  });

  it('rejects a store account on the OM API', async () => {
    const store = await storeAgent('HA02');
    const res = await store.get('/api/portal/om/overview');
    expect(res.status).toBe(403);
  });

  it('lets an OM reply to zero-sales items in managed stores only', async () => {
    const agent = await omAgent('Ivy');
    const own = await agent
      .put(`/api/portal/om/zero-sales/items/${zeroHa02ItemId}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'seasonal', reason_note: 'OM 電話跟進後代覆' });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.entered).toBe(true);
    expect(own.body.item.replied_by).toContain('OM 代覆');

    const other = await agent
      .put(`/api/portal/om/zero-sales/items/${zeroHa19ItemId}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'seasonal', reason_note: '' });
    expect(other.status).toBe(403);

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE event_type = 'om_zero_sales_reply' AND actor_role = 'om' AND actor = 'IVY'`,
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it('lets an OM reply to a designated-SKU matter in a managed store only', async () => {
    const agent = await omAgent('Ivy');
    const list = await agent.get('/api/portal/om/designated-sku/matters');
    const matter = list.body.matters[0] as {
      matter_code: string;
      items: Array<{ id: string }>;
    };
    const items = matter.items.map((item) => ({
      item_id: item.id,
      lines: [{ year_code: '0827', qty: 1 }],
      note: 'OM 代覆',
      no_transfer: false,
    }));
    const res = await agent
      .put(`/api/portal/om/designated-sku/matters/${matter.matter_code}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ items });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.matter.status).toBe('replied');
    expect(res.body.matter.replied_by).toContain('OM 代覆');

    const other = await agent
      .put(`/api/portal/om/designated-sku/matters/${designatedHa19MatterCode}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ items: [{ item_id: '00000000-0000-4000-8000-000000000000', lines: [{ year_code: '0827', qty: 1 }] }] });
    expect(other.status).toBe(403);

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE event_type = 'om_designated_sku_reply' AND actor_role = 'om' AND actor = 'IVY'`,
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it('aggregates stock trends only across managed stores and blocks other stores', async () => {
    const batch = await db.query<{ id: string }>(
      `INSERT INTO shop_stock_batches (report_date, report_kind, week_label, row_count, store_count, content_hash, uploaded_by)
       VALUES ('2026-10-25', 'weekly', '25Oct2026', 3, 3, 'om-stock', 'test')
       RETURNING id`,
    );
    const batchId = batch.rows[0]!.id;
    for (const row of [
      { site: 'HA02', shop: '駱克', om: 'Ivy', excess: 10, soh: 100, sku0: 1, rf: 8 },
      { site: 'HA06', shop: '北角', om: 'Ivy', excess: 20, soh: 100, sku0: 2, rf: 7 },
      { site: 'HA19', shop: '康山', om: 'Violet', excess: 900, soh: 1000, sku0: 9, rf: 9 },
    ]) {
      await db.query(
        `INSERT INTO shop_stock_snapshots
           (batch_id, site_code, shop, om, sku_count_0sale, excess_value_0sale, shop_stock_value_cm, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          batchId,
          row.site,
          row.shop,
          row.om,
          row.sku0,
          row.excess,
          row.soh,
          JSON.stringify({ 'No. of SKU Carry': '10', 'No. of RF SKU': String(row.rf) }),
        ],
      );
    }

    const agent = await omAgent('Ivy');
    const res = await agent.get('/api/portal/om/stock');
    expect(res.status).toBe(200);
    expect(res.body.stores.map((s: { site_code: string }) => s.site_code)).toEqual(['HA02', 'HA06']);
    expect(res.body.kpi.ratio).toBeCloseTo(30 / 200, 6);
    expect(res.body.kpi.company_ratio).toBeCloseTo(930 / 1200, 6);
    // 不良 SKU ÷ Carry SKU：Ivy = 3 / 20；全公司 = 12 / 30
    expect(res.body.kpi.sku_count_0sale).toBe(3);
    expect(res.body.kpi.total_sku_carry).toBe(20);
    expect(res.body.kpi.ovs_carry_ratio).toBeCloseTo(3 / 20, 6);
    expect(res.body.kpi.company_ovs_carry_ratio).toBeCloseTo(12 / 30, 6);
    expect(res.body.series[0].total_sku_carry).toBe(20);
    expect(res.body.series[0].ovs_carry_ratio).toBeCloseTo(3 / 20, 6);
    expect(res.body.company_series[0].total_sku_carry).toBe(30);
    expect(res.body.company_series[0].ovs_carry_ratio).toBeCloseTo(12 / 30, 6);

    const ha02 = res.body.stores.find((s: { site_code: string }) => s.site_code === 'HA02');
    expect(ha02.sku_count_0sale).toBe(1);
    expect(ha02.total_sku_carry).toBe(10);
    expect(ha02.rf_sku_count).toBe(8);
    expect(ha02.ovs_carry_ratio).toBeCloseTo(1 / 10, 6);

    const selected = await agent.get('/api/portal/om/stock?site_code=HA02');
    expect(selected.status).toBe(200);
    expect(selected.body.selected_store.site_code).toBe('HA02');
    expect(selected.body.selected_store.kpi.total_sku_carry).toBe(10);
    expect(selected.body.selected_store.kpi.ovs_carry_ratio).toBeCloseTo(1 / 10, 6);
    expect(selected.body.selected_store.kpi.company_ovs_carry_ratio).toBeCloseTo(12 / 30, 6);
    expect(selected.body.selected_store.series[0].ovs_carry_ratio).toBeCloseTo(1 / 10, 6);

    const other = await agent.get('/api/portal/om/stock?site_code=HA19');
    expect(other.status).toBe(403);
  });

  it('blocks OM replies after the zero-sales week is archived', async () => {
    await db.query('UPDATE zero_sales_batches SET closed_at = now() WHERE id = $1', [zeroBatchId]);
    const agent = await omAgent('Ivy');
    const items = await agent.get(`/api/portal/om/zero-sales/items?batch_id=${zeroBatchId}`);
    const pending = (items.body.items as Array<{ id: string; status: string }>).find((item) => item.status === 'pending');
    expect(pending).toBeTruthy();
    const res = await agent
      .put(`/api/portal/om/zero-sales/items/${pending!.id}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'seasonal', reason_note: '' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BATCH_CLOSED');
  });
});
