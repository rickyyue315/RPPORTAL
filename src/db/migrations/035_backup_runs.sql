-- 每日備份紀錄。由 Railway cron service 的 scripts/backup.sh 直接寫入
-- （pg_dump 前 INSERT running，完成後 UPDATE success／failed），應用程式只讀。
--
-- 為何不靠 object 清單判斷：bucket 只有最近 7 日，若 cron 靜靜死掉，
-- bucket 會一直留住舊檔，看不出「最新一份其實已經幾日前」。以時間戳判斷
-- 才可以在後台即時發現備份停了。
CREATE TABLE IF NOT EXISTS backup_runs (
  id          BIGSERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'success', 'failed')),
  object_key  TEXT,
  dump_bytes  BIGINT,
  duration_ms INTEGER,
  error       TEXT,
  host        TEXT NOT NULL DEFAULT ''
);

-- 「上次成功備份」是唯一會被高頻查詢的查詢路徑。
CREATE INDEX IF NOT EXISTS backup_runs_success_idx
  ON backup_runs (finished_at DESC)
  WHERE status = 'success';

CREATE INDEX IF NOT EXISTS backup_runs_started_idx
  ON backup_runs (started_at DESC);

COMMENT ON TABLE backup_runs IS '每日 pg_dump 備份紀錄；cron service 寫入，後台只讀';
COMMENT ON COLUMN backup_runs.status IS 'running = 進行中或中斷；success = dump 已上傳；failed = 中途失敗（詳見 cron log）';
COMMENT ON COLUMN backup_runs.object_key IS 'bucket 內的物件路徑，例如 db/2026/11/ndrf-20261102T060000Z.dump';
