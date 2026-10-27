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
import { createPortalSession, hashPassword } from '../src/services/portalAuth.js';
import {
  createBatch as createZeroSalesBatch,
  getZeroSalesSummary,
  listBatches as listZeroSalesBatches,
  listBatchItems,
  listMyBatches as listMyZeroSalesBatches,
  listMyItems as listMyZeroSalesItems,
  listZeroSalesPendingStores,
  reopenZeroSalesBatch,
  replyItem,
  setZeroSalesBatchReplyRequired,
  ZeroSalesReplyNotRequiredError,
  autoFillZeroSalesReplies,
} from '../src/services/zeroSales.js';

/* 測試憑證只供本機 PGlite 使用，不是真實密碼 */
const TEST_STORE_PASS = 'StoreTest1!ABCD';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;
/** 需要回覆的對照週次（W41） */
let w41Id = '';
/** 本週無須回覆（W42，最新） */
let w42Id = '';
/** 店舖 Cookie（直接建立 session，不經登入流程） */
let storeCookie = '';
let storeCsrf = '';

/** 一條 cookie header 內同時帶 portal session + csrf cookie */
async function issueCsrf(): Promise<{ cookie: string; token: string }> {
  const res = await request(app).get('/api/csrf');
  const setCookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  return { cookie, token: res.body.token ?? res.body.csrfToken ?? '' };
}

async function storeSession(siteCode: string): Promise<{ cookie: string; csrf: string }> {
  const found = await db.query<{ id: string }>(
    `SELECT id FROM portal_users WHERE role = 'store' AND site_code = $1 LIMIT 1`,
    [siteCode],
  );
  const session = await createPortalSession(found.rows[0]!.id);
  const { cookie, token } = await issueCsrf();
  return { cookie: `portal_session=${session.token}; ${cookie}`, csrf: token };
}

function seedBatch(
  weekLabel: string,
  rows: Array<{ siteCode: string; sku: string }>,
  opts: { replyRequired?: boolean; replyNotice?: string; autoFillRepeats?: boolean } = {},
) {
  return createZeroSalesBatch({
    weekLabel,
    note: 'no-reply test',
    rows: rows.map((r) => ({ ...r, data: { Brand: 'B1' } })),
    contentHash: `hash-${weekLabel}-${Date.now()}-${Math.random()}`,
    createdBy: 'test',
    autoFillRepeats: false,
    ...opts,
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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql', '015_buyer_auto_approve.sql', '016_round_started_at.sql', '017_zero_sales.sql', '018_zero_sales_reasons.sql', '019_zero_sales_edit_once.sql', '020_portal_users_initial_password.sql', '021_store_passwordless.sql', '022_portal_passwordless.sql', '023_zero_sales_repeat_index.sql', '024_zero_sales_archive.sql', '025_zero_sales_auto_reply.sql', '026_shop_stock_snapshots.sql', '027_designated_sku_tasks.sql', '028_designated_sku_admin_edit.sql', '029_designated_sku_matters.sql', '030_designated_sku_due_at.sql', '031_zero_sales_no_reply.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
  ]);
  const pwHash = await hashPassword(TEST_STORE_PASS);
  await db.query(
    `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
     VALUES ('HA02', 'HA02', 'store', 'HA02', $1, false, true, 'test')
     ON CONFLICT (username) DO UPDATE SET active = true`,
    [pwHash],
  );
  app = createApp();

  // W41：正常需要回覆的週次（用來確認待回覆統計仍然運作）
  const w41 = await seedBatch('2026-W41-noreply-test', [
    { siteCode: 'HA02', sku: 'A1' },
    { siteCode: 'HA02', sku: 'A2' },
  ]);
  w41Id = w41.batchId;
  // W42：本週無須回覆（上載時已帶旗標）；上載時會自動封存 W41
  const w42 = await seedBatch(
    '2026-W42-noreply-test',
    [{ siteCode: 'HA02', sku: 'B1' }, { siteCode: 'HA02', sku: 'B2' }],
    { replyRequired: false, replyNotice: '本週銷售繁忙期，無須回覆；請優先銷售以下 SKU。' },
  );
  w42Id = w42.batchId;
  // 重開 W41：模擬「仍有待回覆的正常週次」與「無須回覆的最新週次」並存
  await reopenZeroSalesBatch(w41Id);
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w41Id, '2026-09-01T00:00:00Z']);
  await db.query('UPDATE zero_sales_batches SET created_at = $2 WHERE id = $1', [w42Id, '2026-09-08T00:00:00Z']);

  const s = await storeSession('HA02');
  storeCookie = s.cookie;
  storeCsrf = s.csrf;
});

