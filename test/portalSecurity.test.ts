import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, password_hash, must_change_password, active, created_by)
     VALUES ('LOCKBUYER1', 'Lock Buyer', 'buyer', 'unusable$test', false, true, 'test')`,
  );
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
     VALUES ('LOCKSTORE1', 'Lock Store', 'store', 'LOCK1', 'unusable$test', false, true, 'test')`,
  );
  app = createApp();
});

describe('portal passwordless login', () => {
  it('allows username-only login for store accounts', async () => {
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
    // Store endpoints work with no password change.
    const options = await agent.get('/api/portal/store/options');
    expect(options.status).toBe(200);
    expect(options.body.store.site_code).toBe('LOCK1');
  });

  it('allows username-only login for buyer accounts', async () => {
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const login = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKBUYER1' });
    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe('LOCKBUYER1');
    expect(login.body.user.role).toBe('buyer');
    expect(login.body.user.must_change_password).toBe(false);
    const me = await agent.get('/api/portal/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('LOCKBUYER1');
  });

  it('ignores a supplied password for all portal roles', async () => {
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const login = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKSTORE1', password: 'wrong-password' });
    expect(login.status).toBe(200);
  });

  it('requires a username', async () => {
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const empty = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: '   ' });
    expect(empty.status).toBe(400);
  });

  it('rejects unknown or deactivated usernames without revealing which', async () => {
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const bad = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'NOPE-NOBODY' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('使用者名稱不正確或帳戶已停用');

    await db.query(`UPDATE portal_users SET active = false WHERE username = 'LOCKSTORE1'`);
    const agent2 = request.agent(app) as Agent;
    const token2 = await csrf(agent2);
    const deactivated = await agent2
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token2)
      .send({ username: 'LOCKSTORE1' });
    expect(deactivated.status).toBe(401);
    expect(deactivated.body.error).toBe('使用者名稱不正確或帳戶已停用');
    await db.query(`UPDATE portal_users SET active = true WHERE username = 'LOCKSTORE1'`);
  });

  it('no longer serves the change-password endpoint', async () => {
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const login = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKBUYER1' });
    expect(login.status).toBe(200);
    const change = await agent
      .post('/api/portal/auth/change-password')
      .set('x-csrf-token', token)
      .send({ current_password: 'whatever', new_password: 'Str0ng!Pass' });
    expect(change.status).toBe(404);
  });
});
