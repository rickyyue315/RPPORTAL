-- 031_zero_sales_no_reply.sql
-- 「本週無須回覆」：批次照常派發（店舖仍可看見本店 Top 10 SKU 清單作銷售參考），
-- 但不需要逐條回覆。適合銷售繁忙期（例如旺季、大檔期）減輕店舖工作量。
--
-- reply_required = false 的週次（無論開放或已封存）：
--   * 店舖回覆 API 拒絕寫入（HTTP 409 / code = REPLY_NOT_REQUIRED）
--   * 不計入 pending / 待回覆店舖 / overdue 統計，亦不影響回覆率
--   * 已存在嘅回覆（例如切換前店舖已提交）一律保留，只作紀錄
--   * 管理員可隨時切回「需要回覆」，未回覆的行即重新變成待回覆

ALTER TABLE zero_sales_batches ADD COLUMN IF NOT EXISTS reply_required BOOLEAN NOT NULL DEFAULT true;
-- 給店舖看的說明（例如「本週銷售繁忙期，無須回覆；請優先銷售以下 SKU」），空白時前端用預設文案
ALTER TABLE zero_sales_batches ADD COLUMN IF NOT EXISTS reply_notice TEXT NOT NULL DEFAULT '';

-- 現有批次全部維持「需要回覆」，不需回填
UPDATE zero_sales_batches SET reply_required = true WHERE reply_required IS NULL;

-- 查詢「有哪些週次無須回覆」用（統計 / 待辦排除）
CREATE INDEX IF NOT EXISTS idx_zero_sales_batches_no_reply
  ON zero_sales_batches (created_at DESC)
  WHERE reply_required = false;
