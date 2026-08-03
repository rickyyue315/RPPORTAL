import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
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
import { TEMPLATE_COLUMNS, RP_TEAM_SHEET, SHOP_CODE_HEADER, URGENT_COLUMNS, URGENT_SHEET } from '../src/lib/fields.js';
import * as time from '../src/lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let app: Express;
let db: PGlite;
let timeSpy: ReturnType<typeof vi.spyOn>;

function makePglitePool(database: PGlite): never {
  return {
    query: async (text: string, params?: unknown[]) => database.query(text, params ?? []),
    connect: async () => ({
      query: async (text: string, params?: unknown[]) => database.query(text, params ?? []),
      release: () => {},
    }),
  } as never;
}

async function csrf(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token;
}

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting(makePglitePool(db));
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores(
    [
      { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
      { site_code: 'HA06', shop: '北角', regional: 'HK', class1: 'B', class2: 'B2', size: 'M', om: 'Ivy', type: 'M' },
      { site_code: 'HA19', shop: '康山', regional: 'HK', class1: 'C', class2: 'C2', size: 'S', om: 'Violet', type: 'L' },
      { site_code: 'HBA7', shop: 'AIRSIDE', regional: 'HK', class1: 'C', class2: 'C2', size: 'XS', om: 'Hippo', type: 'M' },
    ],
  );
  app = createApp();
  // Freeze the clock at 09:00 HK so tests are independent of the real wall-clock
  // (the Urgent Order window closes at 14:30 HK). Window tests override this spy.
  timeSpy = vi.spyOn(time, 'hkMinutesNow').mockReturnValue(9 * 60);
});

describe('public API', () => {
  it('validates a known site code', async () => {
    const res = await request(app).get('/api/public/stores/HA02');
    expect(res.status).toBe(200);
    expect(res.body.store.requested_by_email).toBe('ha02@sasa.com');
  });

  it('rejects an unknown site code', async () => {
    const res = await request(app).get('/api/public/stores/ZZ99');
    expect(res.status).toBe(404);
  });

  it('rejects submit with unknown site code', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'ZZ99',
      sku: '123456',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('site_code');
  });

  it('rejects submit with missing SKU', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('sku');
  });

  it('rejects submit with missing RP Type', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '110001',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('rp_type');
  });

  it('rejects ND submit without ND Code', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '110002',
      rp_type: 'ND',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('nd_code');
  });

  it('rejects RF submit without Safety stock', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '110003',
      rp_type: 'RF',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('safety_stock');
  });

  it('rejects RF submit with Safety stock not greater than 0', async () => {
    for (const safetyStock of ['0', '-5', 'abc']) {
      const res = await request(app).post('/api/public/submit').send({
        site_code: 'HA02',
        sku: '110004',
        rp_type: 'RF',
        safety_stock: safetyStock,
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('safety_stock');
    }
  });

  it('accepts RF submit with positive Safety stock for a non-listed store', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '110005',
      rp_type: 'RF',
      safety_stock: '3.5',
    });
    expect(res.status).toBe(201);
  });

  it('rejects RF submit for a listed store without Remark', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA19',
      sku: '110006',
      rp_type: 'RF',
      safety_stock: '5',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('remark');
  });

  it('accepts RF submit for a listed store with Remark', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HBA7',
      sku: '110007',
      rp_type: 'RF',
      safety_stock: '8',
      remark: '轉 RF 原因',
    });
    expect(res.status).toBe(201);
  });

  it('accepts a valid submission', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      brand: 'NEG - NEOGENCE',
      sku: '110079623001',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
    });
    expect(res.status).toBe(201);
    expect(res.body.submission.application_no).toMatch(/^NDRF-/);
    expect(res.body.submission.status).toBe('received');
    expect(res.body.submission.locked).toBe(false);
    expect(res.body.store.shop).toBe('駱克');
  });

  it('queries a submission with application_no + site_code', async () => {
    const created = await request(app).post('/api/public/submit').send({
      site_code: 'HA06',
      sku: '999001',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
      remark: 'test',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).get(`/api/public/query?application_no=${no}&site_code=HA06`);
    expect(res.status).toBe(200);
    expect(res.body.submission.application_no).toBe(no);
    expect(res.body.submission.site_code).toBe('HA06');
  });

  it('does not reveal whether an application number exists', async () => {
    const res = await request(app).get('/api/public/query?application_no=NDRF-NOPE-00000000&site_code=HA02');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('找不到相符申報');
  });

  it('downloads the template workbook without login', async () => {
    const res = await request(app).get('/api/public/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
  });
});

