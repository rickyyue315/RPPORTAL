import ExcelJS from 'exceljs';
import { hashFileContent } from './excelImport.js';
import { normalizeText } from './fields.js';

/**
 * 指定 SKU 回覆 — Excel 解析 / 模板 / 匯出
 *
 * 上載檔（例：107668017004 DRG.xlsx）欄位：
 *   Product Hierarchy | Article | Article Long Text (60 Chars) | Site |
 *   SaSa Net Stock | 店舖回覆可調撥件數 | 貨品年期 (MMYY)
 *
 * 最後兩欄是店舖填寫用的（上載時通常空白），系統只讀前五欄；
 * 但會把整列原文存入 payload，方便日後加欄位追溯。
 */

export const DESIGNATED_SKU_COLUMNS = [
  'Product Hierarchy',
  'Article',
  'Article Long Text (60 Chars)',
  'Site',
  'SaSa Net Stock',
  '店舖回覆可調撥件數',
  '貨品年期 (MMYY)',
] as const;

/** 回覆欄位上限（批次層級硬限；Excel 匯入、後台編輯、前端顯示共用同一個數） */
export const DESIGNATED_SKU_MAX_REPLY_FIELDS = 10;
/** 回覆文字欄上限 */
export const DESIGNATED_SKU_REPLY_TEXT_MAX = 300;

/**
 * 「每間店一套」模式的佔位 SKU。
 * 真實 SaSa Article 為 9–12 位數字，不會撞上單一個 0；
 * 店舖端不會顯示此編號，匯出時 SKU 欄留空。
 */
export const DESIGNATED_SKU_PLACEHOLDER_SKU = '0';

export type DesignatedSkuReplyFieldType = 'text' | 'number' | 'choice';
export type DesignatedSkuReplyMode = 'stock_year' | 'custom' | 'mixed';
export type DesignatedSkuReplyScope = 'item' | 'matter';

export interface DesignatedSkuReplyField {
  /** 穩定識別（f1…f10）；改名不改 key，已收回覆不會失去對應 */
  key: string;
  /** 店舖見到的欄位標題 */
  label: string;
  type: DesignatedSkuReplyFieldType;
  required: boolean;
  hint?: string;
  /** type = choice 時可選值 */
  options?: string[];
}

const FIELD_KEY_PATTERN = /^f\d{1,2}$/;

/** 欄位類型推斷：只認明顯的數量字眼，其餘一律文字（不猜） */
export function inferReplyFieldType(label: string): DesignatedSkuReplyFieldType {
  return /(多少|幾多|數量|件數|行數|數目|qty|quantity|count|number)/i.test(label) ? 'number' : 'text';
}

/**
 * 清洗欄位定義：最多 10 個、key 唯一、label 去空白。
 * 接受 DB 回來的 JSONB（可能是字串）或 API 傳來的陣列。
 */
export function normalizeReplyFields(raw: unknown): DesignatedSkuReplyField[] {
  let list: unknown = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const out: DesignatedSkuReplyField[] = [];
  const usedKeys = new Set<string>();
  for (const entry of list.slice(0, DESIGNATED_SKU_MAX_REPLY_FIELDS)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const label = String(item.label ?? '').trim().slice(0, 80);
    if (!label) continue;
    let key = String(item.key ?? '').trim();
    if (!FIELD_KEY_PATTERN.test(key) || usedKeys.has(key)) {
      let n = 1;
      while (usedKeys.has(`f${n}`)) n += 1;
      key = `f${n}`;
    }
    usedKeys.add(key);
    const type = item.type === 'number' || item.type === 'choice' ? item.type : 'text';
    const required = item.required === true;
    const hint = String(item.hint ?? '').trim().slice(0, 120);
    const options = Array.isArray(item.options)
      ? item.options.map((o) => String(o ?? '').trim().slice(0, 40)).filter(Boolean).slice(0, 12)
      : [];
    out.push({
      key,
      label,
      type,
      required,
      ...(hint ? { hint } : {}),
      ...(type === 'choice' ? { options: options.length ? options : ['是', '否'] } : {}),
    });
  }
  return out;
}

