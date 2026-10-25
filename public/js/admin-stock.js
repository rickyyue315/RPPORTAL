/* Admin 存貨 Dashboard（獨立於 admin.js / admin-zero-sales.js：自有 CSRF / fetch / esc，
   所有 DOM id 以 stk_ 為前綴，不與現有頁面任何 id 或狀態衝突） */
(() => {
  const $ = (id) => document.getElementById(id);

  /* report_kind 的權威值（migration 的 CHECK）：weekly / month_end / ad_hoc，不要用別名 */
  const KIND_LABELS = { weekly: '週更', month_end: '月結', ad_hoc: '臨時' };
  const BATCH_PAGE_KEY = 'ndrf_admin_stock_batch_page_size';
  const WEEK_PAGE_KEY = 'ndrf_admin_stock_week_page_size';
  const COLOR_MAIN = '#0f5c9c';
  const COLOR_REF = '#94a3b8';

  let csrf = null;
  let started = false;
  let summaryCache = null;
  let batchPage = 1;
  let selectedWeek = '';
  let weekRows = [];
  let weekTotals = null;
  let weekPage = 1;
  let autoDate = '';

  /* ==================== 網絡 ==================== */

  async function getCsrf() {
    if (!csrf) {
      const res = await fetch('/api/csrf', { credentials: 'same-origin' });
      const data = await res.json().catch(() => null);
      csrf = data && data.token;
    }
    return csrf;
  }

  /** 帶 CSRF 的請求；失敗時拋出 Error（附 status / data，方便分辨 409 DATE_CONFLICT）。 */
  async function aFetch(url, opts = {}) {
    const token = await getCsrf();
    const headers = { ...(opts.headers || {}) };
    if (token) headers['x-csrf-token'] = token;
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || `請求失敗 (${res.status})`);
      err.status = res.status;
      err.data = data;
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

  /** 屬性值用：esc() 不處理引號，插入 value="…" 時要額外跳脫，避免備註含 " 破壞屬性。 */
  function escAttr(value) {
    return esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** PG numeric 會以字串回傳，一律經此轉換；缺失／非數字回 null（不是 0）。 */
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

  function fmtInt(value) {
    const n = num(value);
    if (n === null) return '—';
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtMoney(value) {
    const n = num(value);
    if (n === null) return '—';
    return `$${fmtInt(n)}`;
  }

  function fmtRatio(value) {
    const n = num(value);
    if (n === null) return '—';
    return `${n.toFixed(2)}%`;
  }

  function fmtPt(value) {
    const n = num(value);
    if (n === null) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}pt`;
  }

  function wowClass(value) {
    const n = num(value);
    if (n === null) return 'text-secondary';
    if (n > 0.0001) return 'text-danger';
    if (n < -0.0001) return 'text-success';
    return 'text-secondary';
  }

  function wowArrow(value) {
    const n = num(value);
    if (n === null) return '';
    if (n > 0.0001) return '▲ ';
    if (n < -0.0001) return '▼ ';
    return '＝ ';
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || kind || '—';
  }

  function shortShop(name) {
    const s = String(name || '');
    return s.length > 16 ? `${s.slice(0, 16)}…` : s;
  }

  function setResult(id, type, message) {
    const el = $(id);
    if (!el) return;
    if (!message) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="alert ${alertClass(type)}">${esc(message)}</div>`;
  }

  function setResultHtml(id, type, html) {
    const el = $(id);
    if (!el) return;
    if (!html) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="alert ${alertClass(type)}">${html}</div>`;
  }

  function alertClass(type) {
    if (type === 'error') return 'alert-danger';
    if (type === 'success') return 'alert-success';
    if (type === 'warning') return 'alert-warning';
    return 'alert-info';
  }

  /* ==================== 彈窗（自行管理，不碰現有 #export_confirm_overlay） ==================== */

  function applyModalFallback(overlay) {
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,.45)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '1056';
    overlay.style.padding = '16px';
    const box = overlay.querySelector('.modal-box');
    if (box) {
      box.style.background = '#fff';
      box.style.borderRadius = '12px';
      box.style.padding = '26px';
      box.style.maxWidth = '460px';
      box.style.width = '100%';
      box.style.boxShadow = '0 10px 30px rgba(0,0,0,.25)';
      box.style.maxHeight = 'calc(100vh - 48px)';
      box.style.overflowY = 'auto';
      box.style.boxSizing = 'border-box';
    }
  }

  /**
   * 通用彈窗。onOk 回傳 false 表示「留在彈窗」（例如日期衝突），其餘值代表完成。
   * 沒有 onOk = 純確認（true / null）。
   */
  function openDialog({ title, bodyHtml, okLabel = '確認', cancelLabel = '取消', danger = false, onOk }) {
    return new Promise((resolve) => {
      let settled = false;
      const overlay = document.createElement('div');
      overlay.className = 'stk-overlay';
      overlay.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-label="${escAttr(title)}">
        <h3 class="${danger ? 'text-danger' : ''}">${esc(title)}</h3>
        <div class="stk-dialog-body">${bodyHtml || ''}</div>
        <div id="stk_dialog_error" class="text-danger small mt-2"></div>
        <div class="d-flex gap-2 justify-content-end mt-4">
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-ok>${esc(okLabel)}</button>
          <button class="btn" type="button" data-cancel>${esc(cancelLabel)}</button>
        </div></div>`;
      document.body.appendChild(overlay);
      applyModalFallback(overlay);
      document.body.classList.add('stk-modal-open');

      const okBtn = overlay.querySelector('[data-ok]');
      const cancelBtn = overlay.querySelector('[data-cancel]');
      const errBox = overlay.querySelector('#stk_dialog_error');
      const focusEl = overlay.querySelector('input, select, textarea') || cancelBtn;

      const close = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        if (!document.querySelector('.stk-overlay')) document.body.classList.remove('stk-modal-open');
        resolve(value);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
      cancelBtn.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey);
      okBtn.addEventListener('click', async () => {
        errBox.textContent = '';
        if (!onOk) { close(true); return; }
        const original = okBtn.textContent;
        okBtn.disabled = true;
        okBtn.textContent = '處理中…';
        try {
          if (typeof onOk === 'function') {
            const value = await onOk(overlay, (msg) => { errBox.textContent = msg; });
            if (value === false) return;
            close(value === undefined ? true : value);
            return;
          }
          close(true);
        } catch (err) {
          errBox.textContent = (err && err.message) || '操作失敗';
        } finally {
          okBtn.disabled = false;
          okBtn.textContent = original;
        }
      });
      focusEl.focus();
    });
  }

  function confirmStk(title, lines, okLabel, danger = true) {
    const body = (lines || []).map((line) => `<p class="text-secondary small" style="margin:6px 0">${esc(line)}</p>`).join('');
    return openDialog({ title, bodyHtml: body, okLabel: okLabel || '確認', danger });
  }

  /* ==================== 檔名日期偵測（pre-fill 報表日期，可手改） ==================== */

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function isoOf(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return '';
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }

  /** '23Oct2026' / '23-Oct-2026' / '2026-10-23' / '23102026' / 'By Shop_25Oct2026.xlsx' → 'YYYY-MM-DD' */
  function dateFromFileName(name) {
    const s = String(name || '');
    if (!s) return '';
    let m = /(\d{1,2})[\s_-]?([A-Za-z]{3})[A-Za-z]*[\s_-]?(\d{4})/.exec(s);
    if (m) {
      const day = Number(m[1]);
      const month = MONTHS[m[2].toLowerCase()];
      const year = Number(m[3]);
      if (month) {
        const iso = isoOf(year, month, day);
        if (iso) return iso;
      }
    }
    m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) {
      const iso = isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
      if (iso) return iso;
    }
    m = /(?:^|\D)(\d{2})(\d{2})(\d{4})(?:\D|$)/.exec(s);
    if (m) {
      const iso = isoOf(Number(m[3]), Number(m[2]), Number(m[1]));
      if (iso) return iso;
    }
    return '';
  }

  function setDateHint(html) {
    const el = $('stk_date_hint');
    if (el) el.innerHTML = html;
  }

  function syncDateHint() {
    const dateEl = $('stk_date');
    const value = dateEl ? dateEl.value : '';
    if (!value) {
      setDateHint('檔名含 <code>23Oct2026</code> 這類日期會自動填入報表日期（可再手改）');
      return;
    }
    const kind = $('stk_kind') ? $('stk_kind').value : 'weekly';
    setDateHint(`報表日期：<b>${esc(value)}</b>｜類型：<b>${esc(kindLabel(kind))}</b>。同一日期再上載會直接取代舊批次。`);
  }

  /* ==================== 上載 ==================== */

  async function upload() {
    const fileEl = $('stk_file');
    const dateEl = $('stk_date');
    const kindEl = $('stk_kind');
    const noteEl = $('stk_note');
    const btn = $('btn_stk_upload');
    const file = fileEl && fileEl.files && fileEl.files[0];
    const reportDate = (dateEl && dateEl.value ? dateEl.value : '').trim();

    if (!file) { setResult('stk_upload_result', 'error', '請選擇 Excel 檔案（.xlsx）。'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) { setResult('stk_upload_result', 'error', '請先選擇報表日期（檔名有日期會自動填入，可手改）。'); return; }

    const form = new FormData();
    form.append('file', file);
    form.append('report_date', reportDate);
    form.append('report_kind', (kindEl && kindEl.value) || 'weekly');
    form.append('note', (noteEl && noteEl.value ? noteEl.value : '').trim());

    if (btn) { btn.disabled = true; btn.textContent = '上載中…'; }
    setResultHtml('stk_upload_result', 'info', '上載及解析中，請稍候…');
    try {
      const data = (await aFetch('/api/admin/stock/batches', { method: 'POST', body: form })) || {};
      renderUploadResult(data, reportDate);
      if (fileEl) fileEl.value = '';
      if (noteEl) noteEl.value = '';
      selectedWeek = reportDate;
      weekPage = 1;
      batchPage = 1;
      await refreshAll();
    } catch (err) {
      setResult('stk_upload_result', 'error', err.message || '上載失敗');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '上載並取代同日批次'; }
    }
  }

  function renderUploadResult(data, reportDate) {
    const batch = data.batch || {};
    const skipped = data.skipped || {};
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    const unknown = Array.isArray(data.unknown_sites) ? data.unknown_sites : [];
    const rows = firstNum([batch.row_count, data.row_count]);
    const stores = firstNum([batch.store_count, data.store_count]);
    const skippedTotal = firstNum([skipped.total]);

    const parts = [];
    parts.push(`已上載 <b>${esc(batch.report_date || reportDate)}</b>（${esc(batch.report_kind_label || kindLabel(batch.report_kind || ($('stk_kind') || {}).value))}）`);
    if (stores !== null) parts.push(`<b>${fmtInt(stores)}</b> 間店`);
    if (rows !== null) parts.push(`<b>${fmtInt(rows)}</b> 行`);
    if (data.replaced) parts.push('已取代同日期舊批次');
    if (skippedTotal) {
      const detail = [];
      if (num(skipped.total)) detail.push(`Total 合計 ${fmtInt(skipped.total)}`);
      if (num(skipped.blank)) detail.push(`空白 ${fmtInt(skipped.blank)}`);
      if (num(skipped.footer)) detail.push(`頁腳 ${fmtInt(skipped.footer)}`);
      parts.push(`略過 ${fmtInt(skippedTotal)} 列${detail.length ? `（${detail.join('、')}）` : ''}`);
    }
    setResultHtml('stk_upload_result', unknown.length || warnings.length ? 'warning' : 'success', `${parts.join('，')}。`);

    const extra = [];
    if (warnings.length) extra.push(warnings.join('；'));
    if (unknown.length) {
      const list = unknown.slice(0, 20).map((s) => esc(String(s))).join('、');
      extra.push(`以下 ${unknown.length} 個 Site Code 不在門店主檔，已照樣入庫但不會對應店舖帳戶：${list}${unknown.length > 20 ? ' 等' : ''}`);
    }
    if (extra.length) {
      setResultHtml('stk_batch_error', 'warning', extra.map((t) => `<div>${t}</div>`).join(''));
    } else {
      setResult('stk_batch_error', 'info', '');
    }
  }

  /* ==================== 摘要 / KPI / 趨勢 ==================== */

  function normalizedSeries(data) {
    const list = Array.isArray(data && data.series) ? data.series.slice() : [];
    return list
      .filter((row) => row && row.report_date)
      .sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));
  }

  function latestPoint() {
    const series = normalizedSeries(summaryCache);
    return series.length ? series[series.length - 1] : null;
  }

  async function loadSummary() {
    const note = $('stk_summary_note');
    try {
      const data = (await aFetch('/api/admin/stock/summary')) || {};
      summaryCache = data;
      const series = normalizedSeries(data);
      if (note) note.textContent = series.length ? `${series.length} 期資料` : '未上載任何報表';
      setResult('stk_kpi_error', 'info', '');
      renderKpi(data, series);
      renderChart(data, series);
      if (!selectedWeek) selectedWeek = series.length ? String(series[series.length - 1].report_date).slice(0, 10) : '';
    } catch (err) {
      summaryCache = null;
      if (note) note.textContent = '載入失敗';
      setResult('stk_kpi_error', 'error', `未能載入存貨摘要：${err.message}`);
      setResult('stk_chart_error', 'error', err.message);
      const kpi = $('stk_kpi');
      if (kpi) kpi.innerHTML = '<div class="stk-kpi stk-kpi--wide"><div class="stk-kpi-value">—</div><div class="stk-kpi-label">未能載入 KPI</div></div>';
    }
  }

  function kpiCard(label, value, sub, tone) {
    return `<div class="stk-kpi">
      <div class="stk-kpi-value ${tone || ''}">${value}</div>
      <div class="stk-kpi-label">${label}</div>
      ${sub ? `<div class="stk-kpi-sub">${sub}</div>` : ''}
    </div>`;
  }

  function renderKpi(data, series) {
    const wrap = $('stk_kpi');
    const note = $('stk_kpi_note');
    if (!wrap) return;
    if (!series.length) {
      wrap.innerHTML = '<div class="stk-kpi stk-kpi--wide"><div class="stk-kpi-value">—</div><div class="stk-kpi-label">尚未上載任何存貨報表</div><div class="stk-kpi-sub">用上方表單上載 I14「By Shop」Excel 後，這裡會顯示最新一期的 KPI。</div></div>';
      if (note) note.textContent = '—';
      return;
    }
    const last = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const kpi = (data && data.kpi) || {};
    const soh = firstNum([kpi.total_soh, kpi.shop_stock_value, kpi.soh, last.total_soh]);
    const excess = firstNum([kpi.total_excess, kpi.deadstock_value, kpi.excess_value, last.total_excess]);
    const ratio = firstNum([kpi.ratio, last.ratio]);
    const prevRatio = prev ? firstNum([prev.ratio]) : null;
    const wow = firstNum([kpi.wow_delta_pt, last.wow_delta_pt]) ?? (ratio !== null && prevRatio !== null ? ratio - prevRatio : null);
    const stores = firstNum([kpi.store_count, last.store_count]);

    const reportDate = String(kpi.report_date || last.report_date || '').slice(0, 10);
    const reportKind = kpi.report_kind_label || last.report_kind_label
      || kindLabel(kpi.report_kind || last.report_kind);
    const ratioZero = soh === 0 && ratio === null;

    wrap.innerHTML = [
      kpiCard('最新報表日期', esc(reportDate || '—'), esc(reportKind)),
      kpiCard('店舖存貨值合計', fmtMoney(soh), '') ,
      kpiCard('死存貨值（P90D 0 Sales）', fmtMoney(excess), ''),
      kpiCard('死存貨佔比', ratioZero ? '—' : fmtRatio(ratio),
        ratioZero ? '店舖存貨值為 0（除零），佔比不適用' : (prev ? `上期 ${fmtRatio(prevRatio)}` : '只有 1 期資料')),
      kpiCard('WoW 變化', `${wowArrow(wow)}${fmtPt(wow)}`, wow === null ? '需要至少 2 期資料' : '較上一期（百分點）', wowClass(wow)),
      kpiCard('涉及店數', stores === null ? '—' : fmtInt(stores), '')
    ].join('');

    if (note) {
      const avg = num(data && data.company_avg_ratio);
      note.textContent = avg === null
        ? `${series.length} 期資料`
        : `${series.length} 期資料｜全公司平均（加權）${fmtRatio(avg)}`;
    }
  }

  function renderChart(data, series) {
    const el = $('stk_chart');
    const legend = $('stk_legend');
    const chartNote = $('stk_chart_note');
    if (!el) return;
    setResult('stk_chart_error', 'info', '');
    if (chartNote) chartNote.textContent = '';

    const points = series.map((row) => ({
      date: row.report_date,
      value: num(row.ratio),
    }));
    const usable = points.filter((p) => p.value !== null);
    const chartApi = globalThis.ChartLite;

    if (!usable.length) {
      if (chartApi) chartApi.clear(el); else el.innerHTML = '';
      if (legend) legend.innerHTML = '';
      el.innerHTML = '<div class="ct-empty">' + (series.length
        ? '已有報表，但全部期數的店舖存貨值為 0（除零），暫時畫不出佔比走勢。'
        : '尚未上載任何存貨報表，趨勢圖會在第一次上載後出現。') + '</div>';
      return;
    }

    if (usable.length === 1) {
      if (chartApi) chartApi.clear(el); else el.innerHTML = '';
      if (legend) legend.innerHTML = '<span class="stk-legend-item"><i style="background:#0f5c9c"></i>死存貨佔比</span>';
      el.innerHTML = `<div class="ct-empty">目前只有 1 期資料（${esc(String(usable[0].date).slice(0, 10))} ${fmtRatio(usable[0].value)}），上載下一期後會顯示走勢。</div>`;
      return;
    }

    const avg = num(data && data.company_avg_ratio);
    const lastRatio = usable[usable.length - 1].value;
    const showAvg = avg !== null && Math.abs(avg - lastRatio) > 0.005;

    if (legend) {
      legend.innerHTML = '<span class="stk-legend-item"><i style="background:#0f5c9c"></i>死存貨佔比（加權）</span>'
        + (showAvg ? `<span class="stk-legend-item"><i class="stk-legend-dash" style="border-color:${COLOR_REF}"></i>全公司平均（加權）${fmtRatio(avg)}</span>` : '');
    }

    if (!chartApi) {
      el.innerHTML = '<div class="ct-empty">圖表元件未載入（/js/chart-lite.js），請重新整理頁面。</div>';
      return;
    }

    const chartSeries = [{
      key: 'ratio',
      label: '死存貨佔比',
      color: COLOR_MAIN,
      points,
    }];
    if (showAvg) {
      chartSeries.push({
        key: 'avg',
        label: '全公司平均（加權）',
        color: COLOR_REF,
        dashed: true,
        points: points.map((p) => ({ date: p.date, value: avg })),
      });
    }

    chartApi.renderLine(el, {
      series: chartSeries,
      height: 220,
      emptyText: '暫無佔比數據',
      yFormat: (v) => `${Number(v).toFixed(1)}%`,
      tipFormat: (v) => fmtRatio(v),
      ariaLabel: `死存貨佔比趨勢，共 ${usable.length} 期，最新 ${fmtRatio(lastRatio)}`,
    });

    const gaps = points.length - usable.length;
    if (chartNote) {
      chartNote.textContent = gaps
        ? `注意：有 ${gaps} 期店舖存貨值為 0（除零），該期不會連線（缺值斷線，不會當成 0%）。`
        : '點或懸停圖表可看該期數值；虛線為全公司平均參考，不屬於任何一期。';
    }
  }

  /* ==================== 批次列表 ==================== */

  function currentBatchPageSize() {
    const v = Number(($('stk_batch_page_size') || {}).value || 20);
    return [20, 50, 100].includes(v) ? v : 20;
  }

  function currentWeekPageSize() {
    const v = Number(($('stk_page_size') || {}).value || 20);
    return [20, 50, 100].includes(v) ? v : 20;
  }

  async function loadBatches() {
    const body = $('stk_batches_body');
    if (!body) return;
    try {
      const params = new URLSearchParams({ page: String(batchPage), size: String(currentBatchPageSize()) });
      const data = (await aFetch(`/api/admin/stock/batches?${params.toString()}`)) || {};
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const total = firstNum([data.total]) ?? rows.length;
      const size = currentBatchPageSize();
      const pages = Math.max(1, Math.ceil(total / size));
      if (batchPage > pages) { batchPage = pages; return loadBatches(); }

      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="9" class="text-center text-secondary">尚未上載任何批次</td></tr>';
      } else {
        body.innerHTML = rows.map((row) => {
          const date = String(row.report_date || '').slice(0, 10);
          const isCurrent = date === selectedWeek;
          const storeCount = firstNum([row.store_count]);
          const rowCount = firstNum([row.row_count]);
          return `<tr class="${isCurrent ? 'row-selected' : ''}">
            <td><b>${esc(date)}</b>${isCurrent ? '<div class="text-secondary small">明細顯示中</div>' : ''}</td>
            <td>${esc(row.report_kind_label || kindLabel(row.report_kind))}</td>
            <td class="text-end">${storeCount === null ? '—' : fmtInt(storeCount)}</td>
            <td class="text-end">${rowCount === null ? '—' : fmtInt(rowCount)}</td>
            <td>${esc(row.note || '')}</td>
            <td>${esc(row.uploaded_by || '')}</td>
            <td class="text-nowrap">${esc(row.created_at || '')}</td>
            <td><code class="stk-hash">${esc(row.content_hash_short || '')}</code></td>
            <td><div class="d-flex gap-1 flex-wrap">
              <button class="btn btn-sm" type="button" data-stk-view="${escAttr(row.id)}" data-stk-date="${escAttr(date)}">明細</button>
              <button class="btn btn-sm btn-outline-primary" type="button" data-stk-edit="${escAttr(row.id)}" data-stk-date="${escAttr(date)}" data-stk-note="${escAttr(row.note || '')}">改日期／備註</button>
              <button class="btn btn-sm btn-outline-danger" type="button" data-stk-del="${escAttr(row.id)}" data-stk-date="${escAttr(date)}" data-stk-rows="${rowCount === null ? '' : rowCount}" data-stk-stores="${storeCount === null ? '' : storeCount}">刪除</button>
            </div></td>
          </tr>`;
        }).join('');
      }

      if (globalThis.AdminPager) {
        globalThis.AdminPager.render({
          nav: $('stk_batch_page_numbers'),
          range: $('stk_batch_page_range'),
          page: batchPage,
          total,
          pageSize: size,
          onPage: (page) => { batchPage = page; loadBatches(); },
          unit: '個批次',
        });
      }
    } catch (err) {
      body.innerHTML = `<tr><td colspan="9" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  async function deleteBatch(id, date, rowsParam, storesParam) {
    const rows = num(rowsParam);
    const stores = num(storesParam);
    const ok = await confirmStk('確認刪除整個批次？', [
      `報表日期：${date}`,
      `將刪除 ${stores === null ? '全部' : stores} 間店的 ${rows === null ? '全部' : rows} 行存貨快照。`,
      '此操作不可還原（會一併刪除該批次的每店快照），並會寫入審計日誌；刪除後 KPI、趨勢與明細即時重算。',
    ], '確認刪除');
    if (!ok) return;
    try {
      const data = (await aFetch(`/api/admin/stock/batches/${encodeURIComponent(id)}`, { method: 'DELETE' })) || {};
      const deletedRows = firstNum([data.deleted_rows]);
      const deletedStores = firstNum([data.deleted_stores]);
      setResult('stk_batch_error', 'success',
        `已刪除「${date}」批次（${deletedRows === null ? '—' : deletedRows} 行、${deletedStores === null ? '—' : deletedStores} 店）。`);
      if (selectedWeek === date) selectedWeek = '';
      weekPage = 1;
      batchPage = 1;
      await refreshAll();
    } catch (err) {
      setResult('stk_batch_error', 'error', err.message || '刪除失敗');
    }
  }

  async function editBatch(id, date, note) {
    const result = await openDialog({
      title: `修改批次「${date}」`,
      okLabel: '儲存',
      bodyHtml: `
        <div class="mb-2"><label class="form-label" for="stk_edit_date">報表日期</label>
          <input type="date" id="stk_edit_date" class="form-control" value="${escAttr(date)}"></div>
        <div class="mb-2"><label class="form-label" for="stk_edit_note">備註</label>
          <input type="text" id="stk_edit_note" class="form-control" maxlength="200" value="${escAttr(note || '')}" placeholder="例如 日期揀錯，已修正"></div>
        <p class="text-secondary small mb-0">改日期等於把這批快照移到另一日；如該日期已有批次會顯示衝突提示（可先刪除或以同日上載取代）。</p>`,
      onOk: async (overlay, setError) => {
        const dateEl = overlay.querySelector('#stk_edit_date');
        const noteEl = overlay.querySelector('#stk_edit_note');
        const nextDate = (dateEl ? dateEl.value : '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) { setError('請選擇有效的報表日期。'); return false; }
        try {
          await aFetch(`/api/admin/stock/batches/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ report_date: nextDate, note: (noteEl ? noteEl.value : '').trim() }),
          });
        } catch (err) {
          if (err.status === 409 || (err.data && err.data.code === 'DATE_CONFLICT')) {
            setError(`「${nextDate}」已經有批次，請先刪除該批次，或直接在該日期上載取代。`);
            return false;
          }
          throw err;
        }
        return nextDate;
      },
    });
    if (!result || result === true) return;
    setResult('stk_batch_error', 'success', result === date
      ? `已更新「${date}」批次的備註。`
      : `已把「${date}」改為「${result}」，KPI、趨勢及明細已重新計算。`);
    if (selectedWeek === date) selectedWeek = String(result);
    batchPage = 1;
    await refreshAll();
  }

  /* ==================== 每店明細（該期） ==================== */

  function filteredWeekRows() {
    const q = String((($('stk_q') || {}).value) || '').trim().toLowerCase();
    const only = (($('stk_only') || {}).value) || '';
    const sort = (($('stk_sort') || {}).value) || 'ratio_desc';

    let rows = weekRows.slice();
    if (q) {
      rows = rows.filter((r) => [r.site_code, r.shop, r.om].some((v) => String(v || '').toLowerCase().includes(q)));
    }
    if (only === 'worse') rows = rows.filter((r) => (num(r.wow_delta_pt) || 0) > 0.0001);
    if (only === 'better') rows = rows.filter((r) => (num(r.wow_delta_pt) || 0) < -0.0001);

    const pick = sort === 'excess_desc' ? (r) => num(r.deadstock_value)
      : sort === 'wow_desc' ? (r) => num(r.wow_delta_pt)
        : (r) => num(r.ratio);
    rows.sort((a, b) => {
      const av = pick(a);
      const bv = pick(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // 缺值永遠排最後（比 0 更不誤導）
      if (bv === null) return -1;
      return sort === 'ratio_asc' ? av - bv : bv - av;
    });
    return rows;
  }

  function renderWeekRows() {
    const body = $('stk_detail_body');
    if (!body) return;
    const rows = filteredWeekRows();
    const size = currentWeekPageSize();
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / size));
    if (weekPage > pages) weekPage = pages;
    if (weekPage < 1) weekPage = 1;
    const pageRows = rows.slice((weekPage - 1) * size, weekPage * size);

    if (!total) {
      body.innerHTML = weekRows.length
        ? '<tr><td colspan="7" class="text-center text-secondary">沒有符合篩選條件的店舖</td></tr>'
        : '<tr><td colspan="7" class="text-center text-secondary">此期沒有店舖數據</td></tr>';
    } else {
      body.innerHTML = pageRows.map((row) => {
        const ratio = num(row.ratio);
        const soh = num(row.shop_stock_value);
        const wow = num(row.wow_delta_pt);
        const zero = soh === 0 && ratio === null;
        return `<tr>
          <td class="stk-site">${esc(row.site_code || '')}</td>
          <td>${esc(row.shop || '')}</td>
          <td>${esc(row.om || '')}</td>
          <td class="text-end">${fmtMoney(row.deadstock_value)}</td>
          <td class="text-end">${fmtMoney(row.shop_stock_value)}</td>
          <td class="text-end"><b>${zero ? '—' : fmtRatio(ratio)}</b>${zero ? '<div class="text-secondary small">存貨值 0，除零</div>' : ''}</td>
          <td class="text-end ${wowClass(wow)}">${wow === null ? '—' : `${wowArrow(wow)}${fmtPt(wow)}`}</td>
        </tr>`;
      }).join('');
    }

    if (globalThis.AdminPager) {
      globalThis.AdminPager.render({
        nav: $('stk_page_numbers'),
        range: $('stk_page_range'),
        page: weekPage,
        total,
        pageSize: size,
        onPage: (page) => { weekPage = page; renderWeekRows(); },
        unit: '間店',
      });
    }
  }

  function renderTop15() {
    const wrap = $('stk_top15');
    if (!wrap) return;
    const ranked = weekRows
      .filter((row) => num(row.ratio) !== null)
      .sort((a, b) => (num(b.ratio) || 0) - (num(a.ratio) || 0))
      .slice(0, 15);
    if (!ranked.length) {
      wrap.innerHTML = '<div class="text-secondary small">此期沒有可計算佔比的店舖（店舖存貨值為 0 或全部缺值）。</div>';
      return;
    }
    const max = num(ranked[0].ratio) || 1;
    wrap.innerHTML = ranked.map((row, index) => {
      const ratio = num(row.ratio) || 0;
      const wow = num(row.wow_delta_pt);
      const width = Math.max(2, Math.min(100, (ratio / max) * 100));
      return `<button type="button" class="stk-bar-row" data-stk-site="${escAttr(row.site_code || '')}" title="按一下只看 ${escAttr(row.site_code || '')} 的明細">
        <span class="stk-bar-rank">${index + 1}</span>
        <span class="stk-bar-name"><b>${esc(row.site_code || '')}</b><span class="stk-bar-shop">${esc(shortShop(row.shop))}</span></span>
        <span class="stk-bar-track"><i style="width:${width.toFixed(1)}%;background:${ratio >= 10 ? '#c0392b' : COLOR_MAIN}"></i></span>
        <span class="stk-bar-value">${fmtRatio(ratio)}</span>
        <span class="stk-bar-wow ${wowClass(wow)}">${wow === null ? '' : `${wowArrow(wow)}${fmtPt(wow)}`}</span>
      </button>`;
    }).join('');
  }

  async function loadWeek(date) {
    const body = $('stk_detail_body');
    const label = $('stk_week_label');
    const target = String(date || '').slice(0, 10);
    setResult('stk_week_error', 'info', '');
    if (!target) {
      weekRows = [];
      weekTotals = null;
      if (label) label.textContent = '—';
      if (body) body.innerHTML = '<tr><td colspan="7" class="text-center text-secondary">尚未有批次，上載後會顯示每店明細</td></tr>';
      const top = $('stk_top15');
      if (top) top.innerHTML = '<div class="text-secondary small">上載報表後會顯示排名。</div>';
      renderWeekRows();
      return;
    }
    if (body) body.innerHTML = '<tr><td colspan="7" class="text-center text-secondary">載入中…</td></tr>';
    try {
      const data = (await aFetch(`/api/admin/stock/weeks/${encodeURIComponent(target)}`)) || {};
      selectedWeek = String(data.report_date || target).slice(0, 10);
      weekRows = Array.isArray(data.rows) ? data.rows : [];
      weekTotals = data.totals || null;
      const storeCount = firstNum([weekTotals && weekTotals.store_count]) ?? weekRows.length;
      const ratio = firstNum([weekTotals && weekTotals.ratio]);
      if (label) {
        label.textContent = `${selectedWeek} · ${storeCount} 店${ratio === null ? '' : ` · 合計佔比 ${fmtRatio(ratio)}`}`;
      }
      renderTop15();
      renderWeekRows();
    } catch (err) {
      weekRows = [];
      weekTotals = null;
      if (label) label.textContent = target;
      setResult('stk_week_error', 'error', `未能載入 ${target} 的明細：${err.message}`);
      if (body) body.innerHTML = `<tr><td colspan="7" class="text-center text-danger">${esc(err.message)}</td></tr>`;
      const top = $('stk_top15');
      if (top) top.innerHTML = '<div class="text-secondary small">未能載入排名。</div>';
      renderWeekRows();
    }
  }

  /* ==================== 總刷新 ==================== */

  async function refreshAll() {
    await loadSummary();
    if (!selectedWeek) {
      const last = latestPoint();
      selectedWeek = last ? String(last.report_date).slice(0, 10) : '';
    }
    await Promise.all([loadBatches(), loadWeek(selectedWeek)]);
  }

  /* ==================== 事件綁定（只綁一次） ==================== */

  function bindEvents() {
    const fileEl = $('stk_file');
    const dateEl = $('stk_date');
    const kindEl = $('stk_kind');

    if (fileEl) {
      fileEl.addEventListener('change', () => {
        const file = fileEl.files && fileEl.files[0];
        const found = dateFromFileName(file && file.name);
        if (found && dateEl && (!dateEl.value || dateEl.value === autoDate)) {
          dateEl.value = found;
          autoDate = found;
          setDateHint(`已從檔名偵測日期 <b>${esc(found)}</b>，可再手改。`);
        } else if (found && dateEl && dateEl.value !== found) {
          setDateHint(`檔名日期為 <b>${esc(found)}</b>，目前使用 <b>${esc(dateEl.value)}</b>（保留你的手動選擇）。`);
        } else {
          syncDateHint();
        }
      });
    }
    if (dateEl) {
      dateEl.addEventListener('change', () => { autoDate = ''; syncDateHint(); });
    }
    if (kindEl) kindEl.addEventListener('change', () => syncDateHint());

    const uploadBtn = $('btn_stk_upload');
    if (uploadBtn) uploadBtn.addEventListener('click', upload);

    const refreshBtn = $('btn_stk_week_refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        try { await refreshAll(); } finally { refreshBtn.disabled = false; }
      });
    }

    // 批次表：容器事件代理（明細 / 改日期備註 / 刪除）
    const batchBody = $('stk_batches_body');
    if (batchBody) {
      batchBody.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target.closest('button') : null;
        if (!target) return;
        if (target.dataset.stkView) {
          selectedWeek = String(target.dataset.stkDate || '').slice(0, 10);
          weekPage = 1;
          loadWeek(selectedWeek).then(() => {
            const card = $('stk_week_label');
            if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
          loadBatches();
          return;
        }
        if (target.dataset.stkEdit) {
          editBatch(target.dataset.stkEdit, String(target.dataset.stkDate || '').slice(0, 10), target.dataset.stkNote || '');
          return;
        }
        if (target.dataset.stkDel) {
          deleteBatch(target.dataset.stkDel, String(target.dataset.stkDate || '').slice(0, 10), target.dataset.stkRows, target.dataset.stkStores);
        }
      });
    }

    // Top 15：按一下只看該店
    const top15 = $('stk_top15');
    if (top15) {
      top15.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target.closest('[data-stk-site]') : null;
        if (!target) return;
        const q = $('stk_q');
        if (q) q.value = target.dataset.stkSite || '';
        weekPage = 1;
        renderWeekRows();
      });
    }

    const qEl = $('stk_q');
    if (qEl) qEl.addEventListener('input', () => { weekPage = 1; renderWeekRows(); });
    ['stk_sort', 'stk_only'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('change', () => { weekPage = 1; renderWeekRows(); });
    });
    const clearBtn = $('btn_stk_clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if ($('stk_q')) $('stk_q').value = '';
        if ($('stk_sort')) $('stk_sort').value = 'ratio_desc';
        if ($('stk_only')) $('stk_only').value = '';
        weekPage = 1;
        renderWeekRows();
      });
    }

    if (globalThis.AdminPager) {
      globalThis.AdminPager.bindSize($('stk_page_size'), WEEK_PAGE_KEY, () => { weekPage = 1; renderWeekRows(); });
      globalThis.AdminPager.bindSize($('stk_batch_page_size'), BATCH_PAGE_KEY, () => { batchPage = 1; loadBatches(); });
    }
  }

  /* ==================== 懶啟動（不依賴 admin:tab-activated） ==================== */

  function start() {
    if (started) return;
    started = true;
    syncDateHint();
    refreshAll();
  }

  function init() {
    const panel = $('panel-stock');
    if (!panel) return;
    bindEvents();

    // 供程式化刷新用；admin-ui 的「立即更新」只會呼叫 __zsRefresh（故意不改現有檔案）
    globalThis.__stkRefresh = () => {
      if (!started) { start(); return; }
      refreshAll();
    };

    if (!('IntersectionObserver' in window)) { start(); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { start(); io.disconnect(); }
      });
    }, { rootMargin: '500px 0px' });
    io.observe(panel);

    // 後備：?tab=stock 直接進入時，若 IO 未及觸發就補一次
    window.addEventListener('load', () => {
      if (!started && globalThis.__adminActiveTab === 'stock') start();
    });
    setTimeout(() => {
      if (!started && !panel.hidden && globalThis.__adminActiveTab === 'stock') start();
    }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
