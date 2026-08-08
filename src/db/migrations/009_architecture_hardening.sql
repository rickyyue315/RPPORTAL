-- 009_architecture_hardening.sql

-- Keep the database invariant aligned with the public/admin validation rules.
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_rp_type;
ALTER TABLE submissions ADD CONSTRAINT chk_rp_type
  CHECK (rp_type IS NULL OR rp_type IN ('ND', 'RF'));

-- Idempotency keys are scoped to an import type. The API already resolves
-- retries by (submission_type, idempotency_key), so the database must use the
-- same scope rather than enforcing a global key.
DROP INDEX IF EXISTS uq_import_batches_idempotency_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_batches_type_idempotency_key
  ON import_batches (submission_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Shared rate-limit counters allow multiple application instances to enforce
-- the same limits without requiring a separate Redis service.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_reset_at
  ON rate_limit_counters (reset_at);
