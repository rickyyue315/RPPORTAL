-- 002_drop_rp_type_completed_at.sql

ALTER TABLE submissions DROP COLUMN IF EXISTS rp_type_completed_at;
