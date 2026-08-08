(() => {
  const $ = (id) => document.getElementById(id);
  let current = null;

  function isUrgent() {
    return current?.submission?.submission_type === 'urgent';
  }

  function isSales() {
    return current?.submission?.submission_type === 'sales';
  }

  function isReturn() {
    return current?.submission?.submission_type === 'return';
  }

  function syncOtherReasonWrap() {
    const reason = $('f_u_urgent_reason').value;
    $('f_u_other_wrap').style.display = reason === '9' ? '' : 'none';
  }

  $('f_u_urgent_reason').addEventListener('change', syncOtherReasonWrap);

  function syncRpTypeFields() {
    const rpType = $('f_rp_type').value;
    $('f_safety_stock_wrap').style.display = rpType === 'ND' ? 'none' : '';
    $('f_nd_code_wrap').style.display = rpType === 'RF' ? 'none' : '';
  }
  $('f_rp_type').addEventListener('change', syncRpTypeFields);

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

  const recoverBox = $('recover_box');
  $('btn_toggle_recover').addEventListener('click', () => {
    const hidden = recoverBox.style.display === 'none';
    recoverBox.style.display = hidden ? '' : 'none';
    if (hidden) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
      if (!$('r_from').value) $('r_from').value = today;
      if (!$('r_to').value) $('r_to').value = today;
    }
  });

  $('recover_form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const site = $('r_site').value.trim().toUpperCase();
    const recoveryCode = $('r_recovery_code').value;
    if (!site) {
      showAlert($('recover_error'), 'error', '請輸入 Site Code');
      return;
    }
    if (!recoveryCode) {
      showAlert($('recover_error'), 'error', '請輸入 Recovery Code');
      return;
    }
    showAlert($('recover_error'), '', '');
    const params = new URLSearchParams();
    params.set('site_code', site);
    if ($('r_from').value) params.set('from', $('r_from').value);
    if ($('r_to').value) params.set('to', $('r_to').value);
    const sku = $('r_sku').value.trim();
    if (sku) params.set('sku', sku);
    const btn = $('btn_recover');
    btn.disabled = true;
    btn.textContent = '查詢中…';
    try {
      const data = await api(`/api/public/my-applications?${params.toString()}`, {
        headers: { 'x-recovery-code': recoveryCode },
      });
      const rows = data.rows || [];
      const TYPE_LABEL = { normal: '一般 NDRF', urgent: 'Urgent Order', sales: '突發性銷售', return: '行貨退貨' };
      if (!rows.length) {
        $('recover_result').innerHTML = '<div class="alert warning">搵唔到相關申報，請檢查 Site Code、日期範圍或 SKU。</div>';
      } else {
        let html = `<div class="alert success">搵到 ${rows.length} 筆申報，撳「申請編號」即可前往查詢／修改。</div>`;
        html += '<div class="table-scroll"><table><thead><tr><th>申請編號</th><th>類型</th><th>SKU</th><th>申請日期</th><th>提交時間</th><th>狀態</th></tr></thead><tbody>';
        rows.forEach((r) => {
          const typeLabel = TYPE_LABEL[r.submission_type] || r.submission_type;
          const status = r.locked ? '已鎖定' : '可修改';
          html += `<tr><td><a href="#" class="recover-link" data-no="${escapeHtml(r.application_no)}">${escapeHtml(r.application_no)}</a></td><td>${escapeHtml(typeLabel)}</td><td>${escapeHtml(r.sku)}</td><td>${escapeHtml(r.application_date)}</td><td>${escapeHtml(r.submitted_at)}</td><td>${escapeHtml(status)}</td></tr>`;
        });
        html += '</tbody></table></div>';
        $('recover_result').innerHTML = html;
        $('recover_result').querySelectorAll('.recover-link').forEach((link) => {
          link.addEventListener('click', (ev) => {
            ev.preventDefault();
            $('q_no').value = link.dataset.no;
            $('q_site').value = site;
            recoverBox.style.display = 'none';
            $('search_form').requestSubmit();
          });
        });
      }
    } catch (err) {
      showAlert($('recover_error'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = '搵返申請編號';
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
    if (isUrgent()) {
      headerRows += `
        <dt>QTY</dt><dd>${escapeHtml(s.qty)}</dd>
        <dt>Urgent Reason</dt><dd>${escapeHtml(s.urgent_reason_label || s.urgent_reason)}${s.urgent_reason_other ? '（' + escapeHtml(s.urgent_reason_other) + '）' : ''}</dd>`;
    } else if (isSales()) {
      headerRows += '<dt>申報類型</dt><dd>突發性銷售申報</dd>';
    } else if (isReturn()) {
      headerRows += `<dt>申報類型</dt><dd>行貨退貨報數</dd><dt>QTY</dt><dd>${escapeHtml(s.return_qty)}</dd><dt>REASON</dt><dd>${escapeHtml(s.return_reason_label || s.return_reason)}</dd><dt>確認人姓名</dt><dd>${escapeHtml(s.return_confirmer_name)}</dd><dt>確認人電話</dt><dd>${escapeHtml(s.return_confirmer_phone)}</dd>`;
    }
    if (s.locked_at) {
      headerRows += `<dt>鎖定時間</dt><dd>${escapeHtml(s.locked_at)}</dd>`;
    }
    $('detail_header').innerHTML = headerRows;

    $('f_sku').value = s.sku || '';

    const normalFields = $('normal_fields');
    const urgentFields = $('urgent_fields');
    if (isUrgent()) {
      normalFields.style.display = 'none';
      urgentFields.style.display = '';
      $('return_fields').style.display = 'none';
      $('f_u_qty').value = s.qty ?? '';
      $('f_u_urgent_reason').value = s.urgent_reason || '';
      $('f_u_urgent_reason_other').value = s.urgent_reason_other || '';
      syncOtherReasonWrap();
    } else if (isSales()) {
      normalFields.style.display = 'none';
      urgentFields.style.display = 'none';
      $('return_fields').style.display = 'none';
    } else if (isReturn()) {
      normalFields.style.display = 'none';
      urgentFields.style.display = 'none';
      $('return_fields').style.display = '';
      $('f_return_qty').value = s.return_qty ?? '';
      $('f_return_reason').value = s.return_reason || '';
      $('f_return_name').value = s.return_confirmer_name || '';
      $('f_return_phone').value = s.return_confirmer_phone || '';
    } else {
      normalFields.style.display = '';
      urgentFields.style.display = 'none';
      $('return_fields').style.display = 'none';
      $('f_rp_type').value = s.rp_type || '';
      $('f_safety_stock').value = s.safety_stock || '';
      $('f_nd_code').value = s.nd_code || '';
      $('f_remark').value = s.remark || '';
      syncRpTypeFields();
    }

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
      tr.innerHTML = `<td>${v.version}</td><td>${escapeHtml(v.changed_at)}</td><td>${actor}</td><td>${escapeHtml(src)}</td><td>${versionChangesHtml(v)}</td>`;
      tbody.appendChild(tr);
    });

    const btn = $('btn_save');
    btn.disabled = false;
    if (s.locked) {
      $('lock_banner').innerHTML = '<div class="alert warning">此申報已被匯出並鎖定，不能修改。</div>';
      $('modify_box').style.display = 'none';
    } else if (isUrgent()) {
      $('modify_box').style.display = '';
      api('/api/public/urgent/window').then((w) => {
        if (w?.open) {
          $('lock_banner').innerHTML = '';
          $('save_note').textContent = '每日 14:30 前可修改，每次修改會新增一個版本紀錄。';
        } else {
          $('lock_banner').innerHTML = '<div class="alert warning">提交時段已結束（每日 14:30 後暫停修改），現時只可查詢。</div>';
          $('save_note').textContent = '';
          btn.disabled = true;
        }
      }).catch(() => {});
      $('save_note').textContent = '每日 14:30 前可修改，每次修改會新增一個版本紀錄。';
    } else if (isSales()) {
      $('lock_banner').innerHTML = '';
      $('modify_box').style.display = '';
      $('save_note').textContent = '沒有提交時間限制；匯出前可修改 SKU，每次修改會新增一個版本紀錄。';
    } else if (isReturn()) {
      $('modify_box').style.display = '';
      const windowOpen = Boolean(s.return_window_open);
      if (!windowOpen) {
        $('lock_banner').innerHTML = '<div class="alert warning">此申請所屬的店舖申請退行貨日期已結束，現時只可查詢。</div>';
        btn.disabled = true;
        $('save_note').textContent = '';
      } else {
        $('lock_banner').innerHTML = '';
        $('save_note').textContent = '只可於原申請窗口內修改，每次修改會新增一個版本紀錄。';
      }
    } else {
      $('lock_banner').innerHTML = '';
      $('modify_box').style.display = '';
      $('save_note').textContent = '匯出前可修改，每次修改會新增一個版本紀錄。';
    }
  }

  function validateUrgentFields(body) {
    const errors = [];
    if (!body.sku.trim()) {
      errors.push({ field: 'sku', message: 'SKU 為必填' });
    }
    const qty = Number(body.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
      errors.push({ field: 'qty', message: 'QTY 必須為 1 至 1000 的整數' });
    }
    if (!body.urgent_reason) {
      errors.push({ field: 'urgent_reason', message: 'Urgent Reason 為必填' });
    } else if (body.urgent_reason === '9') {
      if (!(body.urgent_reason_other || '').trim()) {
        errors.push({ field: 'urgent_reason_other', message: '選擇「9. 其他」時必須填寫 Other Reason' });
      }
    } else if ((body.urgent_reason_other || '').trim()) {
      errors.push({ field: 'urgent_reason_other', message: '僅選擇「9. 其他」時才可填寫 Other Reason' });
    }
    return errors;
  }

  $('btn_save').addEventListener('click', async () => {
    if (!current) return;
    const base = {
      application_no: current.submission.application_no,
      site_code: current.submission.site_code,
      sku: $('f_sku').value.trim(),
    };
    const body = isUrgent()
      ? {
          ...base,
          qty: Number($('f_u_qty').value),
          urgent_reason: $('f_u_urgent_reason').value,
          urgent_reason_other: $('f_u_urgent_reason_other').value.trim(),
        }
      : isSales()
        ? base
        : isReturn()
          ? { ...base, return_qty: Number($('f_return_qty').value), return_reason: $('f_return_reason').value, return_confirmer_name: $('f_return_name').value.trim(), return_confirmer_phone: $('f_return_phone').value.trim() }
        : {
          ...base,
          rp_type: $('f_rp_type').value,
          safety_stock: $('f_safety_stock').value.trim(),
          nd_code: $('f_nd_code').value.trim(),
          remark: $('f_remark').value.trim(),
        };
    const clientErrs = isUrgent()
      ? validateUrgentFields(body)
      : isSales()
        ? (body.sku.trim() ? [] : [{ message: 'SKU 為必填' }])
        : isReturn()
          ? ((body.sku.trim() && Number.isInteger(body.return_qty) && body.return_qty >= 1 && body.return_qty <= 9999 && body.return_reason && body.return_confirmer_name && body.return_confirmer_phone) ? [] : [{ message: '請填妥 QTY、REASON、確認人姓名及確認人電話' }])
        : validateBusinessFields(body, current.submission.site_code);
    if (body.sku.trim() && !/^(?:\d{7}|\d{12})$/.test(body.sku.trim())) {
      clientErrs.push({ message: 'SKU 只容許 7 位或 12 位數字，每個申請只能輸入一個 SKU' });
    }
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
  api('/api/public/return/schedule').then((data) => {
    $('f_return_reason').innerHTML = '<option value="">請選擇申請退貨原因</option>' + data.reasons.map((r) => `<option value="${escapeHtml(r.code)}">${escapeHtml(r.label)}</option>`).join('');
  }).catch(() => {});
})();
