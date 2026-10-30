import { query } from '../db/pool.js';
import { toHKString } from '../lib/time.js';
import {
  adminReplyItem,
  listBatchesForSites,
  listItemsForSites,
  ZeroSalesReplyError,
  type ZeroSalesItemRow,
  type ZeroSalesMyBatchRow,
} from './zeroSales.js';
import {
  DesignatedSkuNotFoundError,
  listMattersForSites,
  submitMatterReply,
  type DesignatedSkuMatter,
  type MatterReplyItemInput,
} from './designatedSku.js';
import { getShopStockSummary } from './shopStock.js';

/**
 * OM（區域主管）Portal 的資料存取。
 *
 * 權限的唯一來源是登入 OM 的 username（= stores.om 大寫）。所有查詢都先
 * 取得該 OM 的 site_code 清單，再以 SQL `ANY($1)` 限定，**不接受前端傳入
 * 「哪個 OM」**。任何指定 site_code 的請求都會再核對一次擁有權。
 */

export class OmSiteAccessError extends Error {
  constructor(message = '此店舖不屬於你管理的範圍') {
    super(message);
    this.name = 'OmSiteAccessError';
  }
}

export interface OmStoreRow {
  site_code: string;
  shop: string;
  regional: string;
  class1: string;
  class2: string;
  size: string;
  type: string;
}

export async function listOmStores(username: string): Promise<OmStoreRow[]> {
  const key = username.trim().toUpperCase();
  const r = await query<OmStoreRow>(
    `SELECT site_code,
            COALESCE(shop, '') AS shop,
            COALESCE(regional, '') AS regional,
            COALESCE(class1, '') AS class1,
            COALESCE(class2, '') AS class2,
            COALESCE(size, '') AS size,
            COALESCE(type, '') AS type
       FROM stores
      WHERE UPPER(BTRIM(COALESCE(om, ''))) = $1
      ORDER BY site_code`,
    [key],
  );
  return r.rows;
}

export async function getOmSiteCodes(username: string): Promise<string[]> {
  return (await listOmStores(username)).map((s) => s.site_code);
}

