import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { normalizeText } from './fields.js';
import { normalizeSiteCode } from '../services/stores.js';
import { hashFileContent } from './excelImport.js';

/**
 * 「By Shop」I14 庫存報表解析器。
 *
 * 上游匯出工具產生的檔案並非嚴格 OOXML（實測 By Shop_25Oct2026.xlsx）：
 *   1. 所有 XML part 的元素都帶 `x:` 命名空間前綴（`<x:worksheet>`、`<x:row>`…）
 *   2. `<row>` / `<c>` 完全沒有 `r` 座標屬性，ExcelJS 會把每格都放到 A 欄
 *   3. 空白行寫成自閉合 `<x:row />`
 * 因此 ExcelJS 直接 `load()` 會失敗（或得到錯位資料）。策略：先試直接讀，
 * 失敗 / 找不到表頭才用 jszip 把 XML 正規化後重新打包再交給 ExcelJS。
 *
 * 資料清洗順序（不可調換）：
 *   ① 剔除 Column A = `Total` 的整列（匯出工具自帶全公司合計，Site Code 會撞真店 HA02）
 *   ② 跳過全空白列
 *   ③ 跳過頁腳列（`Applied filters: …`；判定 = 沒有 Site Code／只有 A 欄有內容）
 *   ④ 最後才做 Site Code 重複檢查
 */

/** 報表完整 36 欄（依原檔次序）。僅作參考與 payload 文件化，實際以表頭文字映射。 */
export const SHOP_STOCK_COLUMNS = [
  'Shop',
  'Site Code',
  'Site Chin Desc',
  'OM',
  'Shop Nature',
  'Shop Type',
  'No. of SKU Carry',
  'No. of RF SKU',
  'No. of ND SKU with Stock',
  'No. of OOS SKU',
  'No. of OOS SKU with replenish',
  'No. of OOS SKU w/o replenish',
  'No. of Potential OOS SKU',
  'No. of Potential OOS SKU with replenish',
  'No. of Potential OOS SKU w/o replenish',
  'No. of Overstock SKU',
  'No. of Overstock SKU (P90D 0 Sales)',
  'No. of Overstock SKU (>2*Monthly Sold Qty & >2pcs)',
  'Excess Stock Qty (P90D 0 Sales)',
  'Excess Stock Qty (>2*Monthly Sold Qty & >2pcs)',
  'Excess Stock Qty',
  'Excess Stock Value (P90D 0 Sales)',
  'Excess Stock Value (>2*Monthly Sold Qty & >2pcs)',
  'Excess Stock Value',
  'Shop Stock Qty (CM)',
  'Shop Stock Value (CM)',
  'Shop Turnday (90D COGS)',
  'Sold Qty (P90D)',
  'Sold Qty (M-2)',
  'Sold Qty (M-1)',
  'Sold Qty (CM - MTD)',
  'Net Sales (P90D)',
  'Net Sales (M-2)',
  'Net Sales (M-1)',
  'Net Sales (CM - MTD)',
  'P90D Daily COGS',
] as const;

/** 文字欄（表頭原文 → 欄位） */
const TEXT_FIELDS = {
  shop: 'Shop',
  siteCode: 'Site Code',
  om: 'OM',
  shopNature: 'Shop Nature',
  shopType: 'Shop Type',
} as const;

/** 數值欄（表頭原文 → 欄位）；空值一律 NULL，不寫 0 */
const NUMBER_FIELDS = {
  skuCount0sale: 'No. of Overstock SKU (P90D 0 Sales)',
  skuCountOver2: 'No. of Overstock SKU (>2*Monthly Sold Qty & >2pcs)',
  excessQty0sale: 'Excess Stock Qty (P90D 0 Sales)',
  excessQtyOver2: 'Excess Stock Qty (>2*Monthly Sold Qty & >2pcs)',
  excessValue0sale: 'Excess Stock Value (P90D 0 Sales)',
  excessValueOver2: 'Excess Stock Value (>2*Monthly Sold Qty & >2pcs)',
  excessValueTotal: 'Excess Stock Value',
  shopStockQtyCm: 'Shop Stock Qty (CM)',
  shopStockValueCm: 'Shop Stock Value (CM)',
  soldQtyP90d: 'Sold Qty (P90D)',
  netSalesP90d: 'Net Sales (P90D)',
} as const;

