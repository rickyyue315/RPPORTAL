import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/services/portalAuth.js';
import { applyAllMigrations } from './migrateTest.js';

/**
 * Per-account Portal passwords for Store and OM.
 *
 * The shared password must keep working until an account actually receives its
 * own password (otherwise a deploy locks every shop out), and must stop working
 * for that account the moment it does.
 */

let db: PGlite;
let app: Express;

const STORE_PLAIN = 'HA02';
const STORE_ISSUED = 'HA06';
const STORE_ISSUED_OTHER = 'HA19';
const STORE_PW = 'StoreOwnPass1!';
const STORE_PW_OTHER = 'StoreOtherPass2!';
const OM_PLAIN = 'IVY';
const OM_ISSUED = 'VIOLET';
const OM_PW = 'OmOwnPass1!';
const OM_OTHER = 'HIPPO';
const OM_PW_OTHER = 'OmOtherPass2!';

type Agent = ReturnType<typeof request.agent>;

async function csrfToken(agent: Agent): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token as string;
}

async function login(username: string, password: string): Promise<{ status: number; body: Record<string, unknown>; agent: Agent }> {
  const agent = request.agent(app) as Agent;
  const token = await csrfToken(agent);
  const res = await agent
    .post('/api/portal/auth/login')
    .set('x-csrf-token', token)
    .send({ username, password });
  return { status: res.status, body: res.body, agent };
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

async function insertUser(input: {
  username: string;
  role: 'store' | 'buyer' | 'sct' | 'om';
  siteCode?: string | null;
  password?: string | null;
  displayName?: string;
  active?: boolean;
}): Promise<string> {
  const passwordHash = input.password
    ? await hashPassword(input.password)
    : `unusable$${Math.random().toString(16).slice(2)}`;
  const result = await db.query<{ id: string }>(
    `INSERT INTO portal_users
       (username, display_name, role, site_code, password_hash, initial_password,
        password_issued_at, must_change_password, active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, 'test')
     RETURNING id`,
    [
      input.username,
      input.displayName ?? input.username,
      input.role,
      input.siteCode ?? null,
      passwordHash,
      input.password ?? null,
      input.password ? new Date().toISOString() : null,
      input.active ?? true,
    ],
  );
  return result.rows[0]!.id;
}

async function seedUsers(): Promise<void> {
  await insertUser({ username: STORE_PLAIN, role: 'store', siteCode: STORE_PLAIN, displayName: '駱克' });
  await insertUser({
    username: STORE_ISSUED,
    role: 'store',
    siteCode: STORE_ISSUED,
    displayName: '北角',
    password: STORE_PW,
  });
  await insertUser({
    username: STORE_ISSUED_OTHER,
    role: 'store',
    siteCode: STORE_ISSUED_OTHER,
    displayName: '康山',
    password: STORE_PW_OTHER,
  });
  await insertUser({ username: 'BUYER1', role: 'buyer', displayName: 'Buyer One' });
  await insertUser({ username: 'SCT1', role: 'sct', displayName: 'SCT One' });
  await insertUser({ username: OM_PLAIN, role: 'om', displayName: 'Ivy' });
  await insertUser({ username: OM_ISSUED, role: 'om', displayName: 'Violet', password: OM_PW });
  await insertUser({ username: OM_OTHER, role: 'om', displayName: 'Hippo', password: OM_PW_OTHER });
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
  await db.query('DELETE FROM portal_login_attempts');
  await db.query('DELETE FROM portal_users');
  await seedUsers();
});

