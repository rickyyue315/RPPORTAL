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

/** Admin 匯出：原22欄 + 回覆原因 + 補充 + 狀態 + 修改次數 */
export async function buildZeroSalesExportBuffer(items: ZeroSalesExportItem[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Zero Sales 回覆');
  const headers = [...ZERO_SALES_COLUMNS.slice(0, 22), '店舖回覆 (原因)', '補充說明', '回覆狀態', '修改次數', '回覆時間', '回覆人'];
  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
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
  const pendingHeaders = ['Site Code', 'Shop Name', 'OM', '週次', '總 SKU 數', '已回覆', '未回覆', '未回覆 SKU', '跟進備註'];
  pendingSheet.addRow(pendingHeaders);
  pendingHeaders.forEach((_, i) => { pendingSheet.getCell(1, i + 1).style = headerStyle; });
  const storeMap = new Map<string, { site_code: string; shop: string; om: string; week: string; total: number; replied: number; skus: string[] }>();
  for (const it of items) {
    const key = `${it.site_code}|${it.batch_label}`;
    let s = storeMap.get(key);
    if (!s) {
      s = { site_code: it.site_code, shop: it.payload?.['Shop Name'] ?? '', om: it.payload?.['OM'] ?? '', week: it.batch_label, total: 0, replied: 0, skus: [] };
      storeMap.set(key, s);
    }
    s.total++;
    if (it.status === 'replied') s.replied++;
    else s.skus.push(it.sku);
  }
  const pendingStores = [...storeMap.values()]
    .filter((s) => s.skus.length > 0)
    .sort((a, b) => b.skus.length - a.skus.length || a.site_code.localeCompare(b.site_code));
  for (const s of pendingStores) {
    pendingSheet.addRow([s.site_code, s.shop, s.om, s.week, s.total, s.replied, s.skus.length, s.skus.join(', '), '']);
  }
  pendingSheet.columns = pendingHeaders.map(() => ({ width: 18 }));
  pendingSheet.getColumn(2).width = 28;
  pendingSheet.getColumn(8).width = 50;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
