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
import { hashPassword } from '../src/services/portalAuth.js';
import {
  createBatch as createZeroSalesBatch,
  listBatches as listZeroSalesBatches,
  listMyBatches as listMyZeroSalesBatches,
  listMyItems as listMyZeroSalesItems,
  getZeroSalesSummary,
  deleteZeroSalesBatch,
} from '../src/services/zeroSales.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;
let w41Id = '';
let w42Id = '';
let w43Id = '';

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

async function storeAgent(site: string): Promise<Agent> {
  const agent = request.agent(app) as Agent;
  const token = await csrf(agent);
  const res = await agent
    .post('/api/portal/auth/login')
    .set('x-csrf-token', token)
    .send({ username: site, password: 'SASA1234' });
  expect(res.status).toBe(200);
  agent._csrf = await csrf(agent);
  return agent;
}

function seedBatch(weekLabel: string, rows: Array<{ siteCode: string; sku: string }>) {
  return createZeroSalesBatch({
    weekLabel,
    note: 'archive test',
    rows: rows.map((r) => ({ ...r, data: { Brand: 'B1' } })),
    contentHash: `hash-${weekLabel}-${Date.now()}-${Math.random()}`,
    createdBy: 'test',
  });
}

async function itemId(batchId: string, sku: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    'SELECT id FROM zero_sales_items WHERE batch_id = $1 AND sku = $2',
    [batchId, sku],
  );
  return r.rows[0]!.id as string;
}

