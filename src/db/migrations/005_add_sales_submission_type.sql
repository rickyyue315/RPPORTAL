-- 005_add_sales_submission_type.sql

ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_submission_type;
ALTER TABLE submissions ADD CONSTRAINT chk_submission_type CHECK (submission_type IN ('normal', 'urgent', 'sales'));

ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_submission_qty;
ALTER TABLE submissions ADD CONSTRAINT chk_submission_qty CHECK (
  (submission_type = 'urgent' AND qty IS NOT NULL AND qty >= 1 AND qty <= 1000)
  OR (submission_type IN ('normal', 'sales') AND qty IS NULL)
);
