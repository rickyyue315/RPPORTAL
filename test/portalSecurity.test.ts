import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  const pwHash = await hashPassword(PASSWORD);
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
     VALUES ('LOCKSTORE1', 'Lock Store', 'store', 'LOCK1', $1, false, true, 'test')`,
    [pwHash],
  );
  app = createApp();
});

describe('portal login hardening', () => {
  it('locks the account after repeated failed logins even with the correct password', async () => {
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    for (let i = 0; i < 5; i++) {
      const res = await agent
        .post('/api/portal/auth/login')
        .set('x-csrf-token', token)
        .send({ username: 'LOCKSTORE1', password: 'wrong-password' });
      expect(res.status).toBe(401);
    }
    const locked = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKSTORE1', password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.error).toContain('鎖定');
  });

  it('does not reveal whether a deactivated account has a correct password', async () => {
    await db.query(`UPDATE portal_users SET active = false WHERE username = 'LOCKSTORE1'`);
    await db.query(`DELETE FROM portal_login_attempts`);
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const res = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKSTORE1', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('使用者名稱或密碼不正確');
  });

  it('enforces password complexity when changing passwords', async () => {
    await db.query(`UPDATE portal_users SET active = true WHERE username = 'LOCKSTORE1'`);
    await db.query(`DELETE FROM portal_login_attempts`);
    const agent = request.agent(app) as Agent;
    const token = await csrf(agent);
    const login = await agent
      .post('/api/portal/auth/login')
      .set('x-csrf-token', token)
      .send({ username: 'LOCKSTORE1', password: PASSWORD });
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
});