(() => {
  const $ = (id) => document.getElementById(id);
  let currentPage = 1;
  let totalPages = 1;
  let puPage = 1;
  let batchesPage = 1;
  let currentDetail = null;
  let pendingStoreFile = null;
  let csrfToken = null;
  const FILTER_STORAGE_KEY = 'ndrf_admin_filters_v1';
  const PAGE_SIZE_STORAGE_KEY = 'ndrf_admin_page_size';
  const PU_PAGE_SIZE_KEY = 'ndrf_admin_pu_page_size';
  const BATCH_PAGE_SIZE_KEY = 'ndrf_admin_batch_page_size';
  const DATE_FILTER_IDS = ['f_from', 'f_to', 'e_from', 'e_to', 'ue_from', 'ue_to', 'se_from', 'se_to', 're_from', 're_to'];
  const FILTER_INPUT_IDS = ['f_from', 'f_to', 'f_site', 'f_source', 'f_type', 'f_exported', 'f_workflow_status', 'f_auto_approved', 'f_modified', 'f_sku', 'f_rp_type', 'f_nd_code', 'f_appno'];

  function readStoredFilters() {
    try { return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || 'null'); }
    catch { return null; }
  }

  function persistFilters() {
    try {
      const data = {};
      ['f_from', 'f_to', 'f_site', 'f_source', 'f_type', 'f_exported', 'f_workflow_status', 'f_auto_approved', 'f_modified', 'f_sku', 'f_rp_type', 'f_nd_code', 'f_appno'].forEach((id) => {
        const el = $(id);
        if (el) data[id] = el.value;
      });
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(data));
      const ps = $('f_page_size');
      if (ps) localStorage.setItem(PAGE_SIZE_STORAGE_KEY, ps.value);
    } catch {}
  }

  function restoreStoredFilters() {
    const saved = readStoredFilters();
    if (saved) {
      Object.entries(saved).forEach(([id, v]) => {
        const el = $(id);
        if (el && typeof v === 'string') el.value = v;
      });
      return true;
    }
    return false;
  }

  function restorePageSize() {
    try {
      const saved = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
      const sel = $('f_page_size');
      if (sel && saved && ['20', '50', '100'].includes(saved)) sel.value = saved;
    } catch {}
  }

  function todayInHongKong() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function setDefaultDateFilters() {
    restorePageSize();
    if (restoreStoredFilters()) {
      // 仍為空的日期匯出欄補今日，避免空查詢
      const today = todayInHongKong();
      DATE_FILTER_IDS.forEach((id) => {
        const field = $(id);
        if (field && !field.value) field.value = today;
      });
      return;
    }
    const today = todayInHongKong();
    DATE_FILTER_IDS.forEach((id) => {
      const field = $(id);
      if (field && !field.value) field.value = today;
    });
  }

  async function ensureAuth() {
    try {
      const data = await api('/api/admin/me');
      return data.username;
    } catch {
      return null;
    }
  }

  async function getCsrf() {
    if (!csrfToken) {
      const data = await api('/api/csrf');
      csrfToken = data.token;
    }
    return csrfToken;
  }

  async function adminFetch(url, options = {}) {
    const token = await getCsrf();
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    headers['x-csrf-token'] = token;
    return api(url, { ...options, headers });
  }

  function currentPageSize() {
    const sel = $('f_page_size');
    const v = sel ? Number(sel.value) : 20;
    return [20, 50, 100].includes(v) ? v : 20;
  }

  function currentPuPageSize() {
    const v = Number($('pu_page_size')?.value || 20);
    return [20, 50, 100].includes(v) ? v : 20;
  }

  function currentBatchPageSize() {
    const v = Number($('batch_page_size')?.value || 20);
    return [20, 50, 100].includes(v) ? v : 20;
  }

  function buildQuery() {
    const params = new URLSearchParams();
    const idMap = { application_no: 'appno', submission_type: 'type', site_code: 'site', rp_type: 'rp_type', nd_code: 'nd_code' };
    ['from', 'to', 'site_code', 'source', 'submission_type', 'exported', 'workflow_status', 'auto_approved', 'sku', 'rp_type', 'nd_code', 'application_no', 'modified'].forEach((k) => {
      const el = $(`f_${idMap[k] || k}`);
      const v = el ? el.value.trim() : '';
      if (v) params.set(k, v);
    });
    params.set('page', String(currentPage));
    params.set('page_size', String(currentPageSize()));
    return params.toString();
  }

  function renderSkeletons() {
    const tbody = $('list_body');
    if (!tbody) return;
    const size = Math.min(currentPageSize(), 10);
    tbody.innerHTML = Array.from({ length: size }).map(() => '<tr class="skeleton-row"><td colspan="12"><div class="skeleton-bar"></div></td></tr>').join('');
  }

  async function loadList() {
    showAlert($('list_error'), '', '');
    renderSkeletons();
    try {
      const data = await adminFetch(`/api/admin/submissions?${buildQuery()}`);
      totalPages = data.total_pages;
      if (totalPages > 0 && data.page > totalPages) {
        currentPage = totalPages;
        await loadList();
        return;
      }
      renderList(data);
    } catch (err) {
      showAlert($('list_error'), 'error', escapeHtml(err.message));
      const tbody = $('list_body');
      if (tbody) tbody.innerHTML = '<tr><td colspan="12" class="empty">載入失敗，請重試</td></tr>';
    }
  }

  function renderPager(data) {
    AdminPager.render({
      nav: $('page_numbers'),
      range: $('page_range'),
      page: data.page,
      total: data.total,
      pageSize: data.page_size || currentPageSize(),
      onPage: goToPage,
      unit: '筆',
    });
  }

  function goToPage(page) {
    const target = Math.max(1, Math.min(Number(page) || 1, totalPages || 1));
    if (target === currentPage) return;
    currentPage = target;
    loadList();
  }

  function renderList(data) {
    const tbody = $('list_body');
    tbody.innerHTML = '';
    const badge = $('list_count_badge');
    if (badge) badge.textContent = `共 ${data.total} 筆`;
    if (!data.submissions.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="empty">沒有符合條件的申報<br><span class="hint">試試放寬日期或清除篩選條件</span></td></tr>';
      renderPager(data);
      document.dispatchEvent(new CustomEvent('admin:list-updated', { detail: data }));
      return;
    }
    data.submissions.forEach((s) => {
      const tr = document.createElement('tr');
      tr.dataset.id = s.id;
      if (currentDetail && String(currentDetail.submission?.id) === String(s.id)) tr.classList.add('row-selected');
      const status = s.locked
        ? `<span class="status-badge locked">已鎖定</span>`
        : s.workflow
          ? workflowBadge(s.workflow.status) + (s.workflow.auto_approved_at ? ` <span class="status-badge received" title="Buyer 逾期未回覆，系統默認同意（${escapeHtml(s.workflow.auto_approved_at)}）">SLA 自動批准</span>` : '')
          : `<span class="status-badge received">已收件</span>`;
      tr.innerHTML = `
        <td class="cell-appno">${escapeHtml(s.application_no)}<button type="button" class="btn-copy-appno" data-copy="${escapeHtml(s.application_no)}" title="複製申請編號">複製</button></td>
        <td>${escapeHtml(s.site_code)}${s.store_shop ? `<div class="hint">${escapeHtml(s.store_shop)}</div>` : ''}</td>
        <td>${escapeHtml(s.sku)}${s.submission_type === 'urgent' ? `<div class="hint">QTY: ${escapeHtml(s.qty)}</div>` : s.submission_type === 'return' ? `<div class="hint">QTY: ${escapeHtml(s.return_qty)}<br>${escapeHtml(s.return_reason_label || '')}</div>` : ''}</td>
        <td>${escapeHtml(s.rp_type || '—')}</td>
        <td>${escapeHtml(s.safety_stock || '—')}</td>
        <td>${escapeHtml(s.nd_code || '—')}</td>
        <td>${s.submission_type === 'urgent' ? '<span class="status-badge received">Urgent</span>' : s.submission_type === 'sales' ? '<span class="status-badge received">突發銷售</span>' : s.submission_type === 'return' ? '<span class="status-badge received">行貨退貨</span>' : '一般'}</td>
        <td>${s.source === 'web' ? '網頁' : 'Excel'}</td>
        <td>${escapeHtml(s.submitted_at)}</td>
        <td>${escapeHtml(s.last_modified_at || '—')}</td>
        <td>${status}</td>
        <td><a href="#" class="view-link" data-id="${s.id}">查看／編輯</a></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.view-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        loadDetail(a.dataset.id);
      });
    });
    tbody.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = btn.dataset.copy || '';
        const done = () => {
          const orig = btn.textContent;
          btn.textContent = '已複製';
          setTimeout(() => { btn.textContent = orig; }, 1200);
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
        else {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch {}
          ta.remove();
          done();
        }
      });
    });
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => loadDetail(tr.dataset.id));
    });
    renderPager(data);
    document.dispatchEvent(new CustomEvent('admin:list-updated', { detail: data }));
  }

  function openDetailDrawer() {
    const card = $('detail_card');
    const overlay = $('detail_overlay');
    if (card) {
      card.style.display = '';
      requestAnimationFrame(() => card.classList.add('open'));
    }
    if (overlay) overlay.classList.add('open');
    document.body.classList.add('drawer-open');
  }

  function closeDetailDrawer() {
    const card = $('detail_card');
    const overlay = $('detail_overlay');
    if (card) {
      card.classList.remove('open');
      setTimeout(() => {
        if (!card.classList.contains('open')) card.style.display = 'none';
      }, 220);
    }
    if (overlay) overlay.classList.remove('open');
    document.body.classList.remove('drawer-open');
    currentDetail = null;
  }

  $('btn_filter').addEventListener('click', () => {
    currentPage = 1;
    persistFilters();
    loadList();
  });
  $('btn_reset').addEventListener('click', () => {
    ['site', 'sku', 'appno'].forEach((id) => ($(`f_${id}`).value = ''));
    ['source', 'type', 'exported', 'modified', 'workflow_status', 'auto_approved'].forEach((id) => ($(`f_${id}`).value = ''));
    ['rp_type', 'nd_code'].forEach((id) => ($(`f_${id}`).value = ''));
    $('f_from').value = todayInHongKong();
    $('f_to').value = todayInHongKong();
    currentPage = 1;
    try { localStorage.removeItem(FILTER_STORAGE_KEY); } catch {}
    document.querySelectorAll('#filter_presets .preset-btn').forEach((b) => b.classList.remove('active'));
    loadList();
  });
  // Enter 直接篩選 + 每頁筆數切換
  FILTER_INPUT_IDS.forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        currentPage = 1;
        persistFilters();
        loadList();
      }
    });
  });
  if ($('f_page_size')) {
    $('f_page_size').addEventListener('change', () => {
      currentPage = 1;
      persistFilters();
      loadList();
    });
  }
  AdminPager.bindSize($('pu_page_size'), PU_PAGE_SIZE_KEY, () => {
    puPage = 1;
    loadPortalUsers();
  });
  AdminPager.bindSize($('batch_page_size'), BATCH_PAGE_SIZE_KEY, () => {
    batchesPage = 1;
    loadExportBatches();
  });

  async function loadDetail(id) {
    showAlert($('detail_error'), '', '');
    openDetailDrawer();
    const drawerBody = document.querySelector('#detail_card .drawer-body');
    if (drawerBody) drawerBody.scrollTop = 0;
    try {
      const data = await adminFetch(`/api/admin/submissions/${id}`);
      currentDetail = data;
      renderDetail(data);
      document.querySelectorAll('#list_body tr.row-selected').forEach((tr) => tr.classList.remove('row-selected'));
      const active = document.querySelector(`#list_body tr[data-id="${CSS.escape(String(id))}"]`);
      if (active) active.classList.add('row-selected');
    } catch (err) {
      showAlert($('detail_error'), 'error', escapeHtml(err.message));
    }
  }

  function renderDetail(data) {
    const s = data.submission;
    const isUrgent = s.submission_type === 'urgent';
    const isSales = s.submission_type === 'sales';
    const isReturn = s.submission_type === 'return';
    $('detail_title').textContent = `申報詳情 — ${s.application_no}`;
    let header = `
      <dt>狀態</dt><dd>${s.locked ? '<span class="status-badge locked">已鎖定</span>' : '<span class="status-badge received">已收件</span>'}</dd>
       <dt>類型</dt><dd>${isUrgent ? 'Urgent Order' : isSales ? '突發性銷售申報' : isReturn ? '行貨退貨報數' : '一般 NDRF'}</dd>
      <dt>Site Code</dt><dd>${escapeHtml(s.site_code)}（${escapeHtml(data.store?.shop || '')}）</dd>
      <dt>申請電郵</dt><dd>${escapeHtml(s.requested_by_email)}</dd>
      <dt>來源</dt><dd>${s.source === 'web' ? '網頁' : 'Excel'}</dd>
      <dt>申請日期</dt><dd>${escapeHtml(s.application_date)}</dd>
      <dt>申請時間</dt><dd>${escapeHtml(s.submitted_at)}</dd>`;
    if (isUrgent) {
      header += `<dt>QTY</dt><dd>${escapeHtml(s.qty)}</dd>`;
      header += `<dt>Urgent Reason</dt><dd>${escapeHtml(s.urgent_reason_label || '—')}</dd>`;
      header += `<dt>Other Reason</dt><dd>${escapeHtml(s.urgent_reason_other || '—')}</dd>`;
    }
    if (isReturn) {
      header += `<dt>QTY</dt><dd>${escapeHtml(s.return_qty)}</dd><dt>REASON</dt><dd>${escapeHtml(s.return_reason_label || s.return_reason || '—')}</dd><dt>確認人姓名</dt><dd>${escapeHtml(s.return_confirmer_name || '—')}</dd><dt>確認人電話</dt><dd>${escapeHtml(s.return_confirmer_phone || '—')}</dd><dt>申請窗口</dt><dd>${escapeHtml(s.return_window_key || '—')}</dd>`;
    }
    if (s.locked_at) header += `<dt>鎖定時間</dt><dd>${escapeHtml(s.locked_at)}</dd>`;
    if (s.exported_at) header += `<dt>匯出時間</dt><dd>${escapeHtml(s.exported_at)}</dd>`;
    $('detail_header').innerHTML = header;

    $('normal_fields').style.display = isUrgent || isSales || isReturn ? 'none' : '';
    $('urgent_fields').style.display = isUrgent ? '' : 'none';
    $('sales_fields').style.display = isSales ? '' : 'none';
    $('return_fields').style.display = isReturn ? '' : 'none';
    $('urgent_note').style.display = isUrgent ? '' : 'none';

    $('a_sku_normal').value = s.sku || '';
    $('a_rp_type').value = s.rp_type || '';
    $('a_safety_stock').value = s.safety_stock || '';
    $('a_nd_code').value = s.nd_code || '';
    $('a_remark').value = s.remark || '';
    syncRpTypeFields();
    $('a_sku_urgent').value = s.sku || '';
    $('a_qty').value = s.qty || '';
    $('a_urgent_reason').value = s.urgent_reason || '';
    $('a_urgent_reason_other').value = s.urgent_reason_other || '';
    $('a_sku_sales').value = s.sku || '';
    $('a_sku_return').value = s.sku || '';
    $('a_return_qty').value = s.return_qty || '';
    $('a_return_reason').value = s.return_reason || '';
    $('a_return_name').value = s.return_confirmer_name || '';
    $('a_return_phone').value = s.return_confirmer_phone || '';
    syncUrgentOtherField();

    $('btn_save_edit').disabled = s.locked;
    $('btn_save_edit').textContent = s.locked ? '已鎖定，不能修改' : '儲存修改';

    renderWorkflowSection(data);

    const box = $('versions_box');
    box.innerHTML = '';
    if (!data.versions.length) {
      box.innerHTML = '<div class="empty">沒有版本紀錄</div>';
      return;
    }
    let html = '<table><thead><tr><th>版本</th><th>修改時間 (HK)</th><th>操作者</th><th>IP</th><th>來源</th><th>更改內容</th></tr></thead><tbody>';
    const SRC_LABEL = { web_submit: '網頁提交', excel_import: 'Excel 匯入', web_modify: '網頁修改', admin_edit: '管理員修改' };
    data.versions.forEach((v) => {
      const actor = v.actor_role === 'admin' ? `管理員 (${v.actor || '—'})` : '申請人';
      html += `<tr><td>${v.version}</td><td>${escapeHtml(v.changed_at)}</td><td>${actor}</td><td>${escapeHtml(v.ip || '—')}</td><td>${escapeHtml(SRC_LABEL[v.change_source] || v.change_source)}</td><td>${versionChangesHtml(v)}</td></tr>`;
    });
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  function syncUrgentOtherField() {
    const showOther = $('a_urgent_reason').value === '9';
    $('a_urgent_reason_other_wrap').style.display = showOther ? '' : 'none';
    if (!showOther) $('a_urgent_reason_other').value = '';
  }

  $('a_urgent_reason').addEventListener('change', syncUrgentOtherField);

  function syncRpTypeFields() {
    const rpType = $('a_rp_type').value;
    $('a_safety_stock_wrap').style.display = rpType === 'ND' ? 'none' : '';
    $('a_nd_code_wrap').style.display = rpType === 'RF' ? 'none' : '';
  }
  $('a_rp_type').addEventListener('change', syncRpTypeFields);

  $('btn_save_edit').addEventListener('click', async () => {
    if (!currentDetail) return;
    const isUrgent = currentDetail.submission.submission_type === 'urgent';
    const isSales = currentDetail.submission.submission_type === 'sales';
    const isReturn = currentDetail.submission.submission_type === 'return';
    const body = isUrgent
      ? {
          sku: $('a_sku_urgent').value.trim(),
          qty: $('a_qty').value === '' ? null : Number($('a_qty').value),
          urgent_reason: $('a_urgent_reason').value,
          urgent_reason_other: $('a_urgent_reason_other').value.trim(),
        }
      : isSales
        ? { sku: $('a_sku_sales').value.trim() }
        : isReturn
          ? { sku: $('a_sku_return').value.trim(), return_qty: Number($('a_return_qty').value), return_reason: $('a_return_reason').value, return_confirmer_name: $('a_return_name').value.trim(), return_confirmer_phone: $('a_return_phone').value.trim() }
        : {
          sku: $('a_sku_normal').value.trim(),
          rp_type: $('a_rp_type').value,
          safety_stock: $('a_safety_stock').value.trim(),
          nd_code: $('a_nd_code').value.trim(),
          remark: $('a_remark').value.trim(),
        };
    if (isUrgent) {
      const urgentErrs = [];
      if (!body.urgent_reason) urgentErrs.push('Urgent Reason 為必填');
      else if (body.urgent_reason === '9' && !body.urgent_reason_other) urgentErrs.push('選擇「9. 其他」時必須填寫 Other Reason');
      else if (body.urgent_reason !== '9' && body.urgent_reason_other) urgentErrs.push('僅選擇「9. 其他」時才可填寫 Other Reason');
      if (urgentErrs.length) {
        showAlert($('save_edit_error'), 'error', urgentErrs.map((e) => escapeHtml(e)).join('<br>'));
        return;
      }
    } else if (isSales) {
      if (!body.sku) {
        showAlert($('save_edit_error'), 'error', 'SKU 為必填');
        return;
      }
    } else if (isReturn) {
      if (!body.sku || !Number.isInteger(body.return_qty) || body.return_qty < 1 || body.return_qty > 9999 || !body.return_reason || !body.return_confirmer_name || !body.return_confirmer_phone) {
        showAlert($('save_edit_error'), 'error', '請填妥 SKU、QTY、REASON、確認人姓名及確認人電話');
        return;
      }
    } else {
      const clientErrs = validateBusinessFields(body, currentDetail.submission.site_code);
      if (clientErrs.length) {
        showAlert($('save_edit_error'), 'error', clientErrs.map((e) => escapeHtml(e.message)).join('<br>'));
        return;
      }
    }
    const btn = $('btn_save_edit');
    btn.disabled = true;
    showAlert($('save_edit_error'), '', '');
    try {
      const data = await adminFetch(`/api/admin/submissions/${currentDetail.submission.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      await loadDetail(currentDetail.submission.id);
      showAlert($('save_edit_error'), 'success', '修改已儲存，並新增一個版本紀錄。');
      loadList();
    } catch (err) {
      showAlert($('save_edit_error'), 'error', escapeHtml(err.message));
      btn.disabled = false;
      btn.textContent = '儲存修改';
    }
  });

  $('btn_close_detail').addEventListener('click', closeDetailDrawer);
  if ($('btn_close_detail_x')) $('btn_close_detail_x').addEventListener('click', closeDetailDrawer);
  if ($('detail_overlay')) $('detail_overlay').addEventListener('click', closeDetailDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('detail_card')?.classList.contains('open')) closeDetailDrawer();
  });

  function setupDrop(dropId, inputId, labelId, cb) {
    const drop = $(dropId);
    const input = $(inputId);
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('dragover');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        cb(e.dataTransfer.files[0]);
        $(labelId).textContent = `已選擇：${e.dataTransfer.files[0].name}`;
      }
    });
    input.addEventListener('change', () => {
      if (input.files.length) {
        cb(input.files[0]);
        $(labelId).textContent = `已選擇：${input.files[0].name}`;
      }
    });
  }

  setupDrop('store_drop', 'store_input', 'store_label', (f) => {
    pendingStoreFile = f;
  });

  function confirmExport(message) {
    return new Promise((resolve) => {
      const overlay = $('export_confirm_overlay');
      $('confirm_message').textContent = message;
      overlay.style.display = 'flex';
      const ok = $('confirm_ok');
      const cancel = $('confirm_cancel');
      cancel.focus();
      const close = (v) => {
        overlay.style.display = 'none';
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlayClick);
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onOk = () => close(true);
      const onCancel = () => close(false);
      const onOverlayClick = (e) => {
        if (e.target === overlay) close(false);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(false);
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlayClick);
      document.addEventListener('keydown', onKey);
    });
  }

  $('btn_export').addEventListener('click', async () => {
    const confirmed = await confirmExport(
      `匯出日期：${$('e_from').value || '不限'} 至 ${$('e_to').value || '不限'}（Site Code：${$('e_site').value.trim() || '全部'}）\n匯出後該批一般 NDRF 申報會被鎖定，申請人不能再修改。\n確定要繼續嗎？`
    );
    if (!confirmed) return;
    const btn = $('btn_export');
    btn.disabled = true;
    btn.textContent = '匯出中…';
    showAlert($('export_info'), '', '');
    const body = {
      from: $('e_from').value,
      to: $('e_to').value,
      site_code: $('e_site').value.trim(),
      include_exported: $('e_include').value === 'true',
    };
    try {
      const token = await getCsrf();
      const res = await fetch('/api/admin/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: '匯出失敗' }));
        throw new Error(errData.error || '匯出失敗');
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? match[1] : 'NDRF_SAP_Export.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showAlert($('export_info'), 'success', '匯出成功，相關申報已鎖定。');
      loadList();
      loadSummary();
      loadExportBatches(true);
    } catch (err) {
      showAlert($('export_info'), 'error', escapeHtml(err.message));
      loadExportBatches();
    } finally {
      btn.disabled = false;
      btn.textContent = '匯出並鎖定';
    }
  });

  async function previewExport(path, body, fallbackName, infoId, btnId) {
    const btn = $(btnId);
    btn.disabled = true;
    btn.textContent = '下載中…';
    showAlert($(infoId), '', '');
    try {
      const token = await getCsrf();
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: '預覽下載失敗' }));
        throw new Error(errData.error || '預覽下載失敗');
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? match[1] : fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showAlert($(infoId), 'success', '預覽下載完成，申報未被鎖定。');
    } catch (err) {
      showAlert($(infoId), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = '預覽下載(不鎖定)';
    }
  }

  $('btn_export_preview').addEventListener('click', () => {
    previewExport('/api/admin/export', {
      from: $('e_from').value,
      to: $('e_to').value,
      site_code: $('e_site').value.trim(),
      include_exported: $('e_include').value === 'true',
      preview: true,
    }, 'NDRF_SAP_Preview.xlsx', 'export_info', 'btn_export_preview');
  });

  $('btn_urgent_export_preview').addEventListener('click', () => {
    previewExport('/api/admin/urgent/export', {
      from: $('ue_from').value,
      to: $('ue_to').value,
      site_code: $('ue_site').value.trim(),
      include_exported: $('ue_include').value === 'true',
      preview: true,
    }, 'Urgent_Order_Preview.xlsx', 'urgent_export_info', 'btn_urgent_export_preview');
  });

  $('btn_sales_export_preview').addEventListener('click', () => {
    previewExport('/api/admin/sales/export', {
      from: $('se_from').value,
      to: $('se_to').value,
      site_code: $('se_site').value.trim(),
      include_exported: $('se_include').value === 'true',
      preview: true,
    }, 'Sudden_Sales_Preview.xlsx', 'sales_export_info', 'btn_sales_export_preview');
  });

  $('btn_return_export_preview').addEventListener('click', () => {
    previewExport('/api/admin/return/export', {
      from: $('re_from').value,
      to: $('re_to').value,
      site_code: $('re_site').value.trim(),
      include_exported: $('re_include').value === 'true',
      preview: true,
    }, 'Return_Goods_Preview.xlsx', 'return_export_info', 'btn_return_export_preview');
  });

  $('btn_urgent_export').addEventListener('click', async () => {
    const confirmed = await confirmExport(
      `匯出日期：${$('ue_from').value || '不限'} 至 ${$('ue_to').value || '不限'}（Site Code：${$('ue_site').value.trim() || '全部'}）\n匯出後該批 Urgent Order 會被鎖定，申請人不能再修改。\n確定要繼續嗎？`
    );
    if (!confirmed) return;
    const btn = $('btn_urgent_export');
    btn.disabled = true;
    btn.textContent = '匯出中…';
    showAlert($('urgent_export_info'), '', '');
    const body = {
      from: $('ue_from').value,
      to: $('ue_to').value,
      site_code: $('ue_site').value.trim(),
      include_exported: $('ue_include').value === 'true',
    };
    try {
      const token = await getCsrf();
      const res = await fetch('/api/admin/urgent/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: '匯出失敗' }));
        throw new Error(errData.error || '匯出失敗');
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? match[1] : 'Urgent_Order_Export.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showAlert($('urgent_export_info'), 'success', '匯出成功，相關 Urgent Order 已鎖定。');
      loadList();
      loadSummary();
      loadExportBatches(true);
    } catch (err) {
      showAlert($('urgent_export_info'), 'error', escapeHtml(err.message));
      loadExportBatches();
    } finally {
      btn.disabled = false;
      btn.textContent = '匯出並鎖定';
    }
  });

  $('btn_return_export').addEventListener('click', async () => {
    const confirmed = await confirmExport(`匯出日期：${$('re_from').value || '不限'} 至 ${$('re_to').value || '不限'}（Site Code：${$('re_site').value.trim() || '全部'}）\n匯出後該批行貨退貨報數會被鎖定，店舖不能再修改。\n確定要繼續嗎？`);
    if (!confirmed) return;
    const btn = $('btn_return_export'); btn.disabled = true; btn.textContent = '匯出中…'; showAlert($('return_export_info'), '', '');
    try {
      const token = await getCsrf();
      const response = await fetch('/api/admin/return/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ from: $('re_from').value, to: $('re_to').value, site_code: $('re_site').value.trim(), include_exported: $('re_include').value === 'true' }) });
      if (!response.ok) { const data = await response.json().catch(() => ({ error: '匯出失敗' })); throw new Error(data.error || '匯出失敗'); }
       const blob = await response.blob(); const disposition = response.headers.get('Content-Disposition') || ''; const match = disposition.match(/filename="([^"]+)"/); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = match ? match[1] : 'Return_Goods_Export.xlsx'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); showAlert($('return_export_info'), 'success', '匯出成功，相關申報已鎖定。'); loadList(); loadSummary(); loadExportBatches(true);
     } catch (error) { showAlert($('return_export_info'), 'error', escapeHtml(error.message)); loadExportBatches(); } finally { btn.disabled = false; btn.textContent = '匯出並鎖定'; }
  });

  $('btn_audit').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const token = await getCsrf();
      const res = await fetch('/api/admin/audit', {
        headers: { 'x-csrf-token': token },
      });
      if (!res.ok) throw new Error('無法下載審計報表');
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? match[1] : 'NDRF_Audit_Report.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showAlert($('export_info'), 'error', escapeHtml(err.message));
    }
  });

  async function loadStoreCount() {
    try {
      const data = await adminFetch('/api/admin/stores');
      $('store_count').textContent = `目前共有 ${data.stores.length} 間門店。`;
    } catch {}
  }

  async function loadSummary() {
    const setNum = (id, v) => {
      const el = $(id);
      if (el) el.textContent = String(v);
    };
    const setStoreInfo = (id, entry) => {
      const el = $(id);
      if (!el) return;
      if (entry) {
        const name = entry.shop ? entry.shop : entry.site_code;
        el.textContent = `${name} ${entry.time}`;
      } else {
        el.textContent = '—';
      }
    };
    try {
      const data = await adminFetch('/api/admin/summary');
      const setStat = (type, key, id) => setNum(id, data[type][key]);
      setNum('s_stores_today', data.stores_today);
      setNum('s_stores_month', data.stores_month);
      setStoreInfo('s_earliest_store', data.earliest_submission_today);
      setStoreInfo('s_latest_store', data.latest_submission_today);
      setStat('normal', 'total', 's_normal_total');
      setStat('normal', 'exported', 's_normal_exported');
      setNum('s_normal_not_exported', data.normal.total - data.normal.exported);
      setStat('normal', 'today', 's_normal_today');
      setStat('normal', 'today_exported', 's_normal_today_exported');
      setStat('normal', 'stores_today', 's_normal_stores_today');
      setStat('urgent', 'total', 's_urgent_total');
      setStat('urgent', 'exported', 's_urgent_exported');
      setNum('s_urgent_not_exported', data.urgent.total - data.urgent.exported);
      setStat('urgent', 'today', 's_urgent_today');
      setStat('urgent', 'today_exported', 's_urgent_today_exported');
      setStat('urgent', 'stores_today', 's_urgent_stores_today');
      setStat('sales', 'total', 's_sales_total');
      setStat('sales', 'exported', 's_sales_exported');
      setNum('s_sales_not_exported', data.sales.total - data.sales.exported);
      setStat('sales', 'today', 's_sales_today');
      setStat('sales', 'today_exported', 's_sales_today_exported');
      setStat('sales', 'stores_today', 's_sales_stores_today');
      setStat('return', 'total', 's_return_total');
      setStat('return', 'exported', 's_return_exported');
      setNum('s_return_not_exported', data.return.total - data.return.exported);
      setStat('return', 'today', 's_return_today');
      setStat('return', 'today_exported', 's_return_today_exported');
      setStat('return', 'stores_today', 's_return_stores_today');
      const note = $('summary_note');
      if (note) {
        if (data.total > 0) {
          note.innerHTML = `<span class="dash-dot dash-dot--ok"></span> 已有 <b>${data.total}</b> 筆提交`;
        } else {
          note.innerHTML = `<span class="dash-dot dash-dot--empty"></span> 目前尚無任何申報提交`;
        }
      }
    } catch {
      const note = $('summary_note');
      if (note) note.textContent = '預覽載入失敗。';
    }
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function exportTypeLabel(type) {
    return ({ normal: '一般 NDRF', urgent: 'Urgent Order', sales: '突發性銷售', return: '行貨退貨' })[type] || '一般 NDRF';
  }

  function renderExportBatches(data) {
    const tbody = $('export_history_body');
    if (!data.exports.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">暫無正式匯出批次</td></tr>';
      return;
    }
    tbody.innerHTML = data.exports.map((batch) => {
      let status;
      let action;
      if (batch.archive_available) {
        status = `<span class="status-badge received">已保存至 ${escapeHtml(batch.archive_expires_at || '三個月')}</span><div class="hint">${formatFileSize(batch.archive_file_size)}</div>`;
        action = `<button class="btn ghost btn-download-export" data-id="${escapeHtml(batch.id)}" data-filename="${escapeHtml(batch.filename)}" data-label="重新下載">重新下載</button>`;
      } else if (batch.archive_expired) {
        status = '<span class="status-badge locked">已過保存期限</span>';
        action = '<span class="hint">檔案已清理</span>';
      } else {
        status = '<span class="status-badge received">舊批次</span><div class="hint">按申報資料重建</div>';
        action = `<button class="btn ghost btn-download-export" data-id="${escapeHtml(batch.id)}" data-filename="${escapeHtml(batch.filename)}" data-label="重新產生">重新產生</button>`;
      }
      return `<tr><td>${escapeHtml(batch.created_at)}</td><td>${escapeHtml(batch.filename)}</td><td>${exportTypeLabel(batch.submission_type)}</td><td>${escapeHtml(batch.submission_count)}</td><td>${status}</td><td>${action}</td></tr>`;
    }).join('');
  }

  async function loadExportBatches(resetPage = false) {
    if (resetPage) batchesPage = 1;
    try {
      const params = new URLSearchParams({ page: String(batchesPage), page_size: String(currentBatchPageSize()) });
      const data = await adminFetch(`/api/admin/batches?${params.toString()}`);
      const pages = Number(data.exports_total_pages) || 0;
      if (pages > 0 && Number(data.exports_page) > pages) {
        batchesPage = pages;
        return loadExportBatches();
      }
      batchesPage = Number(data.exports_page) || 1;
      renderExportBatches(data);
      AdminPager.render({
        nav: $('batch_page_numbers'),
        range: $('batch_page_range'),
        page: batchesPage,
        total: data.exports_total,
        pageSize: currentBatchPageSize(),
        onPage: (page) => { batchesPage = page; loadExportBatches(); },
        unit: '個批次',
      });
      const usage = data.archive_usage || { bytes: 0, files: 0, retention_days: 90 };
      $('export_archive_usage').textContent = `目前保存 ${usage.files} 個正式匯出檔案，共 ${formatFileSize(usage.bytes)}；保存期限 ${usage.retention_days} 日。`;
    } catch (err) {
      showAlert($('export_history_info'), 'error', escapeHtml(err.message));
    }
  }

  async function downloadExportBatch(button) {
    const batchId = button.dataset.id;
    button.disabled = true;
    button.textContent = '處理中…';
    try {
      const token = await getCsrf();
      const response = await fetch(`/api/admin/export-batches/${encodeURIComponent(batchId)}/download`, {
        headers: { 'x-csrf-token': token },
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: '無法下載匯出檔案' }));
        throw new Error(error.error || '無法下載匯出檔案');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = match ? match[1] : button.dataset.filename || 'Export.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showAlert($('export_history_info'), 'success', '匯出檔案已下載。');
    } catch (err) {
      showAlert($('export_history_info'), 'error', escapeHtml(err.message));
    } finally {
      button.disabled = false;
      button.textContent = button.dataset.label || '重新下載';
    }
  }

  $('export_history_body').addEventListener('click', (event) => {
    const button = event.target.closest('.btn-download-export');
    if (button) void downloadExportBatch(button);
  });

  $('btn_store').addEventListener('click', async () => {
    if (!pendingStoreFile) {
      showAlert($('store_result'), 'error', '請先選擇 CSV 檔案');
      return;
    }
    if (!confirm('確定要取代目前門店主檔嗎？')) return;
    const btn = $('btn_store');
    btn.disabled = true;
    const fd = new FormData();
    fd.append('file', pendingStoreFile);
    try {
      const data = await adminFetch('/api/admin/stores', { method: 'PUT', body: fd });
      showAlert($('store_result'), 'success', `門店主檔已更新，共 ${data.count} 筆。`);
      $('store_label').textContent = '拖曳 stores CSV 檔案到此處，或按一下選擇檔案';
      pendingStoreFile = null;
      loadStoreCount();
    } catch (err) {
      let msg = escapeHtml(err.message);
      if (err.data?.errors?.length) msg += `<ul>${err.data.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
      showAlert($('store_result'), 'error', msg);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn_sales_export').addEventListener('click', async () => {
    const confirmed = await confirmExport(
      `匯出日期：${$('se_from').value || '不限'} 至 ${$('se_to').value || '不限'}（Site Code：${$('se_site').value.trim() || '全部'}）\n匯出後該批突發性銷售申報會被鎖定，申請人不能再修改。\n確定要繼續嗎？`
    );
    if (!confirmed) return;
    const btn = $('btn_sales_export');
    btn.disabled = true;
    btn.textContent = '匯出中…';
    showAlert($('sales_export_info'), '', '');
    const body = {
      from: $('se_from').value,
      to: $('se_to').value,
      site_code: $('se_site').value.trim(),
      include_exported: $('se_include').value === 'true',
    };
    try {
      const token = await getCsrf();
      const response = await fetch('/api/admin/sales/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: '匯出失敗' }));
        throw new Error(errorData.error || '匯出失敗');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = match ? match[1] : 'Sudden_Sales_Export.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showAlert($('sales_export_info'), 'success', '匯出成功，相關申報已鎖定。');
      loadList();
      loadSummary();
      loadExportBatches(true);
    } catch (error) {
      showAlert($('sales_export_info'), 'error', escapeHtml(error.message));
      loadExportBatches();
    } finally {
      btn.disabled = false;
      btn.textContent = '匯出並鎖定';
    }
  });

  let recoveryScope = null;

  function loadRecoveryCodes() {
    adminFetch('/api/admin/recovery-codes')
      .then((data) => {
        const rows = [{
          om: 'master',
          label: 'Master（全平台）',
          set: Boolean(data.master?.set),
          code: data.master?.code || '',
          updated_at: data.master?.updated_at,
          updated_by: data.master?.updated_by,
        }];
        (data.om_codes || []).forEach((c) => {
          rows.push({ om: c.om, label: c.om, set: c.set, code: c.code || '', updated_at: c.updated_at, updated_by: c.updated_by });
        });
        const tbody = $('recovery_codes_body');
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="6" class="text-center text-secondary">門店主檔冇任何 OM。</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map((row) => {
          const status = row.set
            ? '<span class="status-badge received">已設定</span>'
            : '<span class="status-badge locked">未設定</span>';
          const codeCell = row.set
            ? `<code style="word-break:break-all">${escapeHtml(row.code)}</code>`
            : '<span class="text-secondary">—</span>';
          const actions = row.set
            ? `<button class="btn ghost btn-recovery-edit" data-scope="${escapeHtml(row.om)}">輪換</button> <button class="btn ghost btn-recovery-del" data-scope="${escapeHtml(row.om)}">清除</button>`
            : `<button class="btn ghost btn-recovery-edit" data-scope="${escapeHtml(row.om)}">設定</button>`;
          return `<tr><td>${escapeHtml(row.label)}</td><td>${status}</td><td>${codeCell}</td><td>${escapeHtml(row.updated_at || '—')}</td><td>${escapeHtml(row.updated_by || '—')}</td><td>${actions}</td></tr>`;
        }).join('');
        tbody.querySelectorAll('.btn-recovery-edit').forEach((btn) => {
          btn.addEventListener('click', () => openRecoveryCodeModal(btn.dataset.scope));
        });
        tbody.querySelectorAll('.btn-recovery-del').forEach((btn) => {
          btn.addEventListener('click', () => removeRecoveryCode(btn.dataset.scope));
        });
      })
      .catch((err) => {
        $('recovery_codes_body').innerHTML = `<tr><td colspan="6" class="text-center text-secondary">載入失敗：${escapeHtml(err.message)}</td></tr>`;
      });
  }

  function openRecoveryCodeModal(scope) {
    recoveryScope = scope;
    $('recovery_code_scope').textContent = scope === 'master' ? 'Master（全平台）' : scope;
    $('recovery_code_title').textContent = '設定 Recovery Code';
    $('recovery_code_input').value = '';
    showAlert($('recovery_code_form_error'), '', '');
    $('recovery_code_overlay').style.display = 'flex';
    $('recovery_code_input').focus();
  }

  function closeRecoveryCodeModal() {
    $('recovery_code_overlay').style.display = 'none';
  }

  $('recovery_code_ok').addEventListener('click', async () => {
    const code = $('recovery_code_input').value;
    if (!code) {
      showAlert($('recovery_code_form_error'), 'error', '請輸入 Recovery Code');
      return;
    }
    const btn = $('recovery_code_ok');
    btn.disabled = true;
    try {
      await adminFetch(`/api/admin/recovery-codes/${encodeURIComponent(recoveryScope)}`, {
        method: 'PUT',
        body: JSON.stringify({ code }),
      });
      closeRecoveryCodeModal();
      showAlert($('recovery_code_result'), 'success', 'Recovery Code 已更新。');
      loadRecoveryCodes();
    } catch (err) {
      showAlert($('recovery_code_form_error'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  $('recovery_code_cancel').addEventListener('click', closeRecoveryCodeModal);
  $('recovery_code_overlay').addEventListener('click', (e) => {
    if (e.target === $('recovery_code_overlay')) closeRecoveryCodeModal();
  });

  async function removeRecoveryCode(scope) {
    const label = scope === 'master' ? 'Master（全平台）' : scope;
    const ok = await confirmExport(`確認清除「${label}」嘅 Recovery Code？清除後該範圍內所有店舖將無法使用「搵返申請編號」。`);
    if (!ok) return;
    try {
      await adminFetch(`/api/admin/recovery-codes/${encodeURIComponent(scope)}`, { method: 'DELETE' });
      showAlert($('recovery_code_result'), 'success', 'Recovery Code 已清除。');
      loadRecoveryCodes();
    } catch (err) {
      showAlert($('recovery_code_result'), 'error', escapeHtml(err.message));
    }
  }

  /* ------------------------------------------------------------------ */
  /* General NDRF workflow management                                   */
  /* ------------------------------------------------------------------ */

  const WORKFLOW_STATUS_LABEL = {
    legacy: 'Legacy',
    pending: '待審批',
    ready_for_rp: '可供 RP 匯出',
    accepted: '已批准',
    rejected: '已拒絕',
  };
  const ROUTE_LABEL = { buyer: 'Buyer', sct: 'SCT', rp: 'RP', legacy: 'Legacy' };

  function workflowBadge(status) {
    return `<span class="status-badge ${status === 'rejected' ? 'locked' : 'received'}">${escapeHtml(WORKFLOW_STATUS_LABEL[status] ?? status ?? '—')}</span>`;
  }

  function renderWorkflowSection(data) {
    const s = data.submission;
    const wf = s.workflow;
    const section = $('workflow_section');
    if (!section) return;
    if (!wf) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    const blocked = Boolean(s.locked);
    $('workflow_header').innerHTML = `
      <div class="datagrid-item"><div class="datagrid-title">狀態</div><div class="datagrid-content">${workflowBadge(wf.status)}</div></div>
      <div class="datagrid-item"><div class="datagrid-title">路由</div><div class="datagrid-content">${escapeHtml(ROUTE_LABEL[wf.route] ?? wf.route ?? '—')}</div></div>
      <div class="datagrid-item"><div class="datagrid-title">審批回合</div><div class="datagrid-content">${wf.review_round}</div></div>
      ${wf.rejected_at ? `<div class="datagrid-item"><div class="datagrid-title">拒絕時間</div><div class="datagrid-content">${escapeHtml(wf.rejected_at)}</div></div>` : ''}
      ${wf.review_remark ? `<div class="datagrid-item"><div class="datagrid-title">Review Remark</div><div class="datagrid-content">${escapeHtml(wf.review_remark)}</div></div>` : ''}
      ${wf.auto_approved_at ? `<div class="datagrid-item"><div class="datagrid-title">SLA 自動批准時間</div><div class="datagrid-content">${escapeHtml(wf.auto_approved_at)}（Buyer 逾期未回覆，默認同意）</div></div>` : ''}`;
    const events = data.reviewEvents || [];
    $('workflow_events').innerHTML = events.length
      ? '<table class="table table-vcenter"><thead><tr><th>時間</th><th>事件</th><th>回合</th><th>操作者</th><th>詳情</th></tr></thead><tbody>'
        + events.map((e) => `<tr><td>${escapeHtml(e.created_at)}</td><td>${escapeHtml(e.event_type)}</td><td>${e.review_round}</td><td>${escapeHtml(e.actor)}</td><td>${escapeHtml(e.reject_reason_label ? `${e.reject_reason_label}${e.reject_reason_note ? `（${e.reject_reason_note}）` : ''}` : (e.remark || e.reason || ''))}</td></tr>`).join('')
        + '</tbody></table>'
      : '<div class="text-secondary small">暫無審批紀錄</div>';

    ['btn_wf_reopen', 'btn_wf_accept', 'btn_wf_ready', 'btn_wf_reject'].forEach((id) => {
      const btn = $(id);
      if (!btn) return;
      btn.disabled = blocked;
    });
    showAlert($('workflow_result'), '', '');
  }

  function workflowOverride(action) {
    const label = { reopen: 'Reopen', override_accept: 'Override 為已批准', override_ready: 'Override 為可供 RP', override_reject: 'Override 為已拒絕' }[action];
    const reason = window.prompt(`請填寫「${label}」的原因（必填）：`);
    if (reason === null) return;
    if (!reason.trim()) {
      showAlert($('workflow_result'), 'error', '必須填寫原因');
      return;
    }
    adminFetch(`/api/admin/submissions/${currentDetail.submission.id}/override`, {
      method: 'POST',
      body: JSON.stringify({ action, reason: reason.trim() }),
    })
      .then(async () => {
        showAlert($('workflow_result'), 'success', '已執行。');
        await loadDetail(currentDetail.submission.id);
        loadList();
      })
      .catch((err) => showAlert($('workflow_result'), 'error', escapeHtml(err.message)));
  }

  $('btn_wf_reopen').addEventListener('click', () => workflowOverride('reopen'));
  $('btn_wf_accept').addEventListener('click', () => workflowOverride('override_accept'));
  $('btn_wf_ready').addEventListener('click', () => workflowOverride('override_ready'));
  $('btn_wf_reject').addEventListener('click', () => workflowOverride('override_reject'));

  /* Portal users ------------------------------------------------------ */

  async function loadPortalUsers() {
    try {
      const params = new URLSearchParams({ page: String(puPage), page_size: String(currentPuPageSize()) });
      const data = await adminFetch(`/api/admin/portal/users?${params.toString()}`);
      const pages = Number(data.total_pages) || 0;
      if (pages > 0 && Number(data.page) > pages) {
        puPage = pages;
        return loadPortalUsers();
      }
      puPage = Number(data.page) || 1;
      const tbody = $('portal_users_body');
      if (!tbody) return;
      tbody.innerHTML = data.users.length
        ? data.users.map((u) => {
          const loginUrl = `${window.location.origin}/portal/?user=${encodeURIComponent(u.username)}`;
          return `<tr>
        <td><input type="checkbox" class="pu-select" data-id="${u.id}" aria-label="選擇 ${escapeHtml(u.username)}"></td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.display_name || '—')}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(u.site_code || '—')}</td>
        <td>${u.active ? '<span class="status-badge received">啟用</span>' : '<span class="status-badge locked">停用</span>'}</td>
        <td><a href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener">開啟</a> <button class="btn ghost btn-sm btn-pu-link-copy" data-url="${escapeHtml(loginUrl)}">複製</button></td>
        <td>
          <button class="btn ghost btn-pu-toggle" data-id="${u.id}" data-active="${u.active}">${u.active ? '停用' : '啟用'}</button>
          <button class="btn ghost btn-pu-del" data-id="${u.id}" data-username="${escapeHtml(u.username)}">刪除</button>
        </td>
      </tr>`;
        }).join('')
        : '<tr><td colspan="8" class="text-center text-secondary">沒有帳戶</td></tr>';
      tbody.querySelectorAll('.btn-pu-toggle').forEach((btn) => {
        btn.addEventListener('click', () => togglePortalUser(btn.dataset.id, btn.dataset.active === 'true'));
      });
      tbody.querySelectorAll('.btn-pu-del').forEach((btn) => {
        btn.addEventListener('click', () => deletePortalUser(btn.dataset.id, btn.dataset.username));
      });
      tbody.querySelectorAll('.btn-pu-link-copy').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(btn.dataset.url || '');
            showAlert($('portal_users_result'), 'success', '登入連結已複製。');
          } catch {
            window.prompt('複製登入連結：', btn.dataset.url || '');
          }
        });
      });
      AdminPager.render({
        nav: $('pu_page_numbers'),
        range: $('pu_page_range'),
        page: puPage,
        total: data.total,
        pageSize: currentPuPageSize(),
        onPage: (page) => { puPage = page; loadPortalUsers(); },
        unit: '個帳戶',
      });
      const selectAll = $('pu_select_all');
      if (selectAll) selectAll.checked = false;
    } catch (err) {
      if ($('portal_users_body')) $('portal_users_body').innerHTML = `<tr><td colspan="8" class="text-center text-secondary">載入失敗：${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function togglePortalUser(id, currentlyActive) {
    try {
      await adminFetch(`/api/admin/portal/users/${id}`, { method: 'PUT', body: JSON.stringify({ active: !currentlyActive }) });
      showAlert($('portal_users_result'), 'success', '帳戶狀態已更新。');
      loadPortalUsers();
    } catch (err) {
      showAlert($('portal_users_result'), 'error', escapeHtml(err.message));
    }
  }

  async function deletePortalUser(id, username) {
    if (!window.confirm(`確定要永久刪除帳戶「${username}」嗎？此操作不可還原。`)) return;
    try {
      await adminFetch(`/api/admin/portal/users/${id}`, { method: 'DELETE' });
      showAlert($('portal_users_result'), 'success', `帳戶「${escapeHtml(username)}」已刪除。`);
      loadPortalUsers();
    } catch (err) {
      showAlert($('portal_users_result'), 'error', escapeHtml(err.message));
    }
  }

  function selectedPortalUserIds() {
    return [...document.querySelectorAll('.pu-select:checked')].map((box) => box.dataset.id);
  }

  async function bulkPortalUsers(action, label) {
    const ids = selectedPortalUserIds();
    if (!ids.length) {
      showAlert($('portal_users_result'), 'error', '請先勾選至少一個帳戶。');
      return;
    }
    if (!window.confirm(`確定要為已勾選的 ${ids.length} 個帳戶批量「${label}」嗎？${action === 'delete' ? '刪除後不可還原。' : ''}`)) return;
    try {
      const data = await adminFetch('/api/admin/portal/users/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) });
      let msg = `批量「${escapeHtml(data.label)}」完成：成功 ${data.succeeded}、失敗 ${data.failed}。`;
      const failures = (data.results || []).filter((r) => !r.ok);
      if (failures.length) {
        msg += '<ul>' + failures.map((r) => `<li><b>${escapeHtml(r.username || r.id)}</b>：${escapeHtml(r.error || '失敗')}</li>`).join('') + '</ul>';
      }
      showAlert($('portal_users_result'), data.failed ? 'warning' : 'success', msg);
      const selectAll = $('pu_select_all');
      if (selectAll) selectAll.checked = false;
      loadPortalUsers();
    } catch (err) {
      showAlert($('portal_users_result'), 'error', escapeHtml(err.message));
    }
  }

  $('pu_select_all').addEventListener('change', (e) => {
    document.querySelectorAll('.pu-select').forEach((box) => { box.checked = e.target.checked; });
  });
  $('btn_pu_bulk_activate').addEventListener('click', () => bulkPortalUsers('activate', '啟用'));
  $('btn_pu_bulk_deactivate').addEventListener('click', () => bulkPortalUsers('deactivate', '停用'));
  $('btn_pu_bulk_delete').addEventListener('click', () => bulkPortalUsers('delete', '刪除'));

  async function loadPuSiteOptions() {
    const sel = $('pu_site');
    if (!sel) return;
    try {
      const data = await adminFetch('/api/admin/stores');
      const stores = data.stores || [];
      sel.innerHTML = '<option value="">請選擇店舖…</option>' + stores.map((s) => {
        const label = s.shop ? `${s.site_code} — ${s.shop}` : s.site_code;
        return `<option value="${escapeHtml(s.site_code)}">${escapeHtml(label)}</option>`;
      }).join('');
    } catch {
      sel.innerHTML = '<option value="">載入店舖失敗，請重試</option>';
    }
  }

  function refreshPuFormByRole() {
    const role = $('pu_role') ? $('pu_role').value : 'buyer';
    const isStore = role === 'store';
    if ($('pu_username_wrap')) $('pu_username_wrap').style.display = isStore ? 'none' : '';
    if ($('pu_site_wrap')) $('pu_site_wrap').style.display = isStore ? '' : 'none';
    if ($('pu_display_wrap')) $('pu_display_wrap').style.display = isStore ? 'none' : '';
    if (isStore) loadPuSiteOptions();
  }

  if ($('pu_role')) $('pu_role').addEventListener('change', refreshPuFormByRole);

  $('btn_pu_create').addEventListener('click', async () => {
    const role = $('pu_role').value;
    try {
      if (role === 'store') {
        const siteCode = ($('pu_site') ? $('pu_site').value : '').trim().toUpperCase();
        if (!siteCode) {
          showAlert($('portal_users_result'), 'error', '請選擇店舖');
          return;
        }
        const data = await adminFetch('/api/admin/portal/users', { method: 'POST', body: JSON.stringify({ role: 'store', site_code: siteCode, username: siteCode }) });
        showAlert($('portal_users_result'), 'success', `店舖帳戶「${escapeHtml(data.username)}」已建立（登入時輸入 Site Code 及密碼）。`);
        if ($('pu_site')) $('pu_site').value = '';
        loadPortalUsers();
        return;
      }
      const username = $('pu_username').value.trim();
      const displayName = $('pu_display').value.trim();
      if (!username) {
        showAlert($('portal_users_result'), 'error', '請輸入使用者名稱');
        return;
      }
      const data = await adminFetch('/api/admin/portal/users', { method: 'POST', body: JSON.stringify({ username, display_name: displayName, role }) });
      showAlert($('portal_users_result'), 'success', `帳戶「${escapeHtml(data.username)}」已建立（登入時輸入使用者名稱及密碼）。`);
      $('pu_username').value = '';
      $('pu_display').value = '';
      loadPortalUsers();
    } catch (err) {
      showAlert($('portal_users_result'), 'error', escapeHtml(err.message));
    }
  });

  async function fetchAllPortalUsers() {
    const all = [];
    let page = 1;
    let totalPages = 1;
    do {
      const data = await adminFetch(`/api/admin/portal/users?page=${page}&page_size=100`);
      all.push(...(data.users || []));
      totalPages = Number(data.total_pages) || 0;
      page += 1;
    } while (page <= totalPages);
    return all;
  }

  $('btn_pu_export_links').addEventListener('click', async () => {
    const btn = $('btn_pu_export_links');
    btn.disabled = true;
    try {
      const users = await fetchAllPortalUsers();
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['使用者名稱,顯示名稱,角色,Site Code,狀態,登入連結'];
      for (const u of users) {
        const url = `${window.location.origin}/portal/?user=${encodeURIComponent(u.username)}`;
        lines.push([u.username, u.display_name || '', u.role, u.site_code || '', u.active ? '啟用' : '停用', url].map(cell).join(','));
      }
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'portal-login-links.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      showAlert($('portal_users_result'), 'success', `已匯出 ${users.length} 個帳戶的登入連結（CSV，可用 Excel 開啟）。`);
    } catch (err) {
      showAlert($('portal_users_result'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  $('btn_store_sync').addEventListener('click', async () => {
    const btn = $('btn_store_sync');
    btn.disabled = true;
    try {
      const data = await adminFetch('/api/admin/stores/sync-accounts', { method: 'POST', body: JSON.stringify({}) });
      let html = `<div class="alert success">同步完成：新增 ${data.created.length}、重新啟用 ${data.reactivated.length}、停用 ${data.deactivated.length}、不變 ${data.unchanged}</div>`;
      if (data.created.length) {
        html += '<div class="alert success">以下新店舖帳戶已建立（登入時輸入 Site Code 及密碼）：<ul>' + data.created.map((c) => `<li><b>${escapeHtml(c.username)}</b>（${escapeHtml(c.site_code)}）</li>`).join('') + '</ul></div>';
      }
      if (data.deactivated.length) html += `<div class="alert info">已停用（不在門店主檔）：${escapeHtml(data.deactivated.join(', '))}</div>`;
      showAlert($('portal_users_result'), '', html);
      loadPortalUsers();
    } catch (err) {
      showAlert($('portal_users_result'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  /* SKU Master -------------------------------------------------------- */

  async function loadSkuMaster() {
    try {
      const data = await adminFetch('/api/admin/sku-master');
      const tbody = $('sku_master_body');
      if (!tbody) return;
      tbody.innerHTML = data.rows.length
        ? data.rows.map((r) => `<tr><td>${escapeHtml(r.sku)}</td><td>${escapeHtml(r.buyer_display_name || r.buyer_username)}</td><td>${r.buyer_active ? '<span class="status-badge received">啟用</span>' : '<span class="status-badge locked">停用</span>'}</td><td>${escapeHtml(r.updated_at)}</td></tr>`).join('')
        : '<tr><td colspan="4" class="text-center text-secondary">尚未設定 SKU Master — ND 提交會被阻止。</td></tr>';
    } catch (err) {
      if ($('sku_master_body')) $('sku_master_body').innerHTML = `<tr><td colspan="4" class="text-center text-secondary">載入失敗：${escapeHtml(err.message)}</td></tr>`;
    }
  }

  $('btn_sku_upload').addEventListener('click', async () => {
    const file = $('sku_input').files[0];
    if (!file) {
      showAlert($('sku_result'), 'error', '請選擇 SKU Master CSV');
      return;
    }
    const btn = $('btn_sku_upload');
    btn.disabled = true;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const data = await adminFetch('/api/admin/sku-master', { method: 'PUT', body: fd });
      showAlert($('sku_result'), 'success', `SKU Master 已整批取代（${data.count} 個 SKU）。`);
      $('sku_input').value = '';
      loadSkuMaster();
    } catch (err) {
      showAlert($('sku_result'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  /* Store routes ------------------------------------------------------ */

  async function loadStoreRoutes() {
    try {
      const data = await adminFetch('/api/admin/store-routes');
      const tbody = $('store_routes_body');
      if (!tbody) return;
      tbody.innerHTML = data.routes.map((r) => `<tr>
        <td>${escapeHtml(r.site_code)}</td>
        <td>${escapeHtml(r.shop || '—')}</td>
        <td><input type="checkbox" data-route-site="${escapeHtml(r.site_code)}" data-route-field="sct" ${r.sct_review_required ? 'checked' : ''}></td>
        <td><input type="checkbox" data-route-site="${escapeHtml(r.site_code)}" data-route-field="remark" ${r.remark_required ? 'checked' : ''}></td>
        <td>${escapeHtml(r.updated_at)}</td>
        <td><button class="btn ghost btn-route-save" data-site="${escapeHtml(r.site_code)}">儲存</button> <button class="btn ghost btn-route-del" data-site="${escapeHtml(r.site_code)}">移除</button></td>
      </tr>`).join('');
      tbody.querySelectorAll('.btn-route-save').forEach((btn) => {
        btn.addEventListener('click', () => saveStoreRoute(btn.dataset.site));
      });
      tbody.querySelectorAll('.btn-route-del').forEach((btn) => {
        btn.addEventListener('click', () => removeStoreRoute(btn.dataset.site));
      });
    } catch (err) {
      if ($('store_routes_body')) $('store_routes_body').innerHTML = `<tr><td colspan="6" class="text-center text-secondary">載入失敗：${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function saveStoreRoute(site) {
    const sct = document.querySelector(`input[data-route-site="${CSS.escape(site)}"][data-route-field="sct"]`)?.checked ?? false;
    const remark = document.querySelector(`input[data-route-site="${CSS.escape(site)}"][data-route-field="remark"]`)?.checked ?? false;
    adminFetch('/api/admin/store-routes', { method: 'PUT', body: JSON.stringify({ site_code: site, sct_review_required: sct, remark_required: remark }) })
      .then(() => {
        showAlert($('store_routes_result'), 'success', `「${site}」路由設定已更新。`);
        loadStoreRoutes();
      })
      .catch((err) => showAlert($('store_routes_result'), 'error', escapeHtml(err.message)));
  }

  $('btn_route_add').addEventListener('click', async () => {
    const site = $('route_site_new').value.trim().toUpperCase();
    if (!site) {
      showAlert($('store_routes_result'), 'error', '請輸入 Site Code');
      return;
    }
    const btn = $('btn_route_add');
    btn.disabled = true;
    try {
      await adminFetch('/api/admin/store-routes', {
        method: 'PUT',
        body: JSON.stringify({ site_code: site, sct_review_required: true, remark_required: true }),
      });
      showAlert($('store_routes_result'), 'success', `「${site}」已加入指定店（SCT 審批 + Remark 必填），只影響新申請。`);
      $('route_site_new').value = '';
      loadStoreRoutes();
    } catch (err) {
      showAlert($('store_routes_result'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  function removeStoreRoute(site) {
    const ok = window.confirm(`確認將「${site}」移出指定店？已建立的申請不受影響，此店之後的新 RF 申請改為普通路由（不需 SCT 審批）。`);
    if (!ok) return;
    adminFetch(`/api/admin/store-routes/${encodeURIComponent(site)}`, { method: 'DELETE' })
      .then(() => {
        showAlert($('store_routes_result'), 'success', `「${site}」已移出指定店。`);
        loadStoreRoutes();
      })
      .catch((err) => showAlert($('store_routes_result'), 'error', escapeHtml(err.message)));
  }

  /* Rejection reasons -------------------------------------------------- */

  async function loadRejectionReasons() {
    try {
      const data = await adminFetch('/api/admin/rejection-reasons');
      const tbody = $('rejection_body');
      if (!tbody) return;
      tbody.innerHTML = data.reasons.map((r) => `<tr>
        <td>${escapeHtml(r.code)}</td>
        <td>${escapeHtml(r.label)}</td>
        <td>${r.sort_order}</td>
        <td>${r.active ? '<span class="status-badge received">啟用</span>' : '<span class="status-badge locked">停用</span>'}</td>
        <td>${escapeHtml(r.updated_by || '—')}</td>
        <td><button class="btn ghost btn-rr-toggle" data-code="${escapeHtml(r.code)}" data-active="${r.active}">${r.active ? '停用' : '啟用'}</button></td>
      </tr>`).join('');
      tbody.querySelectorAll('.btn-rr-toggle').forEach((btn) => {
        btn.addEventListener('click', () => {
          adminFetch('/api/admin/rejection-reasons', {
            method: 'PUT',
            body: JSON.stringify({ code: btn.dataset.code, label: '', sort_order: 0, active: btn.dataset.active === 'false' }),
          }).then(() => { showAlert($('rejection_result'), 'success', '已更新。'); loadRejectionReasons(); }).catch((err) => showAlert($('rejection_result'), 'error', escapeHtml(err.message)));
        });
      });
    } catch (err) {
      if ($('rejection_body')) $('rejection_body').innerHTML = `<tr><td colspan="6" class="text-center text-secondary">載入失敗：${escapeHtml(err.message)}</td></tr>`;
    }
  }

  $('btn_rr_upsert').addEventListener('click', async () => {
    const code = $('rr_code').value.trim();
    const label = $('rr_label').value.trim();
    if (!code || !label) {
      showAlert($('rejection_result'), 'error', '請填寫 Code 及顯示名稱');
      return;
    }
    try {
      await adminFetch('/api/admin/rejection-reasons', {
        method: 'PUT',
        body: JSON.stringify({ code, label, sort_order: Number($('rr_sort').value) || 0, active: true }),
      });
      showAlert($('rejection_result'), 'success', '原因類別已儲存。');
      $('rr_code').value = '';
      $('rr_label').value = '';
      $('rr_sort').value = '0';
      loadRejectionReasons();
    } catch (err) {
      showAlert($('rejection_result'), 'error', escapeHtml(err.message));
    }
  });

  /* Buyer pending review reminder ----------------------------------------- */

  async function loadReviewPending() {
    try {
      const data = await adminFetch('/api/admin/review-pending');
      const tbody = $('review_pending_body');
      if (!tbody) return;
      if (!data.buyers.length && !data.unassigned.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-secondary">目前沒有待審批的 ND 申請。</td></tr>';
        return;
      }
      tbody.innerHTML = data.buyers.map((b) => `<tr>
        <td>${escapeHtml(b.buyer_username)}</td>
        <td>${escapeHtml(b.buyer_display_name || '—')}</td>
        <td>${b.buyer_active ? '<span class="status-badge received">啟用</span>' : '<span class="status-badge locked">停用</span>'}</td>
        <td>${b.pending_submissions}</td>
        <td>${b.pending_skus}</td>
        <td class="text-secondary" style="font-size:12px;word-break:break-all" title="${escapeHtml(b.skus.join(', '))}">${escapeHtml(b.skus.join(', '))}</td>
      </tr>`).join('')
        + (data.unassigned.length
          ? `<tr><td colspan="6" class="text-danger">⚠ 有 ${data.unassigned.length} 筆待審申請未分配 Buyer 或所屬 Buyer 已停用（請檢查 SKU Master 或帳戶狀態）</td></tr>`
          : '')
        + `<tr><td colspan="6" class="text-secondary small">合計：${data.total_pending_submissions} 筆申請／${data.total_pending_skus} 個 SKU</td></tr>`;
    } catch (err) {
      if ($('review_pending_body')) $('review_pending_body').innerHTML = `<tr><td colspan="6" class="text-center text-secondary">載入失敗：${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function downloadReviewPending() {
    try {
      const token = await getCsrf();
      const response = await fetch('/api/admin/review-pending/export', {
        headers: { 'x-csrf-token': token },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: '下載失敗' }));
        throw new Error(errorData.error || '下載失敗');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = match ? match[1] : 'Buyer_Pending_Review.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showAlert($('review_pending_result'), 'success', '提醒 Excel 已下載。');
    } catch (err) {
      showAlert($('review_pending_result'), 'error', escapeHtml(err.message));
    }
  }

  $('btn_review_pending_export').addEventListener('click', downloadReviewPending);
  $('btn_review_pending_refresh').addEventListener('click', loadReviewPending);
  async function runAutoApprove() {
    const ok = window.confirm('確認立即執行「Buyer 逾期自動批准」？\n\n規則：ND 申請超過 ' + (globalThis.NDRF_OPTIONS?.autoApproveDays ?? 7) + ' 日 Buyer 未有回覆，系統會視為默認同意（Accept），並在審批時間線註明「Buyer 未有回復，默認同意」。\n已匯出、已鎖定或已有決定的申請不會被影響。');
    if (!ok) return;
    const btn = $('btn_auto_approve');
    btn.disabled = true;
    btn.textContent = '執行中…';
    try {
      const data = await adminFetch('/api/admin/review-pending/auto-approve', { method: 'POST', body: JSON.stringify({}) });
      showAlert($('review_pending_result'), 'success', `已完成：自動批准 ${data.approved} 筆（跳過 ${data.skipped} 筆）。`);
      loadReviewPending();
      loadList();
    } catch (err) {
      showAlert($('review_pending_result'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = '執行逾期自動批准（Buyer 7 日未回覆 → 默認同意）';
    }
  }

  $('btn_auto_approve')?.addEventListener('click', runAutoApprove);
  $('btn_logout').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const token = await getCsrf();
      await fetch('/api/admin/logout', { method: 'POST', headers: { 'x-csrf-token': token } });
    } catch {}
    window.location.href = '/admin/login.html';
  });

  const lazyLoaded = new Set();
  const lazyLoaders = {
    'portal-users': loadPortalUsers,
    'sku-master': loadSkuMaster,
    'store-routes': loadStoreRoutes,
    'rejection-reasons': loadRejectionReasons,
    stores: loadStoreCount,
    'recovery-codes': loadRecoveryCodes,
  };

  function loadLazySection(key) {
    if (!key || lazyLoaded.has(key)) return;
    const fn = lazyLoaders[key];
    if (!fn) return;
    lazyLoaded.add(key);
    try { fn(); } catch {}
  }

  function setupLazySections() {
    const cards = document.querySelectorAll('[data-lazy-section]');
    if (!('IntersectionObserver' in window)) {
      Object.keys(lazyLoaders).forEach(loadLazySection);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const key = entry.target.dataset.lazySection;
        if (!key || lazyLoaded.has(key)) return;
        loadLazySection(key);
        io.unobserve(entry.target);
      });
    }, { rootMargin: '400px 0px' });
    cards.forEach((el) => {
      // 零銷售由 admin-zero-sales.js 負責，跳過避免重複
      if (el.dataset.lazySection === 'zero-sales') return;
      io.observe(el);
    });
  }

  const TAB_LAZY = {
    accounts: ['portal-users', 'sku-master'],
    review: ['store-routes', 'rejection-reasons'],
    system: ['stores', 'recovery-codes'],
  };

  function refreshActiveTab(manual = false) {
    const tab = globalThis.__adminActiveTab || 'overview';
    if (tab === 'overview') loadSummary();
    else if (tab === 'list') loadList();
    else if (tab === 'batches') loadExportBatches();
    else if (tab === 'review') {
      loadReviewPending();
      if (manual) {
        loadStoreRoutes();
        loadRejectionReasons();
      }
    } else if (tab === 'accounts' && manual) {
      loadPortalUsers();
      loadSkuMaster();
    } else if (tab === 'system' && manual) {
      loadStoreCount();
      loadRecoveryCodes();
    } else if (tab === 'zero-sales') {
      try { globalThis.__zsRefresh?.(); } catch {}
    }
  }

  document.addEventListener('admin:tab-activated', (event) => {
    const tab = event.detail?.tab;
    (TAB_LAZY[tab] || []).forEach(loadLazySection);
    refreshActiveTab();
  });

  // 供頂部導航「立即更新」使用
  globalThis.__adminRefresh = () => {
    refreshActiveTab(true);
    const note = document.getElementById('nav_refresh_note');
    if (note) {
      const now = new Date().toLocaleTimeString('zh-HK', { hour12: false });
      note.textContent = `已更新 ${now} · 每分鐘自動更新`;
    }
  };

  setDefaultDateFilters();
  setupLazySections();

  ensureAuth().then((username) => {
    if (!username) {
      window.location.replace('/admin/login.html');
    }
  });

  setInterval(() => {
    if (document.visibilityState === 'visible' && !document.body.classList.contains('drawer-open')) {
      refreshActiveTab();
    }
  }, 60000);
  populateNdCodeDatalists();
  api('/api/public/return/schedule').then((data) => {
    $('a_return_reason').innerHTML = '<option value="">請選擇申請退貨原因</option>' + data.reasons.map((r) => `<option value="${escapeHtml(r.code)}">${escapeHtml(r.label)}</option>`).join('');
  }).catch(() => {});
})();
