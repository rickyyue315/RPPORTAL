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
import {
  normalizeYearCode,
  parseDesignatedSkuWorkbook,
} from '../src/lib/designatedSku.js';

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

const HEADERS = [
  'Product Hierarchy',
  'Article',
  'Article Long Text (60 Chars)',
  'Site',
  'SaSa Net Stock',
  '店舖回覆可調撥件數',
  '貨品年期 (MMYY)',
];

async function buildWorkbook(
  rows: Array<{ site: string; sku?: string; qty?: string | number; desc?: string }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Check List');
  ws.addRow(HEADERS);
  for (const row of rows) {
    ws.addRow([
      'DRG',
      row.sku ?? '107668017004',
      row.desc ?? 'SPF50+PA+++全效活能雙重BB霜',
      row.site,
      row.qty ?? '',
      null,
      null,
    ]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function uploadBatch(
  agent: Agent,
  buffer: Buffer,
  fields: Record<string, string> = {},
): Promise<request.Response> {
  let req = agent
    .post('/api/admin/designated-sku/batches')
    .set('x-csrf-token', agent._csrf ?? '')
    .field('subject', fields.subject ?? '指定 SKU 存貨年期確認（測試）');
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'subject') continue;
    req = req.field(key, value);
  }
  return req.attach('file', buffer, 'designated-sku-test.xlsx');
}

interface MatterItem {
  id: string;
  sku: string;
  stock_qty: number | null;
  status: string;
  no_transfer: boolean;
  reply_total: number | null;
  reply_note: string;
  reply_count: number;
  admin_edited_at: string | null;
  admin_edited_by: string;
  lines: Array<{ year_code: string; qty: number }>;
}

interface Matter {
  id: string;
  matter_code: string;
  site_code: string;
  status: string;
  item_count: number;
  replied_item_count: number;
  reply_total: number;
  is_open: boolean;
  replied_by: string;
  items: MatterItem[];
}

async function batchMatters(agent: Agent, batchId: string): Promise<{ batch: Record<string, unknown>; matters: Matter[] }> {
  const res = await agent.get(`/api/admin/designated-sku/batches/${batchId}/matters`);
  expect(res.status).toBe(200);
  return res.body as { batch: Record<string, unknown>; matters: Matter[] };
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
    { site_code: 'HA15', shop: '銅鑼灣', regional: 'HK', class1: 'B', class2: 'B2', size: 'M', om: 'Ivy', type: 'M' },
    { site_code: 'HB20', shop: '旺角', regional: 'KLN', class1: 'B', class2: 'B2', size: 'L', om: 'Ken', type: 'M' },
    { site_code: 'HC63', shop: '沙田', regional: 'NT', class1: 'B', class2: 'B2', size: 'M', om: 'Ken', type: 'M' },
  ]);
  const pwHash = await hashPassword('StoreTest1!ABCD');
  for (const site of ['HA02', 'HA15', 'HB20', 'HC63']) {
    await db.query(
      `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
       VALUES ($1, $1, 'store', $2, $3, false, true, 'test')
       ON CONFLICT (username) DO UPDATE SET active = true`,
      [site, site, pwHash],
    );
  }
  app = createApp();
});

