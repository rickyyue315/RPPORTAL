import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildShopStockTrendBuffer, shopStockKindLabel } from '../src/services/shopStockExport.js';
import { monthsBeforeDateOnly } from '../src/lib/time.js';
import type { ShopStockSeriesPoint } from '../src/services/shopStock.js';

/**
 * 匯出純函式的單元測試（不碰 DB）：驗證欄位、格式、缺值留空（不是 0），
 * 以及 PPT 工作表與明細表數值一致。
 */

function point(over: Partial<ShopStockSeriesPoint> & { report_date: string }): ShopStockSeriesPoint {
  return {
    report_kind: 'weekly',
    store_count: 3,
    ratio_store_count: 3,
    excluded_store_count: 0,
    total_excess: 100,
    total_excess_over2: 40,
    total_excess_total: 140,
    total_soh: 1000,
    sku_count_0sale: 7,
    total_rf_sku: 4800,
    rf_store_count: 3,
    rf_sku_delta: null,
    ratio: 0.1,
    ratio_over2: 0.04,
    ratio_total: 0.14,
    wow_delta_pt: null,
    ...over,
  } as ShopStockSeriesPoint;
}

describe('monthsBeforeDateOnly', () => {
  it('shifts back by whole months and clamps to the end of the month', () => {
    expect(monthsBeforeDateOnly('2026-10-25', 12)).toBe('2025-10-25');
    expect(monthsBeforeDateOnly('2026-03-31', 1)).toBe('2026-02-28');
    expect(monthsBeforeDateOnly('2026-01-15', 13)).toBe('2024-12-15');
  });

  it('returns an empty string for malformed input', () => {
    expect(monthsBeforeDateOnly('2026-1-5', 1)).toBe('');
    expect(monthsBeforeDateOnly('', 1)).toBe('');
  });
});

describe('buildShopStockTrendBuffer', () => {
  it('keeps a null ratio blank (never 0) and mirrors it on the PPT sheet', async () => {
    const rows = [
      point({ report_date: '2026-09-27', ratio: null, total_soh: 0, wow_delta_pt: null }),
      point({ report_date: '2026-10-04', ratio: 0.085, wow_delta_pt: 8.5 }),
      point({ report_date: '2026-10-25', ratio: 0.0876, wow_delta_pt: 0.26 }),
    ];
    const buffer = await buildShopStockTrendBuffer({
      rows,
      kpi: {
        report_date: '2026-10-25',
        report_kind: 'weekly',
        store_count: 3,
        total_excess: 100,
        total_excess_over2: 40,
        total_excess_total: 140,
        total_soh: 1000,
        sku_count_0sale: 7,
        total_rf_sku: 4800,
        rf_store_count: 3,
        rf_sku_delta: 12,
        ratio: 0.0876,
        ratio_over2: 0.04,
        ratio_total: 0.14,
        prev_report_date: '2026-10-04',
        wow_delta_pt: 0.26,
        wow_delta_pt_over2: 0,
        wow_delta_pt_total: 0,
      },
      companyAvgRatio: 0.0876,
      months: 12,
      generatedAt: '2026-10-25 20:30:00',
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['佔比趨勢', 'PPT 圖表用', '匯出說明']);

    const detail = workbook.getWorksheet('佔比趨勢')!;
    expect(detail.getRow(1).getCell(1).value).toBe('期別');
    expect(detail.getRow(1).getCell(14).value).toBe('0 Sale SKU 數');
    // 同一份資料亦帶出 RF SKU 數字
    expect(detail.getRow(1).getCell(15).value).toBe('RF SKU 合計');
    expect(detail.getRow(1).getCell(16).value).toBe('RF 資料店數');
    expect(detail.getRow(1).getCell(17).value).toBe('RF SKU 較上期');
    expect(detail.getRow(2).getCell(15).value).toBe(4800);
    expect(detail.getRow(2).getCell(16).value).toBe(3);
    expect(detail.getRow(2).getCell(17).value).toBeNull();
    expect(detail.getRow(2).getCell(1).value).toBe('2026-09-27');
    expect(detail.getRow(2).getCell(2).value).toBe('27Sep2026');
    expect(detail.getRow(2).getCell(3).value).toBe('週更');
    // 分母 0 → 比率 null，儲存格留空（若寫 0 會畫出一條假 0% 線）
    expect(detail.getRow(2).getCell(8).value).toBeNull();
    expect(detail.getRow(3).getCell(8).value).toBeCloseTo(0.085, 10);
    expect(detail.getRow(3).getCell(9).value).toBeCloseTo(8.5, 10);
    expect(detail.getColumn(8).numFmt).toBe('0.0%');
    expect(detail.getColumn(1).numFmt).toBe('@');

    const ppt = workbook.getWorksheet('PPT 圖表用')!;
    expect(ppt.actualRowCount).toBe(4);
    expect(ppt.getCell(2, 1).value).toBe('2026-09-27');
    expect(ppt.getCell(2, 2).value).toBeNull();
    expect(ppt.getCell(4, 2).value).toBeCloseTo(0.0876, 10);
    expect(ppt.getColumn(2).numFmt).toBe('0.0%');

    const info = workbook.getWorksheet('匯出說明')!;
    const labels: string[] = [];
    info.eachRow((row, n) => { if (n > 1) labels.push(String(row.getCell(1).value ?? '')); });
    expect(labels).toContain('口徑');
    expect(labels).toContain('產生時間（HK）');
    expect(labels).toContain('RF SKU 合計（全公司）');
  });

  it('still produces a valid workbook when there is no data at all', async () => {
    const buffer = await buildShopStockTrendBuffer({
      rows: [],
      kpi: null,
      companyAvgRatio: null,
      months: 3,
      generatedAt: '2026-10-25 20:30:00',
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    expect(workbook.getWorksheet('佔比趨勢')!.actualRowCount).toBe(1);
    expect(workbook.getWorksheet('PPT 圖表用')!.actualRowCount).toBe(1);
  });
});

describe('shopStockKindLabel', () => {
  it('maps the three authoritative report kinds and falls back safely', () => {
    expect(shopStockKindLabel('weekly')).toBe('週更');
    expect(shopStockKindLabel('month_end')).toBe('月結');
    expect(shopStockKindLabel('ad_hoc')).toBe('臨時');
    expect(shopStockKindLabel(null)).toBe('—');
  });
});
