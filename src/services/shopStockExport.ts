import ExcelJS from 'exceljs';
import {
  deriveWeekLabel,
  type ShopStockKpi,
  type ShopStockSeriesPoint,
  type ShopStockStoreView,
  type ShopStockWeek,
  type ShopStockWeekRow,
} from './shopStock.js';

/**
 * 「佔比趨勢」圖表的 Excel 匯出（PPT 用）。
 *
 * 三個工作表：
 *   1. 佔比趨勢   — 圖表點擊/懸停看到的完整數字（金額、比率、WoW 百分點），可直接做表
 *   2. PPT 圖表用 — 只有「期別 + 佔比」兩欄的乾淨資料，插入折線圖即用
 *   3. 匯出說明   — 口徑、匯出範圍、產生時間（不放在資料表內，避免弄髒圖表來源）
 *
 * 口徑與 Dashboard 完全一致：比率 = Σ不良存貨值 ÷ Σ店舖存貨值（加權），
 * 分母 NULL / <= 0 時比率留空（不寫 0，避免畫出假 0% 線）。
 * 同一份資料亦帶出 No. of RF SKU（全公司合計、覆蓋店數、較上期增減）
 * 及「不良存貨 SKU 佔店內貨品比率」= Σ No. of Overstock SKU (P90D 0 Sales) ÷ Σ No. of SKU Carry
 * （SKU Carry = RF SKU + ND with Stock，已核實；分子必為分母子集，比率不超過 100%）。
 */

const KIND_LABELS: Record<string, string> = {
  weekly: '週更',
  month_end: '月結',
  ad_hoc: '臨時',
};

export function shopStockKindLabel(kind: string | null | undefined): string {
  const key = String(kind ?? '').trim();
  return KIND_LABELS[key] ?? (key || '—');
}

