-- 019_zero_sales_edit_once.sql
-- 店舖回覆只可修改一次：初次回覆 + 1 次修改 = 最多 2 次寫入

ALTER TABLE zero_sales_items ADD COLUMN IF NOT EXISTS reply_count INTEGER NOT NULL DEFAULT 0;

-- 已回覆的舊資料視為已用 1 次 (仍可再改一次)
UPDATE zero_sales_items SET reply_count = 1 WHERE status = 'replied' AND reply_count = 0;
