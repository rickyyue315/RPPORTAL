import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { listMigrationFiles } from './migrateTest.js';
import { setPoolForTesting } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { getZero90Summary, upsertZero90Stat } from '../src/services/zeroSales90d.js';

/**
 * 「90日0銷售（統計）」每週摘要測試。
 *
 * 這張表是手動入數（簡報數字），同 I14 By Shop 完全獨立；測試驗：
 *   1. migration 042 的 7 期回填數字（總數必須等於 MAKE UP + Non-MAKE UP）
 *   2. 衍生比率／變幅／平均每店（缺值回 null，不當 0）
 *   3. API 全鏈路：權限、CSRF、zod（空字串不可變 0）、覆蓋同日、刪除、匯出
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makePglitePool(db: PGlite): never {
  const clientLike = {
    async query(text: string, params?: unknown[]) {
      return db.query(text, params ?? []);
    },
    release: () => {},
  };
  return {
    query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
    connect: async (): Promise<PoolClient> => clientLike as PoolClient,
  } as never;
}

const MIGRATIONS = await listMigrationFiles();

let db: PGlite;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting(makePglitePool(db));
  for (const file of MIGRATIONS) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    // PGlite 內建 gen_random_uuid，pgcrypto extension 在 WASM build 未必可用
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  app = createApp();
});

describe('migration 042 回填', () => {
  it('載入 2026-10-06 至 2026-11-17 共 7 期，總數 = MAKE UP + Non-MAKE UP', async () => {
    const summary = await getZero90Summary();
    expect(summary.period_count).toBe(7);
    expect(summary.series.map((row) => row.report_date)).toEqual([
      '2026-10-06',
      '2026-10-14',
      '2026-10-20',
      '2026-10-27',
      '2026-11-03',
      '2026-11-10',
      '2026-11-17',
    ]);

    for (const row of summary.series) {
      expect(row.sku_total).toBe(row.makeup_sku + row.non_makeup_sku);
      expect(row.qty_total).toBeCloseTo(row.makeup_qty_cm + row.non_makeup_qty_cm, 3);
    }

    const latest = summary.series[summary.series.length - 1];
    expect(latest.shop_count).toBe(88);
    expect(latest.sku_total).toBe(6659);
    expect(latest.qty_total).toBeCloseTo(230888, 3);
    expect(latest.makeup_sku_share).toBeCloseTo(2575 / 6659, 6);
    expect(latest.makeup_qty_share).toBeCloseTo(102676 / 230888, 6);
  });

  it('KPI 帶最新一期與較上期變幅（11-17 vs 11-10）', async () => {
    const summary = await getZero90Summary();
    const kpi = summary.kpi;
    expect(kpi).not.toBeNull();
    expect(kpi!.period_count).toBe(7);
    expect(kpi!.prev_report_date).toBe('2026-11-10');
    expect(kpi!.sku_delta).toBe(6659 - 6670);
    expect(kpi!.sku_delta_pct).toBeCloseTo((6659 - 6670) / 6670, 6);
    expect(kpi!.qty_delta).toBeCloseTo(230888 - 237159, 3);
    expect(kpi!.sku_per_shop).toBeCloseTo(6659 / 88, 6);
  });
});

describe('service：新增／覆蓋／缺值', () => {
  beforeAll(async () => {
    await db.exec('DELETE FROM zero_sales_90d_stats');
  });

  it('第一期沒有較上期數字（回 null，不是 0）', async () => {
    const saved = await upsertZero90Stat({
      reportDate: '2026-12-01',
      shopCount: 90,
      makeupSku: 100,
      makeupQtyCm: 1000.5,
      nonMakeupSku: 200,
      nonMakeupQtyCm: 2000.25,
      note: '第一期',
      actor: 'tester',
    });
    expect(saved.sku_total).toBe(300);
    expect(saved.qty_total).toBeCloseTo(3000.75, 3);
    expect(saved.sku_delta).toBeNull();
    expect(saved.sku_delta_pct).toBeNull();
    expect(saved.prev_report_date).toBeNull();
    expect(saved.makeup_sku_share).toBeCloseTo(100 / 300, 6);
    expect(saved.sku_per_shop).toBeCloseTo(300 / 90, 6);
  });

  it('同一日期再儲存 = 覆蓋，不會多一期；變幅基準是上一期', async () => {
    await upsertZero90Stat({
      reportDate: '2026-12-08',
      shopCount: 88,
      makeupSku: 150,
      makeupQtyCm: 1500,
      nonMakeupSku: 250,
      nonMakeupQtyCm: 2500,
      note: '',
      actor: 'tester',
    });
    const overwritten = await upsertZero90Stat({
      reportDate: '2026-12-08',
      shopCount: 89,
      makeupSku: 160,
      makeupQtyCm: 1600,
      nonMakeupSku: 260,
      nonMakeupQtyCm: 2600,
      note: '改後',
      actor: 'tester2',
    });
    expect(overwritten.shop_count).toBe(89);
    expect(overwritten.sku_total).toBe(420);
    expect(overwritten.prev_report_date).toBe('2026-12-01');
    expect(overwritten.sku_delta).toBe(120);
    expect(overwritten.sku_delta_pct).toBeCloseTo(120 / 300, 6);

    const summary = await getZero90Summary();
    expect(summary.period_count).toBe(2);
  });

  it('店數為 0 時「平均每店」回 null（不是 0）', async () => {
    const saved = await upsertZero90Stat({
      reportDate: '2026-12-15',
      shopCount: 0,
      makeupSku: 10,
      makeupQtyCm: 10,
      nonMakeupSku: 10,
      nonMakeupQtyCm: 10,
      note: '',
      actor: 'tester',
    });
    expect(saved.sku_per_shop).toBeNull();
    expect(saved.qty_per_shop).toBeNull();
  });
});

describe.skipIf(!config.adminPassword)('admin routes', () => {
  let cookie: string[] = [];
  let csrf = '';

  beforeAll(async () => {
    const seeded = await request(app).get('/api/csrf');
    csrf = String((seeded.body as { token?: string }).token ?? '');
    const initial = (seeded.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const login = await request(app)
      .post('/api/admin/login')
      .set('Cookie', initial)
      .set('x-csrf-token', csrf)
      .send({ username: config.adminUsername, password: config.adminPassword });
    expect(login.status).toBe(200);
    const sessionCookie = (login.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    cookie = [...initial, ...sessionCookie];
  });

  it('未登入不可讀取 summary', async () => {
    const res = await request(app).get('/api/admin/stock/zero90/summary');
    expect(res.status).toBe(401);
  });

  it('GET summary 回傳全部期數＋KPI', async () => {
    const res = await request(app)
      .get('/api/admin/stock/zero90/summary')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.period_count).toBe(3);
    expect(res.body.kpi.report_date).toBe('2026-12-15');
  });

  it('POST 新增一期（總數由伺服器相加）', async () => {
    const res = await request(app)
      .post('/api/admin/stock/zero90')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        report_date: '2026-12-22',
        shop_count: '90',
        makeup_sku: '1,200',
        makeup_qty_cm: '1,234.5',
        non_makeup_sku: '2,300',
        non_makeup_qty_cm: '2,345.25',
        note: '手動入數',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.row.sku_total).toBe(3500);
    expect(res.body.row.qty_total).toBeCloseTo(3579.75, 3);
    expect(res.body.row.note).toBe('手動入數');
  });

  it('POST 空字串／負數／小數 SKU 一律 400（空字串不可變 0）', async () => {
    const base = {
      report_date: '2026-12-29',
      shop_count: '90',
      makeup_sku: '10',
      makeup_qty_cm: '10',
      non_makeup_sku: '10',
      non_makeup_qty_cm: '10',
    };
    const empty = await request(app)
      .post('/api/admin/stock/zero90')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ ...base, makeup_sku: '' });
    expect(empty.status).toBe(400);

    const negative = await request(app)
      .post('/api/admin/stock/zero90')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ ...base, non_makeup_qty_cm: '-1' });
    expect(negative.status).toBe(400);

    const fractional = await request(app)
      .post('/api/admin/stock/zero90')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ ...base, non_makeup_sku: '10.5' });
    expect(fractional.status).toBe(400);

    const badDate = await request(app)
      .post('/api/admin/stock/zero90')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ ...base, report_date: '2026-02-30' });
    expect(badDate.status).toBe(400);
  });

  it('寫入缺少 CSRF 標頭 → 403', async () => {
    const res = await request(app)
      .post('/api/admin/stock/zero90')
      .set('Cookie', cookie)
      .send({
        report_date: '2026-12-29',
        shop_count: 90,
        makeup_sku: 1,
        makeup_qty_cm: 1,
        non_makeup_sku: 1,
        non_makeup_qty_cm: 1,
      });
    expect(res.status).toBe(403);
  });

  it('匯出 Excel（內容為 xlsx，含三張工作表）', async () => {
    // supertest 預設不解析未知二進制 content-type，需自帶 parser 收集原始位元組
    const res = await request(app)
      .get('/api/admin/stock/zero90/export')
      .set('Cookie', cookie)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('spreadsheetml');
    expect(String(res.headers['content-disposition'])).toContain('Zero_Sales_90D_');
    const buffer = res.body as Buffer;
    expect(buffer.length).toBeGreaterThan(1000);
    // xlsx 是 zip：開頭必須是 PK
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['90日0銷售', 'PPT 圖表用', '匯出說明']);
    const detail = workbook.getWorksheet('90日0銷售');
    expect(detail).toBeTruthy();
    // 8 欄位 + 日期 + 備註（第一行是表頭）
    expect(detail!.getRow(1).getCell(1).value).toBe('報表日期');
    expect(detail!.getRow(2).getCell(1).value).toBe('2026-12-01');
    expect(detail!.getRow(2).getCell(3).value).toBe(300);
    expect(detail!.getRow(4).getCell(3).value).toBe(20);
  });

  it('DELETE 某一期；再刪同一期回 404', async () => {
    const first = await request(app)
      .delete('/api/admin/stock/zero90/2026-12-22')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf);
    expect(first.status).toBe(200);

    const again = await request(app)
      .delete('/api/admin/stock/zero90/2026-12-22')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf);
    expect(again.status).toBe(404);

    const summary = await request(app)
      .get('/api/admin/stock/zero90/summary')
      .set('Cookie', cookie);
    expect(summary.body.period_count).toBe(3);
  });
});
