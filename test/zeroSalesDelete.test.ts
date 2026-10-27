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
      { siteCode: 'HA06', sku: '1000004', data: { Brand: 'B2' } },
    ],
    contentHash: `hash-${weekLabel}-${Date.now()}-${Math.random()}`,
    createdBy: 'test',
  });
}

async function batchCounters(batchId: string) {
  const r = await db.query<{ row_count: number; store_count: number }>(
    'SELECT row_count, store_count FROM zero_sales_batches WHERE id = $1',
    [batchId],
  );
  return r.rows[0];
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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql', '023_zero_sales_repeat_index.sql', '024_zero_sales_archive.sql', '025_zero_sales_auto_reply.sql', '026_shop_stock_snapshots.sql', '027_designated_sku_tasks.sql', '028_designated_sku_admin_edit.sql', '029_designated_sku_matters.sql', '030_designated_sku_due_at.sql', '031_zero_sales_no_reply.sql'];
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

describe('zero-sales delete (batch / batch-site / batch-item)', () => {
  it('deletes a single SKU row and refreshes batch counters', async () => {
    const agent = await adminAgent();
    const { batchId } = await seedBatch('2026-W40-del-item');
    const items = await db.query<{ id: string }>(
      `SELECT id FROM zero_sales_items WHERE batch_id = $1 AND site_code = 'HA02' AND sku = '1000001'`,
      [batchId],
    );
    const itemId = items.rows[0]!.id as string;
    const res = await agent
      .delete(`/api/admin/zero-sales/batches/${batchId}/items/${itemId}`)
      .set('x-csrf-token', agent._csrf ?? '');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const remaining = await db.query('SELECT count(*)::text AS count FROM zero_sales_items WHERE batch_id = $1', [batchId]);
    expect(Number((remaining.rows[0] as { count: string }).count)).toBe(3);
    const counters = await batchCounters(batchId);
    expect(counters?.row_count).toBe(3);
    expect(counters?.store_count).toBe(2);
  });

  it('deletes all rows of one site within a batch without touching other sites', async () => {
    const agent = await adminAgent();
    const { batchId } = await seedBatch('2026-W41-del-site');
    const res = await agent
      .delete(`/api/admin/zero-sales/batches/${batchId}/sites/HA02`)
      .set('x-csrf-token', agent._csrf ?? '');
    expect(res.status).toBe(200);
    expect(res.body.deleted_items).toBe(2);
    const ha02 = await db.query('SELECT count(*)::text AS count FROM zero_sales_items WHERE batch_id = $1 AND site_code = $2', [batchId, 'HA02']);
    expect(Number((ha02.rows[0] as { count: string }).count)).toBe(0);
    const ha06 = await db.query('SELECT count(*)::text AS count FROM zero_sales_items WHERE batch_id = $1 AND site_code = $2', [batchId, 'HA06']);
    expect(Number((ha06.rows[0] as { count: string }).count)).toBe(2);
    const counters = await batchCounters(batchId);
    expect(counters?.row_count).toBe(2);
    expect(counters?.store_count).toBe(1);
  });

  it('deletes a whole batch including replied rows via cascade', async () => {
    const agent = await adminAgent();
    const { batchId } = await seedBatch('2026-W42-del-batch');
    await db.query(
      `UPDATE zero_sales_items SET status = 'replied', reason_code = 'other', reason_label = '6.其他', reply_count = 1
        WHERE batch_id = $1 AND site_code = 'HA02' AND sku = '1000001'`,
      [batchId],
    );
    const res = await agent
      .delete(`/api/admin/zero-sales/batches/${batchId}`)
      .set('x-csrf-token', agent._csrf ?? '');
    expect(res.status).toBe(200);
    expect(res.body.deleted_items).toBe(4);
    const batch = await db.query('SELECT id FROM zero_sales_batches WHERE id = $1', [batchId]);
    expect(batch.rows.length).toBe(0);
    const items = await db.query('SELECT count(*)::text AS count FROM zero_sales_items WHERE batch_id = $1', [batchId]);
    expect(Number((items.rows[0] as { count: string }).count)).toBe(0);
  });

  it('returns 404 for unknown batch, empty site, and already-deleted item', async () => {
    const agent = await adminAgent();
    const { batchId } = await seedBatch('2026-W43-del-404');
    const missing = '00000000-0000-4000-8000-000000000000';
    const r1 = await agent
      .delete(`/api/admin/zero-sales/batches/${missing}`)
      .set('x-csrf-token', agent._csrf ?? '');
    expect(r1.status).toBe(404);
    const r2 = await agent
      .delete(`/api/admin/zero-sales/batches/${batchId}/sites/ZZ99`)
      .set('x-csrf-token', agent._csrf ?? '');
    expect(r2.status).toBe(404);
    const items = await db.query<{ id: string }>(`SELECT id FROM zero_sales_items WHERE batch_id = $1 LIMIT 1`, [batchId]);
    const itemId = items.rows[0]!.id as string;
    const r3 = await agent
      .delete(`/api/admin/zero-sales/batches/${batchId}/items/${itemId}`)
      .set('x-csrf-token', agent._csrf ?? '');
    expect(r3.status).toBe(200);
    const r4 = await agent
      .delete(`/api/admin/zero-sales/batches/${batchId}/items/${itemId}`)
      .set('x-csrf-token', agent._csrf ?? '');
    expect(r4.status).toBe(404);
  });

  it('rejects malformed UUIDs and unauthenticated access', async () => {
    const agent = await adminAgent();
    const bad = await agent
      .delete('/api/admin/zero-sales/batches/not-a-uuid')
      .set('x-csrf-token', agent._csrf ?? '');
    expect(bad.status).toBe(400);
    // CSRF runs before the session check: a valid CSRF pair without a login
    // reaches requireAdmin and gets 401 (same convention as api.test.ts).
    const anonAgent = request.agent(app) as Agent;
    const anonToken = await csrf(anonAgent);
    const anon = await anonAgent
      .delete('/api/admin/zero-sales/batches/00000000-0000-4000-8000-000000000000')
      .set('x-csrf-token', anonToken);
    expect(anon.status).toBe(401);
  });
});
