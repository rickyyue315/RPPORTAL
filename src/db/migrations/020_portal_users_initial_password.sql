-- 020_portal_users_initial_password.sql
-- Allows admins to view the last admin-generated (initial) password in the
-- backend instead of showing it only once, so stores do not need constant
-- resets. Admins keep per-account reset capability.
--
-- Stores the plaintext of the last admin-generated password (store sync,
-- buyer/SCT creation, admin reset). It is only returned to authenticated
-- admins via the admin API, never to portal users or public endpoints.
-- The column is cleared (NULL) as soon as the holder changes the password
-- themselves, so user-chosen passwords are never viewable.
--
-- Existing rows keep their hashes but have no recoverable plaintext; admins
-- must reset those accounts once to see a password again.

ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS initial_password TEXT;
