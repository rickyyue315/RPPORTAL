-- 011_cleanup_legacy_schema.sql
-- Removes the legacy columns that are no longer referenced anywhere in the
-- application, but refuses to run if production rows still carry values so
-- data is never silently destroyed. Also drops the single-value CHECK on
-- status; the 'received' value is guaranteed by the application layer.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM submissions
    WHERE supply_source IS NOT NULL OR rp_parameters_change_request IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'refusing to drop legacy columns: some submissions still use supply_source or rp_parameters_change_request';
  END IF;
END $$;

ALTER TABLE submissions DROP COLUMN IF EXISTS supply_source;
ALTER TABLE submissions DROP COLUMN IF EXISTS rp_parameters_change_request;
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_status_check;
