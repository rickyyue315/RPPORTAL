import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles, readMigrationSql } from './migrateTest.js';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { replaceStores } from '../src/services/stores.js';
import { hashPassword } from '../src/services/portalAuth.js';
import { hkTodayForDateColumn, shiftDateOnly } from '../src/lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;

const STORE_PASSWORD = 'SASA1234';
const OM_PASSWORD = 'SASAOM178';

type Agent = ReturnType<typeof request.agent> & { _csrf?: string };

async function csrf(agent: Agent): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token as string;
}

async function portalLogin(agent: Agent, username: string, password: string): Promise<void> {
  const token = await csrf(agent);
  const res = await agent
    .post('/api/portal/auth/login')
    .set('x-csrf-token', token)
    .send({ username, password });
  expect(res.status).toBe(200);
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

async function stats(admin: Agent, query: string) {
  const res = await admin.get(`/api/admin/portal/login-stats?${query}`);
  expect(res.status).toBe(200);
  return res.body;
}

function newAgent(): Agent {
  return request.agent(app) as Agent;
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

  for (const file of await listMigrationFiles()) {
    await db.exec(await readMigrationSql(file));
  }

  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
    { site_code: 'HA06', shop: '北角', regional: 'HK', class1: 'B', class2: 'B2', size: 'M', om: 'Ivy', type: 'M' },
    { site_code: 'HA19', shop: '康山', regional: 'HK', class1: 'C', class2: 'C2', size: 'S', om: 'Violet', type: 'L' },
    { site_code: 'HBA7', shop: 'AIRSIDE', regional: 'HK', class1: 'C', class2: 'C2', size: 'XS', om: 'Hippo', type: 'M' },
  ]);

  const pwHash = await hashPassword('StoreTest1!ABCD');
  for (const site of ['HA02', 'HA06', 'HA19', 'HBA7']) {
    await db.query(
      `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
       VALUES ($1, $1, 'store', $1, $2, false, true, 'test')`,
      [site, pwHash],
    );
  }
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, password_hash, must_change_password, active, created_by)
     VALUES ('IVY', 'Ivy', 'om', $1, false, true, 'test')`,
    [pwHash],
  );
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, password_hash, must_change_password, active, created_by)
     VALUES ('BUYER1', 'Buyer One', 'buyer', $1, false, true, 'test')`,
    [pwHash],
  );

  app = createApp();
});

beforeEach(async () => {
  // Each test starts with an empty login history so counts are exact.
  await db.query('DELETE FROM audit_events');
  await db.query('DELETE FROM portal_login_attempts');
});

