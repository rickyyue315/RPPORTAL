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

interface AdminItem {
  id: string;
  task_code: string;
  site_code: string;
  sku: string;
  stock_qty: number | null;
  status: string;
  lines: Array<{ year_code: string; qty: number }>;
  reply_total: number | null;
  reply_note: string;
  is_open: boolean;
}

async function batchItems(agent: Agent, batchId: string): Promise<{ batch: Record<string, unknown>; items: AdminItem[] }> {
  const res = await agent.get(`/api/admin/designated-sku/batches/${batchId}/items`);
  expect(res.status).toBe(200);
  return res.body as { batch: Record<string, unknown>; items: AdminItem[] };
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

describe('指定 SKU 回覆 API', () => {
  let batchId = '';
  let batchCode = '';
  let ha02Task = '';
  let hb20Task = '';
  let ha15Task = '';

  it('admin 上載 Excel 建立任務，任務編號可追溯', async () => {
    const agent = await adminAgent();
    const buffer = await buildWorkbook([
      { site: 'HA02', qty: 1 },
      { site: 'HB20', qty: 4 },
      { site: 'HA15', qty: 2 },
    ]);
    const res = await uploadBatch(agent, buffer, {
      instructions: '請按年期填報可調撥件數',
      due_date: '2026-11-10',
      reference: 'RP-2026-1042',
    });
    expect(res.status).toBe(201);
    expect(res.body.batchCode).toMatch(/^DSKU-\d{6}-\d{4}$/);
    expect(res.body.taskCount).toBe(3);
    expect(res.body.storeCount).toBe(3);
    batchId = res.body.batchId as string;
    batchCode = res.body.batchCode as string;

    const { batch, items } = await batchItems(agent, batchId);
    expect(batch.batch_code).toBe(batchCode);
    expect(batch.subject).toBe('指定 SKU 存貨年期確認（測試）');
    expect(batch.instructions).toBe('請按年期填報可調撥件數');
    expect(batch.due_date).toBe('2026-11-10');
    expect(batch.reference).toBe('RP-2026-1042');
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.task_code.startsWith(`${batchCode}-`)).toBe(true);
      expect(item.stock_qty).not.toBeNull();
    }
    ha02Task = items.find((i) => i.site_code === 'HA02')!.task_code;
    hb20Task = items.find((i) => i.site_code === 'HB20')!.task_code;
    ha15Task = items.find((i) => i.site_code === 'HA15')!.task_code;
  });

  it('同一檔案再上載會被擋，勾選 force 才可重新派發', async () => {
    const agent = await adminAgent();
    // 用另一間店（HC63）避免影響 HA02 的任務數斷言
    const buffer = await buildWorkbook([{ site: 'HC63', qty: 1 }]);
    const first = await uploadBatch(agent, buffer);
    expect(first.status).toBe(201);
    const res = await uploadBatch(agent, buffer);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_FILE');
    const forced = await uploadBatch(agent, buffer, { force: '1' });
    expect(forced.status).toBe(201);
    expect(forced.body.batchCode).not.toBe(first.body.batchCode);
  });

  it('店舖只見到自己的任務；直 link 只限涉及店舖', async () => {
    const ha02 = await storeAgent('HA02');
    const list = await ha02.get('/api/portal/designated-sku/tasks');
    expect(list.status).toBe(200);
    expect(list.body.tasks).toHaveLength(1);
    expect(list.body.tasks[0].task_code).toBe(ha02Task);
    expect(list.body.pending_count).toBe(1);

    const badge = await ha02.get('/api/portal/designated-sku/pending-count');
    expect(badge.status).toBe(200);
    expect(badge.body.pending_count).toBe(1);

    const own = await ha02.get(`/api/portal/designated-sku/tasks/${ha02Task}`);
    expect(own.status).toBe(200);
    expect(own.body.task.sku).toBe('107668017004');
    expect(own.body.task.batch_code).toBe(batchCode);

    // 另一間店用直 link 開別店任務：必須 403，且不可提交回覆
    const ha15 = await storeAgent('HA15');
    const foreign = await ha15.get(`/api/portal/designated-sku/tasks/${ha02Task}`);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('TASK_FORBIDDEN');

    const foreignReply = await ha15
      .put(`/api/portal/designated-sku/tasks/${ha02Task}/reply`)
      .set('x-csrf-token', ha15._csrf ?? '')
      .send({ lines: [{ year_code: '0827', qty: 1 }] });
    expect(foreignReply.status).toBe(403);

    const missing = await ha02.get('/api/portal/designated-sku/tasks/DSKU-000000-0000-99');
    expect(missing.status).toBe(404);
  });

  it('多個年期回覆：寫入明細、合計及狀態', async () => {
    const hb20 = await storeAgent('HB20');
    const res = await hb20
      .put(`/api/portal/designated-sku/tasks/${hb20Task}/reply`)
      .set('x-csrf-token', hb20._csrf ?? '')
      .send({
        lines: [
          { year_code: '0827', qty: 1 },
          { year_code: '0927', qty: 1 },
          { year_code: '0628', qty: 2 },
        ],
        note: '全部可調撥',
      });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('replied');
    expect(res.body.task.reply_total).toBe(4);
    expect(res.body.task.lines.map((l: { year_code: string; qty: number }) => [l.year_code, l.qty]))
      .toEqual([['0628', 2], ['0827', 1], ['0927', 1]]);
    expect(res.body.task.reply_note).toBe('全部可調撥');

    const again = await hb20.get('/api/portal/designated-sku/tasks');
    expect(again.body.pending_count).toBe(0);
    expect(again.body.tasks[0].status).toBe('replied');
  });

  it('年期格式、重複年期、超過存貨都會被拒', async () => {
    const ha02 = await storeAgent('HA02');
    const url = `/api/portal/designated-sku/tasks/${ha02Task}/reply`;
    const badYear = await ha02.put(url).set('x-csrf-token', ha02._csrf ?? '')
      .send({ lines: [{ year_code: '1327', qty: 1 }] });
    expect(badYear.status).toBe(400);
    expect(badYear.body.error).toContain('年期格式');

    const dup = await ha02.put(url).set('x-csrf-token', ha02._csrf ?? '')
      .send({ lines: [{ year_code: '0827', qty: 1 }, { year_code: '08/27', qty: 1 }] });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toContain('重複');

    const over = await ha02.put(url).set('x-csrf-token', ha02._csrf ?? '')
      .send({ lines: [{ year_code: '0827', qty: 2 }] });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain('不可多於存貨');

    const empty = await ha02.put(url).set('x-csrf-token', ha02._csrf ?? '')
      .send({ lines: [] });
    expect(empty.status).toBe(400);
  });

  it('封存後店舖不可再提交，重開後可補答', async () => {
    const admin = await adminAgent();
    const close = await admin
      .put(`/api/admin/designated-sku/batches/${batchId}/close`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({});
    expect(close.status).toBe(200);

    const ha02 = await storeAgent('HA02');
    const closed = await ha02
      .put(`/api/portal/designated-sku/tasks/${ha02Task}/reply`)
      .set('x-csrf-token', ha02._csrf ?? '')
      .send({ lines: [{ year_code: '0827', qty: 1 }] });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('TASK_CLOSED');

    const detail = await ha02.get(`/api/portal/designated-sku/tasks/${ha02Task}`);
    expect(detail.body.task.is_open).toBe(false);
    expect(detail.body.task.status).toBe('pending');

    const reopen = await admin
      .put(`/api/admin/designated-sku/batches/${batchId}/reopen`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({});
    expect(reopen.status).toBe(200);

    const replied = await ha02
      .put(`/api/portal/designated-sku/tasks/${ha02Task}/reply`)
      .set('x-csrf-token', ha02._csrf ?? '')
      .send({ lines: [{ year_code: '0827', qty: 1 }] });
    expect(replied.status).toBe(200);
    expect(replied.body.task.reply_total).toBe(1);
  });

  it('admin 匯出三個工作表，包含年期明細', async () => {
    const admin = await adminAgent();
    const res = await getXlsx(admin, `/api/admin/designated-sku/export?batch_id=${batchId}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['任務回覆', '年期明細', '未回覆店舖']);

    const summary = wb.getWorksheet('任務回覆')!;
    const header: string[] = [];
    summary.getRow(1).eachCell((cell, col) => { header[col - 1] = String(cell.value ?? ''); });
    expect(header).toContain('任務編號');
    expect(header).toContain('年期明細');
    const rows: string[][] = [];
    summary.eachRow((row, n) => {
      if (n === 1) return;
      rows.push([String(row.getCell(1).value ?? ''), String(row.getCell(12).value ?? '')]);
    });
    expect(rows.find((r) => r[0] === hb20Task)![1]).toContain('0827 × 1');

    const detail = wb.getWorksheet('年期明細')!;
    const yearRows: string[][] = [];
    detail.eachRow((row, n) => {
      if (n === 1) return;
      yearRows.push([String(row.getCell(1).value ?? ''), String(row.getCell(6).value ?? ''), String(row.getCell(7).value ?? '')]);
    });
    expect(yearRows).toContainEqual([hb20Task, '0827', '1']);
  });

  it('批次統計反映回覆進度；刪除單一任務會同步行數', async () => {
    const admin = await adminAgent();
    const summary = await admin.get('/api/admin/designated-sku/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.task_count).toBeGreaterThanOrEqual(3);
    expect(summary.body.replied_count).toBeGreaterThanOrEqual(1);

    const { items } = await batchItems(admin, batchId);
    const target = items.find((i) => i.site_code === 'HA15')!;
    expect(target.task_code).toBe(ha15Task);
    const del = await admin
      .delete(`/api/admin/designated-sku/batches/${batchId}/items/${target.id}`)
      .set('x-csrf-token', admin._csrf ?? '');
    expect(del.status).toBe(200);
    const after = await batchItems(admin, batchId);
    expect(after.batch.row_count).toBe(2);
    expect(after.items.some((i) => i.site_code === 'HA15')).toBe(false);
  });

  it('店舖不能以 query / body 指定別店 site_code', async () => {
    const ha02 = await storeAgent('HA02');
    const res = await ha02.get('/api/portal/designated-sku/tasks?site_code=HB20&status=pending');
    expect(res.status).toBe(200);
    expect(res.body.site_code).toBe('HA02');
    expect(res.body.tasks.every((t: { site_code: string }) => t.site_code === 'HA02')).toBe(true);
  });

  it('批次列表及分頁選項可供後台使用', async () => {
    const admin = await adminAgent();
    const res = await admin.get('/api/admin/designated-sku/batches?page=1&page_size=20');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(res.body.batch_options)).toBe(true);
    expect(res.body.batches[0].batch_code).toMatch(/^DSKU-/);
  });
});

describe('管理員代店舖回覆', () => {
  let editBatchId = '';
  let editTaskId = '';
  let editTaskCode = '';

  it('代填未回覆任務：狀態轉已回覆、回覆人為管理員代填、寫入審計', async () => {
    const admin = await adminAgent();
    const buffer = await buildWorkbook([{ site: 'HA15', qty: 1 }]);
    const up = await uploadBatch(admin, buffer, { subject: '管理員代填測試' });
    expect(up.status).toBe(201);
    editBatchId = up.body.batchId as string;
    const { items } = await batchItems(admin, editBatchId);
    expect(items).toHaveLength(1);
    editTaskId = items[0]!.id;
    editTaskCode = items[0]!.task_code;

    const res = await admin
      .put(`/api/admin/designated-sku/batches/${editBatchId}/items/${editTaskId}/reply`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ lines: [{ year_code: '0827', qty: 1 }], note: '店舖 email 補交' });
    expect(res.status).toBe(200);
    expect(res.body.entered).toBe(true);
    expect(res.body.item.status).toBe('replied');
    expect(res.body.item.replied_by).toBe('管理員代填（admin）');
    expect(res.body.item.reply_count).toBe(1);
    expect(res.body.item.reply_total).toBe(1);
    expect(res.body.item.admin_edited_by).toBe('admin');
    expect(res.body.item.admin_edited_at).toBeTruthy();

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE event_type = 'designated_sku_reply_admin_edited'`,
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it('店舖之後仍可自行修改（管理員代填不佔用店舖次數），並清空管理員修改標記', async () => {
    const ha15 = await storeAgent('HA15');
    const res = await ha15
      .put(`/api/portal/designated-sku/tasks/${editTaskCode}/reply`)
      .set('x-csrf-token', ha15._csrf ?? '')
      .send({ lines: [{ year_code: '0827', qty: 1 }], note: '店舖自行確認' });
    expect(res.status).toBe(200);
    expect(res.body.task.reply_count).toBe(2);
    expect(res.body.task.replied_by).toBe('HA15');
    expect(res.body.task.admin_edited_at).toBeNull();
  });

  it('編輯已回覆任務：保留原回覆人及次數，只加管理員修改紀錄', async () => {
    const admin = await adminAgent();
    const before = await batchItems(admin, editBatchId);
    const beforeItem = before.items[0]!;
    const res = await admin
      .put(`/api/admin/designated-sku/batches/${editBatchId}/items/${editTaskId}/reply`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ lines: [{ year_code: '0927', qty: 1 }], note: '管理員更正年期' });
    expect(res.status).toBe(200);
    expect(res.body.entered).toBe(false);
    expect(res.body.item.replied_by).toBe(beforeItem.replied_by);
    expect(res.body.item.reply_count).toBe(beforeItem.reply_count);
    expect(res.body.item.lines).toEqual([{ year_code: '0927', qty: 1 }]);
    expect(res.body.item.admin_edited_by).toBe('admin');
  });

  it('驗證年期格式、超過存貨及跨批次任務', async () => {
    const admin = await adminAgent();
    const url = `/api/admin/designated-sku/batches/${editBatchId}/items/${editTaskId}/reply`;
    const badYear = await admin
      .put(url)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ lines: [{ year_code: '1327', qty: 1 }] });
    expect(badYear.status).toBe(400);
    expect(badYear.body.error).toContain('年期格式');

    const over = await admin
      .put(url)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ lines: [{ year_code: '0827', qty: 2 }] });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain('不可多於存貨');

    const other = await uploadBatch(admin, await buildWorkbook([{ site: 'HB20', qty: 1 }]), { subject: '跨批次測試' });
    expect(other.status).toBe(201);
    const wrongBatch = await admin
      .put(`/api/admin/designated-sku/batches/${other.body.batchId}/items/${editTaskId}/reply`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ lines: [{ year_code: '0827', qty: 1 }] });
    expect(wrongBatch.status).toBe(404);
  });

  it('批次封存後管理員仍可更正，店舖則不可', async () => {
    const admin = await adminAgent();
    const close = await admin
      .put(`/api/admin/designated-sku/batches/${editBatchId}/close`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({});
    expect(close.status).toBe(200);

    const res = await admin
      .put(`/api/admin/designated-sku/batches/${editBatchId}/items/${editTaskId}/reply`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ lines: [{ year_code: '0628', qty: 1 }], note: '封存後更正' });
    expect(res.status).toBe(200);
    expect(res.body.item.is_open).toBe(false);
    expect(res.body.item.lines).toEqual([{ year_code: '0628', qty: 1 }]);

    const ha15 = await storeAgent('HA15');
    const storeTry = await ha15
      .put(`/api/portal/designated-sku/tasks/${editTaskCode}/reply`)
      .set('x-csrf-token', ha15._csrf ?? '')
      .send({ lines: [{ year_code: '0628', qty: 1 }] });
    expect(storeTry.status).toBe(409);
  });
});
