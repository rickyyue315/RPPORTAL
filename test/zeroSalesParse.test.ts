import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { ZERO_SALES_COLUMNS, parseZeroSalesWorkbook } from '../src/lib/zeroSales.js';

/** 用「欄名 → 值」建表，方便模擬原表加欄／換序 */
async function buildXlsx(headers: string[], rows: Array<Record<string, string>>, sheetName = '店舖90日零銷售Top 10 SKU回覆'): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  for (const r of rows) sheet.addRow(headers.map((h) => r[h] ?? ''));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const baseRow = (site: string, sku: string, extra: Record<string, string> = {}) => ({
  'Site Code': site,
  'Shop Name': '駱克',
  OM: 'IVY',
  'Shop Nature': 'Tourist',
  '店內庫存排名': '1',
  Buyer: '135 - Cherie Cheung',
  Brand: 'HES - HETRAS',
  SKU: sku,
  'SKU Desc': 'DIFFUSER',
  'Adj. MCH1': '03 - FRAGRANCE',
  'MAKE UP 分類': 'Non-MAKE UP',
  'RP Type': 'RF',
  'Safety Stock (現時)': '16',
  'Item Status': 'Active',
  'Supply Source': 'Warehouse',
  'Shop Stock Qty (LM)': '17',
  'Shop Stock Qty (CM)': '15',
  'Sold Qty (P90D)': '0',
  'Sold Qty (M-2)': '0',
  'Sold Qty (M-1)': '0',
  'Sold Qty (CM - MTD)': '0',
  'Shop On Order PO Qty (CM)': '0',
  '店舖回覆': '',
  ...extra,
});

describe('parseZeroSalesWorkbook', () => {
  it('標準 23 欄模板照舊可讀', async () => {
    const buf = await buildXlsx([...ZERO_SALES_COLUMNS], [baseRow('HA02', '111074804008')]);
    const r = await parseZeroSalesWorkbook(buf, new Set(['HA02']), 20000);
    expect(r.ok).toBe(true);
    expect(r.totalRows).toBe(1);
    expect(r.ignoredColumns).toEqual([]);
    expect(r.rows![0]!.data['Shop Stock Qty (LM)']).toBe('17');
    expect(r.rows![0]!.data['Shop Stock Qty (CM)']).toBe('15');
  });

  it('原表中間多插一欄（Shop Stock Qty (LLM)）仍可匯入，且各欄不會錯位', async () => {
    // 2026-11-17 真實情況：LLM 插在 Supply Source 之後，令整份表變成 24 欄
    const headers = [...ZERO_SALES_COLUMNS];
    headers.splice(15, 0, 'Shop Stock Qty (LLM)');
    const row = baseRow('HA02', '111074804008', { 'Shop Stock Qty (LLM)': '19', '店舖回覆': '已陳列當眼位' });
    const r = await parseZeroSalesWorkbook(await buildXlsx(headers, [row]), new Set(['HA02']), 20000);

    expect(r.ok).toBe(true);
    expect(r.totalRows).toBe(1);
    expect(r.ignoredColumns).toEqual(['Shop Stock Qty (LLM)']);
    const d = r.rows![0]!.data;
    expect(r.rows![0]!.siteCode).toBe('HA02');
    expect(r.rows![0]!.sku).toBe('111074804008');
    expect(d['Shop Stock Qty (LM)']).toBe('17'); // 不是 LLM 的 19
    expect(d['Shop Stock Qty (CM)']).toBe('15');
    expect(d['Sold Qty (P90D)']).toBe('0');
    expect(d['Shop On Order PO Qty (CM)']).toBe('0');
    expect(d['店舖回覆']).toBe('已陳列當眼位');
    expect(Object.keys(d).length).toBe(ZERO_SALES_COLUMNS.length); // 多出的欄位不寫入 payload
  });

  it('欄序調換仍按欄名對位', async () => {
    const headers = [...ZERO_SALES_COLUMNS].reverse();
    const r = await parseZeroSalesWorkbook(await buildXlsx(headers, [baseRow('HA02', '111074804008')]), new Set(), 20000);
    expect(r.ok).toBe(true);
    expect(r.rows![0]!.data['Shop Stock Qty (LM)']).toBe('17');
  });

  it('缺少必要欄位要明確指出缺哪一欄', async () => {
    const headers = ZERO_SALES_COLUMNS.filter((h) => h !== 'Sold Qty (P90D)');
    const r = await parseZeroSalesWorkbook(await buildXlsx([...headers], [baseRow('HA02', '111074804008')]), new Set(), 20000);
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]?.field).toBe('header');
    expect(r.errors?.[0]?.reason).toContain('Sold Qty (P90D)');
  });

  it('同店同 SKU 重複仍然要擋', async () => {
    const rows = [baseRow('HA02', '111074804008'), baseRow('HA02', '111074804008')];
    const r = await parseZeroSalesWorkbook(await buildXlsx([...ZERO_SALES_COLUMNS], rows), new Set(), 20000);
    expect(r.ok).toBe(false);
    expect(r.errors?.some((e) => e.reason.includes('重複'))).toBe(true);
  });

  it('未在門店主檔的 Site Code 仍然要擋', async () => {
    const r = await parseZeroSalesWorkbook(
      await buildXlsx([...ZERO_SALES_COLUMNS], [baseRow('ZZ99', '111074804008')]),
      new Set(['HA02']),
      20000,
    );
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]?.reason).toContain('門店主檔');
  });
});
