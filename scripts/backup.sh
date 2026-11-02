#!/bin/sh
# 每日 Postgres 備份：pg_dump -Fc → 上傳 Storage Bucket → 清理過期檔案。
#
# 由 Railway cron service 執行（schedule `0 6,18 * * *` UTC = 02:00／14:00 香港時間）。
# 每次執行都會在 backup_runs 寫一筆紀錄；後台「系統 → 資料庫備份」只讀該表，
# 所以 cron 停掉時「上次備份：X 小時前」會變色，不需要額外監控。
#
# 設計取向：備份本身優先於簿記。寫不入 backup_runs 只會警告，dump 照做照上傳；
# 相反 dump 或上傳失敗就會標 failed 並以非 0 結束，Railway 會顯示部署失敗。
set -eu

log() { printf '[backup] %s\n' "$*"; }

require_env() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    log "缺少環境變數：$1"
    exit 1
  fi
}

for name in DATABASE_URL BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET \
            BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
  require_env "$name"
done

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
PREFIX="${BACKUP_S3_PREFIX:-db}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
KEY="${PREFIX}/$(date -u +%Y/%m)/ndrf-${STAMP}.dump"
TMP="/tmp/ndrf-${STAMP}.dump"

# hostname 只用於紀錄來源，過濾成安全字元後才拼入 SQL。
HOST="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-64)"
[ -n "$HOST" ] || HOST="cron"

STARTED_AT="$(date +%s)"
RUN_ID=""
STAGE=init
SUCCESS=0

psql_run() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -q "$@"; }

cleanup() {
  code=$?
  rm -f "$TMP"
  if [ "$SUCCESS" -ne 1 ]; then
    log "失敗於階段：${STAGE}（exit ${code}）"
    if [ -n "$RUN_ID" ]; then
      elapsed=$(( ($(date +%s) - STARTED_AT) * 1000 ))
      psql_run -c "UPDATE backup_runs
                      SET status = 'failed',
                          finished_at = now(),
                          duration_ms = ${elapsed},
                          error = 'failed at ${STAGE}'
                    WHERE id = ${RUN_ID}" >/dev/null 2>&1 || true
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

STAGE=record-start
RUN_ID="$(psql_run -c "INSERT INTO backup_runs (status, host) VALUES ('running', '${HOST}') RETURNING id" 2>/dev/null | tr -d '[:space:]' || true)"
if [ -n "$RUN_ID" ]; then
  log "run #${RUN_ID} 開始 → ${KEY}"
else
  log "警告：無法寫入 backup_runs（migration 035 未套用？），備份照做但後台不會顯示"
fi

STAGE=dump
log "pg_dump 開始"
pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$TMP" "$DATABASE_URL"
DUMP_BYTES="$(wc -c < "$TMP" | tr -d '[:space:]')"
log "pg_dump 完成：${DUMP_BYTES} bytes"

STAGE=upload
export RCLONE_CONFIG_BCK_TYPE=s3
export RCLONE_CONFIG_BCK_PROVIDER=Other
export RCLONE_CONFIG_BCK_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_BCK_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_BCK_ENDPOINT="$BACKUP_S3_ENDPOINT"
export RCLONE_CONFIG_BCK_REGION="${BACKUP_S3_REGION:-auto}"
export RCLONE_CONFIG_BCK_FORCE_PATH_STYLE="${BACKUP_S3_FORCE_PATH_STYLE:-false}"

log "上傳到 ${BACKUP_S3_BUCKET}/${KEY}"
rclone copyto "$TMP" "bck:${BACKUP_S3_BUCKET}/${KEY}" \
  --s3-chunk-size 8M --retries 3 --low-level-retries 5 --stats 0

# 清理失敗不應該令一次成功的備份變成失敗紀錄，所以只警告。
STAGE=prune
log "清理 ${RETENTION_DAYS} 日前的備份"
rclone delete "bck:${BACKUP_S3_BUCKET}/${PREFIX}" \
  --min-age "${RETENTION_DAYS}d" --include "*.dump" --stats 0 \
  || log "警告：清理過期備份失敗，請檢查 bucket 權限"

STAGE=record
ELAPSED_MS=$(( ($(date +%s) - STARTED_AT) * 1000 ))
if [ -n "$RUN_ID" ]; then
  psql_run -c "UPDATE backup_runs
                  SET status = 'success',
                      finished_at = now(),
                      object_key = '${KEY}',
                      dump_bytes = ${DUMP_BYTES},
                      duration_ms = ${ELAPSED_MS},
                      error = NULL
                WHERE id = ${RUN_ID}" >/dev/null \
    || log "警告：備份已上傳，但無法更新 backup_runs"
  # 執行紀錄保留 60 日；備份檔案本身由上面 rclone delete 按 7 日清理。
  psql_run -c "DELETE FROM backup_runs WHERE started_at < now() - interval '60 days'" >/dev/null 2>&1 || true
fi

SUCCESS=1
log "完成：${KEY}（${DUMP_BYTES} bytes，${ELAPSED_MS} ms）"
