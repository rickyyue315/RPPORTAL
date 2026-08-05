import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import {
  TEMPLATE_COLUMNS,
  TEMPLATE_INDEX_TO_FIELD,
  RP_TEAM_SHEET,
  normalizeText,
  SHOP_CODE_HEADER,
  URGENT_COLUMNS,
  URGENT_SHEET,
  URGENT_QTY_MIN,
  URGENT_QTY_MAX,
  SALES_COLUMNS,
  SALES_SHEET,
  RETURN_COLUMNS,
  RETURN_SHEET,
  RETURN_QTY_MIN,
  RETURN_QTY_MAX,
  BUSINESS_FIELD_LABELS,
  resolveUrgentReasonCode,
  resolveReturnReasonCode,
  type SubmissionBusinessFields,
} from '../lib/fields.js';
import { normalizeSiteCode } from '../services/stores.js';
import { validateBusinessFields, validateUrgentReason, isValidSku, SKU_ERROR } from './validation.js';

export interface ImportRowError {
  row: number;
  field: string;
  reason: string;
  siteCode?: string;
}

export interface ParsedImportRow {
  rowNumber: number;
  siteCode: string;
  fields: SubmissionBusinessFields;
}

export interface ParsedImport {
  ok: boolean;
  sheetName?: string;
  headers?: string[];
  totalRows: number;
  errors?: ImportRowError[];
  rows?: ParsedImportRow[];
  contentHash?: string;
}

const EXPECTED_HEADERS: readonly string[] = TEMPLATE_COLUMNS;

export const EXCEL_UPLOAD_FORMAT_HINT =
  '請上載 Excel 活頁簿（.xlsx）。支援 Excel 2007 或更新版本，例如 Excel 2019、Excel 2021、Excel 2024 或 Microsoft 365；不支援舊式 .xls。';

export const EXCEL_UPLOAD_EXTENSION_ERROR = `檔案格式不適合。${EXCEL_UPLOAD_FORMAT_HINT}`;

export const EXCEL_UPLOAD_PARSE_ERROR = `無法讀取此檔案。${EXCEL_UPLOAD_FORMAT_HINT}如目前是 .xls，請在 Excel 使用「另存新檔」轉換為 .xlsx。`;

