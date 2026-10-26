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
import { hashPassword } from '../src/services/portalAuth.js';
import { createBatch as createZeroSalesBatch } from '../src/services/zeroSales.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;

type Agent = ReturnType<typeof request.agent> & { _csrf?: string };

async function csrf(agent: Agent): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token as string;
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

function seedBatch(weekLabel: string, rows: Array<{ siteCode: string; sku: string; data: Record<string, string> }>) {
  return createZeroSalesBatch({
    weekLabel,
    note: 'test',
    rows,
    contentHash: `hash-${weekLabel}-${Date.now()}-${Math.random()}`,
    createdBy: 'test',
  });
}

async function readStoreSheet(buf: Buffer): Promise<Record<string, string | number>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const ws = wb.getWorksheet('零銷售回覆');
  if (!ws) throw new Error('missing sheet');
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

/** supertest 預設不會解析未知二進制 content-type，需自帶 parser 收集原始位元組 */
function getXlsx(agent: Agent, url: string) {
  return agent.get(url).set('x-csrf-token', agent._csrf ?? '').buffer(true).parse((res, cb) => {
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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql', '023_zero_sales_repeat_index.sql', '024_zero_sales_archive.sql', '025_zero_sales_auto_reply.sql', '026_shop_stock_snapshots.sql', '027_designated_sku_tasks.sql', '028_designated_sku_admin_edit.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
    { site_code: 'HA06', shop: '北角', regional: 'HK', class1: 'B', class2: 'B2', size: 'M', om: 'Ivy', type: 'M' },
  ]);
  // 店舖 portal 帳戶（登入只驗共享密碼，帳戶須存在且 active）
  const pwHash = await hashPassword('StoreTest1!ABCD');
  for (const site of ['HA02', 'HA06']) {
    await db.query(
      `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
       VALUES ($1, $1, 'store', $2, $3, false, true, 'test')
       ON CONFLICT (username) DO UPDATE SET active = true`,
      [site, site, pwHash],
    );
  }
  app = createApp();
});

describe('GET /api/portal/zero-sales/my/export', () => {
  it('只包含本舖的 SKU，欄位為店舖版 11 欄', async () => {
    const batch = await seedBatch('2026-W42-route', [
      { siteCode: 'HA02', sku: '1000001', data: { Brand: 'B1 - Brand One', 'SKU Desc': 'Lip 4g', 'Shop Stock Qty (CM)': '12', 'RP Type': 'RP', 'Safety Stock (現時)': '8' } },
      { siteCode: 'HA02', sku: '1000002', data: { Brand: 'B2 - Brand Two', 'SKU Desc': 'Cream 50g', 'Shop Stock Qty (CM)': '3', 'RP Type': 'NRP', 'Safety Stock (現時)': '5' } },
      { siteCode: 'HA06', sku: '1000003', data: { Brand: 'B3 - Other Shop Only', 'SKU Desc': 'X', 'Shop Stock Qty (CM)': '99' } },
    ]);
    expect(batch.batchId).toBeTruthy();
    const agent = await storeAgent('HA02');
    const res = await getXlsx(agent, '/api/portal/zero-sales/my/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('Zero_Sales_HA02_');
    const rows = await readStoreSheet(res.body as Buffer);
    // 只顯示該舖的 SKU：HA06 的行不可出現
    expect(rows.map((r) => String(r['SKU']))).toEqual(['1000001', '1000002']);
    expect(rows[0]!['Brand']).toBe('B1 - Brand One');
    expect(rows[0]!['狀態']).toBe('未回覆');
    expect(rows[0]!['存貨量']).toBe(12);
    expect(rows[0]!['RP Type']).toBe('RP');
    expect(rows[0]!['Safety Stock']).toBe('8');
  });

  it('status / q / repeat 篩選生效；空結果回 404', async () => {
    const agent = await storeAgent('HA02');
    const withQ = await getXlsx(agent, '/api/portal/zero-sales/my/export?q=1000001');
    expect(withQ.status).toBe(200);
    const qRows = await readStoreSheet(withQ.body as Buffer);
    expect(qRows.map((r) => String(r['SKU']))).toEqual(['1000001']);

    const pending = await getXlsx(agent, '/api/portal/zero-sales/my/export?status=pending');
    expect(pending.status).toBe(200);
    const pendingRows = await readStoreSheet(pending.body as Buffer);
    expect(pendingRows.every((r) => r['狀態'] === '未回覆')).toBe(true);

    const repeat = await getXlsx(agent, '/api/portal/zero-sales/my/export?repeat=1');
    expect(repeat.status).toBe(404);

    const badBatch = await getXlsx(agent, '/api/portal/zero-sales/my/export?batch_id=not-a-uuid');
    expect(badBatch.status).toBe(400);
    const badStatus = await getXlsx(agent, '/api/portal/zero-sales/my/export?status=whatever');
    expect(badStatus.status).toBe(400);
  });

  it('回覆後匯出顯示已回覆及原因；跨週重複上榜顯示第N次', async () => {
    // 第二週再派同一 SKU → 該行為重複上榜
    const items = await db.query<{ id: string; sku: string }>(
      `SELECT i.id, i.sku FROM zero_sales_items i
        JOIN zero_sales_batches b ON b.id = i.batch_id
        WHERE b.week_label = '2026-W42-route' AND i.site_code = 'HA02' AND i.sku = '1000001'`,
    );
    const itemId = items.rows[0]!.id;
    const agent = await storeAgent('HA02');
    const reply = await agent
      .put(`/api/portal/zero-sales/items/${itemId}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'no_display', reason_note: '已加位擺出面' });
    expect(reply.status).toBe(200);

    await seedBatch('2026-W43-route', [
      { siteCode: 'HA02', sku: '1000001', data: { Brand: 'B1 - Brand One', 'SKU Desc': 'Lip 4g' } },
    ]);

    const res = await getXlsx(agent, '/api/portal/zero-sales/my/export');
    expect(res.status).toBe(200);
    const rows = await readStoreSheet(res.body as Buffer);
    // W42 有兩行：已回覆的 1000001 及未回覆的 1000002；未回覆行會排前，所以要按 SKU 找
    const w42 = rows.find((r) => r['週次'] === '2026-W42-route' && String(r['SKU']) === '1000001')!;
    // W43 已派發 → W42 自動封存：狀態會同時標示已封存，避免舊匯出表被當成待辦
    expect(w42['狀態']).toBe('已回覆（已封存）');
    expect(String(w42['店舖本次回覆'])).toContain('1.無陳列/陳列位置不佳');
    expect(String(w42['店舖本次回覆'])).toContain('已加位擺出面');
    // 週次新到舊：W43 在前
    expect(rows[0]!['週次']).toBe('2026-W43-route');
    const w43 = rows[0]!;
    expect(String(w43['重複提示'])).toContain('第2次上榜');
    expect(String(w43['重複提示'])).toContain('2026-W42-route');
  });

  it('未登入不可匯出', async () => {
    const anon = request.agent(app) as Agent;
    const token = await csrf(anon);
    const res = await anon
      .get('/api/portal/zero-sales/my/export')
      .set('x-csrf-token', token);
    expect(res.status).toBe(401);
  });
});
