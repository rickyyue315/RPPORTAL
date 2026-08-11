-- 012_om_recovery_codes.sql
-- Per-OM and master application-number recovery codes for the public
-- "搵返申請編號" feature. Codes are stored as SHA-256 hex hashes (hashed in
-- the application layer with node:crypto, never persisted in plaintext).
-- The reserved om value '__MASTER__' holds the platform-wide master code.

CREATE TABLE IF NOT EXISTS om_recovery_codes (
  om         TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
