-- 022_portal_passwordless.sql
-- The whole portal (Store / Buyer / SCT) is permanently passwordless
-- (username only). Clear any remaining forced-password-change gates and
-- admin-viewable initial passwords. Password hashes are left as-is (unused
-- by the login path); sessions are untouched.
UPDATE portal_users
   SET must_change_password = false,
       initial_password = NULL,
       updated_at = now()
 WHERE must_change_password OR initial_password IS NOT NULL;
