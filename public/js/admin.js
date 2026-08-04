(() => {
  const $ = (id) => document.getElementById(id);
  let currentPage = 1;
  let totalPages = 1;
  let currentDetail = null;
  let pendingStoreFile = null;
  let csrfToken = null;

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
      tbody.innerHTML = '<tr><td colspan="9" class="empty">沒有符合條件的申報</td></tr>';
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
        <td>${escapeHtml(s.sku)}${s.submission_type === 'urgent' ? `<div class="hint">QTY: ${escapeHtml(s.qty)}</div>` : ''}</td>
        <td>${s.submission_type === 'urgent' ? '<span class="status-badge received">Urgent</span>' : '一般'}</td>
        <td>${s.source === 'web' ? '網頁' : 'Excel'}</td>
        <td>${escapeHtml(s.submitted_at)}</td>
        <td>${escapeHtml(s.updated_at || '—')}</td>
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
    ['from', 'to', 'site', 'sku', 'appno'].forEach((id) => ($(`f_${id}`).value = ''));
    ['source', 'type', 'exported'].forEach((id) => ($(`f_${id}`).value = ''));
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
    $('detail_title').textContent = `申報詳情 — ${s.application_no}`;
    let header = `
      <dt>狀態</dt><dd>${s.locked ? '<span class="status-badge locked">已鎖定</span>' : '<span class="status-badge received">已收件</span>'}</dd>
      <dt>類型</dt><dd>${isUrgent ? 'Urgent Order' : '一般 NDRF'}</dd>
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
    if (s.locked_at) header += `<dt>鎖定時間</dt><dd>${escapeHtml(s.locked_at)}</dd>`;
    if (s.exported_at) header += `<dt>匯出時間</dt><dd>${escapeHtml(s.exported_at)}</dd>`;
    $('detail_header').innerHTML = header;

    $('normal_fields').style.display = isUrgent ? 'none' : '';
    $('urgent_fields').style.display = isUrgent ? '' : 'none';
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
    const body = isUrgent
      ? {
          sku: $('a_sku_urgent').value.trim(),
          qty: $('a_qty').value === '' ? null : Number($('a_qty').value),
          urgent_reason: $('a_urgent_reason').value,
          urgent_reason_other: $('a_urgent_reason_other').value.trim(),
        }
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

  $('btn_export').addEventListener('click', async () => {
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
    } catch (err) {
      showAlert($('export_info'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = '匯出並鎖定';
    }
  });

  $('btn_urgent_export').addEventListener('click', async () => {
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
    } catch (err) {
      showAlert($('urgent_export_info'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = '匯出並鎖定';
    }
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
      setStat('normal', 'total', 's_normal_total');
      setStat('normal', 'exported', 's_normal_exported');
      setStat('normal', 'today', 's_normal_today');
      setStat('normal', 'today_exported', 's_normal_today_exported');
      setStat('urgent', 'total', 's_urgent_total');
      setStat('urgent', 'exported', 's_urgent_exported');
      setStat('urgent', 'today', 's_urgent_today');
      setStat('urgent', 'today_exported', 's_urgent_today_exported');
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
    loadList();
    loadSummary();
    loadStoreCount();
  });
  populateNdCodeDatalists();
})();