export async function assertOmSite(username: string, siteCode: string): Promise<void> {
  const r = await query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM stores
      WHERE site_code = $1
        AND UPPER(BTRIM(COALESCE(om, ''))) = $2`,
    [siteCode.trim().toUpperCase(), username.trim().toUpperCase()],
  );
  if (!r.rows[0]) throw new OmSiteAccessError();
}

export interface OmOverview {
  om: string;
  stores: OmStoreRow[];
  zero_sales: {
    latest_batch: {
      id: string;
      week_label: string;
      created_at: string;
      closed_at: string | null;
      reply_required: boolean;
      is_open: boolean;
      total: number;
      replied: number;
      pending: number;
      store_total: number;
      store_pending: number;
    } | null;
    pending_total: number;
    stores_pending: number;
    stores: Array<{
      site_code: string;
      batch_id: string;
      week_label: string;
      closed_at: string | null;
      reply_required: boolean;
      is_open: boolean;
      total: number;
      replied: number;
      pending: number;
    }>;
  };
  designated_sku: {
    open_matters: number;
    pending_matters: number;
    pending_items: number;
    stores: Array<{
      site_code: string;
      total_matters: number;
      pending_matters: number;
      pending_items: number;
    }>;
  };
  stock: OmStockSummary;
}

interface ZeroLatestBatchRow {
  id: string;
  week_label: string;
  created_at: string;
  closed_at: string | null;
  reply_required: boolean;
  total: number;
  replied: number;
  pending: number;
  store_total: number;
  store_pending: number;
}

interface ZeroStoreRow {
  site_code: string;
  batch_id: string;
  week_label: string;
  closed_at: string | null;
  reply_required: boolean;
  total: number;
  replied: number;
  pending: number;
}

interface DskuStoreRow {
  site_code: string;
  total_matters: number;
  pending_matters: number;
  pending_items: number;
}

export async function getOmOverview(username: string): Promise<OmOverview> {
  const stores = await listOmStores(username);
  const siteCodes = stores.map((s) => s.site_code);
  if (!siteCodes.length) {
    return {
      om: username,
      stores: [],
      zero_sales: { latest_batch: null, pending_total: 0, stores_pending: 0, stores: [] },
      designated_sku: { open_matters: 0, pending_matters: 0, pending_items: 0, stores: [] },
      stock: emptyStockSummary(stores.length),
    };
  }

  const [latestBatchResult, openPendingResult, zeroStoreResult, dskuStoreResult, stock] = await Promise.all([
    query<ZeroLatestBatchRow>(
      `SELECT b.id, b.week_label, b.created_at, b.closed_at, b.reply_required,
              count(*)::int AS total,
              count(*) FILTER (WHERE i.status = 'replied')::int AS replied,
              count(*) FILTER (WHERE i.status = 'pending')::int AS pending,
              count(DISTINCT i.site_code)::int AS store_total,
              count(DISTINCT i.site_code) FILTER (WHERE i.status = 'pending')::int AS store_pending
         FROM zero_sales_batches b
         JOIN zero_sales_items i ON i.batch_id = b.id
        WHERE i.site_code = ANY($1::text[])
        GROUP BY b.id, b.week_label, b.created_at, b.closed_at, b.reply_required
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT 1`,
      [siteCodes],
    ),
    query<{ pending: number; stores_pending: number }>(
      `SELECT count(*)::int AS pending,
              count(DISTINCT i.site_code)::int AS stores_pending
         FROM zero_sales_items i
         JOIN zero_sales_batches b ON b.id = i.batch_id
        WHERE i.site_code = ANY($1::text[])
          AND i.status = 'pending'
          AND b.closed_at IS NULL
          AND b.reply_required = true`,
      [siteCodes],
    ),
    query<ZeroStoreRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (i.site_code)
                i.site_code, b.id AS batch_id, b.week_label, b.created_at, b.closed_at, b.reply_required
           FROM zero_sales_items i
           JOIN zero_sales_batches b ON b.id = i.batch_id
          WHERE i.site_code = ANY($1::text[])
          ORDER BY i.site_code, b.created_at DESC, b.id DESC
       )
       SELECT l.site_code, l.batch_id, l.week_label, l.closed_at, l.reply_required,
              count(i.id)::int AS total,
              count(*) FILTER (WHERE i.status = 'replied')::int AS replied,
              count(*) FILTER (WHERE i.status = 'pending')::int AS pending
         FROM latest l
         JOIN zero_sales_items i ON i.batch_id = l.batch_id AND i.site_code = l.site_code
        GROUP BY l.site_code, l.batch_id, l.week_label, l.closed_at, l.reply_required
        ORDER BY l.site_code`,
      [siteCodes],
    ),
    query<DskuStoreRow>(
      `SELECT x.site_code,
              count(*)::int AS total_matters,
              count(*) FILTER (WHERE x.pending_items > 0)::int AS pending_matters,
              COALESCE(sum(x.pending_items), 0)::int AS pending_items
         FROM (
           SELECT m.id, m.site_code,
                  count(i.id) FILTER (WHERE i.status = 'pending')::int AS pending_items
             FROM designated_sku_matters m
             JOIN designated_sku_batches b ON b.id = m.batch_id
             JOIN designated_sku_items i ON i.matter_id = m.id
            WHERE m.site_code = ANY($1::text[])
              AND b.closed_at IS NULL
              AND (b.due_at IS NULL OR b.due_at > now())
            GROUP BY m.id, m.site_code
         ) x
        GROUP BY x.site_code
        ORDER BY x.site_code`,
      [siteCodes],
    ),
    getOmStockSummary(username),
  ]);

  const latest = latestBatchResult.rows[0];
  const latestBatch = latest
    ? {
        id: latest.id,
        week_label: latest.week_label,
        created_at: toHKString(latest.created_at),
        closed_at: latest.closed_at ? toHKString(latest.closed_at) : null,
        reply_required: latest.reply_required !== false,
        is_open: !latest.closed_at && latest.reply_required !== false,
        total: Number(latest.total ?? 0),
        replied: Number(latest.replied ?? 0),
        pending: latest.reply_required === false ? 0 : Number(latest.pending ?? 0),
        store_total: Number(latest.store_total ?? 0),
        store_pending: latest.reply_required === false ? 0 : Number(latest.store_pending ?? 0),
      }
    : null;

  const zeroByStore = new Map(zeroStoreResult.rows.map((row) => [row.site_code, row]));
  const dskuByStore = new Map(dskuStoreResult.rows.map((row) => [row.site_code, row]));

  const dskuRows = [...dskuByStore.values()];
  return {
    om: username,
    stores,
    zero_sales: {
      latest_batch: latestBatch,
      pending_total: Number(openPendingResult.rows[0]?.pending ?? 0),
      stores_pending: Number(openPendingResult.rows[0]?.stores_pending ?? 0),
      stores: stores
        .filter((store) => zeroByStore.has(store.site_code))
        .map((store) => {
          const row = zeroByStore.get(store.site_code)!;
          const replyRequired = row.reply_required !== false;
          return {
            site_code: store.site_code,
            batch_id: row.batch_id,
            week_label: row.week_label,
            closed_at: row.closed_at ? toHKString(row.closed_at) : null,
            reply_required: replyRequired,
            is_open: !row.closed_at && replyRequired,
            total: Number(row.total ?? 0),
            replied: Number(row.replied ?? 0),
            pending: replyRequired ? Number(row.pending ?? 0) : 0,
          };
        }),
    },
    designated_sku: {
      open_matters: dskuRows.reduce((sum, row) => sum + Number(row.total_matters ?? 0), 0),
      pending_matters: dskuRows.reduce((sum, row) => sum + Number(row.pending_matters ?? 0), 0),
      pending_items: dskuRows.reduce((sum, row) => sum + Number(row.pending_items ?? 0), 0),
      stores: stores.map((store) => {
        const row = dskuByStore.get(store.site_code);
        return {
          site_code: store.site_code,
          total_matters: Number(row?.total_matters ?? 0),
          pending_matters: Number(row?.pending_matters ?? 0),
          pending_items: Number(row?.pending_items ?? 0),
        };
      }),
    },
    stock,
  };
}