describe('store accounts with their own password', () => {
  it('still accepts the shared password before a password is issued', async () => {
    const result = await login(STORE_PLAIN, config.portalSharedPassword);
    expect(result.status).toBe(200);
    expect(result.body.user).toMatchObject({ role: 'store', site_code: STORE_PLAIN });
  });

  it('rejects the shared password once an own password is issued', async () => {
    const result = await login(STORE_ISSUED, config.portalSharedPassword);
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('密碼不正確');
  });

  it('accepts the account own password', async () => {
    const result = await login(STORE_ISSUED, STORE_PW);
    expect(result.status).toBe(200);
  });

  it("rejects another store's password", async () => {
    const result = await login(STORE_ISSUED, STORE_PW_OTHER);
    expect(result.status).toBe(401);
  });

  it('stops accepting the old password after an admin reset', async () => {
    const admin = await adminAgent();
    const token = await csrfToken(admin);
    const list = await admin.get('/api/admin/portal/users?role=store');
    const target = (list.body.users as Array<{ id: string; username: string }>).find(
      (user) => user.username === STORE_ISSUED,
    );
    expect(target).toBeDefined();

    const reset = await admin
      .post(`/api/admin/portal/users/${target!.id}/password/reset`)
      .set('x-csrf-token', token)
      .send({});
    expect(reset.status).toBe(200);
    expect(typeof reset.body.password).toBe('string');

    expect((await login(STORE_ISSUED, STORE_PW)).status).toBe(401);
    const fresh = await login(STORE_ISSUED, reset.body.password);
    expect(fresh.status).toBe(200);
  });

  // 後台結果表是按 id 找回該行再執行「複製文案／開啟郵件／標記已通知」。
  // 少了 id，三個按鈕會全部靜默失效（2026-11-02 實際發生過）。
  it('returns an id and contact email so the result table can act on each row', async () => {
    const admin = await adminAgent();
    const token = await csrfToken(admin);
    const list = await admin.get('/api/admin/portal/users?role=store');
    const target = (list.body.users as Array<{ id: string; username: string; site_code: string | null }>).find(
      (user) => user.username === STORE_ISSUED,
    );
    expect(target).toBeDefined();

    const reset = await admin
      .post(`/api/admin/portal/users/${target!.id}/password/reset`)
      .set('x-csrf-token', token)
      .send({});

    expect(reset.status).toBe(200);
    expect(reset.body.id).toBe(target!.id);
    expect(reset.body.contact_email).toBe(`${target!.site_code!.toLowerCase()}@sasa.com`);
  });

  it('revokes existing sessions when the password is reset', async () => {
    const first = await login(STORE_ISSUED, STORE_PW);
    expect(first.status).toBe(200);
    expect((await first.agent.get('/api/portal/auth/me')).status).toBe(200);

    const admin = await adminAgent();
    const token = await csrfToken(admin);
    const list = await admin.get('/api/admin/portal/users?role=store');
    const target = (list.body.users as Array<{ id: string; username: string }>).find(
      (user) => user.username === STORE_ISSUED,
    );
    await admin
      .post(`/api/admin/portal/users/${target!.id}/password/reset`)
      .set('x-csrf-token', token)
      .send({});

    expect((await first.agent.get('/api/portal/auth/me')).status).toBe(401);
  });
});

describe('OM accounts with their own password', () => {
  it('accepts the OM shared password before one is issued', async () => {
    const result = await login(OM_PLAIN, config.portalOmPassword);
    expect(result.status).toBe(200);
    expect(result.body.user).toMatchObject({ role: 'om', site_code: null });
  });

  it('rejects the OM shared password once an own password is issued', async () => {
    const result = await login(OM_ISSUED, config.portalOmPassword);
    expect(result.status).toBe(401);
  });

  it('accepts the OM own password', async () => {
    const result = await login(OM_ISSUED, OM_PW);
    expect(result.status).toBe(200);
  });

  it("rejects another OM's password", async () => {
    const result = await login(OM_ISSUED, OM_PW_OTHER);
    expect(result.status).toBe(401);
  });

  it('never lets an OM sign in with the store shared password', async () => {
    // Not yet issued: the store-wide password must not open an OM account, and
    // the message points the user at the right credential.
    const plain = await login(OM_PLAIN, config.portalSharedPassword);
    expect(plain.status).toBe(401);
    expect(plain.body.error).toBe('OM 帳戶請使用 OM 專用密碼登入');

    // Already issued: only the account own password is accepted, so the
    // store-wide password is simply wrong.
    const issued = await login(OM_ISSUED, config.portalSharedPassword);
    expect(issued.status).toBe(401);
  });

  it('issues an own password for an OM through the admin API', async () => {
    const admin = await adminAgent();
    const token = await csrfToken(admin);
    const list = await admin.get('/api/admin/portal/users?role=om');
    const target = (list.body.users as Array<{ id: string; username: string }>).find(
      (user) => user.username === OM_PLAIN,
    );
    expect(target).toBeDefined();

    const reset = await admin
      .post(`/api/admin/portal/users/${target!.id}/password/reset`)
      .set('x-csrf-token', token)
      .send({});
    expect(reset.status).toBe(200);

    expect((await login(OM_PLAIN, config.portalOmPassword)).status).toBe(401);
    expect((await login(OM_PLAIN, reset.body.password)).status).toBe(200);
  });
});