describe('admin API', () => {
  it('lists, exports and locks submissions without login', async () => {
    const agent = request.agent(app);

    // Create two submissions to export
    for (const site of ['HA02', 'HA06']) {
      await request(app).post('/api/public/submit').send({
        site_code: site,
        sku: `EXP-${site}`,
        rp_type: 'ND',
        nd_code: 'ND20-SO-Not displayed in small stores',
      });
    }

    const token = await csrf(agent);

    const me = await agent.get('/api/admin/me');
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('admin');

    const list = await agent.get('/api/admin/submissions?exported=no&page=1');
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(2);

    const exportRes = await agent
      .post('/api/admin/export')
      .set('x-csrf-token', token)
      .send({ include_exported: false });
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers['content-type']).toContain('spreadsheetml');

    // Submissions should now be locked
    const listAfter = await agent.get('/api/admin/submissions?exported=yes&page=1');
    expect(Number(listAfter.body.total)).toBeGreaterThanOrEqual(2);
  });

  it('returns submission summary counts', async () => {
    const agent = request.agent(app);
    const res = await agent.get('/api/admin/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: expect.any(Number),
      normal: {
        total: expect.any(Number),
        exported: expect.any(Number),
        today: expect.any(Number),
        today_exported: expect.any(Number),
      },
      urgent: {
        total: expect.any(Number),
        exported: expect.any(Number),
        today: expect.any(Number),
        today_exported: expect.any(Number),
      },
    });
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.total).toBe(res.body.normal.total + res.body.urgent.total);
  });

  it('requires CSRF token for admin mutations', async () => {
    const agent = request.agent(app);
    await csrf(agent);
    const res = await agent.post('/api/admin/export').send({});
    expect(res.status).toBe(403);
  });

  it('allows access to the admin API without login', async () => {
    const res = await request(app).get('/api/admin/submissions');
    expect(res.status).toBe(200);
  });

  it('downloads the template workbook', async () => {
    const agent = request.agent(app);
    await csrf(agent);
    const res = await agent.get('/api/admin/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
  });

  it('imports a valid xlsx and creates per-row application numbers', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', '110001', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    ws.addRow(['HA06', '110002', 'RF', '5', '', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await agent
      .post('/api/admin/import')
      .set('x-csrf-token', token)
      .attach('file', buffer, 'test-import.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].application_no).toMatch(/^NDRF-/);
    expect(res.body.rows[0].site_code).toBe('HA02');
    expect(res.body.rows[1].site_code).toBe('HA06');
  });

  it('rejects an import with an invalid site code without writing anything', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);

    const before = await agent.get('/api/admin/submissions?page=1&page_size=1');
    const beforeTotal = before.body.total;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['ZZ99', '110003', '', '', '', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await agent
      .post('/api/admin/import')
      .set('x-csrf-token', token)
      .attach('file', buffer, 'bad-import.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.length).toBeGreaterThan(0);

    const after = await agent.get('/api/admin/submissions?page=1&page_size=1');
    expect(after.body.total).toBe(beforeTotal);
  });

  it('rejects non-xlsx uploads', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    const res = await agent
      .post('/api/admin/import')
      .set('x-csrf-token', token)
      .attach('file', Buffer.from('not an excel'), 'bad.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('.xlsx');
  });
});