const HEADER_STYLE: Partial<ExcelJS.Style> = {
  font: { bold: true, color: { argb: 'FF000000' } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
  border: {
    top: { style: 'thin' },
    left: { style: 'thin' },
    bottom: { style: 'thin' },
    right: { style: 'thin' },
  },
};

const DETAIL_HEADERS = [
  '期別',
  '週次',
  '報表類型',
  '店數',
  '計入比率店數',
  '店舖存貨值合計',
  '不良存貨值（0 Sale）',
  '不良存貨佔比',
  '較上期變化（pp）',
  '不良存貨值（>2 期）',
  '佔比（>2 期）',
  '不良存貨值（合計）',
  '佔比（合計）',
  '0 Sale SKU 數',
  'RF SKU 合計',
  'RF 資料店數',
  'RF SKU 較上期',
  '不良存貨SKU÷SKU Carry',
] as const;

const DETAIL_WIDTHS = [12, 12, 10, 8, 12, 18, 22, 14, 16, 20, 14, 20, 14, 14, 14, 12, 16, 16];

/** 1-based 欄位的數字格式（比率存小數，交由 Excel 顯示成百分比） */
const DETAIL_FORMATS: Record<number, string> = {
  4: '#,##0',
  5: '#,##0',
  6: '#,##0',
  7: '#,##0',
  8: '0.0%',
  9: '+0.00;-0.00;0.00',
  10: '#,##0',
  11: '0.0%',
  12: '#,##0',
  13: '0.0%',
  14: '#,##0',
  15: '#,##0',
  16: '#,##0',
  17: '+0;-0;0',
  18: '0.0%',
};

function styleHeaderRow(sheet: ExcelJS.Worksheet, columns: number): void {
  for (let c = 1; c <= columns; c += 1) {
    sheet.getCell(1, c).style = HEADER_STYLE;
  }
  sheet.getRow(1).height = 20;
}

export interface ShopStockTrendExportInput {
  /** 依 report_date 升序的一期一列 */
  rows: ShopStockSeriesPoint[];
  kpi: ShopStockKpi | null;
  companyAvgRatio: number | null;
  /** 顯示窗口（月），與圖表上 3 / 6 / 12 / 24 一致 */
  months: number;
  /** 產生時間（HK，YYYY-MM-DD HH:mm:ss） */
  generatedAt: string;
}

export async function buildShopStockTrendBuffer(input: ShopStockTrendExportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NDRF Portal';
  workbook.created = new Date();

  /* ---------- 1. 佔比趨勢（完整數字） ---------- */
  const detail = workbook.addWorksheet('佔比趨勢');
  detail.addRow([...DETAIL_HEADERS]);
  styleHeaderRow(detail, DETAIL_HEADERS.length);

  for (const row of input.rows) {
    detail.addRow([
      row.report_date,
      deriveWeekLabel(row.report_date),
      shopStockKindLabel(row.report_kind),
      row.store_count,
      row.ratio_store_count,
      row.total_soh,
      row.total_excess,
      row.ratio,
      row.wow_delta_pt,
      row.total_excess_over2,
      row.ratio_over2,
      row.total_excess_total,
      row.ratio_total,
      row.sku_count_0sale,
      row.total_rf_sku,
      row.rf_store_count,
      row.rf_sku_delta,
      row.ovs_carry_ratio,
    ]);
  }

  DETAIL_WIDTHS.forEach((width, index) => {
    detail.getColumn(index + 1).width = width;
  });
  // 期別／週次保持文字，避免 Excel 依地區設定改寫成日期
  detail.getColumn(1).numFmt = '@';
  detail.getColumn(2).numFmt = '@';
  for (const [col, fmt] of Object.entries(DETAIL_FORMATS)) {
    detail.getColumn(Number(col)).numFmt = fmt;
  }
  detail.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
  if (input.rows.length > 0) {
    detail.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: input.rows.length + 1, column: DETAIL_HEADERS.length },
    };
  }

  /* ---------- 2. PPT 圖表用（只有兩欄，插入折線圖即可） ---------- */
  const chartSheet = workbook.addWorksheet('PPT 圖表用');
  chartSheet.addRow(['期別', '不良存貨佔比']);
  styleHeaderRow(chartSheet, 2);
  for (const row of input.rows) {
    chartSheet.addRow([row.report_date, row.ratio]);
  }
  chartSheet.getColumn(1).width = 14;
  chartSheet.getColumn(1).numFmt = '@';
  chartSheet.getColumn(2).width = 18;
  chartSheet.getColumn(2).numFmt = '0.0%';
  chartSheet.views = [{ state: 'frozen', ySplit: 1 }];

  /* ---------- 3. 匯出說明（口徑 + 範圍） ---------- */
  const info = workbook.addWorksheet('匯出說明');
  const kpi = input.kpi;
  const infoRows: Array<[string, string | number | null]> = [
    ['圖表', '佔比趨勢（不良存貨 ÷ 店舖存貨，全公司加權）'],
    ['口徑', '比率 = Σ不良存貨值 ÷ Σ店舖存貨值；分母為 0 或空值的期數比率留空（顯示為空白，非 0%）。「不良存貨SKU÷SKU Carry」= Σ No. of Overstock SKU (P90D 0 Sales) ÷ Σ No. of SKU Carry（加權）；SKU Carry = RF SKU + ND with Stock，分子必為分母子集，比率不超過 100%'],
    ['顯示範圍', `最近 ${input.months} 個月（與後台圖表一致）`],
    ['期數', input.rows.length],
    ['最新一期', kpi ? `${kpi.report_date}（${shopStockKindLabel(kpi.report_kind)}）` : '—'],
    ['最新佔比', kpi?.ratio ?? null],
    ['最新較上期變化（pp）', kpi?.wow_delta_pt ?? null],
    ['店舖存貨值合計', kpi?.total_soh ?? null],
    ['不良存貨值（0 Sale）', kpi?.total_excess ?? null],
    ['涉及店數', kpi?.store_count ?? null],
    ['RF SKU 合計（全公司）', kpi?.total_rf_sku ?? null],
    ['RF 資料店數', kpi?.rf_store_count ?? null],
    ['不良存貨SKU÷SKU Carry（全公司加權）', kpi?.ovs_carry_ratio ?? null],
    ['產生時間（HK）', input.generatedAt],
  ];
  info.addRow(['項目', '內容']);
  styleHeaderRow(info, 2);
  for (const [label, value] of infoRows) {
    info.addRow([label, value]);
  }
  info.getColumn(1).width = 24;
  info.getColumn(2).width = 70;
  // 只把比率 / 變化 / 金額三類做格式，其餘保持原文
  info.getCell(7, 2).numFmt = '0.0%';
  info.getCell(8, 2).numFmt = '+0.00;-0.00;0.00';
  info.getCell(9, 2).numFmt = '#,##0';
  info.getCell(10, 2).numFmt = '#,##0';
  info.getCell(12, 2).numFmt = '#,##0';
  info.getCell(13, 2).numFmt = '#,##0';
  info.getCell(14, 2).numFmt = '0.0%';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ===========================================================================
