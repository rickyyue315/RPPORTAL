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
  /** 所屬週次是否仍可回覆；false = 已封存（未回覆會標示為已截止，仍會列入匯出紀錄） */
  is_open?: boolean;
  /** 所屬週次是否需要回覆；false = 「本週無須回覆」（未回覆屬正常，不算欠交） */
  reply_required?: boolean;
  /** 若回覆由系統自動套用，記錄來源週次；null／undefined = 店舖自行回覆 */
  auto_filled_from_week?: string | null;
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
  // 跨批次匯出時必須有「週次」，否則無法分辨行屬於哪一批（舊批次會排在後面，看似只有最新批次）
  const headers = ['週次', ...ZERO_SALES_COLUMNS.slice(0, 22), '店舖回覆 (原因)', '補充說明', '回覆狀態', '修改次數', '回覆時間', '回覆人', '記錄狀態'];
  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDAEEF3' } },
  };
  sheet.addRow(headers);
  headers.forEach((_, i) => { sheet.getCell(1, i + 1).style = headerStyle; });
  for (const it of items) {
    sheet.addRow([
      it.batch_label ?? '',
      ...ZERO_SALES_COLUMNS.slice(0, 22).map((c) => it.payload?.[c] ?? (c === 'Site Code' ? it.site_code : c === 'SKU' ? it.sku : '')),
      it.reason_label ?? '',
      it.reason_note ?? '',
      it.status === 'replied'
        ? (it.auto_filled_from_week ? `已回覆（自動套用 ${it.auto_filled_from_week}）` : '已回覆')
        : (it.reply_required === false ? '未回覆（本週無須回覆）' : '未回覆'),
      it.reply_count ?? (it.status === 'replied' ? 1 : 0),
      it.replied_at ?? '',
      it.replied_by ?? '',
      it.reply_required === false
        ? '無須回覆（只供參考）'
        : (it.is_open === false ? '已截止（已封存）' : '可回覆'),
    ]);
  }
  sheet.columns = headers.map(() => ({ width: 18 }));

  const pendingSheet = workbook.addWorksheet('未回覆店舖');
  const pendingHeaders = ['Site Code', 'Shop Name', 'OM', '週次', '批次狀態', '總 SKU 數', '已回覆', '未回覆', '未回覆 SKU', '店舖回覆 (原因)', '跟進備註'];
  pendingSheet.addRow(pendingHeaders);
  pendingHeaders.forEach((_, i) => { pendingSheet.getCell(1, i + 1).style = headerStyle; });
  const storeMap = new Map<string, { site_code: string; shop: string; om: string; week: string; archived: boolean; total: number; replied: number; skus: string[]; reasons: Map<string, number> }>();
  for (const it of items) {
    // 「本週無須回覆」的週次：未回覆屬正常，不可列入跟進名單（只保留已回覆的紀錄）
    if (it.reply_required === false && it.status !== 'replied') continue;
    // 跨批次匯出時，已封存週次的未回覆行亦要保留（歷史紀錄），以「批次狀態」標示不可再回覆
    const key = `${it.site_code}|${it.batch_label}`;
    let s = storeMap.get(key);
    if (!s) {
      s = { site_code: it.site_code, shop: it.payload?.['Shop Name'] ?? '', om: it.payload?.['OM'] ?? '', week: it.batch_label, archived: it.is_open === false, total: 0, replied: 0, skus: [], reasons: new Map() };
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
    // 開放中的週次先列（跟進用），已封存的排後面；同組內未回覆最多的店舖先行
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.skus.length - a.skus.length || a.site_code.localeCompare(b.site_code));
  for (const s of pendingStores) {
    const reasonText = [...s.reasons].map(([label, n]) => `${label} (${n})`).join('；');
    pendingSheet.addRow([s.site_code, s.shop, s.om, s.week, s.archived ? '已封存（已截止）' : '開放中', s.total, s.replied, s.skus.length, s.skus.join(', '), reasonText, '']);
  }
  pendingSheet.columns = pendingHeaders.map(() => ({ width: 18 }));
  pendingSheet.getColumn(2).width = 28;
  pendingSheet.getColumn(9).width = 50;
  pendingSheet.getColumn(10).width = 40;
  // 註解：說明括號內數字的意義（括號內為行數）
  const pendingNote = pendingSheet.getCell(pendingStores.length + 3, 1);
  pendingNote.value = '註：括號內數字為行數（該店以該原因回覆的行數）；「批次狀態」為已封存的週次不可再回覆；「本週無須回覆」的週次不列入此工作表。';
  pendingNote.font = { italic: true, color: { argb: 'FF808080' } };

  buildSkuReasonSheet(workbook, items, reasonLabels, headerStyle);
  buildBuyerSheet(workbook, items, headerStyle);
  applyDefaultFont(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export interface ZeroSalesRepeatSkuExportRow {
  sku: string;
  brand: string;
  sku_desc: string;
  /** 主要 Buyer（服務層最新一行取值；舊資料可能為空） */
  buyer?: string;
  repeat_store_count: number;
  listed_store_count: number;
  repeat_rate: number;
  repeat_rows: number;
  total_rows: number;
  max_occurrence: number;
  pending_count: number;
  replied_count: number;
  last_week_label: string;
  last_seen: string;
}

export interface ZeroSalesRepeatPairExportRow {
  site_code: string;
  shop: string;
  /** 店舖所屬 OM */
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

export interface ZeroSalesRepeatExportMeta {
  minCount: number;
  q?: string;
  siteCode?: string;
  buyer?: string;
  /** 匯出時間（已轉香港時間字串） */
  generatedAt: string;
}

export interface ZeroSalesRepeatExportInput {
  /** 有提供才建立「跨店重複 SKU」工作表 */
  skus?: ZeroSalesRepeatSkuExportRow[];
  /** 有提供才建立「各店明細」工作表 */
  pairs?: ZeroSalesRepeatPairExportRow[];
  meta: ZeroSalesRepeatExportMeta;
}

/** 與前端一致的參考判斷：多店重複 → SKU 問題；單店重複 → 店舖問題 */
function repeatSkuVerdict(row: ZeroSalesRepeatSkuExportRow): string {
  const rate = Number(row.repeat_rate) || 0;
  if (row.repeat_store_count >= 3 && rate >= 0.5) return 'SKU 問題';
  if (row.repeat_store_count >= 2 && rate >= 0.5) return '疑似 SKU';
  return '店舖問題';
}

/** 底部註解文字：重複定義、判斷準則、重複率解讀、建議跟進分工、匯出條件 */
function repeatNoteLines(meta: ZeroSalesRepeatExportMeta): string[] {
  const parts = [`重複定義：同一店舖同一 SKU 跨週（批次）出現 ≥ ${meta.minCount} 次`];
  if (meta.siteCode) parts.push(`Site Code：${meta.siteCode}`);
  if (meta.q) parts.push(`搜尋：${meta.q}`);
  if (meta.buyer) parts.push(`Buyer：${meta.buyer}`);
  parts.push(`匯出時間：${meta.generatedAt}`);
  return [
    `${parts.join('；')}。`,
    '「判斷（參考）」是啟發式標籤，不是統計結論：SKU 問題 = 重複店數 ≥ 3 且重複率 ≥ 50%；疑似 SKU = 2 間店重複且重複率 ≥ 50%；店舖問題 = 其餘（通常是單店重複）。',
    '重複率 = 有重複上榜的店數 ÷ 曾上榜店數。重複率高＝問題橫跨多間店，較可能是 SKU 本身（價錢／陳列／推廣／季節性／生命周期），宜由 Buyer 檢視 SKU；重複率低＝集中在個別店舖，較可能是該店執行問題（陳列位置、補貨、人手），宜由 OM 跟進店舖。',
    '建議分工：先處理「SKU 問題」清單（交 Buyer 檢視價錢／推廣／陳列指引／停售或退貨），再處理「店舖問題」清單（交 OM 檢查該店陳列及補貨）。',
  ];
}

/** 匯出表底部註解區：每行合併整行並自動換行，避免長句被截。
 *  widthsTotal 為該工作表欄寬總和，用作估算換行後行高（中文約佔 2 個寬度單位）。 */
function appendNoteBlock(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  lines: string[],
  lastCol: number,
  widthsTotal: number,
): void {
  const titleCell = sheet.getCell(startRow, 1);
  titleCell.value = '註解';
  titleCell.font = { bold: true, size: 10, color: { argb: 'FF595959' } };
  lines.forEach((line, i) => {
    const rowNum = startRow + 1 + i;
    sheet.mergeCells(rowNum, 1, rowNum, lastCol);
    const cell = sheet.getCell(rowNum, 1);
    cell.value = line;
    cell.font = { italic: true, color: { argb: 'FF808080' } };
    cell.alignment = { vertical: 'top', wrapText: true };
    const units = [...line].reduce((acc, ch) => acc + (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
    const perLine = Math.max(40, Math.floor(widthsTotal * 0.92));
    sheet.getRow(rowNum).height = Math.max(15, Math.ceil(units / perLine) * 15 + 2);
  });
}

/**
 * 重複上榜統計匯出：可只匯出「跨店重複 SKU」或「各店明細」，亦可兩者同時。
 * 兩張表都以同一重複定義（同店同 SKU 跨批次 ≥ minCount）計算。
 */
export async function buildZeroSalesRepeatExportBuffer(
  input: ZeroSalesRepeatExportInput,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDAEEF3' } },
  };
  const noteLines = repeatNoteLines(input.meta);

  if (input.skus) {
    const sheet = workbook.addWorksheet('跨店重複 SKU');
    const headers = [
      '排名', 'SKU', 'Brand', 'SKU 描述', 'Buyer', '重複店數', '曾上榜店數', '重複率',
      '重複行數', '總行數', '單店最高次數', '未回覆', '已回覆',
      '最後週次', '最後出現日期', '判斷（參考）',
    ];
    sheet.addRow(headers);
    headers.forEach((_, i) => { sheet.getCell(1, i + 1).style = headerStyle; });
    input.skus.forEach((r, i) => {
      sheet.addRow([
        i + 1, r.sku, r.brand, r.sku_desc, r.buyer ?? '',
        r.repeat_store_count, r.listed_store_count, r.repeat_rate,
        r.repeat_rows, r.total_rows, r.max_occurrence,
        r.pending_count, r.replied_count,
        r.last_week_label, r.last_seen, repeatSkuVerdict(r),
      ]);
    });
    const widths = [6, 16, 22, 32, 18, 10, 12, 10, 12, 10, 14, 10, 10, 12, 14, 14];
    widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
    sheet.getColumn(8).numFmt = '0%';
    if (input.skus.length) {
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: input.skus.length + 1, column: headers.length } };
    }
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    appendNoteBlock(sheet, input.skus.length + 3, noteLines, headers.length, 222);
  }

  if (input.pairs) {
    const sheet = workbook.addWorksheet('各店明細');
    const headers = [
      'Site Code', '店舖', 'By OM', 'SKU', 'Brand', 'SKU 描述',
      '出現次數', '未回覆', '已回覆', '首次出現', '最後出現', '最後週次',
      '週次（新→舊）', '上次回覆', '上次回覆時間',
    ];
    sheet.addRow(headers);
    headers.forEach((_, i) => { sheet.getCell(1, i + 1).style = headerStyle; });
    for (const r of input.pairs) {
      const lastReply = r.last_reason_label
        ? `${r.last_reason_label}${r.last_reason_note ? `（${r.last_reason_note}）` : ''}`
        : (r.last_status === 'replied' ? '已回覆' : '未回覆');
      sheet.addRow([
        r.site_code, r.shop, r.om ?? '', r.sku, r.brand, r.sku_desc,
        r.occurrence_count, r.pending_count, r.replied_count,
        r.first_seen, r.last_seen, r.last_week_label,
        (r.weeks ?? []).join(' → '), lastReply, r.last_replied_at ?? '',
      ]);
    }
    const widths = [12, 26, 10, 16, 22, 32, 10, 10, 10, 12, 12, 12, 40, 32, 18];
    widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
    if (input.pairs.length) {
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: input.pairs.length + 1, column: headers.length } };
    }
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    // 各店明細只講重複定義及篩選條件（判斷欄只出現在跨店排行）
    appendNoteBlock(sheet, input.pairs.length + 3, noteLines.slice(0, 1), headers.length, 260);
  }

  if (!workbook.worksheets.length) throw new Error('沒有重複上榜資料可以匯出');
  applyDefaultFont(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export interface ZeroSalesBuyerFollowupExportRow extends ZeroSalesRepeatSkuExportRow {
  stock_total: number;
  top_reasons: string;
  store_list: string;
}

/** Buyer 跟進一頁：單一工作表，按重複店數倒序，重點行自動標色，附 Buyer 備註欄。
 *  欄位齊 Buyer／庫存總計／Top 原因／重複店舖清單，直接交 Buyer 跟進。 */
export async function buildZeroSalesBuyerFollowupExportBuffer(
  rows: ZeroSalesBuyerFollowupExportRow[],
  meta: ZeroSalesRepeatExportMeta,
): Promise<Buffer> {
  if (!rows.length) throw new Error('沒有重複上榜資料可以匯出');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Buyer跟進');
  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
  };
  const headers = [
    '排名', 'SKU', 'Brand', 'SKU 描述', 'Buyer',
    '重複店數', '曾上榜店數', '重複率', '重複行數', '總行數', '單店最高次數',
    '庫存總計 (CM)', '未回覆', '已回覆', '主要回覆原因 (Top 2)',
    '重複店舖清單', '最後週次', '最後出現', '判斷（參考）', 'Buyer 跟進備註',
  ];
  sheet.addRow(headers);
  headers.forEach((_, i) => { sheet.getCell(1, i + 1).style = headerStyle; });
  sheet.getRow(1).height = 30;
  rows.forEach((r, i) => {
    const row = sheet.addRow([
      i + 1, r.sku, r.brand, r.sku_desc, r.buyer ?? '',
      r.repeat_store_count, r.listed_store_count, r.repeat_rate,
      r.repeat_rows, r.total_rows, r.max_occurrence,
      r.stock_total ?? 0, r.pending_count, r.replied_count, r.top_reasons ?? '',
      r.store_list ?? '', r.last_week_label, r.last_seen, repeatSkuVerdict(r), '',
    ]);
    // 突出多店重複：≥5 深紅底白字，≥3 淺紅底，≥2 黃底
    let fill: string | null = null;
    let fontColor: string | null = null;
    if (r.repeat_store_count >= 5) { fill = 'FFC00000'; fontColor = 'FFFFFFFF'; }
    else if (r.repeat_store_count >= 3) { fill = 'FFFFC7CE'; }
    else if (r.repeat_store_count >= 2) { fill = 'FFFFEB9C'; }
    if (fill) {
      for (let c = 6; c <= 8; c++) {
        const cell = row.getCell(c);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        if (fontColor) cell.font = { bold: true, color: { argb: fontColor } };
        else cell.font = { bold: true };
      }
    }
    // SKU 問題加粗判斷欄
    const verdict = String(row.getCell(19).value ?? '');
    if (verdict === 'SKU 問題') {
      row.getCell(19).font = { bold: true, color: { argb: 'FFC00000' } };
    }
    row.alignment = { vertical: 'middle', wrapText: true };
  });
  const widths = [6, 16, 20, 30, 16, 10, 12, 9, 10, 9, 12, 13, 9, 9, 34, 30, 12, 12, 12, 24];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  sheet.getColumn(8).numFmt = '0%';
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: headers.length } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  // 打印一頁橫向設定：方便直接列印交 Buyer
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  const widthsTotal = widths.reduce((acc, w) => acc + w, 0);
  appendNoteBlock(sheet, rows.length + 3, [
    ...repeatNoteLines(meta),
    '標色：重複店數 ≥ 2 黃底、≥ 3 淺紅底、≥ 5 深紅底白字；顏色只反映「幾多間店重複」，不代表金額或迫切性。',
    '庫存總計 = 重複店舖行的 Shop Stock Qty (CM) 加總（空白或非數字不計）；主要回覆原因只計已回覆行，格式「原因 (行數)」。',
    '「Buyer 跟進備註」欄供 Buyer 填寫行動、負責人及日期，例如「已改價」「加推廣」「安排退貨」。',
  ], headers.length, widthsTotal);
  applyDefaultFont(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 全份 Excel 統一字體：Arial 10（保留原有粗體／斜體／顏色） */
function applyDefaultFont(workbook: ExcelJS.Workbook): void {
  for (const ws of workbook.worksheets) {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        cell.font = { ...(cell.font ?? {}), name: 'Arial', size: 10 };
      });
    });
  }
}

