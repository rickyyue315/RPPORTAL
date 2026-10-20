import { query, withTransaction } from '../db/pool.js';
import { toHKDateString, toHKString } from '../lib/time.js';
import type { PoolClient } from 'pg';

export interface ZeroSalesBatchRow {
  id: string;
  week_label: string;
  note: string;
  row_count: number;
  store_count: number;
  content_hash: string;
  created_by: string;
  created_at: string;
  /** 封存時間 (null = 派發中，店舖仍可回覆) */
  closed_at: string | null;
  closed_by: string;
  close_reason: string;
  /** 是否仍開放回覆；與 closed_at 同步，方便前端直接用 */
  is_open: boolean;
  replied_count?: number;
  pending_count?: number;
}

/** 被新批次自動封存的舊批次（上載回應 / 審計用） */
export interface ZeroSalesClosedBatch {
  id: string;
  week_label: string;
  /** 封存時仍未回覆的行數（此後不可再回覆） */
  pending: number;
}

export interface ZeroSalesItemRow {
  id: string;
  batch_id: string;
  site_code: string;
  sku: string;
  payload: Record<string, string>;
  status: 'pending' | 'replied';
  reason_code: string | null;
  reason_label: string | null;
  reason_note: string;
  replied_at: string | null;
  replied_by: string | null;
  week_label?: string;
  batch_created_at?: string;
  /** 批次封存時間 (null = 仍可回覆) */
  batch_closed_at?: string | null;
  /** 此行所屬週次是否仍可回覆 */
  is_open?: boolean;
  /** SKU 上載日期 (日 only，YYYY-MM-DD) */
  batch_date?: string;
  /** 已回覆次數：0=未回覆，1=已回覆未改過，2=已用完修改機會 */
  reply_count: number;
  /** 截至本行所屬批次（含本行）同店同 SKU 累計出現次數（當時為止，非全期總數） */
  occurrence_count?: number;
  /** 是否重複上榜（occurrence_count >= 2） */
  is_repeat?: boolean;
  /** 上一次出現的週次 / 回覆（無則為 null） */
  prev_week_label?: string | null;
  prev_status?: string | null;
  prev_reason_label?: string | null;
  prev_reason_note?: string;
  prev_replied_at?: string | null;
}

export interface ZeroSalesReasonRow {
  code: string;
  label: string;
  sort_order: number;
  active: boolean;
  require_note: boolean;
}

export async function listReasons(activeOnly = true): Promise<ZeroSalesReasonRow[]> {
  const sql = activeOnly
    ? 'SELECT code, label, sort_order, active, require_note FROM zero_sales_reasons WHERE active = true ORDER BY sort_order, code'
    : 'SELECT code, label, sort_order, active, require_note FROM zero_sales_reasons ORDER BY sort_order, code';
  const r = await query<ZeroSalesReasonRow>(sql);
  return r.rows;
}

export async function listBatches(): Promise<ZeroSalesBatchRow[]> {
  const r = await query<ZeroSalesBatchRow>(
    `SELECT b.*,
      (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'replied') AS replied_count,
      (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending_count
     FROM zero_sales_batches b ORDER BY b.created_at DESC LIMIT 100`,
  );
  return r.rows.map((b) => ({
    ...b,
    created_at: toHKString(b.created_at),
    closed_at: b.closed_at ? toHKString(b.closed_at) : null,
    is_open: !b.closed_at,
  }));
}

export interface ZeroSalesSummary {
  batches: number;
  total: number;
  replied: number;
  /** 仍可回覆的未回覆行數（只在開放的週次） */
  pending: number;
  /** 已封存週次中當時未回覆的行數（只供歷史統計，店舖不可再回覆） */
  overdue: number;
  locked: number;
  reply_rate: number;
  stores_total: number;
  stores_pending: number;
  stores_overdue: number;
  stores_done: number;
  /** 同店同 SKU 出現 ≥2 次的組數（仍未改善的高危組） */
  repeat_groups: number;
  /** 屬於重複組的總行數 */
  repeat_rows: number;
  latest_batch: {
    id: string;
    week_label: string;
    total: number;
    replied: number;
    pending: number;
    created_at: string;
    closed_at: string | null;
    is_open: boolean;
  } | null;
  by_reason: Array<{ reason_code: string; reason_label: string; count: number }>;
  /** 待回覆店舖（按 OM 匯總）：只計仍開放的週次；每列為一個 OM 的待回覆店數 / 行數 */
  pending_by_om: Array<{
    om: string;
    stores_total: number;
    stores_pending: number;
    total: number;
    replied: number;
    pending: number;
  }>;
  pending_by_store: Array<{
    site_code: string;
    shop: string;
    om: string;
    total: number;
    replied: number;
    pending: number;
  }>;
}

/**
 * 跨批次總覽：總數 / 回覆率 / 原因分佈 / 待回覆店舖排行（供後台統計面板）。
 * 跨批次模式下 pending 只計仍開放的週次，已封存而未回覆的行另計 overdue；
 * 指定 batch_id 時則如實顯示該批次的 pending（供後台查歷史），overdue 固定為 0。
 */