// 每店明細（某一期）—— 跟住畫面篩選，匯出 = 畫面所見
// ===========================================================================

/** 畫面排序選項（public/js/admin-stock.js 的 filteredWeekRows 同款） */
export const SHOP_STOCK_WEEK_SORTS = [
  'ratio_desc',
  'ratio_asc',
  'ovscarry_desc',
  'rf_desc',
  'rf_delta_desc',
  'excess_desc',
  'wow_desc',
] as const;

export type ShopStockWeekSort = (typeof SHOP_STOCK_WEEK_SORTS)[number];

export interface ShopStockWeekExportFilters {
  /** 搜尋：Site / 店舖 / OM / 性質 */
  q?: string;
  sort?: string;
  /** 只顯示：worse（WoW 惡化） / better（WoW 改善） */
  only?: string;
}

export interface NormalizedWeekExportFilters {
  q: string;
  sort: ShopStockWeekSort;
  only: '' | 'worse' | 'better';
}

/** 收窄前端傳來的參數，非法值一律退回預設（唔會令匯出失敗） */
export function normalizeWeekExportFilters(input: ShopStockWeekExportFilters): NormalizedWeekExportFilters {
  const sort = (SHOP_STOCK_WEEK_SORTS as readonly string[]).includes(String(input.sort ?? ''))
    ? (input.sort as ShopStockWeekSort)
    : 'ratio_desc';
  const only = input.only === 'worse' || input.only === 'better' ? input.only : '';
  return { q: String(input.q ?? '').trim(), sort, only };
}

/**
 * 每店明細的篩選 + 排序。
 * ⚠️ 呢段邏輯必須同 public/js/admin-stock.js 的 filteredWeekRows() 一致，
 *    否則「匯出 = 畫面所見」就會講大話。改一邊就要改兩邊。
 */
