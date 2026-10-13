import ExcelJS from 'exceljs';
import { normalizeText } from './fields.js';
import { normalizeSiteCode } from '../services/stores.js';
import { hashFileContent } from './excelImport.js';

/** 90日零銷售上載欄位 (Admin 派發用，前22欄 + 店舖回覆可空) */
export const ZERO_SALES_COLUMNS = [
  'Site Code',
  'Shop Name',
  'OM',
  'Shop Nature',
  '店內庫存排名',
  'Buyer',
  'Brand',
  'SKU',
  'SKU Desc',
  'Adj. MCH1',
  'MAKE UP 分類',
  'RP Type',
  'Safety Stock (現時)',
  'Item Status',
  'Supply Source',
  'Shop Stock Qty (LM)',
  'Shop Stock Qty (CM)',
  'Sold Qty (P90D)',
  'Sold Qty (M-2)',
  'Sold Qty (M-1)',
  'Sold Qty (CM - MTD)',
  'Shop On Order PO Qty (CM)',
  '店舖回覆',
] as const;

export const ZERO_SALES_SHEET_HINT = 'Zero Sales';

export interface ZeroSalesParsedRow {
  rowNumber: number;
  siteCode: string;
  sku: string;
  /** 全部欄位原文，key 為 ZERO_SALES_COLUMNS */
  data: Record<string, string>;
}

export interface ZeroSalesParsed {
  ok: boolean;
  sheetName?: string;
  headers?: string[];
  totalRows: number;
  errors?: Array<{ row: number; field: string; reason: string; siteCode?: string }>;
  rows?: ZeroSalesParsedRow[];
  contentHash?: string;
}

function valueToText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return normalizeText(v as never);
  if (typeof v === 'object') {
    const c = v as { result?: unknown; text?: unknown; richText?: Array<{ text?: unknown }> };
    if ('result' in c) return valueToText(c.result);
    if (Array.isArray(c.richText)) return c.richText.map((p) => valueToText(p.text)).join('');
    if ('text' in c) return valueToText(c.text);
  }
  return '';
}

function cellText(cell: ExcelJS.Cell): string {
  return valueToText(cell.value);
}

