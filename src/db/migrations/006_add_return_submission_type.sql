-- 006_add_return_submission_type.sql

ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_submission_type;
ALTER TABLE submissions ADD CONSTRAINT chk_submission_type CHECK (submission_type IN ('normal', 'urgent', 'sales', 'return'));

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS return_qty INTEGER;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS return_reason TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS return_confirmer_name TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS return_confirmer_phone TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS return_window_key TEXT;

ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_submission_qty;
ALTER TABLE submissions ADD CONSTRAINT chk_submission_qty CHECK (
  (submission_type = 'urgent' AND qty IS NOT NULL AND qty >= 1 AND qty <= 1000)
  OR (submission_type IN ('normal', 'sales', 'return') AND qty IS NULL)
);

ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_return_fields;
ALTER TABLE submissions ADD CONSTRAINT chk_return_fields CHECK (
  (
    submission_type = 'return'
    AND return_qty IS NOT NULL AND return_qty BETWEEN 1 AND 9999
    AND return_reason IS NOT NULL AND return_reason IN ('1', '2', '3', '4', '5', '6')
    AND return_confirmer_name IS NOT NULL AND btrim(return_confirmer_name) <> ''
    AND return_confirmer_phone IS NOT NULL AND btrim(return_confirmer_phone) <> ''
    AND return_window_key IS NOT NULL AND btrim(return_window_key) <> ''
  )
  OR (
    submission_type <> 'return'
    AND return_qty IS NULL
    AND return_reason IS NULL
    AND return_confirmer_name IS NULL
    AND return_confirmer_phone IS NULL
    AND return_window_key IS NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_return_submission_site_sku_window
  ON submissions (site_code, sku, return_window_key)
  WHERE submission_type = 'return';

CREATE INDEX IF NOT EXISTS idx_submissions_return_window
  ON submissions (submission_type, return_window_key);
