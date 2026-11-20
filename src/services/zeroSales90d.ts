import { query } from '../db/pool.js';

/**
 * 「90日0銷售（統計）」每週摘要服務。
 *
 * 口徑（固定，不要用 I14 反推）：
 *   * SKU 總數 = MAKE UP SKU + Non-MAKE UP SKU
 *   * 存貨量（CM）總數 = MAKE UP 存貨量 + Non-MAKE UP 存貨量
 *   * 只存兩個分項，總數一律在這一層相加 —— 資料庫不會出現「總數 ≠ 分項和」
 *   * 每店平均 = 總數 ÷ 店數；店數為 0／缺值時回 null（不是 0）
 *   * 變幅 = 與上一期比較；上一期為 0 或不存在時百分比回 null（不是 0%）
 *
 * 這張表是手動輸入（每週照「90日0銷售（統計）」簡報入數），
 * 與 shop_stock_*（I14 By Shop）完全獨立，互不影響。
 */

export interface Zero90Row {
  report_date: string;
  shop_count: number;
  makeup_sku: number;
  makeup_qty_cm: number;
  non_makeup_sku: number;
  non_makeup_qty_cm: number;
  note: string;
  updated_by: string | null;
}

export interface Zero90Point extends Zero90Row {
  /** MAKE UP + Non-MAKE UP */
  sku_total: number;
  qty_total: number;
  /** MAKE UP 佔 SKU 總數／存貨量；分母為 0 時 null */
  makeup_sku_share: number | null;
  makeup_qty_share: number | null;
  /** 平均每店（總數 ÷ 店數）；店數 0 時 null */
  sku_per_shop: number | null;
  qty_per_shop: number | null;
  /** 上一期日期（用嚟標示變幅基準） */
  prev_report_date: string | null;
  sku_delta: number | null;
  sku_delta_pct: number | null;
  qty_delta: number | null;
  qty_delta_pct: number | null;
}

export interface Zero90Kpi extends Zero90Point {
  /** 目前共有幾期（包括最新一期） */
  period_count: number;
}

export interface Zero90Summary {
  series: Zero90Point[];
  kpi: Zero90Kpi | null;
  period_count: number;
}

export interface Zero90UpsertInput {
  reportDate: string;
  shopCount: number;
  makeupSku: number;
  makeupQtyCm: number;
  nonMakeupSku: number;
  nonMakeupQtyCm: number;
  note: string;
  actor: string;
}

interface RawRow {
  report_date: string;
  shop_count: number;
  makeup_sku: number;
  makeup_qty_cm: string | number;
  non_makeup_sku: number;
  non_makeup_qty_cm: string | number;
  note: string | null;
  updated_by: string | null;
}

/** pg 的 NUMERIC 是 string；空字串／非數字一律 null（絕不寫 0） */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

function mapRow(row: RawRow): Zero90Row {
  return {
    report_date: String(row.report_date).slice(0, 10),
    shop_count: Number(row.shop_count),
    makeup_sku: Number(row.makeup_sku),
    makeup_qty_cm: toNumber(row.makeup_qty_cm) ?? 0,
    non_makeup_sku: Number(row.non_makeup_sku),
    non_makeup_qty_cm: toNumber(row.non_makeup_qty_cm) ?? 0,
    note: row.note ?? '',
    updated_by: row.updated_by ?? null,
  };
}

/** 由左至右計算每期衍生數字；上一期不存在時所有變幅都是 null */
function buildPoints(rows: Zero90Row[]): Zero90Point[] {
  const points: Zero90Point[] = [];
  let prev: Zero90Point | null = null;

  for (const row of rows) {
    const skuTotal = row.makeup_sku + row.non_makeup_sku;
    const qtyTotal = row.makeup_qty_cm + row.non_makeup_qty_cm;
    const point: Zero90Point = {
      ...row,
      sku_total: skuTotal,
      qty_total: qtyTotal,
      makeup_sku_share: ratio(row.makeup_sku, skuTotal),
      makeup_qty_share: ratio(row.makeup_qty_cm, qtyTotal),
      sku_per_shop: ratio(skuTotal, row.shop_count),
      qty_per_shop: ratio(qtyTotal, row.shop_count),
      prev_report_date: prev ? prev.report_date : null,
      sku_delta: prev ? skuTotal - prev.sku_total : null,
      sku_delta_pct: prev ? ratio(skuTotal - prev.sku_total, prev.sku_total) : null,
      qty_delta: prev ? qtyTotal - prev.qty_total : null,
      qty_delta_pct: prev ? ratio(qtyTotal - prev.qty_total, prev.qty_total) : null,
    };
    points.push(point);
    prev = point;
  }

  return points;
}