export async function getZeroSalesSummary(batchId?: string): Promise<ZeroSalesSummary> {
  const batchFilter = batchId ? 'AND i.batch_id = $1' : '';
  // 跨批次：「可回覆」= 批次 closed_at IS NULL；指定批次：不設限（照示該批歷史狀態）
  const openFilter = batchId
    ? 'TRUE'
    : 'EXISTS (SELECT 1 FROM zero_sales_batches ob WHERE ob.id = i.batch_id AND ob.closed_at IS NULL)';
  const closedFilter = batchId
    ? 'FALSE'
    : 'EXISTS (SELECT 1 FROM zero_sales_batches cb WHERE cb.id = i.batch_id AND cb.closed_at IS NOT NULL)';
  const params: unknown[] = batchId ? [batchId] : [];
  const overall = await query<{
    batches: string;
    total: string;
    replied: string;
    pending: string;
    overdue: string;
    locked: string;
    stores_total: string;
    stores_pending: string;
    stores_overdue: string;
    stores_unresolved: string;
  }>(
    `SELECT
      (SELECT count(*)::text FROM zero_sales_batches) AS batches,
      (SELECT count(*)::text FROM zero_sales_items i WHERE TRUE ${batchFilter}) AS total,
      (SELECT count(*)::text FROM zero_sales_items i WHERE i.status = 'replied' ${batchFilter}) AS replied,
      (SELECT count(*)::text FROM zero_sales_items i WHERE i.status = 'pending' AND (${openFilter}) ${batchFilter}) AS pending,
      (SELECT count(*)::text FROM zero_sales_items i WHERE i.status = 'pending' AND (${closedFilter}) ${batchFilter}) AS overdue,
      (SELECT count(*)::text FROM zero_sales_items i WHERE i.reply_count >= 2 ${batchFilter}) AS locked,
      (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE TRUE ${batchFilter}) AS stores_total,
      (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE i.status = 'pending' AND (${openFilter}) ${batchFilter}) AS stores_pending,
      (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE i.status = 'pending' AND (${closedFilter}) ${batchFilter}) AS stores_overdue,
      (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE i.status = 'pending' AND ((${openFilter}) OR (${closedFilter})) ${batchFilter}) AS stores_unresolved`,
    params,
  );
  const o = overall.rows[0]!;
  const total = Number(o.total ?? 0);
  const replied = Number(o.replied ?? 0);
  const pending = Number(o.pending ?? 0);
  const storesTotal = Number(o.stores_total ?? 0);
  const storesPending = Number(o.stores_pending ?? 0);
  const storesOverdue = Number(o.stores_overdue ?? 0);
  const storesUnresolved = Number(o.stores_unresolved ?? 0);

  const reasonRows = await query<{ reason_code: string; reason_label: string; count: string }>(
    `SELECT COALESCE(i.reason_code, '') AS reason_code,
            COALESCE(i.reason_label, '（未分類）') AS reason_label,
            count(*)::text AS count
       FROM zero_sales_items i
      WHERE i.status = 'replied' ${batchFilter}
      GROUP BY i.reason_code, i.reason_label
      ORDER BY count(*) DESC, i.reason_label`,
    params,
  );

  // 待跟進店舖：只計仍開放的週次（已封存而未回覆不可能再補，不應留在待辦）
  const storeRows = await query<{ site_code: string; shop: string; om: string; total: string; replied: string; pending: string }>(
    `SELECT i.site_code,
            COALESCE(s.shop, '') AS shop,
            COALESCE(s.om, '') AS om,
            count(*)::text AS total,
            count(*) FILTER (WHERE i.status = 'replied')::text AS replied,
            count(*) FILTER (WHERE i.status = 'pending')::text AS pending
       FROM zero_sales_items i
       LEFT JOIN stores s ON s.site_code = i.site_code
      WHERE TRUE ${batchFilter} AND (${openFilter})
      GROUP BY i.site_code, s.shop, s.om
     HAVING count(*) FILTER (WHERE i.status = 'pending') > 0
      ORDER BY count(*) FILTER (WHERE i.status = 'pending') DESC, i.site_code
      LIMIT 50`,
    params,
  );

  const omRows = await query<{ om: string; stores_total: string; stores_pending: string; total: string; replied: string; pending: string }>(
    `SELECT COALESCE(NULLIF(BTRIM(COALESCE(s.om, '')), ''), '（未設定）') AS om,
            count(DISTINCT i.site_code)::text AS stores_total,
            count(DISTINCT CASE WHEN i.status = 'pending' THEN i.site_code END)::text AS stores_pending,
            count(*)::text AS total,
            count(*) FILTER (WHERE i.status = 'replied')::text AS replied,
            count(*) FILTER (WHERE i.status = 'pending')::text AS pending
       FROM zero_sales_items i
       LEFT JOIN stores s ON s.site_code = i.site_code
      WHERE TRUE ${batchFilter} AND (${openFilter})
      GROUP BY COALESCE(NULLIF(BTRIM(COALESCE(s.om, '')), ''), '（未設定）')
     HAVING count(*) FILTER (WHERE i.status = 'pending') > 0
      ORDER BY count(*) FILTER (WHERE i.status = 'pending') DESC, om`,
    params,
  );

  const latest = await query<{
    id: string;
    week_label: string;
    total: string;
    replied: string;
    pending: string;
    created_at: string;
    closed_at: string | null;
  }>(
    `SELECT b.id, b.week_label, b.created_at, b.closed_at,
            (SELECT count(*)::text FROM zero_sales_items i WHERE i.batch_id = b.id) AS total,
            (SELECT count(*)::text FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'replied') AS replied,
            (SELECT count(*)::text FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending
       FROM zero_sales_batches b ORDER BY b.created_at DESC LIMIT 1`,
  );
  const lb = latest.rows[0] ?? null;

  // 重複上榜：只在跨批次總覽計算；若指定單一批次則必為 0（批次內 site+sku 唯一）
  let repeatGroups = 0;
  let repeatRows = 0;
  if (!batchId) {
    const repeat = await query<{ groups: string; rows: string }>(
      `SELECT COUNT(*)::text AS groups, COALESCE(SUM(cnt), 0)::text AS rows
         FROM (SELECT COUNT(*) AS cnt FROM zero_sales_items GROUP BY site_code, sku HAVING COUNT(*) >= 2) t`,
    );
    repeatGroups = Number(repeat.rows[0]?.groups ?? 0);
    repeatRows = Number(repeat.rows[0]?.rows ?? 0);
  }

  return {
    batches: Number(o.batches ?? 0),
    total,
    replied,
    pending,
    overdue: Number(o.overdue ?? 0),
    locked: Number(o.locked ?? 0),
    reply_rate: total ? Math.round((replied / total) * 1000) / 10 : 0,
    stores_total: storesTotal,
    stores_pending: storesPending,
    stores_overdue: storesOverdue,
    stores_done: Math.max(0, storesTotal - storesUnresolved),
    repeat_groups: repeatGroups,
    repeat_rows: repeatRows,
    latest_batch: lb
      ? {
          id: lb.id,
          week_label: lb.week_label,
          total: Number(lb.total ?? 0),
          replied: Number(lb.replied ?? 0),
          pending: Number(lb.pending ?? 0),
          created_at: toHKString(lb.created_at),
          closed_at: lb.closed_at ? toHKString(lb.closed_at) : null,
          is_open: !lb.closed_at,
        }
      : null,
    by_reason: reasonRows.rows.map((r) => ({
      reason_code: r.reason_code,
      reason_label: r.reason_label,
      count: Number(r.count ?? 0),
    })),
    pending_by_store: storeRows.rows.map((r) => ({
      site_code: r.site_code,
      shop: r.shop ?? '',
      om: r.om ?? '',
      total: Number(r.total ?? 0),
      replied: Number(r.replied ?? 0),
      pending: Number(r.pending ?? 0),
    })),
    pending_by_om: omRows.rows.map((r) => ({
      om: r.om,
      stores_total: Number(r.stores_total ?? 0),
      stores_pending: Number(r.stores_pending ?? 0),
      total: Number(r.total ?? 0),
      replied: Number(r.replied ?? 0),
      pending: Number(r.pending ?? 0),
    })),
  };
}

