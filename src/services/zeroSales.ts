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
  /** 封存時間 (null = 派發中，未封存) */
  closed_at: string | null;
  closed_by: string;
  close_reason: string;
  /** 是否已封存（只供查閱）；與 closed_at 同步 */
  is_archived: boolean;
  /** 本週是否需要店舖回覆；false = 「本週無須回覆」，只顯示 Top 10 清單 */
  reply_required: boolean;
  /** 給店舖看的說明（空白 = 用預設文案） */
  reply_notice: string;
  /** 店舖現時可否回覆 = 未封存 AND 需要回覆 */
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
  /** 此行所屬週次是否需要回覆；false = 「本週無須回覆」，只供參考 */
  reply_required?: boolean;
  /** 此行現時可否回覆 = 未封存 AND 需要回覆 */
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
  /** 上一次回覆的原因 code（快捷「帶入上次回覆」用，無則為 null） */
  prev_reason_code?: string | null;
  prev_reason_label?: string | null;
  prev_reason_note?: string;
  prev_replied_at?: string | null;
  /** 此行的回覆是否由系統自動套用上次回覆（店舖尚未自行提交） */
  auto_filled?: boolean;
  auto_filled_at?: string | null;
  /** 自動套用的來源批次 / 週次 */
  auto_filled_from_batch_id?: string | null;
  auto_filled_from_week?: string;
  /** 此行的寫入上限：2 = 初次回覆 + 1 次修改；3 = 自動套用 + 2 次修改 */
  reply_limit?: number;
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

function mapBatchRow(b: ZeroSalesBatchRow): ZeroSalesBatchRow {
  const replyRequired = b.reply_required !== false;
  return {
    ...b,
    created_at: toHKString(b.created_at),
    closed_at: b.closed_at ? toHKString(b.closed_at) : null,
    reply_required: replyRequired,
    reply_notice: b.reply_notice ?? '',
    is_archived: Boolean(b.closed_at),
    is_open: !b.closed_at && replyRequired,
  };
}

export async function listBatches(): Promise<ZeroSalesBatchRow[]> {
  const r = await query<ZeroSalesBatchRow>(
    `SELECT b.*,
      (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'replied') AS replied_count,
      (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending_count
     FROM zero_sales_batches b ORDER BY b.created_at DESC, b.id DESC LIMIT 100`,
  );
  return r.rows.map(mapBatchRow);
}

export interface ZeroSalesBatchPage {
  batches: ZeroSalesBatchRow[];
  total: number;
}

