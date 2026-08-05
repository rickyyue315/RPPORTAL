import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  TEMPLATE_COLUMNS,
  RP_TEAM_SHEET,
  SHOP_CODE_HEADER,
  URGENT_COLUMNS,
  URGENT_SHEET,
  SAP_COLUMNS,
  SALES_COLUMNS,
  SALES_SHEET,
  SALES_EXPORT_COLUMNS,
  RETURN_COLUMNS,
  RETURN_SHEET,
  RETURN_EXPORT_COLUMNS,
} from '../src/lib/fields.js';
import { parseImportWorkbook, parseUrgentImportWorkbook, parseSalesImportWorkbook, parseReturnImportWorkbook } from '../src/lib/excelImport.js';
import {
  generateTemplateWorkbook,
  buildSapExportBuffer,
  generateUrgentTemplateWorkbook,
  buildUrgentExportBuffer,
  generateSalesTemplateWorkbook,
  buildSalesImportRecordBuffer,
  buildSalesExportBuffer,
  generateReturnTemplateWorkbook,
  buildReturnImportRecordBuffer,
  buildReturnExportBuffer,
} from '../src/lib/excelExport.js';

const storeCodes = new Set(['HA02', 'HA06', 'HB11', 'HA19']);

async function makeWorkbookBuffer(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(RP_TEAM_SHEET);
  ws.addRow([...TEMPLATE_COLUMNS]);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function blankRow(): string[] {
  return Array(TEMPLATE_COLUMNS.length).fill('');
}

function dataRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const row = blankRow();
  const put = (name: string, val: string) => {
    row[TEMPLATE_COLUMNS.indexOf(name)] = val;
  };
  put(SHOP_CODE_HEADER, 'HA02');
  put('SKU', '110079623001');
  put('RP Type', 'ND');
  put('ND Code', 'ND20-SO-Not displayed in small stores');
  Object.entries(overrides).forEach(([k, v]) => put(k, v));
  return row;
}

