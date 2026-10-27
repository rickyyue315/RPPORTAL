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
import { createBatch as createZeroSalesBatch } from '../src/services/zeroSales.js';

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

function seedBatch(weekLabel: string, rows: Array<{ siteCode: string; sku: string; data: Record<string, string> }>) {
  return createZeroSalesBatch({
    weekLabel,
    note: 'export route test',
    rows,
    contentHash: `hash-${weekLabel}-${Date.now()}-${Math.random()}`,
    createdBy: 'test',
  });
}

/** supertest 預設不會解析未知二進制 content-type，需自帶 parser 收集原始位元組 */
function getXlsx(agent: Agent, url: string) {
  return agent.get(url).set('x-csrf-token', agent._csrf ?? '').buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

async function readSheet(buf: Buffer, name: string): Promise<Record<string, string | number>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`missing sheet ${name}`);
  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => { headers[col - 1] = String(cell.value ?? ''); });
  const rows: Record<string, string | number>[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return;
    const obj: Record<string, string | number> = {};
    headers.forEach((h, i) => {
      const v = row.getCell(i + 1).value;
      obj[h] = typeof v === 'object' && v !== null && 'richText' in v
        ? (v as { richText: Array<{ text?: string }> }).richText.map((t) => t.text ?? '').join('')
        : (v ?? '') as string | number;
    });
    rows.push(obj);
  });
  return rows;
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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql', '023_zero_sales_repeat_index.sql', '024_zero_sales_archive.sql', '025_zero_sales_auto_reply.sql', '026_shop_stock_snapshots.sql', '027_designated_sku_tasks.sql', '028_designated_sku_admin_edit.sql', '029_designated_sku_matters.sql', '030_designated_sku_due_at.sql', '031_zero_sales_no_reply.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
    { site_code: 'HA06', shop: '北角', regional: 'HK', class1: 'B', class2: 'B2', size: 'M', om: 'Ivy', type: 'M' },
  ]);
  app = createApp();

  // W42：兩店各一 SKU；上載 W43 後 W42 會自動封存
  const w42 = await seedBatch('2026-W42-route', [
    { siteCode: 'HA02', sku: 'A1', data: { Brand: 'B1', 'SKU Desc': 'W42 HA02' } },
    { siteCode: 'HA06', sku: 'B1', data: { Brand: 'B1', 'SKU Desc': 'W42 HA06' } },
  ]);
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w42.batchId, '2026-10-12T00:00:00Z']);
  const w43 = await seedBatch('2026-W43-route', [
    { siteCode: 'HA02', sku: 'A2', data: { Brand: 'B1', 'SKU Desc': 'W43 HA02' } },
  ]);
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w43.batchId, '2026-10-19T00:00:00Z']);
});

describe('GET /api/admin/zero-sales/export（全部批次）', () => {
  it('主表包含所有批次並有週次欄；未回覆店舖亦列出已封存週次', async () => {
    const agent = await adminAgent();
    const res = await getXlsx(agent, '/api/admin/zero-sales/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('Zero_Sales_All_Batches_');

    const main = await readSheet(res.body as Buffer, 'Zero Sales 回覆');
    expect(Object.keys(main[0]!)[0]).toBe('週次');
    expect(main.map((r) => `${r['週次']}|${r['Site Code']}|${r['SKU']}`)).toEqual([
      '2026-W43-route|HA02|A2',
      '2026-W42-route|HA02|A1',
      '2026-W42-route|HA06|B1',
    ]);
    expect(main.filter((r) => r['記錄狀態'] === '已截止（已封存）')).toHaveLength(2);

    const pending = await readSheet(res.body as Buffer, '未回覆店舖');
    const data = pending.filter((r) => !String(r['Site Code']).startsWith('註：'));
    expect(data.map((r) => [r['週次'], r['Site Code'], r['批次狀態'], r['未回覆 SKU']])).toEqual([
      ['2026-W43-route', 'HA02', '開放中', 'A2'],
      ['2026-W42-route', 'HA02', '已封存（已截止）', 'A1'],
      ['2026-W42-route', 'HA06', '已封存（已截止）', 'B1'],
    ]);
  });

  it('指定已封存的批次仍會匯出該批未回覆店舖', async () => {
    const agent = await adminAgent();
    const batches = await db.query<{ id: string }>(
      `SELECT id FROM zero_sales_batches WHERE week_label = '2026-W42-route'`,
    );
    const batchId = batches.rows[0]!.id;
    const res = await getXlsx(agent, `/api/admin/zero-sales/export?batch_id=${batchId}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('Zero_Sales_2026-W42-route_');

    const main = await readSheet(res.body as Buffer, 'Zero Sales 回覆');
    expect(main.map((r) => r['週次'])).toEqual(['2026-W42-route', '2026-W42-route']);

    const pending = await readSheet(res.body as Buffer, '未回覆店舖');
    const data = pending.filter((r) => !String(r['Site Code']).startsWith('註：'));
    expect(data).toHaveLength(2);
    expect(data.every((r) => r['批次狀態'] === '已封存（已截止）')).toBe(true);
  });
});
