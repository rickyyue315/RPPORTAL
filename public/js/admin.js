(() => {
  const $ = (id) => document.getElementById(id);
  let currentPage = 1;
  let totalPages = 1;
  let currentDetail = null;
  let pendingStoreFile = null;
  let csrfToken = null;
  const DATE_FILTER_IDS = ['f_from', 'f_to', 'e_from', 'e_to', 'ue_from', 'ue_to', 'se_from', 'se_to', 're_from', 're_to'];

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

  function buildQuery() {
    const params = new URLSearchParams();
    const idMap = { application_no: 'appno', submission_type: 'type', site_code: 'site' };
    ['from', 'to', 'site_code', 'source', 'submission_type', 'exported', 'sku', 'application_no'].forEach((k) => {
      const v = $(`f_${idMap[k] || k}`).value.trim();
      if (v) params.set(k, v);
    });
    params.set('page', String(currentPage));
    params.set('page_size', '20');
    return params.toString();
  }

  async function loadList() {
    showAlert($('list_error'), '', '');
    try {
      const data = await adminFetch(`/api/admin/submissions?${buildQuery()}`);
      totalPages = data.total_pages;
      renderList(data);
    } catch (err) {
      showAlert($('list_error'), 'error', escapeHtml(err.message));
    }
  }

  function renderList(data) {
    const tbody = $('list_body');
    tbody.innerHTML = '';
    if (!data.submissions.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="empty">沒有符合條件的申報</td></tr>';
      $('page_info').textContent = '0 筆';
      $('btn_prev').disabled = true;
      $('btn_next').disabled = true;
      return;
    }
    data.submissions.forEach((s) => {
      const tr = document.createElement('tr');
      const status = s.locked
        ? `<span class="status-badge locked">已鎖定</span>`
        : `<span class="status-badge received">已收件</span>`;
      tr.innerHTML = `
        <td>${escapeHtml(s.application_no)}</td>
        <td>${escapeHtml(s.site_code)}</td>
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
        loadDetail(a.dataset.id);
      });
    });
    $('page_info').textContent = `第 ${data.page} / ${data.total_pages} 頁（共 ${data.total} 筆）`;
    $('btn_prev').disabled = data.page <= 1;
    $('btn_next').disabled = data.page >= data.total_pages;
  }

  $('btn_filter').addEventListener('click', () => {
    currentPage = 1;
    loadList();
  });
  $('btn_reset').addEventListener('click', () => {
    ['site', 'sku', 'appno'].forEach((id) => ($(`f_${id}`).value = ''));
    ['source', 'type', 'exported'].forEach((id) => ($(`f_${id}`).value = ''));
    $('f_from').value = todayInHongKong();
    $('f_to').value = todayInHongKong();
    currentPage = 1;
    loadList();
  });
  $('btn_prev').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadList();
    }
  });
  $('btn_next').addEventListener('click', () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadList();
    }
  });

  async function loadDetail(id) {
    showAlert($('detail_error'), '', '');
    try {
      const data = await adminFetch(`/api/admin/submissions/${id}`);
      currentDetail = data;
      renderDetail(data);
      $('detail_card').style.display = '';
      $('detail_card').scrollIntoView({ behavior: 'smooth' });
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

    const box = $('versions_box');
    box.innerHTML = '';
    if (!data.versions.length) {
      box.innerHTML = '<div class="empty">沒有版本紀錄</div>';
      return;
    }
    let html = '<table><thead><tr><th>版本</th><th>修改時間 (HK)</th><th>操作者</th><th>IP</th><th>來源</th></tr></thead><tbody>';
    const SRC_LABEL = { web_submit: '網頁提交', excel_import: 'Excel 匯入', web_modify: '網頁修改', admin_edit: '管理員修改' };
    data.versions.forEach((v) => {
      const actor = v.actor_role === 'admin' ? `管理員 (${v.actor || '—'})` : '申請人';
      html += `<tr><td>${v.version}</td><td>${escapeHtml(v.changed_at)}</td><td>${actor}</td><td>${escapeHtml(v.ip || '—')}</td><td>${escapeHtml(SRC_LABEL[v.change_source] || v.change_source)}</td></tr>`;
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

  $('btn_close_detail').addEventListener('click', () => {
    $('detail_card').style.display = 'none';
    currentDetail = null;
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
      loadExportBatches();
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
      loadExportBatches();
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
       const blob = await response.blob(); const disposition = response.headers.get('Content-Disposition') || ''; const match = disposition.match(/filename="([^"]+)"/); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = match ? match[1] : 'Return_Goods_Export.xlsx'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); showAlert($('return_export_info'), 'success', '匯出成功，相關申報已鎖定。'); loadList(); loadSummary(); loadExportBatches();
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
    try {
      const data = await adminFetch('/api/admin/summary');
      const setStat = (type, key, id) => setNum(id, data[type][key]);
      setNum('s_stores_today', data.stores_today);
      setStat('normal', 'total', 's_normal_total');
      setStat('normal', 'exported', 's_normal_exported');
      setStat('normal', 'today', 's_normal_today');
      setStat('normal', 'today_exported', 's_normal_today_exported');
      setStat('normal', 'stores_today', 's_normal_stores_today');
      setStat('urgent', 'total', 's_urgent_total');
      setStat('urgent', 'exported', 's_urgent_exported');
      setStat('urgent', 'today', 's_urgent_today');
      setStat('urgent', 'today_exported', 's_urgent_today_exported');
      setStat('urgent', 'stores_today', 's_urgent_stores_today');
      setStat('sales', 'total', 's_sales_total');
      setStat('sales', 'exported', 's_sales_exported');
      setStat('sales', 'today', 's_sales_today');
      setStat('sales', 'today_exported', 's_sales_today_exported');
       setStat('sales', 'stores_today', 's_sales_stores_today');
       setStat('return', 'total', 's_return_total');
       setStat('return', 'exported', 's_return_exported');
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

  async function loadExportBatches() {
    try {
      const data = await adminFetch('/api/admin/batches');
      renderExportBatches(data);
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
      loadExportBatches();
    } catch (error) {
      showAlert($('sales_export_info'), 'error', escapeHtml(error.message));
      loadExportBatches();
    } finally {
      btn.disabled = false;
      btn.textContent = '匯出並鎖定';
    }
  });

  $('btn_logout').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const token = await getCsrf();
      await fetch('/api/admin/logout', { method: 'POST', headers: { 'x-csrf-token': token } });
    } catch {}
    window.location.href = '/admin/login.html';
  });

  ensureAuth().then((username) => {
    if (!username) {
      window.location.replace('/admin/login.html');
      return;
    }
    setDefaultDateFilters();
    loadList();
    loadSummary();
    loadExportBatches();
    loadStoreCount();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      loadSummary();
      loadList();
      loadExportBatches();
    }
  }, 60000);
  populateNdCodeDatalists();
  api('/api/public/return/schedule').then((data) => {
    $('a_return_reason').innerHTML = '<option value="">請選擇申請退貨原因</option>' + data.reasons.map((r) => `<option value="${escapeHtml(r.code)}">${escapeHtml(r.label)}</option>`).join('');
  }).catch(() => {});
})();
