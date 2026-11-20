import ExcelJS from 'exceljs';
import type { Zero90Kpi, Zero90Point } from './zeroSales90d.js';

/**
 * 「90日0銷售（統計）」匯出（PPT 用）。
 *
 * 工作表：
 *   1. 90日0銷售   — 每期完整數字（兩個分項、合計、佔比、較上期）
 *   2. PPT 圖表用  — 只有期別 + 三個 SKU 欄 + 存貨量，插入折線圖即用
 *   3. 匯出說明    — 口徑、期數、最新一期、產生時間
 *
 * 口徑與畫面一致：總數 = MAKE UP + Non-MAKE UP；變幅基準是上一期，
 * 上一期為 0 或不存在時百分比留空（不是 0%）。
 */

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
  '報表日期',
  '店數',
  '90日0銷售 SKU 總數',
  'MAKE UP SKU',
  'Non-MAKE UP SKU',
  '存貨量（CM）總數',
  'MAKE UP 存貨量（CM）',
  'Non-MAKE UP 存貨量（CM）',
  'MAKE UP SKU 佔比',
  'MAKE UP 存貨量佔比',
  'SKU 較上期',
  'SKU 變幅',
  '存貨量較上期',
  '存貨量變幅',
  '平均每店 SKU',
  '備註',
] as const;

const DETAIL_WIDTHS = [13, 8, 20, 13, 17, 19, 19, 23, 17, 19, 13, 11, 15, 13, 13, 28];

const DETAIL_FORMATS: Record<number, string> = {
  2: '#,##0',
  3: '#,##0',
  4: '#,##0',
  5: '#,##0',
  6: '#,##0.00',
  7: '#,##0.00',
  8: '#,##0.00',
  9: '0.0%',
  10: '0.0%',
  11: '+#,##0;-#,##0;0',
  12: '+0.0%;-0.0%;0.0%',
  13: '+#,##0.00;-#,##0.00;0.00',
  14: '+0.0%;-0.0%;0.0%',
  15: '#,##0.0',
};

export interface Zero90ExportInput {
  /** 依 report_date 升序；目前畫面沒有篩選，等於全部期數 */
  rows: Zero90Point[];
  kpi: Zero90Kpi | null;
  /** 產生時間（HK，YYYY-MM-DD HH:mm:ss） */
  generatedAt: string;
}

function styleHeaderRow(sheet: ExcelJS.Worksheet, columns: number): void {
  for (let c = 1; c <= columns; c += 1) {
    sheet.getCell(1, c).style = HEADER_STYLE;
  }
  sheet.getRow(1).height = 20;
}

export async function buildZero90Buffer(input: Zero90ExportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RP Connect';
  workbook.created = new Date();

  /* ---------- 1. 完整數字 ---------- */
  const detail = workbook.addWorksheet('90日0銷售');
  detail.addRow([...DETAIL_HEADERS]);
  styleHeaderRow(detail, DETAIL_HEADERS.length);

  for (const row of input.rows) {
    detail.addRow([
      row.report_date,
      row.shop_count,
      row.sku_total,
      row.makeup_sku,
      row.non_makeup_sku,
      row.qty_total,
      row.makeup_qty_cm,
      row.non_makeup_qty_cm,
      row.makeup_sku_share,
      row.makeup_qty_share,
      row.sku_delta,
      row.sku_delta_pct,
      row.qty_delta,
      row.qty_delta_pct,
      row.sku_per_shop,
      row.note || null,
    ]);
  }

  DETAIL_WIDTHS.forEach((width, index) => {
    detail.getColumn(index + 1).width = width;
  });
  // 日期保持文字，避免 Excel 依地區設定改寫
  detail.getColumn(1).numFmt = '@';
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

  /* ---------- 2. PPT 圖表用 ---------- */
  const chartSheet = workbook.addWorksheet('PPT 圖表用');
  chartSheet.addRow(['報表日期', 'SKU 總數', 'MAKE UP SKU', 'Non-MAKE UP SKU', '存貨量（CM）']);
  styleHeaderRow(chartSheet, 5);
  for (const row of input.rows) {
    chartSheet.addRow([row.report_date, row.sku_total, row.makeup_sku, row.non_makeup_sku, row.qty_total]);
  }
  [14, 14, 14, 18, 18].forEach((width, index) => {
    chartSheet.getColumn(index + 1).width = width;
  });
  chartSheet.getColumn(1).numFmt = '@';
  [2, 3, 4].forEach((col) => { chartSheet.getColumn(col).numFmt = '#,##0'; });
  chartSheet.getColumn(5).numFmt = '#,##0.00';
  chartSheet.views = [{ state: 'frozen', ySplit: 1 }];

  /* ---------- 3. 匯出說明 ---------- */
  const info = workbook.addWorksheet('匯出說明');
  const kpi = input.kpi;
  const infoRows: Array<[string, string | number | null]> = [
    ['圖表', '90日0銷售（統計）走勢'],
    ['口徑', 'SKU 總數 = MAKE UP SKU + Non-MAKE UP SKU；存貨量（CM）總數 = MAKE UP + Non-MAKE UP。數字為每週「90日0銷售（統計）」簡報的統計值，不是 I14「By Shop」的 No. of Overstock SKU'],
    ['每店平均', 'SKU 總數 ÷ 該期店數；店數為 0 時留空'],
    ['較上期', '與上一期比較；上一期為 0 或不存在時，百分比留空（不是 0%）'],
    ['期數', input.rows.length],
    ['最新一期', kpi ? kpi.report_date : '—'],
    ['最新 SKU 總數', kpi ? kpi.sku_total : null],
    ['最新存貨量（CM）', kpi ? kpi.qty_total : null],
    ['最新 MAKE UP SKU 佔比', kpi ? kpi.makeup_sku_share : null],
    ['最新涉及店數', kpi ? kpi.shop_count : null],
    ['產生時間（HK）', input.generatedAt],
  ];
  info.addRow(['項目', '內容']);
  styleHeaderRow(info, 2);
  for (const [label, value] of infoRows) {
    info.addRow([label, value]);
  }
  info.getColumn(1).width = 26;
  info.getColumn(2).width = 90;
  // 第 2 行是表頭，數字由第 8 行開始（最新 SKU 總數）
  info.getCell(8, 2).numFmt = '#,##0';
  info.getCell(9, 2).numFmt = '#,##0.00';
  info.getCell(10, 2).numFmt = '0.0%';
  info.getCell(11, 2).numFmt = '#,##0';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
