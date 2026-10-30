-- 032_om_portal.sql
-- OM（區域主管）Portal：
--   * portal_users 新增 'om' 角色；OM 帳戶以「OM 名稱」作 username，site_code 為 NULL。
--   * 執行期 OM 管理的店舖 = 最新上載存貨報表的 OM（無報表時 fallback stores.om）。
--   * 登入密碼由環境變數 PORTAL_OM_PASSWORD 控制（預設 SASAOM178），
--     與店舖共用密碼分開；OM 帳戶的 password_hash 刻意設為不可用格式。
--
-- 先為現有門店主檔的 OM 建立帳戶；日後新增 OM（包括最新報表轉手的新 OM）
-- 會在門店主檔同步、存貨報表上載或應用程式重啟時自動建立。

ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE portal_users ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('store', 'buyer', 'sct', 'om'));

ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_check;
ALTER TABLE portal_users ADD CONSTRAINT portal_users_check
  CHECK (
    (role = 'store' AND site_code IS NOT NULL AND site_code <> '')
    OR (role IN ('buyer', 'sct', 'om') AND site_code IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_portal_users_role_active_om
  ON portal_users (active)
  WHERE role = 'om';

INSERT INTO portal_users (
  username, display_name, role, site_code, password_hash,
  initial_password, must_change_password, active, created_by
)
SELECT DISTINCT
  UPPER(BTRIM(s.om)),
  BTRIM(s.om),
  'om',
  NULL,
  'unusable$om-portal',
  NULL,
  false,
  true,
  'migration'
FROM stores s
WHERE BTRIM(COALESCE(s.om, '')) <> ''
ON CONFLICT (username) DO NOTHING;
