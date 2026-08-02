(() => {
  const $ = (id) => document.getElementById(id);
  let current = null;

  $('search_form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const no = $('q_no').value.trim().toUpperCase();
    const site = $('q_site').value.trim().toUpperCase();
    if (!no || !site) {
      showAlert($('search_error'), 'error', '請輸入申請編號及 Site Code');
      return;
    }
    showAlert($('search_error'), '', '');
    try {
      const data = await api(`/api/public/query?application_no=${encodeURIComponent(no)}&site_code=${encodeURIComponent(site)}`);
      renderDetail(data);
      $('search_card').style.display = 'none';
      $('detail_card').style.display = '';
    } catch (err) {
      showAlert($('search_error'), 'error', escapeHtml(err.message));
    }
  });

  function renderDetail(data) {
    current = data;
    const s = data.submission;
    const lockBadge = s.locked
      ? `<span class="status-badge locked">已鎖定</span>`
      : `<span class="status-badge received">已收件</span>`;

    let headerRows = `
      <dt>申請編號</dt><dd><b>${escapeHtml(s.application_no)}</b></dd>
      <dt>狀態</dt><dd>${lockBadge}</dd>
      <dt>Site Code</dt><dd>${escapeHtml(s.site_code)}（${escapeHtml(data.store?.shop || '')}）</dd>
      <dt>申請電郵</dt><dd>${escapeHtml(s.requested_by_email)}</dd>
      <dt>申請日期</dt><dd>${escapeHtml(s.application_date)}</dd>
      <dt>申請時間</dt><dd>${escapeHtml(s.submitted_at)}</dd>`;
    if (s.locked_at) {
      headerRows += `<dt>鎖定時間</dt><dd>${escapeHtml(s.locked_at)}</dd>`;
    }
    $('detail_header').innerHTML = headerRows;

    if (s.locked) {
      $('lock_banner').innerHTML = '<div class="alert warning">此申報已被匯出並鎖定，不能修改。</div>';
      $('modify_box').style.display = 'none';
    } else {
      $('lock_banner').innerHTML = '';
      $('modify_box').style.display = '';
      $('save_note').textContent = '匯出前可修改，每次修改會新增一個版本紀錄。';
    }

    $('f_brand').value = s.brand || '';
    $('f_sku').value = s.sku || '';
    $('f_rp_type').value = s.rp_type || '';
    $('f_safety_stock').value = s.safety_stock || '';
    $('f_nd_code').value = s.nd_code || '';
    $('f_remark').value = s.remark || '';

    const tbody = $('versions_table').querySelector('tbody');
    tbody.innerHTML = '';
    const SRC_LABEL = {
      web_submit: '網頁提交',
      excel_import: 'Excel 匯入',
      web_modify: '網頁修改',
      admin_edit: '管理員修改',
    };
    data.versions.forEach((v) => {
      const tr = document.createElement('tr');
      const actor = v.actor_role === 'admin' ? '管理員' : '申請人';
      const src = SRC_LABEL[v.change_source] || v.change_source;
      tr.innerHTML = `<td>${v.version}</td><td>${escapeHtml(v.changed_at)}</td><td>${actor}</td><td>${escapeHtml(src)}</td>`;
      tbody.appendChild(tr);
    });
  }

  $('btn_save').addEventListener('click', async () => {
    if (!current) return;
    const body = {
      application_no: current.submission.application_no,
      site_code: current.submission.site_code,
      brand: $('f_brand').value.trim(),
      sku: $('f_sku').value.trim(),
      rp_type: $('f_rp_type').value,
      safety_stock: $('f_safety_stock').value.trim(),
      nd_code: $('f_nd_code').value.trim(),
      remark: $('f_remark').value.trim(),
    };
    const clientErrs = validateBusinessFields(body, current.submission.site_code);
    if (clientErrs.length) {
      showAlert($('save_error'), 'error', clientErrs.map((e) => escapeHtml(e.message)).join('<br>'));
      return;
    }
    const btn = $('btn_save');
    btn.disabled = true;
    btn.textContent = '儲存中…';
    showAlert($('save_error'), '', '');
    try {
      const data = await api('/api/public/modify', { method: 'POST', body: JSON.stringify(body) });
      const refreshed = await api(
        `/api/public/query?application_no=${encodeURIComponent(current.submission.application_no)}&site_code=${encodeURIComponent(current.submission.site_code)}`,
      );
      renderDetail(refreshed);
      showAlert($('save_error'), 'success', '修改已儲存。');
    } catch (err) {
      showAlert($('save_error'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = '儲存修改';
    }
  });

  $('btn_back').addEventListener('click', () => {
    $('detail_card').style.display = 'none';
    $('search_card').style.display = '';
    $('q_no').value = '';
    $('q_site').value = '';
    showAlert($('search_error'), '', '');
  });

  populateNdCodeDatalists();
})();
