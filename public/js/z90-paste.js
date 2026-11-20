/* 90日0銷售（統計）：Excel 貼上解析（純函數，瀏覽器與測試共用）
 *
 * 欄序固定（與「90日0銷售（統計）」簡報一致）：
 *   1 P90D 0 Sales SKU 總數
 *   2 Shop Stock Qty (CM) 總數
 *   3 MAKE UP SKU 數
 *   4 MAKE UP Shop Stock Qty (CM) 總數
 *   5 Non-MAKE UP SKU 數
 *   6 Non-MAKE UP Shop Stock Qty (CM) 總數
 *
 * 容許：
 *   * Tab 分隔或連續空格分隔
 *   * 連表頭一齊貼（非數字行自動跳過）
 *   * 8 欄（前面多「日期 + 店數」）
 *   * 千分位逗號、存貨量小數
 *
 * 核對：SKU 總數必須等於 MAKE UP + Non-MAKE UP（整數完全相等）；
 *       存貨量容許 1 件捨入差。對唔上會回 error，前台唔會填入，
 *       避免把矛盾數字寫入資料庫（DB 只存兩個分項，總數由服務層相加）。
 */
(() => {
  'use strict';

  const NUMBER_RE = /^\d[\d,]*(\.\d+)?$/;

  /** 貼上的數字格：可含千分位；負數／文字／空字串 → null */
  function parseNumber(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!NUMBER_RE.test(raw)) return null;
    const n = Number(raw.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function fmtInt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
  }

  /** 存貨量：整數不顯示小數，否則最多 3 位 */
  function fmtQty(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const rounded = Math.round(n * 1000) / 1000;
    const digits = Number.isInteger(rounded) ? 0 : (Math.round(rounded * 100) / 100 === rounded ? 2 : 3);
    return rounded.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  /**
   * 解析貼上文字。
   * 成功：{ reportDate?, shopCount?, stats: { makeupSku, makeupQty, nonSku, nonQty }, totals: { sku, qty } }
   * 失敗：{ error: '可以直接顯示的中文訊息' }
   */
  function parse(text) {
    const lines = String(text == null ? '' : text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return { error: '未偵測到貼上內容。' };

    const found = [];
    for (const line of lines) {
      let parts = line.split('\t').map((part) => part.trim()).filter(Boolean);
      // 由網頁／PDF 複製可能是多個空格分隔；數字本身無空格，所以這樣切仍然安全
      if (parts.length < 6) parts = line.split(/\s+/).map((part) => part.trim()).filter(Boolean);

      if (parts.length === 6) {
        const nums = parts.map(parseNumber);
        if (nums.every((n) => n !== null)) found.push({ values: nums });
        continue;
      }
      if (parts.length === 8) {
        const nums = parts.slice(1).map(parseNumber);
        if (/^\d{4}-\d{2}-\d{2}$/.test(parts[0]) && nums.every((n) => n !== null)) {
          found.push({ reportDate: parts[0], shopCount: nums[0], values: nums.slice(1) });
        }
      }
    }

    if (!found.length) {
      return { error: '搵唔到 6 個數字。請在 Excel 一次過選「P90D 0 Sales SKU 總數」至「Non-MAKE UP Shop Stock Qty (CM) 總數」6 格，再貼到上面。' };
    }
    if (found.length > 1) {
      return { error: `偵測到 ${found.length} 行數字；一次只可以貼一期，請只選一行。` };
    }

    const { values, reportDate, shopCount } = found[0];
    const [totalSku, totalQty, makeupSku, makeupQty, nonSku, nonQty] = values;
    if (![totalSku, makeupSku, nonSku].every((n) => Number.isInteger(n))) {
      return { error: 'SKU 數必須是整數，請檢查是否有欄位貼錯（例如把存貨量貼到 SKU 欄）。' };
    }

    const skuSum = makeupSku + nonSku;
    if (Math.abs(totalSku - skuSum) > 0.009) {
      return {
        error: `SKU 總數對唔上：總數 ${fmtInt(totalSku)} ≠ MAKE UP ${fmtInt(makeupSku)} + Non-MAKE UP ${fmtInt(nonSku)}（${fmtInt(skuSum)}）。請確認欄序或數字。`,
      };
    }
    const qtySum = makeupQty + nonQty;
    if (Math.abs(totalQty - qtySum) > 1) {
      return {
        error: `存貨量總數對唔上：總數 ${fmtQty(totalQty)} ≠ MAKE UP ${fmtQty(makeupQty)} + Non-MAKE UP ${fmtQty(nonQty)}（${fmtQty(qtySum)}，相差 ${fmtQty(Math.abs(totalQty - qtySum))}）。`,
      };
    }

    return {
      reportDate,
      shopCount,
      stats: { makeupSku, makeupQty, nonSku, nonQty },
      totals: { sku: skuSum, qty: qtySum },
    };
  }

  const Z90Paste = { parse, parseNumber };
  if (typeof globalThis !== 'undefined') globalThis.Z90Paste = Z90Paste;
})();
