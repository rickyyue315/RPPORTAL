import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles } from './migrateTest.js';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { replaceStores } from '../src/services/stores.js';
import { hashPassword } from '../src/services/portalAuth.js';
import { createBatch as createZeroSalesBatch } from '../src/services/zeroSales.js';

/* 測試憑證只供本機 PGlite 使用，不是真實密碼 */
const TEST_STORE_PASS = 'StoreTest1!ABCD';

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
    .send({ username: site, password: TEST_STORE_PASS });
  expect(res.status).toBe(200);
  agent._csrf = await csrf(agent);
  return agent;
}

function seedBatch(
  weekLabel: string,
  rows: Array<{ siteCode: string; sku: string }>,
  replyRequired = true,
) {
  return createZeroSalesBatch({
    weekLabel,
    note: 'reply stats test',
    rows: rows.map((r) => ({ ...r, data: { Brand: 'B1' } })),
    contentHash: `hash-${weekLabel}-${Date.now()}-${Math.random()}`,
    createdBy: 'test',
    replyRequired,
  });
}

async function itemId(batchId: string, sku: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    'SELECT id FROM zero_sales_items WHERE batch_id = $1 AND sku = $2',
    [batchId, sku],
  );
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
  const migrationFiles = await listMigrationFiles();
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
    { site_code: 'HB20', shop: '測試二店', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
  ]);
  const pwHash = await hashPassword(TEST_STORE_PASS);
  for (const site of ['HA02', 'HB20']) {
    await db.query(
      // initial_password 必須有值：resolveAuthMode() 只有「已派發密碼」的帳戶
      // 才走 per_user 驗證，否則會退回公司共用密碼 → 用測試密碼登入變 401。
      `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, initial_password, must_change_password, active, created_by)
       VALUES ($1, $1, 'store', $1, $2, $3, false, true, 'test')
       ON CONFLICT (username) DO UPDATE
         SET active = true, password_hash = EXCLUDED.password_hash, initial_password = EXCLUDED.initial_password`,
      [site, pwHash, TEST_STORE_PASS],
    );
  }
  app = createApp();

  // W41：兩個 SKU，店舖只回覆 A1 → 封存後變成「部分沒回覆」
  const w41 = await seedBatch('2026-W41-stats', [
    { siteCode: 'HA02', sku: 'A1' },
    { siteCode: 'HA02', sku: 'A2' },
  ]);
  w41Id = w41.batchId;
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w41Id, '2026-09-01T00:00:00Z']);

  const store = await storeAgent('HA02');
  const a1 = await itemId(w41Id, 'A1');
  const replied = await store
    .put(`/api/portal/zero-sales/items/${a1}/reply`)
    .set('x-csrf-token', store._csrf ?? '')
    .send({ reason_code: 'seasonal', reason_note: '' });
  expect(replied.status).toBe(200);

  // W42：再派 HA02 一個從未回覆過的 SKU（自動封存 W41）＋ 另一店 HB20，
  // 兩店都完全沒有回覆。這裡刻意不用 A1 —— A1 在 W41 已回覆過，重複上榜會
  // 被 createBatch 自動套用上次回覆，W42 就變成「已回覆」而不是「完全沒回覆」。
  const w42 = await seedBatch('2026-W42-stats', [
    { siteCode: 'HA02', sku: 'A4' },
    { siteCode: 'HB20', sku: 'B1' },
  ]);
  w42Id = w42.batchId;
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w42Id, '2026-09-08T00:00:00Z']);

  // W43：「本週無須回覆」（自動封存 W42，W42 的未回覆從此定案）
  const w43 = await seedBatch('2026-W43-stats', [{ siteCode: 'HA02', sku: 'A3' }], false);
  w43Id = w43.batchId;
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w43Id, '2026-09-15T00:00:00Z']);
});

