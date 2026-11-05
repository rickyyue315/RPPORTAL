import { describe, expect, it, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles } from './migrateTest.js';
import { setPoolForTesting } from '../src/db/pool.js';
import { replaceStores } from '../src/services/stores.js';
import {
  createBatch as createZeroSalesBatch,
  getZeroSalesSummary,
  replyItem as replyZeroSalesItem,
  ZeroSalesDuplicateBatchError,
  ZeroSalesReplyError,
} from '../src/services/zeroSales.js';
import {
  createNotice,
  listActiveNotices,
  republishNotice,
} from '../src/services/notices.js';
import {
  createBatch as createDesignatedSkuBatch,
  submitMatterReply,
  updateReplyFields,
  DesignatedSkuError,
} from '../src/services/designatedSku.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: PGlite;

/** 真實的測試 pool；個別測試會暫時換掉它來模擬競態 */
function realPool() {
  return {
    query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
    connect: async () => ({
      query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
      release: () => {},
    }),
  } as never;
}

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting(realPool());
  for (const file of await listMigrationFiles()) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
  ]);
});

/* ------------------------------------------------------------------ */
/* 指定 SKU：已有回覆不可改「回覆模式」（會清空年期／件數）            */
/* ------------------------------------------------------------------ */

async function newStockYearBatch(subject: string): Promise<{ batchId: string; matterId: string; itemId: string }> {
  const { batchId } = await createDesignatedSkuBatch({
    subject,
    sourceFilename: 'test.xlsx',
    rows: [{
      siteCode: 'HA02',
      sku: '107668017004',
      hierarchy: 'DRG',
      description: '測試貨品',
      stockQty: 5,
      data: {},
    }],
    skippedRows: 0,
    warnCount: 0,
    contentHash: `hash-${subject}-${Date.now()}`,
    createdBy: 'test',
    replyMode: 'stock_year',
    replyScope: 'item',
  });
  const matter = await db.query<{ id: string }>(
    'SELECT id FROM designated_sku_matters WHERE batch_id = $1 AND site_code = $2',
    [batchId, 'HA02'],
  );
  const item = await db.query<{ id: string }>(
    'SELECT id FROM designated_sku_items WHERE matter_id = $1',
    [matter.rows[0]!.id],
  );
  return { batchId, matterId: matter.rows[0]!.id, itemId: item.rows[0]!.id };
}

async function lineCount(itemId: string): Promise<number> {
  const r = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM designated_sku_reply_lines WHERE item_id = $1',
    [itemId],
  );
  return Number(r.rows[0]?.count ?? 0);
}

