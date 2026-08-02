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
import { SAP_COLUMNS, RP_TEAM_SHEET, SHOP_CODE_HEADER } from '../src/lib/fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let app: Express;
let db: PGlite;

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
  let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', '001_init.sql'), 'utf8');
  sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
  await db.exec(sql);
  await replaceStores(
    [
      { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
      { site_code: 'HA06', shop: '北角', regional: 'HK', class1: 'B', class2: 'B2', size: 'M', om: 'Ivy', type: 'M' },
    ],
  );
  app = createApp();
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

  it('accepts a valid submission', async () => {
    const res = await request(app).post('/api/public/submit').send({
      site_code: 'HA02',
      brand: 'NEG - NEOGENCE',
      sku: '110079623001',
      rp_type: 'ND',
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
  it('rejects login with wrong password', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    const res = await agent
      .post('/api/admin/login')
      .set('x-csrf-token', token)
      .send({ username: 'admin', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('logs in, lists, exports and locks submissions', async () => {
    const agent = request.agent(app);

    // Create two submissions to export
    for (const site of ['HA02', 'HA06']) {
      await request(app).post('/api/public/submit').send({ site_code: site, sku: `EXP-${site}` });
    }

    const token = await csrf(agent);
    const login = await agent
      .post('/api/admin/login')
      .set('x-csrf-token', token)
      .send({ username: 'admin', password: 'admin123' });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);

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

  it('requires CSRF token for admin mutations', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    await agent.post('/api/admin/login').set('x-csrf-token', token).send({ username: 'admin', password: 'admin123' });
    const res = await agent.post('/api/admin/export').send({});
    expect(res.status).toBe(403);
  });

  it('rejects access without login', async () => {
    const res = await request(app).get('/api/admin/submissions');
    expect(res.status).toBe(401);
  });

  it('downloads the template workbook', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    await agent.post('/api/admin/login').set('x-csrf-token', token).send({ username: 'admin', password: 'admin123' });
    const res = await agent.get('/api/admin/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
  });

  it('imports a valid xlsx and creates per-row application numbers', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    await agent.post('/api/admin/login').set('x-csrf-token', token).send({ username: 'admin', password: 'admin123' });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...SAP_COLUMNS]);
    ws.addRow(['', '', 'HA02', 'NEG - NEOGENCE', '110001', 'ND', '1 - Vendor (由供應商送貨到舖)', '', '', '', '', '']);
    ws.addRow(['', '', 'HA06', 'NEG - NEOGENCE', '110002', 'RF', '', '', '', '', '', '']);
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
    await agent.post('/api/admin/login').set('x-csrf-token', token).send({ username: 'admin', password: 'admin123' });

    const before = await agent.get('/api/admin/submissions?page=1&page_size=1');
    const beforeTotal = before.body.total;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow([...SAP_COLUMNS]);
    ws.addRow(['', '', 'ZZ99', 'NEG - NEOGENCE', '110003', '', '', '', '', '', '', '']);
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
    await agent.post('/api/admin/login').set('x-csrf-token', token).send({ username: 'admin', password: 'admin123' });
    const res = await agent
      .post('/api/admin/import')
      .set('x-csrf-token', token)
      .attach('file', Buffer.from('not an excel'), 'bad.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('.xlsx');
  });
});
