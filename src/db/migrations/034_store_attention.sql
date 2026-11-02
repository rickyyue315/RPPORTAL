-- 門店主檔新增「需特別關注」標記（stores-template.csv 2026-11-02 版第 9 欄）。
-- 空白 = 未標記；保留原始文字（而非 boolean），日後若要分級或加其他標記毋須再改 schema。
ALTER TABLE stores ADD COLUMN IF NOT EXISTS attention TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN stores.attention IS '需特別關注標記，空白代表未標記；來源為門店主檔 CSV 第 9 欄';
