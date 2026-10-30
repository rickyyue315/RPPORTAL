import { query } from '../db/pool.js';

/**
 * 「最新上載報表的 OM」對照。
 *
 * 背景：I14「By Shop」每期都帶 OM 欄；店舖的 OM 可能中途轉手，若按每期
 * 報表自己的 OM 分組，舊期數會繼續顯示舊 OM（例如 HA19 之前是 Violet，
 * 最新一期已改為 Queenie）。營運上應以「最後上載的報表」為準，把所有
 * 歷史期數自動歸入目前 OM。
 *
 * 規則：
 *   1. 每間店取「最近一次上載」的報表 OM（同一 `created_at` 以 report_date、
 *      batch id 決勝）；報表 OM 空白時會歸入「未填 OM」，不會悄悄沿用舊 OM。
 *   2. 報表從未出現過的店舖，fallback 到門店主檔 `stores.om`。
 */
export interface EffectiveOmInfo {
  site_code: string;
  om: string;
  source: 'report' | 'stores';
}

export async function getEffectiveOmBySite(): Promise<Map<string, EffectiveOmInfo>> {
  const [stores, reports] = await Promise.all([
    query<{ site_code: string; om: string }>(
      `SELECT site_code, BTRIM(COALESCE(om, '')) AS om FROM stores`,
    ),
    query<{ site_code: string; om: string }>(
      `SELECT DISTINCT ON (s.site_code)
              s.site_code,
              BTRIM(s.om) AS om
         FROM shop_stock_snapshots s
         JOIN shop_stock_batches b ON b.id = s.batch_id
        ORDER BY s.site_code, b.created_at DESC, b.report_date DESC, b.id DESC`,
    ),
  ]);

  const map = new Map<string, EffectiveOmInfo>();
  for (const row of stores.rows) {
    if (!row.om) continue;
    map.set(row.site_code.toUpperCase(), {
      site_code: row.site_code.toUpperCase(),
      om: row.om,
      source: 'stores',
    });
  }
  // 最新報表優先：後寫入會覆蓋 stores.om。
  for (const row of reports.rows) {
    const siteCode = row.site_code.toUpperCase();
    map.set(siteCode, { site_code: siteCode, om: row.om, source: 'report' });
  }
  return map;
}

/** 回傳某店目前應歸屬的 OM；找不到回 null。 */
export async function getEffectiveOmForSite(siteCode: string): Promise<string | null> {
  const map = await getEffectiveOmBySite();
  return map.get(siteCode.trim().toUpperCase())?.om ?? null;
}
