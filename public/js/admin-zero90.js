/* Admin 存貨 Dashboard →「90日0銷售（統計）」分頁
   獨立模組：自有 CSRF / fetch / esc，DOM id 一律 z90_ 前綴，不與 admin-stock.js 衝突。
   數據來源是每週「90日0銷售（統計）」簡報的手動入數，與 I14「By Shop」完全獨立。 */
(() => {
  const $ = (id) => document.getElementById(id);

  /** 分頁／指標偏好（只記顯示方式，不記任何數據） */
  const VIEW_KEY = 'ndrf_admin_stock_view';
  const METRIC_KEY = 'ndrf_admin_z90_metric';
  const SPLIT_KEY = 'ndrf_admin_z90_split';
  const MONTHS_KEY = 'ndrf_admin_z90_months';
  /** 走勢圖顯示期間（月）：1 / 3 / 6 / 12，預設 3；資料永久保留，只影響畫幾多期 */
  const MONTH_OPTIONS = [1, 3, 6, 12];

  const COLOR_TOTAL = '#0f5c9c';
  const COLOR_MAKEUP = '#b5367a';
  const COLOR_NON = '#0f766e';
  /** 雙軸對照：SKU 走綠、存貨量走藍；刻度文字用同一隻色，睇顏色就知邊個軸 */
  const COLOR_DUAL_SKU = '#0f7a4d';
  const COLOR_DUAL_QTY = '#0f5c9c';

  let csrf = null;
  let loaded = false;
  let loading = null;
  let summary = null;
  let metric = 'sku';
  /** 「顯示 MAKE UP 拆分」：預設關（合計線看得清趨勢），偏好記住 */
  let split = false;
  /** 走勢圖顯示期間（月），預設 3 個月；只影響圖表窗口，KPI 與明細永遠用最新／全部 */
  let months = 3;

  /* ==================== 網絡 ==================== */

  async function getCsrf(force) {
    if (!csrf || force) {
      const res = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json().catch(() => null);
      csrf = (data && data.token) || csrf;
    }
    return csrf;
  }

  /** 帶 CSRF 的請求；寫入前重新取 token（cookie 可能過期），403 CSRF 重試一次 */
  async function aFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const isWrite = method !== 'GET' && method !== 'HEAD';
    let res = null;
    let data = null;
    let csrfFailed = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getCsrf(attempt > 0 || isWrite);
      const headers = { ...(opts.headers || {}) };
      if (token) headers['x-csrf-token'] = token;
      if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
      res = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
      data = await res.json().catch(() => null);
      csrfFailed = res.status === 403 && /csrf/i.test(String((data && data.error) || ''));
      if (!csrfFailed || attempt > 0) break;
    }

    if (!res || !res.ok) {
      const message = csrfFailed
        ? '安全憑證已過期，請重新整理頁面（F5）再試'
        : (data && data.error) || `請求失敗 (${res ? res.status : 0})`;
      const err = new Error(message);
      err.status = res ? res.status : 0;
      throw err;
    }
    return data;
  }

  /* ==================== 小工具 ==================== */

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : value;
    return div.innerHTML;
  }

  function escAttr(value) {
    return esc(value).replace(/"/g, '&quot;');
  }

  function num(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmtInt(value) {
    const n = num(value);
    if (n === null) return '—';
    return Math.round(n).toLocaleString('en-US');
  }

  /** 存貨量可以有 3 位小數；整數就不顯示 .00，避免 230,888.000 這種讀法 */
  function fmtQty(value) {
    const n = num(value);
    if (n === null) return '—';
    const rounded = Math.round(n * 1000) / 1000;
    const fractionDigits = Number.isInteger(rounded) ? 0 : (Math.round(rounded * 100) / 100 === rounded ? 2 : 3);
    return rounded.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
  }

  function fmtSignedInt(value) {
    const n = num(value);
    if (n === null) return '—';
    const rounded = Math.round(n);
    return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US')}`;
  }

  function fmtSignedQty(value) {
    const n = num(value);
    if (n === null) return '—';
    return `${n > 0 ? '+' : ''}${fmtQty(n)}`;
  }

  function fmtRatio(value) {
    const n = num(value);
    if (n === null) return '—';
    return `${(n * 100).toFixed(1)}%`;
  }

  function fmtPct(value) {
    const n = num(value);
    if (n === null) return '—';
    return `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
  }

  /** 升＝紅（多咗死貨），跌＝綠；顏色只套在「較上期」文字，數值本身不上色 */
  function deltaClass(value) {
    const n = num(value);
    if (n === null || n === 0) return 'text-secondary';
    return n > 0 ? 'text-danger' : 'text-success';
  }

  function deltaArrow(value) {
    const n = num(value);
    if (n === null || n === 0) return '';
    return n > 0 ? '▲ ' : '▼ ';
  }

  function alertClass(type) {
    if (type === 'error') return 'alert-danger';
    if (type === 'success') return 'alert-success';
    if (type === 'warning') return 'alert-warning';
    return 'alert-info';
  }

  function setResult(id, type, message) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = message ? `<div class="alert ${alertClass(type)}">${esc(message)}</div>` : '';
  }

  /** 香港今日 'YYYY-MM-DD'（後台使用者都在 HK；失敗時回落 UTC） */
  function hkToday() {
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: 'Asia/Hong_Kong',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const year = parts.find((part) => part.type === 'year')?.value;
      const month = parts.find((part) => part.type === 'month')?.value;
      const day = parts.find((part) => part.type === 'day')?.value;
      if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
      /* 舊瀏覽器沒有 formatToParts */
    }
    return new Date().toISOString().slice(0, 10);
  }

  /** 'YYYY-MM-DD' 往前推 n 個月；月底自動夾到該月最後一日（與 admin-stock.js 同一算法） */
  function monthsBefore(dateStr, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
    if (!m) return '';
    const year = Number(m[1]);
    const month = Number(m[2]) - 1 - n;
    const day = Number(m[3]);
    const target = new Date(Date.UTC(year, month, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(target.getUTCDate()).padStart(2, '0');
    return `${target.getUTCFullYear()}-${mm}-${dd}`;
  }

  /** Y 軸刻度用的短格式：6,659 → 6.7k；數字太長會撞到左邊邊界 */
  function axisFormat(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    const abs = Math.abs(n);
    if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
    if (abs >= 1e4) return `${Math.round(n / 1e3)}k`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    if (abs >= 10) return String(Math.round(n));
    return n.toFixed(1);
  }

  /* ==================== 分頁切換 ==================== */

  function currentView() {
    const z = $('stk_view_zero90');
    return z && !z.hidden ? 'zero90' : 'stock';
  }

  function setView(view, options = {}) {
    const target = view === 'zero90' ? 'zero90' : 'stock';
    const stockEl = $('stk_view_stock');
    const zEl = $('stk_view_zero90');
    if (!stockEl || !zEl) return;

    stockEl.hidden = target !== 'stock';
    zEl.hidden = target !== 'zero90';
    const switchEl = $('stk_view_switch');
    if (switchEl) {
      switchEl.querySelectorAll('[data-stk-view]').forEach((btn) => {
        const active = btn.dataset.stkView === target;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
      });
    }
    try { localStorage.setItem(VIEW_KEY, target); } catch { /* 私隱模式 */ }

    if (target === 'zero90' && options.load !== false) ensureLoaded();
  }

  /* ==================== KPI ==================== */

  function kpiCard(value, label, sub) {
    return `<div class="stk-kpi">
      <div class="stk-kpi-value">${value}</div>
      <div class="stk-kpi-label">${label}</div>
      ${sub ? `<div class="stk-kpi-sub">${sub}</div>` : ''}
    </div>`;
  }

  function deltaLine(delta, pct, unit) {
    if (num(delta) === null) return '<span class="text-secondary">暫無對比（第一期）</span>';
    const signed = unit === 'qty' ? fmtSignedQty(delta) : fmtSignedInt(delta);
    return `<span class="${deltaClass(delta)}">${deltaArrow(delta)}${signed}（${fmtPct(pct)}）</span>`;
  }

  function renderKpi(data) {
    const box = $('z90_kpi');
    const note = $('z90_kpi_note');
    if (!box) return;
    const kpi = (data && data.kpi) || null;
    if (!kpi) {
      if (note) note.textContent = '0 期資料';
      box.innerHTML = kpiCard('—', '尚未輸入任何一期', '用下方表單加入第 1 期');
      return;
    }
    if (note) note.textContent = `${kpi.report_date}・共 ${data.period_count} 期資料`;
    box.innerHTML = [
      kpiCard(esc(kpi.report_date), '最新報表日期', `共 ${data.period_count} 期資料`),
      kpiCard(fmtInt(kpi.sku_total), '90日0銷售 SKU 總數', deltaLine(kpi.sku_delta, kpi.sku_delta_pct, 'sku')),
      kpiCard(fmtQty(kpi.qty_total), '90日0銷售存貨量（CM）', deltaLine(kpi.qty_delta, kpi.qty_delta_pct, 'qty')),
      kpiCard(fmtInt(kpi.makeup_sku), 'MAKE UP SKU', `佔 SKU 總數 ${fmtRatio(kpi.makeup_sku_share)}`),
      kpiCard(fmtQty(kpi.makeup_qty_cm), 'MAKE UP 存貨量（CM）', `佔存貨量 ${fmtRatio(kpi.makeup_qty_share)}`),
      kpiCard(fmtInt(kpi.shop_count), '涉及店數', `平均每店 ${fmtQty(kpi.sku_per_shop)} SKU`),
    ].join('');
  }

  /* ==================== 走勢圖 ==================== */

  const METRICS = {
    sku: {
      label: 'SKU 總數',
      format: fmtInt,
      // 標籤預留闊度：數字短可以密一點，6 個月都能逐點標
      labelSpacing: 34,
      total: [{ key: 'total', label: 'SKU 總數', color: COLOR_TOTAL, field: 'sku_total' }],
      split: [
        { key: 'makeup', label: 'MAKE UP', color: COLOR_MAKEUP, field: 'makeup_sku' },
        { key: 'non', label: 'Non-MAKE UP', color: COLOR_NON, field: 'non_makeup_sku' },
      ],
    },
    qty: {
      label: '存貨量（CM）總數',
      format: fmtQty,
      labelSpacing: 48,
      total: [{ key: 'total', label: '存貨量總數', color: COLOR_TOTAL, field: 'qty_total' }],
      split: [
        { key: 'makeup', label: 'MAKE UP', color: COLOR_MAKEUP, field: 'makeup_qty_cm' },
        { key: 'non', label: 'Non-MAKE UP', color: COLOR_NON, field: 'non_makeup_qty_cm' },
      ],
    },
    perShop: {
      label: '平均每店 SKU 數',
      labelSpacing: 38,
      format: (value) => (num(value) === null ? '—' : (Math.round(Number(value) * 10) / 10).toLocaleString('en-US')),
      single: [{ key: 'per', label: '平均每店 SKU 數', color: COLOR_TOTAL, field: 'sku_per_shop' }],
    },
    share: {
      label: 'MAKE UP 佔比',
      format: fmtRatio,
      labelSpacing: 40,
      percent: true,
      shares: [
        { key: 'sku_share', label: 'MAKE UP SKU 佔比', color: COLOR_MAKEUP, field: 'makeup_sku_share' },
        { key: 'qty_share', label: 'MAKE UP 存貨量佔比', color: COLOR_NON, field: 'makeup_qty_share' },
      ],
    },
    dual: {
      label: 'SKU 數 ＋ 存貨量（雙軸）',
      dual: true,
      // 兩條線各自一條軸：左 SKU、右 存貨量，單位唔同都可以放同一個圖
      both: [
        {
          key: 'sku', label: 'SKU 數（左軸）', color: COLOR_DUAL_SKU, field: 'sku_total',
          axis: 'left', format: fmtInt, labelSpacing: 34,
        },
        {
          key: 'qty', label: '存貨量（右軸）', color: COLOR_DUAL_QTY, field: 'qty_total',
          axis: 'right', format: fmtQty, labelSpacing: 48,
        },
      ],
    },
  };

  /** 依現時指標＋「顯示拆分」決定畫邊幾條線（ChartLite 最多 3 條） */
  function activeSeries(config) {
    if (config.both) return config.both;
    if (config.shares) return config.shares;
    if (config.single) return config.single;
    if (split && config.split) return [...config.total, ...config.split];
    return config.total;
  }

  /** 用數據範圍加 25% padding，再對齊「好睇」刻度；範圍一定要包住所有點 */
  function chartRange(values) {
    const api = globalThis.ChartLite;
    const nums = values.map((v) => num(v)).filter((v) => v !== null);
    if (!nums.length || !api || typeof api.niceRange !== 'function') return {};

    let lo = Math.min(...nums);
    let hi = Math.max(...nums);
    if (hi === lo) {
      const pad = Math.abs(hi) * 0.05 || 1;
      lo -= pad;
      hi += pad;
    } else {
      const pad = (hi - lo) * 0.25;
      lo -= pad;
      hi += pad;
    }
    if (lo < 0 && Math.min(...nums) >= 0) lo = 0;

    let range = api.niceRange(lo, hi, 4);
    // 貼線（點幾乎貼住上／下邊）就再放闊少少，至少留 4% 呼吸位
    const span = range.max - range.min;
    if (span > 0) {
      if ((hi - range.min) / span > 0.96 || (range.max - lo) / span > 0.96) {
        range = api.niceRange(range.min - (hi - lo) * 0.15, range.max + (hi - lo) * 0.15, 4);
      }
    }
    return { yMin: range.min, yMax: range.max };
  }

  function renderChart(series) {
    const el = $('z90_chart');
    const legend = $('z90_legend');
    const note = $('z90_chart_note');
    if (!el) return;
    setResult('z90_chart_error', 'info', '');
    if (note) note.textContent = '';

    const config = METRICS[metric] || METRICS.sku;
    const allRows = Array.isArray(series) ? series : [];
    // 顯示期間：以最新一期回推 N 個月；KPI 與明細不受影響
    const latestDate = allRows.length ? String(allRows[allRows.length - 1].report_date).slice(0, 10) : '';
    const cutoff = latestDate ? monthsBefore(latestDate, months) : '';
    const rows = cutoff
      ? allRows.filter((row) => String(row.report_date).slice(0, 10) >= cutoff)
      : allRows;
    const chartSeries = activeSeries(config).map((spec) => ({
      ...spec,
      points: rows
        .map((row) => ({ date: row.report_date, value: num(row[spec.field]) }))
        .filter((point) => point.value !== null),
    }));
    const usable = chartSeries.reduce((acc, spec) => acc + spec.points.length, 0);

    // 「顯示拆分」只對 SKU／存貨量有意義；其他指標隱藏開關，避免多餘控件
    const splitWrap = $('z90_split_wrap');
    if (splitWrap) splitWrap.hidden = !config.split;

    if (!rows.length) {
      el.innerHTML = '<div class="ct-empty">尚未輸入任何一期，走勢會在第一次儲存後出現。</div>';
      if (legend) legend.innerHTML = '';
      return;
    }
    if (usable === 0) {
      el.innerHTML = '<div class="ct-empty">已有期數，但這個指標全部為空（店數為 0 時「平均每店」畫不出）。</div>';
      if (legend) legend.innerHTML = '';
      return;
    }
    if (chartSeries[0].points.length === 1) {
      el.innerHTML = `<div class="ct-empty">目前只有 1 期資料（${esc(rows[0].report_date)}），下一期輸入後會顯示走勢。</div>`;
      if (legend) legend.innerHTML = '';
      return;
    }

    if (legend) {
      legend.innerHTML = chartSeries
        .map((spec) => `<span class="stk-legend-item"><i style="background:${spec.color}"></i>${esc(spec.label)}</span>`)
        .join('');
    }

    const chartApi = globalThis.ChartLite;
    if (!chartApi) {
      el.innerHTML = '<div class="ct-empty">圖表元件未載入（/js/chart-lite.js），請重新整理頁面。</div>';
      return;
    }

    // 雙軸：左右各自計範圍（兩邊單位差 30 倍，共用一個軸會令 SKU 變直線）
    const isDual = !!config.dual;
    const valuesOf = (which) => chartSeries
      .filter((spec) => (which === 'right' ? spec.axis === 'right' : spec.axis !== 'right'))
      .flatMap((spec) => spec.points.map((point) => point.value));
    const range = chartRange(isDual
      ? valuesOf('left')
      : chartSeries.flatMap((spec) => spec.points.map((point) => point.value)));
    const range2 = isDual ? chartRange(valuesOf('right')) : {};
    const yText = (value) => (config.percent ? fmtRatio(value) : axisFormat(value));

    chartApi.renderLine(el, {
      series: chartSeries,
      height: 260,
      emptyText: '暫無數據',
      yFormat: (v) => yText(v),
      // 雙軸：右軸用自己嘅刻度格式，並把左右刻度染成對應線色
      ...(isDual ? {
        y2Format: (v) => axisFormat(v),
        yColor: COLOR_DUAL_SKU,
        y2Color: COLOR_DUAL_QTY,
      } : {}),
      // 單軸指標共用一個格式；雙軸交由每條 series 自己的 format
      ...(typeof config.format === 'function' ? {
        tipFormat: (v) => config.format(v),
        labelFormat: (v) => config.format(v),
      } : {}),
      // 每個數據點都標示實際數值；期數太密時 ChartLite 會自動隔開（最新一期一定標）
      valueLabels: true,
      labelSpacing: config.labelSpacing,
      ariaLabel: `${config.label}走勢，顯示最近 ${months} 個月共 ${rows.length} 期，最新 ${rows[rows.length - 1].report_date}`,
      ...range,
      ...(isDual && Number.isFinite(range2.yMin) ? { y2Min: range2.yMin, y2Max: range2.yMax } : {}),
    });

    if (note) {
      const parts = [];
      parts.push(`顯示最近 ${months} 個月（${rows.length} 期）。`);
      if (isDual) {
        parts.push('左軸＝SKU 數（綠）、右軸＝存貨量（藍）；兩軸各自縮放，只宜比較走勢方向，線的高低不可直接比。');
        const first = rows[0];
        const last = rows[rows.length - 1];
        const pctOf = (from, to) => {
          const a = num(from);
          const b = num(to);
          return a === null || b === null || a === 0 ? null : (b - a) / a;
        };
        parts.push(`期內變化：SKU ${fmtPct(pctOf(first.sku_total, last.sku_total))}、存貨量 ${fmtPct(pctOf(first.qty_total, last.qty_total))}。`);
      } else if (num(range.yMin) !== null && range.yMin > 0) {
        parts.push(`Y 軸由 ${yText(range.yMin)} 起（放大波動，不是 0 起點）。`);
      }
      parts.push('點上數字為該期實際值；期數太密時標籤會自動隔開（最新一期必顯示），懸停可看該期全部線的數值。');
      note.textContent = parts.join(' ');
    }
  }

  /* ==================== 每期明細 ==================== */

  function shareCell(skuShare, qtyShare) {
    return `<span>${fmtRatio(skuShare)}</span><span class="z90-sub">${fmtRatio(qtyShare)}</span>`;
  }

  /** 每期明細的「較上期」：SKU 增減一行、存貨量增減一行（百分比在 KPI 卡看） */
  function deltaCell(row) {
    if (num(row.sku_delta) === null) return '<span class="text-secondary">—</span>';
    return `<span class="${deltaClass(row.sku_delta)}">${fmtSignedInt(row.sku_delta)}</span>`
      + `<span class="z90-sub ${deltaClass(row.qty_delta)}">量 ${fmtSignedQty(row.qty_delta)}</span>`;
  }

  function renderTable(series) {
    const body = $('z90_table_body');
    const note = $('z90_table_note');
    if (!body) return;
    const rows = Array.isArray(series) ? [...series].reverse() : [];
    if (note) note.textContent = rows.length ? `共 ${rows.length} 期（新→舊）` : '';
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="12" class="text-center text-secondary">尚未輸入任何一期，請用上方表單加入第 1 期。</td></tr>';
      return;
    }

    body.innerHTML = rows.map((row) => `
      <tr data-z90-row="${escAttr(row.report_date)}">
        <td>${esc(row.report_date)}</td>
        <td class="z90-num">${fmtInt(row.shop_count)}</td>
        <td class="z90-num"><b>${fmtInt(row.sku_total)}</b></td>
        <td class="z90-num">${fmtInt(row.makeup_sku)}</td>
        <td class="z90-num">${fmtInt(row.non_makeup_sku)}</td>
        <td class="z90-num"><b>${fmtQty(row.qty_total)}</b></td>
        <td class="z90-num">${fmtQty(row.makeup_qty_cm)}</td>
        <td class="z90-num">${fmtQty(row.non_makeup_qty_cm)}</td>
        <td class="z90-num">${shareCell(row.makeup_sku_share, row.makeup_qty_share)}</td>
        <td class="z90-num">${deltaCell(row)}</td>
        <td>${row.note ? esc(row.note) : '<span class="text-secondary">—</span>'}</td>
        <td class="text-nowrap">
          <button class="btn btn-sm" type="button" data-z90-edit="${escAttr(row.report_date)}">編輯</button>
          <button class="btn btn-sm btn-outline-danger" type="button" data-z90-delete="${escAttr(row.report_date)}">刪除</button>
        </td>
      </tr>`).join('');
  }

  /* ==================== 載入 ==================== */

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const data = await aFetch('/api/admin/stock/zero90/summary');
        summary = data;
        loaded = true;
        renderKpi(data);
        renderChart(data.series);
        renderTable(data.series);
        setResult('z90_kpi_error', 'info', '');
      } catch (err) {
        setResult('z90_kpi_error', 'error', err.message);
        setResult('z90_table_error', 'error', err.message);
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  function ensureLoaded() {
    if (!loaded && !loading) void load();
  }

  /* ==================== 表單 ==================== */

  /* ---------- 從 Excel 貼上：解析在 /js/z90-paste.js（純函數，有單元測試） ---------- */

  /** 貼上 → 填入四個分項（日期／店數只會在貼 8 欄時一併填） */
  function applyPaste() {
    const input = $('z90_paste');
    if (!input) return;
    const parser = globalThis.Z90Paste;
    if (!parser || typeof parser.parse !== 'function') {
      setResult('z90_paste_result', 'error', '貼上解析元件未載入（/js/z90-paste.js），請重新整理頁面（F5）再試。');
      return;
    }
    const parsed = parser.parse(input.value);
    if (parsed.error) {
      setResult('z90_paste_result', 'error', parsed.error);
      return;
    }

    if (parsed.reportDate && $('z90_date')) $('z90_date').value = parsed.reportDate;
    if (parsed.shopCount !== undefined && $('z90_shops')) $('z90_shops').value = String(parsed.shopCount);
    const stats = parsed.stats;
    if ($('z90_makeup_sku')) $('z90_makeup_sku').value = String(stats.makeupSku);
    if ($('z90_makeup_qty')) $('z90_makeup_qty').value = String(stats.makeupQty);
    if ($('z90_non_sku')) $('z90_non_sku').value = String(stats.nonSku);
    if ($('z90_non_qty')) $('z90_non_qty').value = String(stats.nonQty);
    updateTotals();

    setResult(
      'z90_paste_result',
      'success',
      `已填入：MAKE UP ${fmtInt(stats.makeupSku)}／${fmtQty(stats.makeupQty)}、Non-MAKE UP ${fmtInt(stats.nonSku)}／${fmtQty(stats.nonQty)}；總數 ${fmtInt(parsed.totals.sku)}／${fmtQty(parsed.totals.qty)} 已核對。`,
    );
    input.value = '';

    // 未填的必填欄（日期／店數）直接聚焦，減少一次手動搵位
    if (!$('z90_date')?.value) $('z90_date')?.focus();
    else if (!$('z90_shops')?.value) $('z90_shops')?.focus();
  }

  function updateTotals() {
    const el = $('z90_form_totals');
    if (!el) return;
    const makeupSku = num(($('z90_makeup_sku') || {}).value);
    const nonSku = num(($('z90_non_sku') || {}).value);
    const makeupQty = num(($('z90_makeup_qty') || {}).value);
    const nonQty = num(($('z90_non_qty') || {}).value);
    const skuTotal = makeupSku !== null && nonSku !== null ? makeupSku + nonSku : null;
    const qtyTotal = makeupQty !== null && nonQty !== null ? makeupQty + nonQty : null;
    el.textContent = `合計：SKU ${skuTotal === null ? '—' : fmtInt(skuTotal)} ・存貨量 ${qtyTotal === null ? '—' : fmtQty(qtyTotal)}`;
  }

  function clearForm() {
    ['z90_shops', 'z90_makeup_sku', 'z90_makeup_qty', 'z90_non_sku', 'z90_non_qty', 'z90_note', 'z90_paste'].forEach((id) => {
      const el = $(id);
      if (el) el.value = '';
    });
    const date = $('z90_date');
    if (date) date.value = hkToday();
    setResult('z90_save_result', 'info', '');
    setResult('z90_paste_result', 'info', '');
    updateTotals();
    document.querySelectorAll('#z90_table_body tr.is-editing').forEach((tr) => tr.classList.remove('is-editing'));
  }

  function fillForm(row) {
    if (!row) return;
    const values = {
      z90_date: row.report_date,
      z90_shops: row.shop_count,
      z90_makeup_sku: row.makeup_sku,
      z90_makeup_qty: row.makeup_qty_cm,
      z90_non_sku: row.non_makeup_sku,
      z90_non_qty: row.non_makeup_qty_cm,
      z90_note: row.note || '',
    };
    Object.keys(values).forEach((id) => {
      const el = $(id);
      if (el) el.value = values[id] == null ? '' : String(values[id]);
    });
    updateTotals();
    setResult('z90_save_result', 'info', `已載入 ${row.report_date} 的數字，修改後再儲存即覆蓋該期。`);
    document.querySelectorAll('#z90_table_body tr.is-editing').forEach((tr) => tr.classList.remove('is-editing'));
    const tr = document.querySelector(`#z90_table_body tr[data-z90-row="${row.report_date}"]`);
    if (tr) tr.classList.add('is-editing');
    $('z90_form_card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('z90_date')?.focus({ preventScroll: true });
  }

  function readForm() {
    const date = String(($('z90_date') || {}).value || '').trim();
    const shops = String(($('z90_shops') || {}).value || '').trim();
    const makeupSku = String(($('z90_makeup_sku') || {}).value || '').trim();
    const makeupQty = String(($('z90_makeup_qty') || {}).value || '').trim();
    const nonSku = String(($('z90_non_sku') || {}).value || '').trim();
    const nonQty = String(($('z90_non_qty') || {}).value || '').trim();
    const note = String(($('z90_note') || {}).value || '').trim();

    if (!date) return { error: '請填報表日期' };
    const fields = [
      [shops, '店數'],
      [makeupSku, 'MAKE UP SKU 數'],
      [makeupQty, 'MAKE UP 存貨量'],
      [nonSku, 'Non-MAKE UP SKU 數'],
      [nonQty, 'Non-MAKE UP 存貨量'],
    ];
    for (const [value, label] of fields) {
      if (value === '') return { error: `請填${label}` };
      const n = Number(value.replace(/,/g, ''));
      if (!Number.isFinite(n) || n < 0) return { error: `${label}應為 0 或以上的數字` };
    }
    const ints = [shops, makeupSku, nonSku];
    for (const value of ints) {
      if (!Number.isInteger(Number(value))) return { error: '店數與 SKU 數必須是整數' };
    }

    return {
      payload: {
        report_date: date,
        shop_count: shops,
        makeup_sku: makeupSku,
        makeup_qty_cm: makeupQty,
        non_makeup_sku: nonSku,
        non_makeup_qty_cm: nonQty,
        note,
      },
    };
  }

  async function save() {
    const parsed = readForm();
    if (parsed.error) {
      setResult('z90_save_result', 'error', parsed.error);
      return;
    }
    const btn = $('btn_z90_save');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
    try {
      const data = await aFetch('/api/admin/stock/zero90', {
        method: 'POST',
        body: JSON.stringify(parsed.payload),
      });
      const row = data && data.row;
      if (row) {
        setResult(
          'z90_save_result',
          'success',
          `已儲存 ${row.report_date}：SKU ${fmtInt(row.sku_total)}、存貨量 ${fmtQty(row.qty_total)}（${row.shop_count} 間店）。`,
        );
      } else {
        setResult('z90_save_result', 'success', '已儲存。');
      }
      await load();
      document.querySelectorAll('#z90_table_body tr.is-editing').forEach((tr) => tr.classList.remove('is-editing'));
      const tr = row ? document.querySelector(`#z90_table_body tr[data-z90-row="${row.report_date}"]`) : null;
      if (tr) tr.classList.add('is-editing');
    } catch (err) {
      setResult('z90_save_result', 'error', err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || '儲存（新增／覆蓋同日）'; }
    }
  }

  async function remove(reportDate) {
    if (!window.confirm(`確定刪除 ${reportDate} 的統計？刪除後不能復原，此操作會寫入審計日誌。`)) return;
    try {
      await aFetch(`/api/admin/stock/zero90/${encodeURIComponent(reportDate)}`, { method: 'DELETE' });
      setResult('z90_table_error', 'success', `已刪除 ${reportDate} 的統計。`);
      loaded = false;
      await load();
    } catch (err) {
      setResult('z90_table_error', 'error', err.message);
    }
  }

  /* ==================== 匯出 ==================== */

  async function downloadExcel(url, fallbackName, btnId, boxId, okMessage) {
    const btn = $(btnId);
    const box = $(boxId);
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '匯出中…'; }
    if (box) box.innerHTML = '';
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((data && data.error) || `匯出失敗 (${res.status})`);
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = match ? match[1] : fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      if (box) box.innerHTML = `<div class="alert alert-success mt-2 mb-0">${esc(okMessage)}</div>`;
    } catch (err) {
      if (box) box.innerHTML = `<div class="alert alert-danger mt-2 mb-0">${esc(err.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || '匯出 Excel'; }
    }
  }

  /* ==================== 事件 ==================== */

  function bindEvents() {
    const switchEl = $('stk_view_switch');
    if (switchEl) {
      switchEl.addEventListener('click', (event) => {
        const btn = event.target instanceof Element ? event.target.closest('[data-stk-view]') : null;
        if (!btn) return;
        setView(btn.dataset.stkView);
      });
    }

    const metricEl = $('z90_metric');
    if (metricEl) {
      metricEl.addEventListener('click', (event) => {
        const btn = event.target instanceof Element ? event.target.closest('[data-z90-metric]') : null;
        if (!btn) return;
        const next = METRICS[btn.dataset.z90Metric] ? btn.dataset.z90Metric : 'sku';
        if (next === metric) return;
        metric = next;
        metricEl.querySelectorAll('[data-z90-metric]').forEach((b) => {
          const active = b.dataset.z90Metric === metric;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-pressed', String(active));
        });
        try { localStorage.setItem(METRIC_KEY, metric); } catch { /* 私隱模式 */ }
        renderChart(summary ? summary.series : []);
      });
    }

    const rangeEl = $('z90_range');
    if (rangeEl) {
      rangeEl.addEventListener('click', (event) => {
        const btn = event.target instanceof Element ? event.target.closest('[data-z90-months]') : null;
        if (!btn) return;
        const next = Number(btn.dataset.z90Months);
        if (!MONTH_OPTIONS.includes(next) || next === months) return;
        months = next;
        rangeEl.querySelectorAll('[data-z90-months]').forEach((b) => {
          const active = Number(b.dataset.z90Months) === months;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-pressed', String(active));
        });
        try { localStorage.setItem(MONTHS_KEY, String(months)); } catch { /* 私隱模式 */ }
        renderChart(summary ? summary.series : []);
      });
    }

    const splitEl = $('z90_split');
    if (splitEl) {
      splitEl.addEventListener('change', () => {
        split = !!splitEl.checked;
        try { localStorage.setItem(SPLIT_KEY, split ? '1' : '0'); } catch { /* 私隱模式 */ }
        renderChart(summary ? summary.series : []);
      });
    }

    ['z90_makeup_sku', 'z90_non_sku', 'z90_makeup_qty', 'z90_non_qty'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', updateTotals);
    });

    const form = $('z90_form_card');
    if (form) {
      // 在表單內按 Enter 直接儲存（備註欄除外，避免打字時誤觸）
      form.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const target = event.target;
        if (target instanceof HTMLElement && target.tagName === 'INPUT' && target.id !== 'z90_note') {
          event.preventDefault();
          void save();
        }
      });
    }

    $('btn_z90_save')?.addEventListener('click', () => { void save(); });
    $('btn_z90_clear')?.addEventListener('click', clearForm);

    // Excel 貼上：按鈕或直接貼（paste 事件要等瀏覽器寫入 value 才讀）
    const pasteBtn = $('btn_z90_paste');
    if (pasteBtn) pasteBtn.addEventListener('click', applyPaste);
    const pasteEl = $('z90_paste');
    if (pasteEl) {
      pasteEl.addEventListener('paste', () => { setTimeout(applyPaste, 0); });
      pasteEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          applyPaste();
        }
      });
    }
    $('btn_z90_refresh')?.addEventListener('click', () => {
      setResult('z90_table_error', 'info', '');
      void load();
    });
    $('btn_z90_export')?.addEventListener('click', () => {
      void downloadExcel(
        '/api/admin/stock/zero90/export',
        'Zero_Sales_90D.xlsx',
        'btn_z90_export',
        'z90_export_result',
        '已匯出全部期數（工作簿含「90日0銷售」與「PPT 圖表用」兩張表）。',
      );
    });

    const body = $('z90_table_body');
    if (body) {
      body.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const editBtn = target.closest('[data-z90-edit]');
        if (editBtn) {
          const date = editBtn.getAttribute('data-z90-edit');
          const row = summary && summary.series ? summary.series.find((item) => item.report_date === date) : null;
          if (row) fillForm(row);
          return;
        }
        const deleteBtn = target.closest('[data-z90-delete]');
        if (deleteBtn) {
          const date = deleteBtn.getAttribute('data-z90-delete');
          if (date) void remove(date);
        }
      });
    }
  }

  /* ==================== 啟動 ==================== */

  function init() {
    const panel = $('panel-stock');
    const zEl = $('stk_view_zero90');
    if (!panel || !zEl) return;

    // 記住的顯示方式（預設 I14 存貨；唔會因為記住咗就自動打 API）
    try {
      if (localStorage.getItem(VIEW_KEY) === 'zero90') setView('zero90', { load: false });
    } catch { /* 私隱模式 */ }
    try {
      const saved = localStorage.getItem(METRIC_KEY);
      if (saved && METRICS[saved]) metric = saved;
      split = localStorage.getItem(SPLIT_KEY) === '1';
      const savedMonths = Number(localStorage.getItem(MONTHS_KEY));
      if (MONTH_OPTIONS.includes(savedMonths)) months = savedMonths;
    } catch { /* 私隱模式 */ }
    const splitEl = $('z90_split');
    if (splitEl) splitEl.checked = split;
    const rangeEl = $('z90_range');
    if (rangeEl) {
      rangeEl.querySelectorAll('[data-z90-months]').forEach((btn) => {
        const active = Number(btn.dataset.z90Months) === months;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
    }
    const metricEl = $('z90_metric');
    if (metricEl) {
      metricEl.querySelectorAll('[data-z90-metric]').forEach((btn) => {
        const active = btn.dataset.z90Metric === metric;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
    }

    const date = $('z90_date');
    if (date && !date.value) date.value = hkToday();
    updateTotals();
    bindEvents();

    // 只會在真正顯示時才載入（分頁隱藏 / 未切到存貨 tab 都不會打 API）
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            ensureLoaded();
            io.disconnect();
          }
        });
      }, { rootMargin: '400px 0px' });
      io.observe(zEl);
    }

    // 供「立即更新」或其他模組呼叫
    globalThis.__z90Refresh = () => {
      if (currentView() === 'zero90') void load();
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
