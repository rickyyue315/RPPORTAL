import { describe, expect, it, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { replaceStores } from '../src/services/stores.js';
import { hashPassword } from '../src/services/portalAuth.js';
import * as time from '../src/lib/time.js';
import { vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'Workflow1!TEST';

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

async function adminLogin(agent: Agent): Promise<void> {
  const token = await csrf(agent);
  agent._csrf = token;
  const res = await agent
    .post('/api/admin/login')
    .set('x-csrf-token', token)
    .send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
}

async function portalLogin(agent: Agent, username: string): Promise<void> {
  const token = await csrf(agent);
  agent._csrf = token;
  const res = await agent
    .post('/api/portal/auth/login')
    .set('x-csrf-token', token)
    .send({ username, password: PASSWORD });
  expect(res.status).toBe(200);
}

async function storeAgent(site: string): Promise<Agent> {
  const agent = request.agent(app) as Agent;
  await portalLogin(agent, site);
  return agent;
}

function submitNormal(agent: Agent, payload: Record<string, unknown>) {
  const { site_code: _ignored, ...body } = payload;
  void _ignored;
  return agent.post('/api/portal/store/submit').set('x-csrf-token', agent._csrf ?? '').send(body);
}

async function insertSubmission(params: {
  site: string;
  sku: string;
  rpType: string;
  route: string;
  status: string;
  rejectedAt?: string | null;
  active?: boolean;
}): Promise<string> {
  const result = await db.query<{ id: string; application_no: string }>(
    `INSERT INTO submissions (
       application_no, source, submission_type, site_code, requested_by_email, application_date,
       brand, sku, rp_type, safety_stock, nd_code, remark, status,
       ndrf_route, workflow_status, active_workflow, review_round, rejected_at
     ) VALUES ($1, 'web', 'normal', $2, $3, $4, '', $5, $6, NULL, NULL, NULL, 'received',
       $7, $8, $9, 1, $10)
     RETURNING id, application_no`,
    [
      `NDRF-WF-${params.site}-${params.sku}`,
      params.site,
      `${params.site.toLowerCase()}@sasa.com`,
      '2026-08-05',
      params.sku,
      params.rpType,
      params.route,
      params.status,
      params.active ?? true,
      params.rejectedAt ?? null,
    ],
  );
  return result.rows[0]!.id;
}

let app: Express;
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting(await makePool(db));
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
    { site_code: 'HA06', shop: '北角', regional: 'HK', class1: 'B', class2: 'B2', size: 'M', om: 'Ivy', type: 'M' },
    { site_code: 'HA19', shop: '康山', regional: 'HK', class1: 'C', class2: 'C2', size: 'S', om: 'Violet', type: 'L' },
  ]);
  const pwHash = await hashPassword(PASSWORD);
  for (const site of ['HA02', 'HA06', 'HA19']) {
    await db.query(
      `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
       VALUES ($1, $1, 'store', $2, $3, false, true, 'test')`,
      [site, site, pwHash],
    );
  }
  const buyer1 = await db.query<{ id: string }>(
    `INSERT INTO portal_users (username, display_name, role, password_hash, must_change_password, active, created_by)
     VALUES ('BUYER1', 'Buyer One', 'buyer', $1, false, true, 'test') RETURNING id`,
    [pwHash],
  );
  const buyer2 = await db.query<{ id: string }>(
    `INSERT INTO portal_users (username, display_name, role, password_hash, must_change_password, active, created_by)
     VALUES ('BUYER2', 'Buyer Two', 'buyer', $1, false, true, 'test') RETURNING id`,
    [pwHash],
  );
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, password_hash, must_change_password, active, created_by)
     VALUES ('SCT1', 'SCT One', 'sct', $1, false, true, 'test')`,
    [pwHash],
  );
  for (const sku of ['1002001', '1002002', '1002003', '1002004', '1002005', '1002006', '1002007']) {
    await db.query(`INSERT INTO sku_master (sku, buyer_user_id, updated_by) VALUES ($1, $2, 'test')`, [sku, buyer1.rows[0]!.id]);
  }
  for (const sku of ['1002101', '1002102']) {
    await db.query(`INSERT INTO sku_master (sku, buyer_user_id, updated_by) VALUES ($1, $2, 'test')`, [sku, buyer2.rows[0]!.id]);
  }
  vi.spyOn(time, 'hkTodayForDateColumn').mockReturnValue('2026-08-05');
  app = createApp();
});

function buyerAgent() {
  return request.agent(app) as Agent;
}

describe('general NDRF review workflow', () => {
  it('routes a normal-store ND to Buyer pending, then accepts to accepted', async () => {
    const store = await storeAgent('HA02');
    const created = await submitNormal(store, {
      sku: '1002001',
      rp_type: 'ND',
      nd_code: 'ND20-SO-Not displayed in small stores',
    });
    expect(created.status).toBe(201);
    expect(created.body.submission.route).toBe('buyer');
    expect(created.body.submission.workflow_status).toBe('pending');

    const buyer = buyerAgent();
    await portalLogin(buyer, 'BUYER1');
    const queue = await buyer.get('/api/portal/reviewer/queue');
    expect(queue.status).toBe(200);
    const item = queue.body.submissions.find((s: { application_no: string }) => s.application_no === created.body.submission.application_no);
    expect(item).toBeDefined();

    const decided = await buyer
      .post(`/api/portal/reviewer/submissions/${item.id}/decision`)
      .set('x-csrf-token', buyer._csrf ?? '')
      .send({ decision: 'accept', remark: 'OK' });
    expect(decided.status).toBe(201);
    expect(decided.body.submission.workflow_status).toBe('accepted');
    expect(decided.body.submission.review_round).toBe(1);

    // A retry of the same decision replays instead of creating a second one.
    const retry = await buyer
      .post(`/api/portal/reviewer/submissions/${item.id}/decision`)
      .set('x-csrf-token', buyer._csrf ?? '')
      .send({ decision: 'accept', remark: 'OK' });
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    const events = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ndrf_review_events WHERE submission_id = $1 AND event_type = 'accept'`,
      [item.id],
    );
    expect(events.rows[0]!.count).toBe('1');
  });

  it('blocks a buyer from deciding another buyers SKU', async () => {
    const store = await storeAgent('HA06');
    const created = await submitNormal(store, { sku: '1002101', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    expect(created.status).toBe(201);

    const wrongBuyer = buyerAgent();
    await portalLogin(wrongBuyer, 'BUYER1');
    const queue = await wrongBuyer.get('/api/portal/reviewer/queue');
    const item = queue.body.submissions.find((s: { application_no: string }) => s.application_no === created.body.submission.application_no);
    expect(item).toBeUndefined();

    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [created.body.submission.application_no]);
    const decided = await wrongBuyer
      .post(`/api/portal/reviewer/submissions/${idRes.rows[0]!.id}/decision`)
      .set('x-csrf-token', wrongBuyer._csrf ?? '')
      .send({ decision: 'accept' });
    expect(decided.status).toBe(409);
  });

  it('routes a designated store RF to the single SCT and requires a remark', async () => {
    const store = await storeAgent('HA19');
    const noRemark = await submitNormal(store, { sku: '1002002', rp_type: 'RF', safety_stock: '5' });
    expect(noRemark.status).toBe(400);
    expect(noRemark.body.field).toBe('remark');

    const created = await submitNormal(store, { sku: '1002002', rp_type: 'RF', safety_stock: '5', remark: '轉 RF 原因' });
    expect(created.status).toBe(201);
    expect(created.body.submission.route).toBe('sct');
    expect(created.body.submission.workflow_status).toBe('pending');

    const sct = buyerAgent();
    await portalLogin(sct, 'SCT1');
    const queue = await sct.get('/api/portal/reviewer/queue');
    const item = queue.body.submissions.find((s: { application_no: string }) => s.application_no === created.body.submission.application_no);
    expect(item).toBeDefined();

    const decided = await sct
      .post(`/api/portal/reviewer/submissions/${item.id}/decision`)
      .set('x-csrf-token', sct._csrf ?? '')
      .send({ decision: 'accept', remark: 'approved' });
    expect(decided.status).toBe(201);
    expect(decided.body.submission.workflow_status).toBe('accepted');
  });

  it('rejects a normal-store RF without remark-required and marks ready_for_rp', async () => {
    const store = await storeAgent('HA02');
    const created = await submitNormal(store, { sku: '1002003', rp_type: 'RF', safety_stock: '5' });
    expect(created.status).toBe(201);
    expect(created.body.submission.route).toBe('rp');
    expect(created.body.submission.workflow_status).toBe('ready_for_rp');
  });

  it('reject requires a reason category and a note; "other" requires a note', async () => {
    const store = await storeAgent('HA02');
    const created = await submitNormal(store, { sku: '1002004', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [created.body.submission.application_no]);

    const buyer = buyerAgent();
    await portalLogin(buyer, 'BUYER1');
    const noReason = await buyer
      .post(`/api/portal/reviewer/submissions/${idRes.rows[0]!.id}/decision`)
      .set('x-csrf-token', buyer._csrf ?? '')
      .send({ decision: 'reject' });
    expect(noReason.status).toBe(409);

    const noNote = await buyer
      .post(`/api/portal/reviewer/submissions/${idRes.rows[0]!.id}/decision`)
      .set('x-csrf-token', buyer._csrf ?? '')
      .send({ decision: 'reject', reject_reason_code: 'data_error' });
    expect(noNote.status).toBe(409);

    const otherNoNote = await buyer
      .post(`/api/portal/reviewer/submissions/${idRes.rows[0]!.id}/decision`)
      .set('x-csrf-token', buyer._csrf ?? '')
      .send({ decision: 'reject', reject_reason_code: 'other' });
    expect(otherNoNote.status).toBe(409);

    const rejected = await buyer
      .post(`/api/portal/reviewer/submissions/${idRes.rows[0]!.id}/decision`)
      .set('x-csrf-token', buyer._csrf ?? '')
      .send({ decision: 'reject', reject_reason_code: 'data_error', reject_reason_note: '數值有誤' });
    expect(rejected.status).toBe(201);
    expect(rejected.body.submission.workflow_status).toBe('rejected');
    expect(rejected.body.submission.rejected_at).toBeTruthy();
  });

  it('enforces the 30-day cooldown and lets admin reopen bypass it', async () => {
    const rejectedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    await insertSubmission({ site: 'HA02', sku: '1002005', rpType: 'ND', route: 'buyer', status: 'rejected', rejectedAt, active: false });

    const store = await storeAgent('HA02');
    const blocked = await submitNormal(store, { sku: '1002005', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    expect(blocked.status).toBe(201); // cooldown expired (31 days)

    const recent = new Date().toISOString();
    await insertSubmission({ site: 'HA02', sku: '1002004', rpType: 'ND', route: 'buyer', status: 'rejected', rejectedAt: recent, active: false });
    const inCooldown = await submitNormal(store, { sku: '1002004', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    expect(inCooldown.status).toBe(409);
    expect(inCooldown.body.error).toContain('拒絕');

    // A different RP Type for the same sku is allowed even during cooldown.
    const differentRpType = await submitNormal(store, { sku: '1002004', rp_type: 'RF', safety_stock: '5' });
    expect(differentRpType.status).toBe(201);
  });

  it('only accepts one of two concurrent reviewer decisions', async () => {
    const store = await storeAgent('HA02');
    const created = await submitNormal(store, { sku: '1002007', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    expect(created.status).toBe(201);
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [created.body.submission.application_no]);

    const a = buyerAgent();
    await portalLogin(a, 'BUYER1');
    const b = buyerAgent();
    await portalLogin(b, 'BUYER1');

    const [r1, r2] = await Promise.all([
      a.post(`/api/portal/reviewer/submissions/${idRes.rows[0]!.id}/decision`).set('x-csrf-token', a._csrf ?? '').send({ decision: 'accept', remark: 'a' }),
      b.post(`/api/portal/reviewer/submissions/${idRes.rows[0]!.id}/decision`).set('x-csrf-token', b._csrf ?? '').send({ decision: 'accept', remark: 'b' }),
    ]);
    // Exactly one succeeds; the other replays the existing decision.
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 201]);
    const events = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ndrf_review_events WHERE submission_id = $1 AND event_type = 'accept'`,
      [idRes.rows[0]!.id],
    );
    expect(events.rows[0]!.count).toBe('1');
  });

  it('keeps pending ND out of SAP export and includes accepted/ready only', async () => {
    const store = await storeAgent('HA06');
    const pending = await submitNormal(store, { sku: '1002102', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    const ready = await submitNormal(store, { sku: '1002101', rp_type: 'RF', safety_stock: '5' });
    expect(pending.status).toBe(201);
    expect(ready.status).toBe(201);

    const agent = request.agent(app) as Agent;
    await adminLogin(agent);
    const exported = await agent.post('/api/admin/export').set('x-csrf-token', agent._csrf ?? '').send({ include_exported: false });
    expect(exported.status).toBe(200);

    const pendingIdRes = await db.query<{ id: string; exported_at: string | null; locked_at: string | null }>(
      'SELECT id, exported_at, locked_at FROM submissions WHERE application_no = $1',
      [pending.body.submission.application_no],
    );
    expect(pendingIdRes.rows[0]!.exported_at).toBeNull();
    expect(pendingIdRes.rows[0]!.locked_at).toBeNull();

    const readyIdRes = await db.query<{ exported_at: string | null; locked_at: string | null }>(
      'SELECT exported_at, locked_at FROM submissions WHERE application_no = $1',
      [ready.body.submission.application_no],
    );
    expect(readyIdRes.rows[0]!.exported_at).toBeTruthy();
    expect(readyIdRes.rows[0]!.locked_at).toBeTruthy();
  });

  it('safe re-export creates an archive without changing the underlying rows', async () => {
    const agent = request.agent(app) as Agent;
    await adminLogin(agent);
    const before = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM export_batches WHERE filters->>'re_export' = 'true'",
    );
    const res = await agent
      .post('/api/admin/export')
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ include_exported: true });
    expect(res.status).toBe(200);
    const after = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM export_batches WHERE filters->>'re_export' = 'true'",
    );
    expect(Number(after.rows[0]!.count)).toBe(Number(before.rows[0]!.count) + 1);
  });

  it('admin override/reopen starts a new review round without deleting the old decision', async () => {
    const store = await storeAgent('HA02');
    const created = await submitNormal(store, { sku: '1002003', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [created.body.submission.application_no]);
    const id = idRes.rows[0]!.id;

    const buyer = buyerAgent();
    await portalLogin(buyer, 'BUYER1');
    await buyer
      .post(`/api/portal/reviewer/submissions/${id}/decision`)
      .set('x-csrf-token', buyer._csrf ?? '')
      .send({ decision: 'reject', reject_reason_code: 'data_error', reject_reason_note: '測試' });

    const admin = request.agent(app) as Agent;
    await adminLogin(admin);
    const reopen = await admin
      .post(`/api/admin/submissions/${id}/override`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ action: 'reopen', reason: '資料已更正' });
    expect(reopen.status).toBe(200);
    expect(reopen.body.submission.workflow.status).toBe('pending');
    expect(reopen.body.submission.workflow.review_round).toBe(2);

    const rejected = await buyer
      .post(`/api/portal/reviewer/submissions/${id}/decision`)
      .set('x-csrf-token', buyer._csrf ?? '')
      .send({ decision: 'accept', remark: '更正後核准' });
    expect(rejected.status).toBe(201);
    expect(rejected.body.submission.workflow_status).toBe('accepted');
    expect(rejected.body.submission.review_round).toBe(2);

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM ndrf_review_events WHERE submission_id = $1 ORDER BY id ASC`,
      [id],
    );
    const types = events.rows.map((row) => row.event_type);
    expect(types).toContain('reject');
    expect(types).toContain('reopen');
    expect(types).toContain('accept');
  });

  it('rejects overriding a locked/exported submission', async () => {
    const admin = request.agent(app) as Agent;
    await adminLogin(admin);
    const readyRes = await db.query<{ id: string; locked_at: string }>(
      `SELECT id, locked_at FROM submissions
        WHERE workflow_status = 'ready_for_rp' AND locked_at IS NOT NULL
        LIMIT 1`,
    );
    if (!readyRes.rows[0]) return;
    const res = await admin
      .post(`/api/admin/submissions/${readyRes.rows[0]!.id}/override`)
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ action: 'reopen', reason: '不應成功' });
    expect(res.status).toBe(409);
  });

  it('admin can add a designated store and remove it again (only new submissions affected)', async () => {
    const admin = request.agent(app) as Agent;
    await adminLogin(admin);

    // Add HA06 as a designated store: RF requires remark and goes to SCT.
    const added = await admin
      .put('/api/admin/store-routes')
      .set('x-csrf-token', admin._csrf ?? '')
      .send({ site_code: 'HA06', sct_review_required: true, remark_required: true });
    expect(added.status).toBe(200);

    const store = await storeAgent('HA06');
    const noRemark = await submitNormal(store, { sku: '1002098', rp_type: 'RF', safety_stock: '5' });
    expect(noRemark.status).toBe(400);
    expect(noRemark.body.field).toBe('remark');
    const designated = await submitNormal(store, { sku: '1002098', rp_type: 'RF', safety_stock: '5', remark: '指定店測試' });
    expect(designated.status).toBe(201);
    expect(designated.body.submission.route).toBe('sct');
    expect(designated.body.submission.workflow_status).toBe('pending');

    // Remove HA06 from the designated list; the existing submission keeps its route.
    const removed = await admin
      .delete('/api/admin/store-routes/HA06')
      .set('x-csrf-token', admin._csrf ?? '');
    expect(removed.status).toBe(200);

    const stillSct = await db.query<{ ndrf_route: string }>(
      'SELECT ndrf_route FROM submissions WHERE application_no = $1',
      [designated.body.submission.application_no],
    );
    expect(stillSct.rows[0]!.ndrf_route).toBe('sct');

    // A new submission after removal uses the normal RP route without remark.
    const normal = await submitNormal(store, { sku: '1002097', rp_type: 'RF', safety_stock: '5' });
    expect(normal.status).toBe(201);
    expect(normal.body.submission.route).toBe('rp');
    expect(normal.body.submission.workflow_status).toBe('ready_for_rp');

    // Removing a non-designated site reports 404.
    const missing = await admin
      .delete('/api/admin/store-routes/HA06')
      .set('x-csrf-token', admin._csrf ?? '');
    expect(missing.status).toBe(404);
  });

  it('SKU Master replacement fails closed when a pending ND would lose its Buyer', async () => {
    const admin = request.agent(app) as Agent;
    await adminLogin(admin);
    const csv = 'SKU,Buyer Username\n1002001,BUYER1\n1002002,BUYER1\n';
    const res = await admin
      .put('/api/admin/sku-master')
      .set('x-csrf-token', admin._csrf ?? '')
      .attach('file', Buffer.from(csv), 'sku-master.csv');
    // 1002003 is still pending for BUYER1 and is missing from the new master.
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('待審');

    // A complete master that keeps every pending SKU assigned succeeds.
    const pending = await db.query<{ sku: string }>(
      `SELECT sku FROM submissions WHERE submission_type = 'normal' AND ndrf_route = 'buyer' AND workflow_status = 'pending'`,
    );
    const rows = pending.rows.map((row) => `${row.sku},BUYER1`).join('\n');
    const okCsv = `SKU,Buyer Username\n${rows}\n`;
    const ok = await admin
      .put('/api/admin/sku-master')
      .set('x-csrf-token', admin._csrf ?? '')
      .attach('file', Buffer.from(okCsv), 'sku-master.csv');
    expect(ok.status).toBe(200);
  });

  it('blocks deactivating a Buyer that still owns SKUs', async () => {
    const agent = request.agent(app) as Agent;
    await adminLogin(agent);
    const buyerRes = await db.query<{ id: string }>('SELECT id FROM portal_users WHERE username = $1', ['BUYER1']);
    const res = await agent
      .put(`/api/admin/portal/users/${buyerRes.rows[0]!.id}`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ active: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('仍有已分配的 SKU');
  });

  it('SKU Master reassignment moves the pending item to the new Buyer', async () => {
    const buyer1Res = await db.query<{ id: string }>('SELECT id FROM portal_users WHERE username = $1', ['BUYER1']);
    const buyer2Res = await db.query<{ id: string }>('SELECT id FROM portal_users WHERE username = $1', ['BUYER2']);
    await db.query(
      `INSERT INTO sku_master (sku, buyer_user_id, updated_by) VALUES ($1, $2, 'test')
       ON CONFLICT (sku) DO UPDATE SET buyer_user_id = EXCLUDED.buyer_user_id, updated_by = 'test', updated_at = now()`,
      ['1002006', buyer1Res.rows[0]!.id],
    );

    const store = await storeAgent('HA06');
    const created = await submitNormal(store, { sku: '1002006', rp_type: 'ND', nd_code: 'ND20-SO-Not displayed in small stores' });
    expect(created.status).toBe(201);
    const idRes = await db.query<{ id: string }>('SELECT id FROM submissions WHERE application_no = $1', [created.body.submission.application_no]);
    const id = idRes.rows[0]!.id;

    // Reassign the SKU to BUYER2.
    await db.query('UPDATE sku_master SET buyer_user_id = $1, updated_by = $2, updated_at = now() WHERE sku = $3', [buyer2Res.rows[0]!.id, 'admin', '1002006']);

    // Old buyer no longer sees or can decide it.
    const oldBuyer = buyerAgent();
    await portalLogin(oldBuyer, 'BUYER1');
    const queue1 = await oldBuyer.get('/api/portal/reviewer/queue');
    expect(queue1.body.submissions.some((s: { id: string }) => s.id === id)).toBe(false);
    const oldDecision = await oldBuyer
      .post(`/api/portal/reviewer/submissions/${id}/decision`)
      .set('x-csrf-token', oldBuyer._csrf ?? '')
      .send({ decision: 'accept', remark: 'x' });
    expect(oldDecision.status).toBe(409);

    // New buyer sees it in the queue and can decide.
    const newBuyer = buyerAgent();
    await portalLogin(newBuyer, 'BUYER2');
    const queue2 = await newBuyer.get('/api/portal/reviewer/queue');
    expect(queue2.body.submissions.some((s: { id: string }) => s.id === id)).toBe(true);
    const decision = await newBuyer
      .post(`/api/portal/reviewer/submissions/${id}/decision`)
      .set('x-csrf-token', newBuyer._csrf ?? '')
      .send({ decision: 'accept', remark: '接手核准' });
    expect(decision.status).toBe(201);
    expect(decision.body.submission.workflow_status).toBe('accepted');
  });
});

describe('legacy cutover', () => {
  it('pre-cutover legacy rows never enter the exportable set', async () => {
    await db.query(
      `INSERT INTO submissions (
         application_no, source, submission_type, site_code, requested_by_email, application_date,
         brand, sku, rp_type, status, ndrf_route, workflow_status, active_workflow
       ) VALUES ('NDRF-LEGACY-0001', 'web', 'normal', 'HA02', 'ha02@sasa.com', '2026-08-01', '', '1002999', 'ND',
         'received', 'legacy', 'legacy', false)`,
    );
    const { findExportRows } = await import('../src/services/exportBatches.js');
    const rows = await findExportRows('normal', { include_exported: true });
    const legacyIncluded = rows.some((row) => row.application_no === 'NDRF-LEGACY-0001');
    expect(legacyIncluded).toBe(false);

    const legacy = await db.query<{ ndrf_route: string; workflow_status: string; active_workflow: boolean }>(
      `SELECT ndrf_route, workflow_status, active_workflow FROM submissions WHERE application_no = 'NDRF-LEGACY-0001'`,
    );
    expect(legacy.rows[0]).toMatchObject({ ndrf_route: 'legacy', workflow_status: 'legacy', active_workflow: false });
  });
});

  it('admin review-pending report lists pending ND by Buyer and exports a reminder workbook', async () => {
    const buyer1Res = await db.query<{ id: string }>('SELECT id FROM portal_users WHERE username = $1', ['BUYER1']);
    await db.query(
      `INSERT INTO sku_master (sku, buyer_user_id, updated_by) VALUES ('1002088', $1, 'test')
       ON CONFLICT (sku) DO UPDATE SET buyer_user_id = EXCLUDED.buyer_user_id, updated_by = 'test', updated_at = now()`,
      [buyer1Res.rows[0]!.id],
    );
    const appNo = `NDRF-RP-${Date.now()}`;
    await db.query(
      `INSERT INTO submissions (
         application_no, source, submission_type, site_code, requested_by_email, application_date,
         brand, sku, rp_type, nd_code, status, ndrf_route, workflow_status, active_workflow, review_round
       ) VALUES ($1, 'web', 'normal', 'HA02', 'ha02@sasa.com', '2026-08-05', '', '1002088', 'ND', 'ND20-SO-Not displayed in small stores',
         'received', 'buyer', 'pending', true, 1)`,
      [appNo],
    );

    const agent = request.agent(app) as Agent;
    await adminLogin(agent);

    const summary = await agent.get('/api/admin/review-pending');
    expect(summary.status).toBe(200);
    expect(summary.body.total_pending_submissions).toBeGreaterThanOrEqual(1);
    const buyer = summary.body.buyers.find((b: { buyer_username: string }) => b.buyer_username === 'BUYER1');
    expect(buyer).toBeDefined();
    expect(buyer.pending_skus).toBeGreaterThanOrEqual(1);
    expect(buyer.skus).toContain('1002088');
    expect(summary.body.items.some((i: { application_no: string }) => i.application_no === appNo)).toBe(true);

    const workbook = await agent.get('/api/admin/review-pending/export');
    expect(workbook.status).toBe(200);
    expect(workbook.headers['content-type']).toContain('spreadsheetml');
    expect(Number(workbook.headers['content-length'])).toBeGreaterThan(1000);
    expect(workbook.headers['content-disposition']).toContain('Buyer_Pending_Review');
  });
describe('Buyer SLA auto-approve (7 日未回覆 → 默認同意)', () => {
  it('auto-approves overdue pending ND with an immutable event and flags Admin', async () => {
    const buyer1Res = await db.query<{ id: string }>('SELECT id FROM portal_users WHERE username = $1', ['BUYER1']);
    await db.query(
      `INSERT INTO sku_master (sku, buyer_user_id, updated_by) VALUES ('1002095', $1, 'test')
       ON CONFLICT (sku) DO UPDATE SET buyer_user_id = EXCLUDED.buyer_user_id, updated_by = 'test', updated_at = now()`,
      [buyer1Res.rows[0]!.id],
    );
    // Overdue: submitted 8 days ago.
    const overdueNo = `NDRF-SLA-${Date.now()}`;
    await db.query(
      `INSERT INTO submissions (
         application_no, source, submission_type, site_code, requested_by_email, application_date,
         brand, sku, rp_type, nd_code, status, ndrf_route, workflow_status, active_workflow, review_round,
         submitted_at
       ) VALUES ($1, 'web', 'normal', 'HA02', 'ha02@sasa.com', '2026-08-05', '', '1002095', 'ND', 'ND20-SO-Not displayed in small stores',
         'received', 'buyer', 'pending', true, 1, now() - interval '8 days')`,
      [overdueNo],
    );
    // Not overdue yet: submitted 1 day ago.
    const freshNo = `NDRF-FRESH-${Date.now()}`;
    await db.query(
      `INSERT INTO submissions (
         application_no, source, submission_type, site_code, requested_by_email, application_date,
         brand, sku, rp_type, nd_code, status, ndrf_route, workflow_status, active_workflow, review_round,
         submitted_at
       ) VALUES ($1, 'web', 'normal', 'HA02', 'ha02@sasa.com', '2026-08-05', '', '1002096', 'ND', 'ND20-SO-Not displayed in small stores',
         'received', 'buyer', 'pending', true, 1, now() - interval '1 day')`,
      [freshNo],
    );

    const { runBuyerAutoApproveJob, AUTO_APPROVE_REMARK } = await import('../src/services/ndrfWorkflow.js');
    const result = await runBuyerAutoApproveJob();
    expect(result.approved).toBeGreaterThanOrEqual(1);

    const overdue = await db.query<{ workflow_status: string; auto_approved_at: string | null; current_review_remark: string | null }>(
      'SELECT workflow_status, auto_approved_at, current_review_remark FROM submissions WHERE application_no = $1',
      [overdueNo],
    );
    expect(overdue.rows[0]!.workflow_status).toBe('accepted');
    expect(overdue.rows[0]!.auto_approved_at).toBeTruthy();
    expect(overdue.rows[0]!.current_review_remark).toBe(AUTO_APPROVE_REMARK);

    const fresh = await db.query<{ workflow_status: string; auto_approved_at: string | null }>(
      'SELECT workflow_status, auto_approved_at FROM submissions WHERE application_no = $1',
      [freshNo],
    );
    expect(fresh.rows[0]!.workflow_status).toBe('pending');
    expect(fresh.rows[0]!.auto_approved_at).toBeNull();

    const event = await db.query<{ event_type: string; actor_role: string; remark: string }>(
      `SELECT event_type, actor_role, e.remark AS remark FROM ndrf_review_events e
        JOIN submissions s ON s.id = e.submission_id
       WHERE s.application_no = $1 AND e.event_type = 'auto_accept'`,
      [overdueNo],
    );
    expect(event.rows[0]).toBeDefined();
    expect(event.rows[0]!.actor_role).toBe('system');
    expect(event.rows[0]!.remark).toBe(AUTO_APPROVE_REMARK);

    // Idempotent: running again does not touch the approved row.
    const again = await runBuyerAutoApproveJob();
    const eventCount = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ndrf_review_events e
        JOIN submissions s ON s.id = e.submission_id
       WHERE s.application_no = $1 AND e.event_type = 'auto_accept'`,
      [overdueNo],
    );
    expect(eventCount.rows[0]!.count).toBe('1');
    void again;
  });

  it('admin sees the auto-approved flag and can trigger the job manually', async () => {
    const agent = request.agent(app) as Agent;
    await adminLogin(agent);

    const list = await agent.get('/api/admin/submissions?workflow_status=accepted&auto_approved=yes&page=1');
    expect(list.status).toBe(200);
    const autoRow = list.body.submissions.find((s: { workflow: { auto_approved_at: string | null } }) => s.workflow?.auto_approved_at);
    expect(autoRow).toBeDefined();

    const trigger = await agent
      .post('/api/admin/review-pending/auto-approve')
      .set('x-csrf-token', agent._csrf ?? '')
      .send({});
    expect(trigger.status).toBe(200);
    expect(typeof trigger.body.approved).toBe('number');
  });
});