export function filterAndSortWeekRows(
  rows: ShopStockWeekRow[],
  filters: NormalizedWeekExportFilters,
): ShopStockWeekRow[] {
  const q = filters.q.trim().toLowerCase();
  let out = rows.slice();
  if (q) {
    out = out.filter((r) =>
      [r.site_code, r.shop, r.om, r.shop_nature].some((v) =>
        String(v ?? '').toLowerCase().includes(q),
      ),
    );
  }
  // wow_delta_pt 單位是百分點；0.0001 為浮點雜訊下限（與前端一致）
  if (filters.only === 'worse') out = out.filter((r) => (r.wow_delta_pt ?? 0) > 0.0001);
  if (filters.only === 'better') out = out.filter((r) => (r.wow_delta_pt ?? 0) < -0.0001);

  const pick = (r: ShopStockWeekRow): number | null => {
    switch (filters.sort) {
      case 'excess_desc': return r.deadstock_value;
      case 'wow_desc': return r.wow_delta_pt;
      case 'rf_desc': return r.rf_sku_count;
      case 'rf_delta_desc': return r.rf_sku_delta;
      case 'ovscarry_desc': return r.ovs_carry_ratio;
      default: return r.ratio;
    }
  };
  out.sort((a, b) => {
    const av = pick(a);
    const bv = pick(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // 缺值永遠排最後（比 0 更不誤導）
    if (bv === null) return -1;
    return filters.sort === 'ratio_asc' ? av - bv : bv - av;
  });
  return out;
}

const WEEK_DETAIL_HEADERS = [
  '排名',
  'Site',
  '店舖',
  'OM',
  'Shop Nature',
  'RF SKU',
  'RF 較上期',
  '不良存貨 SKU ÷ 店內貨品',
  '不良存貨值',
  '店舖存貨值',
  '不良存貨佔比',
  '不良存貨佔比 WoW（pp）',
  '狀態',
] as const;

const WEEK_DETAIL_WIDTHS = [7, 10, 22, 12, 14, 12, 12, 20, 16, 16, 14, 20, 12];

const WEEK_DETAIL_FORMATS: Record<number, string> = {
  1: '0',
  6: '#,##0',
  7: '+0;-0;0',
  8: '0.0%',
  9: '#,##0',
  10: '#,##0',
  11: '0.0%',
  12: '+0.00;-0.00;0.00',
};

export interface ShopStockWeekExportInput {
  week: ShopStockWeek;
  filters: NormalizedWeekExportFilters;
  /** 已套用篩選 + 排序的行（由 filterAndSortWeekRows 產生） */
  rows: ShopStockWeekRow[];
  generatedAt: string;
}

/** 每店明細的 Excel：工作表「每店明細」＋「匯出說明」 */
export async function buildShopStockWeekBuffer(input: ShopStockWeekExportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NDRF Portal';
  workbook.created = new Date();

  const detail = workbook.addWorksheet('每店明細');
  detail.addRow([...WEEK_DETAIL_HEADERS]);
  styleHeaderRow(detail, WEEK_DETAIL_HEADERS.length);

  for (const row of input.rows) {
    detail.addRow([
      row.rank ?? null,
      row.site_code,
      row.shop,
      row.om,
      row.shop_nature,
      row.rf_sku_count,
      row.rf_sku_delta,
      row.ovs_carry_ratio,
      row.deadstock_value,
      row.shop_stock_value,
      row.ratio,
      row.wow_delta_pt,
      row.is_new ? (row.new_reason === 'new_store' ? '新店' : '上期無數據') : '',
    ]);
  }

  WEEK_DETAIL_WIDTHS.forEach((width, index) => {
    detail.getColumn(index + 1).width = width;
  });
  detail.getColumn(2).numFmt = '@'; // Site 保持文字，唔好畀 Excel 當數字
  for (const [col, fmt] of Object.entries(WEEK_DETAIL_FORMATS)) {
    detail.getColumn(Number(col)).numFmt = fmt;
  }
  detail.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  if (input.rows.length > 0) {
    detail.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: input.rows.length + 1, column: WEEK_DETAIL_HEADERS.length },
    };
  }

  const sortLabels: Record<ShopStockWeekSort, string> = {
    ratio_desc: '不良存貨佔比 高→低',
    ratio_asc: '不良存貨佔比 低→高',
    ovscarry_desc: '不良存貨 SKU ÷ 店內貨品 高→低',
    rf_desc: 'RF SKU 高→低',
    rf_delta_desc: 'RF 較上期增加最多',
    excess_desc: '不良存貨值 高→低',
    wow_desc: 'WoW 惡化最多',
  };
  const onlyLabels: Record<string, string> = {
    '': '全部',
    worse: '只顯示 WoW 惡化（上升）',
    better: '只顯示 WoW 改善（下降）',
  };
  const info = workbook.addWorksheet('匯出說明');
  info.addRow(['項目', '內容']);
  styleHeaderRow(info, 2);
  const infoRows: Array<[string, string | number | null]> = [
    ['畫面', '存貨 Dashboard → 每店明細（不良存貨）'],
    ['期別', `${input.week.report_date}（${shopStockKindLabel(input.week.report_kind)}）`],
    ['上一期', input.week.prev_report_date ?? '—（無上一期）'],
    ['該期店數', input.week.store_count],
    ['匯出店數', input.rows.length],
    ['搜尋', input.filters.q ? input.filters.q : '（無）'],
    ['排序', sortLabels[input.filters.sort]],
    ['只顯示', onlyLabels[input.filters.only] ?? '全部'],
    ['口徑', '不良存貨值 = Excess Stock Value (P90D 0 Sales)；不良存貨佔比 = 不良存貨值 ÷ 店舖存貨值 (CM)；WoW = 與上一期的百分點差（正數＝惡化）。分母為 0／缺值時比率留空（不是 0%）。'],
    ['不良存貨 SKU ÷ 店內貨品', 'No. of Overstock SKU (P90D 0 Sales) ÷ No. of SKU Carry（SKU Carry = RF SKU + ND with Stock）；分子必為分母子集，比率不超過 100%'],
    ['排名', '「排名」是該期可比較店舖（排除新店／上期無數據）的壞存貨佔比排名；新店／上期無數據的店舖仍列於表內但不佔名次'],
    ['全公司合計', `該期合計佔比 ${input.week.totals.ratio === null ? '—' : `${(input.week.totals.ratio * 100).toFixed(2)}%`}；店舖存貨值合計 ${input.week.totals.total_soh ?? '—'}；不良存貨值合計 ${input.week.totals.total_excess ?? '—'}`],
    ['產生時間（HK）', input.generatedAt],
  ];
  for (const [label, value] of infoRows) info.addRow([label, value]);
  info.getColumn(1).width = 22;
  info.getColumn(2).width = 90;
  info.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ===========================================================================
