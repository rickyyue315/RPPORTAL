import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildShopStockRfBuffer,
  buildShopStockStoreBuffer,
  buildShopStockTrendBuffer,
  buildShopStockWeekBuffer,
  filterAndSortWeekRows,
  normalizeWeekExportFilters,
  shopStockKindLabel,
} from '../src/services/shopStockExport.js';
import { monthsBeforeDateOnly } from '../src/lib/time.js';
import type {
  ShopStockSeriesPoint,
  ShopStockStoreView,
  ShopStockWeek,
  ShopStockWeekRow,
} from '../src/services/shopStock.js';

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

// ---------------------------------------------------------------------------
// 每店明細匯出（跟住畫面篩選）
// ---------------------------------------------------------------------------

function weekRow(over: Partial<ShopStockWeekRow> & { site_code: string }): ShopStockWeekRow {
  return {
    shop: '',
    om: '',
    shop_nature: '',
    shop_type: '',
    source_row: null,
    sku_count_0sale: null,
    excess_qty_0sale: null,
    excess_value_0sale: null,
    sku_count_over2: null,
    excess_qty_over2: null,
    excess_value_over2: null,
    excess_value_total: null,
    shop_stock_qty_cm: null,
    shop_stock_value_cm: null,
    sold_qty_p90d: null,
    net_sales_p90d: null,
    rf_sku_count: null,
    sku_carry_count: null,
    ovs_carry_ratio: null,
    ratio: null,
    ratio_over2: null,
    ratio_total: null,
    rank: null,
    prev_ratio: null,
    prev_rf_sku_count: null,
    rf_sku_delta: null,
    delta_pt: null,
    is_new: false,
    is_new_store: false,
    new_reason: null,
    first_seen: null,
    deadstock_value: null,
    shop_stock_value: null,
    wow_delta_pt: null,
    ...over,
  } as ShopStockWeekRow;
}

function mockWeek(rows: ShopStockWeekRow[]): ShopStockWeek {
  return {
    report_date: '2026-10-25',
    report_kind: 'weekly',
    prev_report_date: '2026-10-18',
    store_count: rows.length,
    company_ratio: 0.0839,
    new_store_grace_days: 90,
    totals: {
      store_count: rows.length,
      ratio: 0.0839,
      total_excess: 27840384.31,
      total_soh: 331846573.47,
      total_rf_sku: 478945,
      rf_store_count: rows.length,
      rf_sku_delta: -1655,
      total_sku_carry: 5000,
      ovs_carry_ratio: 0.1151,
    },
    rows,
  };
}

describe('normalizeWeekExportFilters', () => {
  it('falls back to the defaults for unknown values instead of failing the export', () => {
    expect(normalizeWeekExportFilters({})).toEqual({ q: '', sort: 'ratio_desc', only: '' });
    expect(normalizeWeekExportFilters({ sort: 'drop_table', only: 'nonsense' })).toEqual({
      q: '',
      sort: 'ratio_desc',
      only: '',
    });
    expect(normalizeWeekExportFilters({ q: '  HA02  ', sort: 'rf_desc', only: 'worse' })).toEqual({
      q: 'HA02',
      sort: 'rf_desc',
      only: 'worse',
    });
  });
});

describe('filterAndSortWeekRows（匯出 = 畫面所見）', () => {
  const rows = [
    weekRow({ site_code: 'HA02', shop: '沙田連城廣場', om: '李嘉欣', ratio: 0.1979, deadstock_value: 364000, shop_stock_value: 1839000, wow_delta_pt: -0.35, rf_sku_count: 4880, rank: 1 }),
    weekRow({ site_code: 'HD09', shop: '觀塘apm', om: '黃志明', ratio: 0.1755, deadstock_value: 298000, shop_stock_value: 1698000, wow_delta_pt: 0.81, rf_sku_count: 3990, rank: 2 }),
    weekRow({ site_code: 'HC63', shop: '旺角彌敦道', om: '陳大文', ratio: null, deadstock_value: null, shop_stock_value: 0, wow_delta_pt: null, rf_sku_count: 5210, rank: null }),
    weekRow({ site_code: 'HE15', shop: '將軍澳PopCorn', om: '鄭大文', ratio: 0.1432, deadstock_value: 178000, shop_stock_value: 1243000, wow_delta_pt: 1.06, rf_sku_count: 2540, rank: 3 }),
  ];

  it('searches across site code, shop, OM and shop nature (case-insensitive)', () => {
    const out = filterAndSortWeekRows(rows, normalizeWeekExportFilters({ q: 'hd09' }));
    expect(out.map((r) => r.site_code)).toEqual(['HD09']);
    const byOm = filterAndSortWeekRows(rows, normalizeWeekExportFilters({ q: '陳大文' }));
    expect(byOm.map((r) => r.site_code)).toEqual(['HC63']);
  });

  it('keeps only the shops that got worse (or better) on the WoW filter', () => {
    // 預設排序係佔比高 → 低，所以 HD09(0.1755) 在 HE15(0.1432) 前面
    const worse = filterAndSortWeekRows(rows, normalizeWeekExportFilters({ only: 'worse' }));
    expect(worse.map((r) => r.site_code)).toEqual(['HD09', 'HE15']);
    const better = filterAndSortWeekRows(rows, normalizeWeekExportFilters({ only: 'better' }));
    expect(better.map((r) => r.site_code)).toEqual(['HA02']);
  });

  it('sorts by the chosen column and always puts missing values last', () => {
    const asc = filterAndSortWeekRows(rows, normalizeWeekExportFilters({ sort: 'ratio_asc' }));
    expect(asc.map((r) => r.site_code)).toEqual(['HE15', 'HD09', 'HA02', 'HC63']);
    const rf = filterAndSortWeekRows(rows, normalizeWeekExportFilters({ sort: 'rf_desc' }));
    expect(rf[0]!.site_code).toBe('HC63');
    const excess = filterAndSortWeekRows(rows, normalizeWeekExportFilters({ sort: 'excess_desc' }));
    expect(excess[0]!.site_code).toBe('HA02');
  });
});