export interface ZeroSalesPendingStoreRow {
  site_code: string;
  shop: string;
  om: string;
  total: number;
  replied: number;
  pending: number;
}

/** 後台 OM 下鑽：取某 OM（或全部 OM）仍有待回覆的店舖名單；與 summary 同樣支援 batch 範圍。
 *  不指定批次時只計仍開放的週次（已封存的未回覆不會再變成回覆，不應留在待辦名單）。 */
export async function listZeroSalesPendingStores(filter: { batchId?: string; om?: string } = {}): Promise<ZeroSalesPendingStoreRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.batchId) {
    params.push(filter.batchId);
    where.push(`i.batch_id = $${params.length}`);
  } else {
    where.push(`EXISTS (SELECT 1 FROM zero_sales_batches b WHERE b.id = i.batch_id AND b.closed_at IS NULL)`);
  }
  const om = (filter.om ?? '').trim();
  if (om) {
    if (om === '（未設定）') {
      where.push(`(s.om IS NULL OR BTRIM(COALESCE(s.om, '')) = '')`);
    } else {
      params.push(om);
      where.push(`BTRIM(COALESCE(s.om, '')) = $${params.length}`);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await query<{ site_code: string; shop: string; om: string; total: string; replied: string; pending: string }>(
    `SELECT i.site_code,
            COALESCE(MAX(s.shop), '') AS shop,
            COALESCE(MAX(s.om), '') AS om,
            COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE i.status = 'replied')::text AS replied,
            COUNT(*) FILTER (WHERE i.status = 'pending')::text AS pending
       FROM zero_sales_items i
       LEFT JOIN stores s ON s.site_code = i.site_code
      ${whereSql}
      GROUP BY i.site_code
     HAVING COUNT(*) FILTER (WHERE i.status = 'pending') > 0
      ORDER BY COUNT(*) FILTER (WHERE i.status = 'pending') DESC, i.site_code
      LIMIT 1000`,
    params,
  );
  return r.rows.map((row) => ({
    site_code: row.site_code,
    shop: row.shop ?? '',
    om: row.om ?? '',
    total: Number(row.total ?? 0),
    replied: Number(row.replied ?? 0),
    pending: Number(row.pending ?? 0),
  }));
}

export interface ZeroSalesExportFilter {
  batchId?: string;
  siteCode?: string;
  status?: 'pending' | 'replied';
  reasonCode?: string;
}

/** 統一匯出查詢：可跨批次按 Site / 狀態 / 原因篩選（上限 10000 行） */
export async function listItemsForExport(filter: ZeroSalesExportFilter): Promise<ZeroSalesItemRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.batchId) {
    params.push(filter.batchId);
    where.push(`i.batch_id = $${params.length}`);
  }
  if (filter.siteCode) {
    params.push(filter.siteCode);
    where.push(`i.site_code = $${params.length}`);
  }
  if (filter.status === 'pending' || filter.status === 'replied') {
    params.push(filter.status);
    where.push(`i.status = $${params.length}`);
  }
  if (filter.reasonCode) {
    params.push(filter.reasonCode);
    where.push(`i.reason_code = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await query<ZeroSalesItemRow>(
    `SELECT i.*, b.week_label, b.created_at AS batch_created_at, b.closed_at AS batch_closed_at
     FROM zero_sales_items i
     JOIN zero_sales_batches b ON b.id = i.batch_id
     ${whereSql} ORDER BY b.created_at DESC, i.site_code, i.sku LIMIT 10000`,
    params,
  );
  return r.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    batch_created_at: row.batch_created_at ? toHKString(row.batch_created_at as unknown as string) : undefined,
    batch_closed_at: row.batch_closed_at ? toHKString(row.batch_closed_at as unknown as string) : null,
    is_open: !row.batch_closed_at,
    batch_date: row.batch_created_at ? toHKDateString(row.batch_created_at as unknown as string) : undefined,
  }));
}

export async function createBatch(input: {
  weekLabel: string;
  note: string;
  rows: Array<{ siteCode: string; sku: string; data: Record<string, string> }>;
  contentHash: string;
  createdBy: string;
}): Promise<{ batchId: string; closedBatches: ZeroSalesClosedBatch[] }> {
  return withTransaction(async (client) => {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO zero_sales_batches (week_label, note, row_count, store_count, content_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        input.weekLabel,
        input.note ?? '',
        input.rows.length,
        new Set(input.rows.map((r) => r.siteCode)).size,
        input.contentHash,
        input.createdBy,
      ],
    );
    const batchId = ins.rows[0]!.id;
    for (const r of input.rows) {
      await client.query(
        `INSERT INTO zero_sales_items (batch_id, site_code, sku, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (batch_id, site_code, sku) DO UPDATE SET payload = EXCLUDED.payload`,
        [batchId, r.siteCode, r.sku, JSON.stringify(r.data)],
      );
    }
    // 即時封存：新批次上載後，之前所有仍開放的批次立刻轉為唯讀。
    // 先插入新批次再封存其他批次，可避免兩個並行上載同時保持開放。
    const closed = await client.query<{ id: string; week_label: string; pending: string }>(
      `UPDATE zero_sales_batches b
          SET closed_at = now(), closed_by = $1, close_reason = 'auto'
        WHERE b.closed_at IS NULL AND b.id <> $2
    RETURNING b.id, b.week_label,
              (SELECT count(*)::text FROM zero_sales_items i
                WHERE i.batch_id = b.id AND i.status = 'pending') AS pending`,
      [input.createdBy, batchId],
    );
    return {
      batchId,
      closedBatches: closed.rows.map((r) => ({
        id: r.id,
        week_label: r.week_label,
        pending: Number(r.pending ?? 0),
      })),
    };
  });
}

export async function listBatchItems(batchId: string, opts: { siteCode?: string; status?: string }): Promise<ZeroSalesItemRow[]> {
  const where = ['i.batch_id = $1'];
  const params: unknown[] = [batchId];
  if (opts.siteCode) { params.push(opts.siteCode); where.push(`i.site_code = $${params.length}`); }
  if (opts.status === 'pending' || opts.status === 'replied') { params.push(opts.status); where.push(`i.status = $${params.length}`); }
  const r = await query<ZeroSalesItemRow>(
    `SELECT i.*, b.week_label, b.created_at AS batch_created_at, b.closed_at AS batch_closed_at
     FROM zero_sales_items i
     JOIN zero_sales_batches b ON b.id = i.batch_id
     WHERE ${where.join(' AND ')} ORDER BY i.site_code, i.sku LIMIT 2000`,
    params,
  );
  const mapped = r.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    batch_created_at: row.batch_created_at ? toHKString(row.batch_created_at as unknown as string) : undefined,
    batch_closed_at: row.batch_closed_at ? toHKString(row.batch_closed_at as unknown as string) : null,
    is_open: !row.batch_closed_at,
    batch_date: row.batch_created_at ? toHKDateString(row.batch_created_at as unknown as string) : undefined,
  }));
  return attachZeroSalesHistory(mapped);
}

interface ZeroSalesHistoryEntry {
  batch_id: string;
  site_code: string;
  sku: string;
  week_label: string;
  batch_created_at: string;
  status: string;
  reason_label: string | null;
  reason_note: string;
  replied_at: string | null;
}

/**
 * 為每行附加跨批次重複資訊：截至該行所屬批次（含本行）的同店同 SKU 出現次數 + 上一次的週次/回覆。
 * 出現次數為「當時為止」而非全期總數：只計時間上不晚於本行的批次，舊週顯示「第幾次上榜」會逐週遞增（1、2、3…）。
 * 以 site 分組一次過查全量歷史，避免每行 N+1 查詢。
 */
async function attachZeroSalesHistory<T extends ZeroSalesItemRow>(items: T[]): Promise<T[]> {
  if (!items.length) return items;
  const skusBySite = new Map<string, Set<string>>();
  for (const it of items) {
    if (!it.site_code || !it.sku) continue;
    let set = skusBySite.get(it.site_code);
    if (!set) { set = new Set<string>(); skusBySite.set(it.site_code, set); }
    set.add(it.sku);
  }
  const historyByKey = new Map<string, ZeroSalesHistoryEntry[]>();
  for (const [siteCode, skuSet] of skusBySite) {
    const skus = [...skuSet];
    if (!skus.length) continue;
    const r = await query<ZeroSalesHistoryEntry>(
      `SELECT h.batch_id, h.site_code, h.sku, hb.week_label, hb.created_at AS batch_created_at,
              h.status, h.reason_label, COALESCE(h.reason_note, '') AS reason_note, h.replied_at
         FROM zero_sales_items h
         JOIN zero_sales_batches hb ON hb.id = h.batch_id
        WHERE h.site_code = $1 AND h.sku = ANY($2::text[])
        ORDER BY h.sku, hb.created_at DESC, hb.id DESC`,
      [siteCode, skus],
    );
    for (const h of r.rows) {
      const key = `${h.site_code}|${h.sku}`;
      const list = historyByKey.get(key) ?? [];
      list.push(h);
      historyByKey.set(key, list);
    }
  }
  return items.map((it) => {
    const list = historyByKey.get(`${it.site_code}|${it.sku}`) ?? [];
    const idx = list.findIndex((h) => h.batch_id === it.batch_id);
    // 截至本行所屬批次（含本行）的累計出現次數：list 已按 created_at DESC（新→舊）排序，
    // 本行連同更舊的行數即「當時為止」次數；找不到本行（理論上不發生）則退回全期總數
    const occurrence_count = idx >= 0 ? list.length - idx : (list.length || 1);
    // 上一次 = 同 SKU 按時間排在現行之前的第一個；找不到（理論上不發生）則退回最新且非本行
    const prev = idx >= 0 ? (list[idx + 1] ?? null) : (list.find((h) => h.batch_id !== it.batch_id) ?? null);
    return {
      ...it,
      occurrence_count,
      is_repeat: occurrence_count >= 2,
      prev_week_label: prev?.week_label ?? null,
      prev_status: prev?.status ?? null,
      prev_reason_label: prev?.reason_label ?? null,
      prev_reason_note: prev?.reason_note ?? '',
      prev_replied_at: prev?.replied_at ? toHKString(prev.replied_at) : null,
    };
  });
}

export interface ZeroSalesRepeatRow {
  site_code: string;
  shop: string;
  sku: string;
  brand: string;
  sku_desc: string;
  occurrence_count: number;
  pending_count: number;
  replied_count: number;
  weeks: string[];
  first_seen: string;
  last_seen: string;
  last_week_label: string;
  last_status: string;
  last_reason_label: string;
  last_reason_note: string;
  last_replied_at: string | null;
}

export interface ZeroSalesRepeatFilter {
  siteCode?: string;
  /** 模糊搜尋 SKU / Site Code */
  q?: string;
  /** 最少出現次數，預設 2（連續兩週即命中，不要求必須相鄰） */
  minCount?: number;
  limit?: number;
}

/** 後台重複上榜統計：同店同 SKU 跨批次出現 ≥ minCount，按次數倒序（上限 500） */
export async function listZeroSalesRepeats(filter: ZeroSalesRepeatFilter = {}): Promise<ZeroSalesRepeatRow[]> {
  const minCount = Math.min(20, Math.max(2, Math.floor(filter.minCount ?? 2) || 2));
  const limit = Math.min(500, Math.max(1, Math.floor(filter.limit ?? 200) || 200));
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.siteCode) {
    params.push(filter.siteCode);
    where.push(`i.site_code = $${params.length}`);
  }
  if (filter.q) {
    params.push(`%${filter.q}%`);
    where.push(`(i.sku ILIKE $${params.length} OR i.site_code ILIKE $${params.length})`);
  }
  params.push(minCount);
  const havingParam = `$${params.length}`;
  params.push(limit);
  const limitParam = `$${params.length}`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await query<{
    site_code: string;
    shop: string;
    sku: string;
    brand: string;
    sku_desc: string;
    occurrence_count: string;
    pending_count: string;
    replied_count: string;
    weeks: string[];
    first_seen_raw: string;
    last_seen_raw: string;
    last_week_label: string;
    last_status: string;
    last_reason_label: string;
    last_reason_note: string;
    last_replied_raw: string | null;
  }>(
    `SELECT i.site_code, COALESCE(MAX(s.shop), '') AS shop, i.sku,
            COUNT(*)::text AS occurrence_count,
            COUNT(*) FILTER (WHERE i.status = 'pending')::text AS pending_count,
            COUNT(*) FILTER (WHERE i.status = 'replied')::text AS replied_count,
            ARRAY_AGG(b.week_label ORDER BY b.created_at DESC) AS weeks,
            MIN(b.created_at)::text AS first_seen_raw,
            MAX(b.created_at)::text AS last_seen_raw,
            (ARRAY_AGG(b.week_label ORDER BY b.created_at DESC))[1] AS last_week_label,
            (ARRAY_AGG(i.status ORDER BY b.created_at DESC))[1] AS last_status,
            (ARRAY_AGG(COALESCE(i.reason_label, '') ORDER BY b.created_at DESC))[1] AS last_reason_label,
            (ARRAY_AGG(COALESCE(i.reason_note, '') ORDER BY b.created_at DESC))[1] AS last_reason_note,
            (ARRAY_AGG(i.payload->>'Brand' ORDER BY b.created_at DESC))[1] AS brand,
            (ARRAY_AGG(i.payload->>'SKU Desc' ORDER BY b.created_at DESC))[1] AS sku_desc,
            (ARRAY_AGG(i.replied_at ORDER BY b.created_at DESC))[1]::text AS last_replied_raw
       FROM zero_sales_items i
       JOIN zero_sales_batches b ON b.id = i.batch_id
       LEFT JOIN stores s ON s.site_code = i.site_code
      ${whereSql}
      GROUP BY i.site_code, i.sku
     HAVING COUNT(*) >= ${havingParam}
      ORDER BY COUNT(*) DESC, MAX(b.created_at) DESC
      LIMIT ${limitParam}`,
    params,
  );
  return r.rows.map((row) => ({
    site_code: row.site_code,
    shop: row.shop ?? '',
    sku: row.sku,
    brand: row.brand ?? '',
    sku_desc: row.sku_desc ?? '',
    occurrence_count: Number(row.occurrence_count ?? 0),
    pending_count: Number(row.pending_count ?? 0),
    replied_count: Number(row.replied_count ?? 0),
    weeks: row.weeks ?? [],
    first_seen: row.first_seen_raw ? toHKDateString(row.first_seen_raw) : '',
    last_seen: row.last_seen_raw ? toHKDateString(row.last_seen_raw) : '',
    last_week_label: row.last_week_label ?? '',
    last_status: row.last_status ?? '',
    last_reason_label: row.last_reason_label ?? '',
    last_reason_note: row.last_reason_note ?? '',
    last_replied_at: row.last_replied_raw ? toHKString(row.last_replied_raw) : null,
  }));
}

export async function listMyItems(siteCode: string, opts: { status?: string; batchId?: string }): Promise<ZeroSalesItemRow[]> {
  const where = ['i.site_code = $1'];
  const params: unknown[] = [siteCode];
  if (opts.status === 'pending' || opts.status === 'replied') { params.push(opts.status); where.push(`i.status = $${params.length}`); }
  if (opts.batchId) { params.push(opts.batchId); where.push(`i.batch_id = $${params.length}`); }
  const r = await query<ZeroSalesItemRow>(
    `SELECT i.*, b.week_label, b.created_at AS batch_created_at, b.closed_at AS batch_closed_at
     FROM zero_sales_items i
     JOIN zero_sales_batches b ON b.id = i.batch_id
     WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC, i.sku LIMIT 1000`,
    params,
  );
  const mapped = r.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    batch_created_at: row.batch_created_at ? toHKString(row.batch_created_at as unknown as string) : undefined,
    batch_closed_at: row.batch_closed_at ? toHKString(row.batch_closed_at as unknown as string) : null,
    is_open: !row.batch_closed_at,
    batch_date: row.batch_created_at ? toHKDateString(row.batch_created_at as unknown as string) : undefined,
  }));
  return attachZeroSalesHistory(mapped);
}

export class ZeroSalesReplyError extends Error {}

/** 店舖嘗試回覆已封存的週次：不可再寫入，前端應引導到最新一週 */
export class ZeroSalesBatchClosedError extends ZeroSalesReplyError {
  constructor(message: string) {
    super(message);
    this.name = 'ZeroSalesBatchClosedError';
  }
}

/** 店舖可見的週次清單：只包含曾派發給該店的行，按新到舊排（預設選最新一個開放的週次） */
export interface ZeroSalesMyBatchRow {
  id: string;
  week_label: string;
  created_at: string;
  closed_at: string | null;
  is_open: boolean;
  total: number;
  replied: number;
  pending: number;
}

export async function listMyBatches(siteCode: string): Promise<ZeroSalesMyBatchRow[]> {
  const r = await query<ZeroSalesMyBatchRow>(
    `SELECT b.id, b.week_label, b.created_at, b.closed_at,
            count(*)::int AS total,
            count(*) FILTER (WHERE i.status = 'replied')::int AS replied,
            count(*) FILTER (WHERE i.status = 'pending')::int AS pending
       FROM zero_sales_batches b
       JOIN zero_sales_items i ON i.batch_id = b.id AND i.site_code = $1
      GROUP BY b.id, b.week_label, b.created_at, b.closed_at
      ORDER BY b.created_at DESC LIMIT 52`,
    [siteCode],
  );
  return r.rows.map((b) => ({
    ...b,
    created_at: toHKString(b.created_at),
    closed_at: b.closed_at ? toHKString(b.closed_at) : null,
    is_open: !b.closed_at,
  }));
}

/** 刪除整個批次（items 經 FK ON DELETE CASCADE 一併清除），回傳週次及清除行數供審計。
 *  若刪除的是當時仍開放的批次，會自動重開剩下最新的批次，避免店舖完全沒有可回覆週次。 */
export async function deleteZeroSalesBatch(
  batchId: string,
): Promise<{ weekLabel: string; deletedItems: number; reopenedWeekLabel: string | null } | null> {
  return withTransaction(async (client) => {
    const existing = await client.query<{ week_label: string; closed_at: string | null }>(
      'SELECT week_label, closed_at FROM zero_sales_batches WHERE id = $1',
      [batchId],
    );
    const row = existing.rows[0];
    if (!row) return null;
    const counted = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM zero_sales_items WHERE batch_id = $1',
      [batchId],
    );
    await client.query('DELETE FROM zero_sales_batches WHERE id = $1', [batchId]);
    let reopenedWeekLabel: string | null = null;
    if (!row.closed_at) {
      const reopened = await client.query<{ week_label: string }>(
        `UPDATE zero_sales_batches
            SET closed_at = NULL, closed_by = '', close_reason = ''
          WHERE id = (SELECT id FROM zero_sales_batches
                       WHERE closed_at IS NOT NULL
                       ORDER BY created_at DESC, id DESC LIMIT 1)
      RETURNING week_label`,
      );
      reopenedWeekLabel = reopened.rows[0]?.week_label ?? null;
    }
    return { weekLabel: row.week_label, deletedItems: Number(counted.rows[0]?.count ?? 0), reopenedWeekLabel };
  });
}

/** 手動封存某一週次（例：本週提早截止）。已封存則原樣回傳。 */
export async function closeZeroSalesBatch(
  batchId: string,
  actor: string,
): Promise<{ weekLabel: string; pending: number; alreadyClosed: boolean } | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<{ week_label: string; closed_at: string | null }>(
      'SELECT week_label, closed_at FROM zero_sales_batches WHERE id = $1',
      [batchId],
    );
    const row = cur.rows[0];
    if (!row) return null;
    if (row.closed_at) {
      const counted = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM zero_sales_items WHERE batch_id = $1 AND status = 'pending'`,
        [batchId],
      );
      return { weekLabel: row.week_label, pending: Number(counted.rows[0]?.count ?? 0), alreadyClosed: true };
    }
    const closed = await client.query<{ pending: string }>(
      `UPDATE zero_sales_batches
          SET closed_at = now(), closed_by = $2, close_reason = 'manual'
        WHERE id = $1 AND closed_at IS NULL
    RETURNING (SELECT count(*)::text FROM zero_sales_items i
                WHERE i.batch_id = $1 AND i.status = 'pending') AS pending`,
      [batchId, actor],
    );
    return {
      weekLabel: row.week_label,
      pending: Number(closed.rows[0]?.pending ?? 0),
      alreadyClosed: false,
    };
  });
}

