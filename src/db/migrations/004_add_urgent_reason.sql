-- 004_add_urgent_reason.sql

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS urgent_reason TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS urgent_reason_other TEXT;

ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_urgent_reason;
ALTER TABLE submissions ADD CONSTRAINT chk_urgent_reason CHECK (
  urgent_reason IS NULL OR urgent_reason IN ('1','2','3','4','5','6','7','8','9')
);