describe('admin portal login stats', () => {
  it('requires an admin session', async () => {
    const res = await request(app).get('/api/admin/portal/login-stats');
    expect(res.status).toBe(401);
  });

  it('wires the admin card to the new endpoint', () => {
    const html = readFileSync(path.join(__dirname, '..', 'public', 'admin', 'index.html'), 'utf8');
    const script = readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin.js'), 'utf8');
    expect(html).toContain('data-lazy-section="login-stats"');
    expect(html).toContain('id="login_stats_body"');
    expect(html).toContain('id="btn_ls_apply"');
    expect(html).toContain('id="btn_ls_export"');
    expect(script).toContain('/api/admin/portal/login-stats');
    expect(script).toContain("'login-stats': loadLoginStats");
  });

  it('counts successful store logins by account and day', async () => {
    const admin = await adminAgent();
    await portalLogin(newAgent(), 'HA02', STORE_PASSWORD);
    await portalLogin(newAgent(), 'HA02', STORE_PASSWORD);
    await portalLogin(newAgent(), 'HA06', STORE_PASSWORD);

    const today = hkTodayForDateColumn();
    const data = await stats(admin, `from=${today}&to=${today}&role=store`);

    expect(data.summary.logins).toBe(3);
    expect(data.summary.logged_in_accounts).toBe(2);
    expect(data.summary.active_accounts).toBe(4);
    expect(data.summary.never_logged_in_accounts).toBe(2);

    const ha02 = data.accounts.find((a: { site_code: string | null }) => a.site_code === 'HA02');
    expect(ha02.logins).toBe(2);
    expect(ha02.last_login_at).toBeTruthy();
    expect(ha02.never_logged_in).toBe(false);

    const ha19 = data.accounts.find((a: { site_code: string | null }) => a.site_code === 'HA19');
    expect(ha19.logins).toBe(0);
    expect(ha19.never_logged_in).toBe(true);

    expect(data.daily).toHaveLength(1);
    expect(data.daily[0]).toMatchObject({ date: today, logins: 3, accounts: 2 });
  });

  it('keeps OM and Buyer logins out of Store stats', async () => {
    const admin = await adminAgent();
    await portalLogin(newAgent(), 'HA02', STORE_PASSWORD);
    await portalLogin(newAgent(), 'IVY', OM_PASSWORD);
    await portalLogin(newAgent(), 'BUYER1', STORE_PASSWORD);

    const today = hkTodayForDateColumn();
    const storeData = await stats(admin, `from=${today}&to=${today}&role=store`);
    expect(storeData.summary.logins).toBe(1);
    expect(storeData.accounts.every((a: { role: string }) => a.role === 'store')).toBe(true);

    const omData = await stats(admin, `from=${today}&to=${today}&role=om`);
    expect(omData.summary.logins).toBe(1);
    expect(omData.accounts).toHaveLength(1);
    expect(omData.accounts[0]).toMatchObject({ username: 'IVY', site_code: null, role: 'om' });

    const allData = await stats(admin, `from=${today}&to=${today}&role=all`);
    expect(allData.summary.logins).toBe(2);
    expect(allData.accounts.some((a: { username: string }) => a.username === 'BUYER1')).toBe(false);
  });

  it('counts failed store logins from the attempts table', async () => {
    const admin = await adminAgent();
    const agent = newAgent();
    const token = await csrf(agent);
    const failed = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'HA06', password: 'wrong-password' });
    expect(failed.status).toBe(401);

    const today = hkTodayForDateColumn();
    const data = await stats(admin, `from=${today}&to=${today}&role=store`);
    expect(data.summary.failed_attempts).toBe(1);

    const ha06 = data.accounts.find((a: { site_code: string | null }) => a.site_code === 'HA06');
    expect(ha06.failed_attempts).toBe(1);
    expect(ha06.never_logged_in).toBe(true);
  });

  it('defaults to the last 30 days', async () => {
    const admin = await adminAgent();
    const data = await stats(admin, 'role=store');
    const today = hkTodayForDateColumn();
    expect(data.range.to).toBe(today);
    expect(data.range.from).toBe(shiftDateOnly(today, -29));
    expect(data.daily).toHaveLength(30);
  });

  it('rejects invalid date ranges', async () => {
    const admin = await adminAgent();
    const today = hkTodayForDateColumn();

    const future = await admin.get(
      `/api/admin/portal/login-stats?from=${today}&to=${shiftDateOnly(today, 1)}`,
    );
    expect(future.status).toBe(400);

    const reversed = await admin.get(
      `/api/admin/portal/login-stats?from=${today}&to=${shiftDateOnly(today, -1)}`,
    );
    expect(reversed.status).toBe(400);

    const tooLong = await admin.get(
      `/api/admin/portal/login-stats?from=${shiftDateOnly(today, -730)}&to=${today}`,
    );
    expect(tooLong.status).toBe(400);

    const badDate = await admin.get('/api/admin/portal/login-stats?from=2026-13-01&to=2026-12-01');
    expect(badDate.status).toBe(400);
  });

  it('groups by Hong Kong date, not UTC date', async () => {
    const admin = await adminAgent();
    const today = hkTodayForDateColumn();
    const todayStart = new Date(`${today}T00:00:00+08:00`);
    const beforeMidnight = new Date(todayStart.getTime() - 1000).toISOString();
    const atMidnight = todayStart.toISOString();

    await db.query(
      `INSERT INTO audit_events (event_type, actor_role, actor, metadata, created_at)
       VALUES ('portal_login', 'store', 'HA02', $1::jsonb, $2::timestamptz),
              ('portal_login', 'store', 'HA02', $1::jsonb, $3::timestamptz)`,
      [JSON.stringify({ site_code: 'HA02' }), beforeMidnight, atMidnight],
    );

    const data = await stats(admin, `from=${today}&to=${today}&role=store`);
    expect(data.summary.logins).toBe(1);
    expect(data.daily).toHaveLength(1);
    expect(data.daily[0]).toMatchObject({ date: today, logins: 1, accounts: 1 });
  });

  // Keep this last: it permanently removes the HBA7 account.
  it('keeps historical logins after the portal account is deleted', async () => {
    const admin = await adminAgent();
    await portalLogin(newAgent(), 'HBA7', STORE_PASSWORD);
    await db.query('DELETE FROM portal_users WHERE username = $1', ['HBA7']);

    const today = hkTodayForDateColumn();
    const data = await stats(admin, `from=${today}&to=${today}&role=store`);
    const row = data.accounts.find((a: { site_code: string | null }) => a.site_code === 'HBA7');
    expect(row).toBeTruthy();
    expect(row.logins).toBe(1);
    expect(row.active).toBe(false);
    expect(row.never_logged_in).toBe(false);
  });
});
