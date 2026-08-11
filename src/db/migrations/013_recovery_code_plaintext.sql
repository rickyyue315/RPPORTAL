-- 013_recovery_code_plaintext.sql
-- Stores the plaintext recovery code so admins can view it in the backend
-- (user decision). The SHA-256 code_hash is kept for constant-time public
-- validation; the plaintext is only returned to authenticated admins via the
-- admin API and never to the public endpoints.
--
-- Existing rows keep their hashes but have no recoverable plaintext; admins
-- must rotate those codes once to see them again.

ALTER TABLE om_recovery_codes ADD COLUMN IF NOT EXISTS code TEXT;
