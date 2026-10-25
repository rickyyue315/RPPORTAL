-- 026_shop_stock_snapshots.sql
-- 存貨儀表板（Inventory / Dead Stock Dashboard）
--
-- 資料源：I14「By Shop」每週存貨報表（每店一行，約 93 間店）。
--   檔案第 95 行是 Shop=Total 的全公司合計列，其 Site Code 會撞真店 HA02，
--   必須在匯入層剔除、永不入庫（本 migration 不處理，屬 service 層責任）。
--
-- 設計原則：
--   * 純新增：只建立新表與視圖，不改動任何既有表（zero_sales_* / stores 完全不動）
--   * 身份鍵是 report_date（一個檔期一批）；week_label 只作顯示，非唯一
--   * site_code 刻意不設 FK 到 stores：新店未入主檔不應令整批上載失敗
--   * 金額 / 數量一律 NUMERIC(18,6)，pg driver 回 string，由 service 層轉 number
--   * 明細保留 payload JSONB（原始列）以便追溯與日後補欄，毋須再改 schema
--
-- 基準數字（25Oct2026 檔，已剔除 Total／空白／頁腳）：93 店、
--   Shop Stock Value (CM) 331,846,573.47、Excess Stock Value (P90D 0 Sales) 27,840,384.31、佔比 8.3895%
--   上載後可用以下查詢核對（注意：為免干擾以分號切句的執行工具，註釋內不寫分號）：
--     SELECT store_count, report_date FROM shop_stock_batches ORDER BY report_date DESC LIMIT 1

-- ---------------------------------------------------------------------------
-- 每週批次（一個上載檔案 = 一批）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shop_stock_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 報表檔期：同一日期只允許一批，重複上載須先刪舊批或改用 ad_hoc
  report_date DATE NOT NULL UNIQUE,
  report_kind TEXT NOT NULL DEFAULT 'weekly'
    CHECK (report_kind IN ('weekly', 'month_end', 'ad_hoc')),
  -- 顯示用標籤（例：'2026-W43' / '25Oct2026'），不參與唯一性判斷
  week_label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  -- 原檔資料列數（含 Total／空白／頁腳）
  source_rows INTEGER NOT NULL DEFAULT 0,
  -- 實際入庫列數（= store_count，除錯時可比對）
  row_count INTEGER NOT NULL DEFAULT 0,
  store_count INTEGER NOT NULL DEFAULT 0,
  -- 被剔除的列數（Total 列、空白列、頁腳）
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  warn_count INTEGER NOT NULL DEFAULT 0,
  -- 檔案內容雜湊：重複上載偵測（同 hash 直接提示已匯入）
  content_hash TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- report_date 的唯一索引已由 UNIQUE 約束提供；此索引服務「最近匯入」列表
CREATE INDEX IF NOT EXISTS idx_shop_stock_batches_created_at
  ON shop_stock_batches (created_at DESC);

-- ---------------------------------------------------------------------------
-- 每店每期存貨明細（一批 = 約 93 行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shop_stock_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES shop_stock_batches(id) ON DELETE CASCADE,
  site_code TEXT NOT NULL CHECK (site_code <> ''),
  shop TEXT NOT NULL DEFAULT '',
  om TEXT NOT NULL DEFAULT '',
  shop_nature TEXT NOT NULL DEFAULT '',
  shop_type TEXT NOT NULL DEFAULT '',
  -- 原檔行號，供對帳（Total 列預期不會出現）
  source_row INTEGER,

  -- 90 日零銷售
  sku_count_0sale INTEGER,
  excess_qty_0sale NUMERIC(18,6),
  excess_value_0sale NUMERIC(18,6),
  -- 90 日銷量 <= 2
  sku_count_over2 INTEGER,
  excess_qty_over2 NUMERIC(18,6),
  excess_value_over2 NUMERIC(18,6),
  -- 合計呆貨
  excess_value_total NUMERIC(18,6),

  -- 存貨基礎
  shop_stock_qty_cm NUMERIC(18,6),
  shop_stock_value_cm NUMERIC(18,6),
  -- 90 日銷售表現（參考欄位，不參與 deadstock_ratio 計算）
  sold_qty_p90d NUMERIC(18,6),
  net_sales_p90d NUMERIC(18,6),

  -- 原始列（欄名 -> 值），保留以便日後補欄不用改 schema
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 同一批同一店只可一行；同時提供 batch_id 前綴查詢的索引
  UNIQUE (batch_id, site_code)
);

-- 單店歷史趨勢（Dashboard 走勢圖：WHERE site_code = $1 ORDER BY batch_id）
CREATE INDEX IF NOT EXISTS idx_shop_stock_snapshots_site
  ON shop_stock_snapshots (site_code, batch_id);

-- ---------------------------------------------------------------------------
-- 報表視圖：把批次維度攤平，並算好比率與資料品質旗標
--
-- deadstock_ratio         = excess_value_0sale / shop_stock_value_cm
-- deadstock_ratio_over2   = excess_value_over2 / shop_stock_value_cm
-- deadstock_ratio_total   = excess_value_total / shop_stock_value_cm
--
-- 分母保護：shop_stock_value_cm 為 NULL 或 <= 0 時比率回 NULL（不做除法），
-- 由 stock_value_missing / stock_value_invalid 旗標告知前端如何呈現。
-- 注意：比率是「每店」層級；全公司佔比請由 service 層先 SUM 再加總計算，
--       不可對本視圖的比率取平均（會令小店權重被放大）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_shop_weekly_deadstock AS
SELECT
  s.batch_id,
  b.report_date,
  b.report_kind,
  b.week_label,
  s.site_code,
  s.shop,
  s.om,
  s.shop_nature,
  s.shop_type,

  s.sku_count_0sale,
  s.excess_qty_0sale,
  s.excess_value_0sale,
  s.sku_count_over2,
  s.excess_qty_over2,
  s.excess_value_over2,
  s.excess_value_total,
  s.shop_stock_qty_cm,
  s.shop_stock_value_cm,
  s.sold_qty_p90d,
  s.net_sales_p90d,

  -- 比率（6 位小數，與欄位 scale 一致）
  CASE
    WHEN s.shop_stock_value_cm IS NULL OR s.shop_stock_value_cm <= 0 THEN NULL
    ELSE ROUND(s.excess_value_0sale / s.shop_stock_value_cm, 6)
  END AS deadstock_ratio,
  CASE
    WHEN s.shop_stock_value_cm IS NULL OR s.shop_stock_value_cm <= 0 THEN NULL
    ELSE ROUND(s.excess_value_over2 / s.shop_stock_value_cm, 6)
  END AS deadstock_ratio_over2,
  CASE
    WHEN s.shop_stock_value_cm IS NULL OR s.shop_stock_value_cm <= 0 THEN NULL
    ELSE ROUND(s.excess_value_total / s.shop_stock_value_cm, 6)
  END AS deadstock_ratio_total,

  -- 資料品質旗標
  (s.shop_stock_value_cm IS NULL) AS stock_value_missing,
  (s.shop_stock_value_cm IS NOT NULL AND s.shop_stock_value_cm <= 0) AS stock_value_invalid,
  (
    s.shop_stock_value_cm IS NOT NULL
    AND s.shop_stock_value_cm > 0
    AND s.excess_value_total IS NOT NULL
    AND (s.excess_value_total < 0 OR s.excess_value_total > s.shop_stock_value_cm)
  ) AS ratio_anomaly
FROM shop_stock_snapshots s
JOIN shop_stock_batches b ON b.id = s.batch_id;