// No. of RF SKU Dashboard（自動補貨）
// ===========================================================================

const RF_TREND_HEADERS = [
  '期別',
  '週次',
  '報表類型',
  'RF SKU 合計',
  'RF 資料店數',
  'RF SKU 較上期',
  '不良存貨 SKU ÷ 店內貨品',
  '較上期（pp）',
  '店舖存貨值合計',
  '不良存貨值（0 Sale）',
] as const;

const RF_TREND_FORMATS: Record<number, string> = {
  4: '#,##0',
  5: '#,##0',
  6: '+0;-0;0',
  7: '0.0%',
  8: '+0.00;-0.00;0.00',
  9: '#,##0',
  10: '#,##0',
};

const RF_RANK_HEADERS = [
  '排名',
  'Site',
  '店舖',
  'OM',
  'Shop Nature',
  'RF SKU',
  'RF 較上期',
] as const;

const RF_RANK_FORMATS: Record<number, string> = { 1: '0', 6: '#,##0', 7: '+0;-0;0' };

const OVS_RANK_HEADERS = [
  '排名',
  'Site',
  '店舖',
  'OM',
  'Shop Nature',
  '不良存貨 SKU',
  '店內貨品 SKU',
  '不良存貨 SKU ÷ 店內貨品',
] as const;

const OVS_RANK_FORMATS: Record<number, string> = { 1: '0', 6: '#,##0', 7: '#,##0', 8: '0.0%' };

export interface ShopStockRfExportInput {
  /** 已按顯示窗口裁剪的期數序列 */
  series: ShopStockSeriesPoint[];
  kpi: ShopStockKpi | null;
  /** 排名用的該期每店行（null 代表冇揀期） */
  week: ShopStockWeek | null;
  months: number;
  generatedAt: string;
}

