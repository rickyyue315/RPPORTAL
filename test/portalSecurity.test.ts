import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/services/portalAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'Lockout1!ABC';

type Agent = ReturnType<typeof request.agent> & { _csrf?: string };

async function makePool(database: PGlite): Promise<never> {
  return {
    query: async (text: string, params?: unknown[]) => database.query(text, params ?? []),
    connect: async () => ({
      query: async (text: string, params?: unknown[]) => database.query(text, params ?? []),
      release: () => {},
    }),
  } as never;
}

async function csrf(agent: Agent): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token as string;
}

let app: Express;
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting(await makePool(db));
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  const pwHash = await hashPassword(PASSWORD);
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, password_hash, must_change_password, active, created_by)
     VALUES ('LOCKBUYER1', 'Lock Buyer', 'buyer', $1, false, true, 'test')`,
    [pwHash],
  );
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
     VALUES ('LOCKSTORE1', 'Lock Store', 'store', 'LOCK1', $1, false, true, 'test')`,
    [pwHash],
  );
  app = createApp();
});

describe('portal login hardening (buyer password login)', () => {
  it('locks the account after repeated failed logins even with the correct password', async () => {
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    for (let i = 0; i < 5; i++) {
      const res = await agent
        .post('/api/portal/auth/login')
        .set('x-csrf-token', token)
        .send({ username: 'LOCKBUYER1', password: 'wrong-password' });
      expect(res.status).toBe(401);
    }
    const locked = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKBUYER1', password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.error).toContain('鎖定');
  });

  it('does not reveal whether a deactivated account has a correct password', async () => {
    await db.query(`UPDATE portal_users SET active = false WHERE username = 'LOCKBUYER1'`);
    await db.query(`DELETE FROM portal_login_attempts`);
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const res = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKBUYER1', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('使用者名稱或密碼不正確');
  });

  it('enforces password complexity when changing passwords', async () => {
    await db.query(`UPDATE portal_users SET active = true WHERE username = 'LOCKBUYER1'`);
    await db.query(`DELETE FROM portal_login_attempts`);
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const login = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKBUYER1', password: PASSWORD });
    expect(login.status).toBe(200);

    const weak = await agent
      .post('/api/portal/auth/change-password')
      .set('x-csrf-token', token)
      .send({ current_password: PASSWORD, new_password: 'abcdefgh' });
    expect(weak.status).toBe(400);
    expect(weak.body.error).toContain('三類');

    const strong = await agent
      .post('/api/portal/auth/change-password')
      .set('x-csrf-token', token)
      .send({ current_password: PASSWORD, new_password: 'Str0ng!Pass' });
    expect(strong.status).toBe(200);
  });

  it('does not lock an account from failures spread across many IPs below the username threshold', async () => {
    // A previous test changed the password; restore the known one.
    await db.query(`UPDATE portal_users SET active = true, password_hash = $1 WHERE username = 'LOCKBUYER1'`, [await hashPassword(PASSWORD)]);
    await db.query(`DELETE FROM portal_login_attempts`);
    // 49 failures from 49 different IPs: each IP is below the per-IP threshold
    // and the username count is below LOGIN_USERNAME_LOCK_THRESHOLD (50).
    for (let i = 1; i <= 49; i++) {
      await db.query(
        `INSERT INTO portal_login_attempts (ip, username, attempted_at, success) VALUES ($1, 'LOCKBUYER1', now(), false)`,
        [`10.99.${Math.floor(i / 250)}.${(i % 250) + 1}`],
      );
    }
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const login = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKBUYER1', password: PASSWORD });
    expect(login.status).toBe(200);

    // Reaching the per-username threshold still locks the account.
    await db.query(`DELETE FROM portal_sessions`);
    for (let i = 50; i <= 60; i++) {
      await db.query(
        `INSERT INTO portal_login_attempts (ip, username, attempted_at, success) VALUES ($1, 'LOCKBUYER1', now(), false)`,
        [`10.98.${Math.floor(i / 250)}.${(i % 250) + 1}`],
      );
    }
    const lockAgent = request.agent(app) as Agent;
    const lockToken = await csrf(lockAgent);
    const locked = await lockAgent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', lockToken)
      .send({ username: 'LOCKBUYER1', password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.error).toContain('鎖定');
  });
});

describe('store passwordless login', () => {
  it('allows username-only login for store accounts and ignores any password', async () => {
    await db.query(`DELETE FROM portal_login_attempts`);
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const login = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKSTORE1' });
    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe('LOCKSTORE1');
    expect(login.body.user.role).toBe('store');
    expect(login.body.user.must_change_password).toBe(false);
    // Store endpoints work without any password change.
    const options = await agent.get('/api/portal/store/options');
    expect(options.status).toBe(200);
    expect(options.body.store.site_code).toBe('LOCK1');

    // A supplied password (even a wrong one) is ignored for stores.
    const agent2 = request.agent(app) as Agent;
    const token2 = await csrf(agent2);
    const login2 = await agent2
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token2)
      .send({ username: 'LOCKSTORE1', password: 'wrong-password' });
    expect(login2.status).toBe(200);
  });

  it('rejects unknown or deactivated store usernames without revealing which', async () => {
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const bad = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'NOPE-NOBODY' });
    expect(bad.status).toBe(401);

    await db.query(`UPDATE portal_users SET active = false WHERE username = 'LOCKSTORE1'`);
    const agent2 = request.agent(app) as Agent;
    const token2 = await csrf(agent2);
    const deactivated = await agent2
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token2)
      .send({ username: 'LOCKSTORE1' });
    expect(deactivated.status).toBe(401);
    expect(deactivated.body.error).toBe('使用者名稱或密碼不正確');
    await db.query(`UPDATE portal_users SET active = true WHERE username = 'LOCKSTORE1'`);
  });

  it('rejects password change for store accounts', async () => {
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const login = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKSTORE1' });
    expect(login.status).toBe(200);
    const change = await agent
      .post('/api/portal/auth/change-password')
      .set('x-csrf-token', token)
      .send({ current_password: 'whatever', new_password: 'Str0ng!Pass' });
    expect(change.status).toBe(400);
    expect(change.body.error).toContain('免密碼');
  });
});