/**
 * 填入值驗證：只保留有定義的欄位，空字串一律當「未填」（不寫入）。
 * 回傳正規化後的物件；有必填未填或格式錯誤時 throw 帶欄名的人話錯誤。
 */
export function normalizeReplyValues(
  raw: unknown,
  fields: DesignatedSkuReplyField[],
  subject: string,
): Record<string, string> {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = input[field.key];
    const text = value === null || value === undefined ? '' : String(value).trim();
    if (!text) {
      if (field.required) throw new Error(`${subject}：「${field.label}」為必填`);
      continue;
    }
    if (field.type === 'number') {
      if (!/^\d+(\.\d{1,2})?$/.test(text)) {
        throw new Error(`${subject}：「${field.label}」必須為數字（不接受負數或文字）`);
      }
    } else if (field.type === 'choice') {
      const options = field.options && field.options.length ? field.options : ['是', '否'];
      if (!options.includes(text)) {
        throw new Error(`${subject}：「${field.label}」只可選擇 ${options.join('／')}`);
      }
    } else if (text.length > DESIGNATED_SKU_REPLY_TEXT_MAX) {
      throw new Error(`${subject}：「${field.label}」不可超過 ${DESIGNATED_SKU_REPLY_TEXT_MAX} 字`);
    }
    out[field.key] = text;
  }
  return out;
}