/** RF SKU Dashboard 的 Excel：走勢 + 兩張店舖排名 + 匯出說明 */
export async function buildShopStockRfBuffer(input: ShopStockRfExportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NDRF Portal';
  workbook.created = new Date();

  /* ---------- 1. RF SKU 走勢 ---------- */
  const trend = workbook.addWorksheet('RF SKU 走勢');
  trend.addRow([...RF_TREND_HEADERS]);
  styleHeaderRow(trend, RF_TREND_HEADERS.length);
  let prevOvs: number | null = null;
  for (const row of input.series) {
    const ovs = row.ovs_carry_ratio;
    const ovsWow = ovs !== null && prevOvs !== null ? (ovs - prevOvs) * 100 : null;
    if (ovs !== null) prevOvs = ovs;
    trend.addRow([
      row.report_date,
      deriveWeekLabel(row.report_date),
      shopStockKindLabel(row.report_kind),
      row.total_rf_sku,
      row.rf_store_count,
      row.rf_sku_delta,
      ovs,
      ovsWow,
      row.total_soh,
      row.total_excess,
    ]);
  }
  [12, 14, 12, 14, 14, 16, 22, 14, 18, 20].forEach((width, index) => {
    trend.getColumn(index + 1).width = width;
  });
  trend.getColumn(1).numFmt = '@';
  trend.getColumn(2).numFmt = '@';
  for (const [col, fmt] of Object.entries(RF_TREND_FORMATS)) {
    trend.getColumn(Number(col)).numFmt = fmt;
  }
  trend.views = [{ state: 'frozen', ySplit: 1 }];

  /* ---------- 2. RF SKU 店舖排名（畫面只顯示頭 15，Excel 俾齊全） ---------- */
  const rfRank = workbook.addWorksheet('RF SKU 店舖排名');
  rfRank.addRow([...RF_RANK_HEADERS]);
  styleHeaderRow(rfRank, RF_RANK_HEADERS.length);
  const rfRows = (input.week?.rows ?? [])
    .filter((row) => row.rf_sku_count !== null)
    .sort((a, b) => (b.rf_sku_count ?? 0) - (a.rf_sku_count ?? 0)
      || a.site_code.localeCompare(b.site_code));
  rfRows.forEach((row, index) => {
    rfRank.addRow([
      index + 1,
      row.site_code,
      row.shop,
      row.om,
      row.shop_nature,
      row.rf_sku_count,
      row.rf_sku_delta,
    ]);
  });
  [7, 10, 22, 12, 14, 12, 12].forEach((width, index) => {
    rfRank.getColumn(index + 1).width = width;
  });
  rfRank.getColumn(2).numFmt = '@';
  for (const [col, fmt] of Object.entries(RF_RANK_FORMATS)) {
    rfRank.getColumn(Number(col)).numFmt = fmt;
  }
  rfRank.views = [{ state: 'frozen', ySplit: 1 }];

  /* ---------- 3. 不良存貨 SKU ÷ 店內貨品 排名（與畫面同一套新店排除規則） ---------- */
  const ovsRank = workbook.addWorksheet('不良÷店內貨品 排名');
  ovsRank.addRow([...OVS_RANK_HEADERS]);
  styleHeaderRow(ovsRank, OVS_RANK_HEADERS.length);
  const ovsRows = (input.week?.rows ?? [])
    .filter((row) => !row.is_new && row.ovs_carry_ratio !== null)
    .sort((a, b) => (b.ovs_carry_ratio ?? 0) - (a.ovs_carry_ratio ?? 0)
      || a.site_code.localeCompare(b.site_code));
  ovsRows.forEach((row, index) => {
    ovsRank.addRow([
      index + 1,
      row.site_code,
      row.shop,
      row.om,
      row.shop_nature,
      row.sku_count_0sale,
      row.sku_carry_count,
      row.ovs_carry_ratio,
    ]);
  });
  [7, 10, 22, 12, 14, 16, 16, 22].forEach((width, index) => {
    ovsRank.getColumn(index + 1).width = width;
  });
  ovsRank.getColumn(2).numFmt = '@';
  for (const [col, fmt] of Object.entries(OVS_RANK_FORMATS)) {
    ovsRank.getColumn(Number(col)).numFmt = fmt;
  }
  ovsRank.views = [{ state: 'frozen', ySplit: 1 }];

  /* ---------- 4. 匯出說明 ---------- */
  const info = workbook.addWorksheet('匯出說明');
  info.addRow(['項目', '內容']);
  styleHeaderRow(info, 2);
  const kpi = input.kpi;
  const infoRows: Array<[string, string | number | null]> = [
    ['畫面', '存貨 Dashboard → No. of RF SKU Dashboard（自動補貨）'],
    ['顯示範圍', `最近 ${input.months} 個月（與後台圖表一致）`],
    ['期數', input.series.length],
    ['最新一期', kpi ? `${kpi.report_date}（${shopStockKindLabel(kpi.report_kind)}）` : '—'],
    ['RF SKU 合計（全公司）', kpi?.total_rf_sku ?? null],
    ['RF 資料店數', kpi?.rf_store_count ?? null],
    ['RF SKU 較上期', kpi?.rf_sku_delta ?? null],
    ['不良存貨 SKU ÷ 店內貨品（全公司加權）', kpi?.ovs_carry_ratio ?? null],
    ['排名期別', input.week ? `${input.week.report_date}（${shopStockKindLabel(input.week.report_kind)}）` : '—'],
    ['口徑', 'RF SKU = I14「No. of RF SKU」（自動補貨 SKU 數）。不良存貨 SKU ÷ 店內貨品 = No. of Overstock SKU (P90D 0 Sales) ÷ No. of SKU Carry（SKU Carry = RF SKU + ND with Stock）；全公司加權 = Σ分子 ÷ Σ分母，比率不超過 100%'],
    ['空白值', '空白或非法值一律留空（不會當作 0）；只有真 0 才顯示 0'],
    ['排名說明', '畫面只顯示頭 15 名，Excel 列出全部；「不良÷店內貨品」排名與畫面同一套排除規則（新店／上期無數據不參與）'],
    ['RF 增減顏色', 'RF SKU 增減本身不代表好壞，匯出只提供數字，不加紅綠好壞標示'],
    ['產生時間（HK）', input.generatedAt],
  ];
  for (const [label, value] of infoRows) info.addRow([label, value]);
  info.getColumn(1).width = 26;
  info.getColumn(2).width = 90;
  info.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  info.getCell(9, 2).numFmt = '0.0%';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ===========================================================================
// 店舖端：自己店舖的存貨走勢（只含本店 + 全公司加權平均）
// ===========================================================================

/**
 * 店舖端匯出的欄位：只提供「比率」，唔含任何金額。
 *
 * ⚠️ 資安考量：Excel 檔案好容易轉發（業主、供應商、跨部門），但頁面只係登入者
 * 自己見到。所以本店匯出**唔包含**「店舖存貨值（CM）」同「不良存貨值
 * （P90D 0 Sales）」兩個金額欄位，避免金額數據外流。
 * 口徑本身（不良存貨值 ÷ 店舖存貨值）寫喺匯出說明，讀者仍然知道比率點計。
 */
const STORE_TREND_HEADERS = [
  '期別',
  '週次',
  '不良存貨佔比',
  '較上期（pp）',
  '不良存貨 SKU ÷ 店內貨品',
  '全公司加權佔比',
  '與全公司差距（pp）',
] as const;

const STORE_TREND_FORMATS: Record<number, string> = {
  3: '0.0%',
  4: '+0.00;-0.00;0.00',
  5: '0.0%',
  6: '0.0%',
  7: '+0.00;-0.00;0.00',
};

const STORE_TREND_WIDTHS = [14, 12, 14, 14, 22, 18, 18];

export interface ShopStockStoreExportInput {
  view: ShopStockStoreView;
  generatedAt: string;
}

/** 店舖端匯出：只含自己店舖的數字 + 全公司加權平均（不洩漏其他店） */
export async function buildShopStockStoreBuffer(input: ShopStockStoreExportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NDRF Portal';
  workbook.created = new Date();

  const companyByDate = new Map(input.view.company_series.map((p) => [p.report_date, p.ratio]));
  const sheet = workbook.addWorksheet('本店走勢');
  sheet.addRow([...STORE_TREND_HEADERS]);
  styleHeaderRow(sheet, STORE_TREND_HEADERS.length);

  for (const row of input.view.series) {
    const companyRatio = companyByDate.get(row.report_date) ?? null;
    const gap = row.ratio !== null && companyRatio !== null ? (row.ratio - companyRatio) * 100 : null;
    // ⚠️ 故意唔寫入 shop_stock_value_cm / excess_value_0sale：金額唔可以外流
    sheet.addRow([
      row.report_date,
      deriveWeekLabel(row.report_date),
      row.ratio,
      row.wow_delta_pt,
      row.ovs_carry_ratio,
      companyRatio,
      gap,
    ]);
  }
  STORE_TREND_WIDTHS.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  sheet.getColumn(1).numFmt = '@';
  sheet.getColumn(2).numFmt = '@';
  for (const [col, fmt] of Object.entries(STORE_TREND_FORMATS)) {
    sheet.getColumn(Number(col)).numFmt = fmt;
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const info = workbook.addWorksheet('匯出說明');
  info.addRow(['項目', '內容']);
  styleHeaderRow(info, 2);
  const kpi = input.view.kpi;
  const infoRows: Array<[string, string | number | null]> = [
    ['畫面', 'Store Portal → 存貨走勢'],
    ['店舖', input.view.site_code],
    ['期數', input.view.series.length],
    ['最新一期', kpi ? `${kpi.report_date}（${shopStockKindLabel(kpi.report_kind)}）` : '—'],
    ['本店不良存貨佔比', kpi?.ratio ?? null],
    ['本店較上期（pp）', kpi?.wow_delta_pt ?? null],
    ['全公司加權佔比', input.view.company_avg_ratio ?? null],
    ['本店與全公司差距（pp）', kpi?.delta_vs_company_pt ?? null],
    ['口徑', '不良存貨值 = Excess Stock Value (P90D 0 Sales)；不良存貨佔比 = 不良存貨值 ÷ 店舖存貨值 (CM)。全公司佔比為加權（Σ不良存貨值 ÷ Σ店舖存貨值），只作對比，不含其他店舖明細'],
    ['不包含的資料', '本匯出只有比率，刻意唔包含「店舖存貨值（CM）」同「不良存貨值（P90D 0 Sales）」的金額數字，以免金額資料外流'],
    ['空白值', '分母為 0 或缺值的期數比率留空（不是 0%）；圖表同樣斷線'],
    ['產生時間（HK）', input.generatedAt],
  ];
  for (const [label, value] of infoRows) info.addRow([label, value]);
  info.getColumn(1).width = 22;
  info.getColumn(2).width = 90;
  info.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  // 依「項目」名稱定位格式，避免手寫行號錯位（之前 5/6/7/8 全部上移了一行）
  const rowOf = (label: string): number => infoRows.findIndex(([key]) => key === label) + 2;
  info.getCell(rowOf('本店不良存貨佔比'), 2).numFmt = '0.0%';
  info.getCell(rowOf('本店較上期（pp）'), 2).numFmt = '+0.00;-0.00;0.00';
  info.getCell(rowOf('全公司加權佔比'), 2).numFmt = '0.0%';
  info.getCell(rowOf('本店與全公司差距（pp）'), 2).numFmt = '+0.00;-0.00;0.00';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