export async function parseZeroSalesWorkbook(
  buffer: Buffer,
  storeCodes: Set<string>,
  maxRows: number,
): Promise<ZeroSalesParsed> {
  const contentHash = hashFileContent(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    return { ok: false, totalRows: 0, errors: [{ row: 0, field: 'file', reason: '無法讀取此檔案，請上載 .xlsx' }], contentHash };
  }
  // 接受第一個工作表 (Admin 原表可能有多種 sheet 名)，但必須包含表頭
  let sheet: ExcelJS.Worksheet | undefined;
  let headerRowNum = 0;
  outer: for (const ws of workbook.worksheets) {
    for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
      const row = ws.getRow(r);
      const vals: string[] = [];
      for (let c = 1; c <= ZERO_SALES_COLUMNS.length; c++) vals.push(cellText(row.getCell(c)));
      // 必須至少包含 Site Code + SKU + 店舖回覆
      if (vals[0] === 'Site Code' && vals[7] === 'SKU' && vals[vals.length - 1] === '店舖回覆') {
        sheet = ws;
        headerRowNum = r;
        break outer;
      }
    }
  }
  if (!sheet) {
    // fallback: 用第一個 sheet 並假設第1列為表頭
    sheet = workbook.worksheets[0];
    if (!sheet) {
      return { ok: false, totalRows: 0, errors: [{ row: 0, field: 'sheet', reason: '找不到工作表' }], contentHash };
    }
    headerRowNum = 1;
  }
  const headers: string[] = [];
  for (let c = 1; c <= ZERO_SALES_COLUMNS.length; c++) headers.push(cellText(sheet.getRow(headerRowNum).getCell(c)));

  const errors: ZeroSalesParsed['errors'] = [];
  const rows: ZeroSalesParsedRow[] = [];
  let totalRows = 0;
  const seen = new Set<string>();

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNum) return;
    let hasAny = false;
    for (let c = 1; c <= ZERO_SALES_COLUMNS.length; c++) {
      const v = row.getCell(c).value;
      if (v !== null && v !== undefined && String(v).trim() !== '') { hasAny = true; break; }
    }
    if (!hasAny) return;
    totalRows++;
    if (totalRows > maxRows) {
      errors!.push({ row: rowNumber, field: 'file', reason: `超出單次最多 ${maxRows} 行限制` });
      return;
    }
    const data: Record<string, string> = {};
    ZERO_SALES_COLUMNS.forEach((col, i) => { data[col] = cellText(row.getCell(i + 1)); });
    const siteCode = normalizeSiteCode(data['Site Code'] || '');
    const sku = normalizeText(data['SKU'] || '');
    if (!siteCode) errors!.push({ row: rowNumber, field: 'Site Code', reason: 'Site Code 為必填' });
    else if (storeCodes.size && !storeCodes.has(siteCode)) errors!.push({ row: rowNumber, field: 'Site Code', reason: `Site Code「${siteCode}」不存在於門店主檔`, siteCode });
    if (!sku) errors!.push({ row: rowNumber, field: 'SKU', reason: 'SKU 為必填' });
    const key = `${siteCode}|${sku}`;
    if (siteCode && sku) {
      if (seen.has(key)) errors!.push({ row: rowNumber, field: 'SKU', reason: '檔案內 Site Code + SKU 重複', siteCode });
      seen.add(key);
    }
    rows.push({ rowNumber, siteCode, sku, data });
  });

  // 嚴格表頭檢查：前22欄必須一致 (店舖回覆欄名必須為「店舖回覆」)
  const expected = [...ZERO_SALES_COLUMNS];
  const mismatch = expected.some((h, i) => headers[i] !== h);
  if (mismatch) {
    return {
      ok: false, sheetName: sheet.name, headers, totalRows,
      errors: [{ row: headerRowNum, field: 'header', reason: `欄名必須與模板一致，應為：${expected.join(' | ')}` }],
      contentHash,
    };
  }

  if (errors!.length) return { ok: false, sheetName: sheet.name, headers, totalRows, errors, contentHash };
  return { ok: true, sheetName: sheet.name, headers, totalRows, rows, contentHash };
}

/** 下載模板 (22欄上下文 + 空白店舖回覆欄) */
export async function generateZeroSalesTemplateWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Zero Sales');
  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: 'FF000000' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
    border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } },
  };
  ZERO_SALES_COLUMNS.forEach((name, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = name;
    cell.style = headerStyle;
  });
  // 最後一欄標示為店舖填寫 (橙色)
  const replyCell = sheet.getCell(1, ZERO_SALES_COLUMNS.length);
  replyCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4A6' } };
  sheet.columns = ZERO_SALES_COLUMNS.map(() => ({ width: 18 }));
  sheet.getColumn(8).width = 22;
  sheet.getColumn(9).width = 28;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export interface ZeroSalesExportItem {
  site_code: string;
  sku: string;
  payload: Record<string, string>;
  status: string;
  reason_code: string | null;
  reason_label: string | null;
  reason_note: string | null;
  replied_at: string | null;
  replied_by: string | null;
  batch_label: string;
  reply_count: number;
}

const UNCLASSIFIED_REASON = '（未分類）';

function replyReasonLabel(item: ZeroSalesExportItem): string {
  return item.reason_label || UNCLASSIFIED_REASON;
}

