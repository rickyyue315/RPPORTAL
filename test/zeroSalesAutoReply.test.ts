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
import {
  createBatch as createZeroSalesBatch,
  listMyItems as listZeroSalesMyItems,
  autoFillZeroSalesReplies,
  replyItem as replyZeroSalesItem,
  ZeroSalesReplyError,
} from '../src/services/zeroSales.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;
let w41Id = '';
let w42Id = '';
let w43Id = '';
let w44Id = '';

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

async function seed(
  weekLabel: string,
  rows: Array<{ siteCode: string; sku: string; data?: Record<string, string> }>,
  createdAt: string,
  opts: { autoFillRepeats?: boolean } = {},
) {
  const result = await createZeroSalesBatch({
    weekLabel,
    note: 'test',
    rows: rows.map((r) => ({ siteCode: r.siteCode, sku: r.sku, data: r.data ?? {} })),
    contentHash: `hash-${weekLabel}-${Date.now()}-${Math.random()}`,
    createdBy: 'test',
    autoFillRepeats: opts.autoFillRepeats,
  });
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [result.batchId, createdAt]);
  return result;
}

async function markReplied(
  batchId: string,
  siteCode: string,
  sku: string,
  opts: { reasonCode?: string; reasonLabel?: string; note?: string; replyCount?: number } = {},
) {
  await db.query(
    `UPDATE zero_sales_items
        SET status = 'replied', reason_code = $3, reason_label = $4, reason_note = $5,
            replied_at = now(), replied_by = '測試店舖', reply_count = $6
      WHERE batch_id = $1 AND site_code = $2 AND sku = $7`,
    [
      batchId,
      siteCode,
      opts.reasonCode ?? 'seasonal',
      opts.reasonLabel ?? '4.季節性/非當季產品',
      opts.note ?? '',
      opts.replyCount ?? 1,
      sku,
    ],
  );
}

async function itemIdOf(batchId: string, siteCode: string, sku: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    'SELECT id FROM zero_sales_items WHERE batch_id = $1 AND site_code = $2 AND sku = $3',
    [batchId, siteCode, sku],
  );
  return r.rows[0]!.id;
}

async function getItem(batchId: string, siteCode: string, sku: string) {
  const r = await db.query<{
    status: string;
    reason_code: string | null;
    reason_note: string;
    reply_count: number;
    reply_limit: number;
    auto_filled_at: string | null;
    auto_filled_from_week: string;
    replied_by: string | null;
  }>(
    `SELECT status, reason_code, reason_note, reply_count, reply_limit,
            auto_filled_at::text AS auto_filled_at, auto_filled_from_week, replied_by
       FROM zero_sales_items WHERE batch_id = $1 AND site_code = $2 AND sku = $3`,
    [batchId, siteCode, sku],
  );
  return r.rows[0]!;
}

function repliedByStore(itemId: string, reasonCode: string, reasonNote = '') {
  return replyZeroSalesItem({
    itemId,
    siteCode: 'HA02',
    reasonCode,
    reasonNote,
    repliedBy: 'HA02',
    repliedByUserId: '00000000-0000-4000-8000-000000000001',
  });
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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql', '023_zero_sales_repeat_index.sql', '024_zero_sales_archive.sql', '025_zero_sales_auto_reply.sql', '026_shop_stock_snapshots.sql'];
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

  // W41：HA02 A1 已回覆、A2 未回覆；HA06 A1 已回覆
  const w41 = await seed('2026-W41-auto', [
    { siteCode: 'HA02', sku: 'A1' },
    { siteCode: 'HA02', sku: 'A2' },
    { siteCode: 'HA06', sku: 'A1' },
  ], '2026-09-01T00:00:00Z');
  w41Id = w41.batchId;
  await markReplied(w41Id, 'HA02', 'A1', { reasonCode: 'seasonal', note: '上週話季節性' });
  await markReplied(w41Id, 'HA06', 'A1', { reasonCode: 'in_warehouse', reasonLabel: '2.貨放舖倉未上架', note: 'HA06 上週貨放舖倉' });

  // W42：A1 重複（HA02 + HA06）→ 自動套用；A2 上次未回覆、B1 新 SKU → 保持 pending
  const w42 = await seed('2026-W42-auto', [
    { siteCode: 'HA02', sku: 'A1' },
    { siteCode: 'HA02', sku: 'A2' },
    { siteCode: 'HA06', sku: 'A1' },
    { siteCode: 'HA02', sku: 'B1' },
  ], '2026-09-08T00:00:00Z');
  w42Id = w42.batchId;
  expect(w42.autoFilled).toBe(2);
});

