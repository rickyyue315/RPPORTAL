import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import { toHKString } from '../lib/time.js';
import {
  parseShopStockWorkbook,
  type ShopStockParsed,
  type ShopStockParseSkipped,
} from '../lib/shopStockXlsx.js';

/**
 * 每週店舖不良存貨 Dashboard 的 service 層。
 *
 * 身份鍵 = `report_date`（DATE UNIQUE）。`report_kind` 只作顯示，不影響唯一性。
 * 同一日期重複上載 = 取代整批（DELETE 舊 snapshots 再 insert，保留同一 batch id）。
 *
 * 口徑：
 *   每店佔比 = excess_value_0sale / shop_stock_value_cm
 *   全公司佔比 = Σexcess ÷ ΣSOH（加權），**不可**用各店比率取平均（會放大細店權重）
 *   分母 NULL 或 <= 0 → 比率回 null（不寫 0，避免前端畫出一條假的 0% 線）
 *
 *   不良存貨 SKU 佔店內貨品比率 = sku_count_0sale / sku_carry_count（同一套加權規則）。
 *   分母 `No. of SKU Carry` = RF SKU + ND with Stock（真實報表 93 店逐店核實），即店內
 *   有貨嘅全部 SKU。分子（No. of Overstock SKU (P90D 0 Sales)，含 ND 貨）必為分母子集，
 *   **比率結構上不超過 100%**；店舖將 RF 轉 ND 而貨未清走時比率不變，只有實際賣出／
 *   轉走先會改善——唔會懲罰正確行為（分母若用 RF SKU 會爆升，2026-10-25 已棄用）。
 */

export const SHOP_STOCK_REPORT_KINDS = ['weekly', 'month_end', 'ad_hoc'] as const;
export type ShopStockReportKind = (typeof SHOP_STOCK_REPORT_KINDS)[number];

/**
 * `report_kind` 只接受 migration 026 CHECK 的三個值（weekly / month_end / ad_hoc）。
 * 契約固定，不接受別名或中文；非法值一律回落 'weekly'。
 */
export function normalizeReportKind(value: string | null | undefined): ShopStockReportKind {
  const key = String(value ?? '').trim();
  return (SHOP_STOCK_REPORT_KINDS as readonly string[]).includes(key)
    ? (key as ShopStockReportKind)
    : 'weekly';
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class ShopStockImportError extends Error {
  constructor(
    message: string,
    readonly parsed: ShopStockParsed,
  ) {
    super(message);
    this.name = 'ShopStockImportError';
  }
}

export class ShopStockDateConflictError extends Error {
  constructor(readonly reportDate: string) {
    super(`報表日期 ${reportDate} 已有批次，請改用該日期直接取代或先刪除舊批次`);
    this.name = 'ShopStockDateConflictError';
  }
}

/** NUMERIC / BIGINT 由 pg 回 string；集中在此轉 number（route 不再逐個 Number()） */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * I14 的 SKU 數由原始 payload 讀取；歷史批次不用 backfill。
 * 千分位字串（例如 "1,234"）可接受；空白、負數、小數及非法文本回 null，絕不當成 0。
 */
function toSkuCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? String(value) : String(value).trim().replace(/,/g, '');
  if (!text) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** 分母 NULL / <= 0 一律回 null */
function ratioOf(numerator: unknown, denominator: unknown): number | null {
  const n = toNumber(numerator);
  const d = toNumber(denominator);
  if (n === null || d === null || !(d > 0)) return null;
  return n / d;
}

/** 百分點差（ratio 為小數，回傳已是 pt 單位） */
function deltaPt(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return (current - previous) * 100;
}

/** 顯示用標籤：2026-10-25 → 25Oct2026（不參與唯一性） */
export function deriveWeekLabel(reportDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(reportDate);
  if (!m) return reportDate;
  const [, y, mo, d] = m;
  const monthIndex = Number(mo) - 1;
  const label = MONTH_ABBR[monthIndex] ?? mo;
  return `${Number(d)}${label}${y}`;
}

/** 把 DATE（pg 可能回 Date 或 string）統一成 YYYY-MM-DD */
function toDateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? '').slice(0, 10);
}

export interface ShopStockBatchRow {
  id: string;
  report_date: string;
  report_kind: string;
  week_label: string;
  note: string;
  source_rows: number;
  row_count: number;
  store_count: number;
  skipped_rows: number;
  warn_count: number;
  content_hash: string;
  /** 前端表格顯示用的短 hash（前 8 位） */
  content_hash_short: string;
  uploaded_by: string;
  created_at: string | null;
  updated_at: string | null;
}

