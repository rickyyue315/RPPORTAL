-- 039_portal_login_stats_index.sql
-- 後台「店舖登入統計」查詢：
--   * 成功登入由 audit_events（event_type = 'portal_login'）按時間聚合。
--   * 失敗登入由 portal_login_attempts（success = false）按時間聚合。
-- 現有索引以 application_no / event_type 為主；以下 partial index 針對
-- 登入統計的日期範圍掃描，避免 audit_events 累積後每次查詢都全表掃描。

CREATE INDEX IF NOT EXISTS idx_audit_events_portal_login_created_at
  ON audit_events (created_at)
  WHERE event_type = 'portal_login';

CREATE INDEX IF NOT EXISTS idx_portal_login_attempts_failed_time
  ON portal_login_attempts (attempted_at)
  WHERE success = false;