describe('zero-sales auto apply previous reply', () => {
  it('copies the previous reply for repeat SKUs and leaves other rows pending', async () => {
    const ha02A1 = await getItem(w42Id, 'HA02', 'A1');
    expect(ha02A1.status).toBe('replied');
    expect(ha02A1.reason_code).toBe('seasonal');
    expect(ha02A1.reason_note).toBe('上週話季節性');
    expect(ha02A1.reply_count).toBe(1);
    expect(ha02A1.reply_limit).toBe(3);
    expect(ha02A1.auto_filled_at).toBeTruthy();
    expect(ha02A1.auto_filled_from_week).toBe('2026-W41-auto');
    expect(ha02A1.replied_by).toContain('系統自動套用');

    const ha06A1 = await getItem(w42Id, 'HA06', 'A1');
    expect(ha06A1.status).toBe('replied');
    expect(ha06A1.reason_code).toBe('in_warehouse');
    expect(ha06A1.auto_filled_from_week).toBe('2026-W41-auto');

    expect((await getItem(w42Id, 'HA02', 'A2')).status).toBe('pending');
    expect((await getItem(w42Id, 'HA02', 'B1')).status).toBe('pending');
  });

  it('exposes auto_filled / reply_limit to the store API payload and puts pending SKUs first', async () => {
    const items = await listZeroSalesMyItems('HA02', { batchId: w42Id });
    // 未回覆 A2 / B1 排在已回覆（自動套用）A1 之前
    expect(items.map((i) => i.sku)).toEqual(['A2', 'B1', 'A1']);
    const auto = items.find((i) => i.sku === 'A1')!;
    expect(auto.auto_filled).toBe(true);
    expect(auto.reply_limit).toBe(3);
    expect(auto.auto_filled_from_week).toBe('2026-W41-auto');
    const fresh = items.find((i) => i.sku === 'A2')!;
    expect(fresh.auto_filled).toBe(false);
    expect(fresh.reply_limit).toBe(2);
  });

  it('allows two modifications on an auto-filled row, then locks it', async () => {
    const itemId = await itemIdOf(w42Id, 'HA02', 'A1');
    const first = await repliedByStore(itemId, 'no_display', '第一次修改');
    expect(first.reply_count).toBe(2);
    expect(first.auto_filled).toBe(false);
    expect((await getItem(w42Id, 'HA02', 'A1')).auto_filled_at).toBeNull();

    const second = await repliedByStore(itemId, 'in_warehouse', '第二次修改');
    expect(second.reply_count).toBe(3);

    await expect(repliedByStore(itemId, 'price_promo', '第三次')).rejects.toBeInstanceOf(ZeroSalesReplyError);
    const after = await getItem(w42Id, 'HA02', 'A1');
    expect(after.reason_code).toBe('in_warehouse');
    expect(after.reply_count).toBe(3);
  });

  it('keeps the original limit of one modification for non-auto rows', async () => {
    const itemId = await itemIdOf(w42Id, 'HA02', 'A2');
    const first = await repliedByStore(itemId, 'seasonal', '首次回覆');
    expect(first.reply_count).toBe(1);
    const second = await repliedByStore(itemId, 'no_display', '修改一次');
    expect(second.reply_count).toBe(2);
    await expect(repliedByStore(itemId, 'price_promo', '再改')).rejects.toBeInstanceOf(ZeroSalesReplyError);
  });

  it('skips auto-fill when the previous reason has been deactivated', async () => {
    await db.query(
      `INSERT INTO zero_sales_reasons (code, label, sort_order, active, require_note, updated_by)
       VALUES ('temp_reason', '9.臨時原因', 9, true, false, 'test')
       ON CONFLICT (code) DO UPDATE SET active = true`,
    );
    await markReplied(w42Id, 'HA02', 'B1', { reasonCode: 'temp_reason', reasonLabel: '9.臨時原因', note: '舊原因' });
    await db.query(`UPDATE zero_sales_reasons SET active = false WHERE code = 'temp_reason'`);

    const w43 = await seed('2026-W43-auto', [{ siteCode: 'HA02', sku: 'B1' }], '2026-09-15T00:00:00Z');
    w43Id = w43.batchId;
    expect(w43.autoFilled).toBe(0);
    const item = await getItem(w43Id, 'HA02', 'B1');
    expect(item.status).toBe('pending');
    expect(item.auto_filled_at).toBeNull();
  });
});

