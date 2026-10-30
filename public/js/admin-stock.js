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
  /** 12 個月之前（去年）的線：淺灰藍，和主線、虛線參考線都分得開 */
  const COLOR_BEFORE = '#b9c6d4';
  const COLOR_RF = '#0f766e';
  const COLOR_RF_BEFORE = '#99c7c2';
  /** 不良÷SKU Carry Top 15 的紅色門檻（全公司加權約 11–12%，≥20% 視為明顯偏高） */
  const OVS_CARRY_RATIO_ALERT = 0.2;

  let csrf = null;
  let started = false;
  let summaryCache = null;
  let batchPage = 1;
  let selectedWeek = '';
  let weekRows = [];
  let weekTotals = null;
  /** 新店觀察期（日），由 API 回傳，避免前後端各寫一個數字 */
  let weekGraceDays = 90;
  /** 趨勢圖顯示期間（月）：3 / 6 / 12 / 24，預設 12；資料永久保留，只影響畫幾多 */
  let chartMonths = 12;
  /** RF 走勢圖口徑：count = RF SKU 數；ratio = 不良存貨 SKU 佔店內貨品比率 */
  let rfMetric = 'count';
  /** 分組小圖口徑：sku = 不良 SKU ÷ SKU Carry；value = 不良存貨值 ÷ 店舖存貨值 */
  let groupMetric = 'sku';
  /** 分組小圖維度：nature = Shop Nature；om = 營運經理 */
  let groupDim = 'nature';
  /** 當月（MTD）每店排名：另外快取該期明細，避免使用者切換舊批次時排名跟著跳 */
  let mtdWeekDate = '';
  let mtdWeekRows = [];
  let mtdPeriodInfo = null;
  let weekPage = 1;
  let autoDate = '';

  /* ==================== 網絡 ==================== */

  async function getCsrf(force) {
    if (!csrf || force) {
      const res = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json().catch(() => null);
      csrf = (data && data.token) || csrf;
    }
    return csrf;
  }

  /**
   * 帶 CSRF 的請求；失敗時拋出 Error（附 status / data，方便分辨 409 DATE_CONFLICT）。
   *
   * 寫入類請求一律重新取 token：cookie 只有 24 小時，而這個 tab 可能開著過夜，
   * 記憶體裡的舊 token 與 cookie 一不一致，所有寫入都會 403。
   * 若仍然收到 CSRF 403（例如另一個分頁剛換了 cookie），換 token 重試一次。
   */
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
      // FormData 可重複送出，所以重試安全
      if (!csrfFailed || attempt > 0) break;
    }

    if (!res || !res.ok) {
      const message = csrfFailed
        ? '安全憑證已過期，請重新整理頁面（F5）再試'
        : (data && data.error) || `請求失敗 (${res ? res.status : 0})`;
      const err = new Error(message);
      err.status = res ? res.status : 0;
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

  /** SKU 絕對增減用正負號；不套紅綠色，因 RF 增加或減少本身沒有好壞結論。 */
  function fmtSignedInt(value) {
    const n = num(value);
    if (n === null) return '—';
    const rounded = Math.round(n);
    return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US')}`;
  }

  function fmtMoney(value) {
    const n = num(value);
    if (n === null) return '—';
    return `$${fmtInt(n)}`;
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

  /**
   * 報表的 Shop 欄多數寫成「HB41 - 九龍城」，Site 欄已經有店號，
   * 這裡把開頭的店號與分隔符去掉，避免同一行出現兩次 Site Code。
   * 去掉後為空（Shop 欄只有店號）就保留原文。
   */
  function shopLabel(row) {
    const code = String((row && row.site_code) || '').trim();
    const name = String((row && row.shop) || '').trim();
    if (!code || !name) return name;
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 店號後面必須接分隔符或行尾，避免 HC6 誤截 HC63 這類前綴相同的店號
    const stripped = name.replace(new RegExp(`^${escaped}(?=[\\s\\-–—:：|/]|$)[\\s\\-–—:：|/]*`, 'i'), '').trim();
    return stripped || name;
  }

  /** 店舖性質（報表 Shop Nature：Local / Non Tourist / Tourist / Mix）＋ 中文提示 */
  const NATURE_LABELS = { local: '民生區（Local / Non Tourist）', tourist: '遊客區', mix: '混合區' };
  function natureTitle(value) {
    const key = String(value || '').trim().toLowerCase();
    return NATURE_LABELS[key] ? `Shop Nature：${value}（${NATURE_LABELS[key]}）` : 'Shop Nature（報表原值）';
  }

  /** 'YYYY-MM-DD' 往前推 n 個月；月底自動夾到該月最後一日（例：3-31 減 1 月 → 2-28） */
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

  /** 香港時區的當前月份 'YYYY-MM'（後台使用者多數在 HK；失敗時回落 UTC） */
  function hkMonthNow() {
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: 'Asia/Hong_Kong',
        year: 'numeric',
        month: '2-digit',
      }).formatToParts(new Date());
      const year = parts.find((part) => part.type === 'year')?.value;
      const month = parts.find((part) => part.type === 'month')?.value;
      if (year && month) return `${year}-${month}`;
    } catch {
      /* 舊瀏覽器沒有 formatToParts，下面用 UTC 月份 */
    }
    return new Date().toISOString().slice(0, 7);
  }

  /**
   * MTD 期別：優先用「香港當前月份」內最新一期；本月未上載時回落最新資料月份，
   * 並由 UI 標明是「最新月份」而非當月。
   */
  function mtdPeriodOf(series) {
    const dates = [...new Set((Array.isArray(series) ? series : [])
      .map((row) => String((row && row.report_date) || '').slice(0, 10))
      .filter(Boolean))].sort();
    if (!dates.length) return null;
    const currentMonth = hkMonthNow();
    const inMonth = dates.filter((date) => date.slice(0, 7) === currentMonth);
    const date = inMonth.length ? inMonth[inMonth.length - 1] : dates[dates.length - 1];
    return {
      date,
      month: date.slice(0, 7),
      is_current_month: date.slice(0, 7) === currentMonth,
    };
  }

  /** 不參與排名的標記：新店（觀察期內）／上期無數據 */
  function newTag(row) {
    if (!row || !row.is_new) return '';
    if (row.new_reason === 'new_store') {
      const since = row.first_seen ? `，系統首次見到 ${row.first_seen}` : '';
      const tip = `報表 Shop Type = NEW STORE，仍在 ${weekGraceDays} 天新店觀察期內${since}`;
      return `<span class="text-secondary small" title="${escAttr(tip)}">（新店）</span>`;
    }
    return '<span class="text-secondary small">（上期無數據）</span>';
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
      setResult('stk_rf_error', 'info', '');
      renderKpi(data, series);
      renderGroupChart(data, series);
      renderMtdRanking();
      renderChart(data, series);
      renderRfDashboard(data, series);
      if (!selectedWeek) selectedWeek = series.length ? String(series[series.length - 1].report_date).slice(0, 10) : '';
    } catch (err) {
      summaryCache = null;
      if (note) note.textContent = '載入失敗';
      setResult('stk_kpi_error', 'error', `未能載入存貨摘要：${err.message}`);
      setResult('stk_group_error', 'error', `未能載入分組走勢：${err.message}`);
      setResult('stk_mtd_error', 'error', `未能載入當月排名：${err.message}`);
      const mtdRank = $('stk_mtd_rank');
      if (mtdRank) mtdRank.innerHTML = '<div class="text-secondary small">未能載入當月排名。</div>';
      const mtdNote = $('stk_mtd_note');
      if (mtdNote) mtdNote.textContent = '載入失敗';
      setResult('stk_chart_error', 'error', err.message);
      setResult('stk_rf_error', 'error', `未能載入 RF SKU 摘要：${err.message}`);
      const groupChart = $('stk_group_chart');
      if (groupChart) {
        if (globalThis.ChartLite) globalThis.ChartLite.clear(groupChart);
        else groupChart.innerHTML = '';
        groupChart.innerHTML = '<div class="ct-empty">未能載入分組走勢。</div>';
      }
      const kpi = $('stk_kpi');
      if (kpi) kpi.innerHTML = '<div class="stk-kpi stk-kpi--wide"><div class="stk-kpi-value">—</div><div class="stk-kpi-label">未能載入 KPI</div></div>';
      const rfKpi = $('stk_rf_kpi');
      if (rfKpi) rfKpi.innerHTML = '<div class="stk-kpi stk-kpi--wide"><div class="stk-kpi-value">—</div><div class="stk-kpi-label">未能載入 RF SKU KPI</div></div>';
      const rfChart = $('stk_rf_chart');
      if (rfChart) rfChart.innerHTML = '<div class="ct-empty">未能載入 RF SKU 走勢。</div>';
      const rfLegend = $('stk_rf_legend');
      if (rfLegend) rfLegend.innerHTML = '';
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
      kpiCard('不良存貨值（P90D 0 Sales）', fmtMoney(excess), ''),
      kpiCard('不良存貨佔比', ratioZero ? '—' : fmtRatio(ratio),
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

  /* ==================== 不良銷售 SKU 佔比走勢（分組小圖） ==================== */

  const GROUP_DIM_LABELS = { nature: 'Shop Nature', om: 'OM' };
  const GROUP_METRIC_LABELS = {
    sku: '不良 SKU ÷ SKU Carry',
    value: '不良存貨值 ÷ 店舖存貨值',
  };

  function groupPointTip(point, isSku) {
    if (!point || !num(point.store_count)) return '此期沒有這個分組的店舖';
    if (isSku) {
      if (point.total_sku_carry == null) return '此期沒有有效 SKU Carry';
      return `不良 SKU ${fmtInt(point.sku_count_0sale)} ÷ SKU Carry ${fmtInt(point.total_sku_carry)}（${fmtInt(point.sku_store_count)} 店）`;
    }
    if (point.total_soh == null) return '此期沒有有效店舖存貨值';
    return `不良存貨值 ${fmtMoney(point.total_excess)} ÷ 店舖存貨值 ${fmtMoney(point.total_soh)}（${fmtInt(point.ratio_store_count)} 店）`;
  }

  function groupSeriesSpec(group, visible, isSku) {
    const byDate = new Map();
    (Array.isArray(group.points) ? group.points : []).forEach((point) => {
      const date = String((point && point.report_date) || '').slice(0, 10);
      if (date) byDate.set(date, point);
    });

    const points = visible.map((row) => {
      const date = String((row && row.report_date) || '').slice(0, 10);
      const point = byDate.get(date) || null;
      return {
        date,
        value: point ? num(isSku ? point.ovs_carry_ratio : point.ratio) : null,
        tip: groupPointTip(point, isSku),
      };
    });

    const finite = points.filter((point) => point.value !== null);
    const last = finite.length ? finite[finite.length - 1] : null;
    const prev = finite.length > 1 ? finite[finite.length - 2] : null;
    const delta = last && prev ? (last.value - prev.value) * 100 : null;
    const deltaTone = delta === null
      ? ''
      : (delta > 0.0001 ? 'is-worse' : (delta < -0.0001 ? 'is-better' : 'is-flat'));

    return {
      key: group.key,
      label: group.label,
      color: isSku ? COLOR_RF : COLOR_MAIN,
      points,
      latest: last ? fmtRatio(last.value) : '—',
      latestTitle: last ? `最新有效日期 ${String(last.date).slice(0, 10)}` : '',
      delta: delta === null ? '' : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}pt`,
      deltaTone,
    };
  }

  function renderGroupChart(data, series) {
    const el = $('stk_group_chart');
    const legend = $('stk_group_legend');
    const note = $('stk_group_note');
    const chartApi = globalThis.ChartLite;
    if (!el) return;
    setResult('stk_group_error', 'info', '');
    if (legend) legend.innerHTML = '';
    if (note) note.textContent = '';

    const clearChart = () => {
      if (chartApi) chartApi.clear(el);
      else el.innerHTML = '';
    };

    const trend = data && data.group_trend;
    if (!trend || typeof trend !== 'object') {
      clearChart();
      el.innerHTML = '<div class="ct-empty">後端未提供分組走勢資料。請重新整理頁面；若問題持續，請確認前後端版本一致。</div>';
      return;
    }
    if (!series.length) {
      clearChart();
      el.innerHTML = '<div class="ct-empty">尚未上載任何存貨報表，分組走勢會在第一次上載後出現。</div>';
      return;
    }

    const allDates = series
      .map((row) => String(row.report_date || '').slice(0, 10))
      .filter(Boolean)
      .sort();
    const latestDate = allDates.length ? allDates[allDates.length - 1] : '';
    const cutoff = latestDate ? monthsBefore(latestDate, chartMonths) : '';
    const visible = cutoff
      ? series.filter((row) => String(row.report_date || '').slice(0, 10) >= cutoff)
      : series;
    if (!visible.length) {
      clearChart();
      el.innerHTML = '<div class="ct-empty">所選期間沒有存貨報表期數。</div>';
      return;
    }

    const isSku = groupMetric === 'sku';
    const groups = groupDim === 'om'
      ? (Array.isArray(trend.om) ? trend.om : [])
      : (Array.isArray(trend.nature) ? trend.nature : []);
    const seriesList = [];
    if (trend.total && typeof trend.total === 'object') seriesList.push(trend.total);
    groups.forEach((group) => { if (group && group.key) seriesList.push(group); });
    if (!seriesList.length) {
      clearChart();
      el.innerHTML = '<div class="ct-empty">目前沒有可用的分組資料（報表可能缺少 Shop Nature／OM 欄）。</div>';
      return;
    }

    const specs = seriesList.map((group) => groupSeriesSpec(group, visible, isSku));
    const color = isSku ? COLOR_RF : COLOR_MAIN;

    if (legend) {
      legend.innerHTML = `<span class="stk-legend-item"><i class="stk-legend-swatch" style="background:${color}"></i>${GROUP_METRIC_LABELS[groupMetric]}</span>`
        + `<span class="stk-legend-item" style="color:#66727f">期間 ${visible.length} 期｜最新 ${esc(latestDate)}</span>`;
    }

    if (!chartApi) {
      el.innerHTML = '<div class="ct-empty">圖表元件未載入（/js/chart-lite.js），請重新整理頁面。</div>';
      return;
    }

    chartApi.renderBarGrid(el, {
      series: specs,
      height: 150,
      yFormat: (value) => `${(Number(value) * 100).toFixed(1)}%`,
      labelFormat: (value) => fmtRatio(value),
      emptyText: '所選期間沒有有效的分組比率數據。',
      ariaLabel: `${GROUP_METRIC_LABELS[groupMetric]}，按 ${GROUP_DIM_LABELS[groupDim]} 分組`,
    });

    if (note) {
      const groupLabel = groupDim === 'om' ? 'OM' : 'Shop Nature';
      const omSource = groupDim === 'om'
        ? 'OM 分組以最後上載報表的 OM 為準，歷史期數會自動歸入最新 OM。'
        : '';
      note.textContent = `${omSource}Grand Total ＋ ${groups.length} 個 ${groupLabel}；每組先加總分子／分母再相除（加權），不是各店比率平均。某組某期沒有店舖時會留空，不會當成 0%。`;
    }
  }

  /* ==================== 當月 MTD 每店排名 ==================== */

  function renderMtdRanking() {
    const wrap = $('stk_mtd_rank');
    const title = $('stk_mtd_title');
    const note = $('stk_mtd_note');
    if (!wrap) return;
    setResult('stk_mtd_error', 'info', '');

    const isSku = groupMetric === 'sku';
    const metricLabel = isSku ? '不良 SKU 佔比' : '不良存貨值佔比';
    if (title) title.textContent = `當月 MTD ${metricLabel}排名`;

    if (!mtdWeekDate) {
      const hasSeries = normalizedSeries(summaryCache).length > 0;
      if (note) note.textContent = hasSeries ? '載入 MTD 排名…' : '尚未有存貨報表';
      wrap.innerHTML = `<div class="text-secondary small">${hasSeries ? '載入 MTD 排名…' : '上載存貨報表後會顯示當月排名。'}</div>`;
      return;
    }

    const period = mtdPeriodInfo || {
      date: mtdWeekDate,
      month: mtdWeekDate.slice(0, 7),
      is_current_month: true,
    };
    if (title) {
      title.textContent = period.is_current_month
        ? `當月 MTD ${metricLabel}排名`
        : `最新月份 MTD ${metricLabel}排名（${period.month}）`;
    }
    const pick = isSku ? (row) => num(row.ovs_carry_ratio) : (row) => num(row.ratio);
    const wowOf = isSku ? (row) => num(row.ovs_carry_delta_pt) : (row) => num(row.wow_delta_pt);
    const rows = Array.isArray(mtdWeekRows) ? mtdWeekRows : [];

    if (!rows.length) {
      if (note) note.textContent = `${mtdWeekDate} · 此期沒有店舖數據`;
      wrap.innerHTML = '<div class="text-secondary small">此期沒有店舖數據。</div>';
      return;
    }

    // 與原有 Top 15 同一套新店規則：新店／上期無數據不排名，但仍計入全公司合計
    const excluded = rows.filter((row) => row.is_new).length;
    const ranked = rows
      .filter((row) => !row.is_new && pick(row) !== null)
      .sort((a, b) => (pick(b) || 0) - (pick(a) || 0)
        || String(a.site_code || '').localeCompare(String(b.site_code || '')))
      .slice(0, 15);

    const monthNote = period.is_current_month ? '' : `（本月尚未上載，顯示最新月份 ${period.month}）`;
    if (note) {
      note.textContent = `${mtdWeekDate}${monthNote} · ${ranked.length} 店入榜${excluded ? ` · 已排除 ${excluded} 間新店／上期無數據` : ''}`;
    }
    if (!ranked.length) {
      wrap.innerHTML = '<div class="text-secondary small">此期沒有可參與排名的店舖（全部為新店，或比率缺值）。</div>';
      return;
    }

    const max = pick(ranked[0]) || 1;
    const alert = isSku ? OVS_CARRY_RATIO_ALERT : 0.1;
    const color = isSku ? COLOR_RF : COLOR_MAIN;
    const detailLabel = isSku ? '不良 SKU ÷ SKU Carry' : '不良存貨值 ÷ 店舖存貨值';

    wrap.innerHTML = `<div class="table-responsive stk-mtd-wrap">
      <table class="table table-vcenter table-hover card-table stk-mtd-table">
        <thead><tr>
          <th scope="col">#</th>
          <th scope="col">Site</th>
          <th scope="col">店舖名稱</th>
          <th scope="col">OM</th>
          <th scope="col">Shop Nature</th>
          <th scope="col" class="text-end">${metricLabel}</th>
          <th scope="col" class="text-end">${detailLabel}</th>
          <th scope="col" class="text-end">與上期</th>
        </tr></thead>
        <tbody>
          ${ranked.map((row, index) => {
            const ratio = pick(row) || 0;
            const wow = wowOf(row);
            const width = Math.max(2, Math.min(100, (ratio / max) * 100));
            const barColor = ratio >= alert ? '#c0392b' : color;
            const detail = isSku
              ? `${fmtInt(row.sku_count_0sale)} ÷ ${fmtInt(row.sku_carry_count)}`
              : `${fmtMoney(row.deadstock_value)} ÷ ${fmtMoney(row.shop_stock_value)}`;
            return `<tr class="stk-mtd-row" data-stk-mtd-site="${escAttr(row.site_code || '')}" data-stk-mtd-date="${escAttr(mtdWeekDate)}" title="按一下查看 ${escAttr(row.site_code || '')} 的明細">
              <td class="text-secondary">${index + 1}</td>
              <td class="stk-mtd-site">${esc(row.site_code || '')}</td>
              <td class="stk-mtd-shop">${esc(shopLabel(row))}</td>
              <td class="stk-mtd-meta">${esc(row.om || '—')}</td>
              <td class="stk-mtd-meta" title="${escAttr(natureTitle(row.shop_nature))}">${esc(row.shop_nature || '—')}</td>
              <td class="text-end">
                <div class="stk-mtd-ratio ${ratio >= alert ? 'text-danger' : ''}">${fmtRatio(ratio)}</div>
                <span class="stk-mtd-track"><i style="width:${width.toFixed(1)}%;background:${barColor}"></i></span>
              </td>
              <td class="text-end stk-mtd-detail">${detail}</td>
              <td class="text-end ${wowClass(wow)}">${wow === null ? '—' : `${wowArrow(wow)}${fmtPt(wow)}`}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  }

  async function loadMtdWeek() {
    const period = mtdPeriodOf(normalizedSeries(summaryCache));
    if (!period) {
      mtdWeekDate = '';
      mtdWeekRows = [];
      mtdPeriodInfo = null;
      renderMtdRanking();
      return;
    }
    mtdPeriodInfo = period;

    // 同一期已快取，或主明細剛好載入同一期：直接重用，避免重複 API 呼叫
    if (mtdWeekDate === period.date && mtdWeekRows.length) {
      renderMtdRanking();
      return;
    }
    if (selectedWeek === period.date && weekRows.length) {
      mtdWeekDate = period.date;
      mtdWeekRows = weekRows;
      renderMtdRanking();
      return;
    }

    setResult('stk_mtd_error', 'info', '');
    try {
      const data = (await aFetch(`/api/admin/stock/weeks/${encodeURIComponent(period.date)}`)) || {};
      mtdWeekDate = String(data.report_date || period.date).slice(0, 10);
      mtdWeekRows = Array.isArray(data.rows) ? data.rows : [];
      weekGraceDays = num(data.new_store_grace_days) ?? weekGraceDays;
    } catch (err) {
      mtdWeekDate = period.date;
      mtdWeekRows = [];
      setResult('stk_mtd_error', 'error', `未能載入當月排名：${err.message}`);
    }
    renderMtdRanking();
  }

  function renderChart(data, series) {
    const el = $('stk_chart');
    const legend = $('stk_legend');
    const chartNote = $('stk_chart_note');
    if (!el) return;
    setResult('stk_chart_error', 'info', '');
    if (chartNote) chartNote.textContent = '';

    // 只畫最近 chartMonths 個月（資料永久保留，這裡純屬顯示窗口）
    const allDates = series
      .map((row) => String(row.report_date || '').slice(0, 10))
      .filter(Boolean)
      .sort();
    const latestDate = allDates.length ? allDates[allDates.length - 1] : '';
    const cutoff = latestDate ? monthsBefore(latestDate, chartMonths) : '';
    const visible = cutoff
      ? series.filter((row) => String(row.report_date || '').slice(0, 10) >= cutoff)
      : series;
    // 超過 12 個月時，12 個月之前的那一段（去年）用淺色畫
    const yearCutoff = chartMonths > 12 ? monthsBefore(latestDate, 12) : '';

    const points = visible.map((row) => ({
      date: row.report_date,
      value: num(row.ratio),
    }));
    // 只有真的有 12 個月之前的資料時，才需要分段與圖例；否則一條線到底
    const hasYearPart = !!yearCutoff
      && points.some((row) => String(row.date || '').slice(0, 10) < yearCutoff);
    const usable = points.filter((p) => p.value !== null);
    const chartApi = globalThis.ChartLite;

    if (!usable.length) {
      if (chartApi) chartApi.clear(el); else el.innerHTML = '';
      if (legend) legend.innerHTML = '';
      el.innerHTML = '<div class="ct-empty">' + (visible.length
        ? '已有報表，但全部期數的店舖存貨值為 0（除零），暫時畫不出佔比走勢。'
        : '尚未上載任何存貨報表，趨勢圖會在第一次上載後出現。') + '</div>';
      return;
    }

    if (usable.length === 1) {
      if (chartApi) chartApi.clear(el); else el.innerHTML = '';
      if (legend) legend.innerHTML = '<span class="stk-legend-item"><i style="background:#0f5c9c"></i>不良存貨佔比</span>';
      el.innerHTML = `<div class="ct-empty">目前只有 1 期資料（${esc(String(usable[0].date).slice(0, 10))} ${fmtRatio(usable[0].value)}），上載下一期後會顯示走勢。</div>`;
      return;
    }

    const avg = num(data && data.company_avg_ratio);
    const lastRatio = usable[usable.length - 1].value;
    const showAvg = avg !== null && Math.abs(avg - lastRatio) > 0.005;

    if (legend) {
      const mainLabel = hasYearPart ? '最近 12 個月' : '不良存貨佔比（加權）';
      legend.innerHTML = `<span class="stk-legend-item"><i style="background:${COLOR_MAIN}"></i>${mainLabel}</span>`
        + (hasYearPart ? `<span class="stk-legend-item"><i style="background:${COLOR_BEFORE}"></i>12 個月前（去年）</span>` : '')
        + (showAvg ? `<span class="stk-legend-item"><i class="stk-legend-dash" style="border-color:${COLOR_REF}"></i>全公司平均（加權）${fmtRatio(avg)}</span>` : '');
    }

    if (!chartApi) {
      el.innerHTML = '<div class="ct-empty">圖表元件未載入（/js/chart-lite.js），請重新整理頁面。</div>';
      return;
    }

    const chartSeries = [{
      key: 'ratio',
      label: '不良存貨佔比',
      color: COLOR_MAIN,
      splitDate: hasYearPart ? yearCutoff : '',
      colorBefore: COLOR_BEFORE,
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
      yFormat: (v) => `${(Number(v) * 100).toFixed(1)}%`,
      tipFormat: (v) => fmtRatio(v),
      ariaLabel: `不良存貨佔比趨勢，共 ${usable.length} 期，最新 ${fmtRatio(lastRatio)}`,
    });

    const gaps = points.length - usable.length;
    if (chartNote) {
      chartNote.textContent = gaps
        ? `注意：有 ${gaps} 期店舖存貨值為 0（除零），該期不會連線（缺值斷線，不會當成 0%）。`
        : '點或懸停圖表可看該期數值；虛線為全公司平均參考，不屬於任何一期。';
    }
  }

  /* ==================== No. of RF SKU Dashboard ==================== */

  function renderRfKpi(data, series) {
    const wrap = $('stk_rf_kpi');
    const note = $('stk_rf_note');
    if (!wrap) return;
    if (!series.length) {
      wrap.innerHTML = '<div class="stk-kpi stk-kpi--wide"><div class="stk-kpi-value">—</div><div class="stk-kpi-label">尚未有 RF SKU 資料</div><div class="stk-kpi-sub">上載含 No. of RF SKU 欄的 I14「By Shop」報表後自動顯示。</div></div>';
      if (note) note.textContent = '走勢期間與上方佔比趨勢同步';
      return;
    }

    const last = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const kpi = (data && data.kpi) || {};
    const total = firstNum([kpi.total_rf_sku, last.total_rf_sku]);
    const prevTotal = prev ? firstNum([prev.total_rf_sku]) : null;
    const delta = firstNum([kpi.rf_sku_delta, last.rf_sku_delta])
      ?? (total !== null && prevTotal !== null ? total - prevTotal : null);
    const stores = firstNum([kpi.store_count, last.store_count]);
    const rfStores = firstNum([kpi.rf_store_count, last.rf_store_count]) ?? 0;
    const missing = stores === null ? 0 : Math.max(0, stores - rfStores);
    const reportDate = String(kpi.report_date || last.report_date || '').slice(0, 10);

    // 不良存貨 SKU 佔店內貨品比率（加權小數）；分母 No. of SKU Carry = RF + ND with Stock
    const ovsRatio = firstNum([kpi.ovs_carry_ratio, last.ovs_carry_ratio]);
    const prevOvsRatio = prev ? firstNum([prev.ovs_carry_ratio]) : null;
    const ovsWow = firstNum([kpi.ovs_carry_ratio_wow_delta_pt])
      ?? (ovsRatio !== null && prevOvsRatio !== null ? (ovsRatio - prevOvsRatio) * 100 : null);

    wrap.innerHTML = [
      kpiCard('最新 RF SKU 合計', fmtInt(total), total === null ? '沒有有效 RF 資料' : `報表日期 ${esc(reportDate || '—')}`),
      kpiCard('RF SKU 較上期', delta === null ? '—' : fmtSignedInt(delta),
        !prev ? '需要至少 2 期資料' : (prevTotal === null ? '上期沒有有效 RF 資料' : `上期合計 ${fmtInt(prevTotal)}`)),
      kpiCard('RF 資料覆蓋', stores === null ? '—' : `${fmtInt(rfStores)} / ${fmtInt(stores)} 店`,
        missing > 0 ? `${fmtInt(missing)} 店缺值，未當作 0` : '全部店舖有有效 RF 數字'),
      kpiCard('不良存貨 SKU 佔店內貨品比率', fmtRatio(ovsRatio),
        ovsRatio === null
          ? '沒有有效 SKU Carry 或不良存貨 SKU 數據'
          : (ovsWow === null
            ? (prev ? '上期沒有有效數據' : '只有 1 期資料')
            : `${wowArrow(ovsWow)}${fmtPt(ovsWow)}　較上一期${prevOvsRatio === null ? '' : `（上期 ${fmtRatio(prevOvsRatio)}）`}`),
        ovsRatio === null ? '' : wowClass(ovsWow)),
    ].join('');
    if (note) note.textContent = `最新 ${reportDate || '—'}｜走勢期間與上方佔比趨勢同步`;
  }

  /**
   * RF 走勢圖有兩個口徑（rfMetric）：
   *   count = 全公司 RF SKU 合計（絕對數，答「規模幾大」）
   *   ratio = 不良存貨 SKU 佔店內貨品比率（加權，答「滯銷佔幾多」；只有實際清貨先會改善）
   */
  function renderRfChart(series) {
    const el = $('stk_rf_chart');
    const legend = $('stk_rf_legend');
    const chartNote = $('stk_rf_chart_note');
    if (!el) return;
    if (chartNote) chartNote.textContent = '';

    const isRatio = rfMetric === 'ratio';
    const pick = (row) => (isRatio ? num(row.ovs_carry_ratio) : num(row.total_rf_sku));
    const emptyLabel = isRatio ? '不良存貨 SKU 佔店內貨品比率' : 'RF SKU 合計';
    const formatValue = isRatio ? fmtRatio : fmtInt;

    const allDates = series
      .map((row) => String(row.report_date || '').slice(0, 10))
      .filter(Boolean)
      .sort();
    const latestDate = allDates.length ? allDates[allDates.length - 1] : '';
    const cutoff = latestDate ? monthsBefore(latestDate, chartMonths) : '';
    const visible = cutoff
      ? series.filter((row) => String(row.report_date || '').slice(0, 10) >= cutoff)
      : series;
    const yearCutoff = chartMonths > 12 ? monthsBefore(latestDate, 12) : '';
    const points = visible.map((row) => ({ date: row.report_date, value: pick(row) }));
    const hasYearPart = !!yearCutoff
      && points.some((row) => String(row.date || '').slice(0, 10) < yearCutoff);
    const usable = points.filter((point) => point.value !== null);
    const chartApi = globalThis.ChartLite;

    if (!usable.length) {
      if (chartApi) chartApi.clear(el); else el.innerHTML = '';
      if (legend) legend.innerHTML = '';
      el.innerHTML = '<div class="ct-empty">' + (visible.length
        ? (isRatio
          ? '所選期間沒有有效比率數據（需要同時有不良存貨 SKU 數與有效 No. of SKU Carry）；空白或無效值不會當作 0。'
          : '所選期間沒有有效 No. of RF SKU 資料；空白或無效值不會當作 0。')
        : '尚未上載任何存貨報表，RF SKU 走勢會在第一次上載後出現。') + '</div>';
      return;
    }

    if (usable.length === 1) {
      if (chartApi) chartApi.clear(el); else el.innerHTML = '';
      if (legend) legend.innerHTML = `<span class="stk-legend-item"><i style="background:${COLOR_RF}"></i>${emptyLabel}</span>`;
      el.innerHTML = `<div class="ct-empty">目前只有 1 期有效資料（${esc(String(usable[0].date).slice(0, 10))} ${esc(formatValue(usable[0].value))}），上載下一期後會顯示走勢。</div>`;
      return;
    }

    if (legend) {
      legend.innerHTML = `<span class="stk-legend-item"><i style="background:${COLOR_RF}"></i>${hasYearPart ? `最近 12 個月（${emptyLabel}）` : emptyLabel}</span>`
        + (hasYearPart ? `<span class="stk-legend-item"><i style="background:${COLOR_RF_BEFORE}"></i>12 個月前（去年）</span>` : '');
    }
    if (!chartApi) {
      el.innerHTML = '<div class="ct-empty">圖表元件未載入（/js/chart-lite.js），請重新整理頁面。</div>';
      return;
    }

    chartApi.renderLine(el, {
      series: [{
        key: isRatio ? 'ovs_carry_ratio' : 'rf_sku',
        label: emptyLabel,
        color: COLOR_RF,
        splitDate: hasYearPart ? yearCutoff : '',
        colorBefore: COLOR_RF_BEFORE,
        points,
      }],
      height: 220,
      emptyText: isRatio ? '暫無比率數據' : '暫無 RF SKU 數據',
      yFormat: (value) => (isRatio ? `${(Number(value) * 100).toFixed(1)}%` : fmtInt(value)),
      tipFormat: (value) => formatValue(value),
      ariaLabel: isRatio
        ? `全公司不良存貨 SKU 佔店內貨品比率趨勢，共 ${usable.length} 期，最新 ${fmtRatio(usable[usable.length - 1].value)}`
        : `全公司 RF SKU 合計趨勢，共 ${usable.length} 期，最新 ${fmtInt(usable[usable.length - 1].value)}`,
    });

    const gaps = points.length - usable.length;
    const notes = [isRatio
      ? '點或懸停圖表可看該期比率；分子 = No. of Overstock SKU (P90D 0 Sales) 合計（含 ND 貨），分母 = No. of SKU Carry 合計（= RF SKU + ND with Stock）。RF 轉 ND 而貨未清走時比率不變。'
      : '點或懸停圖表可看該期的全公司 RF SKU 合計。'];
    if (gaps) notes.push(`有 ${gaps} 期完全沒有有效數據，該期缺值斷線，不會當成 0。`);
    if (!isRatio) {
      const partialPeriods = visible.filter((row) => {
        const stores = num(row.store_count) ?? 0;
        const rfStores = num(row.rf_store_count) ?? 0;
        return stores > rfStores;
      }).length;
      if (partialPeriods) notes.push(`有 ${partialPeriods} 期部分店舖缺少 RF 資料，合計只包括有效值；請同時查看資料覆蓋店數。`);
    }
    if (chartNote) chartNote.textContent = notes.join(' ');
  }

  function renderRfDashboard(data, series) {
    renderRfKpi(data, series);
    renderRfChart(series);
  }

  /* ==================== 匯出（PPT 用） ==================== */

  /** 把趨勢圖目前顯示期間的數字匯出成 Excel（三個工作表：明細 / PPT 圖表用 / 匯出說明） */
  /**
   * 通用 Excel 下載：攞 blob → 觸發瀏覽器存檔。
   * 按鈕會暫時變「匯出中…」並停用；成功／失敗訊息顯示喺 resultBox。
   */
  async function downloadExcel(url, fallbackName, btnId, boxId, okMessage) {
    const btn = $(btnId);
    const box = $(boxId);
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '匯出中…'; }
    if (box) box.innerHTML = '';
    try {
      const res = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
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
      if (box) {
        box.innerHTML = `<div class="alert alert-success mt-2 mb-0">${esc(okMessage)}</div>`;
      }
    } catch (err) {
      if (box) box.innerHTML = `<div class="alert alert-danger mt-2 mb-0">${esc(err.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || '匯出 Excel'; }
    }
  }

  /** 佔比趨勢（圖表右上角）：走勢 + PPT 圖表用兩張表 */
  function downloadTrendExport() {
    return downloadExcel(
      `/api/admin/stock/summary/export?months=${encodeURIComponent(String(chartMonths))}`,
      'Shop_Stock_Ratio.xlsx',
      'btn_stk_export',
      'stk_export_result',
      `已匯出最近 ${chartMonths} 個月的佔比與 RF SKU 趨勢（明細＋PPT 圖表用兩張表）。`,
    );
  }

  /** 每店明細：跟住畫面嘅搜尋／排序／只顯示，即「匯出 = 畫面所見」 */
  function downloadDetailExport() {
    const week = String(selectedWeek || '').slice(0, 10);
    if (!week) {
      const box = $('stk_detail_export_result');
      if (box) {
        box.innerHTML = '<div class="alert alert-warning mt-2 mb-0">未有可匯出的期數，請先上載報表，或喺下方「上載批次」揀一期。</div>';
      }
      return Promise.resolve();
    }
    const params = new URLSearchParams();
    const q = String((($('stk_q') || {}).value) || '').trim();
    if (q) params.set('q', q);
    params.set('sort', String((($('stk_sort') || {}).value) || '') || 'ratio_desc');
    const only = String((($('stk_only') || {}).value) || '');
    if (only) params.set('only', only);
    const count = filteredWeekRows().length;
    return downloadExcel(
      `/api/admin/stock/weeks/${encodeURIComponent(week)}/export?${params.toString()}`,
      'Shop_Stock_Detail.xlsx',
      'btn_stk_detail_export',
      'stk_detail_export_result',
      `已匯出 ${week} 的每店明細，共 ${count} 間店（跟住畫面嘅搜尋／排序／篩選）。`,
    );
  }

  /** RF SKU Dashboard：走勢 + 兩張店舖排名（排名期別跟畫面揀選嗰期） */
  function downloadRfExport() {
    const params = new URLSearchParams();
    params.set('months', String(chartMonths));
    const week = String(selectedWeek || '').slice(0, 10);
    if (week) params.set('report_date', week);
    return downloadExcel(
      `/api/admin/stock/rf/export?${params.toString()}`,
      'Shop_Stock_RF_SKU.xlsx',
      'btn_stk_rf_export',
      'stk_rf_export_result',
      `已匯出 RF SKU 走勢（最近 ${chartMonths} 個月）同店舖排名${week ? `（${week}）` : ''}。`,
    );
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
      rows = rows.filter((r) => [r.site_code, r.shop, r.om, r.shop_nature].some((v) => String(v || '').toLowerCase().includes(q)));
    }
    if (only === 'worse') rows = rows.filter((r) => (num(r.wow_delta_pt) || 0) > 0.0001);
    if (only === 'better') rows = rows.filter((r) => (num(r.wow_delta_pt) || 0) < -0.0001);

    const pick = sort === 'excess_desc' ? (r) => num(r.deadstock_value)
      : sort === 'wow_desc' ? (r) => num(r.wow_delta_pt)
        : sort === 'rf_desc' ? (r) => num(r.rf_sku_count)
          : sort === 'rf_delta_desc' ? (r) => num(r.rf_sku_delta)
            : sort === 'ovscarry_desc' ? (r) => num(r.ovs_carry_ratio)
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
        ? '<tr><td colspan="11" class="text-center text-secondary">沒有符合篩選條件的店舖</td></tr>'
        : '<tr><td colspan="11" class="text-center text-secondary">此期沒有店舖數據</td></tr>';
    } else {
      body.innerHTML = pageRows.map((row) => {
        const ratio = num(row.ratio);
        const soh = num(row.shop_stock_value);
        const wow = num(row.wow_delta_pt);
        const rf = num(row.rf_sku_count);
        const prevRf = num(row.prev_rf_sku_count);
        const rfDelta = num(row.rf_sku_delta);
        const ovsRatio = num(row.ovs_carry_ratio);
        const zero = soh === 0 && ratio === null;
        return `<tr>
          <td class="stk-site">${esc(row.site_code || '')}${newTag(row)}</td>
          <td>${esc(shopLabel(row))}</td>
          <td>${esc(row.om || '')}</td>
          <td class="stk-nature" title="${escAttr(natureTitle(row.shop_nature))}">${esc(row.shop_nature || '')}</td>
          <td class="text-end"><b>${fmtInt(rf)}</b></td>
          <td class="text-end text-secondary" title="${escAttr(prevRf === null ? '上期沒有有效 RF 資料' : `上期 ${fmtInt(prevRf)} SKU`)}">${rfDelta === null ? '—' : fmtSignedInt(rfDelta)}</td>
          <td class="text-end" title="不良存貨 SKU 佔店內貨品比率＝No. of Overstock SKU (P90D 0 Sales) ÷ No. of SKU Carry（SKU Carry = RF + ND with Stock）">${ovsRatio === null ? '—' : fmtRatio(ovsRatio)}</td>
          <td class="text-end">${fmtMoney(row.deadstock_value)}</td>
          <td class="text-end">${fmtMoney(row.shop_stock_value)}</td>
          <td class="text-end"><b>${zero ? '—' : fmtRatio(ratio)}</b>${zero ? '<div class="text-secondary small">存貨值 0，除零</div>' : ''}</td>
          <td class="text-end ${wowClass(wow)}">${row.is_new ? `<span class="text-secondary small">${row.new_reason === 'new_store' ? '新店' : '上期無數據'}</span>` : (wow === null ? '—' : `${wowArrow(wow)}${fmtPt(wow)}`)}</td>
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

  /**
   * 「已排除」提示：預設只佔一行，點開才列出店號與店名，
   * 免得十幾間店的清單把 Top 15 擠下去。點店號可直接只看該店明細。
   * groups：[{ rows, label }]，只有有店的組別會顯示。
   */
  function excludedNote(groups, notes) {
    const group = (rows, label) => {
      if (!rows.length) return '';
      const items = rows
        .slice()
        .sort((a, b) => String(a.site_code || '').localeCompare(String(b.site_code || '')))
        .map((row) => `<button type="button" class="stk-excluded-item" data-stk-site="${escAttr(row.site_code || '')}" title="按一下只看 ${escAttr(row.site_code || '')} 的明細"><b>${esc(row.site_code || '')}</b>${esc(shortShop(shopLabel(row)))}</button>`)
        .join('');
      return `<div class="stk-excluded-group"><span class="stk-excluded-label">${label}</span>${items}</div>`;
    };
    return `<details class="stk-excluded" open>
      <summary>已排除 ${notes.join('、')}，不參與排名（仍計入全公司合計與每店明細）。<span class="stk-excluded-hint">看名單</span></summary>
      <div class="stk-excluded-body">${groups.map(({ rows, label }) => group(rows, label)).join('')}</div>
    </details>`;
  }

  function renderTop15() {
    const wrap = $('stk_top15');
    if (!wrap) return;
    const newStoreRows = weekRows.filter((row) => row.new_reason === 'new_store');
    const noPrevRows = weekRows.filter((row) => row.new_reason === 'no_prev_data');
    const notes = [];
    if (newStoreRows.length) notes.push(`${newStoreRows.length} 間新店（開業未滿 ${weekGraceDays} 天）`);
    if (noPrevRows.length) notes.push(`${noPrevRows.length} 間上期無數據`);
    const note = notes.length
      ? excludedNote([
        { rows: newStoreRows, label: '新店' },
        { rows: noPrevRows, label: '上期無數據' },
      ], notes)
      : '';
    const ranked = weekRows
      .filter((row) => !row.is_new && num(row.ratio) !== null)
      .sort((a, b) => (num(b.ratio) || 0) - (num(a.ratio) || 0))
      .slice(0, 15);
    if (!ranked.length) {
      wrap.innerHTML = `<div class="text-secondary small">此期沒有可比較的店舖（全部為新店，或店舖存貨值為 0 或全部缺值）。</div>${note}`;
      return;
    }
    const max = num(ranked[0].ratio) || 1;
    wrap.innerHTML = ranked.map((row, index) => {
      const ratio = num(row.ratio) || 0;
      const wow = num(row.wow_delta_pt);
      const width = Math.max(2, Math.min(100, (ratio / max) * 100));
      const om = String(row.om || '').trim();
      const nature = String(row.shop_nature || '').trim();
      const meta = [om ? `OM ${om}` : '', nature].filter(Boolean).join(' · ');
      return `<button type="button" class="stk-bar-row" data-stk-site="${escAttr(row.site_code || '')}" title="按一下只看 ${escAttr(row.site_code || '')} 的明細">
        <span class="stk-bar-rank">${index + 1}</span>
        <span class="stk-bar-name">
          <span class="stk-bar-title"><b>${esc(row.site_code || '')}</b><span class="stk-bar-shop">${esc(shortShop(shopLabel(row)))}</span></span>
          ${meta ? `<span class="stk-bar-meta" title="${escAttr(natureTitle(nature))}">${esc(meta)}</span>` : ''}
        </span>
        <span class="stk-bar-track"><i style="width:${width.toFixed(1)}%;background:${ratio >= 0.1 ? '#c0392b' : COLOR_MAIN}"></i></span>
        <span class="stk-bar-value">${fmtRatio(ratio)}</span>
        <span class="stk-bar-wow ${wowClass(wow)}">${wow === null ? '' : `${wowArrow(wow)}${fmtPt(wow)}`}</span>
      </button>`;
    }).join('') + note;
  }

  /** RF 是實際 SKU 數，不像不良存貨比率排名需要排除新店；所有有效數字都參與。 */
  function renderTop15Rf(week) {
    const wrap = $('stk_rf_top15');
    const label = $('stk_rf_top15_label');
    if (!wrap) return;
    const weekLabel = String(week ?? selectedWeek ?? '').slice(0, 10);
    const candidates = weekRows
      .filter((row) => num(row.rf_sku_count) !== null)
      .sort((a, b) => (num(b.rf_sku_count) || 0) - (num(a.rf_sku_count) || 0)
        || String(a.site_code || '').localeCompare(String(b.site_code || '')));
    if (label) label.textContent = weekLabel
      ? `${weekLabel} · ${candidates.length} 店有 RF 資料`
      : '—';
    if (!candidates.length) {
      wrap.innerHTML = `<div class="text-secondary small">${weekRows.length
        ? '此期沒有有效 No. of RF SKU 資料；空白或無效值不會當作 0。'
        : '上載報表或選擇批次後會顯示 RF SKU 店舖排名。'}</div>`;
      return;
    }

    const ranked = candidates.slice(0, 15);
    const max = Math.max(1, num(ranked[0].rf_sku_count) || 0);
    wrap.innerHTML = ranked.map((row, index) => {
      const rf = num(row.rf_sku_count) || 0;
      const delta = num(row.rf_sku_delta);
      const width = Math.max(2, Math.min(100, (rf / max) * 100));
      const om = String(row.om || '').trim();
      const nature = String(row.shop_nature || '').trim();
      const meta = [om ? `OM ${om}` : '', nature].filter(Boolean).join(' · ');
      return `<button type="button" class="stk-bar-row" data-stk-site="${escAttr(row.site_code || '')}" title="按一下只看 ${escAttr(row.site_code || '')} 的明細">
        <span class="stk-bar-rank">${index + 1}</span>
        <span class="stk-bar-name">
          <span class="stk-bar-title"><b>${esc(row.site_code || '')}</b><span class="stk-bar-shop">${esc(shortShop(shopLabel(row)))}</span></span>
          ${meta ? `<span class="stk-bar-meta" title="${escAttr(natureTitle(nature))}">${esc(meta)}</span>` : ''}
        </span>
        <span class="stk-bar-track"><i style="width:${width.toFixed(1)}%;background:${COLOR_RF}"></i></span>
        <span class="stk-bar-value">${fmtInt(rf)}</span>
        <span class="stk-bar-wow text-secondary" title="RF SKU 較上期">${delta === null ? '' : fmtSignedInt(delta)}</span>
      </button>`;
    }).join('');
  }

  /**
   * 「不良存貨 SKU 佔店內貨品比率」Top 15（＝ No. of Overstock SKU (P90D 0 Sales) ÷ No. of SKU Carry）。
   * 排除規則與價值比率 Top 15 同一套新店規則（報表旗標＋觀察期／上期無數據）。
   * 分子必為分母子集（Carry = RF + ND with Stock 覆蓋店內全部有貨 SKU），比率不超過 100%，
   * 所以不需要最低分母門檻——HA43 這類 RF 極少的店在新分母下是正常數字。
   * 比率 ≥ OVS_CARRY_RATIO_ALERT 以紅色顯示；右側欄顯示分子÷分母原數，方便核對。
   */
  function renderTop15OvsCarry(week) {
    const wrap = $('stk_ovscarry_top15');
    const label = $('stk_ovscarry_top15_label');
    if (!wrap) return;
    const newStoreRows = weekRows.filter((row) => row.new_reason === 'new_store');
    const noPrevRows = weekRows.filter((row) => row.new_reason === 'no_prev_data');
    const notes = [];
    if (newStoreRows.length) notes.push(`${newStoreRows.length} 間新店（開業未滿 ${weekGraceDays} 天）`);
    if (noPrevRows.length) notes.push(`${noPrevRows.length} 間上期無數據`);
    const note = notes.length
      ? excludedNote([
        { rows: newStoreRows, label: '新店' },
        { rows: noPrevRows, label: '上期無數據' },
      ], notes)
      : '';
    const ranked = weekRows
      .filter((row) => !row.is_new && num(row.ovs_carry_ratio) !== null)
      .sort((a, b) => (num(b.ovs_carry_ratio) || 0) - (num(a.ovs_carry_ratio) || 0)
        || String(a.site_code || '').localeCompare(String(b.site_code || '')))
      .slice(0, 15);
    if (label) {
      label.textContent = ranked.length
        ? `${String(week ?? selectedWeek ?? '').slice(0, 10)} · ${ranked.length} 店入榜`
        : '—';
    }
    if (!ranked.length) {
      wrap.innerHTML = `<div class="text-secondary small">${weekRows.length
        ? '此期沒有可比較的店舖（全部為新店，或缺 SKU Carry／不良存貨 SKU 數據）。'
        : '上載報表或選擇批次後會顯示排名。'}</div>${note}`;
      return;
    }
    const max = num(ranked[0].ovs_carry_ratio) || 1;
    wrap.innerHTML = ranked.map((row, index) => {
      const ratio = num(row.ovs_carry_ratio) || 0;
      const carry = num(row.sku_carry_count) ?? 0;
      const ovs = num(row.sku_count_0sale) ?? 0;
      const width = Math.max(2, Math.min(100, (ratio / max) * 100));
      const om = String(row.om || '').trim();
      const nature = String(row.shop_nature || '').trim();
      const meta = [om ? `OM ${om}` : '', nature].filter(Boolean).join(' · ');
      return `<button type="button" class="stk-bar-row" data-stk-site="${escAttr(row.site_code || '')}" title="按一下只看 ${escAttr(row.site_code || '')} 的明細">
        <span class="stk-bar-rank">${index + 1}</span>
        <span class="stk-bar-name">
          <span class="stk-bar-title"><b>${esc(row.site_code || '')}</b><span class="stk-bar-shop">${esc(shortShop(shopLabel(row)))}</span></span>
          ${meta ? `<span class="stk-bar-meta" title="${escAttr(natureTitle(nature))}">${esc(meta)}</span>` : ''}
        </span>
        <span class="stk-bar-track"><i style="width:${width.toFixed(1)}%;background:${ratio >= OVS_CARRY_RATIO_ALERT ? '#c0392b' : COLOR_MAIN}"></i></span>
        <span class="stk-bar-value">${fmtRatio(ratio)}</span>
        <span class="stk-bar-wow text-secondary" title="不良存貨 SKU ÷ SKU Carry（分母 = RF + ND with Stock）">${fmtInt(ovs)} / ${fmtInt(carry)}</span>
      </button>`;
    }).join('') + note;
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
      if (body) body.innerHTML = '<tr><td colspan="11" class="text-center text-secondary">尚未有批次，上載後會顯示每店明細</td></tr>';
      const top = $('stk_top15');
      if (top) top.innerHTML = '<div class="text-secondary small">上載報表後會顯示排名。</div>';
      renderTop15Rf('');
      renderTop15OvsCarry('');
      renderWeekRows();
      return;
    }
    if (body) body.innerHTML = '<tr><td colspan="11" class="text-center text-secondary">載入中…</td></tr>';
    try {
      const data = (await aFetch(`/api/admin/stock/weeks/${encodeURIComponent(target)}`)) || {};
      selectedWeek = String(data.report_date || target).slice(0, 10);
      weekRows = Array.isArray(data.rows) ? data.rows : [];
      weekTotals = data.totals || null;
      weekGraceDays = num(data.new_store_grace_days) ?? weekGraceDays;
      const storeCount = firstNum([weekTotals && weekTotals.store_count]) ?? weekRows.length;
      const ratio = firstNum([weekTotals && weekTotals.ratio]);
      if (label) {
        label.textContent = `${selectedWeek} · ${storeCount} 店${ratio === null ? '' : ` · 合計佔比 ${fmtRatio(ratio)}`}`;
      }
      renderTop15();
      renderTop15Rf(selectedWeek);
      renderTop15OvsCarry(selectedWeek);
      if (mtdPeriodInfo && selectedWeek === mtdPeriodInfo.date) {
        mtdWeekDate = selectedWeek;
        mtdWeekRows = weekRows;
        renderMtdRanking();
      }
      renderWeekRows();
    } catch (err) {
      weekRows = [];
      weekTotals = null;
      if (label) label.textContent = target;
      setResult('stk_week_error', 'error', `未能載入 ${target} 的明細：${err.message}`);
      if (body) body.innerHTML = `<tr><td colspan="11" class="text-center text-danger">${esc(err.message)}</td></tr>`;
      const top = $('stk_top15');
      if (top) top.innerHTML = '<div class="text-secondary small">未能載入排名。</div>';
      renderTop15Rf(target);
      renderTop15OvsCarry(target);
      renderWeekRows();
    }
  }

  /* ==================== 總刷新 ==================== */

  async function refreshAll() {
    // 每次刷新都重新取 MTD 明細；若主明細剛好是 MTD 期，loadMtdWeek 會直接重用
    mtdWeekDate = '';
    mtdWeekRows = [];
    mtdPeriodInfo = null;
    await loadSummary();
    if (!selectedWeek) {
      const last = latestPoint();
      selectedWeek = last ? String(last.report_date).slice(0, 10) : '';
    }
    await Promise.all([loadBatches(), loadWeek(selectedWeek)]);
    await loadMtdWeek();
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

    // 三個 Top 15：按一下只看該店明細
    ['stk_top15', 'stk_rf_top15', 'stk_ovscarry_top15'].forEach((id) => {
      const ranking = $(id);
      if (!ranking) return;
      ranking.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target.closest('[data-stk-site]') : null;
        if (!target) return;
        const q = $('stk_q');
        if (q) q.value = target.dataset.stkSite || '';
        weekPage = 1;
        renderWeekRows();
      });
    });

    // MTD 排名：按一下切到該期並只看該店（排名期可能同目前明細期不同）
    const mtdRank = $('stk_mtd_rank');
    if (mtdRank) {
      mtdRank.addEventListener('click', async (e) => {
        const target = e.target instanceof Element ? e.target.closest('[data-stk-mtd-site]') : null;
        if (!target) return;
        const date = String(target.dataset.stkMtdDate || mtdWeekDate || '').slice(0, 10);
        const site = String(target.dataset.stkMtdSite || '');
        if (date && date !== selectedWeek) {
          selectedWeek = date;
          await loadWeek(date);
        }
        const q = $('stk_q');
        if (q) q.value = site;
        weekPage = 1;
        renderWeekRows();
        const label = $('stk_week_label');
        if (label && label.scrollIntoView) label.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    // 匯出目前顯示期間的趨勢數字（Excel；不會改任何資料）
    const exportBtn = $('btn_stk_export');
    if (exportBtn) exportBtn.addEventListener('click', downloadTrendExport);

    // 每店明細匯出（跟住畫面篩選）
    const detailExportBtn = $('btn_stk_detail_export');
    if (detailExportBtn) detailExportBtn.addEventListener('click', downloadDetailExport);

    // RF SKU Dashboard 匯出（走勢 + 兩張排名）
    const rfExportBtn = $('btn_stk_rf_export');
    if (rfExportBtn) rfExportBtn.addEventListener('click', downloadRfExport);

    // 趨勢圖顯示期間（3 / 6 / 12 / 24 個月；兩張卡同步，資料本身永久保留，只影響畫幾多）
    const rangeEls = [$('stk_range'), $('stk_group_range')].filter(Boolean);
    if (rangeEls.length) {
      rangeEls.forEach((rangeEl) => {
        rangeEl.addEventListener('click', (e) => {
          const btn = e.target instanceof Element ? e.target.closest('[data-stk-months]') : null;
          if (!btn) return;
          const months = Number(btn.dataset.stkMonths);
          if (!Number.isFinite(months) || months === chartMonths) return;
          chartMonths = months;
          rangeEls.forEach((el) => {
            el.querySelectorAll('[data-stk-months]').forEach((b) => {
              b.setAttribute('aria-pressed', String(Number(b.dataset.stkMonths) === months));
            });
          });
          const series = normalizedSeries(summaryCache);
          if (series.length) {
            renderGroupChart(summaryCache, series);
            renderChart(summaryCache, series);
            renderRfChart(series);
          }
        });
      });
    }

    // RF 走勢圖口徑：RF SKU 數 / 不良存貨 SKU 佔店內貨品比率
    const rfMetricEl = $('stk_rf_metric');
    if (rfMetricEl) {
      rfMetricEl.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('[data-stk-rf-metric]') : null;
        if (!btn) return;
        const metric = btn.dataset.stkRfMetric === 'ratio' ? 'ratio' : 'count';
        if (metric === rfMetric) return;
        rfMetric = metric;
        rfMetricEl.querySelectorAll('[data-stk-rf-metric]').forEach((b) => {
          b.setAttribute('aria-pressed', String(b.dataset.stkRfMetric === metric));
        });
        const series = normalizedSeries(summaryCache);
        if (series.length) renderRfChart(series);
      });
    }

    // 分組小圖：口徑（SKU / 存貨值）與維度（Shop Nature / OM）
    const groupMetricEl = $('stk_group_metric');
    if (groupMetricEl) {
      groupMetricEl.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('[data-stk-group-metric]') : null;
        if (!btn) return;
        const metric = btn.dataset.stkGroupMetric === 'value' ? 'value' : 'sku';
        if (metric === groupMetric) return;
        groupMetric = metric;
        groupMetricEl.querySelectorAll('[data-stk-group-metric]').forEach((b) => {
          b.setAttribute('aria-pressed', String(b.dataset.stkGroupMetric === metric));
        });
        const series = normalizedSeries(summaryCache);
        if (series.length) renderGroupChart(summaryCache, series);
        renderMtdRanking();
      });
    }

    const groupDimEl = $('stk_group_dim');
    if (groupDimEl) {
      groupDimEl.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('[data-stk-group-dim]') : null;
        if (!btn) return;
        const dim = btn.dataset.stkGroupDim === 'om' ? 'om' : 'nature';
        if (dim === groupDim) return;
        groupDim = dim;
        groupDimEl.querySelectorAll('[data-stk-group-dim]').forEach((b) => {
          b.setAttribute('aria-pressed', String(b.dataset.stkGroupDim === dim));
        });
        const series = normalizedSeries(summaryCache);
        if (series.length) renderGroupChart(summaryCache, series);
        renderMtdRanking();
      });
    }

    const qEl = $('stk_q');
    if (qEl) qEl.addEventListener('input', () => { weekPage = 1; renderWeekRows(); });    ['stk_sort', 'stk_only'].forEach((id) => {
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
