import ExcelJS from 'exceljs';
import {
  SAP_COLUMNS,
  TEMPLATE_COLUMNS,
  RP_TEAM_SHEET,
  RP_TYPE_OPTIONS,
  ND_CODE_OPTIONS,
  URGENT_COLUMNS,
  URGENT_SHEET,
  URGENT_QTY_MIN,
  URGENT_QTY_MAX,
} from '../lib/fields.js';
import { toHKDateString } from '../lib/time.js';
import type { SubmissionRow } from '../services/submissions.js';

type ValidationSheet = ExcelJS.Worksheet & {
  dataValidations: {
    add(address: string, validation: ExcelJS.DataValidation): void;
  };
};

function asValidationSheet(sheet: ExcelJS.Worksheet): ValidationSheet {
  return sheet as ValidationSheet;
}

/** Generates the template workbook for download (headers + data validation dropdowns). */
export async function generateTemplateWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(RP_TEAM_SHEET);

  // Hidden list sheet, mirroring the original template's " Data Validation" sheet.
  const listSheet = workbook.addWorksheet(' Data Validation', { state: 'hidden' });
  const listLabels = ['All Shops', 'All Shops (exclude HB87)', 'HK Shops', 'MO Shops', 'Shop Class A', 'Shop Class B', 'Shop Class C', 'Shop Class D'];
  listLabels.forEach((label, i) => {
    listSheet.getCell(i + 1, 1).value = label;
  });
  ND_CODE_OPTIONS.forEach((code, i) => {
    listSheet.getCell(i + 1, 2).value = code;
  });

  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: 'FF000000' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
    border: {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    },
  };

  TEMPLATE_COLUMNS.forEach((name, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = name;
    cell.style = headerStyle;
  });

  // Data validation dropdowns replicating the original template.
  const lastDataRow = 2001;
  const colLetter = (templateColumn: string) => String.fromCharCode(64 + TEMPLATE_COLUMNS.indexOf(templateColumn as (typeof TEMPLATE_COLUMNS)[number]) + 1);
  const range = (templateColumn: string) => `${colLetter(templateColumn)}2:${colLetter(templateColumn)}${lastDataRow}`;

  const vSheet = asValidationSheet(sheet);
  vSheet.dataValidations.add(range('RP Type'), {
    type: 'list',
    allowBlank: true,
    formulae: [`"${RP_TYPE_OPTIONS.join(',')}"`],
  });
  vSheet.dataValidations.add(range('ND Code'), {
    type: 'list',
    allowBlank: true,
    formulae: [`' Data Validation'!$B$1:$B$${ND_CODE_OPTIONS.length}`],
  });

  const widths = [14, 18, 10, 14, 45, 30];
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export interface ExportFilters {
  fromDate?: string;
  toDate?: string;
  siteCode?: string;
  includeExported?: boolean;
}

export function buildSapExportBuffer(rows: SubmissionRow[]): Promise<Buffer> {
  return (async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(RP_TEAM_SHEET);
    sheet.addRow([...SAP_COLUMNS]);

    const headerStyle: Partial<ExcelJS.Style> = {
      font: { bold: true },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
    };
    for (let c = 1; c <= SAP_COLUMNS.length; c++) {
      const cell = sheet.getCell(1, c);
      cell.style = headerStyle;
    }

    for (const row of rows) {
      sheet.addRow([
        toHKDateString(row.application_date),
        row.requested_by_email,
        row.site_code,
        row.brand,
        row.sku,
        row.rp_type,
        row.safety_stock,
        row.nd_code,
        row.remark,
      ]);
    }

    const widths = [18, 22, 14, 16, 18, 10, 14, 45, 30];
    widths.forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  })();
}

