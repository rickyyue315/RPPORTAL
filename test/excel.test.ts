import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  SAP_COLUMNS,
  RP_TEAM_SHEET,
  SHOP_CODE_HEADER,
  URGENT_COLUMNS,
  URGENT_SHEET,
} from '../src/lib/fields.js';
import { parseImportWorkbook, parseUrgentImportWorkbook } from '../src/lib/excelImport.js';
import {
  generateTemplateWorkbook,
  buildSapExportBuffer,
  generateUrgentTemplateWorkbook,
  buildUrgentExportBuffer,
} from '../src/lib/excelExport.js';

const storeCodes = new Set(['HA02', 'HA06', 'HB11', 'HA19']);

async function makeWorkbookBuffer(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(RP_TEAM_SHEET);
  ws.addRow([...SAP_COLUMNS]);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function blankRow(): string[] {
  return Array(SAP_COLUMNS.length).fill('');
}

function dataRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const row = blankRow();
  const put = (name: string, val: string) => {
    row[SAP_COLUMNS.indexOf(name)] = val;
  };
  put(SHOP_CODE_HEADER, 'HA02');
  put('SKU', '110079623001');
  put('Brand', 'NEG - NEOGENCE');
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
    ws.addRow([...SAP_COLUMNS]);
    ws.addRow(dataRow());
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.field).toBe('sheet');
  });

  it('rejects wrong headers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(RP_TEAM_SHEET);
    ws.addRow(['Application Date', 'Requested by', 'Shop Code']);
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

  it('rejects rows over maxRows limit', async () => {
    const rows = Array.from({ length: 5 }, () => dataRow({ SKU: `sku${Math.random()}` }));
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
    const buffer = await urgentBuffer([['HA02', 'U-1', 5]]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
    expect(result.rows![0].siteCode).toBe('HA02');
    expect(result.rows![0].sku).toBe('U-1');
    expect(result.rows![0].qty).toBe(5);
  });

  it('rejects wrong sheet name', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Other');
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', 'U-1', 5]);
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

  it('rejects qty 0, 1001, decimals and text', async () => {
    const buffer = await urgentBuffer([
      ['HA02', 'U-A', 0],
      ['HA02', 'U-B', 1001],
      ['HA02', 'U-C', 1.5],
      ['HA02', 'U-D', 'abc'],
    ]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.filter((e) => e.field === 'QTY')).toHaveLength(4);
  });

  it('rejects unknown site code and empty sku', async () => {
    const buffer = await urgentBuffer([
      ['ZZ99', 'U-E', 2],
      ['HA02', '', 3],
    ]);
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.field === 'Site Code')).toBe(true);
    expect(result.errors?.some((e) => e.field === 'SKU')).toBe(true);
  });

  it('ignores blank rows', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(URGENT_SHEET);
    ws.addRow([...URGENT_COLUMNS]);
    ws.addRow(['HA02', 'U-F', 4]);
    ws.addRow([]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseUrgentImportWorkbook(buffer, storeCodes, 1000);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
  });
});

describe('generateUrgentTemplateWorkbook / buildUrgentExportBuffer', () => {
  it('produces an urgent template with Site Code | SKU | QTY headers', async () => {
    const buffer = await generateUrgentTemplateWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.getWorksheet(URGENT_SHEET)!;
    expect(ws.getCell(1, 1).value).toBe('Site Code');
    expect(ws.getCell(1, 2).value).toBe('SKU');
    expect(ws.getCell(1, 3).value).toBe('QTY');
  });

  it('writes urgent export with Application No. | Site Code | SKU | QTY', async () => {
    const buffer = await buildUrgentExportBuffer([
      { application_no: 'URGENT-TEST', site_code: 'HA02', sku: 'U-1', qty: 9 },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.getWorksheet(URGENT_SHEET)!;
    expect(ws.getCell(1, 1).value).toBe('Application No.');
    expect(ws.getCell(1, 2).value).toBe('Site Code');
    const data = ws.getRow(2);
    expect(data.getCell(1).value).toBe('URGENT-TEST');
    expect(data.getCell(2).value).toBe('HA02');
    expect(data.getCell(4).value).toBe(9);
  });
});