describe('指定 SKU 回覆模式守衛', () => {
  it('沒有回覆時可自由改模式（不會過度阻擋）', async () => {
    const { batchId } = await newStockYearBatch('無回覆可改模式');
    const updated = await updateReplyFields({
      batchId,
      fields: [{ key: 'f1', label: '陳列位置', type: 'text', required: false }],
      mode: 'mixed',
    });
    expect(updated?.reply_mode).toBe('mixed');
  });

  it('已有年期／件數回覆：改為 custom 會被擋，且回覆原封不動', async () => {
    const { batchId, matterId, itemId } = await newStockYearBatch('有回覆不可改模式');
    await submitMatterReply({
      siteCode: 'HA02',
      matterCode: (await db.query<{ matter_code: string }>(
        'SELECT matter_code FROM designated_sku_matters WHERE id = $1',
        [matterId],
      )).rows[0]!.matter_code,
      items: [{ item_id: itemId, lines: [{ year_code: '0827', qty: 3 }], note: '' }],
      repliedBy: 'HA02',
      repliedByUserId: '00000000-0000-4000-8000-000000000001',
    });
    expect(await lineCount(itemId)).toBe(1);

    await expect(updateReplyFields({ batchId, fields: [], mode: 'custom' }))
      .rejects.toBeInstanceOf(DesignatedSkuError);
    await expect(updateReplyFields({ batchId, fields: [], mode: 'custom' }))
      .rejects.toThrow(/不可改為「純自定欄位」模式/);

    // 關鍵：被擋之後，店舖已填的年期／件數一條都不能少
    expect(await lineCount(itemId)).toBe(1);
    const item = await db.query<{ status: string; reply_total: number | null }>(
      'SELECT status, reply_total FROM designated_sku_items WHERE id = $1',
      [itemId],
    );
    expect(item.rows[0]!.status).toBe('replied');
    expect(item.rows[0]!.reply_total).toBe(3);
    const batch = await db.query<{ reply_mode: string }>(
      'SELECT reply_mode FROM designated_sku_batches WHERE id = $1',
      [batchId],
    );
    expect(batch.rows[0]!.reply_mode).toBe('stock_year');
  });

  it('已有回覆仍可由 stock_year 改為 mixed（加自定欄位），年期不會消失', async () => {
    const { batchId, matterId, itemId } = await newStockYearBatch('加欄位不可丟年期');
    await submitMatterReply({
      siteCode: 'HA02',
      matterCode: (await db.query<{ matter_code: string }>(
        'SELECT matter_code FROM designated_sku_matters WHERE id = $1',
        [matterId],
      )).rows[0]!.matter_code,
      items: [{ item_id: itemId, lines: [{ year_code: '0927', qty: 4 }], note: '' }],
      repliedBy: 'HA02',
      repliedByUserId: '00000000-0000-4000-8000-000000000001',
    });

    const updated = await updateReplyFields({
      batchId,
      fields: [{ key: 'f1', label: '陳列位置', type: 'text', required: false }],
      mode: 'mixed',
    });
    expect(updated?.reply_mode).toBe('mixed');
    expect(await lineCount(itemId)).toBe(1);
    const item = await db.query<{ reply_total: number | null }>(
      'SELECT reply_total FROM designated_sku_items WHERE id = $1',
      [itemId],
    );
    expect(item.rows[0]!.reply_total).toBe(4);
  });

  it('不改模式（只改名／改必填）仍然可以，且回覆保留', async () => {
    const { batchId, matterId, itemId } = await newStockYearBatch('只改欄位不改模式');
    await submitMatterReply({
      siteCode: 'HA02',
      matterCode: (await db.query<{ matter_code: string }>(
        'SELECT matter_code FROM designated_sku_matters WHERE id = $1',
        [matterId],
      )).rows[0]!.matter_code,
      items: [{ item_id: itemId, lines: [{ year_code: '0827', qty: 2 }], note: '' }],
      repliedBy: 'HA02',
      repliedByUserId: '00000000-0000-4000-8000-000000000001',
    });
    const updated = await updateReplyFields({
      batchId,
      fields: [{ key: 'f1', label: '新欄名', type: 'text', required: false }],
    });
    expect(updated?.reply_mode).toBe('stock_year');
    expect(await lineCount(itemId)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 零銷售：同一週次／同一檔案不可重複上載                              */
/* ------------------------------------------------------------------ */

const ZS_ROWS = [{ siteCode: 'HA02', sku: '1000001', data: { Brand: 'TEST' } }];

function zsInput(weekLabel: string, contentHash: string, force = false) {
  return {
    weekLabel,
    note: '',
    rows: ZS_ROWS,
    contentHash,
    createdBy: 'test',
    autoFillRepeats: false,
    force,
  };
}

describe('零銷售批次重複上載守衛', () => {
  it('同一週次再上載會被擋，第一個批次保持開放、未被封存', async () => {
    const first = await createZeroSalesBatch(zsInput('2026-W47-guard', 'hash-guard-a'));

    await expect(createZeroSalesBatch(zsInput('2026-W47-guard', 'hash-guard-b')))
      .rejects.toBeInstanceOf(ZeroSalesDuplicateBatchError);

    const rows = await db.query<{ count: string; closed_at: string | null }>(
      'SELECT count(*)::text AS count, min(closed_at::text) AS closed_at FROM zero_sales_batches WHERE week_label = $1',
      ['2026-W47-guard'],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
    expect(rows.rows[0]!.closed_at).toBeNull();

    const items = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM zero_sales_items WHERE batch_id = $1 AND status = 'pending'",
      [first.batchId],
    );
    expect(Number(items.rows[0]!.count)).toBe(1);
  });

  it('同一份檔案（content_hash）換個週次亦會被擋', async () => {
    await createZeroSalesBatch(zsInput('2026-W48-guard', 'hash-guard-same-file'));
    await expect(createZeroSalesBatch(zsInput('2026-W49-guard', 'hash-guard-same-file')))
      .rejects.toBeInstanceOf(ZeroSalesDuplicateBatchError);
  });

  it('force=true 可略過檢查（管理員確認後才用）', async () => {
    await createZeroSalesBatch(zsInput('2026-W50-guard', 'hash-guard-force'));
    const forced = await createZeroSalesBatch(zsInput('2026-W50-guard', 'hash-guard-force-2', true));
    expect(forced.batchId).toBeTruthy();
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM zero_sales_batches WHERE week_label = $1',
      ['2026-W50-guard'],
    );
    expect(Number(rows.rows[0]!.count)).toBe(2);
  });

  it('週次大小寫不同亦當同一週，不會靜靜開多一個批次', async () => {
    await createZeroSalesBatch(zsInput('2026-W53-guard', 'hash-case-a'));
    await expect(createZeroSalesBatch(zsInput('2026-w53-guard', 'hash-case-b')))
      .rejects.toBeInstanceOf(ZeroSalesDuplicateBatchError);
  });

  it('空 content_hash 不會誤擋（舊批次或測試資料）', async () => {
    await createZeroSalesBatch(zsInput('2026-W51-guard', ''));
    const second = await createZeroSalesBatch(zsInput('2026-W52-guard', ''));
    expect(second.batchId).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 店舖回覆：修改次數的原子守衛 + 覆蓋他人回覆時保留舊值              */
/* ------------------------------------------------------------------ */

async function seedOpenBatch(weekLabel: string, hash: string): Promise<{ batchId: string; itemId: string }> {
  const { batchId } = await createZeroSalesBatch({
    ...zsInput(weekLabel, hash),
    rows: [{ siteCode: 'HA02', sku: '1000001', data: {} }],
  });
  const item = await db.query<{ id: string }>(
    'SELECT id FROM zero_sales_items WHERE batch_id = $1',
    [batchId],
  );
  return { batchId, itemId: item.rows[0]!.id };
}

function storeReply(itemId: string, reasonCode: string) {
  return replyZeroSalesItem({
    itemId,
    siteCode: 'HA02',
    reasonCode,
    reasonNote: '',
    repliedBy: 'HA02',
    repliedByUserId: '00000000-0000-4000-8000-000000000001',
  });
}

describe('店舖回覆：修改次數守衛', () => {
  it('同時提交兩次亦不會超出上限（reply_count 最多到 reply_limit）', async () => {
    const { batchId, itemId } = await seedOpenBatch('2026-W54-guard', 'hash-race');
    // 先給一次回覆，只剩最後一次修改機會
    await db.query(
      `UPDATE zero_sales_items
          SET status = 'replied', reason_code = 'seasonal', reason_label = '4.季節性/非當季產品',
              replied_at = now(), replied_by = 'HA02', reply_count = 1, reply_limit = 2
        WHERE batch_id = $1`,
      [batchId],
    );

    const results = await Promise.allSettled([
      storeReply(itemId, 'no_display'),
      storeReply(itemId, 'in_warehouse'),
    ]);
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    expect(okCount).toBe(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ZeroSalesReplyError);

    const after = await db.query<{ reply_count: number }>(
      'SELECT reply_count FROM zero_sales_items WHERE id = $1',
      [itemId],
    );
    expect(after.rows[0]!.reply_count).toBe(2);
  });

  it('前置檢查讀到舊值時，UPDATE 的 reply_count < reply_limit 仍然擋住（並回正確錯誤）', async () => {
    const { batchId, itemId } = await seedOpenBatch('2026-W57-guard', 'hash-stale');
    await db.query(
      `UPDATE zero_sales_items
          SET status = 'replied', reason_code = 'seasonal', reason_label = '4.季節性/非當季產品',
              replied_at = now(), replied_by = 'HA02', reply_count = 2, reply_limit = 2
        WHERE batch_id = $1`,
      [batchId],
    );

    // 模擬「兩個分頁同時提交」：前一個請求已經用掉最後一次機會，但這一個請求
    // 讀到的仍是舊的 reply_count（0）。只有 UPDATE 的 WHERE 條件可以攔住它。
    const stalePool = {
      query: async (text: string, params?: unknown[]) => {
        const res = await db.query(text, params ?? []);
        if (/^SELECT/i.test(text) && /FROM zero_sales_items i/.test(text) && /JOIN zero_sales_batches b/.test(text)) {
          return { ...res, rows: (res.rows as Array<Record<string, unknown>>).map((row) => ({ ...row, reply_count: 0 })) };
        }
        return res;
      },
      connect: async () => ({
        query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
        release: () => {},
      }),
    } as never;

    setPoolForTesting(stalePool);
    try {
      await expect(storeReply(itemId, 'price_promo')).rejects.toThrow(/已用完修改機會/);
    } finally {
      setPoolForTesting(realPool());
    }

    const after = await db.query<{ reply_count: number; reason_code: string }>(
      'SELECT reply_count, reason_code FROM zero_sales_items WHERE id = $1',
      [itemId],
    );
    expect(after.rows[0]!.reply_count).toBe(2);
    expect(after.rows[0]!.reason_code).toBe('seasonal');
  });

  it('覆蓋 OM 代覆：回傳原本的 replied_by 與舊內容（審計可追）', async () => {
    const { batchId, itemId } = await seedOpenBatch('2026-W55-guard', 'hash-om');
    await db.query(
      `UPDATE zero_sales_items
          SET status = 'replied', reason_code = 'no_display', reason_label = '1.無陳列/陳列位置不佳',
              reason_note = 'OM 現場確認', replied_at = now(),
              replied_by = 'OM 代覆（Ivy）', reply_count = 1
        WHERE batch_id = $1`,
      [batchId],
    );

    const result = await storeReply(itemId, 'in_warehouse');
    expect(result.replacedBy).toBe('OM 代覆（Ivy）');
    expect(result.before.reason_code).toBe('no_display');
    expect(result.before.reason_note).toBe('OM 現場確認');
    expect(result.before.replied_by).toBe('OM 代覆（Ivy）');
    expect(result.item.replied_by).toBe('HA02');
  });

  it('系統自動套用的行不算「被別人改過」', async () => {
    const { batchId, itemId } = await seedOpenBatch('2026-W56-guard', 'hash-auto');
    await db.query(
      `UPDATE zero_sales_items
          SET status = 'replied', reason_code = 'seasonal', reason_label = '4.季節性/非當季產品',
              replied_at = now(), replied_by = '系統自動套用（2026-W40）', reply_count = 1,
              reply_limit = 3, auto_filled_at = now(), auto_filled_from_week = '2026-W40'
        WHERE batch_id = $1`,
      [batchId],
    );

    const result = await storeReply(itemId, 'price_promo');
    expect(result.replacedBy).toBeNull();
    expect(result.before.replied_by).toBe('系統自動套用（2026-W40）');
  });
});

/* ------------------------------------------------------------------ */
/* 平台通告：重新推送已完結的通告不可以靜靜無效                        */
/* ------------------------------------------------------------------ */

describe('平台通告重新推送', () => {
  it('已完結的通告重推後會再出現在店舖頁，並回報已清除結束時間', async () => {
    const ended = await createNotice(
      {
        title: '已完結通告',
        body: '內容',
        endsAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      },
      'test',
    );
    const ids = async () => (await listActiveNotices()).map((n) => n.id);
    expect(await ids()).not.toContain(ended.id);

    const result = await republishNotice(ended.id, 'test');
    expect(result?.clearedEndsAt).toBe(true);
    expect(result?.notice.revision).toBe(2);
    expect(result?.notice.ends_at).toBeNull();
    expect(await ids()).toContain(ended.id);
  });

  it('仍生效的通告重推不會改動其結束時間', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const live = await createNotice({ title: '未完結通告', body: '', endsAt: future }, 'test');

    const result = await republishNotice(live.id, 'test');
    expect(result?.clearedEndsAt).toBe(false);
    expect(result?.notice.ends_at).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 統計：系統自動套用不可當成店舖真的回覆                              */
/* ------------------------------------------------------------------ */

describe('零銷售統計：自動套用分行列出', () => {
  it('auto_filled 獨立計數，店舖自行回覆率會扣掉它', async () => {
    const { batchId, itemId } = await seedOpenBatch('2026-W58-guard', 'hash-summary');
    // 同一批次多一個 SKU，令分母 = 2
    await db.query(
      `INSERT INTO zero_sales_items (batch_id, site_code, sku, payload)
       VALUES ($1, 'HA02', '1000002', '{}'::jsonb)`,
      [batchId],
    );
    // 一行系統自動套用、一行店舖自己回覆
    await db.query(
      `UPDATE zero_sales_items
          SET status = 'replied', reason_code = 'seasonal', reason_label = '4.季節性/非當季產品',
              replied_at = now(), replied_by = '系統自動套用（2026-W40）',
              reply_count = 1, reply_limit = 3,
              auto_filled_at = now(), auto_filled_from_week = '2026-W40'
        WHERE id = $1`,
      [itemId],
    );
    await db.query(
      `UPDATE zero_sales_items
          SET status = 'replied', reason_code = 'no_display', reason_label = '1.無陳列/陳列位置不佳',
              replied_at = now(), replied_by = 'HA02', reply_count = 1
        WHERE batch_id = $1 AND sku = '1000002'`,
      [batchId],
    );

    const summary = await getZeroSalesSummary(batchId);
    expect(summary.replied).toBe(2);
    expect(summary.auto_filled).toBe(1);
    expect(summary.store_confirmed).toBe(1);
    // 舊口徑維持不變（含自動套用），另給扣除此數的口徑
    expect(summary.reply_rate).toBe(100);
    expect(summary.reply_rate_confirmed).toBe(50);
    expect(summary.latest_batch?.auto_filled).toBeGreaterThanOrEqual(0);
  });

  it('店舖確認／修改自動套用的行之後，該行不再計入 auto_filled', async () => {
    const { batchId, itemId } = await seedOpenBatch('2026-W59-guard', 'hash-summary2');
    await db.query(
      `UPDATE zero_sales_items
          SET status = 'replied', reason_code = 'seasonal', reason_label = '4.季節性/非當季產品',
              replied_at = now(), replied_by = '系統自動套用（2026-W40）',
              reply_count = 1, reply_limit = 3,
              auto_filled_at = now(), auto_filled_from_week = '2026-W40'
        WHERE batch_id = $1`,
      [batchId],
    );
    expect((await getZeroSalesSummary(batchId)).auto_filled).toBe(1);

    await storeReply(itemId, 'price_promo');

    const summary = await getZeroSalesSummary(batchId);
    expect(summary.auto_filled).toBe(0);
    expect(summary.store_confirmed).toBe(1);
    expect(summary.reply_rate_confirmed).toBe(100);
  });
});
