import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { setPoolForTesting } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { parseShopStockWorkbook } from '../src/lib/shopStockXlsx.js';
import {
  deleteShopStockBatch,
  deriveWeekLabel,
  getShopStockForStore,
  getShopStockSummary,
  getShopStockWeek,
  listShopStockBatches,
  ShopStockDateConflictError,
  ShopStockImportError,
  updateShopStockBatch,
  upsertShopStockBatch,
} from '../src/services/shopStock.js';
import { createPortalSession } from '../src/services/portalAuth.js';

/**
 * 「By Shop」不良存貨 Dashboard 測試。
 *
 * ⚠ 測試夾具**不包含真實報表**（真實檔含店舖金額）。所有 xlsx 都在執行時用
 *   jszip 動態產生，並刻意模擬上游匯出工具的非標準格式：`x:` 命名空間前綴、
 *   row/cell 無 `r` 座標、空白行自閉合。金額全部是假數。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makePglitePool(db: PGlite): never {
  const clientLike = {
    async query(text: string, params?: unknown[]) {
      return db.query(text, params ?? []);
    },
    release: () => {},
  };
  return {
    query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
    connect: async (): Promise<PoolClient> => clientLike as PoolClient,
  } as never;
}

const MIGRATIONS = [
  '001_init.sql',
  '002_drop_rp_type_completed_at.sql',
  '003_add_submission_type_qty.sql',
  '004_add_urgent_reason.sql',
  '005_add_sales_submission_type.sql',
  '006_add_return_submission_type.sql',
  '007_add_idempotency_and_import_recovery.sql',
  '008_add_export_file_archive.sql',
  '009_architecture_hardening.sql',
  '010_query_optimization.sql',
  '011_cleanup_legacy_schema.sql',
  '012_om_recovery_codes.sql',
  '013_recovery_code_plaintext.sql',
  '014_ndrf_workflow_portal.sql',
  '015_buyer_auto_approve.sql',
  '016_round_started_at.sql',
  '017_zero_sales.sql',
  '018_zero_sales_reasons.sql',
  '019_zero_sales_edit_once.sql',
  '020_portal_users_initial_password.sql',
  '021_store_passwordless.sql',
  '022_portal_passwordless.sql',
  '023_zero_sales_repeat_index.sql',
  '024_zero_sales_archive.sql',
  '025_zero_sales_auto_reply.sql',
  '026_shop_stock_snapshots.sql',
];

let db: PGlite;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting(makePglitePool(db));
  for (const file of MIGRATIONS) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    // PGlite 內建 gen_random_uuid，pgcrypto extension 在 WASM build 未必可用
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  app = createApp();
});

// ---------------------------------------------------------------------------
// 夾具：模擬上游「非標準」xlsx
// ---------------------------------------------------------------------------

/** 報表 36 欄表頭（與真實檔一致，含半形 * 與 &） */
const HEADERS = [
  'Shop',
  'Site Code',
  'Site Chin Desc',
  'OM',
  'Shop Nature',
  'Shop Type',
  'No. of SKU Carry',
  'No. of RF SKU',
  'No. of ND SKU with Stock',
  'No. of OOS SKU',
  'No. of OOS SKU with replenish',
  'No. of OOS SKU w/o replenish',
  'No. of Potential OOS SKU',
  'No. of Potential OOS SKU with replenish',
  'No. of Potential OOS SKU w/o replenish',
  'No. of Overstock SKU',
  'No. of Overstock SKU (P90D 0 Sales)',
  'No. of Overstock SKU (>2*Monthly Sold Qty & >2pcs)',
  'Excess Stock Qty (P90D 0 Sales)',
  'Excess Stock Qty (>2*Monthly Sold Qty & >2pcs)',
  'Excess Stock Qty',
  'Excess Stock Value (P90D 0 Sales)',
  'Excess Stock Value (>2*Monthly Sold Qty & >2pcs)',
  'Excess Stock Value',
  'Shop Stock Qty (CM)',
  'Shop Stock Value (CM)',
  'Shop Turnday (90D COGS)',
  'Sold Qty (P90D)',
  'Sold Qty (M-2)',
  'Sold Qty (M-1)',
  'Sold Qty (CM - MTD)',
  'Net Sales (P90D)',
  'Net Sales (M-2)',
  'Net Sales (M-1)',
  'Net Sales (CM - MTD)',
  'P90D Daily COGS',
];

type CellValue = string | number | null;

