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
import { createPortalSession, hashPassword } from '../src/services/portalAuth.js';
import {
  closeZeroSalesBatch,
  createBatch as createZeroSalesBatch,
  reopenZeroSalesBatch,
  setZeroSalesBatchReplyRequired,
} from '../src/services/zeroSales.js';
import { createBatch as createDesignatedSkuBatch } from '../src/services/designatedSku.js';

/* 測試憑證只供本機 PGlite 使用，不是真實密碼 */
const TEST_STORE_PASS = 'StoreTest1!ABCD';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;
let ha02Cookie = '';
let hb20Cookie = '';
let w41Id = '';
let expiredBatchId = '';

async function issueCsrf(): Promise<{ cookie: string; token: string }> {
  const res = await request(app).get('/api/csrf');
  const setCookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  return { cookie, token: res.body.token ?? res.body.csrfToken ?? '' };
}

async function storeSession(siteCode: string): Promise<string> {
  const found = await db.query<{ id: string }>(
    `SELECT id FROM portal_users WHERE role = 'store' AND site_code = $1 LIMIT 1`,
    [siteCode],
  );
  const session = await createPortalSession(found.rows[0]!.id);
  const { cookie } = await issueCsrf();
  return `portal_session=${session.token}; ${cookie}`;
}

async function badges(cookie: string) {
  const res = await request(app).get('/api/portal/nav-badges').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as { zero_sales: number; designated_sku: number };
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
    { site_code: 'HB20', shop: '旺角', regional: 'KLN', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
  ]);
  const pwHash = await hashPassword(TEST_STORE_PASS);
  for (const site of ['HA02', 'HB20']) {
    await db.query(
      `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
       VALUES ($2, $2, 'store', $2, $1, false, true, 'test')
       ON CONFLICT (username) DO UPDATE SET active = true`,
      [pwHash, site],
    );
  }
  app = createApp();

  // 零銷售：HA02 有 2 行待回覆、HB20 有 1 行（用來驗證店舖隔離）
  const w41 = await createZeroSalesBatch({
    weekLabel: '2026-W41-badge-test',
    note: 'nav badge test',
    rows: [
      { siteCode: 'HA02', sku: 'A1', data: { Brand: 'B1' } },
      { siteCode: 'HA02', sku: 'A2', data: { Brand: 'B1' } },
      { siteCode: 'HB20', sku: 'C1', data: { Brand: 'B1' } },
    ],
    contentHash: `hash-badge-${Date.now()}`,
    createdBy: 'test',
    autoFillRepeats: false,
  });
  w41Id = w41.batchId;

  // 指定 SKU：兩店各一個事項（HA02 兩張單，其中一張已過截止時間 → 不計）
  await createDesignatedSkuBatch({
    subject: '指定 SKU 存貨年期確認（徽章測試）',
    sourceFilename: 'badge-test.xlsx',
    rows: [
      { siteCode: 'HA02', sku: '107668017004', hierarchy: 'DRG', description: '商品 A', stockQty: 5, data: {} },
      { siteCode: 'HB20', sku: '108000000001', hierarchy: 'DRG', description: '商品 B', stockQty: 3, data: {} },
    ],
    skippedRows: 0,
    warnCount: 0,
    contentHash: `hash-dsku-badge-${Date.now()}`,
    createdBy: 'test',
  });
  const expired = await createDesignatedSkuBatch({
    subject: '指定 SKU 已過截止（徽章測試）',
    sourceFilename: 'badge-test-expired.xlsx',
    dueAt: '2020-01-01T00:00:00.000Z',
    rows: [
      { siteCode: 'HA02', sku: '107668017005', hierarchy: 'DRG', description: '商品 C', stockQty: 2, data: {} },
    ],
    skippedRows: 0,
    warnCount: 0,
    contentHash: `hash-dsku-expired-${Date.now()}`,
    createdBy: 'test',
  });
  expiredBatchId = expired.batchId;

  ha02Cookie = await storeSession('HA02');
  hb20Cookie = await storeSession('HB20');
});

describe('導覽待辦徽章 /api/portal/nav-badges', () => {
  it('未登入回 401，不會洩露任何數字', async () => {
    const res = await request(app).get('/api/portal/nav-badges');
    expect(res.status).toBe(401);
    expect(res.body.zero_sales).toBeUndefined();
  });

  it('只計本店：零銷售未回覆 SKU 數 + 指定 SKU 待回覆事項數', async () => {
    expect(await badges(ha02Cookie)).toEqual({ zero_sales: 2, designated_sku: 1 });
    expect(await badges(hb20Cookie)).toEqual({ zero_sales: 1, designated_sku: 1 });
  });

  it('已過截止時間的指定 SKU 批次不計（店舖已無法回覆）', async () => {
    const row = await db.query<{ closed_at: string | null; due_at: string | null }>(
      'SELECT closed_at, due_at FROM designated_sku_batches WHERE id = $1',
      [expiredBatchId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.closed_at).toBeNull();
    expect(row.rows[0]!.due_at).not.toBeNull();

    // DB 內 HA02 實際有 2 個事項仍待回覆，但過期那個店舖已交不出，徽章只算 1
    const pending = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM designated_sku_matters m
         JOIN designated_sku_items i ON i.matter_id = m.id
        WHERE m.site_code = 'HA02' AND i.status = 'pending'`,
    );
    expect(Number(pending.rows[0]!.count)).toBe(2);
    expect(await badges(ha02Cookie)).toEqual({ zero_sales: 2, designated_sku: 1 });
  });

  it('「本週無須回覆」的週次不計，切回需要回覆即恢復', async () => {
    await setZeroSalesBatchReplyRequired({ batchId: w41Id, replyRequired: false, actor: 'test' });
    expect((await badges(ha02Cookie)).zero_sales).toBe(0);

    await setZeroSalesBatchReplyRequired({ batchId: w41Id, replyRequired: true, actor: 'test' });
    expect((await badges(ha02Cookie)).zero_sales).toBe(2);
  });

  it('封存週次不計（未回覆也不算待辦），重開後回復', async () => {
    await closeZeroSalesBatch(w41Id, 'test');
    expect((await badges(ha02Cookie)).zero_sales).toBe(0);

    await reopenZeroSalesBatch(w41Id);
    expect((await badges(ha02Cookie)).zero_sales).toBe(2);
  });

  it('全部回覆後歸零：零銷售與指定 SKU 各自獨立', async () => {
    await db.query(
      `UPDATE zero_sales_items SET status = 'replied' WHERE batch_id = $1 AND site_code = 'HA02'`,
      [w41Id],
    );
    expect(await badges(ha02Cookie)).toEqual({ zero_sales: 0, designated_sku: 1 });

    await db.query(`UPDATE designated_sku_items SET status = 'replied' WHERE site_code = 'HA02'`);
    expect(await badges(ha02Cookie)).toEqual({ zero_sales: 0, designated_sku: 0 });

    // 另一間店不受影響
    expect(await badges(hb20Cookie)).toEqual({ zero_sales: 1, designated_sku: 1 });
  });
});
