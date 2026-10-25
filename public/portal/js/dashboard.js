/* Store 存貨走勢（唯讀；後端以登入店舖強制過濾，前端不會也無法查別店數據） */
(() => {
  const $ = (id) => document.getElementById(id);
  const p = window.portal;
  const COLOR_SELF = '#0f5c9c';
  const COLOR_COMPANY = '#94a3b8';
  /** 趨勢圖顯示最近幾個月（店舖端固定 12 個月） */
  const CHART_MONTHS = 12;

  let loading = false;
  let currentSite = '';

  /** 'YYYY-MM-DD' 往前推 n 個月；月底自動夾到該月最後一日 */
  function monthsBefore(dateStr, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
    if (!m) return '';
    const target = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 - n, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(Number(m[3]), lastDay));
    const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(target.getUTCDate()).padStart(2, '0');
    return `${target.getUTCFullYear()}-${mm}-${dd}`;
  }

  /* ---------- 數值工具（PG numeric 可能以字串回傳） ---------- */

  function num(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function firstNum(list) {
    for (let i = 0; i < list.length; i += 1) {
      const n = num(list[i]);
      if (n !== null) return n;
    }
    return null;
  }

  function fmtMoney(value) {
    const n = num(value);
    if (n === null) return '—';
    return `$${Math.round(n).toLocaleString('en-US')}`;
  }

  function fmtRatio(value) {
    const n = num(value);
    if (n === null) return '—';
    // 後端 ratio 是 0–1 的小數（例如 0.083895），顯示時才乘 100
    return `${(n * 100).toFixed(2)}%`;
  }

  function fmtPt(value) {
    const n = num(value);
    if (n === null) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}pt`;
  }

  function wowClass(value) {
    const n = num(value);
    if (n === null) return '';
    if (n > 0.0001) return 'dash-worse';
    if (n < -0.0001) return 'dash-better';
    return '';
  }

  function wowArrow(value) {
    const n = num(value);
    if (n === null) return '';
    if (n > 0.0001) return '▲ ';
    if (n < -0.0001) return '▼ ';
    return '＝ ';
  }

  function dashDate(value) {
    const s = String(value == null ? '' : value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return `${s.slice(5, 7)}/${s.slice(8, 10)}`;
  }

  function kindLabel(kind) {
    if (kind === 'month_end') return '月結';
    if (kind === 'ad_hoc') return '臨時';
    return '週更';
  }

  /** 依 report_date 升序排好的原始 rows（保留全部欄位，KPI 要用）。 */
  function sortedRows(list) {
    return (Array.isArray(list) ? list.slice() : [])
      .filter((row) => row && row.report_date)
      .sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));
  }

  function toPoints(rows) {
    return rows.map((row) => ({ date: row.report_date, value: num(row.ratio) }));
  }

  /* ---------- 畫面 ---------- */

  function showError(message, type) {
    p.showAlert($('dash_error'), type || 'error', p.escapeHtml(message));
  }

  function clearError() {
    const box = $('dash_error');
    if (box) box.innerHTML = '';
  }

  function kpiCard(label, value, sub, tone) {
    return `<div class="dash-kpi">
      <div class="dash-kpi-value ${tone || ''}">${value}</div>
      <div class="dash-kpi-label">${label}</div>
      ${sub ? `<div class="dash-kpi-sub">${sub}</div>` : ''}
    </div>`;
  }

  function renderEmpty(title, text) {
    const card = $('dash_empty_card');
    if (card) card.hidden = false;
    const titleEl = $('dash_empty_title');
    if (titleEl) titleEl.textContent = title;
    const textEl = $('dash_empty_text');
    if (textEl) textEl.textContent = text;
    const kpi = $('dash_kpi');
    if (kpi) kpi.innerHTML = '';
    const chartCard = $('dash_chart_card');
    if (chartCard) chartCard.hidden = true;
  }

  function showSections() {
    const empty = $('dash_empty_card');
    if (empty) empty.hidden = true;
    const chartCard = $('dash_chart_card');
    if (chartCard) chartCard.hidden = false;
  }

  function renderSiteInfo(site, lastRow) {
    // 合併頁用 dash_site_info（避免與零銷售頁的 site_info 撞 id）；獨立頁仍可用 site_info
    const box = $('dash_site_info') || $('site_info');
    if (!box) return;
    const date = lastRow ? String(lastRow.report_date).slice(0, 10) : '';
    box.innerHTML = `<div class="dash-site-code">店舖 Site Code：<b>${p.escapeHtml(site)}</b></div>`
      + `<div class="hint">${date
        ? `最新一期：<b>${p.escapeHtml(date)}</b>（${p.escapeHtml(lastRow.report_kind_label || kindLabel(lastRow.report_kind))}）`
        : '尚未有存貨報表'}</div>`;
  }

  function renderKpi(data, rows) {
    const wrap = $('dash_kpi');
    if (!wrap) return;
    const last = rows.length ? rows[rows.length - 1] : null;
    const prev = rows.length > 1 ? rows[rows.length - 2] : null;
    const kpi = data.kpi || {};
    const soh = firstNum([
      kpi.total_soh, kpi.shop_stock_value, kpi.shop_stock_value_cm, kpi.soh, kpi.latest_soh,
      last && last.total_soh, last && last.shop_stock_value,
    ]);
    const excess = firstNum([
      kpi.total_excess, kpi.deadstock_value, kpi.excess_value, kpi.excess_value_0sale, kpi.latest_excess,
      last && last.total_excess, last && last.deadstock_value,
    ]);
    const ratio = firstNum([kpi.ratio, kpi.latest_ratio, last && last.ratio]);
    const prevRatio = prev ? num(prev.ratio) : null;
    const wow = firstNum([kpi.wow_delta_pt, kpi.wow, last && last.wow_delta_pt])
      ?? (ratio !== null && prevRatio !== null ? ratio - prevRatio : null);
    const dateLabel = last ? `${dashDate(last.report_date)} 期` : '';
    const zeroDivide = ratio === null && soh !== null && Math.abs(soh) < 0.005;

    wrap.innerHTML = [
      kpiCard('店舖存貨值（CM）', fmtMoney(soh), dateLabel),
      kpiCard('不良存貨值（P90D 0 Sales）', fmtMoney(excess), dateLabel),
      kpiCard('不良存貨佔比', zeroDivide ? '—' : fmtRatio(ratio),
        zeroDivide ? '店舖存貨值為 0，佔比不適用'
          : (wow === null ? '需要至少 2 期資料才有 WoW' : `${wowArrow(wow)}${fmtPt(wow)}　較上一期`),
        wowClass(wow)),
    ].join('');
  }

  function renderChart(points, companyPoints, companyAvg) {
    const el = $('dash_chart');
    const note = $('dash_chart_note');
    const period = $('dash_chart_period');
    if (!el) return;
    if (note) note.textContent = '';
    if (period) period.textContent = '';

    // 只畫最近 12 個月：資料永久保留，但店舖端一條幾年的線反而讀不到走勢
    const latest = [].concat(points, companyPoints)
      .map((row) => String(row.date || '').slice(0, 10))
      .filter(Boolean)
      .sort()
      .pop() || '';
    const cutoff = latest ? monthsBefore(latest, CHART_MONTHS) : '';
    if (cutoff) {
      points = points.filter((row) => String(row.date || '').slice(0, 10) >= cutoff);
      companyPoints = companyPoints.filter((row) => String(row.date || '').slice(0, 10) >= cutoff);
    }

    const usable = points.filter((row) => row.value !== null);
    const companyUsable = companyPoints.filter((row) => row.value !== null);
    const chartApi = globalThis.ChartLite;

    if (!usable.length) {
      if (chartApi) chartApi.clear(el); else el.innerHTML = '';
      renderEmpty('本週未收到此店數據', 'RP Team 在最新的 I14「By Shop」報表未見到你的店舖（或該期店舖存貨值為 0），所以暫時沒有佔比可以顯示。下週報表上載後會自動更新；如有疑問請聯絡 RP Team。');
      return;
    }

    if (usable.length === 1) {
      // 只有 1 期：不畫折線（單點不構成走勢），只給文字說明
      if (chartApi) chartApi.clear(el); else el.innerHTML = '';
      el.innerHTML = '<div class="ct-empty">目前只有 1 期資料，下週上載後會顯示走勢。</div>';
      if (period) period.textContent = String(usable[0].date).slice(0, 10);
      if (note) {
        note.textContent = `本期佔比 ${fmtRatio(usable[0].value)}`
          + (companyAvg !== null ? `；全公司合計（加權）${fmtRatio(companyAvg)}。` : '。');
      }
      return;
    }

    if (!chartApi) {
      el.innerHTML = '<div class="ct-empty">圖表元件未載入，請重新整理頁面。</div>';
      return;
    }

    if (period) {
      period.textContent = `${String(usable[0].date).slice(0, 10)} 至 ${String(usable[usable.length - 1].date).slice(0, 10)}，共 ${usable.length} 期`;
    }

    const chartSeries = [{
      key: 'shop',
      label: '本店佔比',
      color: COLOR_SELF,
      points,
    }];
    if (companyUsable.length) {
      chartSeries.push({
        key: 'company',
        label: '全公司合計(加權)',
        color: COLOR_COMPANY,
        dashed: true,
        points: companyPoints,
      });
    }

    chartApi.renderLine(el, {
      series: chartSeries,
      height: 240,
      emptyText: '暫無佔比數據',
      yFormat: (v) => `${(Number(v) * 100).toFixed(1)}%`,
      tipFormat: (v) => fmtRatio(v),
      ariaLabel: `本店不良存貨佔比趨勢，共 ${usable.length} 期，最新 ${fmtRatio(usable[usable.length - 1].value)}`,
    });

    const gaps = points.length - usable.length;
    const parts = [];
    if (gaps) parts.push(`有 ${gaps} 期店舖存貨值為 0（除零），該期斷線，不會當成 0%。`);
    parts.push('點或懸停圖表可看該期數值。');
    if (note) note.textContent = parts.join('');
  }

  /* ---------- 載入 ---------- */

  async function load(site) {
    if (loading) return;
    loading = true;
    clearError();
    try {
      const data = (await p.api('/api/portal/stock/summary')) || {};
      const rows = sortedRows(data.series);
      const companyRows = sortedRows(data.company_series);
      const lastRow = rows.length ? rows[rows.length - 1] : null;
      renderSiteInfo(site, lastRow);

      if (!rows.length) {
        renderEmpty('本週未收到此店數據',
          data.has_data === false
            ? 'RP Team 尚未在 I14「By Shop」報表見到你的店舖，因此暫時沒有存貨數據。下週報表上載後會自動顯示；如有疑問請聯絡 RP Team。'
            : '系統暫時沒有你店舖的存貨數據，下週報表上載後會自動顯示。');
        return;
      }

      showSections();
      renderKpi(data, rows);
      renderChart(toPoints(rows), toPoints(companyRows), firstNum([data.company_avg_ratio]));
      if (data.has_data === false) {
        showError('最新一期報表未見到你的店舖（圖表顯示的是之前期數）。', 'warning');
      }
    } catch (err) {
      if (err && err.status === 401) return; // portalApi 已導向登入
      showError(err && err.message ? err.message : '載入失敗');
      const kpi = $('dash_kpi');
      if (kpi) kpi.innerHTML = '<div class="dash-kpi"><div class="dash-kpi-value">—</div><div class="dash-kpi-label">未能載入數據</div><div class="dash-kpi-sub">可切換分頁或重新載入頁面再試</div></div>';
      const chart = $('dash_chart');
      if (chart) chart.innerHTML = '<div class="ct-empty">未能載入走勢圖，請重新載入頁面。</div>';
    } finally {
      loading = false;
    }
  }

  /* ---------- 啟動 ---------- */

  const standalone = !$('panel_stock');
  // 合併頁的登出由 zero-sales.js 綁定；避免同一下點擊觸發兩次
  const logout = $('logout_link');
  if (logout && standalone) logout.addEventListener('click', (e) => { e.preventDefault(); p.logout(); });

  let started = false;
  let starting = null;

  /**
   * 首次載入（合併頁由 portal-tabs.js 在切到「存貨走勢」時呼叫，確保面板已可見、
   * 圖表量得到闊度）。重複呼叫不會重複請求。
   */
  async function start() {
    if (started) return;
    if (starting) return starting;
    starting = (async () => {
      let site;
      try {
        site = await p.ensureStoreSite();
      } catch {
        return; // 由現有 gate / 角色導向處理
      }
      currentSite = site;
      // 合併頁的分頁籤會自己管副標題，避免兩個 script 互相覆蓋
      if (standalone && $('store_header')) $('store_header').textContent = `存貨走勢 — ${site}`;
      await load(site);
      started = true;
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  document.addEventListener('portal:tab', (e) => {
    const tab = e && e.detail ? e.detail.tab : '';
    if (tab !== 'stock') return;
    // 首次 → 完整載入；之後每次切回來都重新抓一次，確保看到最新一期（無需手動按鈕）
    if (started) load(currentSite);
    else start();
  });

  // 獨立頁（沒有分頁籤）或面板本來就可見時立即載入；否則等分頁籤通知。
  const panel = $('panel_stock');
  if (standalone || !panel || !panel.hidden) start();
})();
