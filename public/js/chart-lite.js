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
 *   globalThis.ChartLite = { renderLine, clear, dateTicks, niceMax, scaleX, toTime, buildPath, splitIndex, fmtDay }
 *
 * renderLine(el, opts) 的 opts：
 *   series: [{ key, label, color, dashed, splitDate, colorBefore, points: [{ date:'YYYY-MM-DD', value:Number|null }] }]  // 最多 2 條
 *            splitDate 之前的點改用 colorBefore 畫（同一條線分兩段，用於「去年」等舊資料）
 *   height: Number           容器的 clientHeight 為 0 時使用的像素高（預設 220）
 *   yFormat: (v) => String    y 軸刻度文字
 *   tipFormat: (v) => String  tooltip 數值文字（預設同 yFormat）
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
    const raw = v / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    let step = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i] * mag >= raw - 1e-9) { step = steps[i]; break; }
    }
    return round(step * mag * ticks, 6);
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
      return { t, v: Number.isFinite(v) ? v : null };
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

  function startObserving(el, w, h) {
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
      if (el.__ctOpts) renderLine(el, el.__ctOpts);
    });
    observers.set(el, ro);
    ro.observe(el);
  }

  /* ==================== 主渲染 ==================== */

  function renderLine(el, opts) {
    if (!el || typeof document === 'undefined') return null;
    const o = opts || {};
    el.__ctOpts = o;
    stopObserving(el);
    el.innerHTML = '';

    const specs = (Array.isArray(o.series) ? o.series : []).filter(Boolean).slice(0, 2)
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

    const padL = 46;
    const padR = 12;
    const padT = 12;
    const padB = 24;
    const innerW = Math.max(40, W - padL - padR);
    const innerH = Math.max(40, H - padT - padB);

    const times = [];
    specs.forEach((s) => s.points.forEach((p) => times.push(p.t)));
    let minT = Math.min.apply(null, times);
    let maxT = Math.max.apply(null, times);
    if (!Number.isFinite(minT) || !Number.isFinite(maxT)) return null;
    if (maxT <= minT) maxT = minT + DAY; // 只有一個日期時避免除以 0（呼叫端不應走到這裡）

    const maxV = finite.reduce((acc, p) => (p.v > acc ? p.v : acc), finite[0].v);
    const yMax = niceMax(maxV * 1.05, 4);
    const yScale = (v) => padT + (1 - (v / yMax)) * innerH;
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

    /* --- y 軸網格 + 刻度 --- */
    for (let i = 0; i <= 4; i += 1) {
      const v = (yMax * i) / 4;
      const y = round(yScale(v), 2);
      svg.appendChild(svgEl('line', {
        x1: padL, x2: padL + innerW, y1: y, y2: y,
        stroke: i === 0 ? '#c9d8e6' : '#e8eef5',
        'stroke-width': 1,
      }));
      const label = svgEl('text', {
        x: padL - 8, y: y + 4, 'text-anchor': 'end',
        fill: '#66727f', 'font-size': 11, 'font-family': 'inherit',
      });
      label.textContent = yFmt(v);
      svg.appendChild(label);
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

    /* --- 折線 + 圓點 --- */
    const dots = [];
    specs.forEach((s) => {
      const plotted = s.points.map((p) => ({
        x: xScale(p.t),
        y: p.v === null ? NaN : yScale(p.v),
        t: p.t,
        v: p.v,
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
          rows.push({ label: entry.series.label, color: entry.series.color, text: (typeof o.tipFormat === 'function' ? o.tipFormat(p.v) : yFmt(p.v)) });
        } else {
          c.setAttribute('opacity', 0);
          rows.push({ label: entry.series.label, color: entry.series.color, text: '無數據' });
        }
      });
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
      const left = fitsRight ? localX + 12 : Math.max(4, localX - tipW - 12);
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

    startObserving(box, W, H);

    return { width: W, height: H, yMax, minT, maxT, points: finite.length, empty: false };
  }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 清空容器並停止尺寸監聽。呼叫端要用自己的空狀態文案時先叫這個，
   * 否則殘留的 ResizeObserver 會在下次 resize 時把圖畫回來。
   */
  function clear(el) {
    if (!el) return;
    stopObserving(el);
    el.__ctOpts = null;
    el.innerHTML = '';
  }

  const ChartLite = {
    renderLine,
    clear,
    dateTicks,
    niceMax,
    scaleX,
    toTime,
    buildPath,
    splitIndex,
    fmtDay,
  };

  if (typeof globalThis !== 'undefined') globalThis.ChartLite = ChartLite;
})();