/** 數量欄解析：去除千分位，空白或非數字回傳 null（不計入加總） */
function parseQty(text: string | undefined): number | null {
  const t = (text ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Admin 匯出：Zero Sales 回覆 / 未回覆店舖 / SKU 原因統計；reasonLabels 決定原因欄的順序（含已停用原因） */
export async function buildZeroSalesExportBuffer(items: ZeroSalesExportItem[], reasonLabels: string[] = []): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Zero Sales 回覆');
  const headers = [...ZERO_SALES_COLUMNS.slice(0, 22), '店舖回覆 (原因)', '補充說明', '回覆狀態', '修改次數', '回覆時間', '回覆人'];
  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDAEEF3' } },
  };
  sheet.addRow(headers);
  headers.forEach((_, i) => { sheet.getCell(1, i + 1).style = headerStyle; });
  for (const it of items) {
    sheet.addRow([
      ...ZERO_SALES_COLUMNS.slice(0, 22).map((c) => it.payload?.[c] ?? (c === 'Site Code' ? it.site_code : c === 'SKU' ? it.sku : '')),
      it.reason_label ?? '',
      it.reason_note ?? '',
      it.status === 'replied' ? '已回覆' : '未回覆',
      it.reply_count ?? (it.status === 'replied' ? 1 : 0),
      it.replied_at ?? '',
      it.replied_by ?? '',
    ]);
  }
  sheet.columns = headers.map(() => ({ width: 18 }));

  const pendingSheet = workbook.addWorksheet('未回覆店舖');
  const pendingHeaders = ['Site Code', 'Shop Name', 'OM', '週次', '總 SKU 數', '已回覆', '未回覆', '未回覆 SKU', '店舖回覆 (原因)', '跟進備註'];
  pendingSheet.addRow(pendingHeaders);
  pendingHeaders.forEach((_, i) => { pendingSheet.getCell(1, i + 1).style = headerStyle; });
  const storeMap = new Map<string, { site_code: string; shop: string; om: string; week: string; total: number; replied: number; skus: string[]; reasons: Map<string, number> }>();
  for (const it of items) {
    const key = `${it.site_code}|${it.batch_label}`;
    let s = storeMap.get(key);
    if (!s) {
      s = { site_code: it.site_code, shop: it.payload?.['Shop Name'] ?? '', om: it.payload?.['OM'] ?? '', week: it.batch_label, total: 0, replied: 0, skus: [], reasons: new Map() };
      storeMap.set(key, s);
    }
    s.total++;
    if (it.status === 'replied') {
      s.replied++;
      const label = replyReasonLabel(it);
      s.reasons.set(label, (s.reasons.get(label) ?? 0) + 1);
    } else s.skus.push(it.sku);
  }
  const pendingStores = [...storeMap.values()]
    .filter((s) => s.skus.length > 0)
    .sort((a, b) => b.skus.length - a.skus.length || a.site_code.localeCompare(b.site_code));
  for (const s of pendingStores) {
    const reasonText = [...s.reasons].map(([label, n]) => `${label} (${n})`).join('；');
    pendingSheet.addRow([s.site_code, s.shop, s.om, s.week, s.total, s.replied, s.skus.length, s.skus.join(', '), reasonText, '']);
  }
  pendingSheet.columns = pendingHeaders.map(() => ({ width: 18 }));
  pendingSheet.getColumn(2).width = 28;
  pendingSheet.getColumn(8).width = 50;
  pendingSheet.getColumn(9).width = 40;

  buildSkuReasonSheet(workbook, items, reasonLabels, headerStyle);
  buildBuyerSheet(workbook, items, headerStyle);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 「主要原因 (首2位)」顯示格式：原因 (筆數)；多過一個以「；」分隔，同筆數按原因設定的先後次序 */
function formatTopReasons(counts: Map<string, number>): string {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label, n]) => `${label} (${n})`)
    .join('；');
}

interface SkuReasonStat {
  sku: string;
  brand: string;
  sku_desc: string;
  buyer: string;
  adj_mch1: string;
  item_status: string;
  supply_source: string;
  /** Shop Stock Qty (CM) 加總（重複 SKU 用總計）；全部空白則為 null */
  stock: number | null;
  replied: number;
  counts: Map<string, number>;
}

