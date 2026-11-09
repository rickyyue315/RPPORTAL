-- 041_urgent_qty_peak_limit.sql
--
-- Urgent Order 旺季期間每筆 QTY 上限會跟隨最高一級 Limit Qty 提高。
-- 目前最高一級基本值 492、倍數上限 5，絕對上限為 492 × 5 = 2460。
--
-- DB CHECK 只負責絕對防線；實際每筆上限由 `getUrgentQtyMax()` 按
-- urgent_limit_settings 的生效日期及倍數決定（非旺季仍為 1000）。
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_submission_qty;
ALTER TABLE submissions ADD CONSTRAINT chk_submission_qty CHECK (
  (submission_type = 'urgent' AND qty IS NOT NULL AND qty >= 1 AND qty <= 2460)
  OR (submission_type IN ('normal', 'sales', 'return') AND qty IS NULL)
);
