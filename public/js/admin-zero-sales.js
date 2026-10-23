/* Admin 90日零銷售批次管理 (獨立於 admin.js，避免衝突) */
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = null;
  let currentBatch = null;
  let selectedOm = '';
  let reasonsCache = [];
  let itemRows = [];
  let batchesCache = [];
  let repeatSkuRows = [];
  let zsBatchPage = 1;
  const ZS_BATCH_PAGE_SIZE_KEY = 'ndrf_admin_zs_batch_page_size';

  function currentZsBatchPageSize() {
    const v = Number($('zs_batch_page_size')?.value || 20);
    return [20, 50, 100].includes(v) ? v : 20;
  }

  async function getCsrf() {
    if (!csrf) {
      const d = await fetch('/api/csrf', { credentials: 'same-origin' }).then((r) => r.json());
      csrf = d.token;
    }
    return csrf;
  }
  async function aFetch(url, opts = {}) {
    const token = await getCsrf();
    const headers = { ...(opts.headers || {}), 'x-csrf-token': token };
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `請求失敗 (${res.status})`);
    return data;
  }
  // 統計/匯出用 GET：不經 CSRF（與現有批次匯出 <a href> 一致，只帶 cookie）
  async function gFetch(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const ct = res.headers.get('Content-Type') || '';
    if (!res.ok) {
      if (ct.includes('json')) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `請求失敗 (${res.status})`);
      }
      throw new Error(`請求失敗 (${res.status})`);
    }
    if (ct.includes('json')) return res.json();
    return res.blob();
  }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }
  function setText(id, v) {
    const el = $(id);
    if (el) el.textContent = v;
  }

  /* ISO 8601 週次（星期一開始，適用 2026/2027/2028 及任何年份） */
  function parseDateInput(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return null;
    const d = new Date(`${str}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function isoWeekOfDate(d) {
    const day = (d.getDay() + 6) % 7; // Mon=0..Sun=6
    const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 3, 12);
    const isoYear = thursday.getFullYear();
    const jan4 = new Date(isoYear, 0, 4, 12);
    const jan4day = (jan4.getDay() + 6) % 7;
    const week1Mon = new Date(isoYear, 0, 4 - jan4day, 12);
    const week = Math.round((thursday.getTime() - week1Mon.getTime()) / (7 * 86400000)) + 1;
    const monday = new Date(week1Mon.getTime() + (week - 1) * 7 * 86400000);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    return { isoYear, week, label: `${isoYear}-W${String(week).padStart(2, '0')}`, monday, sunday };
  }
  function mondayOfIsoWeek(isoYear, week) {
    const jan4 = new Date(isoYear, 0, 4, 12);
    const jan4day = (jan4.getDay() + 6) % 7;
    return new Date(isoYear, 0, 4 - jan4day + (week - 1) * 7, 12);
  }
  function setWeekHint(html) {
    const hint = $('zs_week_hint');
    if (hint) hint.innerHTML = html;
  }
  function refreshWeekFromDate() {
    const dateEl = $('zs_week_date');
    const weekEl = $('zs_week');
    if (!dateEl || !weekEl) return;
    const d = parseDateInput(dateEl.value);
    if (!d) {
      setWeekHint('選擇日期後自動填入 ISO 週次，可再手改');
      return;
    }
    const info = isoWeekOfDate(d);
    weekEl.value = info.label;
    setWeekHint(`${esc(info.label)} ｜ ${esc(fmtDate(info.monday))}（一）至 ${esc(fmtDate(info.sunday))}（日）`);
  }
  function refreshHintFromWeek() {
    const weekEl = $('zs_week');
    if (!weekEl) return;
    const m = /^(\d{4})-W(\d{2})$/.exec((weekEl.value || '').trim());
    if (!m) {
      setWeekHint('格式例如 2026-W40（星期一開始的 ISO 週）');
      return;
    }
    const isoYear = Number(m[1]);
    const week = Number(m[2]);
    if (week < 1 || week > 53) {
      setWeekHint('週數應為 01 至 53');
      return;
    }
    const monday = mondayOfIsoWeek(isoYear, week);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    // 驗證該週確實屬於該 ISO 年（例如 2026 沒有 W01 以外的邊界問題由 Date 自動處理，仍顯示實際範圍）
    setWeekHint(`${esc(weekEl.value.trim())} ｜ ${esc(fmtDate(monday))}（一）至 ${esc(fmtDate(sunday))}（日）`);
  }

  async function loadBatches(resetPage = false) {
    if (resetPage) zsBatchPage = 1;
    const body = $('zs_batches_body');
    if (!body) return;
    try {
      const params = new URLSearchParams({ page: String(zsBatchPage), page_size: String(currentZsBatchPageSize()) });
      const data = await aFetch(`/api/admin/zero-sales/batches?${params.toString()}`);
      const pages = Number(data.total_pages) || 0;
      if (pages > 0 && Number(data.page) > pages) {
        zsBatchPage = pages;
        return loadBatches();
      }
      zsBatchPage = Number(data.page) || 1;
      const rows = data.batches || [];
      batchesCache = data.batch_options || rows;
      fillExportBatchSelect(batchesCache);
      fillStatsBatchSelect(batchesCache);
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="8" class="text-center text-secondary">暫無批次</td></tr>';
        AdminPager.render({
          nav: $('zs_batch_page_numbers'),
          range: $('zs_batch_page_range'),
          page: zsBatchPage,
          total: data.total,
          pageSize: currentZsBatchPageSize(),
          onPage: (page) => { zsBatchPage = page; loadBatches(); },
          unit: '個批次',
        });
        return;
      }
      body.innerHTML = rows.map((b) => {
        const statusTag = b.is_open
          ? '<span class="badge-zs badge-zs-ok">開放中</span>'
          : `<span class="badge-zs badge-zs-muted">已封存</span><div class="text-secondary small">${b.close_reason === 'auto' ? '自動封存於' : '封存於'} ${esc(b.closed_at || '')}</div>`;
        const toggleBtn = b.is_open
          ? `<button class="btn btn-sm btn-outline-secondary" data-zs-close="${b.id}" data-week="${esc(b.week_label)}">封存</button>`
          : `<button class="btn btn-sm btn-outline-primary" data-zs-reopen="${b.id}" data-week="${esc(b.week_label)}">重開</button>`;
        const autoFillBtn = b.is_open
          ? `<button class="btn btn-sm btn-outline-warning" data-zs-autofill="${b.id}" data-week="${esc(b.week_label)}">自動套用重複回覆</button>`
          : '';
        return `<tr>
        <td><b>${esc(b.week_label)}</b><div class="text-secondary small">${esc(b.note || '')}</div><div class="mt-1">${statusTag}</div></td>
        <td>${b.row_count}</td><td>${b.store_count}</td>
        <td class="text-success">${b.replied_count ?? 0}</td><td class="${b.is_open ? 'text-danger' : 'text-secondary'}">${b.pending_count ?? 0}</td>
        <td>${esc(b.created_by)}</td><td>${esc(b.created_at)}</td>
        <td><div class="d-flex gap-1 flex-wrap">
          <button class="btn btn-sm" data-zs-view="${b.id}">明細</button>
          <a class="btn btn-sm btn-outline-primary" href="/api/admin/zero-sales/batches/${b.id}/export">匯出</a>
          ${autoFillBtn}
          ${toggleBtn}
          <button class="btn btn-sm btn-outline-danger" data-zs-del="${b.id}" data-week="${esc(b.week_label)}" data-rows="${b.row_count}">刪除</button>
        </div></td></tr>`;
      }).join('');
      body.querySelectorAll('[data-zs-view]').forEach((btn) => {
        btn.addEventListener('click', () => { currentBatch = btn.dataset.zsView; syncExportBatchSelect(); loadItems(); });
      });
      body.querySelectorAll('[data-zs-close]').forEach((btn) => {
        btn.addEventListener('click', () => closeBatch(btn.dataset.zsClose, btn.dataset.week || ''));
      });
      body.querySelectorAll('[data-zs-reopen]').forEach((btn) => {
        btn.addEventListener('click', () => reopenBatch(btn.dataset.zsReopen, btn.dataset.week || ''));
      });
      body.querySelectorAll('[data-zs-autofill]').forEach((btn) => {
        btn.addEventListener('click', () => autoFillRepeats(btn.dataset.zsAutofill, btn.dataset.week || ''));
      });
      body.querySelectorAll('[data-zs-del]').forEach((btn) => {
        btn.addEventListener('click', () => deleteBatch(btn.dataset.zsDel, btn.dataset.week || '', Number(btn.dataset.rows || 0)));
      });
      if (!currentBatch && rows[0]) currentBatch = rows[0].id;
      syncExportBatchSelect();
      AdminPager.render({
        nav: $('zs_batch_page_numbers'),
        range: $('zs_batch_page_range'),
        page: zsBatchPage,
        total: data.total,
        pageSize: currentZsBatchPageSize(),
        onPage: (page) => { zsBatchPage = page; loadBatches(); },
        unit: '個批次',
      });
    } catch (err) {
      body.innerHTML = `<tr><td colspan="8" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  function batchOptionLabel(b) {
    const total = (b.replied_count ?? 0) + (b.pending_count ?? 0);
    return `${esc(b.week_label)}（共 ${total}｜未 ${b.pending_count ?? 0}）${b.is_open ? '' : '｜已封存'}`;
  }

  function fillExportBatchSelect(rows) {
    const sel = $('zs_exp_batch');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部批次</option>' + rows.map((b) => `<option value="${b.id}">${batchOptionLabel(b)}</option>`).join('');
    if (cur) sel.value = cur;
  }

  /* 統計總覽的範圍下拉：預設跨批次，可選單一批次（不跨批次統計） */
  function fillStatsBatchSelect(rows) {
    const sel = $('zs_stats_batch');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部批次（跨批次）</option>' + rows.map((b) => `<option value="${b.id}">${batchOptionLabel(b)}</option>`).join('');
    sel.value = rows.some((b) => b.id === cur) ? cur : '';
  }

  function syncExportBatchSelect() {
    const sel = $('zs_exp_batch');
    if (sel && currentBatch) {
      const has = [...sel.options].some((o) => o.value === currentBatch);
      if (has) sel.value = currentBatch;
    }
  }

  async function loadItems(opts = {}) {
    const res = $('zs_items_result');
    const body = $('zs_items_body');
    if (!currentBatch) { if (res) res.innerHTML = '<div class="alert alert-info">請先選擇批次</div>'; return; }
    const site = ($('zs_filter_site').value || '').trim();
    const status = $('zs_filter_status').value;
    const qs = new URLSearchParams();
    if (site) qs.set('site_code', site);
    if (status) qs.set('status', status);
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${currentBatch}/items?${qs.toString()}`);
      const rows = data.items || [];
      itemRows = rows;
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="9" class="text-center text-secondary">此篩選沒有資料</td></tr>';
        return;
      }
      const limitOf = (i) => Number(i.reply_limit) >= 2 ? Number(i.reply_limit) : (i.auto_filled_at ? 3 : 2);
      if (res) res.innerHTML = `<div class="text-secondary small">批次 ${esc(currentBatch.slice(0, 8))}｜共 ${rows.length} 筆｜已回覆 ${rows.filter((r) => r.status === 'replied').length}｜已鎖定（用完修改） ${rows.filter((r) => (r.reply_count ?? (r.status === 'replied' ? 1 : 0)) >= limitOf(r)).length}${rows[0]?.is_open === false ? '｜<b>此批次已封存，店舖不可再回覆（管理員可代回覆）</b>' : ''} <a href="/api/admin/zero-sales/batches/${currentBatch}/export">匯出 Excel</a></div>`;
      const archived = rows[0]?.is_open === false;
      body.innerHTML = rows.slice(0, 200).map((i) => {
        const n = i.reply_count ?? (i.status === 'replied' ? 1 : 0);
        const limit = limitOf(i);
        const left = Math.max(0, limit - n);
        const auto = !!i.auto_filled_at;
        const upDate = i.batch_date || (i.batch_created_at || '').slice(0, 10);
        const lockTag = n >= limit
          ? ' <span class="badge-zs badge-zs-muted">已鎖定</span>'
          : (left > 0 ? ` <span class="text-secondary small">可再改${left}次</span>` : '');
        const editBtn = i.status === 'replied'
          ? `<button class="btn btn-sm" data-zs-item-edit="${i.id}">編輯回覆</button>`
          : `<button class="btn btn-sm" data-zs-item-edit="${i.id}">代回覆</button>`;
        const enteredByAdmin = (i.replied_by || '').startsWith('管理員代填');
        const statusBadge = i.status === 'replied'
          ? `<span class="badge-zs badge-zs-ok">已回覆${archived ? '（已封存）' : ''}</span>${auto ? ` <span class="badge-zs badge-zs-info">自動套用${i.auto_filled_from_week ? ` ${esc(i.auto_filled_from_week)}` : ''}</span>` : ''}${enteredByAdmin ? ' <span class="badge-zs badge-zs-info">代填</span>' : ''}`
          : `<span class="badge-zs ${archived ? 'badge-zs-muted' : 'badge-zs-warn'}">未回覆${archived ? '（已截止）' : ''}</span>`;
        return `<tr>
        <td>${esc(i.site_code)}</td><td>${esc(i.sku)}</td>
        <td>${esc(i.payload?.['Brand'] || '')}</td><td>${esc(i.payload?.['SKU Desc'] || '')}</td>
        <td>${esc(upDate)}</td>
        <td>${statusBadge}</td>
        <td style="white-space:nowrap">${n}/${limit}次${lockTag}</td>
        <td>${esc(i.reason_label || '')}${i.reason_note ? `（${esc(i.reason_note)}）` : ''}</td>
        <td><div class="d-flex gap-1 flex-wrap">${editBtn}<button class="btn btn-sm btn-outline-danger" data-zs-item-del="${i.id}" data-site="${esc(i.site_code)}" data-sku="${esc(i.sku)}">刪除</button></div></td></tr>`;
      }).join('')
        + (rows.length > 200 ? `<tr><td colspan="9" class="text-center text-secondary">只顯示首 200 筆，請匯出 Excel 查看全部</td></tr>` : '');
      body.querySelectorAll('[data-zs-item-edit]').forEach((btn) => {
        btn.addEventListener('click', () => openEditReply(btn.dataset.zsItemEdit, btn));
      });
      body.querySelectorAll('[data-zs-item-del]').forEach((btn) => {
        btn.addEventListener('click', () => deleteItem(currentBatch, btn.dataset.zsItemDel, btn.dataset.site || '', btn.dataset.sku || '', btn));
      });
      // 彈窗儲存後重載：焦點回到同一列的編輯按鈕，頁面不跳動
      if (opts.preserveFocusId) {
        const back = body.querySelector(`[data-zs-item-edit="${opts.preserveFocusId}"]`);
        if (back) back.focus({ preventScroll: true });
      }
    } catch (err) {
      if (res) res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  async function upload() {
    const res = $('zs_upload_result');
    const file = $('zs_file').files[0];
    let week = ($('zs_week').value || '').trim();
    if (!week && $('zs_week_date')?.value) {
      refreshWeekFromDate();
      week = ($('zs_week').value || '').trim();
    }
    if (!week) { res.innerHTML = '<div class="alert alert-danger">請選擇日期或填寫週次（例如 2026-W40）</div>'; return; }
    if (!file) { res.innerHTML = '<div class="alert alert-danger">請選擇 .xlsx</div>'; return; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('week_label', week);
    fd.append('note', $('zs_note').value || '');
    fd.append('auto_fill_repeats', $('zs_auto_fill_upload')?.checked === false ? '0' : '1');
    res.innerHTML = '<div class="alert alert-info">上載中…</div>';
    try {
      const data = await aFetch('/api/admin/zero-sales/batches', { method: 'POST', body: fd });
      const closed = (data.closedBatches || []);
      const closedText = closed.length
        ? `；已自動封存 ${closed.map((b) => `「${esc(b.week_label)}」（${b.pending} 個未回覆 SKU）`).join('、')}`
        : '';
      const autoText = data.autoFilled ? `；已自動套用 ${data.autoFilled} 個重複 SKU 的上次回覆` : '';
      res.innerHTML = `<div class="alert alert-success">已建立批次（${data.totalRows} 行）${autoText}${closedText}。舊週次已轉為唯讀，店舖不能再回覆。</div>`;
      $('zs_file').value = '';
      await loadBatches(true);
      await loadSummary();
      refreshRepeatsIfOpen();
    } catch (err) {
      res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  /* 統計總覽 -------------------------------------------------------- */
  /* 頂部總覽卡永遠顯示跨批次數字；下方區內統計跟隨 zs_stats_batch 下拉：
     不選批次 = 跨批次，選了批次 = 只統計該批次（後端 summary?batch_id= 已支援） */
  async function loadSummary() {
    const note = $('zs_summary_note');
    const statBox = $('zs_stats_result');
    const reasonBody = $('zs_reason_stats_body');
    const omBody = $('zs_om_stats_body');
    const scopeBatch = $('zs_stats_batch')?.value || '';
    const scopeLabel = scopeBatch ? (batchesCache.find((b) => b.id === scopeBatch)?.week_label || '') : '';
    try {
      const [overall, scoped] = await Promise.all([
        gFetch('/api/admin/zero-sales/summary'),
        scopeBatch ? gFetch(`/api/admin/zero-sales/summary?batch_id=${encodeURIComponent(scopeBatch)}`) : Promise.resolve(null),
      ]);
      const s = scoped || overall;
      // 頂部總覽卡（跨批次）：第一行總計、第二行最新週次
      const o = overall;
      setText('s_zs_total_batches', `${o.batches ?? 0} 個批次`);
      setText('s_zs_total', String(o.total ?? 0));
      setText('s_zs_replied', String(o.replied ?? 0));
      setText('s_zs_pending', String(o.pending ?? 0));
      setText('s_zs_overdue', String(o.overdue ?? 0));
      setText('s_zs_rate', `${o.reply_rate ?? 0}%`);
      setText('s_zs_stores', `${o.stores_total ?? 0} / ${o.stores_pending ?? 0}`);
      const lbOverall = o.latest_batch;
      if (lbOverall) {
        // 已封存的最新週次：未回覆屬歷史（逾期），不再是可回覆的待辦
        const open = !!lbOverall.is_open;
        setText('s_zs_latest_week', `${lbOverall.week_label} · ${open ? '開放中' : '已封存'}`);
        setText('l_zs_total', String(lbOverall.total ?? 0));
        setText('l_zs_replied', String(lbOverall.replied ?? 0));
        setText('l_zs_pending', open ? String(lbOverall.pending ?? 0) : '—');
        setText('l_zs_overdue', open ? '—' : String(lbOverall.pending ?? 0));
        const lbRate = lbOverall.total ? Math.round((lbOverall.replied / lbOverall.total) * 1000) / 10 : 0;
        setText('l_zs_rate', `${lbRate}%`);
        setText('l_zs_stores', `${lbOverall.stores_total ?? 0} / ${open ? (lbOverall.stores_pending ?? 0) : '—'}`);
      } else {
        setText('s_zs_latest_week', '暫無批次');
        ['l_zs_total', 'l_zs_replied', 'l_zs_pending', 'l_zs_overdue', 'l_zs_rate', 'l_zs_stores']
          .forEach((id) => setText(id, '—'));
      }
      if (note) {
        note.textContent = o.total
          ? `已鎖定 ${o.locked} 行`
          : '暫無零銷售資料';
      }
      // 區內統計（跟隨下拉範圍）
      const lb = s.latest_batch;
      if (statBox) {
        const head = scopeBatch
          ? `批次 <b>${esc(scopeLabel || scopeBatch.slice(0, 8))}</b>｜`
          : `共 <b>${s.batches}</b> 個批次｜`;
        statBox.innerHTML = `${head}總 <b>${s.total}</b> 行｜已回覆 <b class="text-success">${s.replied}</b>｜未回覆 <b class="text-danger">${s.pending}</b>${s.overdue ? `｜逾期未回覆 <b class="text-secondary">${s.overdue}</b>（已封存）` : ''}｜回覆率 <b>${s.reply_rate}%</b>｜涉及 <b>${s.stores_total}</b> 間店（<b>${s.stores_pending}</b> 間仍有待回覆${s.stores_overdue ? `，<b>${s.stores_overdue}</b> 間有逾期未回覆` : ''}，<b>${s.stores_done}</b> 間已完成）｜已鎖定（用完修改） <b>${s.locked}</b> 行`
          + (scopeBatch ? '' : (s.repeat_groups ? `｜重複上榜 <b class="text-danger">${s.repeat_groups}</b> 組（${s.repeat_rows} 行）` : '｜重複上榜 0 組'))
          + (!scopeBatch && lb ? `<br>最新批次：<b>${esc(lb.week_label)}</b> ${lb.replied}/${lb.total}（未 ${lb.pending}）｜${esc(lb.created_at)}` : '');
      }
      // 原因分佈
      if (reasonBody) {
        const rows = s.by_reason || [];
        if (!rows.length) {
          reasonBody.innerHTML = '<tr><td colspan="3" class="text-center text-secondary">暫無已回覆資料</td></tr>';
        } else {
          const denom = Math.max(1, s.replied || 0);
          reasonBody.innerHTML = rows.map((r) => {
            const pct = Math.round((r.count / denom) * 1000) / 10;
            return `<tr><td>${esc(r.reason_label || r.reason_code)}</td><td>${r.count}</td><td>${pct}%</td></tr>`;
          }).join('');
        }
      }
      // 待回覆店舖（按 OM 匯總，點 OM 下鑽看店舖名單）
      if (omBody) {
        const rows = (s.pending_by_om || []).filter((r) => (r.stores_pending ?? 0) > 0 || (r.pending ?? 0) > 0);
        if (!rows.length) {
          omBody.innerHTML = '<tr><td colspan="4" class="text-center text-secondary">目前沒有待回覆店舖（已封存的逾期紀錄不計）</td></tr>';
          hideOmStores();
        } else {
          omBody.innerHTML = rows.map((r) => {
            const active = selectedOm && r.om === selectedOm ? ' btn-primary' : '';
            return `<tr>
              <td><b>${esc(r.om || '（未設定）')}</b><div class="text-secondary small">共 ${r.stores_total ?? 0} 間店</div></td>
              <td class="text-danger"><b>${r.stores_pending ?? 0}</b></td>
              <td class="text-danger"><b>${r.pending ?? 0}</b></td>
              <td><button class="btn btn-sm${active}" data-zs-om="${esc(r.om || '（未設定）')}">查看店舖</button></td>
            </tr>`;
          }).join('');
          omBody.querySelectorAll('[data-zs-om]').forEach((btn) => {
            btn.addEventListener('click', () => { selectedOm = btn.dataset.zsOm || ''; loadOmStores(); });
          });
          // 轉批次後：已選 OM 若仍在名單內就跟著切範圍重載，否則收起
          if (selectedOm) {
            if (rows.some((r) => (r.om || '（未設定）') === selectedOm)) loadOmStores(true);
            else hideOmStores();
          }
        }
      }
    } catch (err) {
      if (note) note.textContent = `統計載入失敗：${err.message}`;
      if (statBox) statBox.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
      if (reasonBody) reasonBody.innerHTML = `<tr><td colspan="3" class="text-center text-danger">${esc(err.message)}</td></tr>`;
      if (omBody) omBody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  function hideOmStores() {
    selectedOm = '';
    const wrap = $('zs_om_stores_wrap');
    if (wrap) wrap.hidden = true;
  }

  /* OM 下鑽：顯示該 OM 仍有待回覆的店舖名單（跟隨上方批次範圍） */
  async function loadOmStores(keepSelection) {
    const wrap = $('zs_om_stores_wrap');
    const title = $('zs_om_stores_title');
    const body = $('zs_om_stores_body');
    if (!wrap || !body) return;
    if (!selectedOm) { wrap.hidden = true; return; }
    const scopeBatch = $('zs_stats_batch')?.value || '';
    const qs = new URLSearchParams();
    if (scopeBatch) qs.set('batch_id', scopeBatch);
    qs.set('om', selectedOm);
    wrap.hidden = false;
    if (title) title.innerHTML = `OM「<b>${esc(selectedOm)}</b>」待回覆店舖 <span class="text-secondary">（載入中…）</span>`;
    body.innerHTML = '<tr><td colspan="5" class="text-center text-secondary">載入中…</td></tr>';
    try {
      const data = await gFetch(`/api/admin/zero-sales/pending-stores?${qs.toString()}`);
      const rows = data.stores || [];
      if (title) title.innerHTML = `OM「<b>${esc(selectedOm)}</b>」待回覆店舖（<b>${rows.length}</b> 間） <button class="btn btn-sm ms-2" id="zs_om_close">收起</button>`;
      const closeBtn = $('zs_om_close');
      if (closeBtn) closeBtn.addEventListener('click', () => { hideOmStores(); loadSummary(); });
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" class="text-center text-secondary">此 OM 已全部回覆完成</td></tr>';
        return;
      }
      body.innerHTML = rows.map((r) => `<tr>
        <td><b>${esc(r.site_code)}</b></td><td>${esc(r.shop || '—')}</td>
        <td>${r.total}</td><td class="text-success">${r.replied}</td><td class="text-danger"><b>${r.pending}</b></td>
      </tr>`).join('');
      if (!keepSelection) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      if (title) title.textContent = `OM「${selectedOm}」待回覆店舖`;
      body.innerHTML = `<tr><td colspan="5" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  /* 重複上榜 SKU 統計（同店同 SKU 跨週 ≥2 次） ---------------------- */
  async function loadRepeats() {
    const body = $('zs_repeat_body');
    const res = $('zs_repeat_result');
    if (!body) return;
    const site = ($('zs_rep_site')?.value || '').trim();
    const q = ($('zs_rep_q')?.value || '').trim();
    const min = $('zs_rep_min')?.value || '2';
    const qs = new URLSearchParams();
    if (site) qs.set('site_code', site);
    if (q) qs.set('q', q);
    if (min) qs.set('min_count', min);
    qs.set('limit', '200');
    if (res) res.innerHTML = '<div class="text-secondary small">查詢中…</div>';
    try {
      const data = await gFetch(`/api/admin/zero-sales/repeats?${qs.toString()}`);
      const rows = data.repeats || [];
      if (res) res.innerHTML = rows.length
        ? `共 <b>${rows.length}</b> 組重複上榜（只顯示首 200，搜尋可收窄）`
        : '沒有重複上榜 SKU（全部只出現過一次）。';
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="10" class="text-center text-secondary">沒有重複上榜 SKU</td></tr>';
        return;
      }
      body.innerHTML = rows.slice(0, 200).map((r) => {
        const weeks = (r.weeks || []).map((w) => esc(w)).join(' → ');
        const lastReply = r.last_reason_label
          ? `${esc(r.last_reason_label)}${r.last_reason_note ? `（${esc(r.last_reason_note)}）` : ''}`
          : (r.last_status === 'replied' ? '已回覆' : '<span class="text-danger">未回覆</span>');
        return `<tr>
          <td><b>${esc(r.site_code)}</b></td><td>${esc(r.shop || '—')}</td>
          <td>${esc(r.om || '—')}</td>
          <td>${esc(r.sku)}</td><td>${esc(r.brand || '')}</td><td>${esc(r.sku_desc || '')}</td>
          <td><b class="text-danger">${r.occurrence_count} 次</b></td>
          <td class="small">${weeks}</td>
          <td class="small">${esc(r.last_week_label || '')}｜${r.last_status === 'replied' ? '<span class="badge-zs badge-zs-ok">已回覆</span>' : '<span class="badge-zs badge-zs-warn">未回覆</span>'}<br>${lastReply}</td>
          <td>未 <b class="text-danger">${r.pending_count}</b> / 已 <span class="text-success">${r.replied_count}</span></td>
        </tr>`;
      }).join('');
    } catch (err) {
      if (res) res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
      body.innerHTML = `<tr><td colspan="10" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  /* 跨店重複上榜 SKU 排行（Top 10） -------------------------------- */
  /** 以重複店數及重複率給出參考判斷：多店重複 → SKU 問題；單店重複 → 店舖問題 */
  function repeatSkuVerdict(r) {
    const rate = Number(r.repeat_rate) || 0;
    if (r.repeat_store_count >= 3 && rate >= 0.5) {
      return '<span class="badge-zs badge-zs-warn">SKU 問題</span>';
    }
    if (r.repeat_store_count >= 2 && rate >= 0.5) {
      return '<span class="badge-zs badge-zs-info">疑似 SKU</span>';
    }
    return '<span class="badge-zs badge-zs-muted">店舖問題</span>';
  }

  async function loadRepeatSkus() {
    const body = $('zs_repeat_sku_body');
    const res = $('zs_repeat_sku_result');
    if (!body) return;
    const q = ($('zs_rep_sku_q')?.value || '').trim();
    const min = $('zs_rep_sku_min')?.value || '2';
    const limit = $('zs_rep_sku_limit')?.value || '10';
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    qs.set('min_count', min);
    qs.set('limit', limit);
    if (res) res.innerHTML = '<div class="text-secondary small">查詢中…</div>';
    try {
      const data = await gFetch(`/api/admin/zero-sales/repeat-skus?${qs.toString()}`);
      const rows = data.skus || [];
      repeatSkuRows = rows;
      const skuIssueCount = rows.filter((r) => r.repeat_store_count >= 3 && Number(r.repeat_rate) >= 0.5).length;
      if (res) res.innerHTML = rows.length
        ? `共 <b>${rows.length}</b> 款 SKU 符合條件（按重複店數排序）${skuIssueCount ? `；其中 <b class="text-danger">${skuIssueCount}</b> 款屬 SKU 問題` : ''}`
        : '沒有符合條件的重複上榜 SKU。';
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="13" class="text-center text-secondary">沒有重複上榜 SKU</td></tr>';
        return;
      }
      body.innerHTML = rows.map((r, i) => {
        const rate = Math.round((Number(r.repeat_rate) || 0) * 100);
        return `<tr>
          <td>${i + 1}</td>
          <td><b>${esc(r.sku)}</b></td>
          <td>${esc(r.brand || '')}</td>
          <td>${esc(r.sku_desc || '')}</td>
          <td class="${r.repeat_store_count >= 3 ? 'text-danger fw-bold' : ''}">${r.repeat_store_count} 店</td>
          <td>${r.listed_store_count} 店</td>
          <td>${rate}%</td>
          <td>${r.repeat_rows} / ${r.total_rows}</td>
          <td>${r.max_occurrence} 次</td>
          <td class="small">${esc(r.last_week_label || '')}${r.last_seen ? `<br><span class="text-secondary">${esc(r.last_seen)}</span>` : ''}</td>
          <td>未 <b class="text-danger">${r.pending_count}</b> / 已 <span class="text-success">${r.replied_count}</span></td>
          <td>${repeatSkuVerdict(r)}</td>
          <td><button type="button" class="btn btn-sm" data-repeat-idx="${i}">查看店舖</button></td>
        </tr>`;
      }).join('');
    } catch (err) {
      if (res) res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
      body.innerHTML = `<tr><td colspan="13" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  /** 匯出重複上榜統計：skus = 跨店 Top SKU；pairs = 各店明細 */
  async function downloadRepeatExport(kind) {
    const isSku = kind === 'skus';
    const btn = $(isSku ? 'btn_zs_repeat_sku_export' : 'btn_zs_repeat_export');
    const res = $(isSku ? 'zs_repeat_sku_export_result' : 'zs_repeat_export_result');
    const qs = new URLSearchParams();
    if (isSku) {
      const q = ($('zs_rep_sku_q')?.value || '').trim();
      const min = $('zs_rep_sku_min')?.value || '2';
      const limit = $('zs_rep_sku_limit')?.value || '10';
      if (q) qs.set('q', q);
      qs.set('min_count', min);
      qs.set('limit', limit);
    } else {
      const site = ($('zs_rep_site')?.value || '').trim();
      const q = ($('zs_rep_q')?.value || '').trim();
      const min = $('zs_rep_min')?.value || '2';
      if (site) qs.set('site_code', site);
      if (q) qs.set('q', q);
      qs.set('min_count', min);
    }
    const original = isSku ? '匯出 Top SKU' : '匯出各店明細';
    if (btn) { btn.disabled = true; btn.textContent = '匯出中…'; }
    if (res) res.innerHTML = '<div class="text-secondary small">匯出中…</div>';
    try {
      const response = await fetch(`/api/admin/zero-sales/${isSku ? 'repeat-skus' : 'repeats'}/export?${qs}`, { credentials: 'same-origin' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: '匯出失敗' }));
        throw new Error(data.error || '匯出失敗');
      }
      const blob = await response.blob();
      const disp = response.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? match[1] : (isSku ? 'Zero_Sales_Repeat_SKU.xlsx' : 'Zero_Sales_Repeat_Detail.xlsx');
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (res) res.innerHTML = `<div class="text-success small">匯出成功${isSku ? '（Top SKU）' : '（各店明細，最多 5000 行）'}。</div>`;
    } catch (err) {
      if (res) res.innerHTML = `<div class="text-danger small">${esc(err.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  /** 重複上榜區塊預設收起：收起時不載入（省版面及請求），已展開才同步刷新 */
  function refreshRepeatsIfOpen() {
    const wrap = $('zs_repeat_collapse');
    if (wrap && wrap.classList.contains('show')) {
      loadRepeatSkus();
      loadRepeats();
    }
  }

  /* 刪除：批次 / 批次某店 / 批次某店某SKU（二次確認，不可還原） ---- */

  function confirmZsDelete(title, lines, okLabel = '確認刪除', danger = true) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'zs_delete_overlay';
      overlay.innerHTML = `<div class="modal-box" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
        <h3 class="${danger ? 'text-danger' : ''}">${esc(title)}</h3>
        ${(lines || []).map((l) => `<p class="text-secondary small" style="margin:6px 0">${esc(l)}</p>`).join('')}
        <div class="d-flex gap-2 justify-content-end mt-4">
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okLabel)}</button>
          <button class="btn" data-cancel>取消</button>
        </div></div>`;
      document.body.appendChild(overlay);
      applyModalFallback(overlay);
      lockBodyScroll();
      const done = (v) => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        unlockBodyScroll();
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      overlay.querySelector('[data-ok]').addEventListener('click', () => done(true));
      overlay.querySelector('[data-cancel]').addEventListener('click', () => done(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
      document.addEventListener('keydown', onKey);
      overlay.querySelector('[data-cancel]').focus();
    });
  }

  function zsDeleteResult(html, scroll = true) {
    const el = $('zs_delete_result');
    if (el) {
      el.innerHTML = html;
      if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  /* 彈窗共用：鎖住背景捲動、ESC/點背景關閉、關閉後回到觸發按鈕 ---- */
  function lockBodyScroll() {
    document.body.classList.add('zs-modal-open');
  }
  function unlockBodyScroll() {
    if (!document.querySelector('#zs_edit_reply_overlay, #zs_reason_edit_overlay, #zs_delete_overlay')) {
      document.body.classList.remove('zs-modal-open');
    }
  }

  /* 關鍵定位改用 inline style：即使瀏覽器拿著舊版 admin.css，彈窗仍會
     置中顯示，不會變成全幅區塊貼在頁尾。完整美化仍由 admin.css 提供。 */
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

  async function refreshAfterDelete() {
    await loadBatches();
    await loadSummary();
    refreshRepeatsIfOpen();
    if (currentBatch) await loadItems();
  }

  async function closeBatch(batchId, weekLabel) {
    if (!batchId) return;
    const ok = await confirmZsDelete('確認封存此週次？', [
      `週次：${weekLabel || batchId.slice(0, 8)}`,
      '封存後店舖即時不可再回覆或修改，該週次會轉為灰色唯讀紀錄。',
      '已提交的回覆與統計會保留；可隨時按「重開」讓店舖補答。',
    ], '確認封存', false);
    if (!ok) return;
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${batchId}/close`, { method: 'PUT' });
      const note = data.pending
        ? `（${data.pending} 個 SKU 未回覆，已轉為逾期紀錄）`
        : '（所有 SKU 已回覆）';
      $('zs_batch_result').innerHTML = `<div class="alert alert-success">已封存「${esc(data.week_label)}」${note}。</div>`;
      await loadBatches();
      await loadSummary();
      refreshRepeatsIfOpen();
    } catch (err) {
      $('zs_batch_result').innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  async function reopenBatch(batchId, weekLabel) {
    if (!batchId) return;
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${batchId}/reopen`, { method: 'PUT' });
      $('zs_batch_result').innerHTML = `<div class="alert alert-success">已重開「${esc(data.week_label || weekLabel)}」，店舖現可補答；下次上載新批次時會再次自動封存。</div>`;
      await loadBatches();
      await loadSummary();
      refreshRepeatsIfOpen();
    } catch (err) {
      $('zs_batch_result').innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  /** 為已派發中的批次補套用重複 SKU 上次回覆（預設只限完全未回覆店舖） */
  async function autoFillRepeats(batchId, weekLabel) {
    if (!batchId) return;
    const onlyUnreplied = $('zs_autofill_only_unreplied')?.checked !== false;
    const ok = await confirmZsDelete('確認自動套用重複回覆？', [
      `週次：${weekLabel || batchId.slice(0, 8)}`,
      onlyUnreplied
        ? '只會套用於「完全未回覆」的店舖；店舖只要有任何一行自行回覆，全店跳過。'
        : '會套用於所有仍「未回覆」的 SKU；已回覆的店舖及 SKU 仍不會被覆寫。',
      '系統會複製同店同 SKU 上一次的店舖回覆（原因 + 補充說明），店舖可按橙色「修改」鍵再改 2 次。',
    ], '確認套用', false);
    if (!ok) return;
    $('zs_batch_result').innerHTML = '<div class="alert alert-info">自動套用中…</div>';
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${batchId}/auto-fill`, {
        method: 'POST',
        body: JSON.stringify({ only_unreplied_stores: onlyUnreplied }),
      });
      const scope = onlyUnreplied ? '只限完全未回覆店舖' : '包括部分已回覆店舖的未回覆 SKU';
      $('zs_batch_result').innerHTML = `<div class="alert alert-success">已自動套用「${esc(data.week_label || weekLabel)}」<b>${data.applied}</b> 個重複 SKU（${esc(scope)}）。批次原有 ${data.pending_before} 個未回覆，現剩 <b>${data.remaining_pending}</b> 個；已回覆的店舖及 SKU 未被更改。</div>`;
      currentBatch = batchId;
      syncExportBatchSelect();
      await loadBatches();
      await loadSummary();
      refreshRepeatsIfOpen();
      if (currentBatch) await loadItems();
    } catch (err) {
      $('zs_batch_result').innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  async function deleteBatch(batchId, weekLabel, rowCount) {
    if (!batchId) return;
    const ok = await confirmZsDelete('確認刪除整個批次？', [
      `批次：${weekLabel || batchId.slice(0, 8)}（共 ${rowCount} 行）`,
      '該批次全部 SKU 行（含店舖已提交的回覆）將一併清除，店舖不再看到這些指派。',
      '此操作不可還原。如只上載錯部分店舖，請改用下面的店舖級刪除。',
    ]);
    if (!ok) return;
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${batchId}`, { method: 'DELETE' });
      if (currentBatch === batchId) currentBatch = null;
      zsDeleteResult(`<div class="alert alert-success">已刪除批次「${esc(weekLabel)}」（${data.deleted_items ?? rowCount} 行）。</div>`);
      await refreshAfterDelete();
    } catch (err) {
      zsDeleteResult(`<div class="alert alert-danger">${esc(err.message)}</div>`);
    }
  }

  async function deleteBatchSite() {
    const res = $('zs_delete_result');
    if (!currentBatch) {
      if (res) res.innerHTML = '<div class="alert alert-danger">請先按「明細」選擇一個批次</div>';
      return;
    }
    const site = (($('zs_filter_site')?.value || '').trim() || '').toUpperCase();
    if (!site) {
      if (res) res.innerHTML = '<div class="alert alert-danger">請先在「篩選 Site Code」填寫店舖（例如 HC63），再按刪除</div>';
      return;
    }
    const ok = await confirmZsDelete('確認刪除此店此批次資料？', [
      `店舖：${site}`,
      '該店在此批次的全部 SKU 行（含已回覆）將被清除，其他店不受影響。',
      '此操作不可還原。',
    ]);
    if (!ok) return;
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${currentBatch}/sites/${encodeURIComponent(site)}`, { method: 'DELETE' });
      zsDeleteResult(`<div class="alert alert-success">已刪除「${esc(site)}」在此批次的 ${data.deleted_items} 行。</div>`);
      await refreshAfterDelete();
    } catch (err) {
      zsDeleteResult(`<div class="alert alert-danger">${esc(err.message)}</div>`);
    }
  }

  async function deleteItem(batchId, itemId, site, sku, btn) {
    if (!batchId || !itemId) return;
    const ok = await confirmZsDelete('確認刪除此 SKU 行？', [
      `店舖：${site}｜SKU：${sku}`,
      '該行（含店舖已提交的回覆，如有）將被清除，同批次其他行不受影響。',
      '此操作不可還原。',
    ]);
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.textContent = '刪除中…'; }
    try {
      await aFetch(`/api/admin/zero-sales/batches/${batchId}/items/${itemId}`, { method: 'DELETE' });
      zsDeleteResult(`<div class="alert alert-success">已刪除「${esc(site)}｜${esc(sku)}」。</div>`);
      await refreshAfterDelete();
    } catch (err) {
      zsDeleteResult(`<div class="alert alert-danger">${esc(err.message)}</div>`);
      if (btn) { btn.disabled = false; btn.textContent = '刪除'; }
    }
  }

  /* 管理員代改店舖回覆（不受鎖定限制，不佔用店舖修改次數） ---- */

  async function ensureReasons() {
    if (reasonsCache.length) return reasonsCache;
    const data = await aFetch('/api/admin/zero-sales/reasons');
    reasonsCache = (data.reasons || []).filter((r) => r.active);
    return reasonsCache;
  }

  function openEditReply(itemId, triggerBtn) {
    const item = itemRows.find((x) => x.id === itemId);
    if (!item) return;
    openEditReplyOverlay(item, triggerBtn);
  }

  function openEditReplyOverlay(item, triggerBtn) {
    const entering = item.status !== 'replied';
    const auto = !!item.auto_filled_at;
    const overlay = document.createElement('div');
    overlay.id = 'zs_edit_reply_overlay';
    overlay.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-label="${entering ? '代店舖輸入回覆' : '編輯店舖回覆'}">
      <h3>${entering ? '代店舖輸入回覆' : '編輯店舖回覆'}</h3>
      <p class="text-secondary small" style="margin:6px 0">店舖：${esc(item.site_code)}｜SKU：${esc(item.sku)}${item.replied_by ? `｜原回覆人：${esc(item.replied_by)}` : ''}${auto ? `｜系統自動套用${item.auto_filled_from_week ? `自 ${esc(item.auto_filled_from_week)}` : ''}` : ''}｜${item.is_open === false ? '此週次已封存' : '此週次仍開放'}</p>
      <div class="mb-2"><label class="form-label">回覆原因</label><select id="zs_edit_reason" class="form-select"><option value="">載入中…</option></select></div>
      <div class="mb-2"><label class="form-label">補充說明</label><textarea id="zs_edit_note" class="form-control" rows="3" maxlength="2000" placeholder="${entering ? '如店舖以 email 補交，建議註明日期及提供者' : '選擇須補充的原因時必填'}"></textarea></div>
      <p class="text-secondary small" style="margin:6px 0">${entering
        ? (item.is_open === false
          ? '店舖截單後以 email 補交時使用：儲存後狀態變為「已回覆」，回覆人記錄為「管理員代填（你的帳號）」，並寫入審計日誌。'
          : '此週次仍開放，店舖可自行回覆；如你代填，店舖仍可再修改一次（系統自動套用的行可再改 2 次）。')
        : (auto
          ? '此行由系統自動套用上次回覆；管理員修改不受鎖定限制，亦不佔用店舖的修改次數，更改會記錄在審計日誌。'
          : '管理員修改不受鎖定限制，亦不佔用店舖的修改次數；更改會記錄在審計日誌。')}</p>
      <div id="zs_edit_reply_error" class="text-danger small"></div>
      <div class="d-flex gap-2 justify-content-end mt-3">
        <button class="btn btn-primary" data-save>儲存</button>
        <button class="btn" data-cancel>取消</button>
      </div></div>`;
    document.body.appendChild(overlay);
    applyModalFallback(overlay);
    lockBodyScroll();
    const sel = overlay.querySelector('#zs_edit_reason');
    const note = overlay.querySelector('#zs_edit_note');
    const errBox = overlay.querySelector('#zs_edit_reply_error');
    const saveBtn = overlay.querySelector('[data-save]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      unlockBodyScroll();
      if (triggerBtn && document.contains(triggerBtn)) triggerBtn.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', async () => {
      errBox.textContent = '';
      const reasonCode = sel.value;
      const reason = reasonsCache.find((r) => r.code === reasonCode);
      const noteVal = (note.value || '').trim();
      if (!reasonCode) {
        errBox.textContent = '請選擇回覆原因';
        return;
      }
      if (reason?.require_note && !noteVal) {
        errBox.textContent = `選擇「${reason.label}」必須填寫補充說明`;
        return;
      }
      saveBtn.disabled = true; saveBtn.textContent = '儲存中…';
      try {
        const saved = await aFetch(`/api/admin/zero-sales/batches/${currentBatch}/items/${item.id}/reply`, {
          method: 'PUT',
          body: JSON.stringify({ reason_code: reasonCode, reason_note: noteVal }),
        });
        const editedId = item.id;
        const editedLabel = `${item.site_code}｜${item.sku}`;
        close();
        // 原地提示、不捲動頁面（避免跳去最底），再重載明細並停留原位
        const y = window.scrollY;
        if (currentBatch) await loadItems({ preserveFocusId: editedId });
        const action = saved?.entered ? '已代填回覆' : '已更新回覆';
        zsDeleteResult(`<div class="alert alert-success">${action}：${esc(editedLabel)}。</div>`, false);
        if (typeof y === 'number') window.scrollTo(0, y);
      } catch (err) {
        errBox.textContent = err.message;
        saveBtn.disabled = false; saveBtn.textContent = '儲存';
      }
    });
    ensureReasons().then((reasons) => {
      if (!reasons.length) { errBox.textContent = '沒有可用的回覆原因選項'; sel.innerHTML = '<option value="">—</option>'; return; }
      sel.innerHTML = reasons.map((r) => `<option value="${esc(r.code)}"${r.code === item.reason_code ? ' selected' : ''}>${esc(r.label)}</option>`).join('');
      note.value = item.reason_note || '';
      sel.focus();
    }).catch((err) => { errBox.textContent = err.message; });
    document.addEventListener('keydown', onKey);
  }

  /* 統一匯出 -------------------------------------------------------- */
  function buildExportQuery(onlyUnreplied) {
    const qs = new URLSearchParams();
    const batch = $('zs_exp_batch')?.value || '';
    const site = ($('zs_exp_site')?.value || '').trim();
    const status = $('zs_exp_status')?.value || '';
    const reason = $('zs_exp_reason')?.value || '';
    if (batch) qs.set('batch_id', batch);
    if (site) qs.set('site_code', site);
    if (onlyUnreplied) qs.set('status', 'pending');
    else if (status) qs.set('status', status);
    if (reason) qs.set('reason_code', reason);
    return qs.toString();
  }

  async function downloadExport(onlyUnreplied) {
    const res = $('zs_export_result');
    const btn = onlyUnreplied ? $('btn_zs_export_unreplied') : $('btn_zs_export');
    const qs = buildExportQuery(onlyUnreplied);
    if (btn) { btn.disabled = true; btn.textContent = '匯出中…'; }
    if (res) res.innerHTML = '<div class="alert alert-info">匯出中…</div>';
    try {
      const response = await fetch(`/api/admin/zero-sales/export?${qs}`, { credentials: 'same-origin' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: '匯出失敗' }));
        throw new Error(data.error || '匯出失敗');
      }
      const blob = await response.blob();
      const disp = response.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? match[1] : 'Zero_Sales_Export.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (res) res.innerHTML = '<div class="alert alert-success">匯出成功（唯讀，不會鎖定店舖回覆）。</div>';
    } catch (err) {
      if (res) res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = onlyUnreplied ? '只匯出未回覆' : '匯出 Excel'; }
    }
  }

  function init() {
    if (!$('zs_batches_body')) return;
    $('btn_zs_upload').addEventListener('click', upload);
    // 日期選擇自動計 ISO 週次（星期一開始）
    const dateEl = $('zs_week_date');
    const weekEl = $('zs_week');
    if (dateEl) dateEl.addEventListener('change', refreshWeekFromDate);
    if (weekEl) weekEl.addEventListener('input', refreshHintFromWeek);
    // 預設帶今日日期並自動填週次（例如 2026/09/29 = 2026-W40）
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (dateEl && !dateEl.value) dateEl.value = today;
      if (weekEl && !weekEl.value.trim()) refreshWeekFromDate();
      else refreshHintFromWeek();
    } catch {}
    $('btn_zs_view').addEventListener('click', loadItems);
    const delSiteBtn = $('btn_zs_delete_site');
    if (delSiteBtn) delSiteBtn.addEventListener('click', deleteBatchSite);
    const reasonBtn = $('btn_zs_reason_save');
    if (reasonBtn) reasonBtn.addEventListener('click', saveReason);
    const statsBtn = $('btn_zs_stats_refresh');
    if (statsBtn) statsBtn.addEventListener('click', loadSummary);
    const statsBatchSel = $('zs_stats_batch');
    if (statsBatchSel) statsBatchSel.addEventListener('change', loadSummary);
    const expBtn = $('btn_zs_export');
    if (expBtn) expBtn.addEventListener('click', () => downloadExport(false));
    const expUnreplied = $('btn_zs_export_unreplied');
    if (expUnreplied) expUnreplied.addEventListener('click', () => downloadExport(true));
    const expBatch = $('zs_exp_batch');
    if (expBatch) expBatch.addEventListener('change', () => {
      const v = expBatch.value;
      if (v) { currentBatch = v; loadItems(); }
    });
    const repBtn = $('btn_zs_repeat');
    if (repBtn) repBtn.addEventListener('click', loadRepeats);
    const repExport = $('btn_zs_repeat_export');
    if (repExport) repExport.addEventListener('click', () => downloadRepeatExport('pairs'));
    const repSkuBtn = $('btn_zs_repeat_sku');
    if (repSkuBtn) repSkuBtn.addEventListener('click', loadRepeatSkus);
    const repSkuExport = $('btn_zs_repeat_sku_export');
    if (repSkuExport) repSkuExport.addEventListener('click', () => downloadRepeatExport('skus'));
    const repSkuLimit = $('zs_rep_sku_limit');
    if (repSkuLimit) repSkuLimit.addEventListener('change', loadRepeatSkus);
    const repSkuMin = $('zs_rep_sku_min');
    if (repSkuMin) repSkuMin.addEventListener('change', loadRepeatSkus);
    const repSkuQ = $('zs_rep_sku_q');
    if (repSkuQ) {
      repSkuQ.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); loadRepeatSkus(); }
      });
    }
    const repSkuBody = $('zs_repeat_sku_body');
    if (repSkuBody) {
      repSkuBody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-repeat-idx]');
        if (!btn) return;
        const row = repeatSkuRows[Number(btn.getAttribute('data-repeat-idx'))];
        if (!row) return;
        const qInput = $('zs_rep_q');
        if (qInput) qInput.value = row.sku || '';
        const minSelect = $('zs_rep_min');
        if (minSelect) minSelect.value = $('zs_rep_sku_min')?.value || '2';
        loadRepeats();
      });
    }
    AdminPager.bindSize($('zs_batch_page_size'), ZS_BATCH_PAGE_SIZE_KEY, () => {
      zsBatchPage = 1;
      loadBatches();
    });
    // 重複上榜區塊預設收起，展開時才載入資料
    const repWrap = $('zs_repeat_collapse');
    if (repWrap) repWrap.addEventListener('shown.bs.collapse', () => { loadRepeatSkus(); loadRepeats(); });
    // 懶載入：捲動到零銷售區塊才請求 batches / reasons / summary，首屏更快
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      loadBatches();
      loadReasons();
      loadSummary();
    };
    // 供頂部「立即更新」一併刷新（重複上榜收起時不載入）
    globalThis.__zsRefresh = () => { started = true; loadBatches(); loadReasons(); loadSummary(); refreshRepeatsIfOpen(); };
    const anchor = $('zs_card') || $('zs_batches_body');
    if (!('IntersectionObserver' in window)) { start(); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { start(); io.disconnect(); }
      });
    }, { rootMargin: '500px 0px' });
    io.observe(anchor);
  }

  async function loadReasons() {
    const body = $('zs_reasons_body');
    if (!body) return;
    try {
      const data = await aFetch('/api/admin/zero-sales/reasons');
      const rows = data.reasons || [];
      reasonsCache = rows.filter((r) => r.active);
      // 同步匯出篩選的原因下拉
      const expReason = $('zs_exp_reason');
      if (expReason) {
        const cur = expReason.value;
        expReason.innerHTML = '<option value="">全部原因</option>' + rows.filter((r) => r.active).map((r) => `<option value="${esc(r.code)}">${esc(r.label)}</option>`).join('');
        if (cur) expReason.value = cur;
      }
      if (!rows.length) { body.innerHTML = '<tr><td colspan="6" class="text-center text-secondary">暫無原因</td></tr>'; return; }
      body.innerHTML = rows.map((r) => `<tr>
        <td>${esc(r.code)}</td><td>${esc(r.label)}</td><td>${r.sort_order}</td>
        <td>${r.require_note ? '是' : '否'}</td><td>${r.active ? '<span class="badge-zs badge-zs-ok">啟用</span>' : '<span class="badge-zs badge-zs-muted">停用</span>'}</td>
        <td><div class="d-flex gap-1">
          <button class="btn btn-sm" data-zs-reason-edit="${esc(r.code)}">編輯</button>
          <button class="btn btn-sm btn-outline-danger" data-zs-reason-toggle="${esc(r.code)}" data-active="${r.active ? 0 : 1}">${r.active ? '停用' : '啟用'}</button>
        </div></td></tr>`).join('');
      body.querySelectorAll('[data-zs-reason-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = rows.find((x) => x.code === btn.dataset.zsReasonEdit);
          if (!row) return;
          openReasonEditOverlay(row, btn);
        });
      });
      body.querySelectorAll('[data-zs-reason-toggle]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = rows.find((x) => x.code === btn.dataset.zsReasonToggle);
          if (!row) return;
          await aFetch('/api/admin/zero-sales/reasons', {
            method: 'PUT',
            body: JSON.stringify({ code: row.code, label: row.label, sort_order: row.sort_order, active: btn.dataset.active === '1', require_note: row.require_note }),
          });
          await loadReasons();
        });
      });
    } catch (err) {
      body.innerHTML = `<tr><td colspan="6" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  async function saveReason() {
    const res = $('zs_reason_result');
    const code = ($('zs_reason_code').value || '').trim();
    const label = ($('zs_reason_label').value || '').trim();
    if (!code || !label) { res.innerHTML = '<div class="alert alert-danger">Code 及顯示名稱為必填</div>'; return; }
    try {
      await aFetch('/api/admin/zero-sales/reasons', {
        method: 'PUT',
        body: JSON.stringify({
          code,
          label,
          sort_order: Number($('zs_reason_sort').value || 0),
          active: $('zs_reason_active').value === 'true',
          require_note: $('zs_reason_reqnote').value === 'true',
        }),
      });
      res.innerHTML = '<div class="alert alert-success">已儲存</div>';
      await loadReasons();
    } catch (err) {
      res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  /* 回覆原因選項的編輯彈窗（原 inline 填表會跳去最底，改為彈窗原地處理） ---- */
  function openReasonEditOverlay(row, triggerBtn) {
    const overlay = document.createElement('div');
    overlay.id = 'zs_reason_edit_overlay';
    overlay.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-label="編輯回覆原因">
      <h3>編輯回覆原因</h3>
      <p class="text-secondary small" style="margin:6px 0">Code：${esc(row.code)}（不可更改，如需新 Code 請用下方新增）</p>
      <div class="mb-2"><label class="form-label">顯示名稱</label><input type="text" id="zs_re_label" class="form-control" maxlength="200" value="${esc(row.label)}"></div>
      <div class="d-flex gap-2 flex-wrap">
        <div class="flex-grow-1" style="min-width:100px"><label class="form-label">排序</label><input type="number" id="zs_re_sort" class="form-control" value="${Number(row.sort_order || 0)}"></div>
        <div class="flex-grow-1" style="min-width:100px"><label class="form-label">須補充</label><select id="zs_re_reqnote" class="form-select"><option value="false">否</option><option value="true">是</option></select></div>
        <div class="flex-grow-1" style="min-width:100px"><label class="form-label">啟用</label><select id="zs_re_active" class="form-select"><option value="true">是</option><option value="false">否</option></select></div>
      </div>
      <div id="zs_re_error" class="text-danger small mt-2"></div>
      <div class="d-flex gap-2 justify-content-end mt-3">
        <button class="btn btn-primary" data-save>儲存</button>
        <button class="btn" data-cancel>取消</button>
      </div></div>`;
    document.body.appendChild(overlay);
    applyModalFallback(overlay);
    lockBodyScroll();
    const labelEl = overlay.querySelector('#zs_re_label');
    const sortEl = overlay.querySelector('#zs_re_sort');
    const reqEl = overlay.querySelector('#zs_re_reqnote');
    const activeEl = overlay.querySelector('#zs_re_active');
    const errBox = overlay.querySelector('#zs_re_error');
    const saveBtn = overlay.querySelector('[data-save]');
    reqEl.value = String(Boolean(row.require_note));
    activeEl.value = String(Boolean(row.active));
    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      unlockBodyScroll();
      if (triggerBtn && document.contains(triggerBtn)) triggerBtn.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-cancel]').addEventListener('click', close);
    saveBtn.addEventListener('click', async () => {
      errBox.textContent = '';
      const label = (labelEl.value || '').trim();
      if (!label) { errBox.textContent = '顯示名稱為必填'; return; }
      saveBtn.disabled = true; saveBtn.textContent = '儲存中…';
      try {
        await aFetch('/api/admin/zero-sales/reasons', {
          method: 'PUT',
          body: JSON.stringify({
            code: row.code,
            label,
            sort_order: Number(sortEl.value || 0),
            active: activeEl.value === 'true',
            require_note: reqEl.value === 'true',
          }),
        });
        const y = window.scrollY;
        close();
        await loadReasons();
        const res = $('zs_reason_result');
        if (res) res.innerHTML = `<div class="alert alert-success">已更新原因「${esc(row.code)}」。</div>`;
        window.scrollTo(0, y);
      } catch (err) {
        errBox.textContent = err.message;
        saveBtn.disabled = false; saveBtn.textContent = '儲存';
      }
    });
    document.addEventListener('keydown', onKey);
    labelEl.focus();
    labelEl.select();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