/** 例外重開某一舊週次（讓店舖補答）；新批次上載時會再次自動封存。 */
export async function reopenZeroSalesBatch(batchId: string): Promise<{ weekLabel: string; wasOpen: boolean } | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<{ week_label: string; closed_at: string | null }>(
      'SELECT week_label, closed_at FROM zero_sales_batches WHERE id = $1',
      [batchId],
    );
    const row = cur.rows[0];
    if (!row) return null;
    if (!row.closed_at) return { weekLabel: row.week_label, wasOpen: true };
    await client.query(
      `UPDATE zero_sales_batches SET closed_at = NULL, closed_by = '', close_reason = '' WHERE id = $1`,
      [batchId],
    );
    return { weekLabel: row.week_label, wasOpen: false };
  });
}

async function refreshZeroSalesBatchCounters(client: PoolClient, batchId: string): Promise<void> {
  await client.query(
    `UPDATE zero_sales_batches b
        SET row_count = (SELECT count(*) FROM zero_sales_items i WHERE i.batch_id = $1),
            store_count = (SELECT count(DISTINCT site_code) FROM zero_sales_items i WHERE i.batch_id = $1)
      WHERE b.id = $1`,
    [batchId],
  );
}

/** 刪除某批次內某店舖的全部行；批次不存在回 null，店舖無行回 { deletedItems: 0 }（由路由轉 404） */
export async function deleteZeroSalesBatchSite(batchId: string, siteCode: string): Promise<{ deletedItems: number } | null> {
  return withTransaction(async (client) => {
    const batch = await client.query('SELECT id FROM zero_sales_batches WHERE id = $1', [batchId]);
    if (!batch.rows[0]) return null;
    const del = await client.query<{ id: string }>(
      'DELETE FROM zero_sales_items WHERE batch_id = $1 AND site_code = $2 RETURNING id',
      [batchId, siteCode],
    );
    const deleted = del.rows.length;
    if (!deleted) return { deletedItems: 0 };
    await refreshZeroSalesBatchCounters(client, batchId);
    return { deletedItems: deleted };
  });
}