describe('shared password shutdown switch', () => {
  it('blocks a store that has no own password, while buyer keeps working', async () => {
    const previous = config.portalStoreSharedPasswordEnabled;
    config.portalStoreSharedPasswordEnabled = false;
    try {
      const store = await login(STORE_PLAIN, config.portalSharedPassword);
      expect(store.status).toBe(401);
      expect(store.body.code).toBe('PORTAL_PASSWORD_NOT_ISSUED');

      const buyer = await login('BUYER1', config.portalSharedPassword);
      expect(buyer.status).toBe(200);

      const issued = await login(STORE_ISSUED, STORE_PW);
      expect(issued.status).toBe(200);
    } finally {
      config.portalStoreSharedPasswordEnabled = previous;
    }
  });

  it('blocks an OM without an own password but leaves issued OMs working', async () => {
    const previous = config.portalOmSharedPasswordEnabled;
    config.portalOmSharedPasswordEnabled = false;
    try {
      const plain = await login(OM_PLAIN, config.portalOmPassword);
      expect(plain.status).toBe(401);

      const issued = await login(OM_ISSUED, OM_PW);
      expect(issued.status).toBe(200);
    } finally {
      config.portalOmSharedPasswordEnabled = previous;
    }
  });
});

describe('brute-force protection', () => {
  it('locks one identifier after the per-user-IP threshold and leaves other stores alone', async () => {
    const attempts = config.portalLoginFailPerUserIp;
    for (let i = 0; i < attempts; i++) {
      expect((await login(STORE_ISSUED, 'wrong-password')).status).toBe(401);
    }
    const locked = await login(STORE_ISSUED, STORE_PW);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('PORTAL_LOGIN_LOCKED');

    // Same IP, different Site Code: the lock must not leak across accounts.
    const other = await login(STORE_ISSUED_OTHER, STORE_PW_OTHER);
    expect(other.status).toBe(200);
  });

  it('counts only failures after the last successful login', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await login(STORE_ISSUED, 'wrong-password')).status).toBe(401);
    }
    expect((await login(STORE_ISSUED, STORE_PW)).status).toBe(200);

    const attempts = config.portalLoginFailPerUserIp;
    for (let i = 0; i < attempts - 1; i++) {
      expect((await login(STORE_ISSUED, 'wrong-password')).status).toBe(401);
    }
    expect((await login(STORE_ISSUED, STORE_PW)).status).toBe(200);
  });
});