/** 「首2位」顯示格式：名稱 (數量)；多過一個以「；」分隔，同數量按原本出現次序（原因按設定次序、品牌按首次出現次序） */
function formatTopEntries(counts: Map<string, number>): string {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label, n]) => `${label} (${n})`)
    .join('；');
}

/** 店舖版面匯出欄位：與店舖頁表格一致（前8欄），另加存貨量 / RP Type / Safety Stock */
export const ZERO_SALES_STORE_EXPORT_COLUMNS = [
  '週次',
  'Brand',
  'SKU',
  '描述',
  'SKU上載日期',
  '狀態',
  '店舖本次回覆',
  '重複提示',
  '存貨量',
  'RP Type',
  'Safety Stock',
] as const;

export interface ZeroSalesStoreExportItem {
  week_label: string;
  sku: string;
  payload: Record<string, string>;
  status: string;
  reason_label: string | null;
  reason_note: string | null;
  /** SKU 上載日期 (YYYY-MM-DD) */
  batch_date: string;
  /** 所屬週次是否仍可回覆；false = 已封存（匯出時狀態會標示為已截止／已封存） */
  is_open?: boolean;
  /** 所屬週次是否需要回覆；false = 「本週無須回覆」（狀態欄標示為無須回覆，不算欠交） */
  reply_required?: boolean;
  /** 跨批次累計上榜次數（<2 為首次） */
  occurrence_count: number;
  prev_week_label: string | null;
  prev_status: string | null;
  prev_reason_label: string | null;
  /** 若回覆由系統自動套用，記錄來源週次；null／undefined = 店舖自行回覆 */
  auto_filled_from_week?: string | null;
}