/** 用「欄名 → 值」建一列（36 欄），未指定的欄留空 */
function makeRow(values: Record<string, CellValue>): CellValue[] {
  return HEADERS.map((header) => values[header] ?? null);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 單一格；刻意不寫 `r` 座標（模擬上游），空格寫成自閉合 `<x:c />` */
function cellXml(value: CellValue): string {
  if (value === null || value === '') return '<x:c />';
  if (typeof value === 'number') return `<x:c><x:v>${value}</x:v></x:c>`;
  return `<x:c t="inlineStr"><x:is><x:t>${escapeXml(String(value))}</x:t></x:is></x:c>`;
}

/**
 * 產生非標準 xlsx：
 *   * 所有 XML part 的元素帶 `x:` 前綴、`xmlns:x=`
 *   * `<x:row>` / `<x:c>` 無 `r` 座標
 *   * 傳入空陣列 = 全空白列 → 自閉合 `<x:row />`
 */
async function buildNonStandardXlsx(
  rows: CellValue[][],
  headers: string[] = HEADERS,
): Promise<Buffer> {
  const rowXml = [headers as CellValue[], ...rows]
    .map((cells) => (cells.length === 0 ? '<x:row />' : `<x:row>${cells.map(cellXml).join('')}</x:row>`))
    .join('');

  const zip = new JSZip();
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="utf-8"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>${rowXml}</x:sheetData></x:worksheet>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Export" sheetId="1" r:id="R1" /></x:sheets></x:workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml" Id="R1" /></Relationships>`,
  );
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="utf-8"?><x:styleSheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:fonts><x:font /></x:fonts><x:fills><x:fill><x:patternFill patternType="none" /></x:fill></x:fills><x:borders><x:border /></x:borders><x:cellXfs><x:xf /></x:cellXfs></x:styleSheet>`,
  );
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" /><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" /></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml" Id="R0" /></Relationships>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** 列 A = Total 的全公司合計列（Site Code 刻意撞 HA02，模擬真實檔） */
function totalRow(soh: number, excess: number): CellValue[] {
  return makeRow({
    Shop: 'Total',
    'Site Code': 'HA02',
    'Site Chin Desc': 'AIRSIDE',
    OM: 'CANDY',
    'Shop Nature': 'Mix',
    'Shop Type': 'EXISTING',
    'No. of Overstock SKU (P90D 0 Sales)': 12,
    'Excess Stock Value (P90D 0 Sales)': excess,
    'Shop Stock Value (CM)': soh,
  });
}

/** 頁腳列：只有 A 欄有字（真實檔係 `Applied filters: …`） */
const FOOTER_ROW: CellValue[] = ['Applied filters: dummy filter (I14 Shop Summary) is not 0'];

/** 空白列（自閉合 `<x:row />`） */
const BLANK_ROW: CellValue[] = [];

const ROW_HA02 = makeRow({
  Shop: 'HA02 - 駱克',
  'Site Code': 'HA02',
  'Site Chin Desc': '駱克',
  OM: 'IVY',
  'Shop Nature': 'Local',
  'Shop Type': 'EXISTING',
  'No. of Overstock SKU (P90D 0 Sales)': 5,
  'No. of Overstock SKU (>2*Monthly Sold Qty & >2pcs)': 8,
  'Excess Stock Qty (P90D 0 Sales)': 40,
  'Excess Stock Qty (>2*Monthly Sold Qty & >2pcs)': 90,
  // 千分位逗號（字串）→ 解析時必須去掉
  'Excess Stock Value (P90D 0 Sales)': '100,000.25',
  'Excess Stock Value (>2*Monthly Sold Qty & >2pcs)': 310000,
  'Excess Stock Value': 410000.25,
  'Shop Stock Qty (CM)': 5000,
  'Shop Stock Value (CM)': 1000000,
  'Sold Qty (P90D)': 1200,
  'Net Sales (P90D)': 2500000,
});

const ROW_HD09 = makeRow({
  Shop: 'HD09 - 新威尼斯人',
  'Site Code': 'HD09',
  'Site Chin Desc': '新威尼斯人',
  OM: 'WINDY',
  'Shop Nature': 'Tourist',
  'Shop Type': 'EXISTING',
  'No. of Overstock SKU (P90D 0 Sales)': 7,
  'Excess Stock Value (P90D 0 Sales)': 59999.75,
  'Shop Stock Value (CM)': 3000000,
  'Sold Qty (P90D)': 4000,
  'Net Sales (P90D)': 9000000,
});

/** SOH = 0 → 比率必須回 null，且不可拉低全公司加權比率 */
const ROW_HC71 = makeRow({
  Shop: 'HC71 - 東涌',
  'Site Code': 'HC71',
  'Site Chin Desc': '東涌',
  OM: 'IVY',
  'Shop Nature': 'Local',
  'Shop Type': 'NEW STORE',
  'No. of Overstock SKU (P90D 0 Sales)': 1,
  'Excess Stock Value (P90D 0 Sales)': 500,
  'Shop Stock Value (CM)': 0,
});

/**
 * 主夾具：3 間店（其中 1 間 SOH = 0）+ Total 列 + 空白列 + 頁腳列。
 * 加權比率 = (100000.25 + 59999.75) / (1000000 + 3000000) = 0.04
 * 盲目取平均會得到 ≈ 0.06，正好用來驗證加權數學。
 */
const FIXTURE_MAIN = [ROW_HA02, ROW_HD09, ROW_HC71, totalRow(4000000, 160000), BLANK_ROW, FOOTER_ROW];

/** 第二期：全公司加權比率 = 200000 / 2000000 = 0.10（WoW = +6pt） */
const FIXTURE_WEEK2 = [
  makeRow({
    Shop: 'HA02 - 駱克',
    'Site Code': 'HA02',
    'Excess Stock Value (P90D 0 Sales)': 200000,
    'Shop Stock Value (CM)': 1000000,
  }),
  makeRow({
    Shop: 'HD09 - 新威尼斯人',
    'Site Code': 'HD09',
    'Excess Stock Value (P90D 0 Sales)': 0,
    'Shop Stock Value (CM)': 1000000,
  }),
  makeRow({
    Shop: 'HC71 - 東涌',
    'Site Code': 'HC71',
    'Excess Stock Value (P90D 0 Sales)': 500,
    'Shop Stock Value (CM)': 0,
  }),
  totalRow(2000000, 200000),
  BLANK_ROW,
  FOOTER_ROW,
];

async function upload(reportDate: string, rows: CellValue[][], extra: { note?: string; kind?: string } = {}) {
  return upsertShopStockBatch({
    buffer: await buildNonStandardXlsx(rows),
    reportDate,
    reportKind: extra.kind ?? 'weekly',
    note: extra.note ?? '',
    uploadedBy: 'tester',
    maxRows: 500,
  });
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

describe('shopStock xlsx parser', () => {
  it('rejects a workbook whose header lost a required column', async () => {
    const headers = HEADERS.map((h) => (h === 'Shop Stock Value (CM)' ? 'Shop Stock Value (LM)' : h));
    const parsed = await parseShopStockWorkbook(await buildNonStandardXlsx([ROW_HA02], headers), 500);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors?.[0]?.field).toBe('header');
    expect(parsed.errors?.[0]?.reason).toContain('Shop Stock Value (CM)');
  });

  it('drops the Column A = Total row, blank row and footer row, then maps values', async () => {
    const parsed = await parseShopStockWorkbook(await buildNonStandardXlsx(FIXTURE_MAIN), 500);
    expect(parsed.errors).toBeUndefined();
    expect(parsed.ok).toBe(true);
    // 3 間真店；Total 列雖然 Site Code 撞 HA02，但已先被剔除，所以不算重複
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.skipped).toEqual({ total: 1, blank: 1, footer: 1 });
    expect(parsed.sourceRows).toBe(6);

    const ha02 = parsed.rows!.find((r) => r.siteCode === 'HA02')!;
    expect(ha02.shop).toBe('HA02 - 駱克');
    expect(ha02.om).toBe('IVY');
    expect(ha02.shopNature).toBe('Local');
    expect(ha02.shopType).toBe('EXISTING');
    expect(ha02.sourceRow).toBe(2);
    // 千分位逗號已去除
    expect(ha02.excessValue0sale).toBeCloseTo(100000.25, 6);
    expect(ha02.excessValueOver2).toBeCloseTo(310000, 6);
    expect(ha02.excessValueTotal).toBeCloseTo(410000.25, 6);
    expect(ha02.shopStockValueCm).toBeCloseTo(1000000, 6);
    expect(ha02.skuCount0sale).toBe(5);
    expect(ha02.skuCountOver2).toBe(8);
    expect(ha02.soldQtyP90d).toBeCloseTo(1200, 6);
    expect(ha02.netSalesP90d).toBeCloseTo(2500000, 6);

    // 空值必須是 null，不可變成 0
    const hc71 = parsed.rows!.find((r) => r.siteCode === 'HC71')!;
    expect(hc71.shopStockValueCm).toBe(0);
    expect(hc71.soldQtyP90d).toBeNull();
    expect(hc71.excessQtyOver2).toBeNull();

    expect(Object.keys(ha02.payload)).toHaveLength(HEADERS.length);
    expect(ha02.payload['Site Code']).toBe('HA02');
  });

  it('reports duplicate site codes (only after Total removal) with row numbers', async () => {
    const duplicate = makeRow({
      Shop: 'HA02 - 駱克 (重複)',
      'Site Code': 'HA02',
      'Excess Stock Value (P90D 0 Sales)': 1,
      'Shop Stock Value (CM)': 1,
    });
    const parsed = await parseShopStockWorkbook(
      await buildNonStandardXlsx([ROW_HA02, ROW_HD09, duplicate, totalRow(1, 1)]),
      500,
    );
    expect(parsed.ok).toBe(false);
    const dupError = parsed.errors?.find((e) => e.siteCode === 'HA02');
    expect(dupError?.reason).toContain('重複');
    expect(dupError?.reason).toContain('4');
  });

  it('still reads a standard xlsx produced by ExcelJS', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Export');
    sheet.addRow(HEADERS as unknown as string[]);
    sheet.addRow(ROW_HA02 as unknown as (string | number | null)[]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = await parseShopStockWorkbook(buffer, 500);
    expect(parsed.ok).toBe(true);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows![0]!.siteCode).toBe('HA02');
    expect(parsed.rows![0]!.excessValue0sale).toBeCloseTo(100000.25, 6);
  });

  it('returns an error (not a throw) for a non-xlsx buffer', async () => {
    const parsed = await parseShopStockWorkbook(Buffer.from('not a zip'), 500);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors?.[0]?.reason).toContain('無法讀取');
  });
});

