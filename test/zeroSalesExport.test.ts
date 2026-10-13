import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildZeroSalesExportBuffer, type ZeroSalesExportItem } from '../src/lib/zeroSales.js';

const REASONS = ['1.無陳列', '2.貨放舖倉未上架', '6.其他（須填補充）'];
const STAT_SHEET = '店舖回覆 (原因)';
const STAT_HEADER_ROW = 4;

function item(overrides: Partial<ZeroSalesExportItem> & { stock?: string }): ZeroSalesExportItem {
  const { stock = '', ...rest } = overrides;
  return {
    site_code: 'HA02',
    sku: '1001',
    payload: {
      Brand: 'B1',
      'SKU Desc': 'Desc',
      Buyer: '103 - Terence Lee',
      'Adj. MCH1': 'M1',
      'Item Status': 'Active',
      'Supply Source': 'DC',
      'Shop Stock Qty (CM)': stock,
      'Shop Name': 'Shop',
      OM: 'OM1',
    },
    status: 'pending',
    reason_code: null,
    reason_label: null,
    reason_note: null,
    replied_at: null,
    replied_by: null,
    batch_label: '2026-W40',
    reply_count: 0,
    ...rest,
  };
}

async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
}

/** 以指定列為欄名，讀取其後的資料列 */
async function readSheet(buf: Buffer, name: string, headerRow = 1): Promise<Record<string, string | number>[]> {
  const wb = await loadWorkbook(buf);
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`missing sheet ${name}`);
  const headers: string[] = [];
  ws.getRow(headerRow).eachCell((cell, col) => { headers[col - 1] = String(cell.value ?? ''); });
  const rows: Record<string, string | number>[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const obj: Record<string, string | number> = {};
    headers.forEach((h, i) => {
      const v = row.getCell(i + 1).value;
      obj[h] = (v ?? '') as string | number;
    });
    rows.push(obj);
  });
  return rows;
}