describe('portal auth bypass (PORTAL_AUTH_BYPASS)', () => {
  it('allows username-only login and skips forced password change when enabled', async () => {
    const pwHash = await hashPassword(PASSWORD);
    await db.query(
      `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, initial_password, must_change_password, active, created_by)
       VALUES ('BYPASS1', 'Bypass Store', 'store', 'BYP1', $1, 'Sasa1!BYPASS', true, true, 'test')`,
      [pwHash],
    );
    config.portalAuthBypass = true;
    try {
      const agent = request.agent(app) as Agent;
      const token = await csrf(agent);
      // Password is ignored in bypass mode, even a wrong one.
      const login = await agent
        .post('/api/portal/auth/login')
        .set('x-csrf-token', token)
        .send({ username: 'BYPASS1', password: 'wrong-password' });
      expect(login.status).toBe(200);
      expect(login.body.user.username).toBe('BYPASS1');
      // Store endpoints work despite must_change_password=true.
      const options = await agent.get('/api/portal/store/options');
      expect(options.status).toBe(200);
      expect(options.body.store.site_code).toBe('BYP1');
      // Unknown usernames are still rejected.
      const badAgent = request.agent(app) as Agent;
      const badToken = await csrf(badAgent);
      const bad = await badAgent
        .post('/api/portal/auth/login')
        .set('x-csrf-token', badToken)
        .send({ username: 'NOPE-NOBODY' });
      expect(bad.status).toBe(401);
    } finally {
      config.portalAuthBypass = false;
    }
  });
});