/** supertest 預設不解析未知二進制 content-type，需自帶 parser 收集原始位元組 */
function getXlsx(agent: Agent, url: string) {
  return agent.get(url).set('x-csrf-token', agent._csrf ?? '').buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

describe('normalizeYearCode', () => {
  it('接受 MMYY、8/27 等寫法，月份必須 01–12', () => {
    expect(normalizeYearCode('0827')).toBe('0827');
    expect(normalizeYearCode('8/27')).toBe('0827');
    expect(normalizeYearCode('8-27')).toBe('0827');
    expect(normalizeYearCode('827')).toBe('0827');
    expect(normalizeYearCode('1327')).toBeNull();
    expect(normalizeYearCode('0027')).toBeNull();
    expect(normalizeYearCode('abc')).toBeNull();
    expect(normalizeYearCode('')).toBeNull();
  });
});

describe('parseDesignatedSkuWorkbook', () => {
  it('讀出 Site / SKU / 存貨，並剔除 Total 列', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Check List');
    ws.addRow(HEADERS);
    ws.addRow(['DRG', '107668017004', 'BB Cream', 'HB20', 4, null, null]);
    ws.addRow(['DRG', '107668017004', 'BB Cream', 'HA02', '2', null, null]);
    ws.addRow(['', '', '', 'Total', 6, null, null]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const parsed = await parseDesignatedSkuWorkbook(buffer, new Set(['HB20', 'HA02']), 100);
    expect(parsed.ok).toBe(true);
    expect(parsed.totalRows).toBe(2);
    expect(parsed.skippedRows).toBe(1);
    expect(parsed.rows!.map((r) => [r.siteCode, r.stockQty])).toEqual([['HB20', 4], ['HA02', 2]]);
    expect(parsed.rows![0]!.description).toBe('BB Cream');
  });

  it('非數字存貨留空（不當 0）並產生提示；未知 Site 及重複行則擋下', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Check List');
    ws.addRow(HEADERS);
    ws.addRow(['DRG', '107668017004', 'BB Cream', 'HB20', 'N/A', null, null]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const ok = await parseDesignatedSkuWorkbook(buffer, new Set(['HB20']), 100);
    expect(ok.ok).toBe(true);
    expect(ok.rows![0]!.stockQty).toBeNull();
    expect(ok.warnings!.length).toBe(1);

    const dup = await buildWorkbook([{ site: 'HB20' }, { site: 'HB20' }]);
    const dupResult = await parseDesignatedSkuWorkbook(dup, new Set(['HB20']), 100);
    expect(dupResult.ok).toBe(false);
    expect(dupResult.errors![0]!.reason).toContain('重複');

    const unknown = await buildWorkbook([{ site: 'ZZ99' }]);
    const unknownResult = await parseDesignatedSkuWorkbook(unknown, new Set(['HB20']), 100);
    expect(unknownResult.ok).toBe(false);
    expect(unknownResult.errors![0]!.reason).toContain('不存在於門店主檔');
  });

  it('找不到 Site / SKU 表頭時回清楚錯誤', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Foo', 'Bar']);
    const parsed = await parseDesignatedSkuWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), new Set(), 100);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors![0]!.reason).toContain('Site');
  });
});