/** 缺任何一欄都算表格不正確 —— 逐欄列出，方便 admin 對照上游格式是否改版 */
const REQUIRED_HEADERS: readonly string[] = [
  ...Object.values(TEXT_FIELDS),
  ...Object.values(NUMBER_FIELDS),
];

/** 全公司合計列的 Column A 標記 */
const TOTAL_ROW_LABEL = 'total';

/** 解壓後總量上限（防 zip bomb；正常檔案 < 1MB） */
const MAX_UNZIPPED_BYTES = 20 * 1024 * 1024;

/** 表頭列最多往下找幾列 */
const HEADER_SCAN_ROWS = 10;

const MAX_WARNINGS = 20;

export interface ShopStockParsedRow {
  siteCode: string;
  shop: string;
  om: string;
  shopNature: string;
  shopType: string;
  /** 原檔行號（1-based，Excel 列號） */
  sourceRow: number;
  skuCount0sale: number | null;
  skuCountOver2: number | null;
  excessQty0sale: number | null;
  excessQtyOver2: number | null;
  excessValue0sale: number | null;
  excessValueOver2: number | null;
  excessValueTotal: number | null;
  shopStockQtyCm: number | null;
  shopStockValueCm: number | null;
  soldQtyP90d: number | null;
  netSalesP90d: number | null;
  /** 36 欄原文（表頭文字 → 文字值），供日後加欄位／追溯 */
  payload: Record<string, string>;
}

export interface ShopStockParseError {
  row: number;
  field: string;
  reason: string;
  siteCode?: string;
}

export interface ShopStockParseSkipped {
  total: number;
  blank: number;
  footer: number;
}

export interface ShopStockParsed {
  ok: boolean;
  sheetName?: string;
  /** 表頭原文（依原檔次序） */
  headers?: string[];
  rows?: ShopStockParsedRow[];
  /** 已接受的資料列數 */
  totalRows: number;
  /** 表頭以下掃描過的列數（含被剔除的列） */
  sourceRows: number;
  skipped: ShopStockParseSkipped;
  warnings: string[];
  errors?: ShopStockParseError[];
  contentHash: string;
}

function valueToText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return normalizeText(v as never);
  }
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

/**
 * 表頭文字正規化：NFKC（全形 → 半形）＋ 壓縮空白 ＋ 小寫 ＋ `×` → `*`。
 * 上游用半形 `*` / `&`，但 Excel 人手改過可能變全形，這裡兩種都吃得下。
 */
