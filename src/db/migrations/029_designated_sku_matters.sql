-- 029_designated_sku_matters.sql
-- 指定 SKU 回覆：由「每 SKU 一個單位」改為「一個事項 = 一間店舖的多個 SKU」
--
-- 背景：同一次派發可能涉及同一間店舖的多隻 SKU（例如一個品牌回收／調撥）。
-- 店舖應該見到一張「事項」，內含多個 SKU，逐個 SKU 填年期，一次提交。
--
-- 設計：
--   * 新增 designated_sku_matters（batch + site 一個事項，matter_code 對外識別）
--   * designated_sku_items 改為事項內的 SKU 明細（matter_id），移除逐 SKU 的 task_code
--   * no_transfer：店舖可明確表示某 SKU「無可調撥件數」，與「未回覆」區分
--   * 事項狀態不另存欄位，一律由旗下 SKU 的狀態推導（全部已回覆 = 已回覆），避免狀態漂移
--
-- 注意：本 migration 會把既有資料回填成「每個批次／店舖一個事項」，
-- 事項編號按 Site Code 排序重新編號；舊 task_code 不再保留（從未對外派發）。

-- ---------------------------------------------------------------------------
-- 1. 批次欄位改名：task_type -> matter_type
-- ---------------------------------------------------------------------------
ALTER TABLE designated_sku_batches RENAME COLUMN task_type TO matter_type;

-- ---------------------------------------------------------------------------
-- 2. 事項（一批次內同一店舖 = 一個事項）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS designated_sku_matters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES designated_sku_batches(id) ON DELETE CASCADE,
  -- 對外識別：例 DSKU-261026-0001-03
  matter_code TEXT NOT NULL UNIQUE,
  site_code TEXT NOT NULL CHECK (site_code <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一批次同一店舖只有一個事項
  UNIQUE (batch_id, site_code)
);

CREATE INDEX IF NOT EXISTS idx_designated_sku_matters_batch
  ON designated_sku_matters (batch_id);
CREATE INDEX IF NOT EXISTS idx_designated_sku_matters_site
  ON designated_sku_matters (site_code);

-- ---------------------------------------------------------------------------
-- 3. 回填既有資料：每個 (batch, site) 建立一個事項
-- ---------------------------------------------------------------------------
INSERT INTO designated_sku_matters (batch_id, site_code, matter_code)
SELECT s.batch_id, s.site_code, s.batch_code || '-' || lpad(s.rn::text, 2, '0')
  FROM (
    SELECT b.id AS batch_id,
           b.batch_code,
           i.site_code,
           dense_rank() OVER (PARTITION BY b.id ORDER BY i.site_code) AS rn
      FROM designated_sku_batches b
      JOIN designated_sku_items i ON i.batch_id = b.id
     GROUP BY b.id, b.batch_code, i.site_code
  ) s
ON CONFLICT (batch_id, site_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. SKU 明細：掛上事項、加入「無可調撥」旗標、移除逐 SKU 的 task_code
-- ---------------------------------------------------------------------------
ALTER TABLE designated_sku_items
  ADD COLUMN IF NOT EXISTS matter_id UUID REFERENCES designated_sku_matters(id) ON DELETE CASCADE;

UPDATE designated_sku_items i
   SET matter_id = m.id
  FROM designated_sku_matters m
 WHERE m.batch_id = i.batch_id
   AND m.site_code = i.site_code
   AND i.matter_id IS NULL;

ALTER TABLE designated_sku_items ALTER COLUMN matter_id SET NOT NULL;

-- task_code 連同其 UNIQUE 約束一併移除（事項編號已是唯一對外識別）
ALTER TABLE designated_sku_items DROP COLUMN IF EXISTS task_code;

ALTER TABLE designated_sku_items
  ADD COLUMN IF NOT EXISTS no_transfer BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_designated_sku_items_matter
  ON designated_sku_items (matter_id);
