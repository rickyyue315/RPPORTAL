import ExcelJS from 'exceljs';
import {
  SAP_COLUMNS,
  RP_TEAM_SHEET,
  REQUESTED_BY_HEADER,
  RP_TYPE_OPTIONS,
  SUPPLY_SOURCE_OPTIONS,
  RP_PARAMETER_OPTIONS,
  ND_CODE_OPTIONS,
  type SubmissionBusinessFields,
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

  SAP_COLUMNS.forEach((name, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = name;
    cell.style = headerStyle;
  });

  // Data validation dropdowns replicating the original template.
  const lastDataRow = 2001;
  const colLetter = (sapColumn: string) => String.fromCharCode(64 + SAP_COLUMNS.indexOf(sapColumn as (typeof SAP_COLUMNS)[number]) + 1);
  const range = (sapColumn: string) => `${colLetter(sapColumn)}2:${colLetter(sapColumn)}${lastDataRow}`;

  const vSheet = asValidationSheet(sheet);
  vSheet.dataValidations.add(range('RP Type'), {
    type: 'list',
    allowBlank: true,
    formulae: [`"${RP_TYPE_OPTIONS.join(',')}"`],
  });
  vSheet.dataValidations.add(range('Supply source'), {
    type: 'list',
    allowBlank: true,
    formulae: [`"${SUPPLY_SOURCE_OPTIONS.join(',')}"`],
  });
  vSheet.dataValidations.add(range('RP Parameters Change Request'), {
    type: 'list',
    allowBlank: true,
    formulae: [`"${RP_PARAMETER_OPTIONS.join(',')}"`],
  });
  vSheet.dataValidations.add(range('ND Code'), {
    type: 'list',
    allowBlank: true,
    formulae: ["' Data Validation'!$B$1:$B$21"],
  });
  vSheet.dataValidations.add(range(REQUESTED_BY_HEADER), {
    type: 'list',
    allowBlank: true,
    formulae: ['"Cora Lai ,Ice Lin,Bridget Wong ,Ricky Yue,Ting Chan,Laurent Wong,Winnie Lin"'],
  });

  const widths = [18, 22, 14, 16, 18, 10, 40, 14, 45, 28, 20, 30];
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
        row.supply_source,
        row.safety_stock,
        row.nd_code,
        row.rp_parameters_change_request,
        row.rp_type_completed_at ? toHKDateString(row.rp_type_completed_at) : null,
        row.remark,
      ]);
    }

    const widths = [18, 22, 14, 16, 18, 10, 40, 14, 45, 28, 20, 30];
    widths.forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  })();
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
    data_before: SubmissionBusinessFields | null;
    data_after: SubmissionBusinessFields;
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
    const fieldNames = Object.keys(r.data_after) as Array<keyof SubmissionBusinessFields>;
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