describe('urgent public API', () => {
  it('accepts a valid urgent submission', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-VALID-1',
      qty: 10,
      urgent_reason: '1',
    });
    expect(res.status).toBe(201);
    expect(res.body.submission.application_no).toMatch(/^URGENT-[A-Z2-9]{8}-[A-Z2-9]{8}$/);
    expect(res.body.submission.submission_type).toBe('urgent');
    expect(res.body.submission.qty).toBe(10);
    expect(res.body.submission.urgent_reason).toBe('1');
    expect(res.body.submission.urgent_reason_label).toContain('客人訂購');
    expect(res.body.submission.locked).toBe(false);
  });

  it('accepts option 9 with other reason', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-OTHER-1',
      qty: 5,
      urgent_reason: '9',
      urgent_reason_other: '臨時加單',
    });
    expect(res.status).toBe(201);
    expect(res.body.submission.urgent_reason).toBe('9');
    expect(res.body.submission.urgent_reason_other).toBe('臨時加單');
  });

  it('rejects urgent submit without reason', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-NOREASON',
      qty: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('urgent_reason');
  });

  it('rejects urgent option 9 without other reason', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-NOOTHER',
      qty: 5,
      urgent_reason: '9',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('urgent_reason_other');
  });

  it('rejects urgent non-9 with other reason', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-BADOTHER',
      qty: 5,
      urgent_reason: '2',
      urgent_reason_other: '不應填寫',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('urgent_reason_other');
  });

  it('rejects urgent qty 0', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-ZERO',
      qty: 0,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('qty');
  });

  it('rejects urgent qty over 1000', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-OVER',
      qty: 1001,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('qty');
  });

  it('rejects decimal urgent qty', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-DEC',
      qty: 1.5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('qty');
  });

  it('rejects missing urgent sku', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '',
      qty: 5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('sku');
  });

  it('rejects urgent submit with unknown site code', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'ZZ99',
      sku: 'U-BAD',
      qty: 5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('site_code');
  });

  it('exposes urgent submissions to the public lookup', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-LOOKUP-1',
      qty: 4,
      urgent_reason: '9',
      urgent_reason_other: 'roadshow 加單',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).get(`/api/public/query?application_no=${no}&site_code=HA02`);
    expect(res.status).toBe(200);
    expect(res.body.submission.submission_type).toBe('urgent');
    expect(res.body.submission.qty).toBe(4);
    expect(res.body.submission.urgent_reason).toBe('9');
    expect(res.body.submission.urgent_reason_label).toContain('其他');
    expect(res.body.submission.urgent_reason_other).toBe('roadshow 加單');
    expect(res.body.submission.requested_by_email).toBe('ha02@sasa.com');
    expect(res.body.submission.application_date).toBeTruthy();
    expect(res.body.versions).toHaveLength(1);
  });

  it('does not reveal urgent submissions to the public lookup without the matching site code', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-LOOKUP-WRONG-SITE',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).get(`/api/public/query?application_no=${no}&site_code=HA06`);
    expect(res.status).toBe(404);
  });

  it('modifies an urgent submission within the window', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-MODIFY-1',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: 'U-MODIFY-2',
      qty: 7,
      urgent_reason: '9',
      urgent_reason_other: '改單加量',
    });
    expect(res.status).toBe(200);
    expect(res.body.submission.sku).toBe('U-MODIFY-2');
    expect(res.body.submission.qty).toBe(7);
    expect(res.body.submission.urgent_reason).toBe('9');
    expect(res.body.submission.urgent_reason_other).toBe('改單加量');

    const queried = await request(app).get(`/api/public/query?application_no=${no}&site_code=HA02`);
    expect(queried.body.submission.qty).toBe(7);
    expect(queried.body.versions).toHaveLength(2);
  });

  it('rejects public modify of an urgent submission when the window is closed', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-MODIFY-CLOSED',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    timeSpy.mockReturnValue(14 * 60 + 30);
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: 'U-MODIFY-CLOSED',
      qty: 5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('14:30');
    timeSpy.mockReturnValue(9 * 60);
  });

  it('still allows querying an urgent submission when the window is closed', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-QUERY-CLOSED',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    timeSpy.mockReturnValue(23 * 60 + 59);
    const res = await request(app).get(`/api/public/query?application_no=${no}&site_code=HA02`);
    expect(res.status).toBe(200);
    expect(res.body.submission.qty).toBe(4);
    timeSpy.mockReturnValue(9 * 60);
  });

  it('rejects urgent modify with invalid qty', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-MODIFY-BAD-QTY',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: 'U-MODIFY-BAD-QTY',
      qty: 1001,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('qty');
  });

  it('rejects urgent modify with reason 9 and no other reason', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-MODIFY-BAD-REASON',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: 'U-MODIFY-BAD-REASON',
      qty: 5,
      urgent_reason: '9',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('urgent_reason_other');
  });

  it('rejects urgent modify to a SKU already submitted today by the same site', async () => {
    await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-DUP-TARGET',
      qty: 2,
      urgent_reason: '1',
    });
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-DUP-SOURCE',
      qty: 3,
      urgent_reason: '2',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: 'U-DUP-TARGET',
      qty: 3,
      urgent_reason: '2',
    });
    expect(res.status).toBe(409);
    expect(res.body.field).toBe('sku');
  });

  it('rejects urgent modify after the submission is locked', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-MODIFY-LOCKED',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    await db.query('UPDATE submissions SET locked_at = now(), exported_at = now() WHERE application_no = $1', [no]);
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: 'U-MODIFY-LOCKED',
      qty: 5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('鎖定');
  });

  it('downloads the urgent template workbook', async () => {
    const res = await request(app).get('/api/public/urgent/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
  });

  it('imports a valid urgent xlsx and creates URGENT application numbers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', 'U-IMP-1', 2, '1', '']);
    ws.addRow(['HA06', 'U-IMP-2', 999, '9', 'roadshow 加單']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-import.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(2);
    expect(res.body.rows[0].application_no).toMatch(/^URGENT-/);
    expect(res.body.rows[1].qty).toBe(999);
    expect(res.body.rows[1].urgent_reason).toBe('9');
    expect(res.body.rows[1].urgent_reason_other).toBe('roadshow 加單');
  });

  it('downloads the urgent import record workbook from just-imported rows', async () => {
    const res = await request(app)
      .post('/api/public/urgent/import/record')
      .send({
        rows: [
          {
            row: 2,
            application_no: 'URGENT-00000000-00000000',
            site_code: 'HA02',
            sku: 'U-IMP-1',
            qty: 2,
            urgent_reason: '1',
            urgent_reason_other: '',
            submitted_at: '2026-08-03 09:00:00',
          },
          {
            row: 3,
            application_no: 'URGENT-00000000-00000001',
            site_code: 'HA06',
            sku: 'U-IMP-2',
            qty: 999,
            urgent_reason: '9',
            urgent_reason_other: 'roadshow 加單',
            submitted_at: '2026-08-03 09:00:01',
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
    expect(res.headers['content-disposition']).toContain('Urgent_Import_Record');
  });

  it('rejects an urgent import record request with empty rows', async () => {
    const res = await request(app).post('/api/public/urgent/import/record').send({ rows: [] });
    expect(res.status).toBe(400);
  });

  it('imports an urgent xlsx using the template dropdown label and stores its code', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', 'U-IMP-LABEL', 3, '1. 客人訂購 (RP Team定期隨機抽查核實)', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-label.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.rows[0].urgent_reason).toBe('1');
  });

  it('rejects an urgent import with invalid qty without writing anything', async () => {
    const before = await request(app).get('/api/admin/submissions?submission_type=urgent&page=1&page_size=1');
    const beforeTotal = before.body.total;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', 'U-BADQTY', 1001, '1', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-bad.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.length).toBeGreaterThan(0);

    const after = await request(app).get('/api/admin/submissions?submission_type=urgent&page=1&page_size=1');
    expect(after.body.total).toBe(beforeTotal);
  });

  it('rejects an urgent import with missing reason without writing anything', async () => {
    const before = await request(app).get('/api/admin/submissions?submission_type=urgent&page=1&page_size=1');
    const beforeTotal = before.body.total;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', 'U-BADREASON', 5, '', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-bad-reason.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.some((e: { field: string }) => e.field === 'Urgent Reason')).toBe(true);

    const after = await request(app).get('/api/admin/submissions?submission_type=urgent&page=1&page_size=1');
    expect(after.body.total).toBe(beforeTotal);
  });

  it('rejects an urgent import using the wrong sheet', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow(['HA02', 'U-WRONG', 5]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-wrong-sheet.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.[0]?.field).toBe('sheet');
  });
});