interface RawBatchRow extends Omit<ShopStockBatchRow, 'report_date' | 'created_at' | 'updated_at'> {
  report_date: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const BATCH_COLUMNS = `id, report_date::text AS report_date, report_kind, week_label, note,
  source_rows, row_count, store_count, skipped_rows, warn_count, content_hash, uploaded_by,
  created_at, updated_at`;

function mapBatchRow(row: RawBatchRow): ShopStockBatchRow {
  return {
    ...row,
    report_date: toDateOnly(row.report_date),
    content_hash_short: (row.content_hash ?? '').slice(0, 8),
    created_at: row.created_at ? toHKString(row.created_at as Date | string) : null,
    updated_at: row.updated_at ? toHKString(row.updated_at as Date | string) : null,
  };
}

/** 明細行：NUMERIC 全部轉 number，比率一併算好 */
export interface ShopStockSnapshotRow {
  site_code: string;
  shop: string;
  om: string;
  shop_nature: string;
  shop_type: string;
  source_row: number | null;
  sku_count_0sale: number | null;
  excess_qty_0sale: number | null;
  excess_value_0sale: number | null;
  sku_count_over2: number | null;
  excess_qty_over2: number | null;
  excess_value_over2: number | null;
  excess_value_total: number | null;
  shop_stock_qty_cm: number | null;
  shop_stock_value_cm: number | null;
  sold_qty_p90d: number | null;
  net_sales_p90d: number | null;
  /** I14「No. of RF SKU」：自動補貨 SKU 數（不是存貨件數） */
  rf_sku_count: number | null;
  /** I14「No. of SKU Carry」：店內貨品 SKU 總數（= RF SKU + ND with Stock，已核實） */
  sku_carry_count: number | null;
  /** 不良存貨 SKU 佔店內貨品比率 = sku_count_0sale ÷ sku_carry_count（小數）；分子缺值或 Carry 缺值/0 → null */
  ovs_carry_ratio: number | null;
  ratio: number | null;
  ratio_over2: number | null;
  ratio_total: number | null;
}

interface RawSnapshotRow {
  site_code: string;
  shop: string | null;
  om: string | null;
  shop_nature: string | null;
  shop_type: string | null;
  source_row: number | null;
  sku_count_0sale: number | null;
  excess_qty_0sale: unknown;
  excess_value_0sale: unknown;
  sku_count_over2: number | null;
  excess_qty_over2: unknown;
  excess_value_over2: unknown;
  excess_value_total: unknown;
  shop_stock_qty_cm: unknown;
  shop_stock_value_cm: unknown;
  sold_qty_p90d: unknown;
  net_sales_p90d: unknown;
  rf_sku_count_text: unknown;
  sku_carry_count_text: unknown;
}

/** 全表共用的 snapshot 行轉換（pg 的 NUMERIC 是 string） */
export function mapSnapshotRow(row: RawSnapshotRow): ShopStockSnapshotRow {
  const rfSkuCount = toSkuCount(row.rf_sku_count_text);
  const skuCarryCount = toSkuCount(row.sku_carry_count_text);
  return {
    site_code: row.site_code,
    shop: row.shop ?? '',
    om: row.om ?? '',
    shop_nature: row.shop_nature ?? '',
    shop_type: row.shop_type ?? '',
    source_row: toNumber(row.source_row),
    sku_count_0sale: toNumber(row.sku_count_0sale),
    excess_qty_0sale: toNumber(row.excess_qty_0sale),
    excess_value_0sale: toNumber(row.excess_value_0sale),
    sku_count_over2: toNumber(row.sku_count_over2),
    excess_qty_over2: toNumber(row.excess_qty_over2),
    excess_value_over2: toNumber(row.excess_value_over2),
    excess_value_total: toNumber(row.excess_value_total),
    shop_stock_qty_cm: toNumber(row.shop_stock_qty_cm),
    shop_stock_value_cm: toNumber(row.shop_stock_value_cm),
    sold_qty_p90d: toNumber(row.sold_qty_p90d),
    net_sales_p90d: toNumber(row.net_sales_p90d),
    rf_sku_count: rfSkuCount,
    sku_carry_count: skuCarryCount,
    ovs_carry_ratio: ratioOf(row.sku_count_0sale, skuCarryCount),
    ratio: ratioOf(row.excess_value_0sale, row.shop_stock_value_cm),
    ratio_over2: ratioOf(row.excess_value_over2, row.shop_stock_value_cm),
    ratio_total: ratioOf(row.excess_value_total, row.shop_stock_value_cm),
  };
}

const SNAPSHOT_SELECT = `SELECT s.site_code, s.shop, s.om, s.shop_nature, s.shop_type, s.source_row,
  s.sku_count_0sale, s.excess_qty_0sale, s.excess_value_0sale,
  s.sku_count_over2, s.excess_qty_over2, s.excess_value_over2, s.excess_value_total,
  s.shop_stock_qty_cm, s.shop_stock_value_cm, s.sold_qty_p90d, s.net_sales_p90d,
  s.payload->>'No. of RF SKU' AS rf_sku_count_text,
  s.payload->>'No. of SKU Carry' AS sku_carry_count_text`;

// ---------------------------------------------------------------------------
// 上載 / 取代
// ---------------------------------------------------------------------------

export interface ShopStockUploadInput {
  buffer: Buffer;
  /** YYYY-MM-DD */
  reportDate: string;
  reportKind: string;
  note?: string;
  uploadedBy: string;
  maxRows: number;
}

export interface ShopStockReplacedBatch {
  id: string;
  reportDate: string;
  rowCount: number;
  contentHash: string;
}

export interface ShopStockUploadResult {
  batch: ShopStockBatchRow;
  /** true = 同日已有批次，本次為整批取代（舊批次已刪，新批次有新 id） */
  replaced: boolean;
  /** 被取代的舊批次摘要（給 audit 留痕；非取代時為 null） */
  replacedBatch: ShopStockReplacedBatch | null;
  /** true = 內容與現有批次完全相同（content_hash 一致），沒有寫入 */
  noop: boolean;
  skipped: ShopStockParseSkipped;
  warnings: string[];
  /** 對不到 stores 主檔的店號（warning，不阻塞） */
  unknownSites: string[];
  contentHash: string;
}

const SNAPSHOT_INSERT_COLUMNS = [
  'batch_id',
  'site_code',
  'shop',
  'om',
  'shop_nature',
  'shop_type',
  'source_row',
  'sku_count_0sale',
  'excess_qty_0sale',
  'excess_value_0sale',
  'sku_count_over2',
  'excess_qty_over2',
  'excess_value_over2',
  'excess_value_total',
  'shop_stock_qty_cm',
  'shop_stock_value_cm',
  'sold_qty_p90d',
  'net_sales_p90d',
  'payload',
] as const;

/** 每批 chunk 的列數（19 欄 × 50 行 = 950 個參數，遠低於 pg 上限） */
const INSERT_CHUNK = 50;

export async function upsertShopStockBatch(input: ShopStockUploadInput): Promise<ShopStockUploadResult> {
  const parsed = await parseShopStockWorkbook(input.buffer, input.maxRows);
  if (!parsed.ok || !parsed.rows) {
    throw new ShopStockImportError('匯入失敗', parsed);
  }
  const rows = parsed.rows;

  // 未知店號只作 warning：新店未入主檔不應令整批上載失敗
  const siteCodes = [...new Set(rows.map((r) => r.siteCode))];
  const known = await query<{ site_code: string }>(
    'SELECT site_code FROM stores WHERE site_code = ANY($1::text[])',
    [siteCodes],
  );
  const knownSet = new Set(known.rows.map((r) => r.site_code));
  const unknownSites = siteCodes.filter((code) => !knownSet.has(code)).sort();

  const reportKind = normalizeReportKind(input.reportKind);
  const weekLabel = deriveWeekLabel(input.reportDate);
  const skippedRows = parsed.skipped.total + parsed.skipped.blank + parsed.skipped.footer;

  return withTransaction(async (client) => {
    const existing = await client.query<RawBatchRow>(
      `SELECT ${BATCH_COLUMNS} FROM shop_stock_batches WHERE report_date = $1::date FOR UPDATE`,
      [input.reportDate],
    );
    const current = existing.rows[0];

    // content_hash 相同 = 同一份檔案重上，不做任何寫入（回傳既有批次）
    if (current && current.content_hash && current.content_hash === parsed.contentHash) {
      return {
        batch: mapBatchRow(current),
        replaced: false,
        replacedBatch: null,
        noop: true,
        skipped: parsed.skipped,
        warnings: parsed.warnings,
        unknownSites,
        contentHash: parsed.contentHash,
      } satisfies ShopStockUploadResult;
    }

    // 同日重上 = 整批取代：先刪舊批次（FK CASCADE 自動清走明細），再建新批次。
    // 刻意不用「UPDATE 父行 + DELETE 明細」：那會令同一 batch id 先後代表兩份
    // 不同檔案，audit 亦無從分辨。舊 id / 行數 / hash 會回傳，由 route 寫入 audit。
    let replacedBatch: ShopStockReplacedBatch | null = null;
    if (current) {
      replacedBatch = {
        id: current.id,
        reportDate: toDateOnly(current.report_date),
        rowCount: toNumber(current.row_count) ?? 0,
        contentHash: current.content_hash ?? '',
      };
      await client.query('DELETE FROM shop_stock_batches WHERE id = $1', [current.id]);
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO shop_stock_batches
         (report_date, report_kind, week_label, note, source_rows, row_count, store_count,
          skipped_rows, warn_count, content_hash, uploaded_by)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.reportDate,
        reportKind,
        weekLabel,
        input.note ?? '',
        parsed.sourceRows,
        rows.length,
        siteCodes.length,
        skippedRows,
        parsed.warnings.length,
        parsed.contentHash,
        input.uploadedBy,
      ],
    );
    const batchId = inserted.rows[0]!.id;

    for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
      const chunk = rows.slice(start, start + INSERT_CHUNK);
      const values: unknown[] = [];
      const placeholders = chunk.map((row, rowIndex) => {
        const base = rowIndex * SNAPSHOT_INSERT_COLUMNS.length;
        values.push(
          batchId,
          row.siteCode,
          row.shop,
          row.om,
          row.shopNature,
          row.shopType,
          row.sourceRow,
          row.skuCount0sale,
          row.excessQty0sale,
          row.excessValue0sale,
          row.skuCountOver2,
          row.excessQtyOver2,
          row.excessValueOver2,
          row.excessValueTotal,
          row.shopStockQtyCm,
          row.shopStockValueCm,
          row.soldQtyP90d,
          row.netSalesP90d,
          JSON.stringify(row.payload),
        );
        const params = SNAPSHOT_INSERT_COLUMNS.map((_, i) => `$${base + i + 1}`);
        return `(${params.join(', ')})`;
      });
      await client.query(
        `INSERT INTO shop_stock_snapshots (${SNAPSHOT_INSERT_COLUMNS.join(', ')})
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    }

    const saved = await client.query<RawBatchRow>(
      `SELECT ${BATCH_COLUMNS} FROM shop_stock_batches WHERE id = $1`,
      [batchId],
    );
    return {
      batch: mapBatchRow(saved.rows[0]!),
      replaced: Boolean(current),
      replacedBatch,
      noop: false,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
      unknownSites,
      contentHash: parsed.contentHash,
    } satisfies ShopStockUploadResult;
  });
}

// ---------------------------------------------------------------------------
// 批次管理
// ---------------------------------------------------------------------------

export interface ShopStockBatchPage {
  batches: ShopStockBatchRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listShopStockBatches(
  opts: { page?: number; pageSize?: number } = {},
): Promise<ShopStockBatchPage> {
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(opts.pageSize ?? 20) || 20));
  const offset = (page - 1) * pageSize;
  const [count, rows] = await Promise.all([
    query<{ count: string }>('SELECT count(*)::text AS count FROM shop_stock_batches'),
    query<RawBatchRow>(
      `SELECT ${BATCH_COLUMNS} FROM shop_stock_batches
        ORDER BY report_date DESC, id DESC LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
  ]);
  return {
    batches: rows.rows.map(mapBatchRow),
    total: Number(count.rows[0]?.count ?? 0),
    page,
    pageSize,
  };
}

export async function getShopStockBatch(id: string): Promise<ShopStockBatchRow | null> {
  const r = await query<RawBatchRow>(`SELECT ${BATCH_COLUMNS} FROM shop_stock_batches WHERE id = $1`, [id]);
  return r.rows[0] ? mapBatchRow(r.rows[0]) : null;
}

export async function updateShopStockBatch(
  id: string,
  patch: { reportDate?: string; note?: string },
): Promise<ShopStockBatchRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.reportDate !== undefined) {
    params.push(patch.reportDate);
    sets.push(`report_date = $${params.length}::date`);
    params.push(deriveWeekLabel(patch.reportDate));
    sets.push(`week_label = $${params.length}`);
  }
  if (patch.note !== undefined) {
    params.push(patch.note);
    sets.push(`note = $${params.length}`);
  }
  if (!sets.length) return getShopStockBatch(id);
  sets.push('updated_at = now()');
  try {
    const r = await query<RawBatchRow>(
      `UPDATE shop_stock_batches SET ${sets.join(', ')} WHERE id = $1 RETURNING ${BATCH_COLUMNS}`,
      params,
    );
    return r.rows[0] ? mapBatchRow(r.rows[0]) : null;
  } catch (err) {
    // 23505 = unique_violation（report_date 已被另一批佔用）。
    // PGlite 不一定帶 code，所以再檢查訊息文字。
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === '23505' || /duplicate key|unique constraint/i.test(message)) {
      throw new ShopStockDateConflictError(patch.reportDate ?? '');
    }
    throw err;
  }
}

