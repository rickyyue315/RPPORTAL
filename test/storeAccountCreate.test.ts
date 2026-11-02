import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { applyAllMigrations } from './migrateTest.js';

/**
 * Manually opening a Store account for a single shop, including a Site Code
 * that is not in the store master yet (new shop / master CSV not refreshed).
 *
 * The account must survive 「按門店主檔同步」 — otherwise a freshly created
 * login would be deactivated on the next sync.
 */

let db: PGlite;
let app: Express;

type Agent = ReturnType<typeof request.agent>;

async function csrfToken(agent: Agent): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token as string;
}

async function adminAgent(): Promise<Agent> {
  const agent = request.agent(app) as Agent;
  const token = await csrfToken(agent);
  const res = await agent
    .post('/api/admin/login')
    .set('x-csrf-token', token)
    .send({ username: config.adminUsername, password: config.adminPassword });
  expect(res.status).toBe(200);
  return agent;
}

async function createStoreAccount(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const agent = await adminAgent();
  const token = await csrfToken(agent);
  const res = await agent.post('/api/admin/portal/users').set('x-csrf-token', token).send({ role: 'store', ...body });
  return { status: res.status, body: res.body };
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
  await applyAllMigrations(db);
  app = createApp();
});

beforeEach(async () => {
  await db.query('DELETE FROM portal_sessions');
  await db.query('DELETE FROM portal_users');
  await db.query('DELETE FROM stores');
  await db.query(
    `INSERT INTO stores (site_code, shop) VALUES ('HA02', '駱克'), ('HA06', '北角')`,
  );
});

describe('creating a single Store account', () => {
  it('creates an account for a Site Code already in the store master', async () => {
    const res = await createStoreAccount({ site_code: 'HA02' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'HA02', site_code: 'HA02', shop: '駱克', reactivated: false, added_to_master: false });
  });

  it('adds an unknown Site Code to the store master and keeps it after a sync', async () => {
    const res = await createStoreAccount({ site_code: 'zz99', shop_name: '新店測試' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'ZZ99', site_code: 'ZZ99', shop: '新店測試', added_to_master: true });

    const store = await db.query<{ shop: string }>('SELECT shop FROM stores WHERE site_code = $1', ['ZZ99']);
    expect(store.rows[0]?.shop).toBe('新店測試');

    const account = await db.query<{ display_name: string; active: boolean }>(
      "SELECT display_name, active FROM portal_users WHERE role = 'store' AND site_code = $1",
      ['ZZ99'],
    );
    expect(account.rows[0]).toMatchObject({ display_name: '新店測試', active: true });

    const agent = await adminAgent();
    const token = await csrfToken(agent);
    const sync = await agent.post('/api/admin/stores/sync-accounts').set('x-csrf-token', token).send({});
    expect(sync.status).toBe(200);
    expect(sync.body.deactivated).not.toContain('ZZ99');

    const after = await db.query<{ active: boolean }>("SELECT active FROM portal_users WHERE site_code = 'ZZ99'");
    expect(after.rows[0]?.active).toBe(true);
  });

  it('falls back to the Site Code as the shop name when none is given', async () => {
    const res = await createStoreAccount({ site_code: 'ZZ01' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ shop: 'ZZ01', added_to_master: true });
  });

  it('writes every store master column supplied on the form', async () => {
    const res = await createStoreAccount({
      site_code: 'zz10',
      shop_name: '新店十',
      store_fields: { regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T', attention: '需特別關注' },
    });
    expect(res.status).toBe(201);
    const store = await db.query<Record<string, string>>('SELECT * FROM stores WHERE site_code = $1', ['ZZ10']);
    expect(store.rows[0]).toMatchObject({
      shop: '新店十',
      regional: 'HK',
      class1: 'B',
      class2: 'B2',
      size: 'S',
      om: 'Ivy',
      type: 'T',
      attention: '需特別關注',
    });
  });

  it('stores blank master columns as empty strings, like a CSV with empty cells', async () => {
    await createStoreAccount({ site_code: 'ZZ11' });
    const store = await db.query<Record<string, string>>('SELECT * FROM stores WHERE site_code = $1', ['ZZ11']);
    expect(store.rows[0]).toMatchObject({ regional: '', class1: '', class2: '', size: '', om: '', type: '', attention: '' });
  });

  it('lets the new account log in with the shared portal password', async () => {
    await createStoreAccount({ site_code: 'ZZ02', shop_name: '手動開店' });
    const agent = request.agent(app) as Agent;
    const token = await csrfToken(agent);
    const login = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'ZZ02', password: config.portalSharedPassword });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ role: 'store', site_code: 'ZZ02' });
  });

  it('re-activates a disabled account instead of creating a duplicate', async () => {
    await createStoreAccount({ site_code: 'HA06' });
    await db.query("UPDATE portal_users SET active = false WHERE site_code = 'HA06'");

    const again = await createStoreAccount({ site_code: 'HA06' });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ reactivated: true });

    const count = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM portal_users WHERE site_code = 'HA06'");
    expect(count.rows[0]?.count).toBe('1');
  });

  it('rejects an account that already exists and is active', async () => {
    await createStoreAccount({ site_code: 'HA02' });
    const again = await createStoreAccount({ site_code: 'HA02' });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('此店舖帳戶已存在');
  });

  it('rejects a Site Code with characters that are not letters or digits', async () => {
    const res = await createStoreAccount({ site_code: 'HA 02' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('Site Code');
    const store = await db.query('SELECT 1 FROM stores WHERE site_code = $1', ['HA 02']);
    expect(store.rows).toHaveLength(0);
  });
});
