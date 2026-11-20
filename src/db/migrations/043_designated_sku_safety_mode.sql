-- 043_designated_sku_safety_mode.sql
-- 指定 SKU 回覆：新增「Safety 調整」模式
--
-- 背景：買手會派一份「每間店舖需要調整 Safety 的 SKU」清單（11 欄），
-- 店舖只需逐個 SKU 回覆「同意／不同意」，不同意可填原因或提供新 Safety 數字。
-- 這種批次不是年期／可調撥件數，也不是問卷式自定欄位，所以獨立一個模式：
--
--   reply_mode = 'safety'
--   reply_fields = 固定三個（由程式提供，不可在後台改名）
--       f1 回覆            choice  同意 / 不同意（必填）
--       f2 不同意原因      text    選填
--       f3 店舖建議 Safety number  選填
--
-- 顯示用的 11 欄（品牌、描述、問題類型、建議方法、存貨、月銷、可售日、
-- 現時／建議 Safety、增減）存在 designated_sku_items.payload，
-- key 以 "Safety:" 開頭，見 src/lib/designatedSku.ts。

ALTER TABLE designated_sku_batches
  DROP CONSTRAINT IF EXISTS designated_sku_batches_reply_mode_check;

ALTER TABLE designated_sku_batches
  ADD CONSTRAINT designated_sku_batches_reply_mode_check
    CHECK (reply_mode IN ('stock_year', 'custom', 'mixed', 'safety'));
