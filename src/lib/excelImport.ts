import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import {
  SAP_COLUMNS,
  RP_TEAM_SHEET,
  SAP_INDEX_TO_FIELD,
  normalizeText,
  SHOP_CODE_HEADER,
  type SubmissionBusinessFields,
} from '../lib/fields.js';
import { normalizeSiteCode } from '../services/stores.js';

export interface ImportRowError {
  row: number;
  field: string;
  reason: string;
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

const EXPECTED_HEADERS: readonly string[] = SAP_COLUMNS;

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
    if (totalRows > maxRows) {
      errors.push({
        row: rowNumber,
        field: 'file',
        reason: `超出單次最多 ${maxRows} 行限制`,
      });
      return;
    }

    const siteCodeRaw = cellValue(row.getCell(EXPECTED_HEADERS.indexOf(SHOP_CODE_HEADER) + 1));
    const siteCode = normalizeSiteCode(siteCodeRaw);
    if (!siteCode) {
      errors.push({ row: rowNumber, field: SHOP_CODE_HEADER, reason: 'Site Code 為必填' });
    } else if (!storeCodes.has(siteCode)) {
      errors.push({ row: rowNumber, field: SHOP_CODE_HEADER, reason: `Site Code「${siteCode}」不存在於門店主檔` });
    }

    const fields: SubmissionBusinessFields = {
      brand: '',
      sku: '',
      rp_type: '',
      supply_source: '',
      safety_stock: '',
      nd_code: '',
      rp_parameters_change_request: '',
      remark: '',
    };

    for (const [sapIdx, fieldName] of Object.entries(SAP_INDEX_TO_FIELD)) {
      const col = Number(sapIdx) + 1;
      fields[fieldName] = cellValue(row.getCell(col));
    }

    if (!fields.sku) {
      errors.push({ row: rowNumber, field: 'SKU', reason: 'SKU 為必填' });
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