/** 刪除某批次內單一 SKU 行（以 item id 定位並限定 batch，避免跨批次誤刪） */
export async function deleteZeroSalesItem(batchId: string, itemId: string): Promise<{ siteCode: string; sku: string } | null> {
  return withTransaction(async (client) => {
    const del = await client.query<{ site_code: string; sku: string }>(
      'DELETE FROM zero_sales_items WHERE id = $1 AND batch_id = $2 RETURNING site_code, sku',
      [itemId, batchId],
    );
    const row = del.rows[0];
    if (!row) return null;
    await refreshZeroSalesBatchCounters(client, batchId);
    return { siteCode: row.site_code, sku: row.sku };
  });
}

export async function replyItem(input: {
  itemId: string;
  siteCode: string;
  reasonCode: string;
  reasonNote: string;
  repliedBy: string;
  repliedByUserId: string;
}): Promise<ZeroSalesItemRow> {
  const reasons = await listReasons(true);
  const found = reasons.find((r) => r.code === input.reasonCode);
  if (!found) throw new ZeroSalesReplyError('回覆原因無效，請重新選擇');
  const note = (input.reasonNote ?? '').trim();
  if (found.require_note && !note) throw new ZeroSalesReplyError(`選擇「${found.label}」必須填寫補充說明`);
  if (note.length > 2000) throw new ZeroSalesReplyError('補充說明最多 2000 字');
  const current = await query<{ id: string; status: string; reply_count: number; closed_at: string | null; week_label: string }>(
    `SELECT i.id, i.status, i.reply_count, b.closed_at, b.week_label
       FROM zero_sales_items i
       JOIN zero_sales_batches b ON b.id = i.batch_id
      WHERE i.id = $1 AND i.site_code = $2`,
    [input.itemId, input.siteCode],
  );
  const cur = current.rows[0];
  if (!cur) throw new ZeroSalesReplyError('找不到此 SKU 指派');
  if (cur.closed_at) {
    throw new ZeroSalesBatchClosedError(
      `「${cur.week_label}」已截止回覆（新一週已派發），此週次只供查閱。請到最新一週回覆。`,
    );
  }
  if ((cur.reply_count ?? 0) >= 2) {
    throw new ZeroSalesReplyError('此 SKU 已用完修改機會（只可修改一次），如需再更改請聯絡 RP Team');
  }
  // UPDATE 同時檢查批次仍開放，避免「檢查後剛好被新批次封存」的競態
  const r = await query<ZeroSalesItemRow>(
    `UPDATE zero_sales_items i SET status = 'replied', reason_code = $1, reason_label = $2, reason_note = $3,
      replied_at = now(), replied_by = $4, replied_by_user_id = $5, updated_at = now(),
      reply_count = reply_count + 1
     WHERE i.id = $6 AND i.site_code = $7
       AND EXISTS (SELECT 1 FROM zero_sales_batches b WHERE b.id = i.batch_id AND b.closed_at IS NULL)
     RETURNING i.*`,
    [found.code, found.label, note, input.repliedBy, input.repliedByUserId, input.itemId, input.siteCode],
  );
  const row = r.rows[0];
  if (!row) {
    throw new ZeroSalesBatchClosedError(
      `「${cur.week_label}」已截止回覆（新一週已派發），此週次只供查閱。請到最新一週回覆。`,
    );
  }
  return {
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    is_open: true,
    batch_date: undefined,
  };
}