describe('parseImportWorkbook', () => {
  it('accepts a valid workbook', async () => {
    const buffer = await makeWorkbookBuffer([dataRow()]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows![0].siteCode).toBe('HA02');
    expect(result.rows![0].fields.sku).toBe('110079623001');
  });

  it('rejects wrong sheet name', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Other');
    ws.addRow([...TEMPLATE_COLUMNS]);
    ws.addRow(dataRow());
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('sheet');
  });

  it('rejects wrong headers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow(['Shop Code', 'SKU', 'RP Type']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('header');
  });

  it('rejects non-existent site code', async () => {
    const buffer = await makeWorkbookBuffer([dataRow({ 'Shop Code': 'ZZ99' })]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.reason).toContain('不存在於門店主檔');
  });

  it('rejects missing SKU', async () => {
    const buffer = await makeWorkbookBuffer([dataRow({ SKU: '' })]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.reason).toContain('SKU 為必填');
  });

  it('rejects SKUs that are not 7 or 12 digits', async () => {
    const buffer = await makeWorkbookBuffer([dataRow({ SKU: '123456789012 , 123456789011' })]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('SKU');
    expect(result.errors?.[0]?.reason).toContain('7 位或 12 位');
  });

  it('skips SKU format validation when validateSku is false (admin)', async () => {
    const buffer = await makeWorkbookBuffer([dataRow({ SKU: 'NOT-SKU-123' })]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000, { validateSku: false });
    expect(result.ok).toBe(true);
    expect(result.rows![0].fields.sku).toBe('NOT-SKU-123');
  });

  it('rejects rows over maxRows limit', async () => {
    const rows = Array.from({ length: 5 }, () => dataRow({ SKU: `${1000000 + Math.floor(Math.random() * 9000000)}` }));
    const buffer = await makeWorkbookBuffer(rows);
    const result = await parseImportWorkbook(buffer, storeCodes, 3);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.reason.includes('超出單次'))).toBe(true);
  });

  it('ignores fully blank rows', async () => {
    const buffer = await makeWorkbookBuffer([dataRow(), blankRow(), blankRow()]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
  });

  it('allows duplicate site_code+sku rows', async () => {
    const buffer = await makeWorkbookBuffer([dataRow(), dataRow()]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
  });

  it('rejects missing RP Type', async () => {
    const buffer = await makeWorkbookBuffer([dataRow({ 'RP Type': '' })]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('RP Type');
    expect(result.errors?.[0]?.reason).toContain('RP Type 為必填');
  });

  it('rejects ND without ND Code', async () => {
    const buffer = await makeWorkbookBuffer([dataRow({ 'ND Code': '' })]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('ND Code');
    expect(result.errors?.[0]?.reason).toContain('ND Code');
  });

  it('rejects RF without Safety stock and rejects non-positive Safety stock', async () => {
    const missing = await parseImportWorkbook(
      await makeWorkbookBuffer([dataRow({ 'RP Type': 'RF', 'ND Code': '' })]),
      storeCodes,
      1000,
    );
    expect(missing.ok).toBe(false);
    expect(missing.errors?.[0]?.field).toBe('Safety stock');
    expect(missing.errors?.[0]?.reason).toContain('Safety stock');

    const zero = await parseImportWorkbook(
      await makeWorkbookBuffer([dataRow({ 'RP Type': 'RF', 'ND Code': '', 'Safety stock': '0' })]),
      storeCodes,
      1000,
    );
    expect(zero.ok).toBe(false);
    expect(zero.errors?.[0]?.reason).toContain('大於 0');
  });

  it('accepts RF with positive Safety stock for a non-listed store', async () => {
    const buffer = await makeWorkbookBuffer([dataRow({ 'RP Type': 'RF', 'ND Code': '', 'Safety stock': '6.5' })]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
  });

  it('rejects RF without Remark for a listed store', async () => {
    const buffer = await makeWorkbookBuffer([
      dataRow({ 'Shop Code': 'HA19', 'RP Type': 'RF', 'ND Code': '', 'Safety stock': '10' }),
    ]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('Remark');
  });

  it('accepts RF with Remark for a listed store', async () => {
    const buffer = await makeWorkbookBuffer([
      dataRow({ 'Shop Code': 'HA19', 'RP Type': 'RF', 'ND Code': '', 'Safety stock': '10', Remark: '原因' }),
    ]);
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
  });
});

describe('generateTemplateWorkbook', () => {
  it('produces a valid xlsx with RP Team sheet', async () => {
    const buffer = await generateTemplateWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    expect(wb.getWorksheet(RP_TEAM_SHEET)).toBeDefined();
    const ws = wb.getWorksheet(RP_TEAM_SHEET)!;
    expect(ws.getCell(1, 1).value).toBe('Shop Code');
    expect(ws.getCell(1, 6).value).toBe('Remark');
  });
});

describe('buildSapExportBuffer', () => {
  it('writes all columns in order', async () => {
    const rows = [
      {
        id: '1',
        application_no: 'NDRF-TEST',
        source: 'web' as const,
        submission_type: 'normal' as const,
        site_code: 'HA02',
        requested_by_email: 'ha02@sasa.com',
        application_date: '2026-08-02',
        submitted_at: new Date().toISOString(),
        brand: 'NEG - NEOGENCE',
        sku: '110079623001',
        rp_type: 'ND',
        safety_stock: null,
        nd_code: null,
        remark: null,
        qty: null,
        status: 'received',
        exported_at: null,
        export_batch_id: null,
        locked_at: null,
        created_ip: '1.2.3.4',
        created_ip_expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    const buffer = await buildSapExportBuffer(rows);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.getWorksheet(RP_TEAM_SHEET)!;
    const headerRow = ws.getRow(1);
    SAP_COLUMNS.forEach((name, i) => {
      expect(headerRow.getCell(i + 1).value).toBe(name);
    });
    const data = ws.getRow(2);
    expect(data.getCell(3).value).toBe('HA02');
    expect(data.getCell(2).value).toBe('ha02@sasa.com');
    expect(data.getCell(5).value).toBe('110079623001');
  });
});

describe('parseUrgentImportWorkbook', () => {
  async function urgentBuffer(rows: Array<Array<string | number>>): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('accepts a valid urgent workbook', async () => {
    const buffer = await urgentBuffer([['HA02', '1006001', 5, '1', '']]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
    expect(result.rows![0].siteCode).toBe('HA02');
    expect(result.rows![0].sku).toBe('1006001');
    expect(result.rows![0].qty).toBe(5);
    expect(result.rows![0].urgentReason).toBe('1');
    expect(result.rows![0].urgentReasonOther).toBe('');
  });

  it('rejects wrong sheet name', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Other');
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', '1006001', 5, '1', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('sheet');
  });

  it('rejects wrong headers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow(['Site Code', 'SKU']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('header');
  });

  it('rejects the old three-column header contract', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow(['Site Code', 'SKU', 'QTY']);
    ws.addRow(['HA02', '1006101', 5]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('header');
  });

  it('rejects qty 0, 1001, decimals and text', async () => {
    const buffer = await urgentBuffer([
      ['HA02', '1006102', 0, '1', ''],
      ['HA02', '1006103', 1001, '1', ''],
      ['HA02', '1006104', 1.5, '1', ''],
      ['HA02', '1006105', 'abc', '1', ''],
    ]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.filter((e) => e.field === 'QTY')).toHaveLength(4);
  });

  it('rejects unknown site code and empty sku', async () => {
    const buffer = await urgentBuffer([
      ['ZZ99', '1006106', 2, '1', ''],
      ['HA02', '', 3, '1', ''],
    ]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.field === 'Site Code')).toBe(true);
    expect(result.errors?.some((e) => e.field === 'SKU')).toBe(true);
  });

  it('rejects a multi-SKU cell', async () => {
    const buffer = await urgentBuffer([['HA02', '123456789012,123456789011', 2, '1', '']]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.field === 'SKU')).toBe(true);
  });

  it('rejects missing reason', async () => {
    const buffer = await urgentBuffer([['HA02', '1006108', 4, '', '']]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.field === 'Urgent Reason')).toBe(true);
  });

  it('rejects option 9 without other reason', async () => {
    const buffer = await urgentBuffer([['HA02', '1006109', 4, '9', '']]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.field === 'Other Reason')).toBe(true);
  });

  it('rejects non-9 option with other reason', async () => {
    const buffer = await urgentBuffer([['HA02', '1006110', 4, '1', '補充']]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.field === 'Other Reason')).toBe(true);
  });

  it('accepts option 9 with other reason', async () => {
    const buffer = await urgentBuffer([['HA02', '1006111', 4, '9', '詳細原因']]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.rows![0].urgentReason).toBe('9');
    expect(result.rows![0].urgentReasonOther).toBe('詳細原因');
  });

  it('accepts the full reason label from the template dropdown and stores its code', async () => {
    const buffer = await urgentBuffer([['HA02', '1006112', 4, '2. ROADSHOW', '']]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.rows![0].urgentReason).toBe('2');
  });

  it('rejects an invalid reason value', async () => {
    const buffer = await urgentBuffer([['HA02', '1006113', 4, '99', '']]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.field === 'Urgent Reason')).toBe(true);
  });

  it('ignores blank rows', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', '1006107', 4, '1', '']);
    ws.addRow([]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
  });
});