export function hashFileContent(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function cellValue(cell: ExcelJS.Cell): string {
  return normalizeText(cell.value as never);
}

/**
 * Validates the whole file first; returns ok=false with all errors if any invalid.
 * No partial writes happen because validation is done before insertion.
 */
export async function parseImportWorkbook(
  buffer: Buffer,
  storeCodes: Set<string>,
  maxRows: number,
  options: { validateSku?: boolean } = {},
): Promise<ParsedImport> {
  const { validateSku = true } = options;
  const contentHash = hashFileContent(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    return {
      ok: false,
      totalRows: 0,
      errors: [{ row: 0, field: 'file', reason: EXCEL_UPLOAD_PARSE_ERROR }],
      contentHash,
    };
  }

  const sheet = workbook.getWorksheet(RP_TEAM_SHEET);
  if (!sheet) {
    return {
      ok: false,
      sheetName: RP_TEAM_SHEET,
      totalRows: 0,
      errors: [
        {
          row: 0,
          field: 'sheet',
          reason: `工作表名稱必須為「${RP_TEAM_SHEET}」`,
        },
      ],
      contentHash,
    };
  }

  const headers: string[] = [];
  const headerRow = sheet.getRow(1);
  for (let c = 1; c <= EXPECTED_HEADERS.length; c++) {
    headers.push(cellValue(headerRow.getCell(c)));
  }

  if (headers.length !== EXPECTED_HEADERS.length || headers.some((h, i) => h !== EXPECTED_HEADERS[i])) {
    return {
      ok: false,
      sheetName: RP_TEAM_SHEET,
      headers,
      totalRows: 0,
      errors: [
        {
          row: 1,
          field: 'header',
          reason: `欄名必須與模板一致，缺少或不符: ${EXPECTED_HEADERS.filter((h, i) => headers[i] !== h).join(', ')}`,
        },
      ],
      contentHash,
    };
  }

  const errors: ImportRowError[] = [];
  const rows: ParsedImportRow[] = [];
  let totalRows = 0;

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    // Ignore fully blank rows.
    let hasAny = false;
    for (let c = 1; c <= EXPECTED_HEADERS.length; c++) {
      const v = row.getCell(c).value;
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        hasAny = true;
        break;
      }
    }
    if (!hasAny) return;

    totalRows++;

    const siteCodeRaw = cellValue(row.getCell(EXPECTED_HEADERS.indexOf(SHOP_CODE_HEADER) + 1));
    const siteCode = normalizeSiteCode(siteCodeRaw);
    const rowError = (field: string, reason: string) =>
      errors.push({ row: rowNumber, field, reason, siteCode: siteCode || undefined });

    if (totalRows > maxRows) {
      rowError('file', `超出單次最多 ${maxRows} 行限制`);
      return;
    }

    if (!siteCode) {
      rowError(SHOP_CODE_HEADER, 'Site Code 為必填');
    } else if (!storeCodes.has(siteCode)) {
      rowError(SHOP_CODE_HEADER, `Site Code「${siteCode}」不存在於門店主檔`);
    }

    const fields: SubmissionBusinessFields = {
      brand: '',
      sku: '',
      rp_type: '',
      safety_stock: '',
      nd_code: '',
      remark: '',
    };

    for (const [templateIdx, fieldName] of Object.entries(TEMPLATE_INDEX_TO_FIELD)) {
      const col = Number(templateIdx) + 1;
      fields[fieldName] = cellValue(row.getCell(col));
    }

    if (!fields.sku) {
      errors.push({ row: rowNumber, field: 'SKU', reason: 'SKU 為必填' });
    } else if (validateSku && !isValidSku(fields.sku)) {
      errors.push({ row: rowNumber, field: 'SKU', reason: SKU_ERROR });
    }

    for (const err of validateBusinessFields(fields, siteCode)) {
      rowError(
        BUSINESS_FIELD_LABELS[err.field as keyof typeof BUSINESS_FIELD_LABELS] ?? err.field,
        err.message,
      );
    }

    rows.push({ rowNumber, siteCode, fields });
  });

  return {
    ok: errors.length === 0,
    sheetName: RP_TEAM_SHEET,
    headers,
    totalRows,
    errors: errors.length ? errors : undefined,
    rows: errors.length ? undefined : rows,
    contentHash,
  };
}

export interface ParsedUrgentRow {
  rowNumber: number;
  siteCode: string;
  sku: string;
  qty: number;
  urgentReason: string;
  urgentReasonOther: string;
}

export interface ParsedUrgentImport {
  ok: boolean;
  sheetName?: string;
  headers?: string[];
  totalRows: number;
  errors?: ImportRowError[];
  rows?: ParsedUrgentRow[];
  contentHash?: string;
}

const EXPECTED_URGENT_HEADERS: readonly string[] = URGENT_COLUMNS;
const URGENT_SITE_COL = 1;
const URGENT_SKU_COL = 2;
const URGENT_QTY_COL = 3;
const URGENT_REASON_COL = 4;
const URGENT_REASON_OTHER_COL = 5;

function parseQtyCell(raw: ExcelJS.CellValue): number {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? raw : NaN;
  }
  const s = normalizeText(raw as never);
  if (s === '') return NaN;
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : NaN;
}

/**
 * Validates a Urgent Order workbook: sheet must be "Urgent Order" with headers
 * exactly "Site Code | SKU | QTY | Urgent Reason | Other Reason". The whole
 * file is validated first; any error means nothing is written.
 */
