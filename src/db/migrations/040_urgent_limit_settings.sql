-- Urgent Order 旺季限額：後台「系統 → 審批設定」設定倍數及生效日期。
--
-- 為何放 DB：旺季（例如聖誕）會把 D001 庫存量對應的 Limit Qty 整體調高
-- 2–3 倍，但日期及倍數年年不同；寫死在前端就要每次改程式再部署。
--
-- 語意：
--   peak_multiplier = 1 或未設定日期 → 店舖見到基本 Limit Qty。
--   effective_from / effective_to 以香港日期計算，結束日當日仍生效。
--   生效期間 Limit Qty = floor(基本 Limit Qty × peak_multiplier)，並以
--   每筆 Urgent Order 上限 1000 件封頂。
CREATE TABLE IF NOT EXISTS urgent_limit_settings (
  id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  peak_multiplier  NUMERIC(4,2) NOT NULL DEFAULT 1
                   CHECK (peak_multiplier >= 1 AND peak_multiplier <= 5),
  effective_from   DATE,
  effective_to     DATE,
  note             TEXT NOT NULL DEFAULT '',
  updated_by       TEXT NOT NULL DEFAULT '',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT urgent_limit_settings_period_check CHECK (
    (effective_from IS NULL AND effective_to IS NULL)
    OR (
      effective_from IS NOT NULL
      AND effective_to IS NOT NULL
      AND effective_from <= effective_to
    )
  )
);

INSERT INTO urgent_limit_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE urgent_limit_settings IS 'Urgent Order 旺季限額（單列設定）；由後台審批設定維護';
COMMENT ON COLUMN urgent_limit_settings.peak_multiplier IS '旺季倍數，1 = 不調高；上限 5';
COMMENT ON COLUMN urgent_limit_settings.effective_from IS '旺季生效日期（香港日期，首日生效）';
COMMENT ON COLUMN urgent_limit_settings.effective_to IS '旺季結束日期（香港日期，當日仍生效）';
COMMENT ON COLUMN urgent_limit_settings.note IS '後台備註，例如「聖誕旺季」；會顯示在店舖提示';