describe('urgent admin API', () => {
  async function urgentAdminAgent() {
    const agent = request.agent(app);
    const token = await csrf(agent);
    return { agent, token };
  }

  it('filters submissions by submission_type=urgent', async () => {
    await request(app).post('/api/public/urgent/submit').send({ site_code: 'HA02', sku: 'U-FILTER-1', qty: 5, urgent_reason: '1' });
    const { agent } = await urgentAdminAgent();
    const res = await agent.get('/api/admin/submissions?submission_type=urgent&page=1');
    expect(res.status).toBe(200);
    expect(res.body.submissions.length).toBeGreaterThan(0);
    expect(res.body.submissions.every((s: { submission_type: string }) => s.submission_type === 'urgent')).toBe(true);
  });

  it('admin edits urgent sku/qty/reason and rejects out-of-range qty', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-EDIT-1',
      qty: 7,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [no]);
    const id = idRes.rows[0]!.id;

    const { agent, token } = await urgentAdminAgent();
    const res = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: 'U-EDIT-2', qty: 12, urgent_reason: '2' });
    expect(res.status).toBe(200);
    expect(res.body.submission.sku).toBe('U-EDIT-2');
    expect(res.body.submission.qty).toBe(12);
    expect(res.body.submission.urgent_reason).toBe('2');

    const bad = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: 'U-EDIT-2', qty: 1001, urgent_reason: '2' });
    expect(bad.status).toBe(400);

    const noReason = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: 'U-EDIT-2', qty: 12, urgent_reason: '' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.field).toBe('urgent_reason');
  });

  it('admin can complete a reason on a legacy blank urgent row', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-LEGACY-1',
      qty: 6,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    await db.query(
      `UPDATE submissions SET urgent_reason = NULL, urgent_reason_other = NULL WHERE application_no = $1`,
      [no],
    );
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [no]);
    const id = idRes.rows[0]!.id;

    const { agent, token } = await urgentAdminAgent();
    const res = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: 'U-LEGACY-1', qty: 6, urgent_reason: '9', urgent_reason_other: '補回原因' });
    expect(res.status).toBe(200);
    expect(res.body.submission.urgent_reason).toBe('9');
    expect(res.body.submission.urgent_reason_other).toBe('補回原因');
  });

  it('urgent export locks urgent only; SAP export excludes urgent', async () => {
    await request(app).post('/api/public/urgent/submit').send({ site_code: 'HA06', sku: 'U-EXP-1', qty: 3, urgent_reason: '1' });
    const { agent, token } = await urgentAdminAgent();

    const sap = await agent
      .post('/api/admin/export')
      .set('x-csrf-token', token)
      .send({ include_exported: false });
    expect(sap.status).toBe(200);
    expect(sap.headers['content-type']).toContain('spreadsheetml');

    const stillPending = await agent.get('/api/admin/submissions?submission_type=urgent&exported=no&page=1');
    expect(Number(stillPending.body.total)).toBeGreaterThanOrEqual(1);

    const res = await agent
      .post('/api/admin/urgent/export')
      .set('x-csrf-token', token)
      .send({ include_exported: false });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');

    const exported = await agent.get('/api/admin/submissions?submission_type=urgent&exported=yes&page=1');
    expect(Number(exported.body.total)).toBeGreaterThanOrEqual(1);
  });
});

