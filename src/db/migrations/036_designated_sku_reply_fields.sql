-- 036_designated_sku_reply_fields.sql
-- 指定 SKU 回覆：回覆自定欄位（每批次不同，上限 10 個）
--
-- 背景：指定 SKU 回覆原本只有「貨品年期 (MMYY) + 可調撥件數」兩種固定欄位。
-- 實際派發有時是問卷式的（例如：Wall 架幾多行、5 層架幾多行、其他位置說明），
-- 每次欄位都不同，所以改為由批次自己定義回覆欄位。
--
-- 設計：
--   * reply_fields：欄位定義（JSONB 陣列），每項 { key, label, type, required, hint }
--     key 一經建立不改（回覆值用它對應），改名只影響顯示；上限 10 個由程式層擋。
--   * reply_values：店舖回覆值（JSONB 物件），存在指定 SKU 明細上。
--   * reply_mode：
--       stock_year — 只有年期／可調撥件數（預設，與舊批次完全相同）
--       custom     — 只有自定欄位（問卷式，不需要年期）
--       mixed      — 年期＋自定欄位兩者都要
--   * reply_scope：
--       item   — 每個 SKU 一套欄位（預設）
--       matter — 每間店（事項）一套欄位
--   * 「每間店一套」不需要新表：該事項會有一個 SKU = '0' 的佔位列
--     （stock_qty 為 NULL、不出現在店舖畫面的 SKU 清單），
--     回覆值照樣存在該列，事項狀態仍然由 SKU 狀態推導，毋須改任何狀態邏輯。
--     佔位 SKU 只是一條資料，不會與真實 SKU 撞（SaSa Article 為 9–12 位數字）。

ALTER TABLE designated_sku_batches
  ADD COLUMN IF NOT EXISTS reply_mode TEXT NOT NULL DEFAULT 'stock_year',
  ADD COLUMN IF NOT EXISTS reply_scope TEXT NOT NULL DEFAULT 'item',
  ADD COLUMN IF NOT EXISTS reply_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE designated_sku_batches
  ADD CONSTRAINT designated_sku_batches_reply_mode_check
    CHECK (reply_mode IN ('stock_year', 'custom', 'mixed')),
  ADD CONSTRAINT designated_sku_batches_reply_scope_check
    CHECK (reply_scope IN ('item', 'matter'));

-- 回覆值：{ "f1": "3", "f2": "2" }；沒有填的欄位不會出現（空白 ≠ 0）
ALTER TABLE designated_sku_items
  ADD COLUMN IF NOT EXISTS reply_values JSONB NOT NULL DEFAULT '{}'::jsonb;