export async function parseUrgentImportWorkbook(
  buffer: Buffer,
  storeCodes: Set<string>,
  maxRows: number,
  options: { validateSku?: boolean } = {},
): Promise<ParsedUrgentImport> {
  const { validateSku = true } = options;
  const contentHash = hashFileContent(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    return {
      ok: false,
      totalRows: 0,
      errors: [{ row: 0, field: 'file', reason: EXCEL_UPLOAD_PARSE_ERROR }],
      contentHash,
    };
  }

  const sheet = workbook.getWorksheet(URGENT_SHEET);
  if (!sheet) {
    return {
      ok: false,
      sheetName: URGENT_SHEET,
      totalRows: 0,
      errors: [
        {
          row: 0,
          field: 'sheet',
          reason: `工作表名稱必須為「${URGENT_SHEET}」`,
        },
      ],
      contentHash,
    };
  }

  const headers: string[] = [];
  const headerRow = sheet.getRow(1);
  for (let c = 1; c <= EXPECTED_URGENT_HEADERS.length; c++) {
    headers.push(cellValue(headerRow.getCell(c)));
  }

  if (headers.length !== EXPECTED_URGENT_HEADERS.length || headers.some((h, i) => h !== EXPECTED_URGENT_HEADERS[i])) {
    return {
      ok: false,
      sheetName: URGENT_SHEET,
      headers,
      totalRows: 0,
      errors: [
        {
          row: 1,
          field: 'header',
          reason: `欄名必須與模板一致，缺少或不符: ${EXPECTED_URGENT_HEADERS.filter((h, i) => headers[i] !== h).join(', ')}`,
        },
      ],
      contentHash,
    };
  }

  const errors: ImportRowError[] = [];
  const rows: ParsedUrgentRow[] = [];
  let totalRows = 0;

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    let hasAny = false;
    for (let c = 1; c <= EXPECTED_URGENT_HEADERS.length; c++) {
      const v = row.getCell(c).value;
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        hasAny = true;
        break;
      }
    }
    if (!hasAny) return;

    totalRows++;

    const siteCode = normalizeSiteCode(cellValue(row.getCell(URGENT_SITE_COL)));
    const rowError = (field: string, reason: string) =>
      errors.push({ row: rowNumber, field, reason, siteCode: siteCode || undefined });

    if (totalRows > maxRows) {
      rowError('file', `超出單次最多 ${maxRows} 行限制`);
      return;
    }

    if (!siteCode) {
      rowError('Site Code', 'Site Code 為必填');
    } else if (!storeCodes.has(siteCode)) {
      rowError('Site Code', `Site Code「${siteCode}」不存在於門店主檔`);
    }

    const sku = cellValue(row.getCell(URGENT_SKU_COL));
    if (!sku) {
      rowError('SKU', 'SKU 為必填');
    } else if (validateSku && !isValidSku(sku)) {
      rowError('SKU', SKU_ERROR);
    }

    const qty = parseQtyCell(row.getCell(URGENT_QTY_COL).value);
    if (!(Number.isInteger(qty) && qty >= URGENT_QTY_MIN && qty <= URGENT_QTY_MAX)) {
      rowError('QTY', `QTY 必須為 ${URGENT_QTY_MIN} 至 ${URGENT_QTY_MAX} 的整數`);
    }

    const urgentReason = cellValue(row.getCell(URGENT_REASON_COL));
    const urgentReasonOther = cellValue(row.getCell(URGENT_REASON_OTHER_COL));
    for (const err of validateUrgentReason(urgentReason, urgentReasonOther)) {
      const label = err.field === 'urgent_reason' ? 'Urgent Reason' : 'Other Reason';
      rowError(label, err.message);
    }

    rows.push({
      rowNumber,
      siteCode,
      sku,
      qty,
      urgentReason: resolveUrgentReasonCode(urgentReason),
      urgentReasonOther,
    });
  });

  return {
    ok: errors.length === 0,
    sheetName: URGENT_SHEET,
    headers,
    totalRows,
    errors: errors.length ? errors : undefined,
    rows: errors.length ? undefined : rows,
    contentHash,
  };
}

/**
 * Detects duplicate (site_code, sku) rows against existing keys of the same
 * application date AND duplicate rows within the same file. Used by the public
 * import routes only; admin imports are exempt. Returns row errors following
 * the existing all-or-nothing import semantics (nothing is written).
 */