// ---------------------------------------------------------------------------
// Service：上載 / 取代 / 趨勢
// ---------------------------------------------------------------------------

describe('shopStock service', () => {
  it('stores the first batch and reports unknown site codes as a warning', async () => {
    await db.query("INSERT INTO stores (site_code, shop) VALUES ('HA02', '駱克'), ('HD09', '新威尼斯人') ON CONFLICT DO NOTHING");
    const result = await upload('2026-10-25', FIXTURE_MAIN, { note: '第一期' });
    expect(result.replaced).toBe(false);
    expect(result.noop).toBe(false);
    expect(result.batch.report_date).toBe('2026-10-25');
    expect(result.batch.week_label).toBe('25Oct2026');
    expect(result.batch.report_kind).toBe('weekly');
    expect(result.batch.row_count).toBe(3);
    expect(result.batch.store_count).toBe(3);
    expect(result.batch.source_rows).toBe(6);
    expect(result.batch.skipped_rows).toBe(3);
    expect(result.skipped).toEqual({ total: 1, blank: 1, footer: 1 });
    // 前端批次表顯示 content_hash_short（前 8 位）
    expect(result.batch.content_hash_short).toHaveLength(8);
    expect(result.batch.content_hash.startsWith(result.batch.content_hash_short)).toBe(true);
    // HC71 未入 stores 主檔：只警告，不阻塞
    expect(result.unknownSites).toEqual(['HC71']);
  });

  it('computes the company ratio as weighted Σexcess / ΣSOH (never an average of store ratios)', async () => {
    const summary = await getShopStockSummary();
    const point = summary.series.find((p) => p.report_date === '2026-10-25')!;
    expect(point.total_soh).toBeCloseTo(4000000, 6);
    expect(point.total_excess).toBeCloseTo(160000, 6);
    // 加權：160000 / 4000000 = 0.04；若錯用各店平均會是 ≈ 0.06
    expect(point.ratio).toBeCloseTo(0.04, 10);
    expect(point.ratio).not.toBeCloseTo(0.06, 2);
    expect(point.store_count).toBe(3);
    expect(point.ratio_store_count).toBe(2);
    expect(point.excluded_store_count).toBe(1);
    expect(point.wow_delta_pt).toBeNull();
    expect(summary.company_avg_ratio).toBeCloseTo(0.04, 10);
  });

  it('returns null (not 0) for a store whose stock value is 0', async () => {
    const view = await getShopStockForStore('HC71');
    expect(view.has_data).toBe(true);
    expect(view.series[0]!.ratio).toBeNull();
    expect(view.kpi!.ratio).toBeNull();
    expect(view.kpi!.wow_delta_pt).toBeNull();
    expect(view.company_avg_ratio).toBeCloseTo(0.04, 10);
  });

  it('exposes the store KPI fields the portal page reads', async () => {
    const view = await getShopStockForStore('HA02');
    // 前端 KPI 卡固定讀 total_soh / total_excess / report_date / report_kind / ratio / wow_delta_pt
    expect(view.kpi!.total_soh).toBeCloseTo(1000000, 6);
    expect(view.kpi!.total_excess).toBeCloseTo(100000.25, 6);
    expect(view.kpi!.report_date).toBe('2026-10-25');
    expect(view.kpi!.report_kind).toBe('weekly');
    expect(view.kpi!.ratio).toBeCloseTo(0.10000025, 8);
    expect(view.series[0]!.report_date).toBe('2026-10-25');
  });

  it('lists the week detail ranked by ratio with deltas against the previous period', async () => {
    const week = await getShopStockWeek('2026-10-25');
    expect(week).not.toBeNull();
    expect(week!.store_count).toBe(3);
    expect(week!.company_ratio).toBeCloseTo(0.04, 10);
    expect(week!.rows.map((r) => r.site_code)).toEqual(['HA02', 'HD09', 'HC71']);
    expect(week!.rows[0]!.ratio).toBeCloseTo(0.10000025, 8);
    expect(week!.rows[0]!.rank).toBe(1);
    expect(week!.rows[2]!.rank).toBeNull();
    expect(week!.rows[2]!.ratio).toBeNull();
    expect(week!.prev_report_date).toBeNull();
    expect(week!.rows[0]!.delta_pt).toBeNull();
    // 前端表頭用 totals；每店列沿用 deadstock_value / shop_stock_value / wow_delta_pt
    expect(week!.totals.ratio).toBeCloseTo(0.04, 10);
    expect(week!.totals.store_count).toBe(3);
    expect(week!.rows[0]!.deadstock_value).toBeCloseTo(100000.25, 6);
    expect(week!.rows[0]!.shop_stock_value).toBeCloseTo(1000000, 6);
    expect(week!.rows[0]!.wow_delta_pt).toBeNull();
  });

  it('adds a second period and reports WoW in percentage points', async () => {
    await upload('2026-11-01', FIXTURE_WEEK2);
    const summary = await getShopStockSummary();
    const dates = summary.series.map((p) => p.report_date);
    expect(dates).toEqual(['2026-10-25', '2026-11-01']);

    const week2 = summary.series[1]!;
    expect(week2.ratio).toBeCloseTo(0.1, 10);
    expect(week2.wow_delta_pt).toBeCloseTo(6, 8);
    expect(summary.kpi!.report_date).toBe('2026-11-01');
    expect(summary.kpi!.prev_report_date).toBe('2026-10-25');

    const week = await getShopStockWeek('2026-11-01');
    const ha02 = week!.rows.find((r) => r.site_code === 'HA02')!;
    expect(ha02.prev_ratio).toBeCloseTo(0.10000025, 8);
    expect(ha02.delta_pt).toBeCloseTo((0.2 - 0.10000025) * 100, 6);
  });

  it('filters the summary by date range', async () => {
    const summary = await getShopStockSummary({ from: '2026-11-01' });
    expect(summary.series.map((p) => p.report_date)).toEqual(['2026-11-01']);
  });

  it('replaces the whole batch when re-uploading the same report_date (old batch deleted, new id)', async () => {
    const first = await upload('2026-11-08', [ROW_HA02, ROW_HD09]);
    expect(first.batch.store_count).toBe(2);
    expect(first.batch.row_count).toBe(2);

    const second = await upload('2026-11-08', FIXTURE_MAIN);
    expect(second.replaced).toBe(true);
    expect(second.noop).toBe(false);
    // 整批取代 = 舊批次刪掉、新批次新 id（audit 靠 replacedBatch 追溯舊 id / 行數 / hash）
    expect(second.batch.id).not.toBe(first.batch.id);
    expect(second.replacedBatch).toEqual({
      id: first.batch.id,
      reportDate: '2026-11-08',
      rowCount: 2,
      contentHash: first.batch.content_hash,
    });
    expect(second.batch.store_count).toBe(3);
    expect(second.batch.row_count).toBe(3);

    // 舊批次與其明細必須完全消失（FK CASCADE）
    const oldRows = await db.query<{ cnt: number }>(
      'SELECT count(*)::int AS cnt FROM shop_stock_snapshots WHERE batch_id = $1',
      [first.batch.id],
    );
    expect(oldRows.rows[0]!.cnt).toBe(0);
    const oldBatch = await db.query<{ cnt: number }>(
      'SELECT count(*)::int AS cnt FROM shop_stock_batches WHERE id = $1',
      [first.batch.id],
    );
    expect(oldBatch.rows[0]!.cnt).toBe(0);

    const newRows = await db.query<{ cnt: number }>(
      'SELECT count(*)::int AS cnt FROM shop_stock_snapshots WHERE batch_id = $1',
      [second.batch.id],
    );
    expect(newRows.rows[0]!.cnt).toBe(3);

    const batches = await listShopStockBatches({ page: 1, pageSize: 50 });
    expect(batches.batches.filter((b) => b.report_date === '2026-11-08')).toHaveLength(1);
  });

  it('treats an identical re-upload (same content_hash) as a no-op', async () => {
    const before = await getShopStockSummary();
    const beforePoint = before.series.find((p) => p.report_date === '2026-11-08')!;
    const again = await upload('2026-11-08', FIXTURE_MAIN);
    expect(again.noop).toBe(true);
    expect(again.replaced).toBe(false);

    const after = await getShopStockSummary();
    const afterPoint = after.series.find((p) => p.report_date === '2026-11-08')!;
    expect(afterPoint.store_count).toBe(beforePoint.store_count);
    expect(afterPoint.total_soh).toBeCloseTo(beforePoint.total_soh ?? 0, 6);
  });

  it('rejects moving a batch onto a date that already has one', async () => {
    const batches = await listShopStockBatches({ page: 1, pageSize: 50 });
    const target = batches.batches.find((b) => b.report_date === '2026-11-08')!;
    await expect(
      updateShopStockBatch(target.id, { reportDate: '2026-10-25' }),
    ).rejects.toBeInstanceOf(ShopStockDateConflictError);

    // 失敗後原本的日期不變
    const after = await getShopStockSummary();
    expect(after.series.some((p) => p.report_date === '2026-11-08')).toBe(true);
  });

  it('updates note and report_date (recomputing the display label)', async () => {
    const created = await upload('2026-12-06', [ROW_HA02]);
    const updated = await updateShopStockBatch(created.batch.id, { reportDate: '2026-12-13', note: '改期' });
    expect(updated!.report_date).toBe('2026-12-13');
    expect(updated!.week_label).toBe(deriveWeekLabel('2026-12-13'));
    expect(updated!.note).toBe('改期');
  });

  it('deletes a batch, cascading its snapshots', async () => {
    const created = await upload('2027-01-03', FIXTURE_MAIN);
    const deleted = await deleteShopStockBatch(created.batch.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.reportDate).toBe('2027-01-03');
    expect(deleted!.deletedRows).toBe(3);
    expect(deleted!.deletedStores).toBe(3);

    const rows = await db.query<{ cnt: number }>(
      'SELECT count(*)::int AS cnt FROM shop_stock_snapshots WHERE batch_id = $1',
      [created.batch.id],
    );
    expect(rows.rows[0]!.cnt).toBe(0);
    expect(await deleteShopStockBatch(created.batch.id)).toBeNull();
  });

  it('raises a typed import error for a malformed file', async () => {
    await expect(
      upsertShopStockBatch({
        buffer: await buildNonStandardXlsx([ROW_HA02, ROW_HA02]),
        reportDate: '2027-02-07',
        reportKind: 'weekly',
        note: '',
        uploadedBy: 'tester',
        maxRows: 500,
      }),
    ).rejects.toBeInstanceOf(ShopStockImportError);
  });

  it('returns has_data = false for a store with no snapshots', async () => {
    const view = await getShopStockForStore('ZZ99');
    expect(view.has_data).toBe(false);
    expect(view.series).toEqual([]);
    // 公司線仍然提供（店舖可見全公司加權平均，但沒有其他店數據）
    expect(view.company_series.length).toBeGreaterThan(0);
  });

  it('accepts only the three canonical report_kind values', async () => {
    const monthly = await upload('2027-04-04', [ROW_HA02], { kind: 'month_end' });
    expect(monthly.batch.report_kind).toBe('month_end');

    const adhoc = await upload('2027-04-11', [ROW_HA02], { kind: 'ad_hoc' });
    expect(adhoc.batch.report_kind).toBe('ad_hoc');

    // service 對非法值回落 weekly（route 的 zod 已擋在前面）
    const fallback = await upload('2027-04-18', [ROW_HA02], { kind: 'monthly' });
    expect(fallback.batch.report_kind).toBe('weekly');
  });

  it('keeps new stores out of the ranking when the previous period did not include them', async () => {
    // 上一期（2027-04-18）只有 HA02；N001 是新店，首期存貨比率 90% 會霸佔榜首
    const fixture = [
      makeRow({
        Shop: 'HA02 - 駱克',
        'Site Code': 'HA02',
        'Excess Stock Value (P90D 0 Sales)': 100000,
        'Shop Stock Value (CM)': 1000000,
      }),
      makeRow({
        Shop: 'N001 - 新店',
        'Site Code': 'N001',
        'Excess Stock Value (P90D 0 Sales)': 900000,
        'Shop Stock Value (CM)': 1000000,
      }),
      totalRow(2000000, 1000000),
      BLANK_ROW,
      FOOTER_ROW,
    ];
    await upload('2027-05-09', fixture);

    const week = await getShopStockWeek('2027-05-09');
    const ha02 = week!.rows.find((r) => r.site_code === 'HA02')!;
    const newStore = week!.rows.find((r) => r.site_code === 'N001')!;

    expect(ha02.is_new).toBe(false);
    expect(newStore.is_new).toBe(true);
    // 新店不取名次，但比率仍然計出
    expect(newStore.rank).toBeNull();
    expect(newStore.ratio).toBeCloseTo(0.9, 8);
    expect(ha02.rank).toBe(1);
    // 可比較的店舖排前面，新店排最後
    expect(week!.rows[0]!.site_code).toBe('HA02');
    expect(week!.rows[week!.rows.length - 1]!.site_code).toBe('N001');
    // 但仍計入全公司合計：Σexcess 1,000,000 / ΣSOH 2,000,000
    expect(week!.totals.store_count).toBe(2);
    expect(week!.totals.ratio).toBeCloseTo(0.5, 10);
  });

  it('excludes shops the report itself flags as NEW STORE, even with a single period', async () => {
    // 只有一期資料時沒有「上一期」可比，但報表 Shop Type 已標明新店 → 仍不參與排名。
    // 日期刻意早於其他測試，令 previousReportDate 為 null。
    const fixture = [
      makeRow({
        Shop: 'HA02 - 駱克',
        'Site Code': 'HA02',
        'Shop Type': 'EXISTING',
        'Excess Stock Value (P90D 0 Sales)': 100000,
        'Shop Stock Value (CM)': 1000000,
      }),
      makeRow({
        Shop: 'HBB3 - 帝國中心 2',
        'Site Code': 'HBB3',
        'Shop Type': 'NEW STORE',
        'Excess Stock Value (P90D 0 Sales)': 522900,
        'Shop Stock Value (CM)': 1000000,
      }),
    ];
    await upload('2026-01-04', fixture);

    const week = await getShopStockWeek('2026-01-04');
    expect(week!.prev_report_date).toBeNull();

    const existing = week!.rows.find((r) => r.site_code === 'HA02')!;
    const newStore = week!.rows.find((r) => r.site_code === 'HBB3')!;

    expect(newStore.is_new).toBe(true);
    expect(newStore.is_new_store).toBe(true);
    expect(newStore.new_reason).toBe('new_store');
    expect(newStore.rank).toBeNull();

    expect(existing.is_new).toBe(false);
    expect(existing.new_reason).toBeNull();
    expect(existing.rank).toBe(1);

    // 新店排可比較店舖之後
    expect(week!.rows.map((r) => r.site_code)).toEqual(['HA02', 'HBB3']);
    // 但仍計入全公司合計
    expect(week!.totals.store_count).toBe(2);
    expect(week!.totals.ratio).toBeCloseTo(622900 / 2000000, 10);
  });

  it('stops treating a shop as new once it has been in our data longer than the grace period', async () => {
    // 上游的 Shop Type 長期不改（開了半年仍寫 NEW STORE）。觀察期一過，改由系統自己的歷史決定。
    const shop = (excess: number) =>
      makeRow({
        Shop: 'HBX1 - 觀察期測試店',
        'Site Code': 'HBX1',
        'Shop Type': 'NEW STORE',
        'Excess Stock Value (P90D 0 Sales)': excess,
        'Shop Stock Value (CM)': 1000000,
      });
    const existing = makeRow({
      Shop: 'HA02 - 駱克',
      'Site Code': 'HA02',
      'Shop Type': 'EXISTING',
      'Excess Stock Value (P90D 0 Sales)': 100000,
      'Shop Stock Value (CM)': 1000000,
    });

    await upload('2027-08-01', [existing, shop(522900)]);
    const firstWeek = await getShopStockWeek('2027-08-01');
    const atFirst = firstWeek!.rows.find((r) => r.site_code === 'HBX1')!;
    // 上期沒有它 → 仍視為新店（旗標與觀察期同時成立，優先歸類為 new_store）
    expect(atFirst.is_new).toBe(true);
    expect(atFirst.new_reason).toBe('new_store');

    // 92 日後（> 90 天觀察期），旗標仍是 NEW STORE，但系統已認識它
    await upload('2027-11-01', [existing, shop(400000)]);
    const laterWeek = await getShopStockWeek('2027-11-01');
    const atLater = laterWeek!.rows.find((r) => r.site_code === 'HBX1')!;

    expect(atLater.first_seen).toBe('2027-08-01');
    expect(atLater.is_new).toBe(false);
    expect(atLater.new_reason).toBeNull();
    // 旗標本身仍然保留，方便審計（只是不再影響排名）
    expect(atLater.is_new_store).toBe(true);
    expect(atLater.rank).not.toBeNull();
    expect(laterWeek!.new_store_grace_days).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Routes：認證與數據隔離
// ---------------------------------------------------------------------------

describe('shopStock routes', () => {
  it('rejects anonymous admin requests', async () => {
    for (const url of ['/api/admin/stock/summary', '/api/admin/stock/summary/export?months=12', '/api/admin/stock/batches', '/api/admin/stock/weeks/2026-10-25']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(401);
    }
  });

  it('rejects anonymous portal requests', async () => {
    const res = await request(app).get('/api/portal/stock/summary');
    expect(res.status).toBe(401);
  });

  it('returns 200 with has_data = false (not 404) for a store without snapshots', async () => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO portal_users (username, role, site_code, password_hash)
       VALUES ('store-zz99', 'store', 'ZZ99', 'x') RETURNING id`,
    );
    const session = await createPortalSession(inserted.rows[0]!.id);
    const res = await request(app)
      .get('/api/portal/stock/summary')
      .set('Cookie', [`portal_session=${session.token}`]);
    expect(res.status).toBe(200);
    expect(res.body.has_data).toBe(false);
  });

  it('ignores a site_code passed via query string and only returns the signed-in store', async () => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO portal_users (username, role, site_code, password_hash)
       VALUES ('store-ha02', 'store', 'HA02', 'x') RETURNING id`,
    );
    const session = await createPortalSession(inserted.rows[0]!.id);
    const res = await request(app)
      .get('/api/portal/stock/summary?site_code=HD09')
      .set('Cookie', [`portal_session=${session.token}`]);

    expect(res.status).toBe(200);
    expect(res.body.site_code).toBe('HA02');
    expect(res.body.has_data).toBe(true);
    // 只會見到 HA02 自己的數字
    const latest = res.body.series[res.body.series.length - 1] as { excess_value_0sale: number | null };
    expect(latest.excess_value_0sale).not.toBeCloseTo(59999.75, 2);
    // 回應內容不得出現其他店號或別店金額
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('HD09');
    expect(raw).not.toContain('59999.75');
  });

  it('rejects a malformed report date on the week detail route', async () => {
    const res = await request(app).get('/api/admin/stock/weeks/2026-1-5');
    // 未登入先 401；登入後才是 400，所以這裡只驗證不是 200 的路徑不漏資料
    expect([400, 401]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// 已登入管理員：multipart 上載與批次管理（CSRF + zod + limiter 全鏈路）
// ---------------------------------------------------------------------------

/** 登入管理員並取得可用於寫入請求的 cookie / CSRF 標頭 */
async function adminSession(): Promise<{ cookie: string[]; csrf: string }> {
  const seeded = await request(app).get('/api/csrf');
  const csrf = String((seeded.body as { token?: string }).token ?? '');
  const cookie = (seeded.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const login = await request(app)
    .post('/api/admin/login')
    .set('Cookie', cookie)
    .set('x-csrf-token', csrf)
    .send({ username: config.adminUsername, password: config.adminPassword });
  expect(login.status).toBe(200);
  const sessionCookie = (login.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return { cookie: [...cookie, ...sessionCookie], csrf };
}

describe.skipIf(!config.adminPassword)('shopStock admin routes (logged in)', () => {
  let session: { cookie: string[]; csrf: string };

  beforeAll(async () => {
    session = await adminSession();
  });

  async function uploadVia(
    format: 'nonstandard' | 'exceljs',
    date: string,
    rows: CellValue[][],
    kind = 'weekly',
  ) {
    let buffer: Buffer;
    if (format === 'nonstandard') {
      buffer = await buildNonStandardXlsx(rows);
    } else {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Export');
      sheet.addRow(HEADERS as unknown as string[]);
      for (const row of rows) sheet.addRow(row as unknown as (string | number | null)[]);
      buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    }
    return request(app)
      .post('/api/admin/stock/batches')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrf)
      .field('report_date', date)
      .field('report_kind', kind)
      .field('note', 'route test')
      .attach('file', buffer, {
        filename: 'By Shop_test.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
  }

  it('creates a batch from a multipart upload, then replaces it on the same date', async () => {
    const created = await uploadVia('nonstandard', '2027-03-07', [ROW_HA02, ROW_HD09]);
    expect(created.status).toBe(201);
    expect(created.body.ok).toBe(true);
    expect(created.body.batch.report_date).toBe('2027-03-07');
    expect(created.body.batch.row_count).toBe(2);
    expect(created.body.replaced).toBe(false);
    expect(created.body.skipped).toEqual({ total: 0, blank: 0, footer: 0 });
    // HA02 / HD09 已在門店主檔，HC71 未在本夾具出現
    expect(created.body.unknown_sites).toEqual([]);

    const replaced = await uploadVia('exceljs', '2027-03-07', [ROW_HA02]);
    expect(replaced.status).toBe(200);
    expect(replaced.body.replaced).toBe(true);
    expect(replaced.body.batch.id).not.toBe(created.body.batch.id);
    expect(replaced.body.replaced_batch_id).toBe(created.body.batch.id);
    expect(replaced.body.batch.row_count).toBe(1);
  });

  it('lists batches with both batches and rows keys', async () => {
    const res = await request(app)
      .get('/api/admin/stock/batches?page=1&size=5')
      .set('Cookie', session.cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows).toEqual(res.body.batches);
    expect(res.body.page_size).toBe(5);
  });

  it('returns 409 DATE_CONFLICT when moving a batch onto a taken date', async () => {
    await uploadVia('nonstandard', '2027-03-14', [ROW_HA02]);
    const list = await request(app)
      .get('/api/admin/stock/batches?page=1&size=50')
      .set('Cookie', session.cookie);
    const target = (list.body.batches as Array<{ id: string; report_date: string }>).find(
      (b) => b.report_date === '2027-03-07',
    )!;
    const res = await request(app)
      .put(`/api/admin/stock/batches/${target.id}`)
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrf)
      .send({ report_date: '2027-03-14' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DATE_CONFLICT');
  });

  it('serves the summary and the week detail to a logged-in admin', async () => {
    const summary = await request(app).get('/api/admin/stock/summary').set('Cookie', session.cookie);
    expect(summary.status).toBe(200);
    expect(Array.isArray(summary.body.series)).toBe(true);

    const week = await request(app)
      .get('/api/admin/stock/weeks/2027-03-07')
      .set('Cookie', session.cookie);
    expect(week.status).toBe(200);
    expect(week.body.report_date).toBe('2027-03-07');
    expect(week.body.totals.store_count).toBe(1);

    const badDate = await request(app)
      .get('/api/admin/stock/weeks/2027-3-7')
      .set('Cookie', session.cookie);
    expect(badDate.status).toBe(400);

    const missing = await request(app)
      .get('/api/admin/stock/weeks/2019-01-06')
      .set('Cookie', session.cookie);
    expect(missing.status).toBe(404);
  });

  it('deletes a batch through the route and reports the deleted counts', async () => {
    const list = await request(app)
      .get('/api/admin/stock/batches?page=1&size=50')
      .set('Cookie', session.cookie);
    const target = (list.body.batches as Array<{ id: string; report_date: string }>).find(
      (b) => b.report_date === '2027-03-14',
    )!;
    const res = await request(app)
      .delete(`/api/admin/stock/batches/${target.id}`)
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrf);
    expect(res.status).toBe(200);
    expect(res.body.deleted_rows).toBe(1);
    expect(res.body.deleted_stores).toBe(1);
  });

  it('accepts the month_end value used by the admin form and rejects aliases', async () => {
    const ok = await uploadVia('nonstandard', '2027-03-21', [ROW_HA02], 'month_end');
    expect(ok.status).toBe(201);
    expect(ok.body.batch.report_kind).toBe('month_end');

    const alias = await uploadVia('nonstandard', '2027-03-28', [ROW_HA02], 'monthly');
    expect(alias.status).toBe(400);
  });

  it('reports the replaced batch id on a same-date re-upload', async () => {
    const created = await uploadVia('nonstandard', '2027-05-02', [ROW_HA02]);
    expect(created.status).toBe(201);
    const replaced = await uploadVia('exceljs', '2027-05-02', [ROW_HA02, ROW_HD09]);
    expect(replaced.status).toBe(200);
    expect(replaced.body.replaced).toBe(true);
    expect(replaced.body.batch.id).not.toBe(created.body.batch.id);
    expect(replaced.body.replaced_batch_id).toBe(created.body.batch.id);
  });

  it('rejects an upload without a report_date', async () => {
    const buffer = await buildNonStandardXlsx([ROW_HA02]);
    const res = await request(app)
      .post('/api/admin/stock/batches')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrf)
      .field('note', 'no date')
      .attach('file', buffer, {
        filename: 'By Shop_test.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(res.status).toBe(400);
  });

  it('exports the trend chart as an xlsx with detail / PPT / info sheets', async () => {
    const res = await request(app)
      .get('/api/admin/stock/summary/export?months=24')
      .set('Cookie', session.cookie)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(String(res.headers['content-disposition'])).toMatch(/filename="Shop_Stock_Ratio_24M_\d{8}\.xlsx"/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as never);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['佔比趨勢', 'PPT 圖表用', '匯出說明']);

    const detail = workbook.getWorksheet('佔比趨勢')!;
    const headers: string[] = [];
    detail.getRow(1).eachCell((cell, col) => { headers[col - 1] = String(cell.value ?? ''); });
    expect(headers[0]).toBe('期別');
    expect(headers[7]).toBe('不良存貨佔比');

    // 日期以文字輸出（避免 Excel 依地區設定改寫），比率保留小數 + 百分比格式
    const firstDataRow = detail.getRow(2);
    const dates: string[] = [];
    detail.eachRow((row, rowNumber) => {
      if (rowNumber > 1) dates.push(String(row.getCell(1).value ?? ''));
    });
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect(detail.getColumn(8).numFmt).toBe('0.0%');
    const ratioCell = firstDataRow.getCell(8).value;
    if (ratioCell !== null && ratioCell !== '') {
      expect(Number(ratioCell)).toBeGreaterThanOrEqual(0);
    }

    // PPT 圖表用只有兩欄，數值與明細一致
    const chartSheet = workbook.getWorksheet('PPT 圖表用')!;
    expect(chartSheet.getCell(1, 1).value).toBe('期別');
    expect(chartSheet.getCell(1, 2).value).toBe('不良存貨佔比');
    expect(chartSheet.getCell(2, 1).value).toBe(firstDataRow.getCell(1).value);
    expect(chartSheet.getCell(2, 2).value).toBe(firstDataRow.getCell(8).value);
    expect(chartSheet.getColumn(2).numFmt).toBe('0.0%');
  });

  it('rejects an invalid export period', async () => {
    const res = await request(app)
      .get('/api/admin/stock/summary/export?months=0')
      .set('Cookie', session.cookie);
    expect(res.status).toBe(400);
  });
});