describe('daily duplicate rule', () => {
  const ND = { rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' };

  it('blocks a second normal submission for the same site+sku on the same day', async () => {
    const first = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: 'DUP-001', ...ND });
    expect(first.status).toBe(201);
    const dup = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: 'DUP-001', ...ND });
    expect(dup.status).toBe(409);
    expect(dup.body.field).toBe('sku');
  });

  it('allows the same sku on a different site code', async () => {
    const res = await request(app).post('/api/public/submit').send({ site_code: 'HA06', sku: 'DUP-001', ...ND });
    expect(res.status).toBe(201);
  });

  it('allows the same site+sku once for normal and once for urgent, but not urgent twice', async () => {
    const urgent = await request(app).post('/api/public/urgent/submit').send({ site_code: 'HA02', sku: 'DUP-001', qty: 5, urgent_reason: '1' });
    expect(urgent.status).toBe(201);
    const urgentDup = await request(app).post('/api/public/urgent/submit').send({ site_code: 'HA02', sku: 'DUP-001', qty: 6, urgent_reason: '2' });
    expect(urgentDup.status).toBe(409);
    expect(urgentDup.body.field).toBe('sku');
  });

  it('blocks modify changing sku to one already submitted today, allows a new sku', async () => {
    const a = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: 'DUP-MOD-1', ...ND });
    await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: 'DUP-MOD-2', ...ND });
    const no = a.body.submission.application_no;

    const blocked = await request(app)
      .post('/api/public/modify')
      .send({ application_no: no, site_code: 'HA02', sku: 'DUP-MOD-2', ...ND });
    expect(blocked.status).toBe(409);

    const ok = await request(app)
      .post('/api/public/modify')
      .send({ application_no: no, site_code: 'HA02', sku: 'DUP-MOD-3', ...ND });
    expect(ok.status).toBe(200);
    expect(ok.body.submission.sku).toBe('DUP-MOD-3');
  });

  it('rejects a public import row duplicating an existing today submission without writing', async () => {
    await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: 'DUP-IMP-1', ...ND });
    const before = await request(app).get('/api/admin/submissions?page=1&page_size=1');
    const beforeTotal = before.body.total;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', 'DUP-IMP-1', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app).post('/api/public/import').attach('file', buffer, 'dup-import.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.some((e: { field: string }) => e.field === 'SKU')).toBe(true);

    const after = await request(app).get('/api/admin/submissions?page=1&page_size=1');
    expect(after.body.total).toBe(beforeTotal);
  });

  it('rejects a public import file with duplicate rows inside the file without writing', async () => {
    const before = await request(app).get('/api/admin/submissions?page=1&page_size=1');
    const beforeTotal = before.body.total;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', 'DUP-IMP-2', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    ws.addRow(['HA02', 'DUP-IMP-2', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app).post('/api/public/import').attach('file', buffer, 'dup-inline.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.length).toBeGreaterThan(0);

    const after = await request(app).get('/api/admin/submissions?page=1&page_size=1');
    expect(after.body.total).toBe(beforeTotal);
  });

  it('allows admin import of rows duplicating existing today submissions (exempt)', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', 'DUP-001', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    ws.addRow(['HA02', 'DUP-001', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await agent
      .post('/api/admin/import')
      .set('x-csrf-token', token)
      .attach('file', buffer, 'admin-dup.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(2);
  });

  it('allows admin edit to change sku to a duplicate combination (exempt)', async () => {
    const a = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: 'DUP-ADM-1', ...ND });
    await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: 'DUP-ADM-2', ...ND });
    const no = a.body.submission.application_no;
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [no]);
    const id = idRes.rows[0]!.id;

    const agent = request.agent(app);
    const token = await csrf(agent);
    const res = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: 'DUP-ADM-2', ...ND });
    expect(res.status).toBe(200);
    expect(res.body.submission.sku).toBe('DUP-ADM-2');
  });

  it('allows re-submission on the next day', async () => {
    await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: 'DUP-NEXT-1', ...ND });
    await db.query(
      `UPDATE submissions SET application_date = application_date - 1
       WHERE site_code = 'HA02' AND sku = 'DUP-NEXT-1' AND submission_type = 'normal'`,
    );
    const res = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: 'DUP-NEXT-1', ...ND });
    expect(res.status).toBe(201);
  });
});