export function findDuplicateImportErrors(
  rows: Array<{ rowNumber: number; siteCode: string; sku: string }>,
  existingKeys: Set<string>,
): ImportRowError[] {
  const errors: ImportRowError[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.siteCode || !r.sku) continue;
    const key = `${r.siteCode}|${r.sku}`;
    if (seen.has(key) || existingKeys.has(key)) {
      errors.push({
        row: r.rowNumber,
        field: 'SKU',
        reason: '同日已申報相同 SKU 或與檔案內其他行重複',
        siteCode: r.siteCode,
      });
    }
    seen.add(key);
  }
  return errors;
}

function parseReturnQtyCell(raw: ExcelJS.CellValue): number {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : NaN;
  const value = normalizeText(raw as never);
  if (!/^\d+$/.test(value)) return NaN;
  const qty = Number(value);
  return Number.isSafeInteger(qty) ? qty : NaN;
}

/** Validates the public return-goods workbook with all-or-nothing semantics. */
export async function parseReturnImportWorkbook(
  buffer: Buffer,
  storeCodes: Set<string>,
  maxRows: number,
  options: { validateSku?: boolean } = {},
): Promise<ParsedReturnImport> {
  const { validateSku = true } = options;
  const contentHash = hashFileContent(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    return { ok: false, totalRows: 0, errors: [{ row: 0, field: 'file', reason: EXCEL_UPLOAD_PARSE_ERROR }], contentHash };
  }

  const sheet = workbook.getWorksheet(RETURN_SHEET);
  if (!sheet) {
    return {
      ok: false,
      sheetName: RETURN_SHEET,
      totalRows: 0,
      errors: [{ row: 0, field: 'sheet', reason: `工作表名稱必須為「${RETURN_SHEET}」` }],
      contentHash,
    };
  }

  const headers = RETURN_COLUMNS.map((_, index) => cellValue(sheet.getRow(1).getCell(index + 1)));
  if (sheet.getRow(1).cellCount !== RETURN_COLUMNS.length || headers.some((header, index) => header !== RETURN_COLUMNS[index])) {
    return {
      ok: false,
      sheetName: RETURN_SHEET,
      headers,
      totalRows: 0,
      errors: [{
        row: 1,
        field: 'header',
        reason: `欄名必須與模板一致，缺少或不符: ${RETURN_COLUMNS.filter((header, index) => headers[index] !== header).join(', ')}`,
      }],
      contentHash,
    };
  }

  const errors: ImportRowError[] = [];
  const rows: ParsedReturnRow[] = [];
  let totalRows = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const hasAny = RETURN_COLUMNS.some((_, index) => {
      const value = row.getCell(index + 1).value;
      return value !== null && value !== undefined && String(value).trim() !== '';
    });
    if (!hasAny) return;
    totalRows++;

    const siteCode = normalizeSiteCode(cellValue(row.getCell(1)));
    const sku = cellValue(row.getCell(2));
    const qty = parseReturnQtyCell(row.getCell(3).value);
    const reason = cellValue(row.getCell(4));
    const confirmerName = cellValue(row.getCell(5));
    const confirmerPhone = cellValue(row.getCell(6));
    const rowError = (field: string, message: string) => errors.push({ row: rowNumber, field, reason: message, siteCode: siteCode || undefined });

    if (totalRows > maxRows) {
      rowError('file', `超出單次最多 ${maxRows} 行限制`);
      return;
    }
    if (!siteCode) rowError('Site Code', 'Site Code 為必填');
    else if (!storeCodes.has(siteCode)) rowError('Site Code', `Site Code「${siteCode}」不存在於門店主檔`);
    if (!sku) rowError('SKU', 'SKU 為必填');
    else if (validateSku && !isValidSku(sku)) rowError('SKU', SKU_ERROR);
    if (!(Number.isInteger(qty) && qty >= RETURN_QTY_MIN && qty <= RETURN_QTY_MAX)) {
      rowError('QTY', `QTY 必須為 ${RETURN_QTY_MIN} 至 ${RETURN_QTY_MAX} 的整數`);
    }
    if (!reason) rowError('REASON', 'REASON 為必填');
    else if (!resolveReturnReasonCode(reason)) rowError('REASON', 'REASON 選項無效');
    if (!confirmerName) rowError('確認人姓名', '確認人姓名為必填');
    if (!confirmerPhone) rowError('確認人電話', '確認人電話為必填');

    rows.push({
      rowNumber,
      siteCode,
      sku,
      qty,
      reason: resolveReturnReasonCode(reason),
      confirmerName,
      confirmerPhone,
    });
  });

  return {
    ok: errors.length === 0,
    sheetName: RETURN_SHEET,
    headers,
    totalRows,
    errors: errors.length ? errors : undefined,
    rows: errors.length ? undefined : rows,
    contentHash,
  };
}