/** 工作表「店舖回覆 (原因)」：樞紐式版面（第3列為群組標題、第4列為欄名、第5列起為資料）；每 SKU 一行（重複 SKU 庫存加總），只列有回覆的 SKU，按各回覆原因計數，末行為合計 */
function buildSkuReasonSheet(
  workbook: ExcelJS.Workbook,
  items: ZeroSalesExportItem[],
  reasonLabels: string[],
  headerStyle: Partial<ExcelJS.Style>,
): void {
  const reasonCols = [...new Set(reasonLabels)];
  for (const it of items) {
    if (it.status !== 'replied') continue;
    const label = replyReasonLabel(it);
    if (!reasonCols.includes(label)) reasonCols.push(label);
  }

  const skuMap = new Map<string, SkuReasonStat>();
  for (const it of items) {
    const p = it.payload ?? {};
    let s = skuMap.get(it.sku);
    if (!s) {
      s = { sku: it.sku, brand: '', sku_desc: '', buyer: '', adj_mch1: '', item_status: '', supply_source: '', stock: null, replied: 0, counts: new Map() };
      skuMap.set(it.sku, s);
    }
    s.brand = s.brand || (p['Brand'] ?? '');
    s.sku_desc = s.sku_desc || (p['SKU Desc'] ?? '');
    s.buyer = s.buyer || (p['Buyer'] ?? '');
    s.adj_mch1 = s.adj_mch1 || (p['Adj. MCH1'] ?? '');
    s.item_status = s.item_status || (p['Item Status'] ?? '');
    s.supply_source = s.supply_source || (p['Supply Source'] ?? '');
    const qty = parseQty(p['Shop Stock Qty (CM)']);
    if (qty !== null) s.stock = (s.stock ?? 0) + qty;
    if (it.status === 'replied') {
      s.replied++;
      const label = replyReasonLabel(it);
      s.counts.set(label, (s.counts.get(label) ?? 0) + 1);
    }
  }
  const skuStats = [...skuMap.values()]
    .filter((s) => s.replied > 0)
    .sort((a, b) => a.sku.localeCompare(b.sku));

  const HEADER_ROW = 4;
  const FIRST_DATA_ROW = 5;
  const headers = ['SKU', 'Brand', 'SKU Desc', 'Buyer', 'Adj. MCH1', 'Item Status', 'Supply Source', 'Shop Stock Qty (CM)(總計)', ...reasonCols, '總計'];
  const groupStart = 9;
  const groupEnd = headers.length;
  const sheet = workbook.addWorksheet('店舖回覆 (原因)');

  sheet.getCell(3, 1).value = '計數 - Site Code';
  if (reasonCols.length) {
    sheet.mergeCells(3, groupStart, 3, groupEnd);
    sheet.getCell(3, groupStart).value = '店舖回覆 (原因)';
  }
  const centerStyle: Partial<ExcelJS.Style> = { ...headerStyle, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } };
  for (let c = 1; c <= groupEnd; c++) sheet.getCell(3, c).style = centerStyle;
  headers.forEach((h, i) => {
    const cell = sheet.getCell(HEADER_ROW, i + 1);
    cell.value = h;
    cell.style = centerStyle;
  });
  sheet.getRow(HEADER_ROW).height = 45;

  skuStats.forEach((s, idx) => {
    const values: Array<string | number> = [
      s.sku, s.brand, s.sku_desc, s.buyer, s.adj_mch1, s.item_status, s.supply_source, s.stock ?? '',
      ...reasonCols.map((label) => s.counts.get(label) ?? 0),
      s.replied,
    ];
    values.forEach((v, i) => { sheet.getCell(FIRST_DATA_ROW + idx, i + 1).value = v; });
  });

  const sumOf = (pick: (s: SkuReasonStat) => number): number => skuStats.reduce((acc, s) => acc + pick(s), 0);
  const totalRowNum = FIRST_DATA_ROW + skuStats.length;
  const totalValues: Array<string | number> = [
    '合計', '', '', '', '', '', '', sumOf((s) => s.stock ?? 0),
    ...reasonCols.map((label) => sumOf((s) => s.counts.get(label) ?? 0)),
    sumOf((s) => s.replied),
  ];
  totalValues.forEach((v, i) => {
    const cell = sheet.getCell(totalRowNum, i + 1);
    cell.value = v;
    cell.font = { bold: true };
  });

  const widths = [16, 26, 44, 20, 26, 13, 14, 18, ...reasonCols.map(() => 16), 10];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
}

