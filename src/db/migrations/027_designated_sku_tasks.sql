-- 027_designated_sku_tasks.sql
-- 指定 SKU 回覆（Designated SKU Reply）
--
-- 用途：Admin 上載一份「指定 SKU」Excel（每行 = 一間店 + 一隻 SKU + 存貨），
-- 系統按 Site Code 只向該店舖派發一個任務；店舖登入後就每個「貨品年期 (MMYY)」
-- 回覆可調撥件數（同一 SKU 存貨 2 件以上可能有多個年期，故回覆是多行）。
--
-- 設計原則：
--   * 純新增，不改動任何既有表（zero_sales_* / shop_stock_* / stores 完全不動）
--   * 任務 = 一行 Excel（batch + site + sku），有自己的 task_code 供直 link 及日後查閱
--   * 回覆明細拆成 designated_sku_reply_lines，年期 + 件數可多行，數量不設上限（前端按存貨提示）
--   * site_code 不設 FK 到 stores：新店未入主檔不應令整批上載失敗（由匯入層警告／剔除）
--   * 預留欄位：settings JSONB + 下列 instructions / due_date / reference / note 全部可空白；
--     空白時前端自動隱藏，將來新增任務類型毋須再改 schema
--   * stock_qty 可為 NULL（原檔缺值／非數字），NULL 不代表 0，回覆上限檢查會跳過

-- ---------------------------------------------------------------------------
-- 批次編號序列：DSKU-YYMMDD-NNNN（全域遞增，避免同日併發上載撞號）
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS designated_sku_batch_seq;

-- ---------------------------------------------------------------------------
-- 批次（一次上載 = 一批任務）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS designated_sku_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 人類可讀批次編號，例：DSKU-261026-0001；店舖／管理員日後查閱用
  batch_code TEXT NOT NULL UNIQUE,
  -- 任務主題（後台手動輸入，例：指定 SKU 存貨年期確認）
  subject TEXT NOT NULL DEFAULT '',
  -- 任務類型：現時只有 stock_year_breakdown；將來新增類型在此擴充
  task_type TEXT NOT NULL DEFAULT 'stock_year_breakdown',
  -- 以下為預留欄位：空白時前端自動隱藏
  instructions TEXT NOT NULL DEFAULT '',
  due_date DATE,
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,

  source_filename TEXT NOT NULL DEFAULT '',
  row_count INTEGER NOT NULL DEFAULT 0,
  store_count INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  warn_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 封存後店舖只可查閱、不可再提交（NULL = 開放中）
  closed_at TIMESTAMPTZ,
  closed_by TEXT NOT NULL DEFAULT '',
  close_reason TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_designated_sku_batches_created_at
  ON designated_sku_batches (created_at DESC);

-- ---------------------------------------------------------------------------
-- 任務（每店每 SKU 一行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS designated_sku_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES designated_sku_batches(id) ON DELETE CASCADE,
  -- 任務編號，例：DSKU-261026-0001-03；直 link / 查閱用
  task_code TEXT NOT NULL UNIQUE,
  site_code TEXT NOT NULL CHECK (site_code <> ''),
  sku TEXT NOT NULL,
  product_hierarchy TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  -- 原檔 SaSa Net Stock；NULL = 缺值／非數字（不等於 0）
  stock_qty INTEGER,

  -- 原始列（欄名 -> 值），保留以便日後追溯或補欄
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'replied')),
  reply_note TEXT NOT NULL DEFAULT '',
  -- 回覆合計件數 / 年期行數（冗餘快照，方便排序及匯出，真值仍以 reply_lines 為準）
  reply_total INTEGER,
  reply_line_count INTEGER NOT NULL DEFAULT 0,
  replied_at TIMESTAMPTZ,
  replied_by TEXT,
  replied_by_user_id UUID,
  -- 店舖提交次數（每次儲存 +1，供日後審計及限制修改用）
  reply_count INTEGER NOT NULL DEFAULT 0,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, site_code, sku)
);

CREATE INDEX IF NOT EXISTS idx_designated_sku_items_batch
  ON designated_sku_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_designated_sku_items_site
  ON designated_sku_items (site_code, status);
CREATE INDEX IF NOT EXISTS idx_designated_sku_items_status
  ON designated_sku_items (batch_id, status);

-- ---------------------------------------------------------------------------
-- 回覆明細（一個年期一行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS designated_sku_reply_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES designated_sku_items(id) ON DELETE CASCADE,
  -- 貨品年期 MMYY（4 位數字，例 0827 = 2027 年 8 月）
  year_code TEXT NOT NULL CHECK (year_code ~ '^[0-9]{4}$'),
  qty INTEGER NOT NULL CHECK (qty > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一任務同一年的年期只可一行（店舖若要拆開，應合併為一行）
  UNIQUE (item_id, year_code)
);

CREATE INDEX IF NOT EXISTS idx_designated_sku_reply_lines_item
  ON designated_sku_reply_lines (item_id, sort_order);
