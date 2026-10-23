-- 025_zero_sales_auto_reply.sql
-- 重複上榜 SKU 自動套用上次回覆：
--   * 只會套用於仍 pending 的行，永不覆寫店舖已提交的回覆
--   * 記錄套用來源（批次 / 週次），方便追查
--   * 自動套用的行 reply_limit = 3（系統套用 1 次 + 店舖可再修改 2 次）
--   * 其他行維持 reply_limit = 2（初次回覆 + 1 次修改）

ALTER TABLE zero_sales_items ADD COLUMN IF NOT EXISTS auto_filled_at TIMESTAMPTZ;
ALTER TABLE zero_sales_items ADD COLUMN IF NOT EXISTS auto_filled_from_batch_id UUID;
ALTER TABLE zero_sales_items ADD COLUMN IF NOT EXISTS auto_filled_from_week TEXT NOT NULL DEFAULT '';
ALTER TABLE zero_sales_items ADD COLUMN IF NOT EXISTS reply_limit INTEGER NOT NULL DEFAULT 2;

-- 舊資料沿用原有上限；只有日後由系統自動套用的行才會提升至 3
UPDATE zero_sales_items SET reply_limit = 2 WHERE reply_limit IS NULL OR reply_limit < 2;

-- 自動套用回覆的行通常仍會按店舖 / SKU 查詢
CREATE INDEX IF NOT EXISTS idx_zero_sales_items_auto_filled
  ON zero_sales_items (batch_id)
  WHERE auto_filled_at IS NOT NULL;
