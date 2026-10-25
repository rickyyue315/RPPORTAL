import ExcelJS from 'exceljs';
import { deriveWeekLabel, type ShopStockKpi, type ShopStockSeriesPoint } from './shopStock.js';

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
 * 及「不良存貨 SKU 佔 RF 比率」= Σ No. of Overstock SKU (P90D 0 Sales) ÷ Σ RF SKU
 * （分子包含 ND 貨，個別 RF SKU 極少的店可超過 100%）。
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
  '不良存貨SKU÷RF',
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
      row.ovs_rf_ratio,
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
    ['口徑', '比率 = Σ不良存貨值 ÷ Σ店舖存貨值；分母為 0 或空值的期數比率留空（顯示為空白，非 0%）。「不良存貨SKU÷RF」= Σ No. of Overstock SKU (P90D 0 Sales) ÷ Σ No. of RF SKU（加權）；分子包含 ND 貨，個別 RF SKU 極少的店可超過 100%'],
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
    ['不良存貨SKU÷RF（全公司加權）', kpi?.ovs_rf_ratio ?? null],
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
