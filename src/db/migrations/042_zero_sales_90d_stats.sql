-- 042_zero_sales_90d_stats.sql
-- 「90日0銷售（統計）」每週摘要
--
-- 資料源：RP Team 每週「90日0銷售（統計）」簡報（Sasa 版面），不是 I14「By Shop」。
--   簡報每期只有 6 個數字 + 店數，I14 的 No. of Overstock SKU (P90D 0 Sales) 口徑不同
--   （實測 25Oct2026 檔合計 61,488，簡報同期只有 6,xxx），兩者不可互相推算。
--
-- 設計原則：
--   * 純新增，不改動 shop_stock_* / zero_sales_* 任何既有表
--   * 身份鍵是 report_date（一期一列），重複輸入 = 覆蓋該期（ON CONFLICT）
--   * 只存 MAKE UP / Non-MAKE UP 兩個分項，總數由服務層相加，避免出現「總數 ≠ 分項和」
--   * 數量一律 NUMERIC(18,3)；SKU 數與店數為整數
--   * 缺值不寫 0：兩個分項與店數都是 NOT NULL，前端必須填齊才可以存檔
--
-- 回填：2026-10-06 至 2026-11-17 共 7 期，數字照 2026-11-20 提供的統計簡報。
--   ON CONFLICT DO NOTHING —— 若同一期已有人輸入（或日後重跑），不會覆蓋畫面上的數字。

CREATE TABLE IF NOT EXISTS zero_sales_90d_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date DATE NOT NULL UNIQUE,
  -- 該期簡報的「xx 間 Shops」
  shop_count INTEGER NOT NULL CHECK (shop_count >= 0),
  -- MAKE UP（陳列／化妝品類）分項
  makeup_sku INTEGER NOT NULL CHECK (makeup_sku >= 0),
  makeup_qty_cm NUMERIC(18,3) NOT NULL CHECK (makeup_qty_cm >= 0),
  -- Non-MAKE UP 分項
  non_makeup_sku INTEGER NOT NULL CHECK (non_makeup_sku >= 0),
  non_makeup_qty_cm NUMERIC(18,3) NOT NULL CHECK (non_makeup_qty_cm >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 最後修改者（admin 帳號）；新增時一併寫入
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_zero_sales_90d_report_date
  ON zero_sales_90d_stats (report_date DESC);

INSERT INTO zero_sales_90d_stats
  (report_date, shop_count, makeup_sku, makeup_qty_cm, non_makeup_sku, non_makeup_qty_cm, note, updated_by)
VALUES
  ('2026-10-06', 87, 2605, 100669, 4013, 152535, '由 90日0銷售統計簡報回填', 'migration'),
  ('2026-10-14', 87, 2598, 100931, 3979, 143260, '由 90日0銷售統計簡報回填', 'migration'),
  ('2026-10-20', 87, 2584, 101325, 3992, 136406, '由 90日0銷售統計簡報回填', 'migration'),
  ('2026-10-27', 86, 2551,  97378, 3944, 123948, '由 90日0銷售統計簡報回填', 'migration'),
  ('2026-11-03', 88, 2617, 106073, 4076, 132885, '由 90日0銷售統計簡報回填', 'migration'),
  ('2026-11-10', 88, 2602, 105979, 4068, 131180, '由 90日0銷售統計簡報回填', 'migration'),
  ('2026-11-17', 88, 2575, 102676, 4084, 128212, '由 90日0銷售統計簡報回填', 'migration')
ON CONFLICT (report_date) DO NOTHING;
