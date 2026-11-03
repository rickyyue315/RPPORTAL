-- 038_drop_om_recovery_codes.sql
-- Recovery Code is obsolete: every store now has its own portal account, and
-- "搵返申請編號" is authorised by the store portal session instead.
-- This only drops the recovery-code settings table; submissions and version
-- history are not referenced by it and are unaffected.

DROP TABLE IF EXISTS om_recovery_codes;