describe('buildZeroSalesExportBuffer', () => {
  const items: ZeroSalesExportItem[] = [
    item({ site_code: 'HA02', sku: '1001', stock: '5', status: 'replied', reason_label: '1.無陳列', reply_count: 1 }),
    item({ site_code: 'HB11', sku: '1001', stock: '1,200' }),
    item({ site_code: 'HA06', sku: '1001', status: 'replied', reason_label: '6.其他（須填補充）', reply_count: 1 }),
    item({ site_code: 'HA02', sku: '2002', status: 'replied', reason_label: '1.無陳列', reply_count: 1 }),
    item({ site_code: 'HA02', sku: '3003', stock: '7' }),
    item({
      site_code: 'HA02',
      sku: '4004',
      stock: '9',
      payload: { Brand: 'B1', Buyer: '', 'Shop Stock Qty (CM)': '9' },
      status: 'replied',
      reason_label: '1.無陳列',
      reply_count: 1,
    }),
  ];

  it('包含四個工作表', async () => {
    const buf = await buildZeroSalesExportBuffer(items, REASONS);
    const wb = await loadWorkbook(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Zero Sales 回覆', '未回覆店舖', STAT_SHEET, 'Buyer 統計']);
  });

  it('店舖回覆 (原因)：樞紐版面，第3列群組標題、第4列欄名', async () => {
    const buf = await buildZeroSalesExportBuffer(items, REASONS);
    const ws = (await loadWorkbook(buf)).getWorksheet(STAT_SHEET)!;
    expect(ws.getCell(3, 1).value).toBe('計數 - Site Code');
    expect(ws.getCell(3, 9).value).toBe('店舖回覆 (原因)');
    // 標題底色 #DAEEF3
    expect(ws.getCell(3, 1).fill?.fgColor?.argb).toBe('FFDAEEF3');
    expect(ws.getCell(STAT_HEADER_ROW, 1).fill?.fgColor?.argb).toBe('FFDAEEF3');
    const headers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((c) => ws.getCell(STAT_HEADER_ROW, c).value);
    expect(headers).toEqual([
      'SKU', 'Brand', 'SKU Desc', 'Buyer', 'Adj. MCH1', 'Item Status', 'Supply Source', 'Shop Stock Qty (CM)(總計)',
      '1.無陳列', '2.貨放舖倉未上架', '6.其他（須填補充）', '總計',
    ]);
  });

  it('店舖回覆 (原因)：每 SKU 一行、重複 SKU 庫存加總、按原因計數，只列有回覆的 SKU', async () => {
    const buf = await buildZeroSalesExportBuffer(items, REASONS);
    const rows = await readSheet(buf, STAT_SHEET, STAT_HEADER_ROW);
    const dataRows = rows.filter((r) => r['SKU'] !== '合計');
    expect(dataRows.map((r) => r['SKU'])).toEqual(['1001', '2002', '4004']);

    const s1001 = dataRows.find((r) => r['SKU'] === '1001')!;
    expect(s1001['Brand']).toBe('B1');
    expect(s1001['SKU Desc']).toBe('Desc');
    expect(s1001['Buyer']).toBe('103 - Terence Lee');
    expect(s1001['Adj. MCH1']).toBe('M1');
    expect(s1001['Item Status']).toBe('Active');
    expect(s1001['Supply Source']).toBe('DC');
    expect(s1001['Shop Stock Qty (CM)(總計)']).toBe(1205);
    expect(s1001['1.無陳列']).toBe(1);
    expect(s1001['2.貨放舖倉未上架']).toBe(0);
    expect(s1001['6.其他（須填補充）']).toBe(1);
    expect(s1001['總計']).toBe(2);

    const s2002 = dataRows.find((r) => r['SKU'] === '2002')!;
    expect(s2002['Shop Stock Qty (CM)(總計)']).toBe('');
    expect(s2002['1.無陳列']).toBe(1);
    expect(s2002['總計']).toBe(1);
  });

  it('店舖回覆 (原因)：末行為合計', async () => {
    const buf = await buildZeroSalesExportBuffer(items, REASONS);
    const rows = await readSheet(buf, STAT_SHEET, STAT_HEADER_ROW);
    const total = rows.find((r) => r['SKU'] === '合計')!;
    expect(total['Shop Stock Qty (CM)(總計)']).toBe(1214);
    expect(total['1.無陳列']).toBe(3);
    expect(total['6.其他（須填補充）']).toBe(1);
    expect(total['總計']).toBe(4);
  });

  it('Buyer 統計：不重複 SKU 數、庫存總計、首2位原因，未設定 Buyer 歸入（未設定）', async () => {
    const buf = await buildZeroSalesExportBuffer(items, REASONS);
    const ws = (await loadWorkbook(buf)).getWorksheet('Buyer 統計')!;
    expect(ws.getCell(3, 1).value).toBe('店舖回覆 (原因)');
    const headers = [1, 2, 3, 4].map((c) => ws.getCell(STAT_HEADER_ROW, c).value);
    expect(headers).toEqual(['Buyer', 'SKU 數', 'Shop Stock Qty (CM)(總計)', '主要原因 (首2位)']);

    const rows = await readSheet(buf, 'Buyer 統計', STAT_HEADER_ROW);
    const dataRows = rows.filter((r) => r['Buyer'] !== '合計');
    // 同一 Buyer 內只計不重複 SKU；未回覆的 SKU 亦計入 SKU 數及庫存
    expect(dataRows.map((r) => r['Buyer'])).toEqual(['103 - Terence Lee', '（未設定）']);
    const buyer = dataRows.find((r) => r['Buyer'] === '103 - Terence Lee')!;
    expect(buyer['SKU 數']).toBe(3);
    expect(buyer['Shop Stock Qty (CM)(總計)']).toBe(1212);
    // 只有已回覆計入原因：1.無陳列 2 筆、6.其他 1 筆 → 首2位
    expect(buyer['主要原因 (首2位)']).toBe('1.無陳列 (2)；6.其他（須填補充） (1)');
    const unset = dataRows.find((r) => r['Buyer'] === '（未設定）')!;
    expect(unset['SKU 數']).toBe(1);
    expect(unset['Shop Stock Qty (CM)(總計)']).toBe(9);
    expect(unset['主要原因 (首2位)']).toBe('1.無陳列 (1)');

    const total = rows.find((r) => r['Buyer'] === '合計')!;
    // 合計的 SKU 數為全表不重複 SKU（1001/2002/3003/4004）
    expect(total['SKU 數']).toBe(4);
    expect(total['Shop Stock Qty (CM)(總計)']).toBe(1221);
    expect(total['主要原因 (首2位)']).toBe('1.無陳列 (3)；6.其他（須填補充） (1)');
  });

  it('Buyer 統計：按 SKU 數、庫存、名稱排序', async () => {
    const sortItems: ZeroSalesExportItem[] = [
      item({ sku: 'S1', payload: { Brand: 'B1', Buyer: '200 - B Buyer', 'Shop Stock Qty (CM)': '1' } }),
      item({ sku: 'S2', payload: { Brand: 'B1', Buyer: '200 - B Buyer', 'Shop Stock Qty (CM)': '1' } }),
      item({ sku: 'S3', payload: { Brand: 'B1', Buyer: '300 - A Buyer', 'Shop Stock Qty (CM)': '9' } }),
      item({ sku: 'S4', payload: { Brand: 'B1', Buyer: '100 - C Buyer', 'Shop Stock Qty (CM)': '3' } }),
    ];
    const buf = await buildZeroSalesExportBuffer(sortItems, REASONS);
    const rows = await readSheet(buf, 'Buyer 統計', STAT_HEADER_ROW);
    expect(rows.filter((r) => r['Buyer'] !== '合計').map((r) => r['Buyer'])).toEqual([
      '200 - B Buyer', '300 - A Buyer', '100 - C Buyer',
    ]);
  });

  it('未回覆店舖：新增店舖回覆 (原因) 彙總，無回覆則留空', async () => {
    const buf = await buildZeroSalesExportBuffer(items, REASONS);
    const rows = await readSheet(buf, '未回覆店舖');
    expect(rows.find((r) => r['Site Code'] === 'HA02')!['店舖回覆 (原因)']).toBe('1.無陳列 (3)');
    expect(rows.find((r) => r['Site Code'] === 'HB11')!['店舖回覆 (原因)']).toBe('');
    expect(rows.find((r) => r['Site Code'] === 'HA06')).toBeUndefined();
  });
});
