-- 015_buyer_auto_approve.sql
-- Company rule: a Buyer must review an ND submission within 7 days; if there
-- is no reply, the system auto-approves it (default agreement) and flags it
-- for Admin follow-up.
--
--   * submissions.auto_approved_at marks rows approved by the SLA job.
--   * ndrf_review_events gains the 'auto_accept' event type and the 'system'
--     actor role; the per-round decision uniqueness now covers auto_accept.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS auto_approved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_submissions_auto_approved
  ON submissions (auto_approved_at)
  WHERE auto_approved_at IS NOT NULL;

-- Extend the review event type/actor constraints (old rows stay valid).
ALTER TABLE ndrf_review_events DROP CONSTRAINT IF EXISTS ndrf_review_events_event_type_check;
ALTER TABLE ndrf_review_events ADD CONSTRAINT ndrf_review_events_event_type_check
  CHECK (event_type IN ('remark', 'accept', 'reject', 'override', 'reopen', 'auto_accept'));

ALTER TABLE ndrf_review_events DROP CONSTRAINT IF EXISTS ndrf_review_events_actor_role_check;
ALTER TABLE ndrf_review_events ADD CONSTRAINT ndrf_review_events_actor_role_check
  CHECK (actor_role IN ('store', 'buyer', 'sct', 'admin', 'system'));

-- Decision uniqueness per (submission, review round) now includes auto_accept
-- so the SLA job can never double-approve a round that a Buyer just decided.
DROP INDEX IF EXISTS uq_review_events_decision_round;
CREATE UNIQUE INDEX uq_review_events_decision_round
  ON ndrf_review_events (submission_id, review_round)
  WHERE event_type IN ('accept', 'reject', 'auto_accept');