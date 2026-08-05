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
import { cleanupExpiredExportFiles } from '../src/services/exportFiles.js';
import { TEMPLATE_COLUMNS, RP_TEAM_SHEET, SHOP_CODE_HEADER, URGENT_COLUMNS, URGENT_SHEET, SALES_COLUMNS, SALES_SHEET, RETURN_COLUMNS, RETURN_SHEET } from '../src/lib/fields.js';
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

async function adminLogin(agent: ReturnType<typeof request.agent>): Promise<void> {
  const token = await csrf(agent);
  const res = await agent
    .post('/api/admin/login')
    .set('x-csrf-token', token)
    .send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
}

async function countSubmissions(where = ''): Promise<number> {
  const res = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM submissions ${where}`);
  return Number(res.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting(makePglitePool(db));
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql'];
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

  it('supports return-goods schedule and single submission with duplicate protection', async () => {
    const schedule = await request(app).get('/api/public/return/schedule');
    expect(schedule.status).toBe(200);
    expect(schedule.body.windows).toHaveLength(12);
    expect(schedule.body.open).toBe(true);

    const payload = {
      site_code: 'HA02', sku: '1008001', qty: 8, reason: '1', confirmer_name: '確認人', confirmer_phone: '電話文字',
    };
    const created = await request(app).post('/api/public/return/submit').send(payload);
    expect(created.status).toBe(201);
    expect(created.body.submission.application_no).toMatch(/^RETURN-/);
    expect(created.body.submission.return_reason).toBe('1');
    expect(created.body.submission.return_qty).toBe(8);

    const duplicate = await request(app).post('/api/public/return/submit').send(payload);
    expect(duplicate.status).toBe(409);

    const queried = await request(app).get(`/api/public/query?application_no=${created.body.submission.application_no}&site_code=HA02`);
    expect(queried.status).toBe(200);
    expect(queried.body.submission.submission_type).toBe('return');
    expect(queried.body.submission.return_window_open).toBe(true);

    const modified = await request(app).post('/api/public/modify').send({
      application_no: created.body.submission.application_no, site_code: 'HA02', sku: '1008002', return_qty: 9,
      return_reason: '2', return_confirmer_name: '新確認人', return_confirmer_phone: '新電話',
    });
    expect(modified.status).toBe(200);
    expect(modified.body.submission.return_qty).toBe(9);
    await db.query(`DELETE FROM submissions WHERE submission_type = 'return'`);
  });

  it('downloads the return template and imports return rows', async () => {
    const template = await request(app).get('/api/public/return/template');
    expect(template.status).toBe(200);
    expect(template.headers['content-type']).toContain('spreadsheetml');

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RETURN_SHEET);
    ws.addRow([...RETURN_COLUMNS]);
    ws.addRow(['HA02', '1008003', 4, '3. BUYER 電郵確認可退-壞貨', '確認人', '電話']);
    const imported = await request(app).post('/api/public/return/import').attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'return.xlsx');
    expect(imported.status).toBe(201);
    expect(imported.body.rows[0].application_no).toMatch(/^RETURN-/);
    expect(imported.body.rows[0].reason).toBe('3');
    await db.query(`DELETE FROM submissions WHERE submission_type = 'return'`);
  });

  it('rejects submit with unknown site code', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'ZZ99',
      sku: '1000123',
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

  it('rejects submit with multiple comma-separated SKUs', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '123456789012 , 123456789011',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('sku');
    expect(res.body.error).toContain('7 位或 12 位');
  });

  it('rejects submit with SKU of invalid length or characters', async () => {
    for (const sku of ['123456', '1234567890', 'ABC1234567', '1234567890123']) {
      const res = await request(app).post('/api/public/submit').send({
        site_code: 'HA02',
        sku,
        rp_type: 'ND',
        nd_code: 'ND20-SO-Not displayed in small stores',
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('sku');
    }
  });

  it('accepts submit with 7-digit and 12-digit SKUs', async () => {
    const seven = await request(app).post('/api/public/submit').send({
      site_code: 'HA06',
      sku: '1008001',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
    });
    expect(seven.status).toBe(201);
    expect(seven.body.submission.sku).toBe('1008001');

    const twelve = await request(app).post('/api/public/submit').send({
      site_code: 'HA06',
      sku: '110079623001',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
    });
    expect(twelve.status).toBe(201);
    expect(twelve.body.submission.sku).toBe('110079623001');
  });

  it('rejects submit with missing RP Type', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '1000001',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('rp_type');
  });

  it('rejects ND submit without ND Code', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '1000002',
      rp_type: 'ND',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('nd_code');
  });

  it('rejects RF submit without Safety stock', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '1000003',
      rp_type: 'RF',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('safety_stock');
  });

  it('rejects RF submit with Safety stock not greater than 0', async () => {
    for (const safetyStock of ['0', '-5', 'abc']) {
      const res = await request(app).post('/api/public/submit').send({
        site_code: 'HA02',
        sku: '1000004',
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
      sku: '1000005',
      rp_type: 'RF',
      safety_stock: '3.5',
    });
    expect(res.status).toBe(201);
  });

  it('rejects RF submit for a listed store without Remark', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA19',
      sku: '1000006',
      rp_type: 'RF',
      safety_stock: '5',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('remark');
  });

  it('accepts RF submit for a listed store with Remark', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HBA7',
      sku: '1000007',
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

  it('replays a single web submission after a lost response', async () => {
    const key = 'normal-retry-test-key';
    const payload = {
      site_code: 'HA19',
      sku: '1008999',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
    };
    const first = await request(app).post('/api/public/submit').set('Idempotency-Key', key).send(payload);
    expect(first.status).toBe(201);
    const retry = await request(app).post('/api/public/submit').set('Idempotency-Key', key).send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.submission.application_no).toBe(first.body.submission.application_no);
    const stored = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM submissions WHERE idempotency_key = $1', [key]);
    expect(stored.rows[0]?.count).toBe('1');
  });
  it('queries a submission with application_no + site_code', async () => {
    const created = await request(app).post('/api/public/submit').send({
      site_code: 'HA06',
      sku: '1000999',
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

  it('serves the separate visual help page and its SVG assets', async () => {
    const page = await request(app).get('/help.html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('跟著圖示，一步一步完成申報');
    expect(page.text).toContain('/images/help/normal-site.svg');

    const image = await request(app).get('/images/help/normal-site.svg');
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toContain('image/svg+xml');
  });
});

  it('rejects oversized Excel uploads with 413 instead of 500', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
    const res = await request(app)
      .post('/api/public/import')
      .attach('file', oversized, 'oversized.xlsx');
    expect(res.status).toBe(413);
    expect(res.body.error).toContain('上載大小');
  });
describe('admin API', () => {
  it('rejects admin API access without login', async () => {
    const res = await request(app).get('/api/admin/submissions');
    expect(res.status).toBe(401);
  });

  it('rejects wrong login credentials', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    const res = await agent
      .post('/api/admin/login')
      .set('x-csrf-token', token)
      .send({ username: 'admin', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('不正確');
  });

  it('logs out and invalidates the session', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);
    const logout = await agent.post('/api/admin/logout').set('x-csrf-token', token);
    expect(logout.status).toBe(200);
    const me = await agent.get('/api/admin/me');
    expect(me.status).toBe(401);
  });

  it('lists, exports and locks submissions after login', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);

    // Create two submissions to export
    for (const [index, site] of ['HA02', 'HA06'].entries()) {
      await request(app).post('/api/public/submit').send({
        site_code: site,
        sku: `100400${index + 1}`,
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
    const batchId = exportRes.headers['x-export-batch-id'];
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/i);
    const archived = await db.query<{ file_size: string; file_data: Buffer | null; expires_at: string }>(
      'SELECT file_size, file_data, expires_at FROM export_batch_files WHERE export_batch_id = $1',
      [batchId],
    );
    expect(Number(archived.rows[0]?.file_size)).toBeGreaterThan(1000);
    expect(archived.rows[0]?.file_data).toBeInstanceOf(Uint8Array);
    expect(new Date(archived.rows[0]!.expires_at).getTime()).toBeGreaterThan(Date.now());

    const recovered = await agent.get(`/api/admin/export-batches/${batchId}/download`).set('x-csrf-token', token);
    expect(recovered.status).toBe(200);
    expect(recovered.headers['content-type']).toContain('spreadsheetml');
    expect(Number(recovered.headers['content-length'])).toBe(Number(archived.rows[0]!.file_size));

    await db.query('UPDATE export_batch_files SET expires_at = now() - interval \'1 day\' WHERE export_batch_id = $1', [batchId]);
    expect(await cleanupExpiredExportFiles()).toBeGreaterThanOrEqual(1);
    const expired = await agent.get(`/api/admin/export-batches/${batchId}/download`).set('x-csrf-token', token);
    expect(expired.status).toBe(410);

    // Submissions should now be locked
    const listAfter = await agent.get('/api/admin/submissions?exported=yes&page=1');
    expect(Number(listAfter.body.total)).toBeGreaterThanOrEqual(2);
    const locked = listAfter.body.submissions.find((submission: { submission_type: string; locked: boolean }) => submission.submission_type === 'normal' && submission.locked);
    expect(locked).toBeDefined();
    const lockedEdit = await agent
      .put(`/api/admin/submissions/${locked.id}`)
      .set('x-csrf-token', token)
      .send({ sku: '1009120', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    expect(lockedEdit.status).toBe(409);
  });

  it('rebuilds a legacy export batch that has no archived binary', async () => {
    const created = await request(app).post('/api/public/submit').send({
      site_code: 'HBA7',
      sku: '1009131',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
    });
    expect(created.status).toBe(201);
    const batch = await db.query<{ id: string }>(
      `INSERT INTO export_batches (filename, submission_count, submission_nos, filters, created_by)
       VALUES ($1, 1, $2::jsonb, $3::jsonb, $4)
       RETURNING id`,
      ['Legacy_Export.xlsx', JSON.stringify([created.body.submission.application_no]), JSON.stringify({}), 'admin'],
    );
    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);
    const res = await agent.get(`/api/admin/export-batches/${batch.rows[0]!.id}/download`).set('x-csrf-token', token);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });

  describe('preview export & last_modified_at (shared admin session)', () => {
    let agent: ReturnType<typeof request.agent>;
    beforeAll(async () => {
      agent = request.agent(app);
      await adminLogin(agent);
    });

    it('derives last_modified_at from version history (null until modified)', async () => {
      const created = await request(app).post('/api/public/submit').send({
        site_code: 'HA02',
        sku: '1004101',
        rp_type: 'ND',
        nd_code: 'ND20-SO-Not displayed in small stores',
      });
      const no = created.body.submission.application_no;

      const before = await agent.get(`/api/admin/submissions?application_no=${no}&page=1`);
      expect(before.status).toBe(200);
      const rowBefore = before.body.submissions.find((s) => s.application_no === no);
      expect(rowBefore.last_modified_at).toBeNull();

      const modify = await request(app).post('/api/public/modify').send({
        application_no: no,
        site_code: 'HA02',
        sku: '1004102',
        rp_type: 'ND',
        nd_code: 'ND20-SO-Not displayed in small stores',
      });
      expect(modify.status).toBe(200);

      const after = await agent.get(`/api/admin/submissions?application_no=${no}&page=1`);
      const rowAfter = after.body.submissions.find((s) => s.application_no === no);
      expect(rowAfter.last_modified_at).not.toBeNull();

      const versionRes = await db.query<{ changed_at: string }>(
        `SELECT v.changed_at FROM submission_versions v
         JOIN submissions s ON s.id = v.submission_id
         WHERE s.application_no = $1 AND v.version = 2`,
        [no],
      );
      expect(versionRes.rows[0]).toBeDefined();
    });

    it('preview export downloads without locking or writing batches', async () => {
      await request(app).post('/api/public/submit').send({
        site_code: 'HA06',
        sku: '1004103',
        rp_type: 'ND',
        nd_code: 'ND20-SO-Not displayed in small stores',
      });

      const token = await csrf(agent);

      const pendingBefore = await countSubmissions('WHERE exported_at IS NULL');
      const batchesBefore = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM export_batches');

      const preview = await agent
        .post('/api/admin/export')
        .set('x-csrf-token', token)
        .send({ include_exported: false, preview: true });
      expect(preview.status).toBe(200);
      expect(preview.headers['content-type']).toContain('spreadsheetml');
      expect(preview.headers['content-disposition']).toContain('Preview');

      const pendingAfter = await countSubmissions('WHERE exported_at IS NULL');
      expect(Number(pendingAfter)).toBe(Number(pendingBefore));

      const batchesAfter = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM export_batches');
      expect(Number(batchesAfter.rows[0]!.count)).toBe(Number(batchesBefore.rows[0]!.count));
    });

    it('previewed submission remains modifiable by the applicant', async () => {
      const created = await request(app).post('/api/public/submit').send({
        site_code: 'HA06',
        sku: '1004104',
        rp_type: 'ND',
        nd_code: 'ND20-SO-Not displayed in small stores',
      });
      const no = created.body.submission.application_no;

      const token = await csrf(agent);

      const preview = await agent
        .post('/api/admin/export')
        .set('x-csrf-token', token)
        .send({ preview: true });
      expect(preview.status).toBe(200);

      const modify = await request(app).post('/api/public/modify').send({
        application_no: no,
        site_code: 'HA06',
        sku: '1004105',
        rp_type: 'ND',
        nd_code: 'ND20-SO-Not displayed in small stores',
      });
      expect(modify.status).toBe(200);
      expect(modify.body.submission.sku).toBe('1004105');
    });
  });

  it('returns submission summary counts', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);
    const res = await agent.get('/api/admin/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: expect.any(Number),
      stores_today: expect.any(Number),
      normal: {
        total: expect.any(Number),
        exported: expect.any(Number),
        today: expect.any(Number),
        today_exported: expect.any(Number),
        stores_today: expect.any(Number),
      },
      urgent: {
        total: expect.any(Number),
        exported: expect.any(Number),
        today: expect.any(Number),
        today_exported: expect.any(Number),
        stores_today: expect.any(Number),
      },
      sales: {
        total: expect.any(Number),
        exported: expect.any(Number),
        today: expect.any(Number),
        today_exported: expect.any(Number),
        stores_today: expect.any(Number),
      },
      return: {
        total: expect.any(Number),
        exported: expect.any(Number),
        today: expect.any(Number),
        today_exported: expect.any(Number),
        stores_today: expect.any(Number),
      },
    });
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.total).toBe(res.body.normal.total + res.body.urgent.total + res.body.sales.total + res.body.return.total);
  });

  it('counts distinct stores involved today without double-counting a store', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);
    const before = await agent.get('/api/admin/summary');
    expect(before.status).toBe(200);

    const submit = (site_code: string, sku: string) =>
      request(app).post('/api/public/submit').send({
        site_code,
        sku,
        rp_type: 'ND',
        nd_code: 'ND20-SO-Not displayed in small stores',
      });
    const one = await submit('HA02', '1004106');
    const two = await submit('HA02', '1004107');
    const three = await submit('HA19', '1004108');
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(three.status).toBe(201);

    const after = await agent.get('/api/admin/summary');
    expect(after.status).toBe(200);
    expect(after.body.stores_today).toBeGreaterThanOrEqual(before.body.stores_today);
    expect(after.body.normal.today).toBeGreaterThanOrEqual(before.body.normal.today);
    expect(after.body.normal.stores_today).toBeGreaterThanOrEqual(before.body.normal.stores_today);
  });

  it('requires CSRF token for admin mutations', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);
    const res = await agent.post('/api/admin/export').send({});
    expect(res.status).toBe(403);
  });

  it('downloads the template workbook', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);
    const res = await agent.get('/api/admin/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
  });

  it('imports a valid xlsx and creates per-row application numbers', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', '1000001', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    ws.addRow(['HA06', '1000002', 'RF', '5', '', '']);
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
    await adminLogin(agent);
    const token = await csrf(agent);

    const beforeTotal = await countSubmissions();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['ZZ99', '1000003', '', '', '', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await agent
      .post('/api/admin/import')
      .set('x-csrf-token', token)
      .attach('file', buffer, 'bad-import.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.length).toBeGreaterThan(0);

    expect(await countSubmissions()).toBe(beforeTotal);
  });

  it('rejects non-xlsx uploads', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);
    const res = await agent
      .post('/api/admin/import')
      .set('x-csrf-token', token)
      .attach('file', Buffer.from('not an excel'), 'bad.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('.xlsx');

    const stores = await agent
      .put('/api/admin/stores')
      .set('x-csrf-token', token)
      .attach('file', Buffer.from('not csv'), 'stores.txt');
    expect(stores.status).toBe(400);
    expect(stores.body.error).toContain('.csv');
  });
});

describe('urgent public API', () => {
  it('accepts a valid urgent submission', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006029',
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
      sku: '1006026',
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
      sku: '1006025',
      qty: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('urgent_reason');
  });

  it('rejects urgent option 9 without other reason', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006024',
      qty: 5,
      urgent_reason: '9',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('urgent_reason_other');
  });

  it('rejects urgent non-9 with other reason', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006003',
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
      sku: '1006033',
      qty: 0,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('qty');
  });

  it('rejects urgent qty over 1000', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006027',
      qty: 1001,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('qty');
  });

  it('rejects decimal urgent qty', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006004',
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

  it('rejects urgent submit with an invalid SKU format', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '123456789012 , 123456789011',
      qty: 5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('sku');
  });

  it('rejects urgent submit with unknown site code', async () => {
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'ZZ99',
      sku: '1006002',
      qty: 5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('site_code');
  });

  it('exposes urgent submissions to the public lookup', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006016',
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
      sku: '1006017',
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
      sku: '1006018',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: '1006019',
      qty: 7,
      urgent_reason: '9',
      urgent_reason_other: '改單加量',
    });
    expect(res.status).toBe(200);
    expect(res.body.submission.sku).toBe('1006019');
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
      sku: '1006022',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    timeSpy.mockReturnValue(14 * 60 + 30);
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: '1006022',
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
      sku: '1006028',
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
      sku: '1006020',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: '1006020',
      qty: 1001,
      urgent_reason: '1',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('qty');
  });

  it('rejects urgent modify with reason 9 and no other reason', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006021',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: '1006021',
      qty: 5,
      urgent_reason: '9',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('urgent_reason_other');
  });

  it('rejects urgent modify to a SKU already submitted today by the same site', async () => {
    await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006006',
      qty: 2,
      urgent_reason: '1',
    });
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006005',
      qty: 3,
      urgent_reason: '2',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: '1006006',
      qty: 3,
      urgent_reason: '2',
    });
    expect(res.status).toBe(409);
    expect(res.body.field).toBe('sku');
  });

  it('rejects urgent modify after the submission is locked', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006023',
      qty: 4,
      urgent_reason: '1',
    });
    const no = created.body.submission.application_no;
    await db.query('UPDATE submissions SET locked_at = now(), exported_at = now() WHERE application_no = $1', [no]);
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: '1006023',
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
    ws.addRow(['HA02', '1006011', 2, '1', '']);
    ws.addRow(['HA06', '1006012', 999, '9', 'roadshow 加單']);
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

  it('downloads the urgent import record workbook from a stored batch', async () => {
    const key = 'urgent-record-test-key';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', '1006116', 2, '1', '']);
    ws.addRow(['HA06', '1006117', 999, '9', 'roadshow 加單']);
    const imported = await request(app)
      .post('/api/public/urgent/import')
      .set('Idempotency-Key', key)
      .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'urgent-record.xlsx');
    expect(imported.status).toBe(201);
    const retry = await request(app)
      .post('/api/public/urgent/import')
      .set('Idempotency-Key', key)
      .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'urgent-record.xlsx');
    expect(retry.status).toBe(200);
    expect(retry.body.batchId).toBe(imported.body.batchId);

    const res = await request(app)
      .get(`/api/public/urgent/import/record/${imported.body.batchId}`)
      .set('Idempotency-Key', key);
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
    ws.addRow(['HA02', '1006114', 3, '1. 客人訂購 (RP Team定期隨機抽查核實)', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-label.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.rows[0].urgent_reason).toBe('1');
  });

  it('rejects an urgent import with invalid qty without writing anything', async () => {
    const beforeTotal = await countSubmissions(`WHERE submission_type = 'urgent'`);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', '1006115', 1001, '1', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-bad.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.length).toBeGreaterThan(0);

    expect(await countSubmissions(`WHERE submission_type = 'urgent'`)).toBe(beforeTotal);
  });

  it('rejects an urgent import with missing reason without writing anything', async () => {
    const beforeTotal = await countSubmissions(`WHERE submission_type = 'urgent'`);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', '1006116', 5, '', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-bad-reason.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.some((e: { field: string }) => e.field === 'Urgent Reason')).toBe(true);

    expect(await countSubmissions(`WHERE submission_type = 'urgent'`)).toBe(beforeTotal);
  });

  it('rejects an urgent import using the wrong sheet', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow(['HA02', '1006117', 5]);
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
    await adminLogin(agent);
    const token = await csrf(agent);
    return { agent, token };
  }

  it('filters submissions by submission_type=urgent', async () => {
    await request(app).post('/api/public/urgent/submit').send({ site_code: 'HA02', sku: '1006010', qty: 5, urgent_reason: '1' });
    const { agent } = await urgentAdminAgent();
    const res = await agent.get('/api/admin/submissions?submission_type=urgent&page=1');
    expect(res.status).toBe(200);
    expect(res.body.submissions.length).toBeGreaterThan(0);
    expect(res.body.submissions.every((s: { submission_type: string }) => s.submission_type === 'urgent')).toBe(true);
  });

  it('admin edits urgent sku/qty/reason and rejects out-of-range qty', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006007',
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
      .send({ sku: '1006008', qty: 12, urgent_reason: '2. ROADSHOW' });
    expect(res.status).toBe(200);
    expect(res.body.submission.sku).toBe('1006008');
    expect(res.body.submission.qty).toBe(12);
    expect(res.body.submission.urgent_reason).toBe('2');

    const bad = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: '1006008', qty: 1001, urgent_reason: '2' });
    expect(bad.status).toBe(400);

    const noReason = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: '1006008', qty: 12, urgent_reason: '' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.field).toBe('urgent_reason');
  });

  it('admin can complete a reason on a legacy blank urgent row', async () => {
    const created = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006015',
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
      .send({ sku: '1006015', qty: 6, urgent_reason: '9', urgent_reason_other: '補回原因' });
    expect(res.status).toBe(200);
    expect(res.body.submission.urgent_reason).toBe('9');
    expect(res.body.submission.urgent_reason_other).toBe('補回原因');
  });

  it('urgent export locks urgent only; SAP export excludes urgent', async () => {
    await request(app).post('/api/public/urgent/submit').send({ site_code: 'HA06', sku: '1006009', qty: 3, urgent_reason: '1' });
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

describe('sales public API', () => {
  it('accepts a valid sales submission with SALES prefix', async () => {
    const res = await request(app).post('/api/public/sales/submit').send({
      site_code: 'HA02',
      sku: '1005024',
    });
    expect(res.status).toBe(201);
    expect(res.body.submission.application_no).toMatch(/^SALES-[A-Z2-9]{8}-[A-Z2-9]{8}$/);
    expect(res.body.submission.submission_type).toBe('sales');
    expect(res.body.submission.sku).toBe('1005024');
    expect(res.body.submission.qty).toBeNull();
    expect(res.body.submission.locked).toBe(false);
  });

  it('rejects sales submit with unknown site code', async () => {
    const res = await request(app).post('/api/public/sales/submit').send({
      site_code: 'ZZ99',
      sku: '1005010',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('site_code');
  });

  it('rejects sales submit with missing sku', async () => {
    const res = await request(app).post('/api/public/sales/submit').send({
      site_code: 'HA02',
      sku: '',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('sku');
  });

  it('rejects sales submit with an invalid SKU format', async () => {
    const res = await request(app).post('/api/public/sales/submit').send({
      site_code: 'HA02',
      sku: '12,34',
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('sku');
  });

  it('accepts sales submissions after the urgent 14:30 cutoff (no time limit)', async () => {
    timeSpy.mockReturnValue(23 * 60 + 59);
    const res = await request(app).post('/api/public/sales/submit').send({
      site_code: 'HA02',
      sku: '1005023',
    });
    expect(res.status).toBe(201);
    timeSpy.mockReturnValue(9 * 60);
  });

  it('exposes sales submissions to the public lookup', async () => {
    const created = await request(app).post('/api/public/sales/submit').send({
      site_code: 'HA02',
      sku: '1005017',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).get(`/api/public/query?application_no=${no}&site_code=HA02`);
    expect(res.status).toBe(200);
    expect(res.body.submission.submission_type).toBe('sales');
    expect(res.body.submission.sku).toBe('1005017');
    expect(res.body.submission.requested_by_email).toBe('ha02@sasa.com');
    expect(res.body.versions).toHaveLength(1);
  });

  it('modifies a sales submission sku and records a version', async () => {
    const created = await request(app).post('/api/public/sales/submit').send({
      site_code: 'HA02',
      sku: '1005018',
    });
    const no = created.body.submission.application_no;
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: '1005019',
    });
    expect(res.status).toBe(200);
    expect(res.body.submission.sku).toBe('1005019');
    const queried = await request(app).get(`/api/public/query?application_no=${no}&site_code=HA02`);
    expect(queried.body.submission.sku).toBe('1005019');
    expect(queried.body.versions).toHaveLength(2);
  });

  it('rejects sales modify after the submission is locked', async () => {
    const created = await request(app).post('/api/public/sales/submit').send({
      site_code: 'HA02',
      sku: '1005015',
    });
    const no = created.body.submission.application_no;
    await db.query('UPDATE submissions SET locked_at = now(), exported_at = now() WHERE application_no = $1', [no]);
    const res = await request(app).post('/api/public/modify').send({
      application_no: no,
      site_code: 'HA02',
      sku: '1005016',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('鎖定');
  });

  it('downloads the sales template workbook', async () => {
    const res = await request(app).get('/api/public/sales/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
  });

  it('imports a valid sales xlsx and creates SALES application numbers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SALES_SHEET);
    ws.addRow([...SALES_COLUMNS]);
    ws.addRow(['HA02', '1005013']);
    ws.addRow(['HA06', '1007006']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/sales/import')
      .attach('file', buffer, 'sales-import.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(2);
    expect(res.body.rows[0].application_no).toMatch(/^SALES-/);
    expect(res.body.rows[0].site_code).toBe('HA02');
    expect(res.body.rows[1].site_code).toBe('HA06');
  });

  it('downloads the sales import record workbook from a stored batch', async () => {
    const key = 'sales-record-test-key';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SALES_SHEET);
    ws.addRow([...SALES_COLUMNS]);
    ws.addRow(['HA02', '1007015']);
    const imported = await request(app)
      .post('/api/public/sales/import')
      .set('Idempotency-Key', key)
      .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'sales-record.xlsx');
    expect(imported.status).toBe(201);
    const retry = await request(app)
      .post('/api/public/sales/import')
      .set('Idempotency-Key', key)
      .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'sales-record.xlsx');
    expect(retry.status).toBe(200);
    expect(retry.body.batchId).toBe(imported.body.batchId);

    const res = await request(app)
      .get(`/api/public/sales/import/record/${imported.body.batchId}`)
      .set('Idempotency-Key', key);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
    expect(res.headers['content-disposition']).toContain('Sudden_Sales_Import_Record');
  });
  it('rejects a sales import using the wrong sheet', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow(['HA02', '1007005']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/sales/import')
      .attach('file', buffer, 'sales-wrong-sheet.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.[0]?.field).toBe('sheet');
  });

  it('rejects a sales import with invalid site code without writing anything', async () => {
    const beforeTotal = await countSubmissions(`WHERE submission_type = 'sales'`);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SALES_SHEET);
    ws.addRow([...SALES_COLUMNS]);
    ws.addRow(['ZZ99', '1005010']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/api/public/sales/import')
      .attach('file', buffer, 'sales-bad-site.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.[0]?.field).toBe('Site Code');

    expect(await countSubmissions(`WHERE submission_type = 'sales'`)).toBe(beforeTotal);
  });
});

describe('sales admin API', () => {
  it('filters submissions by submission_type=sales and edits sku', async () => {
    const created = await request(app).post('/api/public/sales/submit').send({
      site_code: 'HA02',
      sku: '1005008',
    });
    const no = created.body.submission.application_no;
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [no]);
    const id = idRes.rows[0]!.id;

    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);

    const list = await agent.get('/api/admin/submissions?submission_type=sales&page=1');
    expect(list.status).toBe(200);
    expect(list.body.submissions.every((s: { submission_type: string }) => s.submission_type === 'sales')).toBe(true);

    const res = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: '1005009' });
    expect(res.status).toBe(200);
    expect(res.body.submission.sku).toBe('1005009');

    const missing = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: '' });
    expect(missing.status).toBe(400);
    expect(missing.body.field).toBe('sku');
  });

  it('sales export locks sales only; SAP export excludes sales', async () => {
    await request(app).post('/api/public/sales/submit').send({ site_code: 'HA06', sku: '1005011' });
    await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '1005012',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
    });
    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);

    const sap = await agent
      .post('/api/admin/export')
      .set('x-csrf-token', token)
      .send({ include_exported: false });
    expect(sap.status).toBe(200);

    const stillPending = await agent.get('/api/admin/submissions?submission_type=sales&exported=no&page=1');
    expect(Number(stillPending.body.total)).toBeGreaterThanOrEqual(1);

    const res = await agent
      .post('/api/admin/sales/export')
      .set('x-csrf-token', token)
      .send({ include_exported: false });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('Sudden_Sales_Export');

    const exported = await agent.get('/api/admin/submissions?submission_type=sales&exported=yes&page=1');
    expect(Number(exported.body.total)).toBeGreaterThanOrEqual(1);
  });
});

describe('daily duplicate rule', () => {
  const ND = { rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' };

  it('blocks a second normal submission for the same site+sku on the same day', async () => {
    const first = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: '1003001', ...ND });
    expect(first.status).toBe(201);
    const dup = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: '1003001', ...ND });
    expect(dup.status).toBe(409);
    expect(dup.body.field).toBe('sku');
  });

  it('allows the same sku on a different site code', async () => {
    const res = await request(app).post('/api/public/submit').send({ site_code: 'HA06', sku: '1003001', ...ND });
    expect(res.status).toBe(201);
  });

  it('allows the same site+sku once for normal and once for urgent, but not urgent twice', async () => {
    const urgent = await request(app).post('/api/public/urgent/submit').send({ site_code: 'HA02', sku: '1003001', qty: 5, urgent_reason: '1' });
    expect(urgent.status).toBe(201);
    const urgentDup = await request(app).post('/api/public/urgent/submit').send({ site_code: 'HA02', sku: '1003001', qty: 6, urgent_reason: '2' });
    expect(urgentDup.status).toBe(409);
    expect(urgentDup.body.field).toBe('sku');
  });

  it('allows the same site+sku for sales alongside normal and urgent, but not sales twice', async () => {
    const normal = await request(app).post('/api/public/submit').send({ site_code: 'HA06', sku: '1003009', ...ND });
    expect(normal.status).toBe(201);
    const urgent = await request(app).post('/api/public/urgent/submit').send({ site_code: 'HA06', sku: '1003009', qty: 5, urgent_reason: '1' });
    expect(urgent.status).toBe(201);
    const sales = await request(app).post('/api/public/sales/submit').send({ site_code: 'HA06', sku: '1003009' });
    expect(sales.status).toBe(201);
    const salesDup = await request(app).post('/api/public/sales/submit').send({ site_code: 'HA06', sku: '1003009' });
    expect(salesDup.status).toBe(409);
    expect(salesDup.body.field).toBe('sku');
  });

  it('blocks sales modify changing sku to one already submitted today, allows a new sku', async () => {
    const a = await request(app).post('/api/public/sales/submit').send({ site_code: 'HA02', sku: '1003011' });
    await request(app).post('/api/public/sales/submit').send({ site_code: 'HA02', sku: '1003012' });
    const no = a.body.submission.application_no;

    const blocked = await request(app)
      .post('/api/public/modify')
      .send({ application_no: no, site_code: 'HA02', sku: '1003012' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.field).toBe('sku');

    const ok = await request(app)
      .post('/api/public/modify')
      .send({ application_no: no, site_code: 'HA02', sku: '1003013' });
    expect(ok.status).toBe(200);
    expect(ok.body.submission.sku).toBe('1003013');
  });

  it('rejects a sales import row duplicating an existing today sales submission without writing', async () => {
    await request(app).post('/api/public/sales/submit').send({ site_code: 'HA02', sku: '1003010' });
    const beforeTotal = await countSubmissions(`WHERE submission_type = 'sales'`);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SALES_SHEET);
    ws.addRow([...SALES_COLUMNS]);
    ws.addRow(['HA02', '1003010']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app).post('/api/public/sales/import').attach('file', buffer, 'sales-dup.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.some((e: { field: string }) => e.field === 'SKU')).toBe(true);

    expect(await countSubmissions(`WHERE submission_type = 'sales'`)).toBe(beforeTotal);
  });

  it('blocks modify changing sku to one already submitted today, allows a new sku', async () => {
    const a = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: '1003005', ...ND });
    await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: '1003006', ...ND });
    const no = a.body.submission.application_no;

    const blocked = await request(app)
      .post('/api/public/modify')
      .send({ application_no: no, site_code: 'HA02', sku: '1003006', ...ND });
    expect(blocked.status).toBe(409);

    const ok = await request(app)
      .post('/api/public/modify')
      .send({ application_no: no, site_code: 'HA02', sku: '1003007', ...ND });
    expect(ok.status).toBe(200);
    expect(ok.body.submission.sku).toBe('1003007');
  });

  it('rejects a public import row duplicating an existing today submission without writing', async () => {
    await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: '1003004', ...ND });
    const beforeTotal = await countSubmissions();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', '1003004', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app).post('/api/public/import').attach('file', buffer, 'dup-import.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.some((e: { field: string }) => e.field === 'SKU')).toBe(true);

    expect(await countSubmissions()).toBe(beforeTotal);
  });

  it('rejects a public import file with duplicate rows inside the file without writing', async () => {
    const beforeTotal = await countSubmissions();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', '1003014', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    ws.addRow(['HA02', '1003014', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app).post('/api/public/import').attach('file', buffer, 'dup-inline.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.length).toBeGreaterThan(0);

    expect(await countSubmissions()).toBe(beforeTotal);
  });

  it('allows admin import of rows duplicating existing today submissions (exempt)', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', '1003001', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    ws.addRow(['HA02', '1003001', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await agent
      .post('/api/admin/import')
      .set('x-csrf-token', token)
      .attach('file', buffer, 'admin-dup.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(2);
  });

  it('allows admin edit to change sku to a duplicate combination (exempt)', async () => {
    const a = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: '1003002', ...ND });
    await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: '1003003', ...ND });
    const no = a.body.submission.application_no;
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [no]);
    const id = idRes.rows[0]!.id;

    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);
    const res = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: '1003003', ...ND });
    expect(res.status).toBe(200);
    expect(res.body.submission.sku).toBe('1003003');
  });

  it('allows re-submission on the next day', async () => {
    await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: '1003008', ...ND });
    await db.query(
      `UPDATE submissions SET application_date = application_date - 1
       WHERE site_code = 'HA02' AND sku = '1003008' AND submission_type = 'normal'`,
    );
    const res = await request(app).post('/api/public/submit').send({ site_code: 'HA02', sku: '1003008', ...ND });
    expect(res.status).toBe(201);
  });
});

  it('serializes concurrent public submissions for the same duplicate key', async () => {
    const responses = await Promise.all([
      request(app).post('/api/public/submit').send({ site_code: 'HA19', sku: '1009115', rp_type: 'RF', safety_stock: '5', remark: '同鍵測試' }),
      request(app).post('/api/public/submit').send({ site_code: 'HA19', sku: '1009115', rp_type: 'RF', safety_stock: '5', remark: '同鍵測試' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const count = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM submissions WHERE site_code = 'HA19' AND sku = '1009115' AND submission_type = 'normal'`,
    );
    expect(count.rows[0]!.count).toBe('1');
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
      sku: '1006032',
      qty: 5,
      urgent_reason: '1',
    });
    expect(res.status).toBe(201);
  });

  it('rejects urgent submit at 14:30', async () => {
    timeSpy.mockReturnValue(14 * 60 + 30);
    const res = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006030',
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
      sku: '1006031',
      qty: 5,
      urgent_reason: '1',
    });
    expect(closed.status).toBe(400);

    timeSpy.mockReturnValue(0);
    const reopened = await request(app).post('/api/public/urgent/submit').send({
      site_code: 'HA02',
      sku: '1006031',
      qty: 5,
      urgent_reason: '1',
    });
    expect(reopened.status).toBe(201);
  });

  it('rejects urgent import at 14:30 without writing rows', async () => {
    const beforeTotal = await countSubmissions();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', '1006118', 2, '1', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    timeSpy.mockReturnValue(14 * 60 + 30);
    const res = await request(app)
      .post('/api/public/urgent/import')
      .attach('file', buffer, 'urgent-window.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('14:30');

    expect(await countSubmissions()).toBe(beforeTotal);
  });

  it('still accepts normal submissions after 14:30', async () => {
    timeSpy.mockReturnValue(23 * 60 + 59);
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '1000011',
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

describe('SKU format validation', () => {
  it('rejects a public normal import with a multi-SKU cell without writing anything', async () => {
    const beforeTotal = await countSubmissions();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', '123456789012 , 123456789011', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app).post('/api/public/import').attach('file', buffer, 'multi-sku.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.some((e: { field: string }) => e.field === 'SKU')).toBe(true);

    expect(await countSubmissions()).toBe(beforeTotal);
  });

  it('rejects a public urgent import with a multi-SKU cell without writing anything', async () => {
    const beforeTotal = await countSubmissions();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', '123456789012,123456789011', 2, '1', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app).post('/api/public/urgent/import').attach('file', buffer, 'urgent-multi-sku.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.some((e: { field: string }) => e.field === 'SKU')).toBe(true);

    expect(await countSubmissions()).toBe(beforeTotal);
  });

  it('rejects a public sales import with a multi-SKU cell without writing anything', async () => {
    const beforeTotal = await countSubmissions();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SALES_SHEET);
    ws.addRow([...SALES_COLUMNS]);
    ws.addRow(['HA02', '123456789012 123456789011']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app).post('/api/public/sales/import').attach('file', buffer, 'sales-multi-sku.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.errors?.some((e: { field: string }) => e.field === 'SKU')).toBe(true);

    expect(await countSubmissions()).toBe(beforeTotal);
  });

  it('allows admin import of rows with non-conforming SKUs (exempt)', async () => {
    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(['HA02', 'NOT-SKU-123', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await agent
      .post('/api/admin/import')
      .set('x-csrf-token', token)
      .attach('file', buffer, 'admin-nonconforming.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(1);
    expect(res.body.rows[0].sku).toBe('NOT-SKU-123');
  });

  it('allows admin edit to set a non-conforming SKU (exempt)', async () => {
    const created = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      sku: '1009001',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
    });
    const no = created.body.submission.application_no;
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [no]);
    const id = idRes.rows[0]!.id;

    const agent = request.agent(app);
    await adminLogin(agent);
    const token = await csrf(agent);
    const res = await agent
      .put(`/api/admin/submissions/${id}`)
      .set('x-csrf-token', token)
      .send({ sku: 'ADMIN-FREE-FORM', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    expect(res.status).toBe(200);
    expect(res.body.submission.sku).toBe('ADMIN-FREE-FORM');
  });
});