describe('urgent submission window (14:30 cutoff)', () => {
  const DEFAULT_MINUTES = 9 * 60;
  const ND = { rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' };

  afterEach(() => {
    timeSpy.mockReturnValue(DEFAULT_MINUTES);
  });

  it('accepts urgent submit at 14:29', async () => {
    timeSpy.mockReturnValue(14 * 60 + 29);
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-WINDOW-OPEN',
      qty: 5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(201);
  });

  it('rejects urgent submit at 14:30', async () => {
    timeSpy.mockReturnValue(14 * 60 + 30);
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-WINDOW-CLOSED',
      qty: 5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBeNull();
    expect(res.body.error).toContain('14:30');
  });

  it('rejects urgent submit at 23:59 and accepts it again the next morning', async () => {
    timeSpy.mockReturnValue(23 * 60 + 59);
    const closed = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-WINDOW-EOD',
      qty: 5,
      urgent_reason: '1',
    });
    expect(closed.status).toBe(400);

    timeSpy.mockReturnValue(0);
    const reopened = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: 'U-WINDOW-EOD',
      qty: 5,
      urgent_reason: '1',
    });
    expect(reopened.status).toBe(201);
  });

  it('rejects urgent import at 14:30 without writing rows', async () => {
    const before = await request(app).get('/api/admin/submissions?page=1&page_size=1');
    const beforeTotal = before.body.total;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', 'U-WINDOW-IMP', 2, '1', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    timeSpy.mockReturnValue(14 * 60 + 30);
    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-window.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('14:30');

    const after = await request(app).get('/api/admin/submissions?page=1&page_size=1');
    expect(after.body.total).toBe(beforeTotal);
  });

  it('still accepts normal submissions after 14:30', async () => {
    timeSpy.mockReturnValue(23 * 60 + 59);
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '110011',
      ...ND,
    });
    expect(res.status).toBe(201);
  });

  it('reports the window status via /urgent/window', async () => {
    timeSpy.mockReturnValue(23 * 60 + 59);
    const closed = await request(app).get('/api/public/urgent/window');
    expect(closed.status).toBe(200);
    expect(closed.body.open).toBe(false);
    expect(closed.body.cutoff).toBe('14:30');
    expect(closed.body.message).toContain('14:30');

    timeSpy.mockReturnValue(10 * 60);
    const open = await request(app).get('/api/public/urgent/window');
    expect(open.body.open).toBe(true);
  });
});
