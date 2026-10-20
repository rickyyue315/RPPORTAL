-- 024_zero_sales_archive.sql
-- 90日零銷售「即時封存」：每個週次批次只在新一批次上載前可回覆。
-- closed_at IS NULL = 派發中（店舖可回覆、可修改一次）；非 NULL = 已封存（唯讀紀錄）。

ALTER TABLE zero_sales_batches ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE zero_sales_batches ADD COLUMN IF NOT EXISTS closed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE zero_sales_batches ADD COLUMN IF NOT EXISTS close_reason TEXT NOT NULL DEFAULT '';

-- 一次性回填：除最新一批外，其餘批次以「下一批建立時間」作為封存時間，
-- 令升級後即時符合「只有最新一週可回覆」的規則（不刪除、不改寫任何回覆紀錄）。
WITH ordered AS (
  SELECT id, LEAD(created_at) OVER (ORDER BY created_at, id) AS next_created_at
    FROM zero_sales_batches
)
UPDATE zero_sales_batches b
   SET closed_at = o.next_created_at,
       closed_by = 'migration',
       close_reason = 'auto'
  FROM ordered o
 WHERE b.id = o.id
   AND b.closed_at IS NULL
   AND o.next_created_at IS NOT NULL;

-- 查詢「哪一批仍開放」及店舖頁批次清單用
CREATE INDEX IF NOT EXISTS idx_zero_sales_batches_open
  ON zero_sales_batches (closed_at)
  WHERE closed_at IS NULL;
