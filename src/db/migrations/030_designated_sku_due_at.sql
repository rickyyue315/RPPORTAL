-- 030: 指定 SKU 回覆 — 截止時間改為「日期 + 時間」（香港時間）
--
-- 原本 due_date 只有 DATE，而且純粹作顯示用，逾期不會有任何效果。
-- 改為 due_at TIMESTAMPTZ：
--   * 後台以香港時間輸入（例 2026-11-10 18:00），DB 存對應 UTC 時刻
--   * is_open 一律由 closed_at 與 due_at 推導（過期即視為截止，店舖不能再提交）
--   * 管理員仍可手動封存／重開；重開後若 due_at 已過，需要同時延長期限
--
-- 舊資料回填為當日 23:59（HKT = UTC+8；香港自 1979 年起沒有夏令時間，
-- 所以用固定 +08 偏移換算，不依賴資料庫的時區資料）。

ALTER TABLE designated_sku_batches ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;

UPDATE designated_sku_batches
   SET due_at = ((due_date::text || ' 23:59:00+08')::timestamptz)
 WHERE due_date IS NOT NULL
   AND due_at IS NULL;

ALTER TABLE designated_sku_batches DROP COLUMN IF EXISTS due_date;

CREATE INDEX IF NOT EXISTS idx_dsku_batches_due_at ON designated_sku_batches (due_at);