// ---------------------------------------------------------------------------
// 存貨走勢（OM 合計 + 每店最新一期）
// ---------------------------------------------------------------------------

export interface OmStockSeriesPoint {
  report_date: string;
  report_kind: string;
  store_count: number;
  ratio: number | null;
  wow_delta_pt: number | null;
  total_excess: number | null;
  total_soh: number | null;
  sku_count_0sale: number | null;
  /** 店內貨品 SKU 總數（I14 No. of SKU Carry）；缺值時 null */
  total_sku_carry: number | null;
  ovs_carry_ratio: number | null;
  /** 不良 SKU 比率與上一期的百分點差 */
  ovs_wow_delta_pt: number | null;
}

export interface OmStockStoreRow {
  site_code: string;
  shop: string;
  report_date: string | null;
  report_kind: string;
  ratio: number | null;
  wow_delta_pt: number | null;
  total_excess: number | null;
  total_soh: number | null;
  sku_count_0sale: number | null;
  /** 店內貨品 SKU 總數（I14 No. of SKU Carry） */
  total_sku_carry: number | null;
  /** RF SKU 數（I14 No. of RF SKU） */
  rf_sku_count: number | null;
  ovs_carry_ratio: number | null;
  ovs_wow_delta_pt: number | null;
}

export interface OmStockKpi {
  report_date: string;
  report_kind: string;
  store_count: number;
  ratio: number | null;
  wow_delta_pt: number | null;
  total_excess: number | null;
  total_soh: number | null;
  sku_count_0sale: number | null;
  total_sku_carry: number | null;
  ovs_carry_ratio: number | null;
  ovs_wow_delta_pt: number | null;
  company_ratio: number | null;
  company_ovs_carry_ratio: number | null;
  delta_vs_company_pt: number | null;
}

