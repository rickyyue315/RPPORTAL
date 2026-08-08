-- 010_query_optimization.sql
-- Composite indexes for the admin list/export queries, which filter by
-- (submission_type, application_date, exported_at) and sort by submitted_at.

CREATE INDEX IF NOT EXISTS idx_submissions_export_list
  ON submissions (submission_type, application_date, exported_at);

CREATE INDEX IF NOT EXISTS idx_submissions_date_submitted
  ON submissions (application_date, submitted_at);
