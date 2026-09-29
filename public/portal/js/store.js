(() => {
  const $ = (id) => document.getElementById(id);
  const p = window.portal;
  let storeInfo = null;
  let routeInfo = null;
  let pendingFile = null;
  let pendingImportKey = null;

  const SKU_RE = new RegExp(globalThis.NDRF_OPTIONS?.skuPattern || '^(?:\\d{7}|\\d{12})$');

  function readForm() {
    return {
      brand: $('brand').value.trim(),
      sku: $('sku').value.trim(),
      rp_type: $('rp_type').value,
      safety_stock: $('safety_stock').value.trim(),
      nd_code: $('nd_code').value.trim(),
      remark: $('remark').value.trim(),
    };
  }

  function syncRpTypeFields() {
    const rpType = $('rp_type').value;
    $('safety_stock_wrap').style.display = rpType === 'ND' ? 'none' : '';
    $('nd_code_wrap').style.display = rpType === 'RF' ? 'none' : '';
    if (rpType === 'RF') $('nd_code').value = '';
    if (rpType === 'ND') $('safety_stock').value = '';
  }

  function validateForm(d) {
    const errors = [];
    if (!d.sku) errors.push('SKU 為必填');
    else if (!SKU_RE.test(d.sku)) errors.push('SKU 只容許 7 位或 12 位數字，每個申請只能輸入一個 SKU');
    validateBusinessFields(d, storeInfo?.site_code || '').forEach((e) => errors.push(e.message));
    if (routeInfo?.remark_required && d.rp_type === 'RF' && !d.remark.trim()) {
      errors.push('此店舖轉 RF 時必須填寫 Remark');
    }
    return errors;
  }

  async function loadOptions() {
    const data = await p.api('/api/portal/store/options');
    storeInfo = data.store;
    routeInfo = data.route;
    $('site_code_display').textContent = storeInfo.site_code;
    $('store_header').textContent = `一般 NDRF 申報 — ${storeInfo.site_code} ${storeInfo.shop}`;
    const rpSelect = $('rp_type');
    rpSelect.innerHTML = '<option value="">—</option>'
      + globalThis.NDRF_OPTIONS.rpTypes.map((code) => `<option value="${code}">${code}</option>`).join('');
    populateNdCodeDatalists();
    syncRpTypeFields();
  }

  async function loadList() {
    const data = await p.api('/api/portal/store/submissions');
    const list = $('submission_list');
    if (!data.submissions.length) {
      list.innerHTML = '<div class="hint">暫無申請</div>';
      return;
    }
    list.innerHTML = '<table><thead><tr><th>申請編號</th><th>SKU</th><th>RP Type</th><th>狀態</th><th>提交時間</th><th></th></tr></thead><tbody>'
      + data.submissions.map((s) => `
        <tr>
          <td class="cell-appno">${p.escapeHtml(s.application_no)}</td>
          <td>${p.escapeHtml(s.sku)}</td>
          <td>${p.escapeHtml(s.rp_type || '—')}</td>
          <td>${p.workflowBadge(s.workflow_status)}</td>
          <td>${p.escapeHtml(s.submitted_at)}</td>
          <td><button class="btn ghost" data-detail="${s.id}">詳情</button></td>
        </tr>`).join('')
      + '</tbody></table>';
    list.querySelectorAll('[data-detail]').forEach((btn) => {
      btn.addEventListener('click', () => showDetail(btn.dataset.detail));
    });
  }

  async function showDetail(id) {
    const data = await p.api(`/api/portal/store/submissions/${id}`);
    const s = data.submission;
    $('detail_body').innerHTML = `
      <div class="dl">
        <dt>申請編號</dt><dd>${p.escapeHtml(s.application_no)}</dd>
        <dt>狀態</dt><dd>${p.workflowBadge(s.workflow_status)}</dd>
        <dt>SKU</dt><dd>${p.escapeHtml(s.sku)}</dd>
        <dt>RP Type</dt><dd>${p.escapeHtml(s.rp_type || '—')}</dd>
        <dt>Safety stock</dt><dd>${p.escapeHtml(s.safety_stock || '—')}</dd>
        <dt>ND Code</dt><dd>${p.escapeHtml(s.nd_code || '—')}</dd>
        <dt>Remark</dt><dd>${p.escapeHtml(s.remark || '—')}</dd>
        ${s.rejected_at ? `<dt>拒絕時間</dt><dd>${p.escapeHtml(s.rejected_at)}</dd>` : ''}
        ${s.review_remark ? `<dt>Review Remark</dt><dd>${p.escapeHtml(s.review_remark)}</dd>` : ''}
        ${s.exported_at ? `<dt>匯出時間</dt><dd>${p.escapeHtml(s.exported_at)}</dd>` : ''}
      </div>
      <h3>審批時間線</h3>
      ${p.statusTimeline(data.events)}`;
    $('detail_card').style.display = '';
    $('detail_card').scrollIntoView({ behavior: 'smooth' });
  }

  $('apply_form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = readForm();
    const errors = validateForm(d);
    if (errors.length) {
      p.showAlert($('form_error'), 'error', errors.map((m) => `<div>${p.escapeHtml(m)}</div>`).join(''));
      return;
    }
    p.showAlert($('form_error'), '', '');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const data = await p.api('/api/portal/store/submit', {
        method: 'POST',
        headers: { 'Idempotency-Key': createIdempotencyKey() },
        body: JSON.stringify(d),
      });
      p.showAlert($('submit_result'), 'success',
        `<b>已成功提交</b> — 申請編號：<b class="cell-appno">${p.escapeHtml(data.submission.application_no)}</b>（${p.escapeHtml(data.submission.submitted_at)}）`);
      e.target.reset();
      syncRpTypeFields();
      await loadList();
    } catch (err) {
      p.showAlert($('form_error'), 'error', p.escapeHtml(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = '提交';
    }
  });

  const setPendingFile = (file) => {
    pendingFile = file;
    try {
      const saved = JSON.parse(sessionStorage.getItem('ndrf_portal_import') || 'null');
      pendingImportKey = saved && saved.name === file.name && saved.size === file.size && saved.key ? saved.key : createIdempotencyKey();
    } catch {
      pendingImportKey = createIdempotencyKey();
    }
    try {
      sessionStorage.setItem('ndrf_portal_import', JSON.stringify({ name: file.name, size: file.size, key: pendingImportKey }));
    } catch {}
    $('file_label').textContent = `已選擇：${file.name}`;
  };

  $('file_drop').addEventListener('click', () => $('file_input').click());
  $('file_drop').addEventListener('dragover', (e) => { e.preventDefault(); $('file_drop').classList.add('dragover'); });
  $('file_drop').addEventListener('dragleave', () => $('file_drop').classList.remove('dragover'));
  $('file_drop').addEventListener('drop', (e) => {
    e.preventDefault();
    $('file_drop').classList.remove('dragover');
    if (e.dataTransfer.files.length) setPendingFile(e.dataTransfer.files[0]);
  });
  $('file_input').addEventListener('change', () => {
    if ($('file_input').files.length) setPendingFile($('file_input').files[0]);
  });

  $('btn_import').addEventListener('click', async () => {
    if (!pendingFile) {
      p.showAlert($('import_result'), 'error', '請先選擇 .xlsx 檔案');
      return;
    }
    const btn = $('btn_import');
    btn.disabled = true;
    btn.textContent = '匯入中…';
    p.showAlert($('import_result'), '', '');
    const fd = new FormData();
    fd.append('file', pendingFile);
    try {
      const data = await p.api('/api/portal/store/import', {
        method: 'POST',
        headers: { 'Idempotency-Key': pendingImportKey },
        body: fd,
      });
      let html = `<div class="alert success"><b>${p.escapeHtml(data.message)}</b>（總行數：${data.totalRows}）</div>`;
      html += '<table><thead><tr><th>Excel 行</th><th>申請編號</th><th>SKU</th><th>已收件時間</th></tr></thead><tbody>';
      data.rows.forEach((r) => {
        html += `<tr><td>${r.row}</td><td class="cell-appno">${p.escapeHtml(r.application_no)}</td><td>${p.escapeHtml(r.sku)}</td><td>${p.escapeHtml(r.submitted_at)}</td></tr>`;
      });
      html += '</tbody></table>';
      html += '<div class="btn-row"><button class="btn ghost" id="btn_dl_record">下載匯入記錄 Excel</button></div>';
      $('import_result').innerHTML = html;
      const batchKey = pendingImportKey;
      const batchId = data.batchId;
      pendingFile = null;
      pendingImportKey = null;
      try { sessionStorage.removeItem('ndrf_portal_import'); } catch {}
      $('file_input').value = '';
      $('file_label').textContent = '拖曳 .xlsx 檔案到此處，或按一下選擇檔案';
      document.getElementById('btn_dl_record').addEventListener('click', async () => {
        await downloadImportRecord('/api/portal/store/import/record', batchId, batchKey, 'NDRF_Import_Record.xlsx');
      });
      await loadList();
    } catch (err) {
      let html = `<div class="alert error"><b>${p.escapeHtml(err.message)}</b></div>`;
      if (err.data?.errors?.length) {
        html += '<table><thead><tr><th>行</th><th>欄位</th><th>原因</th></tr></thead><tbody>';
        err.data.errors.forEach((e) => {
          html += `<tr><td>${e.row || '—'}</td><td>${p.escapeHtml(e.field)}</td><td>${p.escapeHtml(e.reason)}</td></tr>`;
        });
        html += '</tbody></table>';
      }
      $('import_result').innerHTML = html;
    } finally {
      btn.disabled = false;
      btn.textContent = '上載並匯入';
    }
  });

  $('btn_close_detail').addEventListener('click', () => { $('detail_card').style.display = 'none'; });
  $('logout_link').addEventListener('click', (e) => { e.preventDefault(); p.logout(); });

  (async () => {
    try {
      await p.ensureUser(['store']);
    } catch (err) {
      return;
    }
    await loadOptions();
    await loadList();
  })();
})();
