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
  BUSINESS_FIELD_LABELS,
  type SubmissionBusinessFields,
} from '../lib/fields.js';
import { normalizeSiteCode } from '../services/stores.js';
import { validateBusinessFields } from './validation.js';

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
): Promise<ParsedImport> {
  const contentHash = hashFileContent(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    return {
      ok: false,
      totalRows: 0,
      errors: [{ row: 0, field: 'file', reason: '無法解析 Excel 檔案' }],
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
 * exactly "Site Code | SKU | QTY". The whole file is validated first; any error
 * means nothing is written.
 */
export async function parseUrgentImportWorkbook(
  buffer: Buffer,
  storeCodes: Set<string>,
  maxRows: number,
): Promise<ParsedUrgentImport> {
  const contentHash = hashFileContent(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    return {
      ok: false,
      totalRows: 0,
      errors: [{ row: 0, field: 'file', reason: '無法解析 Excel 檔案' }],
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
    }

    const qty = parseQtyCell(row.getCell(URGENT_QTY_COL).value);
    if (!(Number.isInteger(qty) && qty >= URGENT_QTY_MIN && qty <= URGENT_QTY_MAX)) {
      rowError('QTY', `QTY 必須為 ${URGENT_QTY_MIN} 至 ${URGENT_QTY_MAX} 的整數`);
    }

    rows.push({ rowNumber, siteCode, sku, qty });
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