describe('buildShopStockWeekBuffer', () => {
  it('writes one row per shop with the on-screen columns and keeps nulls blank', async () => {
    const rows = [
      weekRow({ site_code: 'HA02', shop: '沙田連城廣場', om: '李嘉欣', shop_nature: '商場', ratio: 0.1979, deadstock_value: 364000, shop_stock_value: 1839000, wow_delta_pt: -0.35, rf_sku_count: 4880, rf_sku_delta: 12, ovs_carry_ratio: 0.198, rank: 1 }),
      weekRow({ site_code: 'HD09', shop: '觀塘apm', om: '黃志明', shop_nature: '商場', ratio: 0.1755, deadstock_value: 298000, shop_stock_value: 1698000, wow_delta_pt: 0.81, rf_sku_count: null, rf_sku_delta: null, ovs_carry_ratio: null, rank: 2 }),
      weekRow({ site_code: 'HC71', shop: '屯門市廣場', om: '張家明', shop_nature: '超級市場', ratio: 0.1, deadstock_value: 100, shop_stock_value: 1000, wow_delta_pt: 0.2, rf_sku_count: 100, rf_sku_delta: 0, ovs_carry_ratio: 0.1, rank: null, is_new: true, new_reason: 'new_store' }),
    ];
    const week = mockWeek(rows);
    const filters = normalizeWeekExportFilters({ sort: 'ratio_desc' });
    const buffer = await buildShopStockWeekBuffer({
      week,
      filters,
      rows: filterAndSortWeekRows(rows, filters),
      generatedAt: '2026-10-25 20:30:00',
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['每店明細', '匯出說明']);

    const sheet = workbook.getWorksheet('每店明細')!;
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell, col) => { headers[col - 1] = String(cell.value ?? ''); });
    expect(headers[0]).toBe('排名');
    expect(headers[1]).toBe('Site');
    expect(headers[7]).toBe('不良存貨 SKU ÷ 店內貨品');
    expect(headers[10]).toBe('不良存貨佔比');
    expect(headers[11]).toBe('不良存貨佔比 WoW（pp）');
    expect(headers[12]).toBe('狀態');

    // 排序：佔比高 → 低
    expect(sheet.getCell(2, 2).value).toBe('HA02');
    expect(sheet.getCell(3, 2).value).toBe('HD09');
    expect(sheet.getCell(4, 2).value).toBe('HC71');
    // 比率存小數、格式用百分比；金額用千分位
    expect(sheet.getCell(2, 11).value).toBeCloseTo(0.1979, 10);
    expect(sheet.getColumn(11).numFmt).toBe('0.0%');
    expect(sheet.getColumn(9).numFmt).toBe('#,##0');
    expect(sheet.getColumn(12).numFmt).toBe('+0.00;-0.00;0.00');
    // 缺值留空（唔係 0）
    expect(sheet.getCell(3, 6).value).toBeNull();
    expect(sheet.getCell(3, 8).value).toBeNull();
    // 真 0 要照寫 0（RF 較上期）
    expect(sheet.getCell(4, 7).value).toBe(0);
    // 新店照列但唔佔名次，並標明原因
    expect(sheet.getCell(4, 1).value).toBeNull();
    expect(sheet.getCell(4, 13).value).toBe('新店');

    const info = workbook.getWorksheet('匯出說明')!;
    const labels: string[] = [];
    info.eachRow((row, n) => { if (n > 1) labels.push(String(row.getCell(1).value ?? '')); });
    expect(labels).toContain('口徑');
    expect(labels).toContain('搜尋');
    expect(labels).toContain('排序');
    expect(labels).toContain('產生時間（HK）');
  });
});

