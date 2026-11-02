-- 033_portal_per_user_password.sql
-- 逐帳戶密碼（Store 與 OM）：
--   * password_issued_at   — 管理員生成／重設密碼的時間（NULL = 從未發放）
--   * password_notified_at — 管理員標記「已通知」的時間（NULL = 未通知）
--
-- 密碼本身沿用既有欄位，不需要新欄位：
--   password_hash     scrypt 雜湊（020 的 initial_password 欄存後台可見明文）
--   initial_password  後台可檢視的明文；NULL 代表未發放
--
-- 刻意不新增 contact_email：店舖的聯絡信箱由 site_code 衍生
-- （lower(site_code) || '@sasa.com'，見 src/routes/public.ts），
-- OM 沒有 site_code，由管理員自行以 WhatsApp／口頭通知。
--
-- 不依賴 pgcrypto（測試環境會剝離 CREATE EXTENSION）。

ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS password_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_notified_at TIMESTAMPTZ;

-- 登入防爆破查詢用。
-- L1：同一 username + ip 於時間窗內的失敗次數。
CREATE INDEX IF NOT EXISTS idx_portal_login_attempts_username_ip_time
  ON portal_login_attempts (username, ip, attempted_at DESC);

-- L2：同一 username 跨 IP 的失敗次數（防止換 IP 繼續試）。
CREATE INDEX IF NOT EXISTS idx_portal_login_attempts_username_time
  ON portal_login_attempts (username, attempted_at DESC);