export interface ParsedSalesRow {
  rowNumber: number;
  siteCode: string;
  sku: string;
}

export interface ParsedSalesImport {
  ok: boolean;
  sheetName?: string;
  headers?: string[];
  totalRows: number;
  errors?: ImportRowError[];
  rows?: ParsedSalesRow[];
  contentHash?: string;
}

export interface ParsedReturnRow {
  rowNumber: number;
  siteCode: string;
  sku: string;
  qty: number;
  reason: string;
  confirmerName: string;
  confirmerPhone: string;
}

export interface ParsedReturnImport {
  ok: boolean;
  sheetName?: string;
  headers?: string[];
  totalRows: number;
  errors?: ImportRowError[];
  rows?: ParsedReturnRow[];
  contentHash?: string;
}

/** Validates the dedicated two-column sudden sales workbook. */
export async function parseSalesImportWorkbook(
  buffer: Buffer,
  storeCodes: Set<string>,
  maxRows: number,
  options: { validateSku?: boolean } = {},
): Promise<ParsedSalesImport> {
  const { validateSku = true } = options;
  const contentHash = hashFileContent(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    return { ok: false, totalRows: 0, errors: [{ row: 0, field: 'file', reason: EXCEL_UPLOAD_PARSE_ERROR }], contentHash };
  }

  const sheet = workbook.getWorksheet(SALES_SHEET);
  if (!sheet) {
    return {
      ok: false,
      sheetName: SALES_SHEET,
      totalRows: 0,
      errors: [{ row: 0, field: 'sheet', reason: `工作表名稱必須為「${SALES_SHEET}」` }],
      contentHash,
    };
  }

  const headerRow = sheet.getRow(1);
  const headers = SALES_COLUMNS.map((_, index) => cellValue(headerRow.getCell(index + 1)));
  if (headerRow.cellCount !== SALES_COLUMNS.length || headers.some((header, index) => header !== SALES_COLUMNS[index])) {
    return {
      ok: false,
      sheetName: SALES_SHEET,
      headers,
      totalRows: 0,
      errors: [{
        row: 1,
        field: 'header',
        reason: `欄名必須與模板一致，缺少或不符: ${SALES_COLUMNS.filter((header, index) => headers[index] !== header).join(', ')}`,
      }],
      contentHash,
    };
  }

  const errors: ImportRowError[] = [];
  const rows: ParsedSalesRow[] = [];
  let totalRows = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const hasAny = SALES_COLUMNS.some((_, index) => {
      const value = row.getCell(index + 1).value;
      return value !== null && value !== undefined && String(value).trim() !== '';
    });
    if (!hasAny) return;

    totalRows++;
    const siteCode = normalizeSiteCode(cellValue(row.getCell(1)));
    const sku = cellValue(row.getCell(2));
    const rowError = (field: string, reason: string) => errors.push({ row: rowNumber, field, reason, siteCode: siteCode || undefined });

    if (totalRows > maxRows) {
      rowError('file', `超出單次最多 ${maxRows} 行限制`);
      return;
    }
    if (!siteCode) rowError('Site Code', 'Site Code 為必填');
    else if (!storeCodes.has(siteCode)) rowError('Site Code', `Site Code「${siteCode}」不存在於門店主檔`);
    if (!sku) rowError('SKU', 'SKU 為必填');
    else if (validateSku && !isValidSku(sku)) rowError('SKU', SKU_ERROR);
    rows.push({ rowNumber, siteCode, sku });
  });

  return {
    ok: errors.length === 0,
    sheetName: SALES_SHEET,
    headers,
    totalRows,
    errors: errors.length ? errors : undefined,
    rows: errors.length ? undefined : rows,
    contentHash,
  };
}