/** 「重複提示」欄：第N次上榜（上次 週次：原因）；首次上榜為空白 */
function repeatHint(it: ZeroSalesStoreExportItem): string {
  if ((it.occurrence_count ?? 1) < 2) return '';
  const prevReason = it.prev_reason_label || (it.prev_status === 'replied' ? '已回覆' : '未回覆');
  const prev = it.prev_week_label ? `（上次 ${it.prev_week_label}：${prevReason}）` : '';
  return `第${it.occurrence_count}次上榜${prev}`;
}

/** 店舖版面匯出：單工作表、只含該店被派發的 SKU，欄位與店舖頁表格一致 */
export async function buildZeroSalesStoreExportBuffer(items: ZeroSalesStoreExportItem[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('零銷售回覆');
  const headers = [...ZERO_SALES_STORE_EXPORT_COLUMNS];
  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDAEEF3' } },
    alignment: { vertical: 'middle', wrapText: true },
  };
  sheet.addRow(headers);
  headers.forEach((_, i) => { sheet.getCell(1, i + 1).style = headerStyle; });
  for (const it of items) {
    const p = it.payload ?? {};
    const replied = it.status === 'replied';
    const archived = it.is_open === false;
    // 已封存週次：狀態欄同時交代回覆結果與「不可再回覆」，避免匯出表被當成待辦清單
    // 「本週無須回覆」：未回覆屬正常，標示為無須回覆而非欠交
    const statusText = it.reply_required === false
      ? (replied ? '已回覆（本週無須回覆）' : '無須回覆')
      : archived
        ? (replied ? '已回覆（已封存）' : '未回覆（已截止）')
        : (replied
          ? (it.auto_filled_from_week ? `已回覆（自動套用 ${it.auto_filled_from_week}）` : '已回覆')
          : '未回覆');
    sheet.addRow([
      it.week_label ?? '',
      p['Brand'] ?? '',
      it.sku,
      p['SKU Desc'] ?? '',
      it.batch_date ?? '',
      statusText,
      replied ? [it.reason_label || '', it.reason_note || ''].filter(Boolean).join('\n') : '',
      repeatHint(it),
      parseQty(p['Shop Stock Qty (CM)']) ?? p['Shop Stock Qty (CM)'] ?? '',
      p['RP Type'] ?? '',
      p['Safety Stock (現時)'] ?? '',
    ]);
  }
  const widths = [12, 22, 16, 36, 14, 10, 36, 34, 12, 12, 14];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  applyDefaultFont(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
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
  /** 該 Buyer 的 Zero Sales 不重複品牌數 */
  brands: number;
  /** 該 Buyer 的 Shop Stock Qty (CM) 總計 */
  stock: number;
  /** 回覆原因計數（只計已回覆） */
  counts: Map<string, number>;
  /** 品牌 → 行數（用於品牌數及首2位品牌） */
  brandRows: Map<string, number>;
}

/**
 * 工作表「Buyer 統計」：每 Buyer 一列，統計 Zero Sales 不重複 SKU 數（含未回覆）、品牌數、Shop Stock Qty (CM)（重複 SKU 加總）、
 * 首 2 位品牌及首 2 位回覆原因（括號內為行數；品牌計所有行，原因只計已回覆行）；版面與其他統計表一致（第3列群組標題、第4列欄名、第5列起資料），末行為合計，下方加註解說明括號內數字的意義。
 * 未設定 Buyer / Brand 的行歸入「（未設定）」。
 */
function buildBuyerSheet(
  workbook: ExcelJS.Workbook,
  items: ZeroSalesExportItem[],
  headerStyle: Partial<ExcelJS.Style>,
): void {
  const itemBrand = (it: ZeroSalesExportItem): string => (it.payload?.['Brand'] ?? '') || '（未設定）';

  const byBuyer = new Map<string, BuyerStat & { skuSet: Set<string> }>();
  for (const it of items) {
    const buyer = (it.payload?.['Buyer'] ?? '') || '（未設定）';
    let b = byBuyer.get(buyer);
    if (!b) {
      b = { buyer, skus: 0, brands: 0, stock: 0, counts: new Map(), brandRows: new Map(), skuSet: new Set() };
      byBuyer.set(buyer, b);
    }
    b.skuSet.add(it.sku);
    const brand = itemBrand(it);
    b.brandRows.set(brand, (b.brandRows.get(brand) ?? 0) + 1);
    const qty = parseQty(it.payload?.['Shop Stock Qty (CM)']);
    if (qty !== null) b.stock += qty;
    if (it.status === 'replied') {
      const label = replyReasonLabel(it);
      b.counts.set(label, (b.counts.get(label) ?? 0) + 1);
    }
  }
  const buyerStats = [...byBuyer.values()]
    .map(({ skuSet, ...b }) => ({ ...b, skus: skuSet.size, brands: b.brandRows.size }))
    .sort((a, b) => b.skus - a.skus || b.stock - a.stock || a.buyer.localeCompare(b.buyer));

  // 合計的 SKU / 品牌數為全表不重複（同一 SKU 可能出現在多個 Buyer，不能直接加總每列）
  const totalSkus = new Set(items.map((it) => it.sku)).size;
  const totalBrandRows = new Map<string, number>();
  for (const it of items) {
    const brand = itemBrand(it);
    totalBrandRows.set(brand, (totalBrandRows.get(brand) ?? 0) + 1);
  }
  const totalStock = buyerStats.reduce((acc, b) => acc + b.stock, 0);
  const totalCounts = new Map<string, number>();
  for (const b of buyerStats) {
    for (const [label, n] of b.counts) totalCounts.set(label, (totalCounts.get(label) ?? 0) + n);
  }
  const HEADER_ROW = 4;
  const FIRST_DATA_ROW = 5;
  const headers = ['Buyer', 'SKU 數', '品牌數', '主要品牌 (首2位)', 'Shop Stock Qty (CM)(總計)', '主要原因 (首2位)'];
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
    const values: Array<string | number> = [
      b.buyer, b.skus, b.brands,
      formatTopEntries(b.brandRows),
      b.stock,
      formatTopEntries(b.counts),
    ];
    values.forEach((v, i) => { sheet.getCell(FIRST_DATA_ROW + idx, i + 1).value = v; });
  });
  const totalValues: Array<string | number> = [
    '合計', totalSkus, totalBrandRows.size,
    formatTopEntries(totalBrandRows),
    totalStock,
    formatTopEntries(totalCounts),
  ];
  totalValues.forEach((v, i) => {
    const cell = sheet.getCell(FIRST_DATA_ROW + buyerStats.length, i + 1);
    cell.value = v;
    cell.font = { bold: true };
  });
  // 註解：說明括號內數字的意義（括號內為行數）
  const noteCell = sheet.getCell(FIRST_DATA_ROW + buyerStats.length + 2, 1);
  noteCell.value = '註：括號內數字為行數（品牌為該品牌的行數；原因為該原因的已回覆行數）。';
  noteCell.font = { italic: true, color: { argb: 'FF808080' } };
  const widths = [26, 10, 10, 34, 24, 52];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
}