/** 全部期數，依 report_date 升序（圖表左至右） */
export async function listZero90Stats(): Promise<Zero90Point[]> {
  const result = await query<RawRow>(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS report_date,
            shop_count,
            makeup_sku,
            makeup_qty_cm,
            non_makeup_sku,
            non_makeup_qty_cm,
            note,
            updated_by
       FROM zero_sales_90d_stats
      ORDER BY report_date ASC`,
  );
  return buildPoints(result.rows.map(mapRow));
}

/** 圖表＋KPI 一次過（前端只打一支 API） */
export async function getZero90Summary(): Promise<Zero90Summary> {
  const series = await listZero90Stats();
  const latest = series.length ? series[series.length - 1] : null;
  return {
    series,
    kpi: latest ? { ...latest, period_count: series.length } : null,
    period_count: series.length,
  };
}

/** 新增／覆蓋同一期（report_date 唯一）；回傳最新一期 */
export async function upsertZero90Stat(input: Zero90UpsertInput): Promise<Zero90Point> {
  const result = await query<RawRow>(
    `INSERT INTO zero_sales_90d_stats
       (report_date, shop_count, makeup_sku, makeup_qty_cm,
        non_makeup_sku, non_makeup_qty_cm, note, updated_by)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (report_date) DO UPDATE
       SET shop_count = EXCLUDED.shop_count,
           makeup_sku = EXCLUDED.makeup_sku,
           makeup_qty_cm = EXCLUDED.makeup_qty_cm,
           non_makeup_sku = EXCLUDED.non_makeup_sku,
           non_makeup_qty_cm = EXCLUDED.non_makeup_qty_cm,
           note = EXCLUDED.note,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by
     RETURNING to_char(report_date, 'YYYY-MM-DD') AS report_date,
               shop_count, makeup_sku, makeup_qty_cm,
               non_makeup_sku, non_makeup_qty_cm, note, updated_by`,
    [
      input.reportDate,
      input.shopCount,
      input.makeupSku,
      input.makeupQtyCm,
      input.nonMakeupSku,
      input.nonMakeupQtyCm,
      input.note,
      input.actor,
    ],
  );

  const inserted = result.rows[0];
  if (!inserted) throw new Error('儲存 90日0銷售統計失敗：資料庫未回傳資料');
  const saved = mapRow(inserted);
  // 用來計變幅的上一期（嚴格早於本次輸入的日期）
  const prevRow = await query<RawRow>(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS report_date,
            shop_count, makeup_sku, makeup_qty_cm,
            non_makeup_sku, non_makeup_qty_cm, note, updated_by
       FROM zero_sales_90d_stats
      WHERE report_date < $1::date
      ORDER BY report_date DESC
      LIMIT 1`,
    [input.reportDate],
  );
  const points = buildPoints([...(prevRow.rows.map(mapRow)), saved]);
  const point = points[points.length - 1];
  if (!point) throw new Error('儲存 90日0銷售統計失敗：無法計算衍生數字');
  return point;
}

/** 刪除某一期；回傳是否有刪到（false = 該期不存在）
 *  用 RETURNING 的行數而不是 rowCount：PGlite（測試用）唔會填 rowCount。 */
export async function deleteZero90Stat(reportDate: string): Promise<boolean> {
  const result = await query<{ report_date: string }>(
    'DELETE FROM zero_sales_90d_stats WHERE report_date = $1::date RETURNING report_date',
    [reportDate],
  );
  return result.rows.length > 0;
}