/** Generates the Urgent Order import template (Site Code | SKU | QTY). */
export async function generateUrgentTemplateWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(URGENT_SHEET);

  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: 'FF000000' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
    border: {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    },
  };

  URGENT_COLUMNS.forEach((name, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = name;
    cell.style = headerStyle;
  });

  const vSheet = asValidationSheet(sheet);
  vSheet.dataValidations.add('C2:C2001', {
    type: 'whole',
    operator: 'between',
    allowBlank: true,
    formulae: [URGENT_QTY_MIN, URGENT_QTY_MAX],
  });

  sheet.getColumn(1).width = 14;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 12;

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export interface UrgentExportRow {
  application_no: string;
  site_code: string;
  sku: string;
  qty: number | null;
}

/** Builds the Urgent Order export workbook (Application No. | Site Code | SKU | QTY). */
export function buildUrgentExportBuffer(rows: UrgentExportRow[]): Promise<Buffer> {
  return (async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(URGENT_SHEET);
    sheet.addRow(['Application No.', ...URGENT_COLUMNS]);

    const headerStyle: Partial<ExcelJS.Style> = {
      font: { bold: true },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
    };
    for (let c = 1; c <= 4; c++) {
      const cell = sheet.getCell(1, c);
      cell.style = headerStyle;
    }

    for (const row of rows) {
      sheet.addRow([row.application_no, row.site_code, row.sku, row.qty]);
    }

    sheet.getColumn(1).width = 32;
    sheet.getColumn(2).width = 14;
    sheet.getColumn(3).width = 22;
    sheet.getColumn(4).width = 12;

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  })();
}

export interface ImportRecordRow {
  row: number;
  application_no: string;
  site_code: string;
  sku: string;
  rp_type?: string;
  safety_stock?: string;
  nd_code?: string;
  remark?: string;
  submitted_at: string;
}

/** Builds the import record workbook: one sheet per Site Code with that store's imported rows. */
export async function buildImportRecordBuffer(rows: ImportRecordRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
  };
  const headers = ['Excel 行', '申請編號', 'Site Code', 'SKU', 'RP Type', 'Safety stock', 'ND Code', 'Remark', '已收件時間'];
  const widths = [10, 32, 12, 20, 10, 14, 45, 30, 24];

  const bySite = new Map<string, ImportRecordRow[]>();
  for (const r of rows) {
    const list = bySite.get(r.site_code) ?? [];
    list.push(r);
    bySite.set(r.site_code, list);
  }

  for (const site of [...bySite.keys()].sort()) {
    const sheet = workbook.addWorksheet(site.slice(0, 31));
    sheet.addRow(headers);
    for (let c = 1; c <= headers.length; c++) {
      sheet.getCell(1, c).style = headerStyle;
    }
    for (const r of bySite.get(site)!) {
      sheet.addRow([
        r.row,
        r.application_no,
        r.site_code,
        r.sku,
        r.rp_type ?? '',
        r.safety_stock ?? '',
        r.nd_code ?? '',
        r.remark ?? '',
        r.submitted_at,
      ]);
    }
    widths.forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function buildAuditExportBuffer(
  rows: Array<{
    application_no: string;
    version: number;
    actor_role: string;
    actor: string | null;
    ip: string | null;
    change_source: string;
    changed_at: string;
    data_before: Record<string, string | number | null> | null;
    data_after: Record<string, string | number | null>;
    export_batch_id?: string | null;
  }>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Audit Report');

  sheet.addRow([
    '申請編號',
    '版本',
    '操作者角色',
    '操作者',
    'IP',
    '修改來源',
    '修改日期時間 (HK)',
    '匯出批次',
    '欄位',
    '修改前',
    '修改後',
  ]);

  for (const r of rows) {
    const fieldNames = Object.keys(r.data_after);
    for (const field of fieldNames) {
      const before = r.data_before?.[field] ?? '';
      const after = r.data_after[field] ?? '';
      if (before === after) continue;
      sheet.addRow([
        r.application_no,
        r.version,
        r.actor_role === 'admin' ? '管理員' : '申請人',
        r.actor ?? '',
        r.ip ?? '',
        r.change_source,
        toHKDateString(r.changed_at),
        r.export_batch_id ?? '',
        field,
        before,
        after,
      ]);
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