describe('buildShopStockRfBuffer', () => {
  it('writes the trend plus both shop rankings and keeps the new-store exclusion', async () => {
    const week = mockWeek([
      weekRow({ site_code: 'HA02', shop: '沙田連城廣場', om: '李嘉欣', rf_sku_count: 4880, rf_sku_delta: 12, ovs_carry_ratio: 0.198, sku_count_0sale: 500, sku_carry_count: 2525, rank: 1 }),
      weekRow({ site_code: 'HD09', shop: '觀塘apm', om: '黃志明', rf_sku_count: 3990, rf_sku_delta: -30, ovs_carry_ratio: 0.1755, sku_count_0sale: 400, sku_carry_count: 2280, rank: 2 }),
      weekRow({ site_code: 'HC71', shop: '屯門市廣場', om: '張家明', rf_sku_count: 100, rf_sku_delta: 0, ovs_carry_ratio: 0.9, sku_count_0sale: 90, sku_carry_count: 100, rank: null, is_new: true, new_reason: 'new_store' }),
    ]);
    const buffer = await buildShopStockRfBuffer({
      series: [
        point({ report_date: '2026-10-18', total_rf_sku: 480600, rf_sku_delta: null, ovs_carry_ratio: 0.1147 }),
        point({ report_date: '2026-10-25', total_rf_sku: 478945, rf_sku_delta: -1655, ovs_carry_ratio: 0.1151 }),
      ],
      kpi: null,
      week,
      months: 12,
      generatedAt: '2026-10-25 20:30:00',
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    expect(workbook.worksheets.map((w) => w.name)).toEqual([
      'RF SKU 走勢',
      'RF SKU 店舖排名',
      '不良÷店內貨品 排名',
      '匯出說明',
    ]);

    const trend = workbook.getWorksheet('RF SKU 走勢')!;
    expect(trend.getCell(1, 4).value).toBe('RF SKU 合計');
    expect(trend.getCell(1, 7).value).toBe('不良存貨 SKU ÷ 店內貨品');
    expect(trend.getCell(2, 4).value).toBe(480600);
    expect(trend.getCell(3, 4).value).toBe(478945);
    // 較上期（pp）由相鄰兩期自己計：0.1151 - 0.1147 = 0.04pp
    expect(trend.getCell(3, 8).value).toBeCloseTo(0.04, 6);
    expect(trend.getColumn(7).numFmt).toBe('0.0%');

    // RF 排名：有有效 RF 數字嘅店（新店都參與，RF 係絕對數）
    const rfRank = workbook.getWorksheet('RF SKU 店舖排名')!;
    expect(rfRank.getCell(1, 6).value).toBe('RF SKU');
    expect(rfRank.getCell(2, 2).value).toBe('HA02');
    expect(rfRank.getCell(3, 2).value).toBe('HD09');
    expect(rfRank.getCell(4, 2).value).toBe('HC71');

    // 不良÷店內貨品排名：新店唔參與（同一套排除規則）
    const ovsRank = workbook.getWorksheet('不良÷店內貨品 排名')!;
    expect(ovsRank.getCell(1, 8).value).toBe('不良存貨 SKU ÷ 店內貨品');
    expect(ovsRank.actualRowCount).toBe(3); // 表頭 + 兩間店
    expect(ovsRank.getCell(2, 2).value).toBe('HA02');
    expect(ovsRank.getCell(3, 2).value).toBe('HD09');
  });
});

describe('buildShopStockStoreBuffer', () => {
  it('writes only the store own rows plus the company weighted line', async () => {
    const view: ShopStockStoreView = {
      has_data: true,
      site_code: 'HA02',
      series: [
        { report_date: '2026-10-18', report_kind: 'weekly', ratio: 0.099, wow_delta_pt: null, excess_value_0sale: 360000, shop_stock_value_cm: 3636000, ovs_carry_ratio: 0.19 },
        { report_date: '2026-10-25', report_kind: 'weekly', ratio: 0.0839, wow_delta_pt: -1.51, excess_value_0sale: 364000, shop_stock_value_cm: 4339000, ovs_carry_ratio: 0.198 },
      ],
      company_series: [
        { report_date: '2026-10-18', ratio: 0.0847, wow_delta_pt: null, ovs_carry_ratio: 0.1147 },
        { report_date: '2026-10-25', ratio: 0.0839, wow_delta_pt: -0.08, ovs_carry_ratio: 0.1151 },
      ],
      kpi: {
        report_date: '2026-10-25',
        report_kind: 'weekly',
        ratio: 0.0839,
        wow_delta_pt: -1.51,
        total_soh: 4339000,
        total_excess: 364000,
        sku_count_0sale: 500,
        shop_stock_value_cm: 4339000,
        excess_value_0sale: 364000,
        company_ratio: 0.0839,
        delta_vs_company_pt: 0,
        ovs_carry_ratio: 0.198,
        company_ovs_carry_ratio: 0.1151,
      },
      company_avg_ratio: 0.0839,
    };
    const buffer = await buildShopStockStoreBuffer({ view, generatedAt: '2026-10-25 20:30:00' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['本店走勢', '匯出說明']);

    const sheet = workbook.getWorksheet('本店走勢')!;
    expect(sheet.getCell(1, 3).value).toBe('不良存貨佔比');
    expect(sheet.getCell(1, 6).value).toBe('全公司加權佔比');
    expect(sheet.actualRowCount).toBe(3); // 表頭 + 兩期
    expect(sheet.getCell(2, 1).value).toBe('2026-10-18');
    expect(sheet.getCell(2, 3).value).toBeCloseTo(0.099, 10);
    expect(sheet.getCell(3, 1).value).toBe('2026-10-25');
    // 與全公司差距（pp）：0.0839 - 0.0839 = 0
    expect(sheet.getCell(3, 7).value).toBeCloseTo(0, 6);
    expect(sheet.getColumn(3).numFmt).toBe('0.0%');

    // 匯出說明要寫明店舖代號，同埋只含本店
    const info = workbook.getWorksheet('匯出說明')!;
    const labels: string[] = [];
    info.eachRow((row, n) => { if (n > 1) labels.push(String(row.getCell(1).value ?? '')); });
    expect(labels).toContain('店舖');
    expect(labels).toContain('口徑');
    // 「店舖」一列的內容 = 自己的 site code（唔會出現其他店）
    const siteValue = info.getCell(labels.indexOf('店舖') + 2, 2).value;
    expect(siteValue).toBe('HA02');
  });

  it('never writes the store stock value or the excess value into the workbook', async () => {
    const view: ShopStockStoreView = {
      has_data: true,
      site_code: 'HA02',
      series: [
        { report_date: '2026-10-18', report_kind: 'weekly', ratio: 0.099, wow_delta_pt: null, excess_value_0sale: 360000, shop_stock_value_cm: 3636000, ovs_carry_ratio: 0.19 },
        { report_date: '2026-10-25', report_kind: 'weekly', ratio: 0.0839, wow_delta_pt: -1.51, excess_value_0sale: 364000, shop_stock_value_cm: 4339000, ovs_carry_ratio: 0.198 },
      ],
      company_series: [
        { report_date: '2026-10-18', ratio: 0.0847, wow_delta_pt: null, ovs_carry_ratio: 0.1147 },
        { report_date: '2026-10-25', ratio: 0.0839, wow_delta_pt: -0.08, ovs_carry_ratio: 0.1151 },
      ],
      kpi: {
        report_date: '2026-10-25',
        report_kind: 'weekly',
        ratio: 0.0839,
        wow_delta_pt: -1.51,
        total_soh: 4339000,
        total_excess: 364000,
        sku_count_0sale: 500,
        shop_stock_value_cm: 4339000,
        excess_value_0sale: 364000,
        company_ratio: 0.0839,
        delta_vs_company_pt: 0,
        ovs_carry_ratio: 0.198,
        company_ovs_carry_ratio: 0.1151,
      },
      company_avg_ratio: 0.0839,
    };
    const buffer = await buildShopStockStoreBuffer({ view, generatedAt: '2026-10-25 20:30:00' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);

    // 表頭唔可以有金額欄
    const sheet = workbook.getWorksheet('本店走勢')!;
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell) => { headers.push(String(cell.value ?? '')); });
    expect(headers).not.toContain('店舖存貨值（CM）');
    expect(headers).not.toContain('不良存貨值（P90D 0 Sales）');
    expect(headers).toEqual([
      '期別', '週次', '不良存貨佔比', '較上期（pp）',
      '不良存貨 SKU ÷ 店內貨品', '全公司加權佔比', '與全公司差距（pp）',
    ]);

    // 全份 workbook（含說明頁）任何一個數值格都唔可以係金額
    const forbidden = new Set([360000, 3636000, 364000, 4339000, 500]);
    const hits: number[] = [];
    for (const ws of workbook.worksheets) {
      ws.eachRow((row) => {
        row.eachCell((cell) => {
          if (typeof cell.value === 'number' && forbidden.has(cell.value)) hits.push(cell.value);
        });
      });
    }
    expect(hits).toEqual([]);

    // 說明頁要講明刻意唔包含金額
    const info = workbook.getWorksheet('匯出說明')!;
    const labels: string[] = [];
    info.eachRow((row, n) => { if (n > 1) labels.push(String(row.getCell(1).value ?? '')); });
    expect(labels).toContain('不包含的資料');
  });
});