export async function listBatchesPage(opts: { page?: number; pageSize?: number } = {}): Promise<ZeroSalesBatchPage> {
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(opts.pageSize ?? 20) || 20));
  const offset = (page - 1) * pageSize;
  const [count, r] = await Promise.all([
    query<{ count: string }>('SELECT count(*)::text AS count FROM zero_sales_batches'),
    query<ZeroSalesBatchRow>(
      `SELECT b.*,
        (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'replied') AS replied_count,
        (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending_count
       FROM zero_sales_batches b ORDER BY b.created_at DESC, b.id DESC LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
  ]);
  return { total: Number(count.rows[0]?.count ?? 0), batches: r.rows.map(mapBatchRow) };
}

export interface ZeroSalesBatchOption {
  id: string;
  week_label: string;
  closed_at: string | null;
  close_reason: string;
  /** false = 本週無須回覆（只顯示 Top 10，不計入待回覆） */
  reply_required: boolean;
  replied_count: number;
  pending_count: number;
  is_archived: boolean;
  is_open: boolean;
}

/** Lightweight list of every batch for the export / stats dropdowns (not paginated). */
export async function listBatchOptions(): Promise<ZeroSalesBatchOption[]> {
  const r = await query<Omit<ZeroSalesBatchOption, 'is_open' | 'is_archived'> & { reply_required: boolean | null }>(
    `SELECT b.id, b.week_label, b.closed_at, b.close_reason, b.reply_required,
      (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'replied') AS replied_count,
      (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending_count
     FROM zero_sales_batches b ORDER BY b.created_at DESC, b.id DESC`,
  );
  return r.rows.map((b) => {
    const replyRequired = b.reply_required !== false;
    return {
      ...b,
      reply_required: replyRequired,
      closed_at: b.closed_at ? toHKString(b.closed_at) : null,
      is_archived: Boolean(b.closed_at),
      is_open: !b.closed_at && replyRequired,
    };
  });
}

export interface ZeroSalesSummary {
  batches: number;
  /** 全部派發行數（含「無須回覆」週次，方便知道曾派發幾多 SKU） */
  total: number;
  replied: number;
  /** 仍可回覆的未回覆行數（只在開放且需要回覆的週次） */
  pending: number;
  /** 已封存週次中當時未回覆的行數（只供歷史統計，店舖不可再回覆；不含無須回覆週次） */
  overdue: number;
  /** 「本週無須回覆」週次的行數（不計入 pending / overdue / 回覆率分母） */
  no_reply: number;
  /** 「本週無須回覆」的批次數 */
  no_reply_batches: number;
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
    stores_total: number;
    stores_pending: number;
    created_at: string;
    closed_at: string | null;
    /** 該週次是否需要店舖回覆（false = 本週無須回覆） */
    reply_required: boolean;
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
 * 跨批次模式下 pending 只計仍開放且需要回覆的週次，已封存而未回覆的行另計 overdue；
 * 指定 batch_id 時則如實顯示該批次的 pending（供後台查歷史），overdue 固定為 0。
 * 「本週無須回覆」的批次：行數另計 no_reply，永不計入 pending / overdue，亦不計入回覆率分母。
 */
export async function getZeroSalesSummary(batchId?: string): Promise<ZeroSalesSummary> {
  const batchFilter = batchId ? 'AND i.batch_id = $1' : '';
  // 跨批次：「可回覆」= 批次未封存 AND 需要回覆；指定批次：不設封存限制（照示該批歷史狀態），但仍要需要回覆
  const openFilter = batchId
    ? 'EXISTS (SELECT 1 FROM zero_sales_batches ob WHERE ob.id = i.batch_id AND ob.reply_required = true)'
    : 'EXISTS (SELECT 1 FROM zero_sales_batches ob WHERE ob.id = i.batch_id AND ob.closed_at IS NULL AND ob.reply_required = true)';
  const closedFilter = batchId
    ? 'FALSE'
    : 'EXISTS (SELECT 1 FROM zero_sales_batches cb WHERE cb.id = i.batch_id AND cb.closed_at IS NOT NULL AND cb.reply_required = true)';
  // 無須回覆的行：不計入待辦 / 逾期 / 回覆率
  const noReplyFilter = 'EXISTS (SELECT 1 FROM zero_sales_batches nb WHERE nb.id = i.batch_id AND nb.reply_required = false)';
  const params: unknown[] = batchId ? [batchId] : [];
  const overall = await query<{
    batches: string;
    no_reply_batches: string;
    total: string;
    replied: string;
    replied_required: string;
    no_reply: string;
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
      (SELECT count(*)::text FROM zero_sales_batches b WHERE b.reply_required = false
        ${batchId ? 'AND b.id = $1' : ''}) AS no_reply_batches,
      (SELECT count(*)::text FROM zero_sales_items i WHERE TRUE ${batchFilter}) AS total,
      (SELECT count(*)::text FROM zero_sales_items i WHERE i.status = 'replied' ${batchFilter}) AS replied,
      (SELECT count(*)::text FROM zero_sales_items i WHERE i.status = 'replied' AND NOT (${noReplyFilter}) ${batchFilter}) AS replied_required,
      (SELECT count(*)::text FROM zero_sales_items i WHERE TRUE AND (${noReplyFilter}) ${batchFilter}) AS no_reply,
      (SELECT count(*)::text FROM zero_sales_items i WHERE i.status = 'pending' AND (${openFilter}) ${batchFilter}) AS pending,
      (SELECT count(*)::text FROM zero_sales_items i WHERE i.status = 'pending' AND (${closedFilter}) ${batchFilter}) AS overdue,
      (SELECT count(*)::text FROM zero_sales_items i WHERE i.reply_count >= COALESCE(i.reply_limit, 2) ${batchFilter}) AS locked,
      (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE TRUE ${batchFilter}) AS stores_total,
      (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE i.status = 'pending' AND (${openFilter}) ${batchFilter}) AS stores_pending,
      (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE i.status = 'pending' AND (${closedFilter}) ${batchFilter}) AS stores_overdue,
      (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE i.status = 'pending' AND ((${openFilter}) OR (${closedFilter})) ${batchFilter}) AS stores_unresolved`,
    params,
  );
  const o = overall.rows[0]!;
  const total = Number(o.total ?? 0);
  const replied = Number(o.replied ?? 0);
  const noReply = Number(o.no_reply ?? 0);
  // 回覆率只針對「需要回覆」的行，避免無須回覆的週次拖低比率
  const requiredTotal = Math.max(0, total - noReply);
  const repliedRequired = Number(o.replied_required ?? 0);
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
    stores_total: string;
    stores_pending: string;
    created_at: string;
    closed_at: string | null;
    reply_required: boolean;
  }>(
    `SELECT b.id, b.week_label, b.created_at, b.closed_at, b.reply_required,
            (SELECT count(*)::text FROM zero_sales_items i WHERE i.batch_id = b.id) AS total,
            (SELECT count(*)::text FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'replied') AS replied,
            (SELECT count(*)::text FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending,
            (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE i.batch_id = b.id) AS stores_total,
            (SELECT count(DISTINCT i.site_code)::text FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS stores_pending
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
    no_reply: noReply,
    no_reply_batches: Number(o.no_reply_batches ?? 0),
    locked: Number(o.locked ?? 0),
    reply_rate: requiredTotal ? Math.min(100, Math.round((repliedRequired / requiredTotal) * 1000) / 10) : 0,
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
          // 無須回覆的週次：pending 一律顯示 0，避免變成清不完的待辦
          pending: lb.reply_required === false ? 0 : Number(lb.pending ?? 0),
          stores_total: Number(lb.stores_total ?? 0),
          stores_pending: lb.reply_required === false ? 0 : Number(lb.stores_pending ?? 0),
          created_at: toHKString(lb.created_at),
          closed_at: lb.closed_at ? toHKString(lb.closed_at) : null,
          reply_required: lb.reply_required !== false,
          is_open: !lb.closed_at && lb.reply_required !== false,
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
 *  不指定批次時只計仍開放的週次（已封存的未回覆不會再變成回覆，不應留在待辦名單）。
 *  「本週無須回覆」的週次永不列入待辦。 */
export async function listZeroSalesPendingStores(filter: { batchId?: string; om?: string } = {}): Promise<ZeroSalesPendingStoreRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  // 「本週無須回覆」的週次沒有待辦；指定批次時仍要檢查該批次是否需要回覆
  if (filter.batchId) {
    params.push(filter.batchId);
    where.push(`i.batch_id = $${params.length}`);
    where.push(`EXISTS (SELECT 1 FROM zero_sales_batches b WHERE b.id = i.batch_id AND b.reply_required = true)`);
  } else {
    where.push(`EXISTS (SELECT 1 FROM zero_sales_batches b WHERE b.id = i.batch_id AND b.closed_at IS NULL AND b.reply_required = true)`);
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

/** 統一匯出查詢：可跨批次按 Site / 狀態 / 原因篩選（上限 50000 行，約 2 年每週批次量） */
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
    `SELECT i.*, b.week_label, b.reply_required, b.created_at AS batch_created_at, b.closed_at AS batch_closed_at
     FROM zero_sales_items i
     JOIN zero_sales_batches b ON b.id = i.batch_id
     ${whereSql} ORDER BY b.created_at DESC, i.site_code, i.sku LIMIT 50000`,
    params,
  );
  return r.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    auto_filled_at: row.auto_filled_at ? toHKString(row.auto_filled_at as unknown as string) : null,
    auto_filled: Boolean(row.auto_filled_at),
    auto_filled_from_week: row.auto_filled_from_week ?? '',
    reply_limit: row.reply_limit ?? 2,
    batch_created_at: row.batch_created_at ? toHKString(row.batch_created_at as unknown as string) : undefined,
    batch_closed_at: row.batch_closed_at ? toHKString(row.batch_closed_at as unknown as string) : null,
    is_open: !row.batch_closed_at && row.reply_required !== false,
    batch_date: row.batch_created_at ? toHKDateString(row.batch_created_at as unknown as string) : undefined,
  }));
}

export interface ZeroSalesAutoFillResult {
  batch_id: string;
  week_label: string;
  /** 今次成功自動套用的行數 */
  applied: number;
  /** 執行前批次內的未回覆行數 */
  pending_before: number;
  /** 執行前批次內的已回覆行數 */
  replied_before: number;
  /** 執行後仍待回覆的行數 */
  remaining_pending: number;
}

/**
 * 為某一批次內「仍 pending」的重複上榜行，自動套用同店同 SKU 對上一次「出現」的店舖回覆。
 * 只有上一次出現本身是已回覆時才會套用；上次未回覆則保持 pending（不拿更舊的回覆硬套）。
 * - 永不修改 status='replied' 的行，所以已回覆店舖 / 已回覆 SKU 一定不受影響。
 * - onlyUnrepliedStores=true 時，只處理「完全未有人手回覆」的店舖：
 *   店舖只要有任何一行是店舖自行回覆（auto_filled_at IS NULL），全店跳過。
 * - 上次原因已停用、或需要補充說明但上次沒有填，會跳過並保持 pending，交由店舖自行回覆。
 */
async function autoFillZeroSalesRepliesWithClient(
  client: PoolClient,
  batchId: string,
  onlyUnrepliedStores: boolean,
): Promise<ZeroSalesAutoFillResult | null> {
  const batch = await client.query<{ week_label: string; reply_required: boolean }>(
    'SELECT week_label, reply_required FROM zero_sales_batches WHERE id = $1',
    [batchId],
  );
  const batchRow = batch.rows[0];
  if (!batchRow) return null;
  // 「本週無須回覆」的週次毋須逐條確認，套用只會製造無意義的 replied 紀錄
  if (batchRow.reply_required === false) {
    throw new ZeroSalesReplyError(`「${batchRow.week_label}」本週無須回覆，不需要自動套用重複回覆。`);
  }

  const applied = await client.query<{ applied: number }>(
    `WITH target AS (
       SELECT i.id, i.site_code, i.sku, b.created_at AS batch_created_at
         FROM zero_sales_items i
         JOIN zero_sales_batches b ON b.id = i.batch_id
        WHERE i.batch_id = $1 AND i.status = 'pending'
     ),
     prev AS (
       SELECT DISTINCT ON (t.id)
              t.id AS item_id,
              p.batch_id AS prev_batch_id,
              pb.week_label AS prev_week_label,
              p.status AS prev_status,
              p.reason_code,
              COALESCE(r.label, p.reason_label, p.reason_code) AS reason_label,
              COALESCE(p.reason_note, '') AS reason_note,
              r.active AS reason_active,
              r.require_note AS reason_require_note
         FROM target t
         JOIN zero_sales_items p
           ON p.site_code = t.site_code
          AND p.sku = t.sku
         JOIN zero_sales_batches pb ON pb.id = p.batch_id
         LEFT JOIN zero_sales_reasons r ON r.code = p.reason_code
        WHERE (pb.created_at, pb.id) < (t.batch_created_at, $1)
        ORDER BY t.id, pb.created_at DESC, pb.id DESC
     ),
     updated AS (
       UPDATE zero_sales_items i
          SET status = 'replied',
              reason_code = p.reason_code,
              reason_label = p.reason_label,
              reason_note = p.reason_note,
              replied_at = now(),
              replied_by = '系統自動套用（' || p.prev_week_label || '）',
              replied_by_user_id = NULL,
              reply_count = 1,
              reply_limit = 3,
              auto_filled_at = now(),
              auto_filled_from_batch_id = p.prev_batch_id,
              auto_filled_from_week = p.prev_week_label,
              updated_at = now()
         FROM prev p
        WHERE i.id = p.item_id
          AND i.status = 'pending'
          AND p.prev_status = 'replied'
          AND p.reason_code IS NOT NULL
          AND p.reason_active IS TRUE
          AND NOT (p.reason_require_note IS TRUE AND BTRIM(p.reason_note) = '')
          AND ($2::boolean IS FALSE OR NOT EXISTS (
            SELECT 1 FROM zero_sales_items x
             WHERE x.batch_id = $1
               AND x.site_code = i.site_code
               AND x.status = 'replied'
               AND x.auto_filled_at IS NULL
          ))
        RETURNING 1
     )
     SELECT count(*)::int AS applied FROM updated`,
    [batchId, onlyUnrepliedStores],
  );
  const appliedCount = Number(applied.rows[0]?.applied ?? 0);

  const after = await client.query<{ remaining_pending: number; replied_after: number }>(
    `SELECT
       (SELECT count(*)::int FROM zero_sales_items WHERE batch_id = $1 AND status = 'pending') AS remaining_pending,
       (SELECT count(*)::int FROM zero_sales_items WHERE batch_id = $1 AND status = 'replied') AS replied_after`,
    [batchId],
  );
  const remainingPending = Number(after.rows[0]?.remaining_pending ?? 0);
  const repliedAfter = Number(after.rows[0]?.replied_after ?? 0);
  return {
    batch_id: batchId,
    week_label: batchRow.week_label,
    applied: appliedCount,
    pending_before: remainingPending + appliedCount,
    replied_before: Math.max(0, repliedAfter - appliedCount),
    remaining_pending: remainingPending,
  };
}

/** 後台手動為某一批次補套用（例如 2026-W43 已有部分店舖回覆，只套用未回覆店舖） */
export async function autoFillZeroSalesReplies(
  batchId: string,
  opts: { onlyUnrepliedStores?: boolean } = {},
): Promise<ZeroSalesAutoFillResult | null> {
  return withTransaction((client) =>
    autoFillZeroSalesRepliesWithClient(client, batchId, opts.onlyUnrepliedStores === true),
  );
}

export async function createBatch(input: {
  weekLabel: string;
  note: string;
  rows: Array<{ siteCode: string; sku: string; data: Record<string, string> }>;
  contentHash: string;
  createdBy: string;
  /** 預設 true：重複上榜 SKU 自動套用上一次的店舖回覆（只套用新批次的 pending 行） */
  autoFillRepeats?: boolean;
  /** 預設 true：需要店舖回覆；false = 「本週無須回覆」，只顯示 Top 10 清單（不會自動套用重複回覆） */
  replyRequired?: boolean;
  /** 給店舖看的說明（空白 = 前端用預設文案） */
  replyNotice?: string;
}): Promise<{ batchId: string; closedBatches: ZeroSalesClosedBatch[]; autoFilled: number; replyRequired: boolean }> {
  const replyRequired = input.replyRequired !== false;
  return withTransaction(async (client) => {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO zero_sales_batches (week_label, note, row_count, store_count, content_hash, created_by, reply_required, reply_notice)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.weekLabel,
        input.note ?? '',
        input.rows.length,
        new Set(input.rows.map((r) => r.siteCode)).size,
        input.contentHash,
        input.createdBy,
        replyRequired,
        (input.replyNotice ?? '').trim(),
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

    // 新批次所有行預設 pending，可安全地為重複上榜 SKU 套用上一次的店舖回覆。
    // 呢個步驟只會改 pending 行，不會影響任何已回覆紀錄。
    // 「本週無須回覆」的週次不套用：店舖毋須逐條確認，套用只會製造無意義的 replied 紀錄。
    let autoFilled = 0;
    if (input.autoFillRepeats !== false && replyRequired) {
      const filled = await autoFillZeroSalesRepliesWithClient(client, batchId, false);
      autoFilled = filled?.applied ?? 0;
    }

    return {
      batchId,
      closedBatches: closed.rows.map((r) => ({
        id: r.id,
        week_label: r.week_label,
        pending: Number(r.pending ?? 0),
      })),
      autoFilled,
      replyRequired,
    };
  });
}

export async function listBatchItems(batchId: string, opts: { siteCode?: string; status?: string }): Promise<ZeroSalesItemRow[]> {
  const where = ['i.batch_id = $1'];
  const params: unknown[] = [batchId];
  if (opts.siteCode) { params.push(opts.siteCode); where.push(`i.site_code = $${params.length}`); }
  if (opts.status === 'pending' || opts.status === 'replied') { params.push(opts.status); where.push(`i.status = $${params.length}`); }
  const r = await query<ZeroSalesItemRow>(
    `SELECT i.*, b.week_label, b.reply_required, b.created_at AS batch_created_at, b.closed_at AS batch_closed_at
     FROM zero_sales_items i
     JOIN zero_sales_batches b ON b.id = i.batch_id
     WHERE ${where.join(' AND ')} ORDER BY i.site_code, i.sku LIMIT 2000`,
    params,
  );
  const mapped = r.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    auto_filled_at: row.auto_filled_at ? toHKString(row.auto_filled_at as unknown as string) : null,
    auto_filled: Boolean(row.auto_filled_at),
    auto_filled_from_week: row.auto_filled_from_week ?? '',
    reply_limit: row.reply_limit ?? 2,
    batch_created_at: row.batch_created_at ? toHKString(row.batch_created_at as unknown as string) : undefined,
    batch_closed_at: row.batch_closed_at ? toHKString(row.batch_closed_at as unknown as string) : null,
    is_open: !row.batch_closed_at && row.reply_required !== false,
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
  reason_code: string | null;
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
              h.status, h.reason_code, h.reason_label, COALESCE(h.reason_note, '') AS reason_note, h.replied_at
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
      prev_reason_code: prev?.reason_code ?? null,
      prev_reason_label: prev?.reason_label ?? null,
      prev_reason_note: prev?.reason_note ?? '',
      prev_replied_at: prev?.replied_at ? toHKString(prev.replied_at) : null,
    };
  });
}

export interface ZeroSalesRepeatRow {
  site_code: string;
  shop: string;
  /** 店舖所屬 OM（門店主檔未設定時為空字串） */
  om: string;
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

/** 後台重複上榜統計：同店同 SKU 跨批次出現 ≥ minCount，按次數倒序（匯出最多 5000 行；API 只允許 500） */
export async function listZeroSalesRepeats(filter: ZeroSalesRepeatFilter = {}): Promise<ZeroSalesRepeatRow[]> {
  const minCount = Math.min(20, Math.max(2, Math.floor(filter.minCount ?? 2) || 2));
  const limit = Math.min(5000, Math.max(1, Math.floor(filter.limit ?? 200) || 200));
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
    om: string;
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
    `SELECT i.site_code, COALESCE(MAX(s.shop), '') AS shop,
            COALESCE(MAX(NULLIF(BTRIM(s.om), '')), '') AS om, i.sku,
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
    om: row.om ?? '',
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

export interface ZeroSalesRepeatSkuRow {
  sku: string;
  brand: string;
  sku_desc: string;
  /** 該 SKU 主要 Buyer（取最新一行的 Buyer，跨店通常一致；不一致時取最新） */
  buyer: string;
  /** 有重複上榜（同店同 SKU ≥ minCount）的店舖數 */
  repeat_store_count: number;
  /** 曾上榜（至少一次）的店舖數 */
  listed_store_count: number;
  /** 重複店數 ÷ 曾上榜店數（0–1） */
  repeat_rate: number;
  /** 屬重複組的行數 */
  repeat_rows: number;
  /** 全部行數（所有店舖所有週次） */
  total_rows: number;
  /** 單店最高上榜次數 */
  max_occurrence: number;
  pending_count: number;
  replied_count: number;
  last_week_label: string;
  last_seen: string;
}

export interface ZeroSalesRepeatSkuFilter {
  siteCode?: string;
  /** 模糊搜尋 SKU */
  q?: string;
  /** 按 Buyer 模糊篩選（payload Buyer 欄） */
  buyer?: string;
  /** 同店同 SKU 最少出現次數，預設 2 */
  minCount?: number;
  limit?: number;
}

/**
 * 跨店重複上榜 SKU 排行：同一 SKU 在多間店舖各自重複上榜（同店同 SKU ≥ minCount）。
 * 用於分辨「SKU 問題」與「店舖問題」：重複店數越多、重複率越高，
 * 越可能是 SKU 本身（陳列／價格／推廣／季節性）而非個別店舖執行問題。
 * 以重複店數倒序，再按重複行數、總行數倒序。
 */
export async function listZeroSalesRepeatSkus(
  filter: ZeroSalesRepeatSkuFilter = {},
): Promise<ZeroSalesRepeatSkuRow[]> {
  const minCount = Math.min(20, Math.max(2, Math.floor(filter.minCount ?? 2) || 2));
  const limit = Math.min(100, Math.max(1, Math.floor(filter.limit ?? 10) || 10));
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.siteCode) {
    params.push(filter.siteCode);
    where.push(`i.site_code = $${params.length}`);
  }
  if (filter.q) {
    params.push(`%${filter.q}%`);
    where.push(`i.sku ILIKE $${params.length}`);
  }
  if (filter.buyer) {
    params.push(`%${filter.buyer}%`);
    where.push(`COALESCE(i.payload->>'Buyer', '') ILIKE $${params.length}`);
  }
  params.push(minCount);
  const minParam = `$${params.length}`;
  params.push(limit);
  const limitParam = `$${params.length}`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await query<{
    sku: string;
    brand: string | null;
    sku_desc: string | null;
    buyer: string | null;
    repeat_store_count: number;
    listed_store_count: number;
    repeat_rows: number;
    total_rows: number;
    max_occurrence: number;
    pending_count: number;
    replied_count: number;
    last_week_label: string | null;
    last_seen_raw: string | null;
  }>(
    `WITH pair AS (
       SELECT i.site_code, i.sku,
              COUNT(*)::int AS occ,
              COUNT(*) FILTER (WHERE i.status = 'pending')::int AS pending_count,
              COUNT(*) FILTER (WHERE i.status = 'replied')::int AS replied_count,
              MAX(b.created_at) AS last_seen,
              (ARRAY_AGG(b.week_label ORDER BY b.created_at DESC))[1] AS last_week_label,
              (ARRAY_AGG(COALESCE(i.payload->>'Brand', '') ORDER BY b.created_at DESC))[1] AS brand,
              (ARRAY_AGG(COALESCE(i.payload->>'SKU Desc', '') ORDER BY b.created_at DESC))[1] AS sku_desc,
              (ARRAY_AGG(COALESCE(i.payload->>'Buyer', '') ORDER BY b.created_at DESC))[1] AS buyer
         FROM zero_sales_items i
         JOIN zero_sales_batches b ON b.id = i.batch_id
        ${whereSql}
        GROUP BY i.site_code, i.sku
     ),
     rollup AS (
       SELECT p.sku,
              COUNT(*) FILTER (WHERE p.occ >= ${minParam})::int AS repeat_store_count,
              COUNT(*)::int AS listed_store_count,
              COALESCE(SUM(p.occ) FILTER (WHERE p.occ >= ${minParam}), 0)::int AS repeat_rows,
              SUM(p.occ)::int AS total_rows,
              (MAX(p.occ) FILTER (WHERE p.occ >= ${minParam}))::int AS max_occurrence,
              COALESCE(SUM(p.pending_count) FILTER (WHERE p.occ >= ${minParam}), 0)::int AS pending_count,
              COALESCE(SUM(p.replied_count) FILTER (WHERE p.occ >= ${minParam}), 0)::int AS replied_count,
              (MAX(p.last_seen) FILTER (WHERE p.occ >= ${minParam}))::text AS last_seen_raw,
              (ARRAY_AGG(p.last_week_label ORDER BY p.last_seen DESC) FILTER (WHERE p.occ >= ${minParam}))[1] AS last_week_label,
              (ARRAY_AGG(p.brand ORDER BY p.last_seen DESC) FILTER (WHERE p.occ >= ${minParam}))[1] AS brand,
              (ARRAY_AGG(p.sku_desc ORDER BY p.last_seen DESC) FILTER (WHERE p.occ >= ${minParam}))[1] AS sku_desc,
              (ARRAY_AGG(p.buyer ORDER BY p.last_seen DESC) FILTER (WHERE p.occ >= ${minParam}))[1] AS buyer
         FROM pair p
        GROUP BY p.sku
       HAVING COUNT(*) FILTER (WHERE p.occ >= ${minParam}) >= 1
     )
     SELECT sku, brand, sku_desc, buyer, repeat_store_count, listed_store_count,
            repeat_rows, total_rows, max_occurrence, pending_count, replied_count,
            last_week_label, last_seen_raw
       FROM rollup
      ORDER BY repeat_store_count DESC, repeat_rows DESC, total_rows DESC, sku
      LIMIT ${limitParam}`,
    params,
  );
  return r.rows.map((row) => {
    const repeatStoreCount = Number(row.repeat_store_count ?? 0);
    const listedStoreCount = Number(row.listed_store_count ?? 0);
    return {
      sku: row.sku,
      brand: row.brand ?? '',
      sku_desc: row.sku_desc ?? '',
      buyer: row.buyer ?? '',
      repeat_store_count: repeatStoreCount,
      listed_store_count: listedStoreCount,
      repeat_rate: listedStoreCount > 0 ? repeatStoreCount / listedStoreCount : 0,
      repeat_rows: Number(row.repeat_rows ?? 0),
      total_rows: Number(row.total_rows ?? 0),
      max_occurrence: Number(row.max_occurrence ?? 0),
      pending_count: Number(row.pending_count ?? 0),
      replied_count: Number(row.replied_count ?? 0),
      last_week_label: row.last_week_label ?? '',
      last_seen: row.last_seen_raw ? toHKDateString(row.last_seen_raw) : '',
    };
  });
}

export async function listMyItems(siteCode: string, opts: { status?: string; batchId?: string }): Promise<ZeroSalesItemRow[]> {
  const where = ['i.site_code = $1'];  const params: unknown[] = [siteCode];
  if (opts.status === 'pending' || opts.status === 'replied') { params.push(opts.status); where.push(`i.status = $${params.length}`); }
  if (opts.batchId) { params.push(opts.batchId); where.push(`i.batch_id = $${params.length}`); }
  const r = await query<ZeroSalesItemRow>(
    `SELECT i.*, b.week_label, b.reply_required, b.created_at AS batch_created_at, b.closed_at AS batch_closed_at
     FROM zero_sales_items i
     JOIN zero_sales_batches b ON b.id = i.batch_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.created_at DESC,
              CASE WHEN i.status = 'pending' THEN 0 ELSE 1 END,
              i.sku
     LIMIT 1000`,
    params,
  );
  const mapped = r.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    auto_filled_at: row.auto_filled_at ? toHKString(row.auto_filled_at as unknown as string) : null,
    auto_filled: Boolean(row.auto_filled_at),
    auto_filled_from_week: row.auto_filled_from_week ?? '',
    reply_limit: row.reply_limit ?? 2,
    batch_created_at: row.batch_created_at ? toHKString(row.batch_created_at as unknown as string) : undefined,
    batch_closed_at: row.batch_closed_at ? toHKString(row.batch_closed_at as unknown as string) : null,
    is_open: !row.batch_closed_at && row.reply_required !== false,
    batch_date: row.batch_created_at ? toHKDateString(row.batch_created_at as unknown as string) : undefined,
  }));
  return attachZeroSalesHistory(mapped);
}