export interface OmStockCompanySeriesPoint {
  report_date: string;
  ratio: number | null;
  wow_delta_pt: number | null;
  sku_count_0sale: number | null;
  total_sku_carry: number | null;
  ovs_carry_ratio: number | null;
  ovs_wow_delta_pt: number | null;
}

export interface OmStockSummary {
  has_data: boolean;
  site_count: number;
  series: OmStockSeriesPoint[];
  company_series: OmStockCompanySeriesPoint[];
  selected_store: { site_code: string; shop: string; series: OmStockSeriesPoint[]; kpi: OmStockKpi | null } | null;
  kpi: OmStockKpi | null;
  stores: OmStockStoreRow[];
}

function emptyStockSummary(siteCount = 0): OmStockSummary {
  return {
    has_data: false,
    site_count: siteCount,
    series: [],
    company_series: [],
    selected_store: null,
    kpi: null,
    stores: [],
  };
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ratioOf(numerator: unknown, denominator: unknown): number | null {
  const n = num(numerator);
  const d = num(denominator);
  if (n === null || d === null || d <= 0) return null;
  return n / d;
}

function deltaPt(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return (current - previous) * 100;
}

/** 與 I14 相同：以千分位文字亦可解析；空白／非法 → null，不當 0。 */
function skuCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/,/g, '');
  if (!text) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

interface OmStockRawRow {
  site_code: string;
  shop: string;
  report_date: string;
  report_kind: string;
  excess_value_0sale: unknown;
  shop_stock_value_cm: unknown;
  sku_count_0sale: unknown;
  carry_text: unknown;
  rf_text: unknown;
}

