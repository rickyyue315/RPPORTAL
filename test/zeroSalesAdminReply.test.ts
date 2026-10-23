import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { replaceStores } from '../src/services/stores.js';
import { createBatch as createZeroSalesBatch } from '../src/services/zeroSales.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;

type Agent = ReturnType<typeof request.agent> & { _csrf?: string };

async function csrf(agent: Agent): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token as string;
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

function seedBatch(weekLabel: string) {
  return createZeroSalesBatch({
    weekLabel,
    note: 'test',
    rows: [
      { siteCode: 'HA02', sku: '1000001', data: { Brand: 'B1' } },
      { siteCode: 'HA02', sku: '1000002', data: { Brand: 'B1' } },
      { siteCode: 'HA06', sku: '1000003', data: { Brand: 'B2' } },
    ],
    contentHash: `hash-${weekLabel}-${Date.now()}-${Math.random()}`,
    createdBy: 'test',
  });
}

/** 把某行設成已回覆（可指定 reply_count 模擬已鎖定） */
async function markReplied(batchId: string, sku: string, opts: { reasonCode?: string; note?: string; replyCount?: number } = {}) {
  await db.query(
    `UPDATE zero_sales_items SET status = 'replied', reason_code = $2, reason_label = $3, reason_note = $4,
      replied_at = now(), replied_by = '測試店舖', reply_count = $5
      WHERE batch_id = $1 AND sku = $6`,
    [batchId, opts.reasonCode ?? 'seasonal', opts.reasonCode === 'other' ? '6.其他（須填補充）' : '4.季節性/非當季產品', opts.note ?? '', opts.replyCount ?? 1, sku],
  );
}

async function getItem(batchId: string, sku: string) {
  const r = await db.query<{
    status: string;
    reason_code: string | null;
    reason_label: string | null;
    reason_note: string;
    reply_count: number;
    replied_by: string | null;
  }>('SELECT status, reason_code, reason_label, reason_note, reply_count, replied_by FROM zero_sales_items WHERE batch_id = $1 AND sku = $2', [batchId, sku]);
  return r.rows[0]!;
}

async function itemIdOf(batchId: string, sku: string): Promise<string> {
  const r = await db.query<{ id: string }>('SELECT id FROM zero_sales_items WHERE batch_id = $1 AND sku = $2', [batchId, sku]);
  return r.rows[0]!.id as string;
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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql', '023_zero_sales_repeat_index.sql', '024_zero_sales_archive.sql', '025_zero_sales_auto_reply.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
    { site_code: 'HA06', shop: '北角', regional: 'HK', class1: 'B', class2: 'B2', size: 'M', om: 'Ivy', type: 'M' },
  ]);
  app = createApp();
});

describe('zero-sales admin reply edit', () => {
  it('edits a locked reply (reply_count=2) without consuming the store quota and writes an audit event', async () => {
    const agent = await adminAgent();
    const { batchId } = await seedBatch('2026-W50-admin-edit');
    await markReplied(batchId, '1000001', { reasonCode: 'seasonal', note: '入錯', replyCount: 2 });
    const itemId = await itemIdOf(batchId, '1000001');
    const before = await getItem(batchId, '1000001');
    expect(before.reply_count).toBe(2);

    const res = await agent
      .put(`/api/admin/zero-sales/batches/${batchId}/items/${itemId}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'in_warehouse', reason_note: '店舖 email 求助，代改為貨放舖倉' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await getItem(batchId, '1000001');
    expect(after.status).toBe('replied');
    expect(after.reason_code).toBe('in_warehouse');
    expect(after.reason_label).toBe('2.貨放舖倉未上架');
    expect(after.reason_note).toBe('店舖 email 求助，代改為貨放舖倉');
    // 管理員修改不佔用店舖修改次數：仍然鎖定在 2
    expect(after.reply_count).toBe(2);
    // 店舖回覆人保留不變
    expect(after.replied_by).toBe('測試店舖');

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE event_type = 'zero_sales_reply_edited' AND actor_role = 'admin'`,
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it('rejects a require_note reason with empty note and unknown reason codes', async () => {
    const agent = await adminAgent();
    const { batchId } = await seedBatch('2026-W51-admin-note');
    await markReplied(batchId, '1000001', { replyCount: 2 });
    const itemId = await itemIdOf(batchId, '1000001');
    const noNote = await agent
      .put(`/api/admin/zero-sales/batches/${batchId}/items/${itemId}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'other', reason_note: '' });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error).toContain('必須填寫補充說明');
    const badReason = await agent
      .put(`/api/admin/zero-sales/batches/${batchId}/items/${itemId}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'no_such_reason', reason_note: '' });
    expect(badReason.status).toBe(400);
  });

  it('enters a reply for a pending item and rejects an unknown item', async () => {
    const agent = await adminAgent();
    const { batchId } = await seedBatch('2026-W52-admin-pending');
    const pendingId = await itemIdOf(batchId, '1000002');
    const entered = await agent
      .put(`/api/admin/zero-sales/batches/${batchId}/items/${pendingId}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'seasonal', reason_note: '店舖截單後 email 補交' });
    expect(entered.status).toBe(200);
    expect(entered.body.entered).toBe(true);
    const after = await getItem(batchId, '1000002');
    expect(after.status).toBe('replied');
    expect(after.reason_code).toBe('seasonal');
    expect(after.reason_note).toBe('店舖截單後 email 補交');
    expect(after.reply_count).toBe(1);
    expect(after.replied_by).toContain('管理員代填');
    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE event_type = 'zero_sales_reply_entered' AND actor_role = 'admin'`,
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);

    const missing = await agent
      .put(`/api/admin/zero-sales/batches/${batchId}/items/00000000-0000-4000-8000-000000000000/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'seasonal', reason_note: '' });
    expect(missing.status).toBe(400);
  });

  it('rejects unauthenticated and malformed requests', async () => {
    const { batchId } = await seedBatch('2026-W53-admin-auth');
    const anonAgent = request.agent(app) as Agent;
    const anonToken = await csrf(anonAgent);
    const anon = await anonAgent
      .put(`/api/admin/zero-sales/batches/${batchId}/items/00000000-0000-4000-8000-000000000000/reply`)
      .set('x-csrf-token', anonToken)
      .send({ reason_code: 'seasonal', reason_note: '' });
    expect(anon.status).toBe(401);
    const agent = await adminAgent();
    const badUuid = await agent
      .put(`/api/admin/zero-sales/batches/${batchId}/items/not-a-uuid/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'seasonal', reason_note: '' });
    expect(badUuid.status).toBe(400);
  });
});