/**
 * OM 版：一次取得多間店舖的零銷售行（site codes 由呼叫者按登入 OM 強制帶入）。
 * 篩選與店舖版一致：batch / site / status / 搜尋 SKU、Brand、描述。
 */
export async function listItemsForSites(
  siteCodes: string[],
  opts: { status?: string; batchId?: string; siteCode?: string; q?: string; limit?: number } = {},
): Promise<ZeroSalesItemRow[]> {
  if (!siteCodes.length) return [];
  const where = ['i.site_code = ANY($1::text[])'];
  const params: unknown[] = [siteCodes];
  if (opts.batchId) {
    params.push(opts.batchId);
    where.push(`i.batch_id = $${params.length}`);
  }
  if (opts.siteCode) {
    params.push(opts.siteCode);
    where.push(`i.site_code = $${params.length}`);
  }
  if (opts.status === 'pending' || opts.status === 'replied') {
    params.push(opts.status);
    where.push(`i.status = $${params.length}`);
  }
  const q = (opts.q ?? '').trim();
  if (q) {
    params.push(`%${q}%`);
    where.push(
      `(i.sku ILIKE $${params.length} OR COALESCE(i.payload->>'Brand', '') ILIKE $${params.length} OR COALESCE(i.payload->>'SKU Desc', '') ILIKE $${params.length})`,
    );
  }
  const limit = Math.min(5000, Math.max(1, Math.floor(opts.limit ?? 3000) || 3000));
  params.push(limit);
  const r = await query<ZeroSalesItemRow>(
    `SELECT i.*, b.week_label, b.reply_required, b.created_at AS batch_created_at, b.closed_at AS batch_closed_at
       FROM zero_sales_items i
       JOIN zero_sales_batches b ON b.id = i.batch_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.created_at DESC,
               CASE WHEN i.status = 'pending' THEN 0 ELSE 1 END,
               i.site_code, i.sku
      LIMIT $${params.length}`,
    params,
  );
  const mapped = r.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    auto_filled_at: row.auto_filled_at ? toHKString(row.auto_filled_at as unknown as string) : null,
    auto_filled: Boolean(row.auto_filled_at),
    auto_filled_from_week: row.auto_filled_from_week ?? '',
    reply_limit: row.reply_limit ?? 2,
    batch_created_at: row.batch_created_at ? toHKString(row.batch_created_at as unknown as string) : undefined,
    batch_closed_at: row.batch_closed_at ? toHKString(row.batch_closed_at as unknown as string) : null,
    is_open: !row.batch_closed_at && row.reply_required !== false,
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

/** 店舖嘗試回覆「本週無須回覆」的週次：只供參考，不應視為錯誤操作（前端靜默轉為唯讀） */
export class ZeroSalesReplyNotRequiredError extends ZeroSalesReplyError {
  constructor(message: string) {
    super(message);
    this.name = 'ZeroSalesReplyNotRequiredError';
  }
}

/** 店舖可見的週次清單：只包含曾派發給該店的行，按新到舊排（預設選最新一個開放的週次） */
export interface ZeroSalesMyBatchRow {
  id: string;
  week_label: string;
  created_at: string;
  closed_at: string | null;
  /** 是否需要店舖回覆；false = 本週無須回覆（只顯示 Top 10 清單） */
  reply_required: boolean;
  /** 給店舖看的說明（空白 = 前端用預設文案） */
  reply_notice: string;
  is_archived: boolean;
  /** 現時可否回覆 = 未封存 AND 需要回覆 */
  is_open: boolean;
  total: number;
  replied: number;
  /** 未回覆數：無須回覆的週次恆為 0，避免變成清不完的待辦 */
  pending: number;
}

export async function listMyBatches(siteCode: string): Promise<ZeroSalesMyBatchRow[]> {
  const r = await query<Omit<ZeroSalesMyBatchRow, 'is_open' | 'is_archived' | 'reply_required' | 'reply_notice'> & {
    reply_required: boolean | null;
    reply_notice: string | null;
  }>(
    `SELECT b.id, b.week_label, b.created_at, b.closed_at, b.reply_required, b.reply_notice,
            count(*)::int AS total,
            count(*) FILTER (WHERE i.status = 'replied')::int AS replied,
            count(*) FILTER (WHERE i.status = 'pending')::int AS pending
       FROM zero_sales_batches b
       JOIN zero_sales_items i ON i.batch_id = b.id AND i.site_code = $1
      GROUP BY b.id, b.week_label, b.created_at, b.closed_at, b.reply_required, b.reply_notice
      ORDER BY b.created_at DESC LIMIT 52`,
    [siteCode],
  );
  return r.rows.map((b) => {
    const replyRequired = b.reply_required !== false;
    return {
      ...b,
      created_at: toHKString(b.created_at),
      closed_at: b.closed_at ? toHKString(b.closed_at) : null,
      reply_required: replyRequired,
      reply_notice: b.reply_notice ?? '',
      is_archived: Boolean(b.closed_at),
      is_open: !b.closed_at && replyRequired,
      pending: replyRequired ? b.pending : 0,
    };
  });
}

/** OM 版：只回傳涉及該 OM 店舖的週次，計數亦只計其店舖。 */
export async function listBatchesForSites(siteCodes: string[]): Promise<ZeroSalesMyBatchRow[]> {
  if (!siteCodes.length) return [];
  const r = await query<Omit<ZeroSalesMyBatchRow, 'is_open' | 'is_archived' | 'reply_required' | 'reply_notice'> & {
    reply_required: boolean | null;
    reply_notice: string | null;
  }>(
    `SELECT b.id, b.week_label, b.created_at, b.closed_at, b.reply_required, b.reply_notice,
            count(*)::int AS total,
            count(*) FILTER (WHERE i.status = 'replied')::int AS replied,
            count(*) FILTER (WHERE i.status = 'pending')::int AS pending
       FROM zero_sales_batches b
       JOIN zero_sales_items i ON i.batch_id = b.id AND i.site_code = ANY($1::text[])
      GROUP BY b.id, b.week_label, b.created_at, b.closed_at, b.reply_required, b.reply_notice
      ORDER BY b.created_at DESC LIMIT 52`,
    [siteCodes],
  );
  return r.rows.map((b) => {
    const replyRequired = b.reply_required !== false;
    return {
      ...b,
      created_at: toHKString(b.created_at),
      closed_at: b.closed_at ? toHKString(b.closed_at) : null,
      reply_required: replyRequired,
      reply_notice: b.reply_notice ?? '',
      is_archived: Boolean(b.closed_at),
      is_open: !b.closed_at && replyRequired,
      pending: replyRequired ? b.pending : 0,
    };
  });
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
): Promise<{ weekLabel: string; pending: number; alreadyClosed: boolean; replyRequired: boolean } | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<{ week_label: string; closed_at: string | null; reply_required: boolean }>(
      'SELECT week_label, closed_at, reply_required FROM zero_sales_batches WHERE id = $1',
      [batchId],
    );
    const row = cur.rows[0];
    if (!row) return null;
    if (row.closed_at) {
      const counted = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM zero_sales_items WHERE batch_id = $1 AND status = 'pending'`,
        [batchId],
      );
      return {
        weekLabel: row.week_label,
        pending: Number(counted.rows[0]?.count ?? 0),
        alreadyClosed: true,
        replyRequired: row.reply_required !== false,
      };
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
      replyRequired: row.reply_required !== false,
    };
  });
}

/** 切換「本週無須回覆」：批次照樣派發（店舖可看見 Top 10），但不需要逐條回覆。
 *  * 只影響「是否需要回覆」的判斷，不會修改任何已提交的回覆
 *  * 切回需要回覆時，未回覆的行即重新變成待回覆（店舖可繼續回覆）
 *  * 可同時更新給店舖看的說明（replyNotice）
 */
export async function setZeroSalesBatchReplyRequired(input: {
  batchId: string;
  replyRequired: boolean;
  notice?: string;
  actor: string;
}): Promise<{
  weekLabel: string;
  replyRequired: boolean;
  notice: string;
  changed: boolean;
  pending: number;
  replied: number;
} | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<{
      week_label: string;
      reply_required: boolean;
      reply_notice: string;
      closed_at: string | null;
    }>('SELECT week_label, reply_required, reply_notice, closed_at FROM zero_sales_batches WHERE id = $1', [
      input.batchId,
    ]);
    const row = cur.rows[0];
    if (!row) return null;
    const notice = (input.notice ?? row.reply_notice ?? '').trim().slice(0, 1000);
    const changed = row.reply_required !== input.replyRequired || (input.notice !== undefined && notice !== row.reply_notice);
    const updated = await client.query<{ reply_required: boolean; reply_notice: string }>(
      `UPDATE zero_sales_batches
          SET reply_required = $2, reply_notice = $3
        WHERE id = $1
    RETURNING reply_required, reply_notice`,
      [input.batchId, input.replyRequired, notice],
    );
    const counts = await client.query<{ pending: string; replied: string }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE status = 'replied')::text AS replied
         FROM zero_sales_items WHERE batch_id = $1`,
      [input.batchId],
    );
    return {
      weekLabel: row.week_label,
      replyRequired: updated.rows[0]?.reply_required ?? input.replyRequired,
      notice: updated.rows[0]?.reply_notice ?? notice,
      changed,
      pending: Number(counts.rows[0]?.pending ?? 0),
      replied: Number(counts.rows[0]?.replied ?? 0),
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
  const current = await query<{
    id: string;
    status: string;
    reply_count: number;
    reply_limit: number;
    auto_filled_at: string | null;
    closed_at: string | null;
    reply_required: boolean;
    week_label: string;
  }>(
    `SELECT i.id, i.status, i.reply_count, i.reply_limit, i.auto_filled_at,
            b.closed_at, b.reply_required, b.week_label
       FROM zero_sales_items i
       JOIN zero_sales_batches b ON b.id = i.batch_id
      WHERE i.id = $1 AND i.site_code = $2`,
    [input.itemId, input.siteCode],
  );
  const cur = current.rows[0];
  if (!cur) throw new ZeroSalesReplyError('找不到此 SKU 指派');
  if (cur.reply_required === false) {
    throw new ZeroSalesReplyNotRequiredError(`「${cur.week_label}」本週無須回覆，只顯示你店舖的 Top 10 SKU 作銷售參考。`);
  }
  if (cur.closed_at) {
    throw new ZeroSalesBatchClosedError(
      `「${cur.week_label}」已截止回覆（新一週已派發），此週次只供查閱。請到最新一週回覆。`,
    );
  }
  const limit = cur.reply_limit ?? (cur.auto_filled_at ? 3 : 2);
  if ((cur.reply_count ?? 0) >= limit) {
    const edits = Math.max(1, limit - 1);
    throw new ZeroSalesReplyError(`此 SKU 已用完修改機會（可修改 ${edits} 次），如需再更改請聯絡 RP Team`);
  }
  // UPDATE 同時檢查批次仍開放且需要回覆，避免「檢查後剛好被新批次封存／改為無須回覆」的競態
  const r = await query<ZeroSalesItemRow>(
    `UPDATE zero_sales_items i SET status = 'replied', reason_code = $1, reason_label = $2, reason_note = $3,
      replied_at = now(), replied_by = $4, replied_by_user_id = $5, updated_at = now(),
      reply_count = reply_count + 1,
      -- 店舖一經儲存（確認或修改），此行即變成店舖回覆，不再算「系統自動套用」
      auto_filled_at = NULL
     WHERE i.id = $6 AND i.site_code = $7
       AND EXISTS (SELECT 1 FROM zero_sales_batches b
                    WHERE b.id = i.batch_id AND b.closed_at IS NULL AND b.reply_required = true)
     RETURNING i.*`,
    [found.code, found.label, note, input.repliedBy, input.repliedByUserId, input.itemId, input.siteCode],
  );
  const row = r.rows[0];
  if (!row) {
    // 競態：查一下真正原因，回傳對應錯誤碼（前端才能給正確引導）
    const st = await query<{ closed_at: string | null; reply_required: boolean; week_label: string }>(
      `SELECT b.closed_at, b.reply_required, b.week_label
         FROM zero_sales_items i JOIN zero_sales_batches b ON b.id = i.batch_id
        WHERE i.id = $1`,
      [input.itemId],
    );
    const s = st.rows[0];
    if (s && s.reply_required === false) {
      throw new ZeroSalesReplyNotRequiredError(`「${s.week_label}」本週無須回覆，只顯示你店舖的 Top 10 SKU 作銷售參考。`);
    }
    throw new ZeroSalesBatchClosedError(
      `「${cur.week_label}」已截止回覆（新一週已派發），此週次只供查閱。請到最新一週回覆。`,
    );
  }
  return {
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    auto_filled_at: row.auto_filled_at ? toHKString(row.auto_filled_at as unknown as string) : null,
    auto_filled: Boolean(row.auto_filled_at),
    auto_filled_from_week: row.auto_filled_from_week ?? '',
    reply_limit: row.reply_limit ?? 2,
    is_open: true,
    batch_date: undefined,
  };
}

/** 管理員代改／代填店舖回覆：不受「只可修改一次」鎖定限制，亦不佔用店舖的修改次數。
 *  已封存週次常見「店舖截單後以 email 補交」，管理員可將 pending 行直接填成 replied。
 *  `entered` = 之前未回覆、今次由管理員代填；`false` = 修改既有回覆。 */
export async function adminReplyItem(input: {
  batchId: string;
  itemId: string;
  reasonCode: string;
  reasonNote: string;
  /** 管理員帳號，寫入 replied_by 供日後追查 */
  adminUser: string;
  /** 寫入 replied_by 的前綴；預設「管理員代填」，OM 代覆時傳「OM 代覆」 */
  actorLabel?: string;
  /** true = 只可在仍開放且需要回覆的週次操作（OM 代覆用）；預設 false（管理員可改歷史） */
  requireOpen?: boolean;
}): Promise<{
  before: { reason_code: string | null; reason_label: string | null; reason_note: string };
  item: ZeroSalesItemRow;
  entered: boolean;
}> {
  const reasons = await listReasons(false);
  const found = reasons.find((r) => r.code === input.reasonCode);
  if (!found) throw new ZeroSalesReplyError('回覆原因無效，請重新選擇');
  const note = (input.reasonNote ?? '').trim();
  if (found.require_note && !note) throw new ZeroSalesReplyError(`選擇「${found.label}」必須填寫補充說明`);
  if (note.length > 2000) throw new ZeroSalesReplyError('補充說明最多 2000 字');

  if (input.requireOpen) {
    const batch = await query<{ closed_at: string | null; reply_required: boolean; week_label: string }>(
      'SELECT closed_at, reply_required, week_label FROM zero_sales_batches WHERE id = $1',
      [input.batchId],
    );
    const row = batch.rows[0];
    if (!row) throw new ZeroSalesReplyError('找不到此週次（可能已被刪除）');
    if (row.reply_required === false) {
      throw new ZeroSalesReplyNotRequiredError(`「${row.week_label}」本週無須回覆，只供參考銷售。`);
    }
    if (row.closed_at) {
      throw new ZeroSalesBatchClosedError(
        `「${row.week_label}」已截止回覆（只供查閱），OM 不可再代覆；如需更正請聯絡 RP Team。`,
      );
    }
  }
  const openGuard = input.requireOpen
    ? `AND EXISTS (SELECT 1 FROM zero_sales_batches ob
                    WHERE ob.id = i.batch_id AND ob.closed_at IS NULL AND ob.reply_required = true)`
    : '';
  const actorLabel = input.actorLabel ?? '管理員代填';

  const current = await query<{
    status: string;
    reply_count: number;
    reason_code: string | null;
    reason_label: string | null;
    reason_note: string;
  }>(
    'SELECT status, reply_count, reason_code, reason_label, reason_note FROM zero_sales_items WHERE id = $1 AND batch_id = $2',
    [input.itemId, input.batchId],
  );
  const cur = current.rows[0];
  if (!cur) throw new ZeroSalesReplyError('找不到此 SKU 行（可能已被刪除）');
  const before = { reason_code: cur.reason_code, reason_label: cur.reason_label, reason_note: cur.reason_note };

  if (cur.status === 'pending') {
    // 代填：狀態轉 replied、記錄回覆人為代覆者、給予 1 次（店舖仍可在開放週次修改一次）
    const inserted = await query<ZeroSalesItemRow>(
      `UPDATE zero_sales_items i
          SET status = 'replied', reason_code = $1, reason_label = $2, reason_note = $3,
              replied_at = now(), replied_by = $4, replied_by_user_id = NULL,
              updated_at = now(), reply_count = GREATEST(reply_count, 1),
              auto_filled_at = NULL
        WHERE i.id = $5 AND i.batch_id = $6 AND i.status = 'pending' ${openGuard}
        RETURNING i.*`,
      [found.code, found.label, note, `${actorLabel}（${input.adminUser}）`, input.itemId, input.batchId],
    );
    const row = inserted.rows[0];
    if (!row) throw new ZeroSalesReplyError('此 SKU 狀態已改變，請重新載入後再試');
    return {
      before,
      item: {
        ...row,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
        replied_at: row.replied_at ? toHKString(row.replied_at) : null,
        auto_filled_at: row.auto_filled_at ? toHKString(row.auto_filled_at as unknown as string) : null,
        auto_filled: Boolean(row.auto_filled_at),
        auto_filled_from_week: row.auto_filled_from_week ?? '',
        reply_limit: row.reply_limit ?? 2,
        batch_date: undefined,
      },
      entered: true,
    };
  }

  if (!cur.reason_code) throw new ZeroSalesReplyError('此 SKU 沒有可編輯的回覆原因');
  const r = await query<ZeroSalesItemRow>(
    `UPDATE zero_sales_items i
        SET reason_code = $1, reason_label = $2, reason_note = $3, updated_at = now(),
            auto_filled_at = NULL
      WHERE i.id = $4 AND i.batch_id = $5 ${openGuard}
      RETURNING i.*`,
    [found.code, found.label, note, input.itemId, input.batchId],
  );
  const row = r.rows[0];
  if (!row) throw new ZeroSalesReplyError('找不到此 SKU 行（可能已被刪除）');
  return {
    before,
    item: {
      ...row,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
      replied_at: row.replied_at ? toHKString(row.replied_at) : null,
      auto_filled_at: row.auto_filled_at ? toHKString(row.auto_filled_at as unknown as string) : null,
      auto_filled: Boolean(row.auto_filled_at),
      auto_filled_from_week: row.auto_filled_from_week ?? '',
      reply_limit: row.reply_limit ?? 2,
      batch_date: undefined,
    },
    entered: false,
  };
}

export interface ZeroSalesBuyerFollowupRow extends ZeroSalesRepeatSkuRow {
  /** 重複店舖行的 Shop Stock Qty (CM) 總計（空白／非數字不計） */
  stock_total: number;
  /** 重複店舖行中已回覆原因 Top 2，格式「原因 (n)」以「；」分隔 */
  top_reasons: string;
  /** 有重複上榜的店舖清單（Site Code，字母排序，逗號分隔） */
  store_list: string;
}

export interface ZeroSalesBuyerFollowupFilter extends ZeroSalesRepeatSkuFilter {}

/** Buyer 跟進一頁：跨店重複 SKU 排行 + 庫存總計 + Top 原因 + 重複店舖清單。
 *  以 listZeroSalesRepeatSkus 取排名，再一次過查該批 SKU 的全部行在 JS 彙總
 *  （避免 SQL 解析「1,200」千分位庫存字串的方言差異，PGlite／PG 共用同一邏輯）。 */
export async function listZeroSalesBuyerFollowup(
  filter: ZeroSalesBuyerFollowupFilter = {},
): Promise<ZeroSalesBuyerFollowupRow[]> {
  const base = await listZeroSalesRepeatSkus(filter);
  if (!base.length) return [];
  const minCount = Math.min(20, Math.max(2, Math.floor(filter.minCount ?? 2) || 2));
  const skus = base.map((r) => r.sku);
  const r = await query<{
    sku: string;
    site_code: string;
    stock_text: string | null;
    reason_label: string | null;
    status: string;
  }>(
    `SELECT i.sku, i.site_code,
            i.payload->>'Shop Stock Qty (CM)' AS stock_text,
            COALESCE(i.reason_label, '') AS reason_label,
            i.status
       FROM zero_sales_items i
      WHERE i.sku = ANY($1::text[])`,
    [skus],
  );
  const parseStock = (t: string | null | undefined): number | null => {
    const s = (t ?? '').replace(/,/g, '').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const bySku = new Map<string, Array<{ site_code: string; stock: number | null; reason: string; status: string }>>();
  for (const row of r.rows) {
    const list = bySku.get(row.sku) ?? [];
    list.push({ site_code: row.site_code, stock: parseStock(row.stock_text), reason: row.reason_label || '', status: row.status });
    bySku.set(row.sku, list);
  }
  return base.map((b) => {
    const rows = bySku.get(b.sku) ?? [];
    // 同店出現次數 ≥ minCount 的才算重複店舖（與排名定義一致）
    const occ = new Map<string, number>();
    for (const x of rows) occ.set(x.site_code, (occ.get(x.site_code) ?? 0) + 1);
    const repeatSites = [...occ.entries()].filter(([, n]) => n >= minCount).map(([s]) => s).sort((x, y) => x.localeCompare(y));
    const repeatSet = new Set(repeatSites);
    const repeatRows = rows.filter((x) => repeatSet.has(x.site_code));
    let stockTotal = 0;
    let hasStock = false;
    for (const x of repeatRows) {
      if (x.stock !== null) { stockTotal += x.stock; hasStock = true; }
    }
    const reasonCounts = new Map<string, number>();
    for (const x of repeatRows) {
      if (x.status === 'replied') {
        const label = x.reason || '（未分類）';
        reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
      }
    }
    const topReasons = [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([label, n]) => `${label} (${n})`)
      .join('；');
    return {
      ...b,
      stock_total: hasStock ? stockTotal : 0,
      top_reasons: topReasons,
      store_list: repeatSites.join(', '),
    };
  });
}