export async function getOmStockSummary(username: string, selectedSiteCode = ''): Promise<OmStockSummary> {
  const stores = await listOmStores(username);
  if (!stores.length) return emptyStockSummary(0);
  const siteCodes = stores.map((s) => s.site_code);
  let selected = '';
  if (selectedSiteCode) {
    selected = selectedSiteCode.trim().toUpperCase();
    if (!siteCodes.includes(selected)) throw new OmSiteAccessError();
  }

  const r = await query<OmStockRawRow>(
    `SELECT s.site_code,
            COALESCE(s.shop, '') AS shop,
            b.report_date::text AS report_date,
            b.report_kind,
            s.excess_value_0sale,
            s.shop_stock_value_cm,
            s.sku_count_0sale,
            s.payload->>'No. of SKU Carry' AS carry_text,
            s.payload->>'No. of RF SKU' AS rf_text
       FROM shop_stock_snapshots s
       JOIN shop_stock_batches b ON b.id = s.batch_id
      WHERE s.site_code = ANY($1::text[])
      ORDER BY b.report_date, s.site_code`,
    [siteCodes],
  );
  if (!r.rows.length) {
    const empty = emptyStockSummary(stores.length);
    empty.stores = stores.map((s) => ({
      site_code: s.site_code,
      shop: s.shop,
      report_date: null,
      report_kind: '',
      ratio: null,
      wow_delta_pt: null,
      total_excess: null,
      total_soh: null,
      sku_count_0sale: null,
      total_sku_carry: null,
      rf_sku_count: null,
      ovs_carry_ratio: null,
      ovs_wow_delta_pt: null,
    }));
    return empty;
  }

  interface Agg {
    report_date: string;
    report_kind: string;
    storeCount: number;
    excess: number;
    soh: number;
    sku0: number;
    carry: number;
    hasCarry: boolean;
  }
  const byDate = new Map<string, Agg>();
  for (const row of r.rows) {
    const date = String(row.report_date ?? '').slice(0, 10);
    if (!date) continue;
    const soh = num(row.shop_stock_value_cm);
    const excess = num(row.excess_value_0sale);
    const sku0 = num(row.sku_count_0sale);
    const carry = skuCount(row.carry_text);
    let agg = byDate.get(date);
    if (!agg) {
      agg = {
        report_date: date,
        report_kind: row.report_kind,
        storeCount: 0,
        excess: 0,
        soh: 0,
        sku0: 0,
        carry: 0,
        hasCarry: false,
      };
      byDate.set(date, agg);
    }
    agg.storeCount += 1;
    if (soh !== null && soh > 0) {
      agg.soh += soh;
      agg.excess += excess ?? 0;
    }
    agg.sku0 += sku0 ?? 0;
    if (carry !== null) {
      agg.carry += carry;
      agg.hasCarry = true;
    }
  }

  const series: OmStockSeriesPoint[] = [...byDate.values()]
    .sort((a, b) => a.report_date.localeCompare(b.report_date))
    .map((agg) => ({
      report_date: agg.report_date,
      report_kind: agg.report_kind,
      store_count: agg.storeCount,
      ratio: ratioOf(agg.excess, agg.soh),
      wow_delta_pt: null,
      total_excess: agg.soh > 0 ? agg.excess : null,
      total_soh: agg.soh > 0 ? agg.soh : null,
      sku_count_0sale: agg.sku0,
      total_sku_carry: agg.hasCarry ? agg.carry : null,
      ovs_carry_ratio: agg.hasCarry ? ratioOf(agg.sku0, agg.carry) : null,
      ovs_wow_delta_pt: null,
    }));
  for (let i = 1; i < series.length; i += 1) {
    series[i]!.wow_delta_pt = deltaPt(series[i]!.ratio, series[i - 1]!.ratio);
    series[i]!.ovs_wow_delta_pt = deltaPt(series[i]!.ovs_carry_ratio, series[i - 1]!.ovs_carry_ratio);
  }

  const company = await getShopStockSummary();
  const company_series: OmStockCompanySeriesPoint[] = company.series.map((point) => ({
    report_date: point.report_date,
    ratio: point.ratio,
    wow_delta_pt: point.wow_delta_pt,
    sku_count_0sale: point.sku_count_0sale,
    total_sku_carry: point.total_sku_carry,
    ovs_carry_ratio: point.ovs_carry_ratio,
    ovs_wow_delta_pt: null,
  }));
  for (let i = 1; i < company_series.length; i += 1) {
    company_series[i]!.ovs_wow_delta_pt = deltaPt(
      company_series[i]!.ovs_carry_ratio,
      company_series[i - 1]!.ovs_carry_ratio,
    );
  }
  const companyByDate = new Map(company_series.map((point) => [point.report_date, point.ratio]));
  const companyOvsByDate = new Map(company_series.map((point) => [point.report_date, point.ovs_carry_ratio]));

  // 每店最新一期（同店按 report_date 升序，取最後兩期計 WoW）
  const rowsByStore = new Map<string, OmStockRawRow[]>();
  for (const row of r.rows) {
    const list = rowsByStore.get(row.site_code) ?? [];
    list.push(row);
    rowsByStore.set(row.site_code, list);
  }
  const stockStores: OmStockStoreRow[] = stores.map((store) => {
    const list = (rowsByStore.get(store.site_code) ?? [])
      .slice()
      .sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));
    const latest = list[list.length - 1];
    const previous = list[list.length - 2];
    if (!latest) {
      return {
        site_code: store.site_code,
        shop: store.shop,
        report_date: null,
        report_kind: '',
        ratio: null,
        wow_delta_pt: null,
        total_excess: null,
        total_soh: null,
        sku_count_0sale: null,
        total_sku_carry: null,
        rf_sku_count: null,
        ovs_carry_ratio: null,
        ovs_wow_delta_pt: null,
      };
    }
    const latestRatio = ratioOf(latest.excess_value_0sale, latest.shop_stock_value_cm);
    const prevRatio = previous ? ratioOf(previous.excess_value_0sale, previous.shop_stock_value_cm) : null;
    const carry = skuCount(latest.carry_text);
    const prevCarry = previous ? skuCount(previous.carry_text) : null;
    const latestOvs = carry !== null ? ratioOf(latest.sku_count_0sale, carry) : null;
    const prevOvs = previous && prevCarry !== null ? ratioOf(previous.sku_count_0sale, prevCarry) : null;
    return {
      site_code: store.site_code,
      shop: store.shop,
      report_date: String(latest.report_date).slice(0, 10),
      report_kind: latest.report_kind,
      ratio: latestRatio,
      wow_delta_pt: deltaPt(latestRatio, prevRatio),
      total_excess: num(latest.excess_value_0sale),
      total_soh: num(latest.shop_stock_value_cm),
      sku_count_0sale: num(latest.sku_count_0sale),
      total_sku_carry: carry,
      rf_sku_count: skuCount(latest.rf_text),
      ovs_carry_ratio: latestOvs,
      ovs_wow_delta_pt: deltaPt(latestOvs, prevOvs),
    };
  });

  let selectedStore: OmStockSummary['selected_store'] = null;
  if (selected) {
    const store = stores.find((s) => s.site_code === selected)!;
    const selectedSeries: OmStockSeriesPoint[] = (rowsByStore.get(selected) ?? [])
      .slice()
      .sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)))
      .map((row) => {
        const carry = skuCount(row.carry_text);
        return {
          report_date: String(row.report_date).slice(0, 10),
          report_kind: row.report_kind,
          store_count: 1,
          ratio: ratioOf(row.excess_value_0sale, row.shop_stock_value_cm),
          wow_delta_pt: null,
          total_excess: num(row.excess_value_0sale),
          total_soh: num(row.shop_stock_value_cm),
          sku_count_0sale: num(row.sku_count_0sale),
          total_sku_carry: carry,
          ovs_carry_ratio: carry !== null ? ratioOf(row.sku_count_0sale, carry) : null,
          ovs_wow_delta_pt: null,
        };
      });
    for (let i = 1; i < selectedSeries.length; i += 1) {
      selectedSeries[i]!.wow_delta_pt = deltaPt(selectedSeries[i]!.ratio, selectedSeries[i - 1]!.ratio);
      selectedSeries[i]!.ovs_wow_delta_pt = deltaPt(selectedSeries[i]!.ovs_carry_ratio, selectedSeries[i - 1]!.ovs_carry_ratio);
    }
    const lastSelected = selectedSeries[selectedSeries.length - 1];
    const selectedCompanyRatio = lastSelected ? companyByDate.get(lastSelected.report_date) ?? null : null;
    const selectedCompanyOvs = lastSelected ? companyOvsByDate.get(lastSelected.report_date) ?? null : null;
    const selectedKpi: OmStockKpi | null = lastSelected
      ? {
          report_date: lastSelected.report_date,
          report_kind: lastSelected.report_kind,
          store_count: 1,
          ratio: lastSelected.ratio,
          wow_delta_pt: lastSelected.wow_delta_pt,
          total_excess: lastSelected.total_excess,
          total_soh: lastSelected.total_soh,
          sku_count_0sale: lastSelected.sku_count_0sale,
          total_sku_carry: lastSelected.total_sku_carry,
          ovs_carry_ratio: lastSelected.ovs_carry_ratio,
          ovs_wow_delta_pt: lastSelected.ovs_wow_delta_pt,
          company_ratio: selectedCompanyRatio,
          company_ovs_carry_ratio: selectedCompanyOvs,
          delta_vs_company_pt: deltaPt(lastSelected.ratio, selectedCompanyRatio),
        }
      : null;
    selectedStore = { site_code: store.site_code, shop: store.shop, series: selectedSeries, kpi: selectedKpi };
  }

  const latestPoint = series[series.length - 1];
  if (!latestPoint) {
    return {
      has_data: false,
      site_count: stores.length,
      series,
      company_series,
      selected_store: selectedStore,
      kpi: null,
      stores: stockStores,
    };
  }
  const companyRatio = companyByDate.get(latestPoint.report_date) ?? null;
  const companyOvsRatio = companyOvsByDate.get(latestPoint.report_date) ?? null;
  return {
    has_data: true,
    site_count: stores.length,
    series,
    company_series,
    selected_store: selectedStore,
    kpi: {
      report_date: latestPoint.report_date,
      report_kind: latestPoint.report_kind,
      store_count: latestPoint.store_count,
      ratio: latestPoint.ratio,
      wow_delta_pt: latestPoint.wow_delta_pt,
      total_excess: latestPoint.total_excess,
      total_soh: latestPoint.total_soh,
      sku_count_0sale: latestPoint.sku_count_0sale,
      total_sku_carry: latestPoint.total_sku_carry,
      ovs_carry_ratio: latestPoint.ovs_carry_ratio,
      ovs_wow_delta_pt: latestPoint.ovs_wow_delta_pt,
      company_ratio: companyRatio,
      company_ovs_carry_ratio: companyOvsRatio,
      delta_vs_company_pt: deltaPt(latestPoint.ratio, companyRatio),
    },
    stores: stockStores,
  };
}

