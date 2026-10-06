-- 023_zero_sales_repeat_index.sql
-- 重複上榜查詢加速：按 (店舖, SKU) 跨批次統計出現次數及上次回覆
CREATE INDEX IF NOT EXISTS idx_zero_sales_items_site_sku
  ON zero_sales_items (site_code, sku);