/** 欄名比對用的正規化：去空白、去括號、轉小寫 */
function normalizeHeader(raw: string): string {
  return String(raw ?? '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[（）()]/g, '')
    .toLowerCase();
}

const HEADER_ALIASES: Record<string, string[]> = {
  hierarchy: ['producthierarchy', 'brand', 'producttype', '產品分類'],
  sku: ['article', 'sku', 'articleno', 'articlenumber', '貨品編號'],
  description: [
    'articlelongtext60chars',
    'articlelongtext',
    'skudesc',
    'description',
    '貨品描述',
    '描述',
  ],
  site: ['site', 'sitecode', 'shop', 'shopcode', '店舖', '店舖編號'],
  stock: [
    'sasanetstock',
    'shopstockqtycm',
    'storestock',
    'stock',
    'netstock',
    '存貨',
    '店內存貨',
  ],
};

const HEADER_FIELDS = Object.keys(HEADER_ALIASES) as Array<keyof typeof HEADER_ALIASES>;

function detectField(header: string): string | null {
  const h = normalizeHeader(header);
  if (!h) return null;
  for (const field of HEADER_FIELDS) {
    if (HEADER_ALIASES[field]!.includes(h)) return field;
  }
  // 容錯：欄名含關鍵字（例如「SaSa Net Stock (CM)」）
  if (h.includes('site') && !h.includes('website')) return 'site';
  if (h.includes('sasanetstock') || h.includes('shopstockqty')) return 'stock';
  if (h.includes('articlelongtext') || h.includes('skudesc')) return 'description';
  if (h === 'article' || (h.startsWith('article') && !h.includes('long'))) return 'sku';
  return null;
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

export function normalizeSiteCode(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase();
}

/** 原檔的合計／頁腳列，不應入庫 */
const TOTAL_SITE_CODES = new Set(['TOTAL', 'SHOPTOTAL', 'SHOP=TOTAL', '合計', '總計']);

/**
 * 貨品年期正規化：只接受 4 位數字 MMYY（月份 01–12）。
 * 亦接受 08/27、08-27、8/27 等寫法；其他一律回 null（不猜測）。
 */
export function normalizeYearCode(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const compact = text.replace(/[\s/\-.]/g, '');
  if (!/^\d{1,4}$/.test(compact)) return null;
  let mm: string;
  let yy: string;
  if (compact.length === 4) {
    mm = compact.slice(0, 2);
    yy = compact.slice(2);
  } else if (compact.length === 3) {
    // 827 = 8 月 + 27 年
    mm = `0${compact.slice(0, 1)}`;
    yy = compact.slice(1);
  } else {
    // 只有 2 位無法判斷是月份還是年份，交由店舖補齊
    return null;
  }
  const month = Number(mm);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return `${mm}${yy}`;
}

export interface DesignatedSkuParsedRow {
  rowNumber: number;
  siteCode: string;
  sku: string;
  hierarchy: string;
  description: string;
  /** 原檔存貨；null = 缺值／非數字（不等於 0） */
  stockQty: number | null;
  /** 全部欄位原文，key 為原檔表頭 */
  data: Record<string, string>;
}

export interface DesignatedSkuParsed {
  ok: boolean;
  sheetName?: string;
  headers?: string[];
  totalRows: number;
  /** 被剔除以外的列數（Total 列、空白列） */
  skippedRows: number;
  errors?: Array<{ row: number; field: string; reason: string; siteCode?: string }>;
  warnings?: Array<{ row: number; field: string; reason: string; siteCode?: string }>;
  rows?: DesignatedSkuParsedRow[];
  contentHash?: string;
  /** 由表頭自動抽出的回覆欄位（最多 10 個） */
  replyFields?: DesignatedSkuReplyField[];
  /** item = 每個 SKU 一套；matter = 每間店一套（檔案無 Article 欄） */
  replyScope?: DesignatedSkuReplyScope;
  replyMode?: DesignatedSkuReplyMode;
}

function parseStockQty(raw: string): { value: number | null; invalid: boolean } {
  const text = String(raw ?? '').trim().replace(/,/g, '');
  if (!text) return { value: null, invalid: false };
  if (!/^-?\d+$/.test(text)) return { value: null, invalid: true };
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

/** 舊模板的兩個「店舖填寫」欄，不算自定回覆欄位（它們代表年期模式） */
function isLegacyReplyHeader(header: string): boolean {
  const h = normalizeHeader(header);
  return h.includes('可調撥件數') || h.includes('貨品年期') || h === 'mmyy';
}

export async function parseDesignatedSkuWorkbook(
  buffer: Buffer,
  storeCodes: Set<string>,
  maxRows: number,
): Promise<DesignatedSkuParsed> {
  const contentHash = hashFileContent(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    return {
      ok: false,
      totalRows: 0,
      skippedRows: 0,
      errors: [{ row: 0, field: 'file', reason: '無法讀取此檔案，請上載 .xlsx' }],
      contentHash,
    };
  }

  // 找表頭：首 10 列中，同時有 Site + SKU 欄（或欄名命中最多）的一列
  let sheet: ExcelJS.Worksheet | undefined;
  let headerRowNum = 0;
  let headerMap = new Map<string, number>();
  let headers: string[] = [];
  let bestScore = 0;

  for (const ws of workbook.worksheets) {
    const maxProbe = Math.min(10, ws.rowCount);
    for (let r = 1; r <= maxProbe; r += 1) {
      const row = ws.getRow(r);
      const map = new Map<string, number>();
      for (let c = 1; c <= Math.max(ws.columnCount, 1); c += 1) {
        const text = cellText(row.getCell(c)).trim();
        const field = detectField(text);
        if (field && !map.has(field)) map.set(field, c);
      }
      const score = HEADER_FIELDS.filter((f) => map.has(f)).length;
      // Article 可以不出現（= 每間店一套）；但 Site 一定要有
      if (map.has('site') && score > bestScore) {
        sheet = ws;
        headerRowNum = r;
        headerMap = map;
        bestScore = score;
      }
    }
  }

  if (!sheet || !headerMap.has('site')) {
    return {
      ok: false,
      totalRows: 0,
      skippedRows: 0,
      errors: [{
        row: 0,
        field: 'header',
        reason: '找不到表頭：檔案必須包含 Site（或 Site Code）欄；如要逐個 SKU 回覆，另加 Article（或 SKU）欄',
      }],
      contentHash,
    };
  }

  // 以原檔表頭建立完整欄名（保留順序，供 payload 及除錯顯示）
  const headerRow = sheet.getRow(headerRowNum);
  const columnCount = Math.max(sheet.columnCount, 1);
  const fullHeaders: string[] = [];
  for (let c = 1; c <= columnCount; c += 1) {
    fullHeaders.push(cellText(headerRow.getCell(c)).trim() || `Column ${c}`);
  }
  headers = fullHeaders;

  // ---------------------------------------------------------------------
  // 回覆欄位：內建 5 欄及舊「年期／件數」欄以外，其餘表頭自動成為自定欄位。
  // 表頭就是欄位名，上載後仍可在後台改名；key 固定 f1…f10，改名不影響已收回覆。
  // ---------------------------------------------------------------------
  const replyScope: DesignatedSkuReplyScope = headerMap.has('sku') ? 'item' : 'matter';
  const mappedColumns = new Set<number>(headerMap.values());
  const replyFields: DesignatedSkuReplyField[] = [];
  let hasYearColumns = false;
  for (let c = 1; c <= columnCount; c += 1) {
    const raw = fullHeaders[c - 1] ?? '';
    if (mappedColumns.has(c)) continue;
    if (!raw || /^Column \d+$/i.test(raw)) continue;
    if (isLegacyReplyHeader(raw)) {
      hasYearColumns = true;
      continue;
    }
    replyFields.push({
      key: `f${replyFields.length + 1}`,
      label: raw.slice(0, 80),
      type: inferReplyFieldType(raw),
      required: false,
    });
  }
  if (replyFields.length > DESIGNATED_SKU_MAX_REPLY_FIELDS) {
    return {
      ok: false,
      sheetName: sheet.name,
      headers,
      totalRows: 0,
      skippedRows: 0,
      errors: [{
        row: headerRowNum,
        field: '回覆欄位',
        reason: `本次上載有 ${replyFields.length} 個回覆欄位（${replyFields.map((f) => f.label).join('、')}），`
          + `上限 ${DESIGNATED_SKU_MAX_REPLY_FIELDS} 個；請先刪減欄位再上載`,
      }],
      contentHash,
    };
  }
  const replyMode: DesignatedSkuReplyMode = replyScope === 'matter'
    ? 'custom'
    : (replyFields.length ? (hasYearColumns ? 'mixed' : 'custom') : 'stock_year');

  const errors: NonNullable<DesignatedSkuParsed['errors']> = [];
  const warnings: NonNullable<DesignatedSkuParsed['warnings']> = [];
  const rows: DesignatedSkuParsedRow[] = [];
  const seen = new Set<string>();
  let totalRows = 0;
  let skippedRows = 0;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNum) return;
    const data: Record<string, string> = {};
    let hasAny = false;
    for (let c = 1; c <= columnCount; c += 1) {
      const text = cellText(row.getCell(c));
      data[fullHeaders[c - 1] ?? `Column ${c}`] = text;
      if (text !== '') hasAny = true;
    }
    if (!hasAny) return;

    const siteRaw = cellText(row.getCell(headerMap.get('site')!));
    const siteCode = normalizeSiteCode(siteRaw);
    // Total／頁腳列：靜靜剔除，不當錯誤
    if (TOTAL_SITE_CODES.has(siteCode.replace(/[\s_-]/g, ''))) {
      skippedRows += 1;
      return;
    }

    totalRows += 1;
    if (totalRows > maxRows) {
      errors.push({ row: rowNumber, field: 'file', reason: `超出單次最多 ${maxRows} 行限制` });
      return;
    }

    // 沒有 Article 欄 = 每間店一套；用佔位 SKU 代表店舖層（不顯示、不匯出）
    const sku = headerMap.has('sku')
      ? normalizeText(cellText(row.getCell(headerMap.get('sku')!)))
      : DESIGNATED_SKU_PLACEHOLDER_SKU;
    const hierarchy = headerMap.has('hierarchy')
      ? cellText(row.getCell(headerMap.get('hierarchy')!))
      : '';
    const description = headerMap.has('description')
      ? cellText(row.getCell(headerMap.get('description')!))
      : '';
    const stockRaw = headerMap.has('stock') ? cellText(row.getCell(headerMap.get('stock')!)) : '';
    const stock = parseStockQty(stockRaw);

    if (!siteCode) errors.push({ row: rowNumber, field: 'Site', reason: 'Site Code 為必填' });
    else if (storeCodes.size && !storeCodes.has(siteCode)) {
      errors.push({
        row: rowNumber,
        field: 'Site',
        reason: `Site Code「${siteCode}」不存在於門店主檔`,
        siteCode,
      });
    }
    if (headerMap.has('sku') && !sku) {
      errors.push({ row: rowNumber, field: 'SKU', reason: 'Article / SKU 為必填' });
    }
    if (stock.invalid) {
      warnings.push({
        row: rowNumber,
        field: '存貨',
        reason: `存貨「${stockRaw}」不是有效數量，已留空（不當 0 處理）`,
        siteCode,
      });
    }

    if (siteCode && sku) {
      // 每間店一套：同一店舖只可以一行；逐個 SKU：店舖 + SKU 不可重複
      const key = replyScope === 'matter' ? siteCode : `${siteCode}|${sku}`;
      if (seen.has(key)) {
        errors.push({
          row: rowNumber,
          field: replyScope === 'matter' ? 'Site' : 'SKU',
          reason: replyScope === 'matter'
            ? '此檔為「每間店一套」，同一店舖只可以有一行'
            : '檔案內 Site Code + Article 重複',
          siteCode,
        });
      }
      seen.add(key);
    }

    rows.push({
      rowNumber,
      siteCode,
      sku,
      hierarchy,
      description,
      stockQty: stock.value,
      data,
    });
  });

  if (errors.length) {
    return {
      ok: false,
      sheetName: sheet.name,
      headers,
      totalRows,
      skippedRows,
      errors,
      warnings,
      contentHash,
    };
  }
  if (!rows.length) {
    return {
      ok: false,
      sheetName: sheet.name,
      headers,
      totalRows,
      skippedRows,
      errors: [{ row: headerRowNum, field: 'file', reason: '檔案沒有任何可匯入的資料列' }],
      warnings,
      contentHash,
    };
  }

  return {
    ok: true,
    sheetName: sheet.name,
    headers,
    totalRows,
    skippedRows,
    rows,
    warnings,
    contentHash,
    replyFields,
    replyScope,
    replyMode,
  };
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
  alignment: { vertical: 'middle', wrapText: true },
};

