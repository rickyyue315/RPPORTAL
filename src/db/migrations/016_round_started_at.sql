-- 016_round_started_at.sql
-- The Buyer auto-approve SLA must be measured from the start of the CURRENT
-- review round, not from the original submission time. Otherwise a reopened
-- submission (admin reopen starts review_round N+1) would be auto-approved
-- almost immediately because its original submitted_at is already old.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS round_started_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill: reopened submissions use the latest reopen event time; all other
-- rows keep their original submission time.
UPDATE submissions
   SET round_started_at = COALESCE(
     (SELECT e.created_at
        FROM ndrf_review_events e
       WHERE e.submission_id = submissions.id AND e.event_type = 'reopen'
       ORDER BY e.created_at DESC
       LIMIT 1),
     submitted_at
   );