describe('店舖沒有回覆次數統計', () => {
  it('未登入不可讀取', async () => {
    const res = await request(app).get('/api/portal/zero-sales/reply-stats');
    expect(res.status).toBe(401);
  });

  it('只計已封存週次：部分沒回覆與完全沒回覆都算 1 次', async () => {
    const agent = await storeAgent('HA02');
    const res = await agent.get('/api/portal/zero-sales/reply-stats');
    expect(res.status).toBe(200);
    expect(res.body.site_code).toBe('HA02');

    const byWeek = Object.fromEntries(
      (res.body.weeks as Array<{ week_label: string }>).map((w) => [w.week_label, w]),
    ) as Record<string, {
      status: string; is_archived: boolean; total: number; replied: number; pending: number; date: string;
    }>;

    // 新到舊
    expect(res.body.weeks.map((w: { week_label: string }) => w.week_label))
      .toEqual(['2026-W43-stats', '2026-W42-stats', '2026-W41-stats']);

    expect(byWeek['2026-W41-stats']).toMatchObject({ status: 'partial', is_archived: true, total: 2, replied: 1, pending: 1 });
    expect(byWeek['2026-W42-stats']).toMatchObject({ status: 'missed', is_archived: true, total: 1, replied: 0, pending: 1 });
    // 「本週無須回覆」：不計入次數，狀態獨立
    expect(byWeek['2026-W43-stats']).toMatchObject({ status: 'not_required', is_archived: false });
    expect(byWeek['2026-W41-stats'].date).toBe('2026-09-01');

    expect(res.body.summary).toMatchObject({
      window_weeks: 3,
      finalized_weeks: 2,
      missed_weeks: 2,
      missed_full_weeks: 1,
      missed_partial_weeks: 1,
      replied_weeks: 0,
      streak: 2,
      items_required: 3,
      items_replied: 1,
      items_missed: 2,
      last_missed_week: '2026-W42-stats',
      last_missed_date: '2026-09-08',
      open_week: '',
      open_pending: 0,
      open_total: 0,
    });
    expect(res.body.summary.reply_rate).toBeCloseTo(1 / 3, 6);
  });

  it('未封存的最新一週只顯示待回覆，不算沒回覆次數', async () => {
    // 重新開啟 W42，模擬「最新一週仍可回覆」
    await db.query('UPDATE zero_sales_batches SET closed_at = NULL WHERE id = $1', [w42Id]);
    const agent = await storeAgent('HA02');
    const res = await agent.get('/api/portal/zero-sales/reply-stats');
    expect(res.status).toBe(200);

    const w42 = (res.body.weeks as Array<{ week_label: string; status: string }>)
      .find((w) => w.week_label === '2026-W42-stats');
    expect(w42?.status).toBe('open_pending');
    expect(res.body.summary.missed_weeks).toBe(1); // 只剩 W41
    expect(res.body.summary.open_week).toBe('2026-W42-stats');
    expect(res.body.summary.open_pending).toBe(1);
    expect(res.body.summary.open_total).toBe(1);

    await db.query("UPDATE zero_sales_batches SET closed_at = now(), close_reason = 'manual' WHERE id = $1", [w42Id]);
  });

  it('每間店只看自己的紀錄', async () => {
    const agent = await storeAgent('HB20');
    const res = await agent.get('/api/portal/zero-sales/reply-stats');
    expect(res.status).toBe(200);
    expect(res.body.site_code).toBe('HB20');
    expect(res.body.weeks.map((w: { week_label: string }) => w.week_label)).toEqual(['2026-W42-stats']);
    expect(res.body.summary).toMatchObject({
      finalized_weeks: 1,
      missed_weeks: 1,
      missed_full_weeks: 1,
      streak: 1,
      items_required: 1,
      items_missed: 1,
    });
    expect(res.body.summary.reply_rate).toBe(0);
  });

  it('管理員代填後統計即時改善（最終沒有回覆才算）', async () => {
    const agent = await adminAgent();
    const a2 = await itemId(w41Id, 'A2');
    const res = await agent
      .put(`/api/admin/zero-sales/batches/${w41Id}/items/${a2}/reply`)
      .set('x-csrf-token', agent._csrf ?? '')
      .send({ reason_code: 'in_warehouse', reason_note: '店舖補交' });
    expect(res.status).toBe(200);

    const store = await storeAgent('HA02');
    const stats = await store.get('/api/portal/zero-sales/reply-stats');
    expect(stats.body.summary.missed_weeks).toBe(1);
    expect(stats.body.summary.missed_partial_weeks).toBe(0);
    expect(stats.body.summary.replied_weeks).toBe(1);
    expect(stats.body.summary.items_missed).toBe(1);
    expect(stats.body.summary.reply_rate).toBeCloseTo(2 / 3, 6);
    expect(stats.body.summary.streak).toBe(1);
  });
});