function styleHeader(sheet: ExcelJS.Worksheet, columns: readonly string[]): void {
  columns.forEach((name, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = name;
    cell.style = HEADER_STYLE;
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const last = sheet.getColumn(columns.length);
  last.eachCell((cell) => {
    cell.border = { ...(cell.border ?? {}), right: { style: 'thin' } };
  });
}

/** 上載模板：與原檔相同欄位；另外附一張填寫說明 */
export async function generateDesignatedSkuTemplateWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('指定 SKU');
  styleHeader(sheet, DESIGNATED_SKU_COLUMNS);
  sheet.columns = [
    { width: 18 },
    { width: 16 },
    { width: 40 },
    { width: 10 },
    { width: 14 },
    { width: 20 },
    { width: 18 },
  ];
  // 最後兩欄由店舖填寫，用橙色標示（上載時可留空）
  for (const col of [6, 7]) {
    sheet.getCell(1, col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4A6' } };
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: DESIGNATED_SKU_COLUMNS.length } };

  const help = workbook.addWorksheet('填寫說明');
  help.columns = [{ width: 22 }, { width: 90 }];
  const lines: Array<[string, string]> = [
    ['Product Hierarchy', '產品分類（例：DRG），可留空'],
    ['Article', '貨品編號（SKU），必填'],
    ['Article Long Text (60 Chars)', '貨品描述'],
    ['Site', '店舖 Site Code（例：HB20），必填；只會向該店舖派發事項'],
    ['SaSa Net Stock', '該店存貨件數；留空或非數字會顯示為「未提供」，不當 0'],
    ['店舖回覆可調撥件數', '店舖填寫用，上載時請留空'],
    ['貨品年期 (MMYY)', '店舖填寫用（例：0827 = 2027 年 8 月），上載時請留空'],
    ['', ''],
    ['回覆自定欄位', `在最後一欄之後加欄即可：以上欄位以外的每個表頭都會成為店舖要填的回覆欄位，最多 ${DESIGNATED_SKU_MAX_REPLY_FIELDS} 個；欄名就是店舖見到的標題，上載後仍可在後台改名。`],
    ['每間店一套', '如果檔案只有 Site、沒有 Article，系統會當「每間店一套」：每間店只需回覆一次，不需要逐個 SKU（該批次不再要求年期及件數）。'],
    ['', ''],
    ['事項編號', '系統於上載後自動產生（批次編號 + 店舖序號），供日後查閱'],
    ['多個 SKU', '同一店舖同一批次的多個 SKU 會歸入同一個事項，店舖一次過回覆'],
    ['多個年期', '同一店同一 SKU 存貨有 2 件或以上時，店舖可分成多個年期回覆'],
  ];
  lines.forEach(([a, b], i) => {
    help.getCell(i + 1, 1).value = a;
    help.getCell(i + 1, 2).value = b;
    if (i === 0) {
      help.getCell(1, 1).font = { bold: true };
      help.getCell(1, 2).font = { bold: true };
    }
    help.getCell(i + 1, 2).alignment = { wrapText: true };
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export interface DesignatedSkuExportLine {
  year_code: string;
  qty: number;
}

export interface DesignatedSkuExportItem {
  matter_code: string;
  matter_status: 'pending' | 'replied';
  batch_code: string;
  subject: string;
  matter_type: string;
  site_code: string;
  shop?: string;
  sku: string;
  description: string;
  stock_qty: number | null;
  /** 此 SKU 的狀態（事項狀態另見 matter_status） */
  status: string;
  no_transfer: boolean;
  reply_total: number | null;
  reply_note: string;
  replied_by: string | null;
  replied_at: string | null;
  reply_count: number;
  admin_edited_by?: string;
  admin_edited_at?: string | null;
  is_open: boolean;
  created_at: string;
  lines: DesignatedSkuExportLine[];
  /** 自定回覆欄位（label + 已填值）；空白欄位不會出現 */
  reply_fields?: Array<{ label: string; value: string }>;
  /** matter = 每間店一套（SKU 欄留空） */
  reply_scope?: string;
}

export type DesignatedSkuMatterType = 'stock_year_breakdown';

function matterTypeLabel(type: string): string {
  if (type === 'stock_year_breakdown') return '年期／可調撥件數';
  return type || '—';
}

function matterStatusLabel(item: DesignatedSkuExportItem): string {
  if (!item.is_open) {
    return item.matter_status === 'replied' ? '已回覆（已封存）' : '未回覆（已截止）';
  }
  return item.matter_status === 'replied' ? '已回覆' : '未回覆';
}

function itemStatusLabel(item: DesignatedSkuExportItem): string {
  if (item.status === 'replied') {
    if (item.no_transfer) return '無可調撥';
    return item.is_open ? '已回覆' : '已回覆（已封存）';
  }
  return item.is_open ? '未回覆' : '未回覆（已截止）';
}

function lineSummary(lines: DesignatedSkuExportLine[]): string {
  if (!lines.length) return '';
  return lines
    .slice()
    .sort((a, b) => a.year_code.localeCompare(b.year_code))
    .map((l) => `${l.year_code} × ${l.qty}`)
    .join('；');
}

/** 後台匯出：事項回覆 / 年期明細 / 未回覆事項 三張工作表（每個 SKU 一行） */
export async function buildDesignatedSkuExportBuffer(items: DesignatedSkuExportItem[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summaryHead = ['事項編號', '批次編號', '批次主題', '事項類型', 'Site', '店舖', 'SKU', '描述'];
  const summaryTail = [
    '存貨',
    '事項狀態',
    'SKU 狀態',
    '無可調撥',
    '回覆合計（件）',
    '年期明細',
    '備註',
    '回覆人',
    '回覆時間',
    '提交次數',
    '管理員修改人',
    '管理員修改時間',
  ];
  // 不同批次可以有不同自定欄位：匯出用 label 聯集，按首次出現排序
  const reserved = new Set([...summaryHead, ...summaryTail]);
  const customLabels: string[] = [];
  for (const it of items) {
    for (const field of it.reply_fields ?? []) {
      if (field.label && !reserved.has(field.label) && !customLabels.includes(field.label)) {
        customLabels.push(field.label);
      }
    }
  }
  const summaryCols = [...summaryHead, ...customLabels, ...summaryTail];

  const summary = workbook.addWorksheet('事項回覆');
  styleHeader(summary, summaryCols);
  const fieldValue = (it: DesignatedSkuExportItem, label: string) =>
    (it.reply_fields ?? []).find((f) => f.label === label)?.value ?? '';
  items.forEach((it) => {
    summary.addRow([
      it.matter_code,
      it.batch_code,
      it.subject,
      matterTypeLabel(it.matter_type),
      it.site_code,
      it.shop ?? '',
      // 每間店一套：佔位 SKU（0）不顯示
      it.reply_scope === 'matter' ? '' : it.sku,
      it.description,
      ...customLabels.map((label) => fieldValue(it, label)),
      it.stock_qty === null || it.stock_qty === undefined ? '' : it.stock_qty,
      matterStatusLabel(it),
      itemStatusLabel(it),
      it.no_transfer ? '是' : '',
      it.reply_total === null || it.reply_total === undefined ? '' : it.reply_total,
      lineSummary(it.lines),
      it.reply_note,
      it.replied_by ?? '',
      it.replied_at ?? '',
      it.reply_count,
      it.admin_edited_by ?? '',
      it.admin_edited_at ?? '',
    ]);
  });
  const widthOf: Record<string, number> = {
    事項編號: 26,
    批次編號: 20,
    批次主題: 28,
    事項類型: 20,
    Site: 10,
    店舖: 18,
    SKU: 16,
    描述: 38,
    存貨: 9,
    事項狀態: 18,
    'SKU 狀態': 16,
    無可調撥: 10,
    '回覆合計（件）': 14,
    年期明細: 34,
    備註: 30,
    回覆人: 18,
    回覆時間: 20,
    提交次數: 10,
    管理員修改人: 18,
    管理員修改時間: 20,
  };
  summary.columns = summaryCols.map((name) => ({ width: widthOf[name] ?? 20 }));
  if (items.length) {
    summary.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: summaryCols.length } };
  }

  const lineCols = ['事項編號', '批次編號', 'Site', '店舖', 'SKU', '貨品年期 (MMYY)', '可調撥件數'] as const;
  const detail = workbook.addWorksheet('年期明細');
  styleHeader(detail, lineCols);
  for (const it of items) {
    for (const line of it.lines) {
      detail.addRow([it.matter_code, it.batch_code, it.site_code, it.shop ?? '', it.sku, line.year_code, line.qty]);
    }
  }
  detail.columns = [
    { width: 26 },
    { width: 20 },
    { width: 10 },
    { width: 18 },
    { width: 16 },
    { width: 18 },
    { width: 14 },
  ];

  const pendingCols = ['批次編號', '批次主題', '事項編號', 'Site', '店舖', 'SKU', '描述', '存貨', '建立時間'] as const;
  const pending = workbook.addWorksheet('未回覆事項');
  styleHeader(pending, pendingCols);
  items
    .filter((it) => it.status === 'pending')
    .forEach((it) => {
      pending.addRow([
        it.batch_code,
        it.subject,
        it.matter_code,
        it.site_code,
        it.shop ?? '',
        it.reply_scope === 'matter' ? '' : it.sku,
        it.description,
        it.stock_qty === null || it.stock_qty === undefined ? '' : it.stock_qty,
        it.created_at,
      ]);
    });
  pending.columns = [
    { width: 20 },
    { width: 28 },
    { width: 26 },
    { width: 10 },
    { width: 18 },
    { width: 16 },
    { width: 38 },
    { width: 9 },
    { width: 20 },
  ];

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