export interface ShopStockDeleteResult {
  reportDate: string;
  weekLabel: string;
  contentHash: string;
  deletedRows: number;
  deletedStores: number;
}

/**
 * 刪除整批。snapshots 由 FK CASCADE 一併刪除，但刪除前要先數清楚行數／店數，
 * 因為 audit 是刪除後唯一可回溯的痕跡。
 */
export async function deleteShopStockBatch(id: string): Promise<ShopStockDeleteResult | null> {
  return withTransaction(async (client: PoolClient) => {
    const batch = await client.query<RawBatchRow>(
      `SELECT ${BATCH_COLUMNS} FROM shop_stock_batches WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = batch.rows[0];
    if (!row) return null;
    const counts = await client.query<{ rows: number; stores: number }>(
      `SELECT count(*)::int AS rows, count(DISTINCT site_code)::int AS stores
         FROM shop_stock_snapshots WHERE batch_id = $1`,
      [id],
    );
    await client.query('DELETE FROM shop_stock_batches WHERE id = $1', [id]);
    const mapped = mapBatchRow(row);
    return {
      reportDate: mapped.report_date,
      weekLabel: mapped.week_label,
      contentHash: mapped.content_hash,
      deletedRows: toNumber(counts.rows[0]?.rows) ?? 0,
      deletedStores: toNumber(counts.rows[0]?.stores) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 全公司趨勢 / KPI（加權比率）
// ---------------------------------------------------------------------------

export interface ShopStockSeriesPoint {
  report_date: string;
  report_kind: string;
  store_count: number;
  /** 納入比率計算的店數（SOH > 0） */
  ratio_store_count: number;
  excluded_store_count: number;
  total_excess: number | null;
  total_excess_over2: number | null;
  total_excess_total: number | null;
  total_soh: number | null;
  sku_count_0sale: number | null;
  /** 各自動補貨 SKU 數合計；全部店缺值時為 null */
  total_rf_sku: number | null;
  /** 實際提供有效 RF SKU 數的店數（用來揭示合計覆蓋範圍） */
  rf_store_count: number;
  /** 全公司 RF SKU 合計與上一期的絕對增減 */
  rf_sku_delta: number | null;
  /** 各店 No. of SKU Carry 合計；全部店缺值時為 null */
  total_sku_carry: number | null;
  /** 加權「不良存貨 SKU 佔店內貨品比率」= Σ sku_count_0sale ÷ Σ SKU Carry（小數）；Carry 合計 0/NULL → null */
  ovs_carry_ratio: number | null;
  /** 加權佔比（0–1 小數）；分母 0/NULL → null */
  ratio: number | null;
  ratio_over2: number | null;
  ratio_total: number | null;
  /** 對上一期的百分點差 */
  wow_delta_pt: number | null;
}

export interface ShopStockKpi {
  report_date: string;
  report_kind: string;
  store_count: number;
  total_excess: number | null;
  total_excess_over2: number | null;
  total_excess_total: number | null;
  total_soh: number | null;
  sku_count_0sale: number | null;
  total_rf_sku: number | null;
  rf_store_count: number;
  rf_sku_delta: number | null;
  total_sku_carry: number | null;
  ovs_carry_ratio: number | null;
  ovs_carry_ratio_wow_delta_pt: number | null;
  ratio: number | null;
  ratio_over2: number | null;
  ratio_total: number | null;
  prev_report_date: string | null;
  wow_delta_pt: number | null;
  wow_delta_pt_over2: number | null;
  wow_delta_pt_total: number | null;
}

export interface ShopStockSummary {
  series: ShopStockSeriesPoint[];
  kpi: ShopStockKpi | null;
  /** 最新一期的全公司加權比率（小數） */
  company_avg_ratio: number | null;
}

interface RawCompanyAgg {
  report_date: string;
  report_kind: string;
  store_count: number;
  ratio_store_count: number;
  excess_0sale: unknown;
  excess_over2: unknown;
  excess_total: unknown;
  soh: unknown;
  sku_count_0sale: unknown;
}

interface RawSkuCountRow {
  report_date: string;
  rf_sku_count_text: unknown;
  sku_carry_count_text: unknown;
}

/** 把一組（可含 null 的）SKU 數合計：全部缺值 → total null，絕不當 0 */
function sumSkuCount(values: Array<number | null>): { total: number | null; storeCount: number } {
  let total = 0;
  let storeCount = 0;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    storeCount += 1;
  }
  return { total: storeCount > 0 ? total : null, storeCount };
}

async function loadCompanySeries(from?: string, to?: string): Promise<ShopStockSeriesPoint[]> {
  const params = [from ?? null, to ?? null];
  const dateFilter = `($1::date IS NULL OR b.report_date >= $1::date)
        AND ($2::date IS NULL OR b.report_date <= $2::date)`;
  // RF / SKU Carry 原始值可能是數字或含千分位的文字。先在 TS 安全解析再合計，
  // 避免對缺欄／非法文字做 SQL numeric cast 而令整個 summary API 失敗。
  const [r, skuRows] = await Promise.all([
    query<RawCompanyAgg>(
      `SELECT b.report_date::text AS report_date,
              b.report_kind,
              count(*)::int AS store_count,
              count(*) FILTER (WHERE s.shop_stock_value_cm > 0)::int AS ratio_store_count,
              sum(COALESCE(s.excess_value_0sale, 0)) FILTER (WHERE s.shop_stock_value_cm > 0) AS excess_0sale,
              sum(COALESCE(s.excess_value_over2, 0)) FILTER (WHERE s.shop_stock_value_cm > 0) AS excess_over2,
              sum(COALESCE(s.excess_value_total, 0)) FILTER (WHERE s.shop_stock_value_cm > 0) AS excess_total,
              sum(COALESCE(s.shop_stock_value_cm, 0)) FILTER (WHERE s.shop_stock_value_cm > 0) AS soh,
              sum(COALESCE(s.sku_count_0sale, 0))::bigint AS sku_count_0sale
         FROM shop_stock_batches b
         JOIN shop_stock_snapshots s ON s.batch_id = b.id
        WHERE ${dateFilter}
        GROUP BY b.report_date, b.report_kind
        ORDER BY b.report_date`,
      params,
    ),
    query<RawSkuCountRow>(
      `SELECT b.report_date::text AS report_date,
              s.payload->>'No. of RF SKU' AS rf_sku_count_text,
              s.payload->>'No. of SKU Carry' AS sku_carry_count_text
         FROM shop_stock_batches b
         JOIN shop_stock_snapshots s ON s.batch_id = b.id
        WHERE ${dateFilter}
        ORDER BY b.report_date, s.site_code`,
      params,
    ),
  ]);

  const skuByDate = new Map<string, Array<{ rf: number | null; carry: number | null }>>();
  for (const row of skuRows.rows) {
    const date = toDateOnly(row.report_date);
    const list = skuByDate.get(date) ?? [];
    list.push({
      rf: toSkuCount(row.rf_sku_count_text),
      carry: toSkuCount(row.sku_carry_count_text),
    });
    skuByDate.set(date, list);
  }

  const points: ShopStockSeriesPoint[] = r.rows.map((row) => {
    const soh = toNumber(row.soh);
    const excess = toNumber(row.excess_0sale);
    const reportDate = toDateOnly(row.report_date);
    const dayRows = skuByDate.get(reportDate) ?? [];
    const rf = sumSkuCount(dayRows.map((x) => x.rf));
    const carry = sumSkuCount(dayRows.map((x) => x.carry));
    return {
      report_date: reportDate,
      report_kind: row.report_kind,
      store_count: toNumber(row.store_count) ?? 0,
      ratio_store_count: toNumber(row.ratio_store_count) ?? 0,
      excluded_store_count: (toNumber(row.store_count) ?? 0) - (toNumber(row.ratio_store_count) ?? 0),
      total_excess: excess,
      total_excess_over2: toNumber(row.excess_over2),
      total_excess_total: toNumber(row.excess_total),
      total_soh: soh,
      sku_count_0sale: toNumber(row.sku_count_0sale),
      total_rf_sku: rf.total,
      rf_store_count: rf.storeCount,
      rf_sku_delta: null,
      total_sku_carry: carry.total,
      ovs_carry_ratio: ratioOf(row.sku_count_0sale, carry.total),
      ratio: ratioOf(excess, soh),
      ratio_over2: ratioOf(row.excess_over2, soh),
      ratio_total: ratioOf(row.excess_total, soh),
      wow_delta_pt: null,
    };
  });

  // WoW = 對上一個 report_date 的百分點差（不是上一筆插入時間）
  for (let i = 1; i < points.length; i += 1) {
    const current = points[i]!;
    const previous = points[i - 1]!;
    current.wow_delta_pt = deltaPt(current.ratio, previous.ratio);
    current.rf_sku_delta = current.total_rf_sku !== null && previous.total_rf_sku !== null
      ? current.total_rf_sku - previous.total_rf_sku
      : null;
  }
  return points;
}

export async function getShopStockSummary(
  opts: { from?: string; to?: string } = {},
): Promise<ShopStockSummary> {
  const series = await loadCompanySeries(opts.from, opts.to);
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  if (!latest) return { series, kpi: null, company_avg_ratio: null };
  const kpi: ShopStockKpi = {
    report_date: latest.report_date,
    report_kind: latest.report_kind,
    store_count: latest.store_count,
    total_excess: latest.total_excess,
    total_excess_over2: latest.total_excess_over2,
    total_excess_total: latest.total_excess_total,
    total_soh: latest.total_soh,
    sku_count_0sale: latest.sku_count_0sale,
    total_rf_sku: latest.total_rf_sku,
    rf_store_count: latest.rf_store_count,
    rf_sku_delta: latest.rf_sku_delta,
    total_sku_carry: latest.total_sku_carry,
    ovs_carry_ratio: latest.ovs_carry_ratio,
    ovs_carry_ratio_wow_delta_pt: deltaPt(latest.ovs_carry_ratio, previous?.ovs_carry_ratio ?? null),
    ratio: latest.ratio,
    ratio_over2: latest.ratio_over2,
    ratio_total: latest.ratio_total,
    prev_report_date: previous?.report_date ?? null,
    wow_delta_pt: deltaPt(latest.ratio, previous?.ratio ?? null),
    wow_delta_pt_over2: deltaPt(latest.ratio_over2, previous?.ratio_over2 ?? null),
    wow_delta_pt_total: deltaPt(latest.ratio_total, previous?.ratio_total ?? null),
  };
  return { series, kpi, company_avg_ratio: latest.ratio };
}

// ---------------------------------------------------------------------------
// 單期每店明細
// ---------------------------------------------------------------------------

export interface ShopStockWeekRow extends ShopStockSnapshotRow {
  rank: number | null;
  prev_ratio: number | null;
  prev_rf_sku_count: number | null;
  /** 本店 RF SKU 數與上一期的絕對增減 */
  rf_sku_delta: number | null;
  /** 與上一期的百分點差 */
  delta_pt: number | null;
  /**
   * 不參與排名。來源有兩個：
   *   1. 報表 `Shop Type` 標示 NEW STORE（權威，只有一期資料時仍有效）
   *   2. 上一期已有批次、但這間店不在其中（上期未列入）
   * 首期存貨通常偏高，排上去會令榜首失去比較意義，但仍計入全公司合計與趨勢。
   */
  is_new: boolean;
  /** 報表 Shop Type 是否標示新店（只在新店觀察期內生效） */
  is_new_store: boolean;
  /** 不參與排名的原因；可參與排名時為 null */
  new_reason: 'new_store' | 'no_prev_data' | null;
  /** 系統第一次見到這間店的報表日期（= 該店最早一期快照）；用來計算新店觀察期 */
  first_seen: string | null;
  // --- 前端（admin-stock.js）沿用的欄名別名，內容與上表相同 ---
  deadstock_value: number | null;
  shop_stock_value: number | null;
  wow_delta_pt: number | null;
}

export interface ShopStockWeekTotals {
  store_count: number;
  ratio: number | null;
  total_excess: number | null;
  total_soh: number | null;
  total_rf_sku: number | null;
  rf_store_count: number;
  rf_sku_delta: number | null;
  total_sku_carry: number | null;
  /** 該期加權「不良存貨 SKU 佔店內貨品比率」（小數） */
  ovs_carry_ratio: number | null;
}

export interface ShopStockWeek {
  report_date: string;
  report_kind: string;
  prev_report_date: string | null;
  store_count: number;
  company_ratio: number | null;
  /** 新店觀察期（日），前端顯示文案用 */
  new_store_grace_days: number;
  /** 該期加權合計（前端表頭顯示「N 店 · 合計佔比 X%」） */
  totals: ShopStockWeekTotals;
  rows: ShopStockWeekRow[];
}

/** 取某一期之前的最近一期（排序一律用 report_date，不可用 created_at） */
async function previousReportDate(reportDate: string): Promise<string | null> {
  const r = await query<{ report_date: string }>(
    `SELECT report_date::text AS report_date FROM shop_stock_batches
      WHERE report_date < $1::date ORDER BY report_date DESC LIMIT 1`,
    [reportDate],
  );
  return r.rows[0] ? toDateOnly(r.rows[0].report_date) : null;
}

async function loadWeekSnapshots(reportDate: string): Promise<ShopStockSnapshotRow[]> {
  const r = await query<RawSnapshotRow>(
    `${SNAPSHOT_SELECT}
       FROM shop_stock_snapshots s
       JOIN shop_stock_batches b ON b.id = s.batch_id
      WHERE b.report_date = $1::date
      ORDER BY s.site_code`,
    [reportDate],
  );
  return r.rows.map(mapSnapshotRow);
}

/** 報表 `Shop Type` 標示新店（例：`NEW STORE`、`新店`）→ 只在新店觀察期內生效 */
export function isNewStoreType(value: unknown): boolean {
  const t = String(value ?? '').trim().toUpperCase();
  if (!t) return false;
  if (t === 'NEW' || t === 'NEW STORE' || t === 'NEW_SHOP' || t === 'NEWSHOP') return true;
  return t.includes('NEW STORE') || t.includes('新店');
}

/**
 * 新店觀察期（日）。
 * 報表的 `Shop Type = NEW STORE` 由上游人工維護，開業後往往長期不更新，所以旗標只在
 * 「系統第一次見到這間店」之後的這段時間內有效；超過就由系統自己的歷史資料決定。
 * 要調整觀察期，改這裡即可。
 */
export const NEW_STORE_GRACE_DAYS = 90;

/** 兩個 YYYY-MM-DD 之間的日數（純 UTC 計算，不受時區影響） */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** 每間店在系統內最早出現的報表日期（只用已入庫的存貨快照） */
async function loadFirstSeen(reportDate: string): Promise<Map<string, string>> {
  const r = await query<{ site_code: string; first_seen: string }>(
    `SELECT s.site_code, MIN(b.report_date)::text AS first_seen
       FROM shop_stock_snapshots s
       JOIN shop_stock_batches b ON b.id = s.batch_id
      WHERE b.report_date <= $1::date
      GROUP BY s.site_code`,
    [reportDate],
  );
  return new Map(r.rows.map((row) => [row.site_code, toDateOnly(row.first_seen)]));
}

export async function getShopStockWeek(reportDate: string): Promise<ShopStockWeek | null> {
  const batch = await query<{ report_date: string; report_kind: string }>(
    `SELECT report_date::text AS report_date, report_kind FROM shop_stock_batches
      WHERE report_date = $1::date`,
    [reportDate],
  );
  const batchRow = batch.rows[0];
  if (!batchRow) return null;

  const prevDate = await previousReportDate(reportDate);
  const [snapshots, prevSnapshots, firstSeenBySite] = await Promise.all([
    loadWeekSnapshots(reportDate),
    prevDate ? loadWeekSnapshots(prevDate) : Promise.resolve<ShopStockSnapshotRow[]>([]),
    loadFirstSeen(reportDate),
  ]);
  const prevBySite = new Map(prevSnapshots.map((row) => [row.site_code, row]));
  const thisDate = toDateOnly(batchRow.report_date);

  const rows: ShopStockWeekRow[] = snapshots
    .map((row) => {
      const prev = prevBySite.get(row.site_code);
      const delta = deltaPt(row.ratio, prev?.ratio ?? null);
      const prevRf = prev?.rf_sku_count ?? null;
      const rfDelta = row.rf_sku_count !== null && prevRf !== null
        ? row.rf_sku_count - prevRf
        : null;
      const firstSeen = firstSeenBySite.get(row.site_code) ?? null;
      // ① 系統自己的資料：上期有批次，但這間店不在其中 → 新店／上期漏抽
      const missingPrev = prevDate !== null && !prevBySite.has(row.site_code);
      // ② 報表旗標，但只在觀察期內有效（避免上游忘記改 NEW STORE 而永遠被排除）
      const flagged = isNewStoreType(row.shop_type);
      const ageDays = firstSeen ? daysBetween(firstSeen, thisDate) : null;
      const withinGrace = ageDays === null || ageDays < NEW_STORE_GRACE_DAYS;
      const newStore = flagged && withinGrace;
      const reason: ShopStockWeekRow['new_reason'] = newStore
        ? 'new_store'
        : missingPrev
          ? 'no_prev_data'
          : null;
      return {
        ...row,
        rank: null,
        prev_ratio: prev?.ratio ?? null,
        prev_rf_sku_count: prevRf,
        rf_sku_delta: rfDelta,
        delta_pt: delta,
        is_new: reason !== null,
        is_new_store: flagged,
        new_reason: reason,
        first_seen: firstSeen,
        deadstock_value: row.excess_value_0sale,
        shop_stock_value: row.shop_stock_value_cm,
        wow_delta_pt: delta,
      };
    })
    // 排名：比率高（不良貨品多）排前；新店排可比較店舖之後，不佔名次
    .sort((a, b) => {
      if (a.is_new !== b.is_new) return a.is_new ? 1 : -1;
      if (a.ratio === null && b.ratio === null) return a.site_code.localeCompare(b.site_code);
      if (a.ratio === null) return 1;
      if (b.ratio === null) return -1;
      if (b.ratio !== a.ratio) return b.ratio - a.ratio;
      return a.site_code.localeCompare(b.site_code);
    });

  let rankCounter = 0;
  for (const row of rows) {
    if (!row.is_new && row.ratio !== null) {
      rankCounter += 1;
      row.rank = rankCounter;
    }
  }

  const ratioRows = snapshots.filter((row) => row.ratio !== null);
  const totalExcess = ratioRows.reduce((sum, row) => sum + (row.excess_value_0sale ?? 0), 0);
  const totalSoh = ratioRows.reduce((sum, row) => sum + (row.shop_stock_value_cm ?? 0), 0);
  const companyRatio = ratioOf(totalExcess, totalSoh);
  const rf = sumSkuCount(snapshots.map((row) => row.rf_sku_count));
  const previousRf = sumSkuCount(prevSnapshots.map((row) => row.rf_sku_count));
  const carry = sumSkuCount(snapshots.map((row) => row.sku_carry_count));
  // 分子與 loadCompanySeries 同一口徑：Σ sku_count_0sale（缺值當 0）÷ Σ 有效 SKU Carry
  const sku0Total = snapshots.reduce((sum, row) => sum + (row.sku_count_0sale ?? 0), 0);

  return {
    report_date: toDateOnly(batchRow.report_date),
    report_kind: batchRow.report_kind,
    prev_report_date: prevDate,
    store_count: snapshots.length,
    company_ratio: companyRatio,
    new_store_grace_days: NEW_STORE_GRACE_DAYS,
    totals: {
      store_count: snapshots.length,
      ratio: companyRatio,
      total_excess: totalExcess,
      total_soh: totalSoh,
      total_rf_sku: rf.total,
      rf_store_count: rf.storeCount,
      rf_sku_delta: rf.total !== null && previousRf.total !== null
        ? rf.total - previousRf.total
        : null,
      total_sku_carry: carry.total,
      ovs_carry_ratio: ratioOf(sku0Total, carry.total),
    },
    rows,
  };
}

// ---------------------------------------------------------------------------
// 店舖端（只回自己 ＋ 全公司加權平均線；不洩漏任何個別店數據）
// ---------------------------------------------------------------------------

export interface ShopStockStoreSeriesPoint {
  report_date: string;
  report_kind: string;
  ratio: number | null;
  wow_delta_pt: number | null;
  excess_value_0sale: number | null;
  shop_stock_value_cm: number | null;
  /** 本店不良存貨 SKU 佔店內貨品比率（小數）；缺 SKU Carry 時為 null */
  ovs_carry_ratio: number | null;
}

export interface ShopStockCompanySeriesPoint {
  report_date: string;
  ratio: number | null;
  wow_delta_pt: number | null;
  /** 全公司加權「不良存貨 SKU 佔店內貨品比率」（小數） */
  ovs_carry_ratio: number | null;
}

export interface ShopStockStoreKpi {
  report_date: string;
  report_kind: string;
  ratio: number | null;
  wow_delta_pt: number | null;
  /** 本店最新一期店舖存貨值（前端 KPI 卡固定讀 total_soh） */
  total_soh: number | null;
  /** 本店最新一期不良存貨值（前端 KPI 卡固定讀 total_excess） */
  total_excess: number | null;
  sku_count_0sale: number | null;
  /** 與 total_soh / total_excess 同值的舊欄名，保留給已上線的前端 bundle */
  shop_stock_value_cm: number | null;
  excess_value_0sale: number | null;
  company_ratio: number | null;
  /** 自己 - 全公司，百分點 */
  delta_vs_company_pt: number | null;
  /** 本店不良存貨 SKU 佔店內貨品比率（小數）；缺 SKU Carry 時為 null */
  ovs_carry_ratio: number | null;
  /** 全公司同日加權「不良存貨 SKU 佔店內貨品比率」 */
  company_ovs_carry_ratio: number | null;
}

export interface ShopStockStoreView {
  has_data: boolean;
  site_code: string;
  series: ShopStockStoreSeriesPoint[];
  company_series: ShopStockCompanySeriesPoint[];
  kpi: ShopStockStoreKpi | null;
  company_avg_ratio: number | null;
}

export async function getShopStockForStore(siteCode: string): Promise<ShopStockStoreView> {
  const r = await query<RawSnapshotRow & { report_date: string; report_kind: string }>(
    `${SNAPSHOT_SELECT}, b.report_date::text AS report_date, b.report_kind
       FROM shop_stock_snapshots s
       JOIN shop_stock_batches b ON b.id = s.batch_id
      WHERE s.site_code = $1
      ORDER BY b.report_date`,
    [siteCode],
  );

  const series: ShopStockStoreSeriesPoint[] = r.rows.map((raw) => {
    const row = mapSnapshotRow(raw);
    return {
      report_date: toDateOnly(raw.report_date),
      report_kind: raw.report_kind,
      ratio: row.ratio,
      wow_delta_pt: null,
      excess_value_0sale: row.excess_value_0sale,
      shop_stock_value_cm: row.shop_stock_value_cm,
      ovs_carry_ratio: row.ovs_carry_ratio,
    };
  });
  for (let i = 1; i < series.length; i += 1) {
    series[i]!.wow_delta_pt = deltaPt(series[i]!.ratio, series[i - 1]!.ratio);
  }

  const companySeries = await loadCompanySeries();
  const company_series: ShopStockCompanySeriesPoint[] = companySeries.map((point) => ({
    report_date: point.report_date,
    ratio: point.ratio,
    wow_delta_pt: point.wow_delta_pt,
    ovs_carry_ratio: point.ovs_carry_ratio,
  }));
  const companyByDate = new Map(companySeries.map((point) => [point.report_date, point.ratio]));
  const companyOvsByDate = new Map(companySeries.map((point) => [point.report_date, point.ovs_carry_ratio]));

  const latest = r.rows[r.rows.length - 1];
  if (!latest) {
    return { has_data: false, site_code: siteCode, series: [], company_series, kpi: null, company_avg_ratio: null };
  }
  const latestRow = mapSnapshotRow(latest);
  const latestDate = toDateOnly(latest.report_date);
  const companyRatio = companyByDate.get(latestDate) ?? null;
  const companyOvsRatio = companyOvsByDate.get(latestDate) ?? null;
  const kpi: ShopStockStoreKpi = {
    report_date: latestDate,
    report_kind: latest.report_kind,
    ratio: latestRow.ratio,
    wow_delta_pt: series[series.length - 2]
      ? deltaPt(latestRow.ratio, series[series.length - 2]!.ratio)
      : null,
    total_soh: latestRow.shop_stock_value_cm,
    total_excess: latestRow.excess_value_0sale,
    sku_count_0sale: latestRow.sku_count_0sale,
    shop_stock_value_cm: latestRow.shop_stock_value_cm,
    excess_value_0sale: latestRow.excess_value_0sale,
    company_ratio: companyRatio,
    delta_vs_company_pt: deltaPt(latestRow.ratio, companyRatio),
    ovs_carry_ratio: latestRow.ovs_carry_ratio,
    company_ovs_carry_ratio: companyOvsRatio,
  };

  return {
    has_data: true,
    site_code: siteCode,
    series,
    company_series,
    kpi,
    company_avg_ratio: companySeries[companySeries.length - 1]?.ratio ?? null,
  };
}
