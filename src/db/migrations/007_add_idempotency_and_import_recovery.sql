-- 007_add_idempotency_and_import_recovery.sql

-- A client retry must resolve to the original submission instead of creating a
-- second row after a response is lost.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_submissions_idempotency_key
  ON submissions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Keep enough information to replay an Excel import response and download its
-- server-generated record without trusting a large client JSON payload.
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS submission_type TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS chk_import_batch_submission_type;
ALTER TABLE import_batches ADD CONSTRAINT chk_import_batch_submission_type
  CHECK (submission_type IN ('normal', 'urgent', 'sales', 'return'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_batches_idempotency_key
  ON import_batches (idempotency_key)
  WHERE idempotency_key IS NOT NULL;