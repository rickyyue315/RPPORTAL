-- 001_init.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Store master data
CREATE TABLE IF NOT EXISTS stores (
  site_code TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  regional TEXT,
  class1 TEXT,
  class2 TEXT,
  size TEXT,
  om TEXT,
  type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Submissions
CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_no TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('web', 'excel')),
  site_code TEXT NOT NULL,
  requested_by_email TEXT NOT NULL,
  application_date DATE NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  brand TEXT,
  sku TEXT NOT NULL,
  rp_type TEXT,
  supply_source TEXT,
  safety_stock TEXT,
  nd_code TEXT,
  rp_parameters_change_request TEXT,
  remark TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status = 'received'),
  exported_at TIMESTAMPTZ,
  export_batch_id UUID,
  locked_at TIMESTAMPTZ,
  created_ip TEXT,
  created_ip_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submissions_site_code ON submissions (site_code);
CREATE INDEX IF NOT EXISTS idx_submissions_application_date ON submissions (application_date);
CREATE INDEX IF NOT EXISTS idx_submissions_sku ON submissions (sku);
CREATE INDEX IF NOT EXISTS idx_submissions_exported_at ON submissions (exported_at);
CREATE INDEX IF NOT EXISTS idx_submissions_locked_at ON submissions (locked_at);

-- Immutable version history per submission
CREATE TABLE IF NOT EXISTS submission_versions (
  id BIGSERIAL PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data_before JSONB,
  data_after JSONB NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('applicant', 'admin')),
  actor TEXT,
  ip TEXT,
  change_source TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, version)
);

CREATE INDEX IF NOT EXISTS idx_submission_versions_submission_id ON submission_versions (submission_id);

-- Import batches (Excel uploads)
CREATE TABLE IF NOT EXISTS import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Export batches (SAP exports; lock submissions at creation)
CREATE TABLE IF NOT EXISTS export_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  submission_count INTEGER NOT NULL,
  submission_nos JSONB NOT NULL DEFAULT '[]'::jsonb,
  filters JSONB,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit events
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_role TEXT,
  actor TEXT,
  submission_id UUID,
  application_no TEXT,
  ip TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_application_no ON audit_events (application_no);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events (event_type);

-- Admin sessions (server-side, DB-backed)
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ
);

-- Admin login attempt tracking (lockout)
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  success BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_ip_time ON admin_login_attempts (ip, attempted_at DESC);
