-- 021_store_passwordless.sql
-- Store accounts are passwordless (Site Code only). Clear the stale
-- forced-password-change gate and admin-viewable initial passwords left over
-- from when stores used passwords. Password hashes are left as-is (unused by
-- the store login path); sessions are untouched.
UPDATE portal_users
   SET must_change_password = false,
       initial_password = NULL,
       updated_at = now()
 WHERE role = 'store';
