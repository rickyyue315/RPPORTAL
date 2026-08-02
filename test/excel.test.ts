import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  SAP_COLUMNS,
  RP_TEAM_SHEET,
  SHOP_CODE_HEADER,
} from '../src/lib/fields.js';
import { parseImportWorkbook } from '../src/lib/excelImport.js';
import { generateTemplateWorkbook, buildSapExportBuffer } from '../src/lib/excelExport.js';

const storeCodes = new Set(['HA02', 'HA06', 'HB11']);

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
});

describe('generateTemplateWorkbook', () => {
  it('produces a valid xlsx with RP Team sheet', async () => {
    const buffer = await generateTemplateWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    expect(wb.getWorksheet(RP_TEAM_SHEET)).toBeDefined();
    const ws = wb.getWorksheet(RP_TEAM_SHEET)!;
    expect(ws.getCell(1, 1).value).toBe('Application Date');
    expect(ws.getCell(1, 11).value).toBe('Remark');
  });
});

describe('buildSapExportBuffer', () => {
  it('writes all columns in order', async () => {
    const rows = [
      {
        id: '1',
        application_no: 'NDRF-TEST',
        source: 'web' as const,
        site_code: 'HA02',
        requested_by_email: 'ha02@sasa.com',
        application_date: '2026-08-02',
        submitted_at: new Date().toISOString(),
        brand: 'NEG - NEOGENCE',
        sku: '110079623001',
        rp_type: 'ND',
        supply_source: '1 - Vendor (由供應商送貨到舖)',
        safety_stock: null,
        nd_code: null,
        rp_parameters_change_request: null,
        remark: null,
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