async function batchState(batchId: string): Promise<{ closed_at: string | null; closed_by: string; close_reason: string }> {
  const r = await db.query<{ closed_at: string | null; closed_by: string; close_reason: string }>(
    'SELECT closed_at::text AS closed_at, closed_by, close_reason FROM zero_sales_batches WHERE id = $1',
    [batchId],
  );
  return r.rows[0]!;
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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql', '023_zero_sales_repeat_index.sql', '024_zero_sales_archive.sql', '025_zero_sales_auto_reply.sql', '026_shop_stock_snapshots.sql', '027_designated_sku_tasks.sql', '028_designated_sku_admin_edit.sql', '029_designated_sku_matters.sql', '030_designated_sku_due_at.sql', '031_zero_sales_no_reply.sql', '032_om_portal.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
  ]);
  const pwHash = await hashPassword('StoreTest1!ABCD');
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
     VALUES ('HA02', 'HA02', 'store', 'HA02', $1, false, true, 'test')
     ON CONFLICT (username) DO UPDATE SET active = true`,
    [pwHash],
  );
  app = createApp();

  // W41：兩個未回覆 SKU
  const w41 = await seedBatch('2026-W41-arch', [
    { siteCode: 'HA02', sku: 'A1' },
    { siteCode: 'HA02', sku: 'A2' },
  ]);
  w41Id = w41.batchId;
  // W42：再派 A1；上載 W42 時應自動封存 W41
  const w42 = await seedBatch('2026-W42-arch', [{ siteCode: 'HA02', sku: 'A1' }]);
  w42Id = w42.batchId;
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w41Id, '2026-09-01T00:00:00Z']);
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w42Id, '2026-09-08T00:00:00Z']);
});

describe('zero-sales 即時封存', () => {
  it('新批次上載時自動封存之前所有開放批次', async () => {
    const w41 = await batchState(w41Id);
    expect(w41.closed_at).toBeTruthy();
    expect(w41.closed_by).toBe('test');
    expect(w41.close_reason).toBe('auto');
    expect((await batchState(w42Id)).closed_at).toBeNull();

    const batches = await listZeroSalesBatches();
    expect(batches.find((b) => b.id === w41Id)?.is_open).toBe(false);
    expect(batches.find((b) => b.id === w42Id)?.is_open).toBe(true);
  });

  it('店舖回覆已封存週次 → 409 BATCH_CLOSED，資料不變', async () => {
    const agent = await storeAgent('HA02');
    const id = await itemId(w41Id, 'A1');
    const res = await agent
      .put(`/api/portal/zero-sales/items/${id}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'seasonal', reason_note: '' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BATCH_CLOSED');
    expect(res.body.error).toContain('2026-W41-arch');
    expect(res.body.error).toContain('已截止');

    const row = await db.query<{ status: string; reply_count: number }>(
      'SELECT status, reply_count FROM zero_sales_items WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ status: 'pending', reply_count: 0 });
  });

  it('店舖 API 回傳 is_open，舊週次標示為已封存', async () => {
    const agent = await storeAgent('HA02');
    const batches = await agent.get('/api/portal/zero-sales/batches');
    expect(batches.status).toBe(200);
    const w41 = batches.body.batches.find((b: { week_label: string }) => b.week_label === '2026-W41-arch');
    const w42 = batches.body.batches.find((b: { week_label: string }) => b.week_label === '2026-W42-arch');
    expect(w41.is_open).toBe(false);
    expect(w41.closed_at).toBeTruthy();
    expect(w42.is_open).toBe(true);

    const oldItems = await listMyZeroSalesItems('HA02', { batchId: w41Id });
    expect(oldItems).toHaveLength(2);
    expect(oldItems.every((i) => i.is_open === false)).toBe(true);
    const openItems = await listMyZeroSalesItems('HA02', { batchId: w42Id });
    expect(openItems.every((i) => i.is_open === true)).toBe(true);

    const myBatches = await listMyZeroSalesBatches('HA02');
    expect(myBatches.find((b) => b.id === w41Id)?.is_open).toBe(false);
    expect(myBatches.find((b) => b.id === w42Id)?.is_open).toBe(true);
  });

  it('管理員可手動封存及例外重開，並寫入審計', async () => {
    const agent = await adminAgent();
    const close = await agent
      .put(`/api/admin/zero-sales/batches/${w42Id}/close`)
      .set('x-csrf-token', agent._csrf ?? '');
    expect(close.status).toBe(200);
    expect(close.body.already_closed).toBe(false);
    expect(close.body.pending).toBe(1);

    const store = await storeAgent('HA02');
    const id = await itemId(w42Id, 'A1');
    const blocked = await store
      .put(`/api/portal/zero-sales/items/${id}/reply`)
      .set('x-csrf-token', store._csrf ?? '')
      .send({ reason_code: 'seasonal', reason_note: '' });
    expect(blocked.status).toBe(409);

    const reopen = await agent
      .put(`/api/admin/zero-sales/batches/${w42Id}/reopen`)
      .set('x-csrf-token', agent._csrf ?? '');
    expect(reopen.status).toBe(200);
    expect(reopen.body.already_open).toBe(false);

    const replied = await store
      .put(`/api/portal/zero-sales/items/${id}/reply`)
      .set('x-csrf-token', store._csrf ?? '')
      .send({ reason_code: 'seasonal', reason_note: '重開後補答' });
    expect(replied.status).toBe(200);
    expect(replied.body.item.status).toBe('replied');

    const audit = await db.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE event_type IN ('zero_sales_batch_closed', 'zero_sales_batch_reopened')`,
    );
    expect(audit.rows.map((r) => r.event_type).sort()).toEqual(['zero_sales_batch_closed', 'zero_sales_batch_reopened']);
  });

  it('跨批次統計：pending 只計開放週次，已封存的未回覆計入 overdue', async () => {
    // W43 上載後 W42 自動封存；W41 仍是逾期
    const w43 = await seedBatch('2026-W43-arch', [{ siteCode: 'HA02', sku: 'A9' }]);
    w43Id = w43.batchId;

    const cross = await getZeroSalesSummary();
    expect(cross.total).toBe(4);
    expect(cross.replied).toBe(1);
    expect(cross.pending).toBe(1); // 只有 W43 的 A9
    expect(cross.overdue).toBe(2); // W41 的 A1 / A2
    expect(cross.stores_total).toBe(1);
    expect(cross.stores_pending).toBe(1);
    expect(cross.stores_overdue).toBe(1);
    expect(cross.stores_done).toBe(0);
    // 總覽卡「最新週次」那一行所需的批次層級店舖數
    expect(cross.latest_batch?.week_label).toBe('2026-W43-arch');
    expect(cross.latest_batch?.total).toBe(1);
    expect(cross.latest_batch?.pending).toBe(1);
    expect(cross.latest_batch?.stores_total).toBe(1);
    expect(cross.latest_batch?.stores_pending).toBe(1);
    // 待回覆名單只含仍可回覆的 W43
    expect(cross.pending_by_store).toHaveLength(1);
    expect(cross.pending_by_store[0]!.total).toBe(1);
    expect(cross.pending_by_store[0]!.pending).toBe(1);

    // 指定批次時如實顯示該批歷史狀態（不把 pending 轉成 overdue）
    const scoped = await getZeroSalesSummary(w41Id);
    expect(scoped.total).toBe(2);
    expect(scoped.pending).toBe(2);
    expect(scoped.overdue).toBe(0);
  });

  it('刪除仍開放的批次會自動重開上一個已封存批次', async () => {
    const result = await deleteZeroSalesBatch(w43Id);
    expect(result?.reopenedWeekLabel).toBe('2026-W42-arch');
    expect((await batchState(w42Id)).closed_at).toBeNull();
    expect((await batchState(w41Id)).closed_at).toBeTruthy();

    const batches = await listZeroSalesBatches();
    expect(batches.find((b) => b.id === w43Id)).toBeUndefined();
    expect(batches.find((b) => b.id === w42Id)?.is_open).toBe(true);
  });

  it('已封存週次的未回覆行可由管理員代填（店舖 email 補交）', async () => {
    const agent = await adminAgent();
    const id = await itemId(w41Id, 'A2');
    const res = await agent
      .put(`/api/admin/zero-sales/batches/${w41Id}/items/${id}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'in_warehouse', reason_note: '店舖 10月20日 email 補交' });
    expect(res.status).toBe(200);
    expect(res.body.entered).toBe(true);

    const row = await db.query<{ status: string; replied_by: string; reply_count: number; reason_note: string }>(
      'SELECT status, replied_by, reply_count, reason_note FROM zero_sales_items WHERE id = $1',
      [id],
    );
    expect(row.rows[0]!.status).toBe('replied');
    expect(row.rows[0]!.replied_by).toContain('管理員代填');
    expect(row.rows[0]!.reply_count).toBe(1);
    expect(row.rows[0]!.reason_note).toBe('店舖 10月20日 email 補交');
  });
});
