-- 平台通告：後台「系統 → 平台通告」新增／排程，店舖與 OM 頁面顯示。
--
-- 為何放 DB 而不是寫死在前端腳本：改名通知這一類公告日後會不斷出現
-- （促銷、暫停收單、系統維護），每次改字都要改程式碼再部署並不合理。
--
-- 顯示規則（前台）：
--   is_active = true
--   AND (starts_at IS NULL OR starts_at <= now())
--   AND (ends_at   IS NULL OR ends_at   >  now())
-- 店舖按 X 之後以 localStorage 記住「通告 id + revision」，因此：
--   - 同一個版本：不再顯示（即使重新載入）
--   - 管理員按「重新推送」令 revision + 1：所有店舖會再見一次
CREATE TABLE IF NOT EXISTS portal_notices (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link_url   TEXT,
  link_text  TEXT,
  tone       TEXT NOT NULL DEFAULT 'info'
             CHECK (tone IN ('info', 'warning', 'success')),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  starts_at  TIMESTAMPTZ,
  ends_at    TIMESTAMPTZ,
  revision   INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 前台每次開頁都會查一次：條件是「生效中、按建立時間新到舊、最多 3 條」。
CREATE INDEX IF NOT EXISTS portal_notices_active_idx
  ON portal_notices (created_at DESC)
  WHERE is_active;

COMMENT ON TABLE portal_notices IS '店舖／OM 頁面的平台通告；由後台系統分頁維護';
COMMENT ON COLUMN portal_notices.revision IS '按「重新推送」時 +1；前端 localStorage 以 id+revision 記住已關閉';
COMMENT ON COLUMN portal_notices.tone IS 'info = 一般消息；warning = 需要注意；success = 好消息';

-- 把 2026-11-02 的改名通告接管過來，切換前後店舖見到的內容一致。
-- 之前關閉過的店舖會因為 key 由 rename_notice 轉為 notice:<id> 而再見一次，
-- 這是預期行為（順便讓已關閉的店舖看到定稿字眼）。
INSERT INTO portal_notices (title, body, tone, created_by, updated_by)
SELECT
  'RP Portal 已改名為 RP Connect — RP 連繫網申報平台',
  '網址、登入帳號及密碼全部不變。此平台與公司另一個「SASA Portal」無關，是 RP Team 向店舖發通告及收集回覆的平台。',
  'info',
  'migration-037',
  'migration-037'
WHERE NOT EXISTS (SELECT 1 FROM portal_notices);