describe('generateUrgentTemplateWorkbook / buildUrgentExportBuffer', () => {
  it('produces an urgent template with Site Code | SKU | QTY | Urgent Reason | Other Reason headers', async () => {
    const buffer = await generateUrgentTemplateWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.getWorksheet(URGENT_SHEET)!;
    expect(ws.getCell(1, 1).value).toBe('Site Code');
    expect(ws.getCell(1, 2).value).toBe('SKU');
    expect(ws.getCell(1, 3).value).toBe('QTY');
    expect(ws.getCell(1, 4).value).toBe('Urgent Reason');
    expect(ws.getCell(1, 5).value).toBe('Other Reason');
  });

  it('writes urgent export with Application No. | Site Code | SKU | QTY | Urgent Reason | Other Reason', async () => {
    const buffer = await buildUrgentExportBuffer([
      { application_no: 'URGENT-TEST', site_code: 'HA02', sku: '1006001', qty: 9, urgent_reason: '9', urgent_reason_other: '備註原因' },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.getWorksheet(URGENT_SHEET)!;
    expect(ws.getCell(1, 1).value).toBe('Application No.');
    expect(ws.getCell(1, 2).value).toBe('Site Code');
    expect(ws.getCell(1, 5).value).toBe('Urgent Reason');
    expect(ws.getCell(1, 6).value).toBe('Other Reason');
    const data = ws.getRow(2);
    expect(data.getCell(1).value).toBe('URGENT-TEST');
    expect(data.getCell(2).value).toBe('HA02');
    expect(data.getCell(4).value).toBe(9);
    expect(data.getCell(5).value).toBe('9. 其他');
    expect(data.getCell(6).value).toBe('備註原因');
  });
});

describe('sales Excel', () => {
  async function salesBuffer(rows: string[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SALES_SHEET);
    ws.addRow([...SALES_COLUMNS]);
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('accepts a valid sales workbook', async () => {
    const buffer = await salesBuffer([['HA02', '1007001']]);
    const result = await parseSalesImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
    expect(result.rows![0].siteCode).toBe('HA02');
    expect(result.rows![0].sku).toBe('1007001');
  });

  it('rejects wrong sheet name', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Other');
    ws.addRow(['Site Code', 'SKU']);
    ws.addRow(['HA02', '1007002']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseSalesImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('sheet');
  });

  it('rejects wrong headers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SALES_SHEET);
    ws.addRow(['Site Code', 'SKU', 'QTY']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseSalesImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('header');
  });

  it('rejects unknown site code and missing sku', async () => {
    const buffer = await salesBuffer([['ZZ99', '1007003'], ['HA02', '']]);
    const result = await parseSalesImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.field === 'Site Code')).toBe(true);
    expect(result.errors?.some((e) => e.field === 'SKU')).toBe(true);
  });

  it('rejects a multi-SKU cell', async () => {
    const buffer = await salesBuffer([['HA02', '123456789012 123456789011']]);
    const result = await parseSalesImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.field === 'SKU')).toBe(true);
  });

  it('rejects rows over maxRows limit', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ['HA02', `${1007000 + i}`]);
    const buffer = await salesBuffer(rows);
    const result = await parseSalesImportWorkbook(buffer, storeCodes, 2);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.reason.includes('超出單次'))).toBe(true);
  });

  it('ignores fully blank rows', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SALES_SHEET);
    ws.addRow([...SALES_COLUMNS]);
    ws.addRow(['HA02', '1007004']);
    ws.addRow([]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseSalesImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
  });

  it('produces a sales template with exactly Site Code | SKU', async () => {
    const buffer = await generateSalesTemplateWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.getWorksheet(SALES_SHEET)!;
    expect(ws.getCell(1, 1).value).toBe('Site Code');
    expect(ws.getCell(1, 2).value).toBe('SKU');
  });

  it('builds a sales import record workbook grouped by site', async () => {
    const buffer = await buildSalesImportRecordBuffer([
      { row: 2, application_no: 'SALES-A', site_code: 'HA02', sku: '1005005', submitted_at: '2026-08-03 09:00:00' },
      { row: 3, application_no: 'SALES-B', site_code: 'HA06', sku: '1005006', submitted_at: '2026-08-03 09:00:01' },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    expect(wb.getWorksheet('HA02')).toBeDefined();
    expect(wb.getWorksheet('HA06')).toBeDefined();
    const ws = wb.getWorksheet('HA02')!;
    expect(ws.getCell(1, 2).value).toBe('申請編號');
    expect(ws.getCell(2, 2).value).toBe('SALES-A');
  });

  it('builds the four-column sales export with RP Team sheet', async () => {
    const buffer = await buildSalesExportBuffer([
      { application_date: '2026-08-03', requested_by_email: 'ha02@sasa.com', site_code: 'HA02', sku: '1005007' },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.getWorksheet(RP_TEAM_SHEET)!;
    SALES_EXPORT_COLUMNS.forEach((name, i) => {
      expect(ws.getCell(1, i + 1).value).toBe(name);
    });
    const data = ws.getRow(2);
    expect(data.getCell(1).value).toBe('2026-08-03');
    expect(data.getCell(2).value).toBe('ha02@sasa.com');
    expect(data.getCell(3).value).toBe('HA02');
    expect(data.getCell(4).value).toBe('1005007');
  });
});

describe('return-goods Excel', () => {
  async function returnBuffer(rows: Array<Array<string | number>>): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RETURN_SHEET);
    ws.addRow([...RETURN_COLUMNS]);
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('accepts a valid return workbook and resolves the reason label', async () => {
    const result = await parseReturnImportWorkbook(
      await returnBuffer([['HA02', '1008001', 99, '2. BUYER 電郵確認可退-期貨', '確認人', '電話文字']]),
      storeCodes,
      1000,
    );
    expect(result.ok).toBe(true);
    expect(result.rows![0]).toMatchObject({ siteCode: 'HA02', sku: '1008001', qty: 99, reason: '2', confirmerName: '確認人', confirmerPhone: '電話文字' });
  });

  it('rejects invalid return fields and quantity outside 1 to 9999', async () => {
    const result = await parseReturnImportWorkbook(
      await returnBuffer([['ZZ99', '123456', 10000, '99', '', '']]),
      storeCodes,
      1000,
    );
    expect(result.ok).toBe(false);
    expect(result.errors?.some((error) => error.field === 'Site Code')).toBe(true);
    expect(result.errors?.some((error) => error.field === 'SKU')).toBe(true);
    expect(result.errors?.some((error) => error.field === 'QTY')).toBe(true);
    expect(result.errors?.some((error) => error.field === 'REASON')).toBe(true);
  });

  it('generates the return template and eight-column export', async () => {
    const template = new ExcelJS.Workbook();
    await template.xlsx.load((await generateReturnTemplateWorkbook()) as never);
    expect(template.getWorksheet(RETURN_SHEET)?.getRow(1).values).toEqual(expect.arrayContaining([...RETURN_COLUMNS]));

    const exportWorkbook = new ExcelJS.Workbook();
    await exportWorkbook.xlsx.load((await buildReturnExportBuffer([{
      application_no: 'RETURN-TEST', application_date: '2026-08-05', site_code: 'HA02', sku: '1008002', qty: 3,
      reason: '1', confirmer_name: '確認人', confirmer_phone: '電話',
    }])) as never);
    const exportSheet = exportWorkbook.getWorksheet(RETURN_SHEET)!;
    RETURN_EXPORT_COLUMNS.forEach((column, index) => expect(exportSheet.getCell(1, index + 1).value).toBe(column));
    expect(exportSheet.getCell(2, 3).value).toBe('HA02');
    expect(exportSheet.getCell(2, 6).value).toContain('BUYER MEMO');
  });

  it('builds return import records grouped by store', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildReturnImportRecordBuffer([{
      row: 2, application_no: 'RETURN-A', site_code: 'HA02', sku: '1008003', qty: 2, reason: '1', confirmer_name: '甲', confirmer_phone: '電話', submitted_at: '2026-08-05 09:00:00',
    }])) as never);
    expect(workbook.getWorksheet('HA02')).toBeDefined();
    expect(workbook.getWorksheet('HA02')!.getCell(1, 2).value).toBe('申請編號');
  });
});
