/*!
 * chart-export.js — Dashboard 圖表匯出（PDF / SVG / JPG / PNG）
 *
 * 設計原則：
 *  1. 零依賴：ChartLite 本身已是 SVG，直接複製成向量圖；HTML 柱狀圖按 DOM 幾何重建成 SVG。
 *  2. SVG 是真正的向量圖（不是 foreignObject 截圖），文字、線條、柱都可放大不失真。
 *  3. JPG／PNG 由 SVG 經 canvas 光柵化（2–2.5 倍），PDF 由內建最小 PDF writer 嵌入高解析 JPEG。
 *  4. 匯出檔名統一加時間戳，避免重複下載時覆蓋。
 *
 * 對外 API：
 *   globalThis.ChartExport = {
 *     mount(host, opts),               // 在 host 建立「匯出圖表」選單
 *     exportChart(target, opts),       // 回傳重建後的 SVG（供預覽／程式呼叫）
 *     saveChart(target, opts, format), // 直接下載指定格式
 *   }
 *
 * mount(host, opts) 的 opts：
 *   target:    () => Element      要匯出的圖表容器（必填；每次匯出時才解析）
 *   title:     String | () => String
 *   subtitle:  String | () => String
 *   filename:  String | () => String  不含副檔名；會自動加 _YYYYMMDD_HHmm
 *   formats:   Array<'pdf'|'svg'|'jpg'|'png'>  預設全部
 *   buttonLabel: String          預設「匯出圖表」
 *   dataTable: Boolean           線圖下方加「查看數據表」（匯出圖亦會自動包含）
 */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
  const DEFAULT_FORMATS = ['pdf', 'svg', 'jpg', 'png'];
  const FORMAT_LABELS = {
    pdf: { name: 'PDF', hint: 'A4 文件，方便列印／分享' },
    svg: { name: 'SVG', hint: '向量圖，放大不失真' },
    jpg: { name: 'JPG', hint: '壓縮圖片，檔案較小' },
    png: { name: 'PNG', hint: '無損圖片，線條最清晰' },
  };
  const MAX_RASTER = 8192;

  let measureCtx = null;

  /* ==================== 通用小工具 ==================== */

  function $(ref) {
    if (!ref) return null;
    if (typeof ref === 'function') return $(ref());
    if (typeof ref === 'string') {
      const value = ref.trim();
      if (value.startsWith('#') || value.startsWith('.') || value.startsWith('[')) {
        return document.querySelector(value);
      }
      return document.getElementById(value);
    }
    return ref instanceof Element ? ref : null;
  }

  function resolve(value) {
    return typeof value === 'function' ? value() : value;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function fmt(n) {
    const value = Number(n);
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0';
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function stamp(date) {
    const d = date || new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fileStamp(date) {
    const d = date || new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  }

  function safeName(value) {
    return String(value == null ? '' : value)
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .replace(/\s+/g, '_')
      .replace(/^[._\s]+|[._\s]+$/g, '')
      .slice(0, 80) || 'NDRF_chart';
  }

  /** 'YYYY-MM-DD' / Date / timestamp → UTC 毫秒（日期粒度）；無法解析回 NaN。 */
  function pointTime(value) {
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

  function fmtPointDate(t) {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  /** 把 formatter 的輸出壓成純文字（表格用；避免 tooltip 的 HTML 走進 SVG／表格）。 */
  function plainText(value) {
    return String(value == null ? '' : value)
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 把 ChartLite 的 series 整理成「日期 × 每條線」的表格模型。
   * 只在有 label 的 series 上工作；回傳 null 代表沒有可列出的數據。
   */
  function lineTableModel(opts) {
    const o = opts || {};
    const columns = (Array.isArray(o.series) ? o.series : [])
      .filter((spec) => spec && spec.label)
      .map((spec) => {
        const points = (Array.isArray(spec.points) ? spec.points : []).map((p) => {
          if (!p) return null;
          const dateValue = p.date != null ? p.date : (p.report_date != null ? p.report_date : p.x);
          const t = pointTime(dateValue);
          const rawValue = p.value != null ? p.value : (p.ratio != null ? p.ratio : p.y);
          const n = rawValue == null || rawValue === '' ? NaN : Number(rawValue);
          return { t, v: Number.isFinite(n) ? n : null };
        }).filter((p) => p && Number.isFinite(p.t));
        return { label: plainText(spec.label), points };
      })
      .filter((spec) => spec.points.some((p) => p.v !== null));

    if (!columns.length) return null;
    const times = [...new Set(columns.flatMap((spec) => spec.points.map((p) => p.t)))]
      .sort((a, b) => a - b);
    if (!times.length) return null;

    const rows = times.map((t) => ({
      date: fmtPointDate(t),
      values: columns.map((spec) => {
        const hit = spec.points.find((p) => p.t === t && p.v !== null) || spec.points.find((p) => p.t === t);
        return hit ? hit.v : null;
      }),
    }));

    const formatter = typeof o.tipFormat === 'function'
      ? o.tipFormat
      : (typeof o.yFormat === 'function' ? o.yFormat : (v) => fmt(v));
    return {
      columns: columns.map((spec) => spec.label),
      rows,
      format: (v) => {
        if (v == null) return '—';
        try {
          const text = plainText(formatter(v));
          return text || '—';
        } catch {
          return fmt(v);
        }
      },
    };
  }

  function textWidth(text, font) {
    if (!measureCtx) {
      const canvas = document.createElement('canvas');
      measureCtx = canvas.getContext('2d');
    }
    if (!measureCtx) return String(text || '').length * 8;
    measureCtx.font = font;
    return measureCtx.measureText(String(text || '')).width;
  }

  function parseColor(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw || raw === 'transparent') return null;
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(raw);
    if (m) {
      let alpha = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      if (!Number.isFinite(alpha)) alpha = 1;
      if (alpha <= 0) return null;
      return {
        r: Math.max(0, Math.min(255, Math.round(Number(m[1])))),
        g: Math.max(0, Math.min(255, Math.round(Number(m[2])))),
        b: Math.max(0, Math.min(255, Math.round(Number(m[3])))),
        a: Math.max(0, Math.min(1, alpha)),
      };
    }
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return { css: raw, a: 1 };
    if (/^[a-z]+$/i.test(raw)) return { css: raw, a: 1 };
    return null;
  }

  function colorAttrs(prefix, color) {
    if (!color) return '';
    if (color.css) return ` ${prefix}="${esc(color.css)}"`;
    const rgb = `rgb(${color.r}, ${color.g}, ${color.b})`;
    const opacity = color.a < 1 ? ` ${prefix}-opacity="${fmt(color.a * 1000) / 1000}"` : '';
    return ` ${prefix}="${rgb}"${opacity}`;
  }

  function px(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  function fontOf(cs) {
    const style = cs.fontStyle === 'italic' ? 'italic' : 'normal';
    const weight = cs.fontWeight || '400';
    const size = px(cs.fontSize) || 12;
    const family = cs.fontFamily || DEFAULT_FONT;
    return {
      style,
      weight,
      size,
      family,
      css: `${style} ${weight} ${size}px ${family}`,
    };
  }

  function directText(el) {
    let out = '';
    for (const node of el.childNodes || []) {
      if (node.nodeType === 3) out += node.nodeValue;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch { /* 忽略 */ }
    }, 1500);
  }

  function toast(message, isError) {
    let box = document.getElementById('cx_toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cx_toast';
      box.className = 'cx-toast';
      box.setAttribute('role', 'status');
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.classList.toggle('is-error', !!isError);
    box.hidden = false;
    clearTimeout(box._cxTimer);
    box._cxTimer = setTimeout(() => { box.hidden = true; }, isError ? 6500 : 3000);
  }

  /* ==================== 線圖：原生 SVG + 標題列 + 數據表 ==================== */

  /** 把表格模型畫成 SVG 片段（放在線圖下方，讓匯出圖自己解釋得通）。 */
  function buildTableSvg(model, x, y, width) {
    const rows = model && Array.isArray(model.rows) ? model.rows : [];
    const cols = model && Array.isArray(model.columns) ? model.columns : [];
    if (!rows.length || !cols.length) return { parts: [], height: 0 };

    const compact = rows.length > 40;
    const rowH = compact ? 15 : 17;
    const headH = compact ? 22 : 24;
    const fontSize = compact ? 9 : 10;
    const headFont = compact ? 9 : (cols.length >= 3 ? 9 : 10);
    const dateW = Math.max(88, Math.min(160, width * 0.24));
    const valueW = (width - dateW) / cols.length;
    const top = y + 20;
    const tableH = headH + rows.length * rowH;
    const parts = [];

    parts.push(`<text x="${fmt(x)}" y="${fmt(y + 13)}" fill="#0a3d69" font-size="12.5" font-weight="700">數據明細</text>`);
    parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + 18)}" x2="${fmt(x + width)}" y2="${fmt(y + 18)}" stroke="#e3eef8" stroke-width="1"/>`);
    parts.push(`<rect x="${fmt(x)}" y="${fmt(top)}" width="${fmt(width)}" height="${fmt(headH)}" fill="#eef4fb"/>`);
    parts.push(`<text x="${fmt(x + 8)}" y="${fmt(top + headH * 0.68)}" fill="#0a3d69" font-size="${headFont}" font-weight="700">日期</text>`);

    cols.forEach((label, i) => {
      const cx = x + dateW + valueW * (i + 1) - 8;
      parts.push(`<text x="${fmt(cx)}" y="${fmt(top + headH * 0.68)}" fill="#0a3d69" font-size="${headFont}" font-weight="700" text-anchor="end">${esc(label)}</text>`);
    });

    rows.forEach((row, i) => {
      const ry = top + headH + i * rowH;
      if (i % 2 === 1) {
        parts.push(`<rect x="${fmt(x)}" y="${fmt(ry)}" width="${fmt(width)}" height="${fmt(rowH)}" fill="#f8fbfe"/>`);
      }
      parts.push(`<line x1="${fmt(x)}" y1="${fmt(ry + rowH)}" x2="${fmt(x + width)}" y2="${fmt(ry + rowH)}" stroke="#eef2f6" stroke-width="1"/>`);
      const baseline = ry + rowH * 0.7;
      parts.push(`<text x="${fmt(x + 8)}" y="${fmt(baseline)}" fill="#41505e" font-size="${fontSize}">${esc(row.date)}</text>`);
      row.values.forEach((value, vi) => {
        const cx = x + dateW + valueW * (vi + 1) - 8;
        parts.push(`<text x="${fmt(cx)}" y="${fmt(baseline)}" fill="#253543" font-size="${fontSize}" font-weight="600" text-anchor="end">${esc(model.format(value))}</text>`);
      });
    });

    // 欄位分隔線放在最上層，避免被偶數列的底色蓋住
    parts.push(`<line x1="${fmt(x + dateW)}" y1="${fmt(top)}" x2="${fmt(x + dateW)}" y2="${fmt(top + tableH)}" stroke="#e3eef8" stroke-width="1"/>`);
    for (let i = 1; i < cols.length; i += 1) {
      const vx = x + dateW + valueW * i;
      parts.push(`<line x1="${fmt(vx)}" y1="${fmt(top)}" x2="${fmt(vx)}" y2="${fmt(top + tableH)}" stroke="#eef2f6" stroke-width="1"/>`);
    }

    parts.push(`<rect x="${fmt(x)}" y="${fmt(top)}" width="${fmt(width)}" height="${fmt(tableH)}" fill="none" stroke="#dbe7f2" stroke-width="1" rx="4"/>`);
    return { parts, height: 20 + tableH + 4 };
  }

  function buildLineSvg(svgEl, hostEl, meta) {
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
    const W = Math.max(280, Math.round((vb && vb.width) || svgEl.clientWidth || 640));
    const H = Math.max(120, Math.round((vb && vb.height) || svgEl.clientHeight || 220));

    const opts = hostEl && hostEl.__ctOpts ? hostEl.__ctOpts : {};
    const rawSeries = (Array.isArray(opts.series) ? opts.series : []).filter((s) => s && s.label);
    const series = rawSeries.map((s) => ({
      label: String(s.label),
      color: s.color || '#0f5c9c',
      dashed: !!s.dashed,
    }));
    // 24 個月檢視：12 個月前的段落用淺色畫，圖例要交代，否則匯出圖少了一截顏色說明
    const splitSeries = rawSeries.find((s) => s && s.splitDate && s.colorBefore);
    if (splitSeries && !series.some((s) => s.label === '較早資料')) {
      series.push({ label: '較早資料', color: splitSeries.colorBefore, dashed: false });
    }
    const legend = series.length > 1 ? series : [];

    const pad = 18;
    const titleSize = 17;
    const subSize = 11.5;
    const legendFont = `600 11.5px ${DEFAULT_FONT}`;
    const titleW = textWidth(meta.title, `700 ${titleSize}px ${DEFAULT_FONT}`);
    const subW = meta.subtitle ? textWidth(meta.subtitle, `${subSize}px ${DEFAULT_FONT}`) : 0;

    let legendW = 0;
    const legendGap = 18;
    legend.forEach((item) => {
      legendW += 20 + textWidth(item.label, legendFont) + legendGap;
    });
    if (legendW) legendW -= legendGap;

    const table = lineTableModel(opts);
    const minTableW = table ? Math.max(320, 110 + table.columns.length * 92) : 0;
    const totalW = Math.ceil(Math.max(W + pad * 2, titleW + pad * 2, subW + pad * 2, legendW + pad * 2, minTableW + pad * 2));
    let y = pad + titleSize + 4;
    const titleBaseline = y;
    if (meta.subtitle) y += 17;
    const subtitleBaseline = meta.subtitle ? y : 0;
    if (legend.length) y += 20;
    const legendBaseline = legend.length ? y : 0;
    const chartTop = y + 8;
    const tableTop = chartTop + H + 26;
    const tableBlock = table ? buildTableSvg(table, pad, tableTop, totalW - pad * 2) : { parts: [], height: 0 };
    const footerBaseline = tableBlock.height ? tableTop + tableBlock.height + 22 : chartTop + H + 20;
    const totalH = Math.ceil(footerBaseline + 14);

    const out = [];
    out.push(`<svg xmlns="${SVG_NS}" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="${esc(DEFAULT_FONT)}" role="img" aria-label="${esc(meta.title)}">`);
    out.push(`<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#ffffff"/>`);
    out.push(`<text x="${pad}" y="${fmt(titleBaseline)}" fill="#0a3d69" font-size="${titleSize}" font-weight="700">${esc(meta.title)}</text>`);
    if (meta.subtitle) {
      out.push(`<text x="${pad}" y="${fmt(subtitleBaseline)}" fill="#66727f" font-size="${subSize}">${esc(meta.subtitle)}</text>`);
    }

    if (legend.length) {
      let x = pad;
      legend.forEach((item) => {
        out.push(`<line x1="${fmt(x)}" y1="${fmt(legendBaseline - 4)}" x2="${fmt(x + 16)}" y2="${fmt(legendBaseline - 4)}" stroke="${esc(item.color)}" stroke-width="3" stroke-linecap="round"${item.dashed ? ' stroke-dasharray="6 4"' : ''}/>`);
        out.push(`<text x="${fmt(x + 21)}" y="${fmt(legendBaseline)}" fill="#41505e" font-size="11.5" font-weight="600">${esc(item.label)}</text>`);
        x += 20 + textWidth(item.label, legendFont) + legendGap;
      });
    }

    const clone = svgEl.cloneNode(true);
    // 匯出時不應帶住 hover 狀態：引導線與 focus 圓點可能仍係 opacity 1
    clone.querySelectorAll('line[stroke="#94a3b8"][stroke-dasharray="3 3"]').forEach((node) => {
      node.setAttribute('opacity', '0');
    });
    clone.querySelectorAll('g[opacity]').forEach((node) => {
      node.setAttribute('opacity', '0');
    });
    clone.setAttribute('x', String(pad));
    clone.setAttribute('y', String(fmt(chartTop)));
    clone.setAttribute('width', String(W));
    clone.setAttribute('height', String(H));
    clone.removeAttribute('style');
    clone.setAttribute('overflow', 'visible');
    const cloneText = new XMLSerializer().serializeToString(clone);
    out.push(cloneText);
    tableBlock.parts.forEach((part) => out.push(part));

    out.push(`<text x="${pad}" y="${fmt(footerBaseline)}" fill="#8a96a3" font-size="10">RP Connect · NDRF Portal</text>`);
    out.push(`<text x="${totalW - pad}" y="${fmt(footerBaseline)}" fill="#8a96a3" font-size="10" text-anchor="end">${esc(meta.stamp)}</text>`);
    out.push('</svg>');

    return { svg: out.join(''), width: totalW, height: totalH };
  }

  /* ==================== 柱狀圖：DOM 幾何 → 原生 SVG ==================== */

  function isSkippedElement(el) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') return true;
    if (el.closest('.cx-wrap') || el.closest('.ct-tip')) return true;
    return false;
  }

  function relativeRect(el, root, rootRect) {
    const r = el.getBoundingClientRect();
    let x = r.left - rootRect.left;
    let y = r.top - rootRect.top;
    let p = el.parentElement;
    while (p) {
      if (p === root) break;
      if (p.scrollLeft) x += p.scrollLeft;
      if (p.scrollTop) y += p.scrollTop;
      p = p.parentElement;
    }
    if (el !== root) {
      if (root.scrollLeft) x += root.scrollLeft;
      if (root.scrollTop) y += root.scrollTop;
    }

    let w = r.width;
    let h = r.height;
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) w = el.scrollWidth;
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) h = el.scrollHeight;
    return { x, y, w, h };
  }

  function addBorder(items, el, cs, rect) {
    const widths = ['Top', 'Right', 'Bottom', 'Left'].map((side) => px(cs[`border${side}Width`]));
    const styles = ['Top', 'Right', 'Bottom', 'Left'].map((side) => cs[`border${side}Style`]);
    const colors = ['Top', 'Right', 'Bottom', 'Left'].map((side) => parseColor(cs[`border${side}Color`]));
    if (!widths.some((w) => w > 0)) return;

    const radius = Math.min(
      px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius),
      px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius),
    );
    const allSame = widths.every((w) => Math.abs(w - widths[0]) < 0.01)
      && styles.every((s) => s === styles[0])
      && colors.every((c) => (c && colors[0] && c.r === colors[0].r && c.g === colors[0].g && c.b === colors[0].b && c.a === colors[0].a)
        || (!c && !colors[0]));

    if (allSame && widths[0] > 0 && colors[0] && (styles[0] === 'solid' || radius > 0)) {
      const color = colors[0];
      const dash = styles[0] === 'dashed' ? ' stroke-dasharray="4 3"' : (styles[0] === 'dotted' ? ' stroke-dasharray="2 2"' : '');
      const inset = widths[0] / 2;
      items.push({
        kind: 'rect',
        x: rect.x + inset,
        y: rect.y + inset,
        w: Math.max(0, rect.w - widths[0]),
        h: Math.max(0, rect.h - widths[0]),
        radius: Math.max(0, radius - inset),
        fill: null,
        stroke: color,
        strokeWidth: widths[0],
        dash,
      });
      return;
    }

    const sides = [
      { w: widths[0], style: styles[0], color: colors[0], x1: rect.x, y1: rect.y, x2: rect.x + rect.w, y2: rect.y },
      { w: widths[1], style: styles[1], color: colors[1], x1: rect.x + rect.w, y1: rect.y, x2: rect.x + rect.w, y2: rect.y + rect.h },
      { w: widths[2], style: styles[2], color: colors[2], x1: rect.x, y1: rect.y + rect.h, x2: rect.x + rect.w, y2: rect.y + rect.h },
      { w: widths[3], style: styles[3], color: colors[3], x1: rect.x, y1: rect.y, x2: rect.x, y2: rect.y + rect.h },
    ];
    sides.forEach((side) => {
      if (side.w <= 0 || !side.color || side.style === 'none' || side.style === 'hidden') return;
      const dash = side.style === 'dashed' ? ' stroke-dasharray="4 3"' : (side.style === 'dotted' ? ' stroke-dasharray="2 2"' : '');
      items.push({
        kind: 'line',
        x1: side.x1,
        y1: side.y1,
        x2: side.x2,
        y2: side.y2,
        stroke: side.color,
        strokeWidth: side.w,
        dash,
      });
    });
  }

  function addOutline(items, cs, rect) {
    const width = px(cs.outlineWidth);
    if (width <= 0 || cs.outlineStyle === 'none' || cs.outlineStyle === 'hidden') return;
    const color = parseColor(cs.outlineColor);
    if (!color) return;
    const offset = px(cs.outlineOffset);
    const dash = cs.outlineStyle === 'dashed' ? ' stroke-dasharray="4 3"' : (cs.outlineStyle === 'dotted' ? ' stroke-dasharray="2 2"' : '');
    items.push({
      kind: 'rect',
      x: rect.x - offset - width / 2,
      y: rect.y - offset - width / 2,
      w: rect.w + offset * 2 + width,
      h: rect.h + offset * 2 + width,
      radius: 3,
      fill: null,
      stroke: color,
      strokeWidth: width,
      dash,
    });
  }

  function buildDomSvg(root, meta) {
    const rootRect = root.getBoundingClientRect();
    if (!rootRect.width && !rootRect.height) return null;

    const backgrounds = [];
    const texts = [];
    const defs = [];
    let clipSeq = 0;
    const uid = `cx${Math.random().toString(36).slice(2, 8)}`;
    const stripePatternId = `${uid}stripe`;
    let stripePatternAdded = false;
    let maxX = Math.max(rootRect.width, root.scrollWidth || 0);
    let maxY = Math.max(rootRect.height, root.scrollHeight || 0);

    const all = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      if (isSkippedElement(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const rect = relativeRect(el, root, rootRect);
      if (rect.w < 0.5 || rect.h < 0.5) continue;
      maxX = Math.max(maxX, rect.x + rect.w);
      maxY = Math.max(maxY, rect.y + rect.h);

      const bg = parseColor(cs.backgroundColor);
      const bgImage = String(cs.backgroundImage || '');
      const hasStripes = bgImage.includes('repeating-linear-gradient');
      if (bg) {
        backgrounds.push({
          kind: 'rect',
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
          radius: Math.min(px(cs.borderTopLeftRadius), rect.w / 2, rect.h / 2),
          fill: bg,
          stroke: null,
          strokeWidth: 0,
          dash: '',
        });
      }
      if (hasStripes) {
        const clipId = `${uid}clip${clipSeq += 1}`;
        defs.push(`<clipPath id="${clipId}"><rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.w)}" height="${fmt(rect.h)}" rx="${fmt(Math.min(px(cs.borderTopLeftRadius), rect.w / 2))}"/></clipPath>`);
        if (!stripePatternAdded) {
          stripePatternAdded = true;
          defs.push(`<pattern id="${stripePatternId}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="3" fill="#ffffff" fill-opacity="0.55"/></pattern>`);
        }
        backgrounds.push({
          kind: 'rect',
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
          radius: 0,
          fill: null,
          fillUrl: stripePatternId,
          clipPath: clipId,
          stroke: null,
          strokeWidth: 0,
          dash: '',
        });
      }

      addBorder(backgrounds, el, cs, rect);
      addOutline(backgrounds, cs, rect);

      if ((el.classList.contains('stk-share-bar') || el.classList.contains('om-share-bar')) && el.closest('.is-capped')) {
        backgrounds.push({
          kind: 'rect',
          x: rect.x - 1,
          y: rect.y,
          w: rect.w + 2,
          h: 3,
          radius: 0,
          fill: { r: 255, g: 255, b: 255, a: 1 },
          stroke: null,
          strokeWidth: 0,
          dash: '',
        });
        backgrounds.push({
          kind: 'line',
          x1: rect.x - 1,
          y1: rect.y - 0.5,
          x2: rect.x + rect.w + 1,
          y2: rect.y - 0.5,
          stroke: { r: 15, g: 92, b: 156, a: 0.45 },
          strokeWidth: 1,
          dash: '',
        });
      }

      const content = directText(el);
      if (!content) continue;
      const font = fontOf(cs);
      const color = parseColor(cs.color) || { r: 65, g: 80, b: 94, a: 1 };
      const vertical = /^vertical/.test(String(cs.writingMode || ''));
      const borderL = px(cs.borderLeftWidth);
      const borderR = px(cs.borderRightWidth);
      const padL = px(cs.paddingLeft);
      const padR = px(cs.paddingRight);
      const clipId = (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis') ? `${uid}clip${clipSeq += 1}` : '';
      if (clipId) {
        defs.push(`<clipPath id="${clipId}"><rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.w)}" height="${fmt(rect.h)}"/></clipPath>`);
      }

      let x;
      let y;
      let anchor = 'start';
      let transform = '';
      let widthForBounds;
      const measured = textWidth(content, font.css);

      if (vertical) {
        // writing-mode: vertical-rl 對中文字是「直排正立」，不是整段旋轉；
        // 只有數字／英文（例如柱頂百分比）才用旋轉 90° 的方式。
        const cjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(content);
        if (cjk) {
          const chars = Array.from(content);
          let lineY = rect.y + font.size * 0.95;
          const step = font.size * 1.15;
          chars.forEach((ch) => {
            if (!/\s/.test(ch)) {
              texts.push({
                x: rect.x + rect.w / 2,
                y: lineY,
                content: ch,
                anchor: 'middle',
                transform: '',
                clipId,
                font,
                color,
                letterSpacing: '',
              });
            }
            lineY += step;
          });
          maxX = Math.max(maxX, rect.x + rect.w);
          continue;
        }
        x = rect.x + rect.w / 2;
        y = rect.y + rect.h / 2 + font.size * 0.35;
        anchor = 'middle';
        transform = ` transform="rotate(90 ${fmt(x)} ${fmt(y)})"`;
        widthForBounds = rect.x + rect.w;
      } else {
        const left = rect.x + borderL + padL;
        const right = rect.x + rect.w - borderR - padR;
        const align = String(cs.textAlign || 'start');
        if (align === 'center' || align === 'middle') {
          x = (left + right) / 2;
          anchor = 'middle';
          widthForBounds = x + measured / 2;
        } else if (align === 'right' || align === 'end') {
          x = right;
          anchor = 'end';
          widthForBounds = right;
        } else {
          x = left;
          anchor = 'start';
          widthForBounds = left + measured;
        }
        y = rect.y + rect.h / 2 + font.size * 0.35;
      }
      maxX = Math.max(maxX, widthForBounds);

      texts.push({
        x,
        y,
        content,
        anchor,
        transform,
        clipId,
        font,
        color,
        letterSpacing: cs.letterSpacing && cs.letterSpacing !== 'normal' ? cs.letterSpacing : '',
      });
    }

    const contentW = Math.ceil(maxX + 2);
    const contentH = Math.ceil(maxY + 2);
    if (!contentW || !contentH) return null;

    const pad = 16;
    const titleSize = 17;
    const subSize = 11.5;
    const titleW = textWidth(meta.title, `700 ${titleSize}px ${DEFAULT_FONT}`);
    const subW = meta.subtitle ? textWidth(meta.subtitle, `${subSize}px ${DEFAULT_FONT}`) : 0;
    const totalW = Math.ceil(Math.max(contentW + pad * 2, titleW + pad * 2, subW + pad * 2));
    let y = pad + titleSize + 4;
    const titleBaseline = y;
    if (meta.subtitle) y += 17;
    const subtitleBaseline = meta.subtitle ? y : 0;
    const chartTop = y + 10;
    const footerBaseline = chartTop + contentH + 20;
    const totalH = Math.ceil(footerBaseline + 14);

    const out = [];
    out.push(`<svg xmlns="${SVG_NS}" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="${esc(DEFAULT_FONT)}" role="img" aria-label="${esc(meta.title)}">`);
    out.push(`<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#ffffff"/>`);
    out.push(`<text x="${pad}" y="${fmt(titleBaseline)}" fill="#0a3d69" font-size="${titleSize}" font-weight="700">${esc(meta.title)}</text>`);
    if (meta.subtitle) {
      out.push(`<text x="${pad}" y="${fmt(subtitleBaseline)}" fill="#66727f" font-size="${subSize}">${esc(meta.subtitle)}</text>`);
    }
    if (defs.length) out.push(`<defs>${defs.join('')}</defs>`);
    out.push(`<g transform="translate(${pad} ${fmt(chartTop)})">`);

    backgrounds.forEach((item) => {
      if (item.kind === 'rect') {
        const attrs = [];
        if (item.fillUrl) attrs.push(`fill="url(#${item.fillUrl})"`);
        else if (item.fill) attrs.push(colorAttrs('fill', item.fill).trim());
        else attrs.push('fill="none"');
        if (item.stroke) attrs.push(colorAttrs('stroke', item.stroke).trim());
        if (item.strokeWidth) attrs.push(`stroke-width="${fmt(item.strokeWidth)}"`);
        if (item.radius) attrs.push(`rx="${fmt(item.radius)}"`);
        if (item.dash) attrs.push(item.dash.trim());
        if (item.clipPath) attrs.push(`clip-path="url(#${item.clipPath})"`);
        out.push(`<rect x="${fmt(item.x)}" y="${fmt(item.y)}" width="${fmt(item.w)}" height="${fmt(item.h)}" ${attrs.join(' ')}/>`);
      } else {
        const attrs = [
          `x1="${fmt(item.x1)}"`, `y1="${fmt(item.y1)}"`,
          `x2="${fmt(item.x2)}"`, `y2="${fmt(item.y2)}"`,
          colorAttrs('stroke', item.stroke).trim(),
          `stroke-width="${fmt(item.strokeWidth)}"`,
        ];
        if (item.dash) attrs.push(item.dash.trim());
        out.push(`<line ${attrs.join(' ')}/>`);
      }
    });

    texts.forEach((item) => {
      const attrs = [
        `x="${fmt(item.x)}"`, `y="${fmt(item.y)}"`,
        `fill="${item.color.css ? esc(item.color.css) : `rgb(${item.color.r}, ${item.color.g}, ${item.color.b})`}"`,
        `font-family="${esc(item.font.family)}"`,
        `font-size="${fmt(item.font.size)}"`,
        `font-weight="${esc(item.font.weight)}"`,
      ];
      if (item.color.a < 1) attrs.push(`fill-opacity="${fmt(item.color.a * 1000) / 1000}"`);
      if (item.font.style !== 'normal') attrs.push(`font-style="${item.font.style}"`);
      if (item.anchor !== 'start') attrs.push(`text-anchor="${item.anchor}"`);
      if (item.letterSpacing) attrs.push(`letter-spacing="${esc(item.letterSpacing)}"`);
      if (item.transform) attrs.push(item.transform.trim());
      if (item.clipId) attrs.push(`clip-path="url(#${item.clipId})"`);
      out.push(`<text ${attrs.join(' ')}>${esc(item.content)}</text>`);
    });

    out.push('</g>');
    out.push(`<text x="${pad}" y="${fmt(footerBaseline)}" fill="#8a96a3" font-size="10">RP Connect · NDRF Portal</text>`);
    out.push(`<text x="${totalW - pad}" y="${fmt(footerBaseline)}" fill="#8a96a3" font-size="10" text-anchor="end">${esc(meta.stamp)}</text>`);
    out.push('</svg>');
    return { svg: out.join(''), width: totalW, height: totalH };
  }

  /* ==================== 光柵化 / PDF ==================== */

  function loadImage(src) {
    return new Promise((resolveImage, reject) => {
      const img = new Image();
      img.onload = () => resolveImage(img);
      img.onerror = () => reject(new Error('SVG 轉換成圖片失敗'));
      img.src = src;
    });
  }

  async function rasterize(svg, width, height, scale) {
    const ratio = Math.min(scale, MAX_RASTER / Math.max(1, width), MAX_RASTER / Math.max(1, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('瀏覽器不支援 canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolveBlob, reject) => {
      if (canvas.toBlob) {
        canvas.toBlob((blob) => {
          if (blob) resolveBlob(blob);
          else reject(new Error('產生圖片失敗'));
        }, mime, quality);
        return;
      }
      try {
        const data = canvas.toDataURL(mime, quality);
        const base64 = data.split(',')[1] || '';
        const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
        resolveBlob(new Blob([bytes], { type: mime }));
      } catch (err) {
        reject(err);
      }
    });
  }

  function ascii(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function pdfTextHex(text) {
    let hex = 'FEFF';
    for (const ch of String(text || '')) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0').toUpperCase();
        hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0').toUpperCase();
      } else {
        hex += cp.toString(16).padStart(4, '0').toUpperCase();
      }
    }
    return hex;
  }

  async function buildPdf(jpegBlob, pixelW, pixelH, title) {
    const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
    const A4 = { w: 595.28, h: 841.89 };
    const landscape = pixelW > pixelH * 1.05;
    const pageW = landscape ? A4.h : A4.w;
    const pageH = landscape ? A4.w : A4.h;
    const margin = 24;
    const fit = Math.min((pageW - margin * 2) / pixelW, (pageH - margin * 2) / pixelH);
    const drawW = pixelW * fit;
    const drawH = pixelH * fit;
    const drawX = (pageW - drawW) / 2;
    const drawY = (pageH - drawH) / 2;

    const parts = [];
    let length = 0;
    const offsets = [];
    const push = (data) => {
      const bytes = typeof data === 'string' ? ascii(data) : data;
      parts.push(bytes);
      length += bytes.length;
    };
    const obj = (n, body) => {
      offsets[n] = length;
      push(`${n} 0 obj\n`);
      if (typeof body === 'string') push(body);
      else body.forEach(push);
      push('\nendobj\n');
    };

    const content = `q\n${fmt(drawW)} 0 0 ${fmt(drawH)} ${fmt(drawX)} ${fmt(drawY)} cm\n/Im0 Do\nQ\n`;
    const date = new Date();
    const pdfDate = `D:${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}+08'00'`;

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pageW)} ${fmt(pageH)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
    obj(4, [`<< /Length ${content.length} >>\nstream\n`, ascii(content), 'endstream']);
    obj(5, [
      `<< /Type /XObject /Subtype /Image /Width ${pixelW} /Height ${pixelH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      '\nendstream',
    ]);
    obj(6, `<< /Title <${pdfTextHex(title || 'NDRF Chart')}> /Producer (RP Connect NDRF Portal) /CreationDate (${pdfDate}) >>`);

    const xrefStart = length;
    push(`xref\n0 7\n0000000000 65535 f \n`);
    for (let i = 1; i <= 6; i += 1) {
      push(`${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  /* ==================== 匯出流程 ==================== */

  function buildMeta(opts) {
    const title = String(resolve(opts.title) || '圖表').trim() || '圖表';
    const subtitle = String(resolve(opts.subtitle) || '').trim();
    const base = safeName(resolve(opts.filename) || title);
    return {
      title,
      subtitle,
      stamp: stamp(),
      filename: `${base}_${fileStamp()}`,
    };
  }

  async function exportChart(targetRef, options) {
    const opts = options || {};
    const target = $(targetRef);
    if (!target) throw new Error('找不到圖表，請先載入資料。');
    const meta = buildMeta(opts);
    const lineSvg = target.querySelector('svg.ct-svg');
    const hasHtmlChart = !!target.querySelector('.stk-share, .om-share, .stk-bars, .om-share-rows');
    let built = null;
    if (lineSvg && !hasHtmlChart) built = buildLineSvg(lineSvg, target, meta);
    else built = buildDomSvg(target, meta);
    if (!built || !built.svg) throw new Error('此圖表未支援匯出，或目前沒有可匯出的內容。');
    return { ...built, meta };
  }

  async function saveChart(targetRef, options, format) {
    const opts = options || {};
    const built = await exportChart(targetRef, opts);
    const ext = ['pdf', 'svg', 'jpg', 'png'].includes(format) ? format : 'png';

    if (ext === 'svg') {
      downloadBlob(new Blob([built.svg], { type: 'image/svg+xml;charset=utf-8' }), `${built.meta.filename}.svg`);
      return;
    }

    const scale = ext === 'pdf' ? 2.5 : 2;
    const canvas = await rasterize(built.svg, built.width, built.height, scale);
    if (ext === 'pdf') {
      const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.95);
      const pdf = await buildPdf(jpeg, canvas.width, canvas.height, built.meta.title);
      downloadBlob(pdf, `${built.meta.filename}.pdf`);
      return;
    }
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';
    const blob = await canvasToBlob(canvas, mime, 0.95);
    downloadBlob(blob, `${built.meta.filename}.${ext}`);
  }

  async function run(hostEl, opts, format, trigger) {
    const wrap = hostEl ? hostEl.querySelector('.cx-wrap') : null;
    if (wrap && wrap.dataset.busy === '1') return;
    if (wrap) wrap.dataset.busy = '1';
    const defaultLabel = opts.buttonLabel || '匯出圖表';
    if (trigger) {
      clearTimeout(trigger._cxResetTimer);
      trigger.textContent = '匯出中…';
      trigger.setAttribute('aria-busy', 'true');
    }
    try {
      await saveChart(opts.target, opts, format);
      toast(`已匯出 ${String(format).toUpperCase()} 圖表`);
      if (trigger) {
        trigger.textContent = '已匯出';
        trigger._cxResetTimer = setTimeout(() => { trigger.textContent = defaultLabel; }, 1400);
      }
    } catch (err) {
      console.error('[chart-export]', err);
      toast(`匯出失敗：${err && err.message ? err.message : err}`, true);
      if (trigger) {
        clearTimeout(trigger._cxResetTimer);
        trigger.textContent = defaultLabel;
      }
    } finally {
      if (trigger) trigger.removeAttribute('aria-busy');
      if (wrap) setTimeout(() => { wrap.dataset.busy = '0'; }, 300);
    }
  }

  /* ==================== 畫面用「查看數據表」 ==================== */

  function renderScreenTable(details, target) {
    const body = details.querySelector('.cx-data-body');
    const summary = details.querySelector('summary');
    if (!body || !summary) return;
    const model = lineTableModel(target && target.__ctOpts);
    if (!model || !model.rows.length) {
      summary.textContent = '暫無數據表';
      body.innerHTML = '<p class="cx-data-empty">此圖表暫時沒有可列出的每期數據。</p>';
      return;
    }
    summary.textContent = `查看數據表（${model.rows.length} 期）`;
    const head = `<tr><th scope="col">日期</th>${model.columns.map((label) => `<th scope="col">${esc(label)}</th>`).join('')}</tr>`;
    const rows = model.rows.map((row) => `<tr><td>${esc(row.date)}</td>${row.values.map((value) => `<td>${esc(model.format(value))}</td>`).join('')}</tr>`).join('');
    body.innerHTML = `<div class="cx-data-scroll"><table class="cx-data-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  }

  function mountDataTable(targetRef) {
    const target = $(targetRef);
    if (!target || !target.parentNode || target.dataset.cxTableMounted === '1') return null;
    target.dataset.cxTableMounted = '1';
    const details = document.createElement('details');
    details.className = 'cx-data-details';
    details.innerHTML = '<summary>查看數據表</summary><div class="cx-data-body"></div>';
    target.insertAdjacentElement('afterend', details);
    details.addEventListener('toggle', () => {
      if (details.open) renderScreenTable(details, target);
    });
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(() => {
        if (details.open) renderScreenTable(details, target);
      });
      observer.observe(target, { childList: true });
    }
    return details;
  }

  function mount(hostRef, options) {
    const host = $(hostRef);
    if (!host || host.dataset.cxMounted === '1') return null;
    const opts = options || {};
    if (!opts.target) throw new Error('ChartExport.mount 需要 target');
    host.dataset.cxMounted = '1';
    host.classList.add('chart-export-host');

    const formats = (Array.isArray(opts.formats) && opts.formats.length ? opts.formats : DEFAULT_FORMATS)
      .filter((key) => FORMAT_LABELS[key]);

    const wrap = document.createElement('details');
    wrap.className = 'cx-wrap';
    const trigger = document.createElement('summary');
    trigger.className = 'cx-btn';
    trigger.textContent = opts.buttonLabel || '匯出圖表';
    trigger.title = '匯出目前圖表（PDF／SVG／JPG／PNG）';
    trigger.setAttribute('aria-label', '匯出目前圖表');

    const menu = document.createElement('div');
    menu.className = 'cx-menu';
    menu.setAttribute('role', 'menu');
    formats.forEach((key) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'cx-item';
      item.dataset.cxFormat = key;
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `<b>${FORMAT_LABELS[key].name}</b><span>${FORMAT_LABELS[key].hint}</span>`;
      menu.appendChild(item);
    });

    wrap.append(trigger, menu);
    host.appendChild(wrap);
    if (resolve(opts.dataTable)) mountDataTable(opts.target);

    menu.addEventListener('click', (e) => {
      const item = e.target instanceof Element ? e.target.closest('[data-cx-format]') : null;
      if (!item) return;
      e.preventDefault();
      wrap.open = false;
      void run(host, opts, item.dataset.cxFormat, trigger);
    });

    return wrap;
  }

  /* 點擊選單外面／按 Esc 自動收起 */
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.cx-wrap[open]').forEach((wrap) => {
      if (!(e.target instanceof Node) || !wrap.contains(e.target)) wrap.open = false;
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.cx-wrap[open]').forEach((wrap) => { wrap.open = false; });
  });

  globalThis.ChartExport = {
    mount,
    exportChart,
    saveChart,
    version: '1.0.0',
  };
})();