/** 管理員代改店舖回覆：不受「只可修改一次」鎖定限制，亦不佔用店舖的修改次數（reply_count 不變） */
export async function adminReplyItem(input: {
  batchId: string;
  itemId: string;
  reasonCode: string;
  reasonNote: string;
}): Promise<{
  before: { reason_code: string | null; reason_label: string | null; reason_note: string };
  item: ZeroSalesItemRow;
}> {
  const reasons = await listReasons(false);
  const found = reasons.find((r) => r.code === input.reasonCode);
  if (!found) throw new ZeroSalesReplyError('回覆原因無效，請重新選擇');
  const note = (input.reasonNote ?? '').trim();
  if (found.require_note && !note) throw new ZeroSalesReplyError(`選擇「${found.label}」必須填寫補充說明`);
  if (note.length > 2000) throw new ZeroSalesReplyError('補充說明最多 2000 字');
  const current = await query<{ reason_code: string | null; reason_label: string | null; reason_note: string }>(
    'SELECT reason_code, reason_label, reason_note FROM zero_sales_items WHERE id = $1 AND batch_id = $2',
    [input.itemId, input.batchId],
  );
  const cur = current.rows[0];
  if (!cur) throw new ZeroSalesReplyError('找不到此 SKU 行（可能已被刪除）');
  if (!cur.reason_code) throw new ZeroSalesReplyError('此 SKU 尚未回覆，沒有可編輯的回覆');
  const r = await query<ZeroSalesItemRow>(
    `UPDATE zero_sales_items SET reason_code = $1, reason_label = $2, reason_note = $3, updated_at = now()
     WHERE id = $4 AND batch_id = $5
     RETURNING *`,
    [found.code, found.label, note, input.itemId, input.batchId],
  );
  const row = r.rows[0];
  if (!row) throw new ZeroSalesReplyError('找不到此 SKU 行（可能已被刪除）');
  return {
    before: { reason_code: cur.reason_code, reason_label: cur.reason_label, reason_note: cur.reason_note },
    item: {
      ...row,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
      replied_at: row.replied_at ? toHKString(row.replied_at) : null,
      batch_date: undefined,
    },
  };
}