// ---------------------------------------------------------------------------
// 零銷售 / 指定 SKU（OM 代覆）
// ---------------------------------------------------------------------------

export async function getOmZeroSalesBatches(username: string): Promise<ZeroSalesMyBatchRow[]> {
  return listBatchesForSites(await getOmSiteCodes(username));
}

export async function getOmZeroSalesItems(
  username: string,
  opts: { status?: string; batchId?: string; siteCode?: string; q?: string } = {},
): Promise<ZeroSalesItemRow[]> {
  const siteCodes = await getOmSiteCodes(username);
  if (opts.siteCode) {
    await assertOmSite(username, opts.siteCode);
  }
  return listItemsForSites(siteCodes, {
    status: opts.status,
    batchId: opts.batchId,
    siteCode: opts.siteCode?.trim().toUpperCase(),
    q: opts.q,
  });
}

export async function replyZeroSalesAsOm(input: {
  username: string;
  userId: string;
  itemId: string;
  reasonCode: string;
  reasonNote: string;
}): Promise<{
  before: { reason_code: string | null; reason_label: string | null; reason_note: string };
  item: ZeroSalesItemRow;
  entered: boolean;
  site_code: string;
  sku: string;
}> {
  const r = await query<{ batch_id: string; site_code: string; sku: string }>(
    'SELECT batch_id, site_code, sku FROM zero_sales_items WHERE id = $1',
    [input.itemId],
  );
  const row = r.rows[0];
  if (!row) throw new ZeroSalesReplyError('找不到此 SKU 指派');
  await assertOmSite(input.username, row.site_code);
  const result = await adminReplyItem({
    batchId: row.batch_id,
    itemId: input.itemId,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
    adminUser: input.username,
    actorLabel: 'OM 代覆',
    requireOpen: true,
  });
  return { ...result, site_code: row.site_code, sku: row.sku };
}

