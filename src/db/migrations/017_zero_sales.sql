-- 017_zero_sales.sql
-- 90日零銷售 SKU 店舖回覆功能
-- Admin 每週上載 (Site Code + SKU + 上下文欄位)，店舖登入回覆原因

-- 原因選項 (Admin 可維護)
CREATE TABLE IF NOT EXISTS zero_sales_reasons (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  require_note BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO zero_sales_reasons (code, label, sort_order, active, require_note, updated_by) VALUES
  ('no_display', '1.無陳列/陳列位置不佳', 1, true, false, 'migration'),
  ('in_warehouse', '2.貨放舖倉未上架', 2, true, false, 'migration'),
  ('stolen', '3.被偷', 3, true, false, 'migration'),
  ('seasonal', '4.季節性/非當季產品', 4, true, false, 'migration'),
  ('price_promo', '5.價格/推廣問題', 5, true, false, 'migration'),
  ('other', '6.其他（須填補充）', 99, true, true, 'migration')
ON CONFLICT (code) DO NOTHING;

-- 每週派發批次
CREATE TABLE IF NOT EXISTS zero_sales_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_label TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  row_count INTEGER NOT NULL DEFAULT 0,
  store_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zero_sales_batches_created_at
  ON zero_sales_batches (created_at DESC);

-- 每行指派 (每店 SKU 可不同，上下文欄位存 JSONB)
CREATE TABLE IF NOT EXISTS zero_sales_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES zero_sales_batches(id) ON DELETE CASCADE,
  site_code TEXT NOT NULL,
  sku TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'replied')),
  reason_code TEXT,
  reason_label TEXT,
  reason_note TEXT NOT NULL DEFAULT '',
  replied_at TIMESTAMPTZ,
  replied_by TEXT,
  replied_by_user_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, site_code, sku)
);

CREATE INDEX IF NOT EXISTS idx_zero_sales_items_batch
  ON zero_sales_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_zero_sales_items_site
  ON zero_sales_items (site_code, status);
CREATE INDEX IF NOT EXISTS idx_zero_sales_items_status
  ON zero_sales_items (batch_id, status);
