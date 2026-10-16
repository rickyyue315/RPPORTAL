import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildZeroSalesStoreExportBuffer,
  ZERO_SALES_STORE_EXPORT_COLUMNS,
  type ZeroSalesStoreExportItem,
} from '../src/lib/zeroSales.js';

function item(overrides: Partial<ZeroSalesStoreExportItem> = {}): ZeroSalesStoreExportItem {
  return {
    week_label: '2026-W42',
    sku: '1001',
    payload: {
      Brand: 'EYG - EO YUNG GAM(HAN BANG)',
      'SKU Desc': 'Lip Gloss 4g',
      'Shop Stock Qty (CM)': '12',
      'RP Type': 'RP',
      'Safety Stock (現時)': '8',
    },
    status: 'pending',
    reason_label: null,
    reason_note: null,
    batch_date: '2026-10-14',
    occurrence_count: 1,
    prev_week_label: null,
    prev_status: null,
    prev_reason_label: null,
    ...overrides,
  };
}

async function readSheet(buf: Buffer): Promise<{ headers: string[]; rows: Record<string, string | number>[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const ws = wb.getWorksheet('零銷售回覆');
  if (!ws) throw new Error('missing sheet 零銷售回覆');
  expect(wb.worksheets).toHaveLength(1);
  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => { headers[col - 1] = String(cell.value ?? ''); });
  const rows: Record<string, string | number>[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return;
    const obj: Record<string, string | number> = {};
    headers.forEach((h, i) => {
      const v = row.getCell(i + 1).value;
      // 換行儲存格（label\nnote）以 rich text / 文字保留
      obj[h] = typeof v === 'object' && v !== null && 'richText' in v
        ? (v as { richText: Array<{ text?: string }> }).richText.map((t) => t.text ?? '').join('')
        : (v ?? '') as string | number;
    });
    rows.push(obj);
  });
  return { headers, rows };
}

describe('buildZeroSalesStoreExportBuffer', () => {
  it('欄名為店舖版面指定的 11 欄', async () => {
    const buf = await buildZeroSalesStoreExportBuffer([item()]);
    const { headers } = await readSheet(buf);
    expect(headers).toEqual([...ZERO_SALES_STORE_EXPORT_COLUMNS]);
    expect(headers).toEqual(['週次', 'Brand', 'SKU', '描述', 'SKU上載日期', '狀態', '店舖本次回覆', '重複提示', '存貨量', 'RP Type', 'Safety Stock']);
  });

  it('已回覆行：狀態=已回覆、本次回覆=原因+補充（兩行）、存貨量為數字', async () => {
    const buf = await buildZeroSalesStoreExportBuffer([
      item({ status: 'replied', reason_label: '1.無陳列', reason_note: '已安排下週陳列' }),
    ]);
    const { rows } = await readSheet(buf);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r['週次']).toBe('2026-W42');
    expect(r['Brand']).toBe('EYG - EO YUNG GAM(HAN BANG)');
    expect(r['SKU']).toBe('1001');
    expect(r['描述']).toBe('Lip Gloss 4g');
    expect(r['SKU上載日期']).toBe('2026-10-14');
    expect(r['狀態']).toBe('已回覆');
    expect(r['店舖本次回覆']).toBe('1.無陳列\n已安排下週陳列');
    expect(r['重複提示']).toBe('');
    expect(r['存貨量']).toBe(12);
    expect(r['RP Type']).toBe('RP');
    expect(r['Safety Stock']).toBe('8');
  });

  it('未回覆行：本次回覆為空白；只有原因無補充時不留空行', async () => {
    const buf = await buildZeroSalesStoreExportBuffer([
      item({ sku: '2002' }),
      item({ sku: '3003', status: 'replied', reason_label: '2.貨放舖倉未上架', reason_note: '' }),
    ]);
    const { rows } = await readSheet(buf);
    expect(rows[0]!['狀態']).toBe('未回覆');
    expect(rows[0]!['店舖本次回覆']).toBe('');
    expect(rows[1]!['店舖本次回覆']).toBe('2.貨放舖倉未上架');
  });

  it('重複上榜：第N次上榜 + 上次週次及原因；首次上榜為空白', async () => {
    const buf = await buildZeroSalesStoreExportBuffer([
      item({
        sku: '4004',
        occurrence_count: 2,
        prev_week_label: '2026-W41',
        prev_status: 'replied',
        prev_reason_label: '1.無陳列',
      }),
      item({ sku: '5005', occurrence_count: 3, prev_week_label: '2026-W41', prev_status: 'pending' }),
    ]);
    const { rows } = await readSheet(buf);
    expect(rows[0]!['重複提示']).toBe('第2次上榜（上次 2026-W41：1.無陳列）');
    // 上次未回覆：顯示「未回覆」，提醒仍未改善
    expect(rows[1]!['重複提示']).toBe('第3次上榜（上次 2026-W41：未回覆）');
  });

  it('存貨量：千分位轉數字、非數字保留原文、空白留空', async () => {
    const buf = await buildZeroSalesStoreExportBuffer([
      item({ sku: 'A1', payload: { 'Shop Stock Qty (CM)': '1,200' } }),
      item({ sku: 'A2', payload: { 'Shop Stock Qty (CM)': 'N/A' } }),
      item({ sku: 'A3', payload: {} }),
    ]);
    const { rows } = await readSheet(buf);
    expect(rows[0]!['存貨量']).toBe(1200);
    expect(rows[1]!['存貨量']).toBe('N/A');
    expect(rows[2]!['存貨量']).toBe('');
  });

  it('表頭有底色、全份字體 Arial 10、首列凍結', async () => {
    const buf = await buildZeroSalesStoreExportBuffer([item()]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const ws = wb.getWorksheet('零銷售回覆')!;
    expect(ws.getCell(1, 1).font).toMatchObject({ name: 'Arial', size: 10, bold: true });
    expect(ws.getCell(1, 1).fill?.fgColor?.argb).toBe('FFDAEEF3');
    expect(ws.getCell(2, 3).font).toMatchObject({ name: 'Arial', size: 10 });
    expect(ws.views).toHaveLength(1);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });
});