describe('zero-sales auto apply backfill for an existing week', () => {
  it('with onlyUnrepliedStores keeps already-replied shops untouched, then can include them explicitly', async () => {
    // W44：HA02 在「本批次」已有人手回覆（B2），HA06 在本批次完全未回覆
    const w44 = await seed('2026-W44-auto', [
      { siteCode: 'HA02', sku: 'A2' },
      { siteCode: 'HA02', sku: 'B2' },
      { siteCode: 'HA06', sku: 'A1' },
    ], '2026-09-22T00:00:00Z', { autoFillRepeats: false });
    w44Id = w44.batchId;
    expect(w44.autoFilled).toBe(0);
    await markReplied(w44Id, 'HA02', 'B2', { reasonCode: 'seasonal', note: 'HA02 本週已自行回覆' });

    const first = await autoFillZeroSalesReplies(w44Id, { onlyUnrepliedStores: true });
    expect(first).toMatchObject({ applied: 1, pending_before: 2, remaining_pending: 1 });
    expect((await getItem(w44Id, 'HA06', 'A1')).status).toBe('replied');
    expect((await getItem(w44Id, 'HA06', 'A1')).auto_filled_from_week).toBe('2026-W42-auto');
    expect((await getItem(w44Id, 'HA02', 'A2')).status).toBe('pending');

    const second = await autoFillZeroSalesReplies(w44Id, { onlyUnrepliedStores: false });
    expect(second).toMatchObject({ applied: 1, pending_before: 1, remaining_pending: 0 });
    expect((await getItem(w44Id, 'HA02', 'A2')).status).toBe('replied');
    expect((await getItem(w44Id, 'HA02', 'A2')).auto_filled_from_week).toBe('2026-W42-auto');
  });

  it('exposes the admin backfill endpoint and writes an audit event', async () => {
    const agent = await adminAgent();
    const res = await agent
      .post(`/api/admin/zero-sales/batches/${w44Id}/auto-fill`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ only_unreplied_stores: true });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(0);
    expect(res.body.remaining_pending).toBe(0);

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE event_type = 'zero_sales_auto_filled' AND actor_role = 'admin'`,
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);

    const anon = request.agent(app) as Agent;
    const token = await csrf(anon);
    const denied = await anon
      .post(`/api/admin/zero-sales/batches/${w44Id}/auto-fill`)
      .set('x-csrf-token', token)
      .send({ only_unreplied_stores: true });
    expect(denied.status).toBe(401);

    const missing = await agent
      .post('/api/admin/zero-sales/batches/00000000-0000-4000-8000-000000000000/auto-fill')
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ only_unreplied_stores: true });
    expect(missing.status).toBe(404);
  });
});

// Keep the TS compiler aware that w41Id / w43Id are used for traceability in this fixture.
void w41Id;
void w43Id;