export async function getOmDesignatedSkuMatters(
  username: string,
  opts: { batchId?: string; status?: 'pending' | 'replied'; siteCode?: string; q?: string } = {},
): Promise<DesignatedSkuMatter[]> {
  const siteCodes = await getOmSiteCodes(username);
  if (opts.siteCode) {
    await assertOmSite(username, opts.siteCode);
  }
  return listMattersForSites(siteCodes, {
    batchId: opts.batchId,
    status: opts.status,
    q: opts.q,
  }).then((matters) =>
    opts.siteCode
      ? matters.filter((m) => m.site_code === opts.siteCode!.trim().toUpperCase())
      : matters,
  );
}

export async function replyDesignatedSkuAsOm(input: {
  username: string;
  userId: string;
  matterCode: string;
  items: MatterReplyItemInput[];
}): Promise<DesignatedSkuMatter> {
  const r = await query<{ site_code: string }>(
    'SELECT site_code FROM designated_sku_matters WHERE matter_code = $1',
    [input.matterCode],
  );
  const row = r.rows[0];
  if (!row) {
    throw new DesignatedSkuNotFoundError('找不到此事項，可能已被刪除');
  }
  await assertOmSite(input.username, row.site_code);
  return submitMatterReply({
    siteCode: row.site_code,
    matterCode: input.matterCode,
    items: input.items,
    repliedBy: `OM 代覆（${input.username}）`,
    repliedByUserId: input.userId,
  });
}