function headerKey(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/×/g, '*')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 千分位逗號 → 數字；空字串 / 非數字 → null（絕不寫 0） */
function parseNumberText(text: string): number | null {
  const t = text.replace(/,/g, '').replace(/\s+/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function colLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCharCode(65 + m) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 去掉所有 `prefix:` 元素前綴，`xmlns:x=` 改寫成 `xmlns=` */
function stripElementPrefix(xml: string): string {
  return xml
    .replace(/<\/([A-Za-z_][\w.-]*):/g, '</')
    .replace(/<([A-Za-z_][\w.-]*):/g, '<')
    .replace(/\sxmlns:x=/g, ' xmlns=');
}

/**
 * 為沒有座標的 `<row>` / `<c>` 補 `r="N"` / `r="A1"`。
 * 必須處理自閉合 `<row/>`（空白行，仍要佔一個列號）與 `<c/>`（空值格）。
 * 只作用於 sheet part（其他 part 不會有 row/c）。
 */
function addCellRefs(xml: string): string {
  let rowNo = 0;
  let colNo = 0;
  return xml.replace(
    /<(row|c)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g,
    (match, tag: string, attrs: string, selfClose: string) => {
      if (tag === 'row') {
        colNo = 0;
        const existingRow = /\br="(\d+)"/.exec(attrs);
        if (existingRow) {
          rowNo = Number(existingRow[1]);
          return match;
        }
        rowNo += 1;
        return `<row r="${rowNo}"${attrs}${selfClose}>`;
      }
      colNo += 1;
      const existingCell = /\br="([A-Za-z]{1,3})\d*"/.exec(attrs);
      if (existingCell) {
        return `<c r="${existingCell[1]}${rowNo}"${attrs}${selfClose}>`;
      }
      return `<c r="${colLetter(colNo)}${rowNo}"${attrs}${selfClose}>`;
    },
  );
}

/** 直接讀（標準 xlsx）。非標準檔會在 ExcelJS 內部拋錯，交由呼叫者 fallback。 */
async function loadDirect(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  return workbook;
}

/**
 * 正規化後再讀：jszip 逐 part 去掉 `x:` 前綴，sheet part 補上 row/cell 座標，
 * 重新打包成合法 xlsx 交給 ExcelJS。解壓總量超過 20MB 直接拒絕。
 */
async function loadNormalized(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const zip = await JSZip.loadAsync(buffer);
  const out = new JSZip();
  let unzipped = 0;
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    const raw = await entry.async('uint8array');
    unzipped += raw.byteLength;
    if (unzipped > MAX_UNZIPPED_BYTES) {
      throw new Error(`解壓後檔案超過 ${MAX_UNZIPPED_BYTES / 1024 / 1024}MB 限制`);
    }
    if (!/\.(xml|rels)$/i.test(name)) {
      out.file(name, raw);
      continue;
    }
    const text = Buffer.from(raw).toString('utf8');
    const converted = stripElementPrefix(text);
    out.file(name, /\/worksheets\//i.test(name) ? addCellRefs(converted) : converted);
  }
  const rebuilt = await out.generateAsync({ type: 'nodebuffer' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(rebuilt as never);
  return workbook;
}

interface LocatedHeader {
  sheet: ExcelJS.Worksheet;
  headerRow: number;
  /** headerKey → 1-based 欄號 */
  columns: Map<string, number>;
  headers: string[];
}

/** 找表頭列：任一工作表前 10 列中同時有 Site Code + Shop Stock Value (CM) + 0 Sales 不良存貨值 */
function locateHeader(workbook: ExcelJS.Workbook): LocatedHeader | null {
  const needed = [
    headerKey(TEXT_FIELDS.siteCode),
    headerKey(NUMBER_FIELDS.shopStockValueCm),
    headerKey(NUMBER_FIELDS.excessValue0sale),
  ];
  for (const sheet of workbook.worksheets) {
    const maxRow = Math.min(HEADER_SCAN_ROWS, sheet.rowCount || 0);
    for (let r = 1; r <= maxRow; r += 1) {
      const row = sheet.getRow(r);
      const columns = new Map<string, number>();
      const headers: string[] = [];
      const colCount = Math.max(row.cellCount, sheet.columnCount || 0);
      for (let c = 1; c <= colCount; c += 1) {
        const text = cellText(row.getCell(c));
        headers.push(text);
        if (!text) continue;
        const key = headerKey(text);
        if (!columns.has(key)) columns.set(key, c);
      }
      if (needed.every((k) => columns.has(k))) {
        return { sheet, headerRow: r, columns, headers };
      }
    }
  }
  return null;
}

export async function parseShopStockWorkbook(
  buffer: Buffer,
  maxRows: number,
): Promise<ShopStockParsed> {
  const contentHash = hashFileContent(buffer);
  const empty: ShopStockParsed = {
    ok: false,
    totalRows: 0,
    sourceRows: 0,
    skipped: { total: 0, blank: 0, footer: 0 },
    warnings: [],
    contentHash,
  };

  // 兩條路徑：標準 xlsx（直接讀）→ 非標準（jszip 正規化後讀）
  for (const loader of [loadDirect, loadNormalized]) {
    let workbook: ExcelJS.Workbook;
    try {
      workbook = await loader(buffer);
    } catch {
      continue;
    }
    const located = locateHeader(workbook);
    if (!located) {
      if (loader === loadDirect) continue;
      return {
        ...empty,
        errors: [
          {
            row: 0,
            field: 'header',
            reason: '找不到表頭列：需包含 Site Code、Excess Stock Value (P90D 0 Sales)、Shop Stock Value (CM)',
          },
        ],
      };
    }
    return parseLocatedSheet(located, maxRows, contentHash);
  }

  return {
    ...empty,
    errors: [{ row: 0, field: 'file', reason: '無法讀取此檔案，請上載 .xlsx' }],
  };
}

function parseLocatedSheet(
  located: LocatedHeader,
  maxRows: number,
  contentHash: string,
): ShopStockParsed {
  const { sheet, headerRow, columns, headers } = located;
  const skipped: ShopStockParseSkipped = { total: 0, blank: 0, footer: 0 };
  const warnings: string[] = [];
  const errors: ShopStockParseError[] = [];

  const missing = REQUIRED_HEADERS.filter((h) => !columns.has(headerKey(h)));
  if (missing.length) {
    return {
      ok: false,
      sheetName: sheet.name,
      headers,
      totalRows: 0,
      sourceRows: 0,
      skipped,
      warnings,
      errors: [{
        row: headerRow,
        field: 'header',
        reason: `缺少必要欄位：${missing.join(' ／ ')}`,
      }],
      contentHash,
    };
  }

  const shopColumn = columns.get(headerKey(TEXT_FIELDS.shop))!;
  const siteColumn = columns.get(headerKey(TEXT_FIELDS.siteCode))!;
  const headerColCount = headers.length;
  const fieldColumns = new Map<string, number>();
  for (const [field, label] of Object.entries(TEXT_FIELDS)) fieldColumns.set(field, columns.get(headerKey(label))!);
  for (const [field, label] of Object.entries(NUMBER_FIELDS)) fieldColumns.set(field, columns.get(headerKey(label))!);

  const rows: ShopStockParsedRow[] = [];
  const seen = new Map<string, number[]>();
  /** 頁腳列若出現在資料列之間，代表格式走位，必須報錯而非靜默丟資料 */
  const footerRows: number[] = [];
  let lastDataRow = 0;
  let sourceRows = 0;
  const rowCount = sheet.rowCount || 0;

  for (let r = headerRow + 1; r <= rowCount; r += 1) {
    const row = sheet.getRow(r);
    sourceRows += 1;

    const texts: string[] = [];
    for (let c = 1; c <= headerColCount; c += 1) texts.push(cellText(row.getCell(c)));

    const nonEmpty = texts.filter((t) => t !== '').length;
    if (nonEmpty === 0) {
      skipped.blank += 1;
      continue;
    }

    // ① 匯出工具的全公司合計列（Column A = Total，實測該欄就是 Shop 欄）。
    // 必須先剔除：它的 Site Code 是 HA02，會與真店撞號，亦會令總數 ×2。
    // 兩個位置都檢查，上游改欄序時仍然擋得住。
    const columnA = headerKey(texts[0] ?? '');
    const shopCell = headerKey(texts[shopColumn - 1] ?? '');
    if (columnA === TOTAL_ROW_LABEL || shopCell === TOTAL_ROW_LABEL) {
      skipped.total += 1;
      continue;
    }

    const siteCodeRaw = cellText(row.getCell(siteColumn));
    const siteCode = normalizeSiteCode(siteCodeRaw);

    // ③ 頁腳列（`Applied filters: …`）：沒有 Site Code，或內容只出現在 A 欄，
    //    或 XML 內定義的 cell 數少於表頭欄數且沒有店號 → 不可能是有意義的資料列。
    if (!siteCode) {
      const cellsDefined = row.cellCount;
      const onlyColumnA = texts.slice(1).every((t) => t === '');
      if (onlyColumnA || cellsDefined < headerColCount) {
        skipped.footer += 1;
        footerRows.push(r);
        continue;
      }
      errors.push({ row: r, field: TEXT_FIELDS.siteCode, reason: 'Site Code 為必填' });
      continue;
    }

    if (rows.length >= maxRows) {
      errors.push({ row: r, field: 'file', reason: `超出單次最多 ${maxRows} 行限制` });
      break;
    }

    const numeric: Record<string, number | null> = {};
    for (const [field, label] of Object.entries(NUMBER_FIELDS)) {
      const raw = texts[(fieldColumns.get(field) ?? 1) - 1] ?? '';
      const parsed = parseNumberText(raw);
      numeric[field] = parsed;
      if (raw !== '' && parsed === null && warnings.length < MAX_WARNINGS) {
        warnings.push(`第 ${r} 列「${label}」不是數字（${raw}），已視為空白`);
      }
    }

    const payload: Record<string, string> = {};
    headers.forEach((header, i) => {
      const key = header || `Column ${i + 1}`;
      if (!(key in payload)) payload[key] = texts[i] ?? '';
    });
    const rowSkippedNumeric = Object.values(numeric).every((v) => v === null);
    if (rowSkippedNumeric && warnings.length < MAX_WARNINGS) {
      warnings.push(`第 ${r} 列（${siteCode}）所有統計數值為空白`);
    }

    rows.push({
      siteCode,
      shop: normalizeText(cellText(row.getCell(shopColumn))),
      om: normalizeText(cellText(row.getCell(fieldColumns.get('om')!))),
      shopNature: normalizeText(cellText(row.getCell(fieldColumns.get('shopNature')!))),
      shopType: normalizeText(cellText(row.getCell(fieldColumns.get('shopType')!))),
      sourceRow: r,
      skuCount0sale: numeric.skuCount0sale ?? null,
      skuCountOver2: numeric.skuCountOver2 ?? null,
      excessQty0sale: numeric.excessQty0sale ?? null,
      excessQtyOver2: numeric.excessQtyOver2 ?? null,
      excessValue0sale: numeric.excessValue0sale ?? null,
      excessValueOver2: numeric.excessValueOver2 ?? null,
      excessValueTotal: numeric.excessValueTotal ?? null,
      shopStockQtyCm: numeric.shopStockQtyCm ?? null,
      shopStockValueCm: numeric.shopStockValueCm ?? null,
      soldQtyP90d: numeric.soldQtyP90d ?? null,
      netSalesP90d: numeric.netSalesP90d ?? null,
      payload,
    });
    lastDataRow = r;
    const prev = seen.get(siteCode);
    if (prev) prev.push(r);
    else seen.set(siteCode, [r]);
  }

  if (footerRows.length && footerRows.some((r) => r < lastDataRow)) {
    const firstBad = footerRows.find((r) => r < lastDataRow)!;
    errors.push({
      row: firstBad,
      field: 'row',
      reason: '頁腳列出現在資料列之間，檔案格式不正確（可能被插入空白／說明列）',
    });
  }

  // ④ 重複店號檢查放最後：Total 列剔除後，HA02 等撞號應自然消失
  for (const [siteCode, rowNumbers] of seen) {
    if (rowNumbers.length > 1) {
      errors.push({
        row: rowNumbers[1]!,
        field: TEXT_FIELDS.siteCode,
        reason: `Site Code「${siteCode}」在檔案內重複（行 ${rowNumbers.join('、')}）`,
        siteCode,
      });
    }
  }

  if (!rows.length && !errors.length) {
    errors.push({ row: headerRow, field: 'row', reason: '檔案沒有資料列' });
  }

  const result: ShopStockParsed = {
    ok: errors.length === 0,
    sheetName: sheet.name,
    headers,
    totalRows: rows.length,
    sourceRows,
    skipped,
    warnings,
    contentHash,
  };
  if (errors.length) result.errors = errors;
  else result.rows = rows;
  return result;
}
