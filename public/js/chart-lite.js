/*!
 * chart-lite.js — 自製 SVG 折線圖（零依賴、零 CDN、零 npm 套件）
 *
 * 用途：存貨 Dashboard 的趨勢線（1–2 條線、最多 60 點）。
 *
 * 設計原則：
 *  1. x 軸用「真實日期線性映射」：月結點與週點之間的距離按實際日數，不會等距排列騙人。
 *  2. 缺值一定斷線（value 為 null / NaN / 缺失），絕不當成 0 畫落去。
 *  3. 可選虛線對比線（dashed），用於「全公司合計（加權）」之類的參考線。
 *  4. tooltip / 點按（pointer 事件），觸控目標由 CSS 保證 ≥20px。
 *
 * 對外 API：
 *   globalThis.ChartLite = { renderLine, renderBarGrid, redraw, clear, barLabelIndices, weeklyLabelVisibility, dateTicks, niceMax, niceRange, scaleX, toTime, buildPath, splitIndex, fmtDay }
 *
 * renderLine(el, opts) 的 opts：
 *   series: [{ key, label, color, dashed, splitDate, colorBefore, points: [{ date:'YYYY-MM-DD', value:Number|null, showLabel?:Boolean }] }]  // 最多 3 條
 *            splitDate 之前的點改用 colorBefore 畫（同一條線分兩段，用於「去年」等舊資料）
 *            showLabel: false 只隱藏該點的數值標籤，圓點與 tooltip 照舊
 *            axis: 'right' 用右邊獨立 Y 軸（雙軸對照；預設左軸）
 *            format: (v) => String 該條線自己的數值格式（雙軸時左右單位不同）
 *            labelSpacing: Number  該條線的標籤預留闊度（覆蓋外層設定）
 *   y2Min / y2Max: Number     右軸自訂範圍（條件同 yMin / yMax）
 *   y2Format: (v) => String   右軸刻度文字
 *   yColor / y2Color: String  左右刻度文字顏色（雙軸時染成對應線色，一眼分得出）
 *   topLabels: { label, color, fontSize, spacing, format, points: [{ date, value }] }
 *                             圖頂附加一行文字（例如「該期店舖數」），不畫線、不參與 Y 軸；
 *                             太密時自動抽樣（永遠保留首尾），並會加入 tooltip。
 *   height: Number           容器的 clientHeight 為 0 時使用的像素高（預設 220）
 *   yFormat: (v) => String    y 軸刻度文字
 *   tipFormat: (v) => String  tooltip 數值文字（預設同 yFormat）
 *   yMin / yMax: Number       自訂 y 軸範圍（兩者要一齊給、且包住所有點才會生效）。
 *                             用於「放大波動」：比例類數據只在 8%–11% 徘徊時，由 0 起畫會變直線。
 *                             非 0 起點會在圖內加註「Y 軸由 x 起」，不要靠讀者自己發現。
 *   valueLabels: Boolean      是否在資料點直接標示數值（預設 false）
 *   labelSeries: [Number]     只標示指定 series 的數值（預設全部；三線圖可設 [0,1] 只標首兩條）
 *   labelSpacing: Number      每個數值標籤預留的橫向像素（預設 44；字短可調細，令每點都標到）
 *   emptyText: String        完全沒有有效點時顯示的文字
 *   ariaLabel: String        SVG 的無障礙描述（預設自動生成）
 *   maxPoints: Number        超過此點數不畫圓點（預設 24）
 *
 * 純函數（dateTicks / niceMax / scaleX / toTime / buildPath / fmtDay）不碰 DOM，
 * 可以 import 後直接做單元測試（見 test/chartLite.test.ts）。
 */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DAY = 86400000;
  const observers = typeof WeakMap === 'function' ? new WeakMap() : null;

  /* ==================== 純函數（不碰 DOM） ==================== */

  /** 'YYYY-MM-DD' / Date / timestamp → UTC 毫秒（日期粒度）；無法解析回 NaN。 */
  function toTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) {
      const t = value.getTime();
      if (!Number.isFinite(t)) return NaN;
      return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value == null ? '' : value));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  /** 毫秒 → 'MM-DD'（withYear=true 則 'YYYY-MM-DD'）。用 UTC，避免時區位移一日。 */
  function fmtDay(t, withYear) {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return '';
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return withYear ? `${d.getUTCFullYear()}-${mm}-${dd}` : `${mm}-${dd}`;
  }

  function round(v, digits) {
    const f = Math.pow(10, digits == null ? 2 : digits);
    return Math.round(v * f) / f;
  }

  /**
   * 日期 → 像素。domain 退化（maxT <= minT）時回 x0，不會產生 NaN / Infinity。
   */
  function scaleX(t, minT, maxT, x0, x1) {
    if (!Number.isFinite(t)) return x0;
    if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT <= minT) return x0;
    return x0 + ((t - minT) / (maxT - minT)) * (x1 - x0);
  }

  /**
   * 把最大值向上取成「好睇」的刻度上限（1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 / 10 × 10^n 的倍數）。
   * 呼叫端固定用 4 段網格，所以候選步距要夠密，否則 top 會遠高於實際最大值（線會壓在底部）。
   * niceMax(8.81, 4) === 10、niceMax(100, 4) === 100、niceMax(0) === 1。
   */
  function niceMax(value, tickCount) {
    const ticks = Math.min(8, Math.max(1, Math.floor(Number(tickCount) || 4)));
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return 1;
    return round(niceStep(v / ticks) * ticks, 6);
  }

  /** 把 raw 向上取成「好睇」的步距（1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 / 10 × 10^n）。 */
  function niceStep(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(value)));
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i] * mag >= value - 1e-9) return steps[i] * mag;
    }
    return steps[steps.length - 1] * mag;
  }

  /**
   * 把 [minV, maxV] 擴成「好睇」的刻度範圍，下限可以不是 0。
   * 用於「放大波動」：數據只在 8%–11% 之間徘徊時，由 0 起畫會變成一條直線。
   * 回傳 { min, max }：min <= minV、max >= maxV，且 (max - min) 可被 ticks 整除。
   * niceRange(8.3, 11.9, 4) → { min: 8, max: 12 }。
   */
  function niceRange(minV, maxV, tickCount) {
    const ticks = Math.min(8, Math.max(1, Math.floor(Number(tickCount) || 4)));
    const lo = Number(minV);
    const hi = Number(maxV);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1 };
    if (hi <= lo) return { min: lo, max: lo + 1 };
    // 下限要先對齊到步距，對齊後可能蓋不住上限（例如 8.3 對齊到 7.8 之後只到 10.2），
    // 這時換大一級步距再試，寧願範圍闊少少，都不要出現 7.8 / 8.55 / 9.3 這種怪刻度。
    let step = niceStep((hi - lo) / ticks);
    for (let guard = 0; guard < 12; guard += 1) {
      const first = round(Math.floor(lo / step + 1e-9) * step, 10);
      const last = round(first + step * ticks, 10);
      if (last >= hi - 1e-9) return { min: first, max: last };
      step = niceStep(step * 1.01);
    }
    return { min: lo, max: hi };
  }

  /**
   * x 軸刻度：在 [minT, maxT] 上等距取 n 個真實日期（因為 x 是線性時間軸，等距 = 等時間距離）。
   * 回傳 [{ t, label }]；domain 退化時回傳單一 tick。
   */
  function dateTicks(minT, maxT, count) {
    const n = Math.min(8, Math.max(2, Math.floor(Number(count) || 4)));
    const a = Number(minT);
    const b = Number(maxT);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
    if (b <= a) return [{ t: a, label: fmtDay(a) }];
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const raw = a + ((b - a) * i) / (n - 1);
      const t = Math.round(raw / DAY) * DAY; // 貼齊日界，避免 12:03 這種怪異刻度
      out.push({ t, label: fmtDay(t) });
    }
    return out;
  }

  /**
   * 折線路徑。points: [{ x, y }]；y 非有限值（null / NaN）代表缺值 → 斷線（重新 M）。
   * 回傳 SVG path 的 d 屬性字串；全部缺值時回傳 ''。
   */
  function buildPath(points) {
    const list = Array.isArray(points) ? points : [];
    let d = '';
    let pen = false;
    for (let i = 0; i < list.length; i += 1) {
      const p = list[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${round(p.x, 2)} ${round(p.y, 2)} `;
      pen = true;
    }
    return d.trim();
  }

  /* ==================== 內部工具 ==================== */

  /**
   * 找「第一個不早於 splitT 的點」的索引，用於把同一條線分成兩段（例如 12 個月前用淺色）。
   * points: [{ t }]（可含缺值，只要 t 有效就會計）。回傳 -1 代表全部都在 splitT 之前。
   * 純函數，不碰 DOM。
   */
  function splitIndex(points, splitT) {
    const t = Number(splitT);
    if (!Number.isFinite(t)) return -1;
    const list = Array.isArray(points) ? points : [];
    for (let i = 0; i < list.length; i += 1) {
      const p = list[i];
      if (p && Number.isFinite(p.t) && p.t >= t) return i;
    }
    return -1;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach((k) => {
      if (attrs[k] != null) node.setAttribute(k, String(attrs[k]));
    });
    return node;
  }

  function normalizeSeries(spec, index) {
    const palette = ['#0f5c9c', '#94a3b8'];
    const raw = Array.isArray(spec.points) ? spec.points : [];
    const points = raw.map((p) => {
      if (!p) return null;
      const dateValue = p.date != null ? p.date : (p.report_date != null ? p.report_date : p.x);
      const value = p.value != null ? p.value : (p.ratio != null ? p.ratio : p.y);
      const t = toTime(dateValue);
      const v = value == null || value === '' ? NaN : Number(value);
      return {
        t,
        v: Number.isFinite(v) ? v : null,
        // 逐點開關：false = 唔畫數值標籤，但圓點、tooltip 照舊
        showLabel: p.showLabel !== false,
      };
    }).filter((p) => p && Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t);
    return {
      key: spec.key || `s${index}`,
      label: spec.label || '',
      color: spec.color || palette[index % palette.length],
      dashed: !!spec.dashed,
      /** 分界日期（含）之前的點改用 colorBefore 畫，用於「去年」等舊資料 */
      splitT: toTime(spec.splitDate),
      colorBefore: spec.colorBefore || '#94a3b8',
      /** 'right' = 用右邊獨立 Y 軸（雙軸對照）；預設左軸 */
      axis: spec.axis === 'right' ? 'right' : 'left',
      /** 每條線自己的數值格式（雙軸時兩邊單位不同，總不能共用一個） */
      format: typeof spec.format === 'function' ? spec.format : null,
      /** 每條線自己的數值標籤預留闊度（長數字要闊一點） */
      labelSpacing: Number(spec.labelSpacing) || 0,
      points,
    };
  }

  function defaultAria(specs, finite) {
    const parts = specs.filter((s) => s.points.some((p) => p.v !== null)).map((s) => {
      const pts = s.points.filter((p) => p.v !== null);
      const last = pts[pts.length - 1];
      return `${s.label || s.key}：共 ${pts.length} 期，最新 ${fmtDay(last.t, true)} 為 ${round(last.v, 2)}`;
    });
    return `折線圖（${finite.length} 個資料點）。${parts.join('；')}`;
  }

  /* ==================== 尺寸監聽 ==================== */

  function stopObserving(el) {
    if (!observers) return;
    const ro = observers.get(el);
    if (ro) {
      try { ro.disconnect(); } catch { /* 忽略 */ }
      observers.delete(el);
    }
  }

  function startObserving(el, w, h, rerender) {
    if (typeof ResizeObserver === 'undefined' || !observers) return;
    stopObserving(el);
    let lastW = w;
    let lastH = h;
    const ro = new ResizeObserver(() => {
      const nextW = Math.round(el.clientWidth);
      const nextH = Math.round(el.clientHeight);
      if (!nextW) return; // 面板隱藏中（display:none）→ 等它顯示再說
      if (Math.abs(nextW - lastW) < 8 && Math.abs(nextH - lastH) < 8) return;
      lastW = nextW;
      lastH = nextH;
      if (el.__ctOpts) (rerender || renderLine)(el, el.__ctOpts);
    });
    observers.set(el, ro);
    ro.observe(el);
  }

  /**
   * 柱狀圖要顯示哪幾根柱的標籤：永遠包含第一根與最新一根，中間按需要隔開。
   * 純函數，方便測試；count 為 0 時回空陣列。
   */
  function barLabelIndices(count, maxLabels) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return [];
    let max = Math.max(2, Math.floor(Number(maxLabels) || 6));
    if (n <= max) return Array.from({ length: n }, (_, i) => i);
    // 由標籤上限逐步收窄，確保除首尾外，每個標籤至少隔一個資料點。
    // 舊版用固定 step 再補最後一點，會出現「尾二」與「最新」貼在一起（百分比疊字）。
    while (max > 2) {
      const step = (n - 1) / (max - 1);
      const out = [];
      for (let i = 0; i < max; i += 1) out.push(Math.round(i * step));
      const unique = [...new Set(out)];
      const minGap = unique.slice(1).reduce(
        (gap, value, i) => Math.min(gap, value - unique[i]),
        Infinity,
      );
      if (unique[unique.length - 1] === n - 1 && minGap >= 2) return unique;
      max -= 1;
    }
    return [0, n - 1];
  }

  /**
   * 月結／週更數值標籤規則（pure function）：
   *   同一月份有月結時，該月「月結之前」嘅週更點唔標數值；
   *   月結之後（未有新月結）嘅週更照標；月結本身永遠照標。
   * 回傳 predicate(row)，row 需有 report_date / report_kind。
   */
  function weeklyLabelVisibility(rows) {
    const monthEndByMonth = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || row.report_kind !== 'month_end') continue;
      const date = String(row.report_date || '').slice(0, 10);
      if (!date) continue;
      const month = date.slice(0, 7);
      const current = monthEndByMonth.get(month);
      if (!current || date > current) monthEndByMonth.set(month, date);
    }
    return (row) => {
      if (!row || row.report_kind !== 'weekly') return true;
      const date = String(row.report_date || '').slice(0, 10);
      const monthEnd = monthEndByMonth.get(date.slice(0, 7));
      return !monthEnd || date > monthEnd;
    };
  }

  /* ==================== 主渲染 ==================== */

  function renderLine(el, opts) {
    if (!el || typeof document === 'undefined') return null;
    const o = opts || {};
    el.__ctOpts = o;
    el.__ctRenderer = renderLine;
    stopObserving(el);
    el.innerHTML = '';

    const specs = (Array.isArray(o.series) ? o.series : []).filter(Boolean).slice(0, 3)
      .map((spec, i) => normalizeSeries(spec, i));
    const finite = [];
    specs.forEach((s) => s.points.forEach((p) => { if (p.v !== null) finite.push(p); }));

    if (!finite.length) {
      const empty = document.createElement('div');
      empty.className = 'ct-empty';
      empty.textContent = o.emptyText || '暫無數據';
      el.appendChild(empty);
      return null;
    }

    const box = el;
    const computed = typeof getComputedStyle === 'function' ? getComputedStyle(box) : null;
    if (computed && computed.position === 'static') box.style.position = 'relative';

    const W = Math.max(280, Math.round(box.clientWidth || o.width || 640));
    const measureH = box.clientHeight && box.clientHeight > 60 ? box.clientHeight : 0;
    const H = Math.max(120, Math.round(measureH || o.height || 220));

    /* --- 圖頂附加數字（例如「該期店舖數」）：唔屬於任何一條線，純參考 --- */
    const topSpec = o.topLabels && typeof o.topLabels === 'object' ? o.topLabels : null;
    const topPoints = topSpec && Array.isArray(topSpec.points)
      ? topSpec.points.map((p) => {
        if (!p) return null;
        const t = toTime(p.date != null ? p.date : p.x);
        const raw = p.value != null ? p.value : p.y;
        const v = raw == null || raw === '' ? NaN : Number(raw);
        return Number.isFinite(t) && Number.isFinite(v) ? { t, v, show: p.show !== false } : null;
      }).filter(Boolean).sort((a, b) => a.t - b.t)
      : [];
    const hasTop = topPoints.length > 0;
    const topFmt = topSpec && typeof topSpec.format === 'function' ? topSpec.format : (v) => String(v);

    // 雙軸：有 series 指定 axis:'right' 才啟用，右邊要預留位置放刻度文字
    const rightSpecs = specs.filter((s) => s.axis === 'right' && s.points.some((p) => p.v !== null));
    const hasRight = rightSpecs.length > 0;

    const padL = 46;
    const padR = hasRight ? 54 : 12;
    // 顯示數值標籤時頂部要留位（最高點的標籤在點上方），否則會被裁掉；
    // 圖頂再加一行附加數字時，還要多留 16px
    const padT = (o.valueLabels ? 28 : 12) + (hasTop ? 16 : 0);
    const padB = 24;
    const innerW = Math.max(40, W - padL - padR);
    const innerH = Math.max(40, H - padT - padB);

    const times = [];
    specs.forEach((s) => s.points.forEach((p) => times.push(p.t)));
    let minT = Math.min.apply(null, times);
    let maxT = Math.max.apply(null, times);
    if (!Number.isFinite(minT) || !Number.isFinite(maxT)) return null;
    if (maxT <= minT) maxT = minT + DAY; // 只有一個日期時避免除以 0（呼叫端不應走到這裡）

    // 左軸只計左軸的點（雙軸時右軸那條有自己的範圍，不能拉高左軸）
    const leftPts = specs.filter((s) => s.axis !== 'right')
      .flatMap((s) => s.points).filter((p) => p.v !== null);
    const axisL = leftPts.length ? leftPts : finite;
    const maxV = axisL.reduce((acc, p) => (p.v > acc ? p.v : acc), axisL[0].v);
    const minV = axisL.reduce((acc, p) => (p.v < acc ? p.v : acc), axisL[0].v);
    // 「放大波動」：呼叫端可用 yMin / yMax 指定非 0 起點的範圍（比例類數據由 0 起畫會變直線）。
    // 範圍必須包住所有點（含虛線對照線），否則最低／最高點會畫出框外，所以在這裡再驗一次。
    const reqMin = Number(o.yMin);
    const reqMax = Number(o.yMax);
    const customRange = Number.isFinite(reqMin) && Number.isFinite(reqMax)
      && reqMin >= 0 && reqMax > reqMin && reqMin < minV && reqMax > maxV;
    const yMin = customRange ? reqMin : 0;
    const yMax = customRange ? reqMax : niceMax(maxV * 1.05, 4);
    const spanV = yMax - yMin;
    const yScale = (v) => padT + (1 - ((v - yMin) / spanV)) * innerH;

    /* --- 右軸（雙軸對照）：獨立範圍，同樣支援 y2Min / y2Max 放大波動 --- */
    let y2Min = 0;
    let y2Max = 0;
    let span2 = 0;
    let y2Scale = null;
    if (hasRight) {
      const rPts = rightSpecs.flatMap((s) => s.points).filter((p) => p.v !== null);
      const maxR = rPts.reduce((acc, p) => (p.v > acc ? p.v : acc), rPts[0].v);
      const minR = rPts.reduce((acc, p) => (p.v < acc ? p.v : acc), rPts[0].v);
      const req2Min = Number(o.y2Min);
      const req2Max = Number(o.y2Max);
      const custom2 = Number.isFinite(req2Min) && Number.isFinite(req2Max)
        && req2Min >= 0 && req2Max > req2Min && req2Min < minR && req2Max > maxR;
      y2Min = custom2 ? req2Min : 0;
      y2Max = custom2 ? req2Max : niceMax(maxR * 1.05, 4);
      span2 = y2Max - y2Min;
      y2Scale = (v) => padT + (1 - ((v - y2Min) / span2)) * innerH;
    }
    const scaleOf = (s) => (s.axis === 'right' && y2Scale ? y2Scale : yScale);

    const xScale = (t) => scaleX(t, minT, maxT, padL, padL + innerW);

    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      role: 'img',
      'aria-label': o.ariaLabel || defaultAria(specs, finite),
      class: 'ct-svg',
    });
    svg.style.display = 'block';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';

    const yFmt = typeof o.yFormat === 'function' ? o.yFormat : (v) => String(round(v, 2));
    const y2Fmt = typeof o.y2Format === 'function' ? o.y2Format : yFmt;
    // 雙軸時把刻度文字染成對應線色，睇顏色就知邊個軸屬邊條線
    const tickColorL = o.yColor || '#66727f';
    const tickColorR = o.y2Color || '#66727f';

    /* --- y 軸網格 + 左右刻度 --- */
    for (let i = 0; i <= 4; i += 1) {
      const v = round(yMin + (spanV * i) / 4, 10);
      const y = round(yScale(v), 2);
      svg.appendChild(svgEl('line', {
        x1: padL, x2: padL + innerW, y1: y, y2: y,
        stroke: i === 0 ? '#c9d8e6' : '#e8eef5',
        'stroke-width': 1,
      }));
      const label = svgEl('text', {
        x: padL - 8, y: y + 4, 'text-anchor': 'end',
        fill: tickColorL, 'font-size': 11, 'font-family': 'inherit',
      });
      label.textContent = yFmt(v);
      svg.appendChild(label);
      if (!hasRight) continue;
      const v2 = round(y2Min + (span2 * i) / 4, 10);
      const label2 = svgEl('text', {
        x: padL + innerW + 8, y: y + 4, 'text-anchor': 'start',
        fill: tickColorR, 'font-size': 11, 'font-family': 'inherit',
      });
      label2.textContent = y2Fmt(v2);
      svg.appendChild(label2);
    }

    // 非 0 起點要在圖上寫明，否則單看刻度容易被誤讀成「跌到 0」
    if (yMin > 0 || (hasRight && y2Min > 0)) {
      let noteText;
      if (yMin > 0 && hasRight && y2Min > 0) {
        noteText = `兩軸皆非 0 起（左 ${yFmt(yMin)}／右 ${y2Fmt(y2Min)}）`;
      } else if (hasRight && y2Min > 0) {
        noteText = `右軸由 ${y2Fmt(y2Min)} 起（放大波動）`;
      } else {
        noteText = `Y 軸由 ${yFmt(yMin)} 起（放大波動）`;
      }
      const note = svgEl('text', {
        x: padL + 4, y: round(padT + innerH - 8, 2), 'text-anchor': 'start',
        fill: '#8a97a4', 'font-size': 9.5, 'font-family': 'inherit',
      });
      note.textContent = noteText;
      svg.appendChild(note);
    }

    /* --- x 軸刻度（真實日期） --- */
    const tickCount = W < 420 ? 3 : (W < 720 ? 4 : 6);
    dateTicks(minT, maxT, tickCount).forEach((tick) => {
      const x = round(xScale(tick.t), 2);
      const label = svgEl('text', {
        x, y: H - 6, 'text-anchor': 'middle',
        fill: '#66727f', 'font-size': 11, 'font-family': 'inherit',
      });
      label.textContent = tick.label;
      svg.appendChild(label);
    });

    /* --- 圖頂附加數字：每期一個，例如「店舖數」。太密時用 barLabelIndices 抽樣 --- */
    if (hasTop) {
      const perTop = Number(topSpec.spacing) || 30;
      const maxTop = Math.max(2, Math.floor(innerW / perTop));
      // 只喺「准許標示」嘅點之間抽樣（呼叫端可用 show:false 留白，tooltip 照樣有值）
      const showIdx = [];
      topPoints.forEach((p, i) => { if (p.show !== false) showIdx.push(i); });
      const keepTop = new Set(barLabelIndices(showIdx.length, maxTop).map((pos) => showIdx[pos]));
      const drawn = [...keepTop].sort((a, b) => a - b);
      const firstDrawn = drawn[0];
      const lastDrawn = drawn[drawn.length - 1];
      topPoints.forEach((p, i) => {
        if (!keepTop.has(i)) return;
        // 首尾貼邊的改用 start／end 對齊，免得文字半截跑出繪圖區
        const anchor = i === firstDrawn ? 'start' : (i === lastDrawn ? 'end' : 'middle');
        const offsetX = i === firstDrawn ? -2 : (i === lastDrawn ? 2 : 0);
        const label = svgEl('text', {
          x: round(xScale(p.t) + offsetX, 2),
          y: 13,
          'text-anchor': anchor,
          fill: topSpec.color || '#1f2937',
          'font-size': Number(topSpec.fontSize) || 10,
          'font-weight': 600,
          'font-family': 'inherit',
        });
        label.textContent = topFmt(p.v);
        svg.appendChild(label);
      });
    }

    /* --- 折線 + 圓點 --- */
    const dots = [];
    specs.forEach((s) => {
      const plotted = s.points.map((p) => ({
        x: xScale(p.t),
        y: p.v === null ? NaN : scaleOf(s)(p.v),
        t: p.t,
        v: p.v,
        showLabel: p.showLabel,
      }));
      const hasSplit = Number.isFinite(s.splitT);
      const k = hasSplit ? splitIndex(plotted, s.splitT) : -1;
      const drawPath = (pts, color) => {
        const d = buildPath(pts);
        if (!d) return;
        svg.appendChild(svgEl('path', {
          d,
          fill: 'none',
          stroke: color,
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
          'stroke-dasharray': s.dashed ? '6 4' : null,
        }));
      };
      if (hasSplit && k > 0) {
        // 分界點同時屬於兩段，線才不會在中間斷開
        drawPath(plotted.slice(0, k + 1), s.colorBefore);
        drawPath(plotted.slice(k), s.color);
      } else {
        drawPath(plotted, hasSplit && k === -1 ? s.colorBefore : s.color);
      }
      const colorOf = (p) => (hasSplit && p.t < s.splitT ? s.colorBefore : s.color);
      if (plotted.length <= (o.maxPoints || 24)) {
        plotted.forEach((p) => {
          if (!Number.isFinite(p.y)) return;
          const c = svgEl('circle', { cx: round(p.x, 2), cy: round(p.y, 2), r: 2.6, fill: '#fff', stroke: colorOf(p), 'stroke-width': 1.6 });
          svg.appendChild(c);
        });
      }
      // 最後一個有效點永遠標出來（最新值）
      const last = plotted.filter((p) => Number.isFinite(p.y)).pop();
      if (last) {
        svg.appendChild(svgEl('circle', {
          cx: round(last.x, 2), cy: round(last.y, 2), r: 4, fill: s.color, stroke: '#fff', 'stroke-width': 1.5,
        }));
      }
      dots.push({ series: s, plotted });
    });

    /* --- 數值標籤（opt-in）：第 1 條線標在點上方、第 2 條標在下方；
       期數太密時用 barLabelIndices 抽樣（永遠保留最新一期），避免疊字。 --- */
    if (o.valueLabels) {
      const globalLabel = typeof o.labelFormat === 'function' ? o.labelFormat : yFmt;
      const globalPer = Number(o.labelSpacing) || 44;
      dots.forEach((entry, seriesIndex) => {
        // 三線圖可只標首兩條，第三條（所選店舖）留 tooltip
        if (Array.isArray(o.labelSeries) && !o.labelSeries.includes(seriesIndex)) return;
        const plotted = entry.plotted;
        if (!plotted.length) return;
        // 雙軸時兩邊單位不同，各系列可以有自己的格式與標籤闊度
        const labelOf = entry.series.format || globalLabel;
        const maxLabels = Math.max(2, Math.floor(innerW / (entry.series.labelSpacing || globalPer)));
        const above = seriesIndex === 0;
        // 只喺「有數值兼且准許標示」嘅點入面抽樣，避免 hidden 點白佔標籤位
        const candidates = [];
        plotted.forEach((p, i) => {
          if (Number.isFinite(p.y) && p.showLabel !== false) candidates.push(i);
        });
        if (!candidates.length) return;
        const keep = new Set(barLabelIndices(candidates.length, maxLabels).map((pos) => candidates[pos]));
        const firstVisible = candidates[0];
        const lastVisible = candidates[candidates.length - 1];
        plotted.forEach((p, i) => {
          if (!keep.has(i) || !Number.isFinite(p.y)) return;
          // 首尾「有標籤」嘅點改用 start／end 對齊，免得文字半截跑出繪圖區
          const anchor = i === firstVisible ? 'start' : (i === lastVisible ? 'end' : 'middle');
          const offsetX = i === firstVisible ? -2 : (i === lastVisible ? 2 : 0);
          const label = svgEl('text', {
            x: round(p.x + offsetX, 2),
            y: round(p.y + (above ? -7 : 14), 2),
            'text-anchor': anchor,
            fill: entry.series.color,
            'font-size': 9.5,
            'font-weight': 600,
            'font-family': 'inherit',
            'paint-order': 'stroke',
            stroke: '#fff',
            'stroke-width': 2.5,
            'stroke-linejoin': 'round',
          });
          label.textContent = labelOf(p.v);
          svg.appendChild(label);
        });
      });
    }

    /* --- tooltip 層 --- */
    const guide = svgEl('line', {
      x1: 0, x2: 0, y1: padT, y2: padT + innerH,
      stroke: '#94a3b8', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0,
    });
    svg.appendChild(guide);
    const focus = svgEl('g', { opacity: 0 });
    dots.forEach((entry) => {
      const c = svgEl('circle', { cx: 0, cy: 0, r: 4.5, fill: '#fff', stroke: entry.series.color, 'stroke-width': 2 });
      focus.appendChild(c);
    });
    svg.appendChild(focus);

    // 收集所有出現過的日期（union），點按時吸附到最近的真實日期
    const dateList = [...new Set(times)].sort((a, b) => a - b);

    const tip = document.createElement('div');
    tip.className = 'ct-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;

    const hit = svgEl('rect', {
      x: padL, y: padT, width: innerW, height: innerH,
      fill: 'transparent', style: 'touch-action: pan-y',
    });

    const place = (clientX) => {
      if (!dateList.length) return;
      const rect = svg.getBoundingClientRect();
      const scale = rect.width ? (W / rect.width) : 1;
      const px = (clientX - rect.left) * scale;
      let best = dateList[0];
      let bestD = Infinity;
      dateList.forEach((t) => {
        const d = Math.abs(xScale(t) - px);
        if (d < bestD) { bestD = d; best = t; }
      });
      const x = xScale(best);
      guide.setAttribute('x1', round(x, 2));
      guide.setAttribute('x2', round(x, 2));
      guide.setAttribute('opacity', 0.9);
      focus.setAttribute('opacity', 1);
      const circles = focus.childNodes;
      let idx = 0;
      let anyValue = false;
      const rows = [];
      dots.forEach((entry) => {
        const p = entry.plotted.find((q) => q.t === best);
        const c = circles[idx];
        idx += 1;
        if (p && Number.isFinite(p.y)) {
          c.setAttribute('cx', round(p.x, 2));
          c.setAttribute('cy', round(p.y, 2));
          c.setAttribute('opacity', 1);
          anyValue = true;
          const tipFmt = entry.series.format || (typeof o.tipFormat === 'function' ? o.tipFormat : yFmt);
          rows.push({ label: entry.series.label, color: entry.series.color, text: tipFmt(p.v) });
        } else {
          c.setAttribute('opacity', 0);
          rows.push({ label: entry.series.label, color: entry.series.color, text: '無數據' });
        }
      });
      // 圖頂那行附加數字也放進 tooltip，標籤被抽樣隔開時仍查得到
      if (hasTop) {
        const tp = topPoints.find((q) => q.t === best);
        if (tp) rows.push({ label: topSpec.label || '參考', color: topSpec.color || '#1f2937', text: topFmt(tp.v) });
      }
      if (!anyValue) { guide.setAttribute('opacity', 0); focus.setAttribute('opacity', 0); tip.hidden = true; return; }
      tip.innerHTML = `<div class="ct-tip-date">${fmtDay(best, true)}</div>`
        + rows.map((r) => `<div class="ct-tip-row"><span class="ct-tip-dot" style="background:${r.color}"></span>`
          + `<span class="ct-tip-label">${escapeText(r.label)}</span><b>${escapeText(r.text)}</b></div>`).join('');
      tip.hidden = false;
      // tooltip 定位：貼近右邊界時自動翻到左邊，避免超出容器
      const boxRect = box.getBoundingClientRect();
      const localX = (x / W) * boxRect.width;
      const tipW = tip.offsetWidth || 132;
      const fitsRight = localX + 12 + tipW <= boxRect.width - 4;
      // 再夾一次右邊界：tooltip 變寬後仍要留在容器內，唔可以黐出圖表
      const maxLeft = Math.max(4, boxRect.width - tipW - 4);
      const left = Math.min(maxLeft, fitsRight ? localX + 12 : Math.max(4, localX - tipW - 12));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = '8px';
    };

    const hide = () => {
      guide.setAttribute('opacity', 0);
      focus.setAttribute('opacity', 0);
      tip.hidden = true;
    };

    ['pointermove', 'pointerdown'].forEach((evt) => {
      svg.addEventListener(evt, (e) => { place(e.clientX); }, { passive: true });
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointercancel', hide);

    svg.appendChild(hit);
    box.appendChild(svg);
    box.appendChild(tip);

    startObserving(box, W, H, renderLine);

    return { width: W, height: H, yMax, y2Max, minT, maxT, points: finite.length, empty: false };
  }

  /**
   * 分期小圖（small multiples）：每個 spec 一張小圖，每期一根柱，柱上顯示百分比。
   * 適合「Grand Total ＋ 各分組」一起看走勢，資料點多過標籤位時會自動抽樣標籤。
   *
   * opts:
   *   series: [{ key, label, color, points:[{ date, value, tip }], latest, delta, deltaTone }]
   *   height: Number            每張小圖的繪圖區高度（預設 150）
   *   yFormat: (v) => String    y 軸文字
   *   labelFormat: (v) => String 柱上文字（預設同 yFormat）
   *   emptyText: String         完全沒有有效值時的整體空狀態
   *   ariaLabel: String         SVG 無障礙描述前綴
   *   maxBarLabels: Number      每張小圖最多顯示幾個柱標籤（會按闊度自動調整）
   */
  function renderBarGrid(el, opts) {
    if (!el || typeof document === 'undefined') return null;
    const o = opts || {};
    el.__ctOpts = o;
    el.__ctRenderer = renderBarGrid;
    stopObserving(el);
    el.innerHTML = '';

    const specs = (Array.isArray(o.series) ? o.series : []).filter(Boolean).map((spec, index) => {
      const raw = Array.isArray(spec.points) ? spec.points : [];
      const points = raw.map((p) => {
        if (!p) return null;
        const dateValue = p.date != null ? p.date : p.report_date;
        const rawValue = p.value != null ? p.value : (p.ratio != null ? p.ratio : p.y);
        const value = rawValue == null || rawValue === '' ? null : Number(rawValue);
        const date = String(dateValue == null ? '' : dateValue);
        return {
          date,
          value: Number.isFinite(value) ? value : null,
          tip: p.tip == null ? '' : String(p.tip),
        };
      }).filter((p) => p && p.date);
      return {
        key: spec.key || `s${index}`,
        label: spec.label || '',
        color: spec.color || '#0f5c9c',
        points,
        latest: spec.latest || '',
        latestTitle: spec.latestTitle || '',
        delta: spec.delta || '',
        deltaTone: spec.deltaTone || '',
      };
    });

    const anyValue = specs.some((spec) => spec.points.some((p) => p.value !== null));
    if (!anyValue) {
      const empty = document.createElement('div');
      empty.className = 'ct-empty';
      empty.textContent = o.emptyText || '暫無數據';
      el.appendChild(empty);
      return null;
    }

    const grid = document.createElement('div');
    grid.className = 'ct-bar-grid';
    const H = Math.max(110, Math.round(o.height || 150));
    const panels = specs.map((spec) => {
      const panel = document.createElement('section');
      panel.className = 'ct-bar-panel';

      const head = document.createElement('div');
      head.className = 'ct-bar-head';
      const title = document.createElement('span');
      title.className = 'ct-bar-title';
      title.textContent = spec.label;
      title.title = spec.label;
      head.appendChild(title);

      if (spec.latest || spec.delta) {
        const latest = document.createElement('span');
        latest.className = 'ct-bar-latest';
        latest.textContent = spec.latest;
        if (spec.latestTitle) latest.title = spec.latestTitle;
        if (spec.delta) {
          const delta = document.createElement('span');
          delta.className = `ct-bar-delta${spec.deltaTone ? ` ${spec.deltaTone}` : ''}`;
          delta.textContent = spec.delta;
          latest.appendChild(delta);
        }
        head.appendChild(latest);
      }

      const plot = document.createElement('div');
      plot.className = 'ct-bar-plot';
      panel.appendChild(head);
      panel.appendChild(plot);
      grid.appendChild(panel);
      return { spec, plot };
    });
    el.appendChild(grid);

    panels.forEach(({ spec, plot }) => {
      const fallbackW = Math.round((el.clientWidth || 960) / Math.max(1, specs.length));
      drawBarPanel(plot, spec, Math.max(190, Math.round(plot.clientWidth || fallbackW || 240)), H, o);
    });

    startObserving(el, Math.round(el.clientWidth || 0), Math.round(el.clientHeight || 0), renderBarGrid);
    return {
      panels: specs.length,
      points: specs.reduce((acc, spec) => acc + spec.points.filter((p) => p.value !== null).length, 0),
      empty: false,
    };
  }

  function drawBarPanel(plot, spec, W, H, opts) {
    plot.innerHTML = '';
    const finite = spec.points.filter((p) => p.value !== null);
    if (!finite.length) {
      const empty = document.createElement('div');
      empty.className = 'ct-bar-empty';
      empty.textContent = '此分組暫無數據';
      plot.appendChild(empty);
      return;
    }

    const padL = 34;
    const padR = 4;
    const padT = 18;
    const padB = 18;
    const innerW = Math.max(20, W - padL - padR);
    const innerH = Math.max(30, H - padT - padB);
    const maxV = finite.reduce((acc, p) => (p.value > acc ? p.value : acc), finite[0].value);
    const yMax = maxV > 0 ? niceMax(maxV * 1.08, 3) : 0.01;
    const baseY = padT + innerH;
    const yScale = (v) => padT + (1 - (v / yMax)) * innerH;
    const yLabel = (v) => (typeof opts.yFormat === 'function' ? opts.yFormat(v) : String(round(v, 2)));
    const valueLabel = (v) => (typeof opts.labelFormat === 'function' ? opts.labelFormat(v) : yLabel(v));

    const last = finite[finite.length - 1];
    const autoLabel = `${spec.label}：共 ${finite.length} 期有效數據，最新 ${String(last.date).slice(0, 10)} 為 ${valueLabel(last.value)}`;
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      role: 'img',
      'aria-label': opts.ariaLabel ? `${opts.ariaLabel}｜${autoLabel}` : autoLabel,
      class: 'ct-svg',
    });
    svg.style.display = 'block';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';

    // y 軸：只畫 0 與上限兩條線，小圖保持清爽
    [[0, '#c9d8e6', null], [yMax, '#e8eef5', '4 3']].forEach(([value, color, dash]) => {
      const y = round(yScale(value), 2);
      svg.appendChild(svgEl('line', {
        x1: padL, x2: padL + innerW, y1: y, y2: y,
        stroke: color, 'stroke-width': 1, 'stroke-dasharray': dash,
      }));
      const label = svgEl('text', {
        x: padL - 6, y: y + 3.5, 'text-anchor': 'end',
        fill: '#7a8894', 'font-size': 9.5, 'font-family': 'inherit',
      });
      label.textContent = yLabel(value);
      svg.appendChild(label);
    });

    const n = spec.points.length;
    const slot = innerW / Math.max(1, n);
    const barW = Math.max(1.5, Math.min(16, slot * 0.62));
    const maxLabels = Math.max(
      2,
      Math.min(
        8,
        Math.floor(Number(opts.maxBarLabels) || Math.floor(innerW / 46)),
      ),
    );
    const labelSet = new Set(barLabelIndices(n, maxLabels));

    spec.points.forEach((p, i) => {
      const cx = padL + slot * i + slot / 2;
      const labelX = Math.max(padL + 10, Math.min(W - padR - 10, cx));

      if (p.value !== null) {
        const y = yScale(p.value);
        const height = Math.max(p.value > 0 ? 1 : 0.75, baseY - y);
        svg.appendChild(svgEl('rect', {
          x: round(cx - barW / 2, 2),
          y: round(baseY - height, 2),
          width: round(barW, 2),
          height: round(height, 2),
          rx: Math.min(2, barW / 2),
          fill: spec.color,
          opacity: i === n - 1 ? 1 : 0.72,
        }));

        // 透明熱區比柱本身闊，滑鼠容易停留在很窄的週柱上
        const hit = svgEl('rect', {
          x: round(padL + slot * i, 2),
          y: padT,
          width: round(slot, 2),
          height: innerH,
          fill: 'transparent',
        });
        const tip = svgEl('title');
        tip.textContent = `${String(p.date).slice(0, 10)}：${valueLabel(p.value)}${p.tip ? `（${p.tip}）` : ''}`;
        hit.appendChild(tip);
        svg.appendChild(hit);
      }

      if (!labelSet.has(i)) return;
      const dateText = svgEl('text', {
        x: round(labelX, 2), y: H - 4, 'text-anchor': 'middle',
        fill: '#66727f', 'font-size': 9.5, 'font-family': 'inherit',
      });
      dateText.textContent = fmtDay(toTime(p.date), false) || String(p.date).slice(5, 10);
      svg.appendChild(dateText);

      const valueText = svgEl('text', {
        x: round(labelX, 2),
        y: p.value === null ? baseY - 4 : Math.max(10, yScale(p.value) - 4),
        'text-anchor': 'middle',
        fill: p.value === null ? '#a0aab4' : '#1f2d3d',
        'font-size': 9.5,
        'font-weight': 600,
        'font-family': 'inherit',
      });
      valueText.textContent = p.value === null ? '—' : valueLabel(p.value);
      svg.appendChild(valueText);
    });

    plot.appendChild(svg);
  }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 清除容器並停止尺寸監聽。呼叫端要用自己的空狀態文案時先叫這個，
   * 否則殘留的 ResizeObserver 會在下次 resize 時把圖畫回來。
   */
  function clear(el) {
    if (!el) return;
    stopObserving(el);
    el.__ctOpts = null;
    el.__ctRenderer = null;
    el.innerHTML = '';
  }

  /** 用最後一次 render 的 opts 重畫（尺寸改變／由放大模式返回時用）。 */
  function redraw(el) {
    if (!el || !el.__ctOpts) return null;
    return (el.__ctRenderer || renderLine)(el, el.__ctOpts);
  }

  const ChartLite = {
    renderLine,
    renderBarGrid,
    redraw,
    clear,
    barLabelIndices,
    weeklyLabelVisibility,
    dateTicks,
    niceMax,
    niceRange,
    scaleX,
    toTime,
    buildPath,
    splitIndex,
    fmtDay,
  };

  if (typeof globalThis !== 'undefined') globalThis.ChartLite = ChartLite;
})();