describe('admin password API', () => {
  it('reports the three password states', async () => {
    const admin = await adminAgent();
    const res = await admin.get('/api/admin/portal/users');
    expect(res.status).toBe(200);
    const byName = new Map(
      (res.body.users as Array<{ username: string; password_status: string }>).map((user) => [
        user.username,
        user.password_status,
      ]),
    );
    expect(byName.get(STORE_PLAIN)).toBe('not_issued');
    expect(byName.get(STORE_ISSUED)).toBe('issued');
    expect(byName.get('BUYER1')).toBe('not_applicable');
    expect(byName.get(OM_PLAIN)).toBe('not_issued');
    expect(byName.get(OM_ISSUED)).toBe('issued');
  });

  it('derives the contact email for stores only', async () => {
    const admin = await adminAgent();
    const res = await admin.get('/api/admin/portal/users');
    const rows = res.body.users as Array<{ username: string; contact_email: string | null }>;
    expect(rows.find((row) => row.username === STORE_ISSUED)?.contact_email).toBe('ha06@sasa.com');
    expect(rows.find((row) => row.username === OM_ISSUED)?.contact_email).toBeNull();
    expect(rows.find((row) => row.username === 'BUYER1')?.contact_email).toBeNull();
  });

  it('never exposes a password for accounts that have none', async () => {
    const admin = await adminAgent();
    const res = await admin.get('/api/admin/portal/users?password_status=not_issued');
    const rows = res.body.users as Array<{ initial_password: string | null; role: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.initial_password).toBeNull();
      expect(['store', 'om']).toContain(row.role);
    }
  });

  it('rejects a reset for a buyer account', async () => {
    const admin = await adminAgent();
    const token = await csrfToken(admin);
    const list = await admin.get('/api/admin/portal/users?role=buyer');
    const buyer = (list.body.users as Array<{ id: string }>)[0];
    const res = await admin
      .post(`/api/admin/portal/users/${buyer!.id}/password/reset`)
      .set('x-csrf-token', token)
      .send({});
    expect(res.status).toBe(400);
  });

  it('previews a bulk run without returning passwords', async () => {
    const admin = await adminAgent();
    const token = await csrfToken(admin);
    const res = await admin
      .post('/api/admin/portal/users/passwords/bulk')
      .set('x-csrf-token', token)
      .send({ only_missing: true, dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.generated).toBeGreaterThan(0);
    for (const item of res.body.items as Array<Record<string, unknown>>) {
      expect(item.password).toBeUndefined();
    }
  });

  it('does not overwrite an already issued password when only_missing is set', async () => {
    const admin = await adminAgent();
    const token = await csrfToken(admin);

    const preview = await admin
      .post('/api/admin/portal/users/passwords/bulk')
      .set('x-csrf-token', token)
      .send({ only_missing: true, dry_run: true });
    const previewNames = (preview.body.items as Array<{ username: string }>).map((item) => item.username);
    expect(previewNames).not.toContain(STORE_ISSUED);
    expect(previewNames).toContain(STORE_PLAIN);

    const run = await admin
      .post('/api/admin/portal/users/passwords/bulk')
      .set('x-csrf-token', token)
      .send({ only_missing: true, dry_run: false });
    expect(run.status).toBe(200);
    expect(run.body.generated).toBe(previewNames.length);
    expect(run.body.skipped).toBe(0);

    // The account that already had a password keeps working with the old one.
    expect((await login(STORE_ISSUED, STORE_PW)).status).toBe(200);
    // The newly issued account no longer accepts the shared password.
    expect((await login(STORE_PLAIN, config.portalSharedPassword)).status).toBe(401);
  });

  it('exports issued passwords as CSV', async () => {
    const admin = await adminAgent();
    const res = await admin.get('/api/admin/portal/users/passwords/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain(STORE_ISSUED);
    expect(res.text).toContain(STORE_PW);
    expect(res.text).not.toContain(STORE_PLAIN);
  });
});

describe('session guard', () => {
  it('refuses to create a session when the stored hash changed', async () => {
    const { createPortalSessionGuarded } = await import('../src/services/portalAuth.js');
    const rows = await db.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM portal_users WHERE username = $1',
      [STORE_ISSUED],
    );
    const user = rows.rows[0]!;
    expect(await createPortalSessionGuarded(user.id, 'scrypt$deadbeef$deadbeef', 'per_user')).toBeNull();
    expect(await createPortalSessionGuarded(user.id, user.password_hash, 'per_user')).not.toBeNull();
  });
});