describe('zero-sales 本週無須回覆', () => {
  it('批次／行回傳 reply_required=false，且 is_open=false 但未封存', async () => {
    const batches = await listZeroSalesBatches();
    const w42 = batches.find((b) => b.id === w42Id)!;
    expect(w42.reply_required).toBe(false);
    expect(w42.is_archived).toBe(false);
    expect(w42.is_open).toBe(false); // 未封存但不可回覆
    expect(w42.reply_notice).toContain('銷售繁忙期');

    const rows = await listBatchItems(w42Id, {});
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.reply_required === false)).toBe(true);
    expect(rows.every((r) => r.is_open === false)).toBe(true);
  });

  it('店舖不可回覆，回 409 REPLY_NOT_REQUIRED（資料不變）', async () => {
    const id = await itemId(w42Id, 'B1');
    const res = await request(app)
      .put(`/api/portal/zero-sales/items/${id}/reply`)
      .set('Cookie', storeCookie)
      .set('x-csrf-token', storeCsrf)
      .send({ reason_code: 'seasonal', reason_note: '' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REPLY_NOT_REQUIRED');
    expect(res.body.error).toContain('2026-W42-noreply-test');
    expect(res.body.error).toContain('無須回覆');

    const row = await db.query<{ status: string; reply_count: number }>(
      'SELECT status, reply_count FROM zero_sales_items WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ status: 'pending', reply_count: 0 });
  });

  it('店舖直接呼叫服務層亦會被擋（不依賴 HTTP）', async () => {
    const id = await itemId(w42Id, 'B2');
    await expect(replyItem({
      itemId: id,
      siteCode: 'HA02',
      reasonCode: 'seasonal',
      reasonNote: '',
      repliedBy: 'HA02',
      repliedByUserId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toBeInstanceOf(ZeroSalesReplyNotRequiredError);
  });

  it('店舖週次清單：pending 顯示 0、帶 reply_required 與說明', async () => {
    const res = await request(app)
      .get('/api/portal/zero-sales/batches')
      .set('Cookie', storeCookie);
    expect(res.status).toBe(200);
    const w42 = res.body.batches.find((b: { week_label: string }) => b.week_label === '2026-W42-noreply-test');
    expect(w42.reply_required).toBe(false);
    expect(w42.is_archived).toBe(false);
    expect(w42.pending).toBe(0);
    expect(w42.total).toBe(2);
    expect(w42.reply_notice).toContain('銷售繁忙期');

    const items = await listMyZeroSalesItems('HA02', { batchId: w42Id });
    expect(items.every((i) => i.reply_required === false)).toBe(true);
  });

  it('統計：無須回覆的行不計入待回覆／逾期，亦不計入回覆率', async () => {
    const summary = await getZeroSalesSummary();
    // 只有 W41 的 2 行屬待回覆
    expect(summary.pending).toBe(2);
    expect(summary.overdue).toBe(0);
    expect(summary.no_reply).toBe(2);
    expect(summary.no_reply_batches).toBe(1);
    // 總行數 4（2 需回覆 + 2 無須回覆），回覆率分母只計 2 行
    expect(summary.total).toBe(4);
    expect(summary.reply_rate).toBe(0);
    expect(summary.latest_batch?.reply_required).toBe(false);
    expect(summary.latest_batch?.pending).toBe(0);

    const latestScope = await getZeroSalesSummary(w42Id);
    expect(latestScope.pending).toBe(0);
    expect(latestScope.overdue).toBe(0);
    expect(latestScope.no_reply).toBe(2);
  });

  it('待回覆店舖名單不會包含無須回覆的週次', async () => {
    const pending = await listZeroSalesPendingStores({});
    // HA02 只有 W41 兩行待回覆，W42 不應被計入
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ site_code: 'HA02', pending: 2, total: 2 });
    expect(await listZeroSalesPendingStores({ batchId: w42Id })).toHaveLength(0);
  });

  it('封存「無須回覆」的週次不會產生逾期', async () => {
    // 直接改 DB 模擬封存，避免依賴封存流程
    await db.query(`UPDATE zero_sales_batches SET closed_at = now(), close_reason = 'manual' WHERE id = $1`, [w42Id]);
    const summary = await getZeroSalesSummary();
    expect(summary.overdue).toBe(0);
    expect(summary.no_reply).toBe(2);
    // 還原：週次維持開放（未封存），方便後續測試
    await db.query(`UPDATE zero_sales_batches SET closed_at = NULL, close_reason = '' WHERE id = $1`, [w42Id]);
  });

  it('管理員切回「需要回覆」後，店舖可正常回覆', async () => {
    const first = await setZeroSalesBatchReplyRequired({
      batchId: w42Id,
      replyRequired: true,
      actor: 'admin',
    });
    expect(first?.replyRequired).toBe(true);
    expect(first?.notice).toContain('銷售繁忙期'); // 只切換開關時保留原說明

    const list = await listMyZeroSalesBatches('HA02');
    const w42 = list.find((b) => b.id === w42Id)!;
    expect(w42.reply_required).toBe(true);
    expect(w42.is_open).toBe(true);
    expect(w42.pending).toBe(2);

    const id = await itemId(w42Id, 'B1');
    const replied = await request(app)
      .put(`/api/portal/zero-sales/items/${id}/reply`)
      .set('Cookie', storeCookie)
      .set('x-csrf-token', storeCsrf)
      .send({ reason_code: 'seasonal', reason_note: '恢復後回覆' });
    expect(replied.status).toBe(200);
    expect(replied.body.item.status).toBe('replied');
  });

  it('再設為無須回覆：已提交的回覆保留，只封住新回覆', async () => {
    const result = await setZeroSalesBatchReplyRequired({
      batchId: w42Id,
      replyRequired: false,
      notice: '',
      actor: 'admin',
    });
    expect(result?.replyRequired).toBe(false);
    expect(result?.replied).toBe(1);

    const rows = await listBatchItems(w42Id, {});
    expect(rows.find((r) => r.sku === 'B1')?.status).toBe('replied');
    expect(rows.find((r) => r.sku === 'B2')?.status).toBe('pending');

    // 已回覆的行亦不可再改
    const id = await itemId(w42Id, 'B1');
    await expect(replyItem({
      itemId: id,
      siteCode: 'HA02',
      reasonCode: 'other',
      reasonNote: '再改',
      repliedBy: 'HA02',
      repliedByUserId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toBeInstanceOf(ZeroSalesReplyNotRequiredError);
  });

  it('無須回覆的週次不可自動套用重複回覆', async () => {
    await expect(autoFillZeroSalesReplies(w42Id, { onlyUnrepliedStores: false })).rejects.toThrow(/無須回覆/);
  });

  it('上載「本週無須回覆」時不會自動套用重複回覆', async () => {
    // W43：同一 SKU B1（上一週已回覆），但設為無須回覆 → 不應套用
    const w43 = await seedBatch('2026-W43-noreply-test', [{ siteCode: 'HA02', sku: 'B1' }], {
      replyRequired: false,
      autoFillRepeats: true,
    });
    expect(w43.autoFilled).toBe(0);
    const rows = await listBatchItems(w43.batchId, {});
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.auto_filled_at ?? null).toBeNull();
  });

  it('管理員 API：PUT /reply-required 切換並寫入審計', async () => {
    const w44 = await seedBatch('2026-W44-noreply-test', [{ siteCode: 'HA02', sku: 'C1' }]);
    const agent = request.agent(app);
    const token0 = await agent.get('/api/csrf');
    const csrf0 = token0.body.token ?? token0.body.csrfToken;
    const login = await agent
      .post('/api/admin/login')
      .set('x-csrf-token', csrf0)
      .send({ username: 'admin', password: 'test-password' });
    expect(login.status).toBe(200);
    const token1 = await agent.get('/api/csrf');
    const csrf1 = token1.body.token ?? token1.body.csrfToken;

    const res = await agent
      .put(`/api/admin/zero-sales/batches/${w44.batchId}/reply-required`)
      .set('x-csrf-token', csrf1)
      .send({ reply_required: false, notice: '旺季不用回覆' });
    expect(res.status).toBe(200);
    expect(res.body.reply_required).toBe(false);
    expect(res.body.notice).toBe('旺季不用回覆');
    expect(res.body.changed).toBe(true);
    expect(res.body.pending).toBe(1);

    const batch = await listZeroSalesBatches();
    const row = batch.find((b) => b.id === w44.batchId)!;
    expect(row.reply_required).toBe(false);
    expect(row.reply_notice).toBe('旺季不用回覆');
    expect(row.is_open).toBe(false);

    const audit = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'zero_sales_reply_required_changed'`,
    );
    expect(audit.rows[0]?.n).toBe(1);

    // 參數驗證：缺 reply_required → 400
    const bad = await agent
      .put(`/api/admin/zero-sales/batches/${w44.batchId}/reply-required`)
      .set('x-csrf-token', csrf1)
      .send({ notice: 'x' });
    expect(bad.status).toBe(400);
  });
});
