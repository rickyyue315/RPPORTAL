-- 018_zero_sales_reasons.sql
-- 統一 90日零銷售預設原因選項 (覆蓋 017 舊預設，停用已不再使用的 code)

INSERT INTO zero_sales_reasons (code, label, sort_order, active, require_note, updated_by) VALUES
  ('no_display', '1.無陳列/陳列位置不佳', 1, true, false, 'migration-018'),
  ('in_warehouse', '2.貨放舖倉未上架', 2, true, false, 'migration-018'),
  ('stolen', '3.被偷', 3, true, false, 'migration-018'),
  ('seasonal', '4.季節性/非當季產品', 4, true, false, 'migration-018'),
  ('price_promo', '5.價格/推廣問題', 5, true, false, 'migration-018'),
  ('other', '6.其他（須填補充）', 99, true, true, 'migration-018')
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  active = EXCLUDED.active,
  require_note = EXCLUDED.require_note,
  updated_by = EXCLUDED.updated_by,
  updated_at = now();

-- 停用 017 的舊預設 (如曾寫入)：曾缺貨、客流偏低
UPDATE zero_sales_reasons SET active = false, updated_at = now()
 WHERE code IN ('out_of_stock', 'slow_movement');
