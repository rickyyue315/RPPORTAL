-- 014_ndrf_workflow_portal.sql
-- Adds the general NDRF review workflow: portal accounts (Store/Buyer/SCT),
-- SKU Master, store routing, rejection reasons, review events and the
-- workflow state machine columns on submissions.
--
-- Design rules from the implementation plan:
--   * Existing normal NDRF submissions become inactive Legacy/Received.
--   * Urgent / sales / return submissions keep their existing behaviour.
--   * Decisions are append-only review events; a decision is unique per
--     (submission_id, review_round) at the database level.
--   * Active "Site + SKU + RP Type" uniqueness is enforced by a partial
--     unique index (transaction/advisory locks are added in the service).
--   * One active Store account per Site Code and at most one active SCT.

-- ---------------------------------------------------------------------------
-- Portal users (Store / Buyer / SCT)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('store', 'buyer', 'sct')),
  site_code TEXT,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (role = 'store' AND site_code IS NOT NULL AND site_code <> '')
    OR (role IN ('buyer', 'sct') AND site_code IS NULL)
  )
);

-- One active Store account per Site Code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_users_store_site
  ON portal_users (site_code)
  WHERE role = 'store' AND active AND site_code IS NOT NULL;

-- At most one active SCT account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_users_active_sct
  ON portal_users (role)
  WHERE role = 'sct' AND active;

CREATE INDEX IF NOT EXISTS idx_portal_users_role_active
  ON portal_users (role, active);

-- ---------------------------------------------------------------------------
-- Portal sessions and login attempts (separate from admin sessions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_user_id
  ON portal_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_expires_at
  ON portal_sessions (expires_at);

CREATE TABLE IF NOT EXISTS portal_login_attempts (
  id BIGSERIAL PRIMARY KEY,
  ip TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  success BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_login_attempts_ip_time
  ON portal_login_attempts (ip, attempted_at DESC);

-- ---------------------------------------------------------------------------
-- SKU Master: each SKU is owned by exactly one Buyer account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sku_master (
  sku TEXT PRIMARY KEY,
  buyer_user_id UUID NOT NULL REFERENCES portal_users(id),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sku_master_buyer
  ON sku_master (buyer_user_id);

-- Immutable snapshot of each full replacement, so an old master can be
-- restored and audited.
CREATE TABLE IF NOT EXISTS sku_master_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  row_count INTEGER NOT NULL,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Rejection reason catalogue (admin-maintained; labels are snapshotted into
-- review events so history stays stable after renames/deactivation).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ndrf_rejection_reasons (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ndrf_rejection_reasons (code, label, sort_order, active, updated_by) VALUES
  ('duplicate', '重複申請', 1, true, 'migration'),
  ('data_error', '資料錯誤', 2, true, 'migration'),
  ('insufficient_info', '資料不完整', 3, true, 'migration'),
  ('stock_issue', '庫存/缺貨問題', 4, true, 'migration'),
  ('policy', '不符合申報政策', 5, true, 'migration'),
  ('other', '其他', 99, true, 'migration')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Store routing settings. The old RF_REMARK_REQUIRED_SITES list is used as a
-- migration seed only; runtime reads this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ndrf_store_routes (
  site_code TEXT PRIMARY KEY,
  sct_review_required BOOLEAN NOT NULL DEFAULT false,
  remark_required BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ndrf_store_routes (site_code, sct_review_required, remark_required, updated_by) VALUES
  ('HA19', true, true, 'migration'),
  ('HA21', true, true, 'migration'),
  ('HA33', true, true, 'migration'),
  ('HA37', true, true, 'migration'),
  ('HB77', true, true, 'migration'),
  ('HB86', true, true, 'migration'),
  ('HB87', true, true, 'migration'),
  ('HB91', true, true, 'migration'),
  ('HBA5', true, true, 'migration'),
  ('HBA7', true, true, 'migration'),
  ('HC13', true, true, 'migration'),
  ('HC44', true, true, 'migration'),
  ('HC68', true, true, 'migration'),
  ('HC70', true, true, 'migration')
ON CONFLICT (site_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Submission workflow columns (general NDRF only).
-- ---------------------------------------------------------------------------
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS ndrf_route TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS workflow_status TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS active_workflow BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS review_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS current_review_remark TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS created_by_portal_user_id UUID;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS shop_snapshot TEXT;

ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_submissions_ndrf_route;
ALTER TABLE submissions ADD CONSTRAINT chk_submissions_ndrf_route
  CHECK (ndrf_route IS NULL OR ndrf_route IN ('buyer', 'sct', 'rp', 'legacy'));

ALTER TABLE submissions DROP CONSTRAINT IF EXISTS chk_submissions_workflow_status;
ALTER TABLE submissions ADD CONSTRAINT chk_submissions_workflow_status
  CHECK (workflow_status IS NULL OR workflow_status IN ('legacy', 'pending', 'ready_for_rp', 'accepted', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_submissions_ndrf_route
  ON submissions (ndrf_route)
  WHERE ndrf_route IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_workflow_status
  ON submissions (workflow_status)
  WHERE workflow_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_created_by_portal
  ON submissions (created_by_portal_user_id)
  WHERE created_by_portal_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_rejected_cooldown
  ON submissions (site_code, sku, rp_type, rejected_at)
  WHERE workflow_status = 'rejected';

-- At most one active (unexported) submission per Site + SKU + RP Type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_submissions_active_workflow_key
  ON submissions (site_code, sku, rp_type)
  WHERE active_workflow AND submission_type = 'normal';

-- ---------------------------------------------------------------------------
-- Append-only review events. Decision is unique per (submission, review round)
-- so a network retry can never create a second Accept/Reject.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ndrf_review_events (
  id BIGSERIAL PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  review_round INTEGER NOT NULL DEFAULT 1,
  event_type TEXT NOT NULL CHECK (event_type IN ('remark', 'accept', 'reject', 'override', 'reopen')),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('store', 'buyer', 'sct', 'admin')),
  actor_user_id UUID,
  actor TEXT NOT NULL,
  remark TEXT,
  reject_reason_code TEXT,
  reject_reason_label TEXT,
  reject_reason_note TEXT,
  reason TEXT,
  ip TEXT,
  ip_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_review_events_decision_round
  ON ndrf_review_events (submission_id, review_round)
  WHERE event_type IN ('accept', 'reject');

CREATE INDEX IF NOT EXISTS idx_review_events_submission
  ON ndrf_review_events (submission_id, review_round, created_at);

-- ---------------------------------------------------------------------------
-- Import batch ownership (Store-scoped normal imports).
-- ---------------------------------------------------------------------------
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS portal_user_id UUID;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS site_code TEXT;

CREATE INDEX IF NOT EXISTS idx_import_batches_portal
  ON import_batches (portal_user_id)
  WHERE portal_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Version actor roles now include portal roles; old rows stay valid.
-- ---------------------------------------------------------------------------
ALTER TABLE submission_versions DROP CONSTRAINT IF EXISTS submission_versions_actor_role_check;
ALTER TABLE submission_versions ADD CONSTRAINT submission_versions_actor_role_check
  CHECK (actor_role IN ('applicant', 'admin', 'store', 'buyer', 'sct'));

-- ---------------------------------------------------------------------------
-- Cutover: all existing general NDRF submissions become inactive Legacy.
-- Urgent / sales / return keep their existing behaviour.
-- ---------------------------------------------------------------------------
UPDATE submissions
   SET ndrf_route = 'legacy',
       workflow_status = 'legacy',
       active_workflow = false
 WHERE submission_type = 'normal'
   AND ndrf_route IS NULL
   AND workflow_status IS NULL;