describe('指定 SKU 回覆 API（一個事項多個 SKU）', () => {
  let batchId = '';
  let batchCode = '';
  let ha02Matter = '';
  let ha02MatterId = '';
  let hb20Matter = '';
  let hb20MatterId = '';
  let hc63MatterId = '';
  let ha02SkuA = '';
  let ha02SkuB = '';
  /**
   * 上載成功的原始檔案位元組。
   * 重複檔案偵測用 contentHash = 檔案 bytes 雜湊，而 ExcelJS 每次 writeBuffer
   * 都會寫入新的時間戳，所以「內容相同但重新產生」的檔案雜湊不同 —— 測試必
   * 須重用同一份 buffer，否則會隨執行速度時好時壞（CI 曾因此失敗）。
   */
  let mainBuffer: Buffer;

  it('admin 上載 Excel：同店多個 SKU 歸入同一事項', async () => {
    const agent = await adminAgent();
    const buffer = await buildWorkbook([
      { site: 'HA02', sku: '107668017004', qty: 1 },
      { site: 'HA02', sku: '108000000001', qty: 2, desc: '另一款貨品' },
      { site: 'HB20', sku: '107668017004', qty: 4 },
      { site: 'HC63', sku: '107668017004', qty: 3 },
    ]);
    mainBuffer = buffer;
    const res = await uploadBatch(agent, buffer, {
      instructions: '請按年期填報可調撥件數',
      due_at: '2026-11-10T18:00',
      reference: 'RP-2026-1042',
    });
    expect(res.status).toBe(201);
    expect(res.body.batchCode).toMatch(/^DSKU-\d{6}-\d{4}$/);
    expect(res.body.matterCount).toBe(3);
    expect(res.body.itemCount).toBe(4);
    expect(res.body.storeCount).toBe(3);
    batchId = res.body.batchId as string;
    batchCode = res.body.batchCode as string;

    const { batch, matters } = await batchMatters(agent, batchId);
    expect(batch.batch_code).toBe(batchCode);
    expect(batch.subject).toBe('指定 SKU 存貨年期確認（測試）');
    expect(batch.instructions).toBe('請按年期填報可調撥件數');
    // 輸入香港時間 18:00，讀回同一時間
    expect(batch.due_at).toBe('2026-11-10 18:00');
    expect(batch.reference).toBe('RP-2026-1042');
    expect(batch.matter_count).toBe(3);
    expect(batch.row_count).toBe(4);
    expect(batch.store_count).toBe(3);
    expect(matters).toHaveLength(3);

    const ha02 = matters.find((m) => m.site_code === 'HA02')!;
    expect(ha02.item_count).toBe(2);
    expect(ha02.matter_code).toBe(`${batchCode}-01`);
    expect(ha02.items.map((it) => it.sku)).toEqual(['107668017004', '108000000001']);
    ha02Matter = ha02.matter_code;
    ha02MatterId = ha02.id;
    ha02SkuA = ha02.items[0]!.id;
    ha02SkuB = ha02.items[1]!.id;

    const hb20 = matters.find((m) => m.site_code === 'HB20')!;
    expect(hb20.item_count).toBe(1);
    hb20Matter = hb20.matter_code;
    hb20MatterId = hb20.id;
    hc63MatterId = matters.find((m) => m.site_code === 'HC63')!.id;
  });

  it('同一檔案再上載會被擋（DUPLICATE_FILE）', async () => {
    const agent = await adminAgent();
    const res = await uploadBatch(agent, mainBuffer);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_FILE');
    expect(res.body.existing.batch_code).toBe(batchCode);
  });

  it('店舖只見到自己的事項；直 link 只限涉及店舖', async () => {
    const ha02 = await storeAgent('HA02');
    const list = await ha02.get('/api/portal/designated-sku/matters');
    expect(list.status).toBe(200);
    expect(list.body.matters).toHaveLength(1);
    expect(list.body.matters[0].matter_code).toBe(ha02Matter);
    expect(list.body.matters[0].items).toHaveLength(2);
    expect(list.body.pending_count).toBe(1);

    const badge = await ha02.get('/api/portal/designated-sku/pending-count');
    expect(badge.body.pending_count).toBe(1);

    const own = await ha02.get(`/api/portal/designated-sku/matters/${ha02Matter}`);
    expect(own.status).toBe(200);
    expect(own.body.matter.batch_code).toBe(batchCode);
    expect(own.body.matter.items.map((it: { sku: string }) => it.sku)).toEqual(['107668017004', '108000000001']);
    // 內部欄位不外洩
    expect(own.body.matter.settings).toBeUndefined();
    expect(own.body.matter.batch_note).toBeUndefined();
    expect(own.body.matter.items[0].payload).toBeUndefined();

    const ha15 = await storeAgent('HA15');
    const foreign = await ha15.get(`/api/portal/designated-sku/matters/${ha02Matter}`);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('MATTER_FORBIDDEN');

    const foreignReply = await ha15
      .put(`/api/portal/designated-sku/matters/${ha02Matter}/reply`)
      .set('x-csrf-token', ha15._csrf ?? '')
      .send({ items: [{ item_id: ha02SkuA, lines: [{ year_code: '0827', qty: 1 }], no_transfer: false }] });
    expect(foreignReply.status).toBe(403);

    const missing = await ha02.get('/api/portal/designated-sku/matters/DSKU-000000-0000-99');
    expect(missing.status).toBe(404);
  });

  it('一次過回覆多個 SKU：年期明細 + 無可調撥', async () => {
    const ha02 = await storeAgent('HA02');
    const res = await ha02
      .put(`/api/portal/designated-sku/matters/${ha02Matter}/reply`)
      .set('x-csrf-token', ha02._csrf ?? '')
      .send({
        items: [
          { item_id: ha02SkuA, lines: [{ year_code: '0827', qty: 1 }], note: 'A 可調撥' },
          { item_id: ha02SkuB, lines: [], no_transfer: true, note: 'B 無貨可調' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.matter.status).toBe('replied');
    expect(res.body.matter.replied_item_count).toBe(2);
    expect(res.body.matter.reply_total).toBe(1);
    const a = res.body.matter.items.find((it: MatterItem) => it.sku === '107668017004')!;
    const b = res.body.matter.items.find((it: MatterItem) => it.sku === '108000000001')!;
    expect(a.lines).toEqual([{ year_code: '0827', qty: 1 }]);
    expect(a.reply_note).toBe('A 可調撥');
    expect(b.no_transfer).toBe(true);
    expect(b.status).toBe('replied');
    expect(b.reply_total).toBe(0);
    expect(b.lines).toEqual([]);

    const again = await ha02.get('/api/portal/designated-sku/matters');
    expect(again.body.pending_count).toBe(0);
    expect(again.body.matters[0].status).toBe('replied');
  });

  it('驗證：缺 SKU、超存貨、年期格式、重複年期', async () => {
    const ha02 = await storeAgent('HA02');
    const url = `/api/portal/designated-sku/matters/${ha02Matter}/reply`;

    const missing = await ha02.put(url).set('x-csrf-token', ha02._csrf ?? '')
      .send({ items: [{ item_id: ha02SkuA, lines: [{ year_code: '0827', qty: 1 }] }] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('每個 SKU');

    const over = await ha02.put(url).set('x-csrf-token', ha02._csrf ?? '')
      .send({
        items: [
          { item_id: ha02SkuA, lines: [{ year_code: '0827', qty: 1 }] },
          { item_id: ha02SkuB, lines: [{ year_code: '0927', qty: 3 }] },
        ],
      });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain('不可多於存貨');

    const badYear = await ha02.put(url).set('x-csrf-token', ha02._csrf ?? '')
      .send({
        items: [
          { item_id: ha02SkuA, lines: [{ year_code: '1327', qty: 1 }] },
          { item_id: ha02SkuB, lines: [], no_transfer: true },
        ],
      });
    expect(badYear.status).toBe(400);
    expect(badYear.body.error).toContain('年期格式');

    const dupYear = await ha02.put(url).set('x-csrf-token', ha02._csrf ?? '')
      .send({
        items: [
          { item_id: ha02SkuA, lines: [{ year_code: '0827', qty: 1 }, { year_code: '08/27', qty: 1 }] },
          { item_id: ha02SkuB, lines: [], no_transfer: true },
        ],
      });
    expect(dupYear.status).toBe(400);
    expect(dupYear.body.error).toContain('重複');
  });

  it('管理員代填未回覆事項（多個年期）', async () => {
    const admin = await adminAgent();
    const res = await admin
      .put(`/api/admin/designated-sku/batches/${batchId}/matters/${hb20MatterId}/reply`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({
        items: [
          {
            item_id: (await batchMatters(admin, batchId)).matters.find((m) => m.id === hb20MatterId)!.items[0]!.id,
            lines: [
              { year_code: '0827', qty: 1 },
              { year_code: '0927', qty: 1 },
              { year_code: '0628', qty: 2 },
            ],
            note: '店舖 email 補交',
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.entered).toBe(true);
    expect(res.body.matter.status).toBe('replied');
    expect(res.body.matter.reply_total).toBe(4);
    expect(res.body.matter.items[0].replied_by).toBe('管理員代填（admin）');
    expect(res.body.matter.items[0].reply_count).toBe(1);
    expect(res.body.matter.items[0].admin_edited_by).toBe('admin');

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE event_type = 'designated_sku_reply_admin_edited'`,
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it('管理員編輯已回覆事項：保留原回覆人及次數', async () => {
    const admin = await adminAgent();
    const res = await admin
      .put(`/api/admin/designated-sku/batches/${batchId}/matters/${ha02MatterId}/reply`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({
        items: [
          { item_id: ha02SkuA, lines: [{ year_code: '0927', qty: 1 }], note: '管理員更正年期' },
          { item_id: ha02SkuB, lines: [], no_transfer: true },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.entered).toBe(false);
    const a = res.body.matter.items.find((it: MatterItem) => it.sku === '107668017004')!;
    expect(a.lines).toEqual([{ year_code: '0927', qty: 1 }]);
    expect(a.replied_by).toBe('HA02');
    expect(a.reply_count).toBe(1);
    expect(a.admin_edited_by).toBe('admin');
    expect(a.admin_edited_at).toBeTruthy();
  });

  it('admin 匯出：事項回覆 / 年期明細 / 未回覆事項（每 SKU 一行）', async () => {
    const admin = await adminAgent();
    const res = await getXlsx(admin, `/api/admin/designated-sku/export?batch_id=${batchId}`);
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['事項回覆', '年期明細', '未回覆事項']);

    const summary = wb.getWorksheet('事項回覆')!;
    const header: string[] = [];
    summary.getRow(1).eachCell((cell, col) => { header[col - 1] = String(cell.value ?? ''); });
    expect(header).toContain('事項編號');
    expect(header).toContain('SKU 狀態');
    expect(header).toContain('無可調撥');

    const rows: string[][] = [];
    summary.eachRow((row, n) => {
      if (n === 1) return;
      rows.push([String(row.getCell(1).value ?? ''), String(row.getCell(7).value ?? ''), String(row.getCell(12).value ?? '')]);
    });
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r[0] === ha02Matter)).toHaveLength(2);
    expect(rows.find((r) => r[1] === '108000000001')![2]).toBe('是');

    const detail = wb.getWorksheet('年期明細')!;
    const yearRows: string[][] = [];
    detail.eachRow((row, n) => {
      if (n === 1) return;
      yearRows.push([String(row.getCell(1).value ?? ''), String(row.getCell(5).value ?? ''), String(row.getCell(6).value ?? ''), String(row.getCell(7).value ?? '')]);
    });
    expect(yearRows).toContainEqual([ha02Matter, '107668017004', '0927', '1']);
    expect(yearRows.filter((r) => r[0] === hb20Matter)).toHaveLength(3);

    const pending = wb.getWorksheet('未回覆事項')!;
    const pendingRows: string[] = [];
    pending.eachRow((row, n) => {
      if (n === 1) return;
      pendingRows.push(String(row.getCell(3).value ?? ''));
    });
    expect(pendingRows).toEqual([`${batchCode}-03`]);
  });

  it('刪除單一事項會同步批次事項數及 SKU 行數', async () => {
    const admin = await adminAgent();
    const del = await admin
      .delete(`/api/admin/designated-sku/batches/${batchId}/matters/${hc63MatterId}`)
      .set('x-csrf-token', admin._csrf ?? '');
    expect(del.status).toBe(200);
    expect(del.body.matterCode).toBe(`${batchCode}-03`);
    expect(del.body.itemCount).toBe(1);

    const after = await batchMatters(admin, batchId);
    expect(after.batch.matter_count).toBe(2);
    expect(after.batch.row_count).toBe(3);
    expect(after.batch.store_count).toBe(2);
    expect(after.matters.some((m) => m.site_code === 'HC63')).toBe(false);
  });

  it('統計反映事項與 SKU 數', async () => {
    const admin = await adminAgent();
    const summary = await admin.get('/api/admin/designated-sku/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.matter_count).toBe(2);
    expect(summary.body.item_count).toBe(3);
    expect(summary.body.replied_count).toBe(2);
    expect(summary.body.pending_count).toBe(0);
    expect(summary.body.store_count).toBe(2);
  });

  it('封存後店舖不可再提交，管理員仍可更正；重開後店舖可補答', async () => {
    const admin = await adminAgent();
    const close = await admin
      .put(`/api/admin/designated-sku/batches/${batchId}/close`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({});
    expect(close.status).toBe(200);

    const ha02 = await storeAgent('HA02');
    const closed = await ha02
      .put(`/api/portal/designated-sku/matters/${ha02Matter}/reply`)
      .set('x-csrf-token', ha02._csrf ?? '')
      .send({
        items: [
          { item_id: ha02SkuA, lines: [{ year_code: '0827', qty: 1 }] },
          { item_id: ha02SkuB, lines: [], no_transfer: true },
        ],
      });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('MATTER_CLOSED');

    const detail = await ha02.get(`/api/portal/designated-sku/matters/${ha02Matter}`);
    expect(detail.body.matter.is_open).toBe(false);

    const adminEdit = await admin
      .put(`/api/admin/designated-sku/batches/${batchId}/matters/${ha02MatterId}/reply`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({
        items: [
          { item_id: ha02SkuA, lines: [{ year_code: '0628', qty: 1 }], note: '封存後更正' },
          { item_id: ha02SkuB, lines: [], no_transfer: true },
        ],
      });
    expect(adminEdit.status).toBe(200);
    expect(adminEdit.body.matter.is_open).toBe(false);

    const reopen = await admin
      .put(`/api/admin/designated-sku/batches/${batchId}/reopen`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({});
    expect(reopen.status).toBe(200);

    const replied = await ha02
      .put(`/api/portal/designated-sku/matters/${ha02Matter}/reply`)
      .set('x-csrf-token', ha02._csrf ?? '')
      .send({
        items: [
          { item_id: ha02SkuA, lines: [{ year_code: '0827', qty: 1 }] },
          { item_id: ha02SkuB, lines: [], no_transfer: true },
        ],
      });
    expect(replied.status).toBe(200);
    expect(replied.body.matter.reply_total).toBe(1);
  });

  it('批次列表及店舖查詢不可用 query 指定別店', async () => {
    const admin = await adminAgent();
    const list = await admin.get('/api/admin/designated-sku/batches?page=1&page_size=20');
    expect(list.status).toBe(200);
    expect(list.body.batches[0].matter_count).toBe(2);
    expect(list.body.batches[0].row_count).toBe(3);

    const ha02 = await storeAgent('HA02');
    const res = await ha02.get('/api/portal/designated-sku/matters?site_code=HB20&status=pending');
    expect(res.status).toBe(200);
    expect(res.body.site_code).toBe('HA02');
    expect(res.body.matters.every((m: { site_code: string }) => m.site_code === 'HA02')).toBe(true);
  });

  it('同一檔案勾選 force 可重新派發', async () => {
    const agent = await adminAgent();
    const forced = await uploadBatch(agent, mainBuffer, { force: '1' });
    expect(forced.status).toBe(201);
    expect(forced.body.batchCode).not.toBe(batchCode);
    expect(forced.body.matterCount).toBe(3);
  });
});

describe('人手輸入與批次維護', () => {
  let mb = '';
  let mbCode = '';
  let hb20Matter = '';
  let hb20MatterId = '';
  let hb20ItemA = '';
  let hb20ItemB = '';

  const manualRows = [
    { site_code: 'HB20', sku: '200000000001', description: 'A 貨品', stock_qty: '4' },
    { site_code: 'HB20', sku: '200000000002', description: 'B 貨品', stock_qty: '' },
    { site_code: 'HA15', sku: '200000000001', stock_qty: '2' },
  ];

  it('人手輸入建立批次：同店多個 SKU 歸入同一事項，存貨留空保持 null', async () => {
    const admin = await adminAgent();
    const res = await admin
      .post('/api/admin/designated-sku/batches/manual')
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ subject: '人手輸入測試', due_at: '2026-12-31T18:30', rows: manualRows });
    expect(res.status).toBe(201);
    expect(res.body.matterCount).toBe(2);
    expect(res.body.itemCount).toBe(3);
    mb = res.body.batchId as string;
    mbCode = res.body.batchCode as string;

    const { batch, matters } = await batchMatters(admin, mb);
    expect(batch.due_at).toBe('2026-12-31 18:30');
    expect(batch.row_count).toBe(3);
    expect(matters).toHaveLength(2);

    const hb20 = matters.find((m) => m.site_code === 'HB20')!;
    expect(hb20.items).toHaveLength(2);
    expect(hb20.items.find((it) => it.sku === '200000000001')!.stock_qty).toBe(4);
    expect(hb20.items.find((it) => it.sku === '200000000002')!.stock_qty).toBeNull();
    hb20Matter = hb20.matter_code;
    hb20MatterId = hb20.id;
    hb20ItemA = hb20.items.find((it) => it.sku === '200000000001')!.id;
    hb20ItemB = hb20.items.find((it) => it.sku === '200000000002')!.id;
  });

  it('人手輸入：同店重複 SKU 會逐行報錯', async () => {
    const admin = await adminAgent();
    const res = await admin
      .post('/api/admin/designated-sku/batches/manual')
      .set('x-csrf-token', admin._csrf ?? '')
      .send({
        subject: '重複行測試',
        rows: [
          { site_code: 'HB20', sku: '200000000009', stock_qty: '1' },
          { site_code: 'HB20', sku: '200000000009', stock_qty: '2' },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].reason).toContain('重複');
  });

  it('人手輸入：相同清單再提交 409，勾 force 可重新派發', async () => {
    const admin = await adminAgent();
    const dup = await admin
      .post('/api/admin/designated-sku/batches/manual')
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ subject: '人手輸入測試（重複）', rows: manualRows });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_FILE');

    const forced = await admin
      .post('/api/admin/designated-sku/batches/manual')
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ subject: '人手輸入測試（重派）', rows: manualRows, force: '1' });
    expect(forced.status).toBe(201);
    expect(forced.body.batchCode).not.toBe(mbCode);
    // 清掉，避免影響後面的人手批次斷言
    await admin
      .delete(`/api/admin/designated-sku/batches/${forced.body.batchId}`)
      .set('x-csrf-token', admin._csrf ?? '');
  });

  it('批次內補加 SKU：新店自動建立事項、同店加入現有事項、重複會擋', async () => {
    const admin = await adminAgent();
    const first = await admin
      .post(`/api/admin/designated-sku/batches/${mb}/items`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ site_code: 'HC63', sku: '200000000003', description: 'C 貨品', stock_qty: 5 });
    expect(first.status).toBe(201);
    expect(first.body.matterCreated).toBe(true);

    const second = await admin
      .post(`/api/admin/designated-sku/batches/${mb}/items`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ site_code: 'HC63', sku: '200000000004', stock_qty: '' });
    expect(second.status).toBe(201);
    expect(second.body.matterCreated).toBe(false);
    expect(second.body.matterId).toBe(first.body.matterId);

    const dup = await admin
      .post(`/api/admin/designated-sku/batches/${mb}/items`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ site_code: 'HC63', sku: '200000000003', stock_qty: 1 });
    expect(dup.status).toBe(400);

    const { batch } = await batchMatters(admin, mb);
    expect(batch.matter_count).toBe(3);
    expect(batch.row_count).toBe(5);
  });

  it('修改存貨：不可低於已回覆合計；可改描述及 SKU 編號', async () => {
    const admin = await adminAgent();
    const store = await storeAgent('HB20');
    const replied = await store
      .put(`/api/portal/designated-sku/matters/${hb20Matter}/reply`)
      .set('x-csrf-token', store._csrf ?? '')
      .send({
        items: [
          { item_id: hb20ItemA, lines: [{ year_code: '0927', qty: 3 }] },
          { item_id: hb20ItemB, lines: [], no_transfer: true },
        ],
      });
    expect(replied.status).toBe(200);

    const tooLow = await admin
      .put(`/api/admin/designated-sku/batches/${mb}/items/${hb20ItemA}`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ stock_qty: 2 });
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error).toContain('不可少於');

    const ok = await admin
      .put(`/api/admin/designated-sku/batches/${mb}/items/${hb20ItemA}`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ stock_qty: 5, description: 'A 貨品（已更正）', sku: '200000000001X' });
    expect(ok.status).toBe(200);

    const { matters } = await batchMatters(admin, mb);
    const item = matters
      .find((m) => m.id === hb20MatterId)!
      .items.find((it) => it.id === hb20ItemA)!;
    expect(item.stock_qty).toBe(5);
    expect(item.sku).toBe('200000000001X');
    expect(item.description).toBe('A 貨品（已更正）');
    // 回覆紀錄不受影響
    expect(item.lines).toEqual([{ year_code: '0927', qty: 3 }]);
  });

  it('改店舖：SKU 會搬到該店的事項，舊事項空了自動移除', async () => {
    const admin = await adminAgent();
    const moved = await admin
      .put(`/api/admin/designated-sku/batches/${mb}/items/${hb20ItemB}`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ site_code: 'HA02' });
    expect(moved.status).toBe(200);
    expect(moved.body.moved).toBe(true);
    expect(moved.body.matterCode).toBe(`${mbCode}-04`);

    const { batch, matters } = await batchMatters(admin, mb);
    expect(batch.matter_count).toBe(4);
    expect(batch.row_count).toBe(5);
    expect(matters.find((m) => m.site_code === 'HA02')!.items.map((it) => it.sku)).toEqual(['200000000002']);
    expect(matters.find((m) => m.id === hb20MatterId)!.items.map((it) => it.sku)).toEqual(['200000000001X']);

    // 搬走最後一隻 → 事項消失
    const back = await admin
      .put(`/api/admin/designated-sku/batches/${mb}/items/${hb20ItemB}`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ site_code: 'HB20' });
    expect(back.status).toBe(200);
    const after = await batchMatters(admin, mb);
    expect(after.batch.matter_count).toBe(3);
  });

  it('刪除 SKU：事項再無其他 SKU 時連事項一併移除', async () => {
    const admin = await adminAgent();
    // 先搬一隻 SKU 去 HA02，建立一個只有 1 個 SKU 的事項
    const moved = await admin
      .put(`/api/admin/designated-sku/batches/${mb}/items/${hb20ItemB}`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ site_code: 'HA02' });
    expect(moved.status).toBe(200);

    const before = await batchMatters(admin, mb);
    const ha02Matter = before.matters.find((m) => m.site_code === 'HA02')!;
    expect(ha02Matter.items).toHaveLength(1);
    const del = await admin
      .delete(`/api/admin/designated-sku/batches/${mb}/items/${ha02Matter.items[0]!.id}`)
      .set('x-csrf-token', admin._csrf ?? '');
    expect(del.status).toBe(200);
    expect(del.body.matterDeleted).toBe(true);

    const after = await batchMatters(admin, mb);
    expect(after.batch.matter_count).toBe(3);
    expect(after.batch.row_count).toBe(4);
    expect(after.matters.some((m) => m.site_code === 'HA02')).toBe(false);
  });

  it('截止時間已過：店舖不可提交、標示已逾期；管理員仍可代填，延長後店舖可提交', async () => {
    const admin = await adminAgent();
    const past = await admin
      .post('/api/admin/designated-sku/batches/manual')
      .set('x-csrf-token', admin._csrf ?? '')
      .send({
        subject: '過期測試',
        due_at: '2020-01-01T10:00',
        rows: [{ site_code: 'HA15', sku: '200000000099', stock_qty: 2 }],
      });
    expect(past.status).toBe(201);
    const batchId = past.body.batchId as string;

    const { matters } = await batchMatters(admin, batchId);
    expect(matters[0]!.is_open).toBe(false);
    expect(matters[0]!.is_expired).toBe(true);
    const code = matters[0]!.matter_code;
    const itemId = matters[0]!.items[0]!.id;

    const store = await storeAgent('HA15');
    const list = await store.get('/api/portal/designated-sku/matters');
    const seen = list.body.matters.find((m: { matter_code: string }) => m.matter_code === code);
    expect(seen.is_open).toBe(false);
    expect(seen.is_expired).toBe(true);

    const blocked = await store
      .put(`/api/portal/designated-sku/matters/${code}/reply`)
      .set('x-csrf-token', store._csrf ?? '')
      .send({ items: [{ item_id: itemId, lines: [{ year_code: '0827', qty: 1 }] }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('MATTER_CLOSED');
    expect(blocked.body.error).toContain('截止時間');

    const adminEdit = await admin
      .put(`/api/admin/designated-sku/batches/${batchId}/matters/${matters[0]!.id}/reply`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ items: [{ item_id: itemId, lines: [{ year_code: '0827', qty: 1 }] }] });
    expect(adminEdit.status).toBe(200);

    const extended = await admin
      .put(`/api/admin/designated-sku/batches/${batchId}`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ due_at: '2030-01-01T18:00' });
    expect(extended.status).toBe(200);
    expect(extended.body.batch.due_at).toBe('2030-01-01 18:00');
    expect(extended.body.batch.is_open).toBe(true);
    expect(extended.body.batch.is_expired).toBe(false);

    const allowed = await store
      .put(`/api/portal/designated-sku/matters/${code}/reply`)
      .set('x-csrf-token', store._csrf ?? '')
      .send({ items: [{ item_id: itemId, lines: [{ year_code: '0827', qty: 1 }] }] });
    expect(allowed.status).toBe(200);
  });

  it('封存後不可再補加 SKU，重開後可', async () => {
    const admin = await adminAgent();
    await admin
      .put(`/api/admin/designated-sku/batches/${mb}/close`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({});
    const blocked = await admin
      .post(`/api/admin/designated-sku/batches/${mb}/items`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ site_code: 'HC63', sku: '200000000077', stock_qty: 1 });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toContain('封存');

    await admin
      .put(`/api/admin/designated-sku/batches/${mb}/reopen`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({});
    const ok = await admin
      .post(`/api/admin/designated-sku/batches/${mb}/items`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ site_code: 'HC63', sku: '200000000077', stock_qty: 1 });
    expect(ok.status).toBe(201);
  });
});
