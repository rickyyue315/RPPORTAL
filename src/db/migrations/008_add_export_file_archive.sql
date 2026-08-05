-- 008_add_export_file_archive.sql

-- Formal exports are immutable handoff files. Keep the binary separate from
-- export_batches so batch listing queries do not read large TOAST values.
CREATE TABLE IF NOT EXISTS export_batch_files (
  export_batch_id UUID PRIMARY KEY REFERENCES export_batches(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_data BYTEA,
  file_size BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_export_batch_files_expires_at
  ON export_batch_files (expires_at);
