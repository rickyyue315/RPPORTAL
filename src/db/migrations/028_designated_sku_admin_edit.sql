-- 028_designated_sku_admin_edit.sql
-- 指定 SKU 回覆：管理員代店舖輸入／修改回覆
--
-- 背景：店舖可能以 email／WhatsApp 補交或要求更正，管理員需要在後台代為填寫，
-- 而且即使批次已封存（截止）亦要可以更正紀錄。
--
-- 設計：
--   * 只加兩欄記錄「最近一次由管理員修改」的時間及帳號，方便日後查閱；
--   * 店舖原本的 replied_by / reply_count 不會被管理員修改覆蓋（代填除外）；
--   * 真正的內容以 designated_sku_reply_lines 為準，修改會整批取代該單位的明細。

ALTER TABLE designated_sku_items
  ADD COLUMN IF NOT EXISTS admin_edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_edited_by TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN designated_sku_items.admin_edited_at IS
  '最近一次由管理員代填／修改回覆的時間（NULL = 店舖自行回覆且未經管理員修改）';
COMMENT ON COLUMN designated_sku_items.admin_edited_by IS
  '最近一次代填／修改的管理員帳號';