interface BuyerStat {
  buyer: string;
  /** 該 Buyer 的 Zero Sales 不重複 SKU 數 */
  skus: number;
  /** 該 Buyer 的 Shop Stock Qty (CM) 總計 */
  stock: number;
  /** 回覆原因計數（只計已回覆） */
  counts: Map<string, number>;
}

/**
 * 工作表「Buyer 統計」：每 Buyer 一列，統計 Zero Sales 不重複 SKU 數（含未回覆）、Shop Stock Qty (CM)（重複 SKU 加總），
 * 以及最高 2 位的回覆原因（只計已回覆）；版面與其他統計表一致（第3列群組標題、第4列欄名、第5列起資料），末行為合計。
 * 未設定 Buyer 的行歸入「（未設定）」。
 */
function buildBuyerSheet(
  workbook: ExcelJS.Workbook,
  items: ZeroSalesExportItem[],
  headerStyle: Partial<ExcelJS.Style>,
): void {
  const byBuyer = new Map<string, BuyerStat & { skuSet: Set<string> }>();
  for (const it of items) {
    const buyer = (it.payload?.['Buyer'] ?? '') || '（未設定）';
    let b = byBuyer.get(buyer);
    if (!b) {
      b = { buyer, skus: 0, stock: 0, counts: new Map(), skuSet: new Set() };
      byBuyer.set(buyer, b);
    }
    b.skuSet.add(it.sku);
    const qty = parseQty(it.payload?.['Shop Stock Qty (CM)']);
    if (qty !== null) b.stock += qty;
    if (it.status === 'replied') {
      const label = replyReasonLabel(it);
      b.counts.set(label, (b.counts.get(label) ?? 0) + 1);
    }
  }
  const buyerStats = [...byBuyer.values()]
    .map(({ skuSet, ...b }) => ({ ...b, skus: skuSet.size }))
    .sort((a, b) => b.skus - a.skus || b.stock - a.stock || a.buyer.localeCompare(b.buyer));

  // 合計的 SKU 數為全表不重複 SKU（同一 SKU 可能出現在多個 Buyer，不能直接加總每列）
  const totalSkus = new Set(items.map((it) => it.sku)).size;
  const totalStock = buyerStats.reduce((acc, b) => acc + b.stock, 0);
  const totalCounts = new Map<string, number>();
  for (const b of buyerStats) {
    for (const [label, n] of b.counts) totalCounts.set(label, (totalCounts.get(label) ?? 0) + n);
  }
  const HEADER_ROW = 4;
  const FIRST_DATA_ROW = 5;
  const headers = ['Buyer', 'SKU 數', 'Shop Stock Qty (CM)(總計)', '主要原因 (首2位)'];
  const sheet = workbook.addWorksheet('Buyer 統計');
  sheet.getCell(3, 1).value = '店舖回覆 (原因)';
  const centerStyle: Partial<ExcelJS.Style> = { ...headerStyle, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } };
  for (let c = 1; c <= headers.length; c++) sheet.getCell(3, c).style = centerStyle;
  headers.forEach((h, i) => {
    const cell = sheet.getCell(HEADER_ROW, i + 1);
    cell.value = h;
    cell.style = centerStyle;
  });
  buyerStats.forEach((b, idx) => {
    const values: Array<string | number> = [b.buyer, b.skus, b.stock, formatTopReasons(b.counts)];
    values.forEach((v, i) => { sheet.getCell(FIRST_DATA_ROW + idx, i + 1).value = v; });
  });
  const totalValues: Array<string | number> = ['合計', totalSkus, totalStock, formatTopReasons(totalCounts)];
  totalValues.forEach((v, i) => {
    const cell = sheet.getCell(FIRST_DATA_ROW + buyerStats.length, i + 1);
    cell.value = v;
    cell.font = { bold: true };
  });
  const widths = [26, 10, 24, 52];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
}
