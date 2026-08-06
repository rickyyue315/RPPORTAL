(() => {
  const $ = (id) => document.getElementById(id);
  const QTY_MIN = 1;
  const QTY_MAX = 1000;
  const URGENT_OTHER_CODE = '9';
  const URGENT_REASONS = [
    { code: '1', label: '1. 客人訂購 (RP Team定期隨機抽查核實)' },
    { code: '2', label: '2. ROADSHOW' },
    { code: '3', label: '3. 追數 (OM指定)' },
    { code: '4', label: '4. Promotion' },
    { code: '5', label: '5. 新舖落貨(只限開舖第一週)' },
    { code: '6', label: '6. 新產品SAP無法落貨' },
    { code: '7', label: '7. 大堆頭擺放' },
    { code: '8', label: '8. 管理層要求(只限Portal落貨)(缺貨)' },
    { code: '9', label: '9. 其他' },
  ];
  function reasonLabel(code) {
    const found = URGENT_REASONS.find((r) => r.code === code);
    return found ? found.label : code;
  }
  let storeCache = null;
  let previewData = null;
  let pendingFile = null;
  let pendingImportKey = null;
  let submitKey = null;

  function readForm() {
    return {
      site_code: $('site_code').value.trim(),
      sku: $('sku').value.trim(),
      qty: $('qty').value === '' ? '' : Number($('qty').value),
      urgent_reason: $('urgent_reason').value,
      urgent_reason_other: $('urgent_reason_other').value.trim(),
    };
  }

  const LABELS = {
    site_code: 'Site Code',
    sku: 'SKU',
    qty: 'QTY',
    urgent_reason: 'Urgent Reason',
    urgent_reason_other: 'Other Reason',
  };

  let siteTimer = null;
  $('site_code').addEventListener('input', () => {
    $('site_code').value = $('site_code').value.toUpperCase();
    clearTimeout(siteTimer);
    siteTimer = setTimeout(validateSite, 300);
  });

  async function validateSite() {
    const code = $('site_code').value.trim();
    if (!code) {
      $('store_info').textContent = '—';
      storeCache = null;
      return;
    }
    try {
      const data = await api(`/api/public/stores/${encodeURIComponent(code)}`);
      storeCache = data.store;
      $('store_info').innerHTML = `<b>${escapeHtml(data.store.shop)}</b>`;
    } catch (err) {
      storeCache = null;
      $('store_info').innerHTML = `<span style="color:var(--danger)">Site Code 不存在</span>`;
    }
  }

  function validateForm() {
    const d = readForm();
    const errs = [];
    if (!d.site_code) errs.push('Site Code 為必填');
    if (!d.sku) errs.push('SKU 為必填');
    else if (!/^(?:\d{7}|\d{12})$/.test(d.sku)) errs.push('SKU 只容許 7 位或 12 位數字，每個申請只能輸入一個 SKU');
    if (d.qty === '' || !Number.isInteger(d.qty)) {
      errs.push(`QTY 必須為 ${QTY_MIN} 至 ${QTY_MAX} 的整數`);
    } else if (d.qty < QTY_MIN || d.qty > QTY_MAX) {
      errs.push(`QTY 必須為 ${QTY_MIN} 至 ${QTY_MAX} 的整數`);
    }
    if (!d.urgent_reason) {
      errs.push('Urgent Reason 為必填');
    } else if (d.urgent_reason === URGENT_OTHER_CODE) {
      if (!d.urgent_reason_other) {
        errs.push('選擇「9. 其他」時必須填寫 Other Reason');
      }
    } else if (d.urgent_reason_other) {
      errs.push('僅選擇「9. 其他」時才可填寫 Other Reason');
    }
    return errs;
  }

  function showPreview() {
    const d = readForm();
    const errs = validateForm();
    showAlert($('form_error'), 'error', errs.map((e) => `<div>${e}</div>`).join(''));
    if (errs.length) return;
    previewData = d;
    submitKey = createIdempotencyKey();
    const rows = Object.keys(LABELS)
      .map((k) => {
        const v = d[k];
        let val = v === '' || v === null || v === undefined ? '—' : String(v);
        if (k === 'site_code' && storeCache) val += `（${escapeHtml(storeCache.shop)}）`;
        if (k === 'urgent_reason') val = reasonLabel(d[k]);
        return `<dt>${LABELS[k]}</dt><dd>${escapeHtml(val)}</dd>`;
      })
      .join('');
    $('preview_body').innerHTML = rows;
    $('preview_box').style.display = '';
  }

  async function submit() {
    const btn = $('btn_confirm');
    btn.disabled = true;
    btn.textContent = '提交中…';
    showAlert($('confirm_error'), '', '');
    try {
      const data = await api('/api/public/urgent/submit', {
        method: 'POST',
        headers: { 'Idempotency-Key': submitKey },
        body: JSON.stringify(previewData),
      });
      rememberSubmission(data, 'urgent');
      $('res_no').textContent = data.submission.application_no;
      $('res_time').textContent = data.submission.submitted_at;
      $('form_error').innerHTML = '';
      $('apply_form').style.display = 'none';
      $('preview_box').style.display = 'none';
      $('result_card').style.display = '';
      $('result_card').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      showAlert($('confirm_error'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = '確認提交';
    }
  }

  function resetForm() {
    $('apply_form').reset();
    $('urgent_reason_other_wrap').style.display = 'none';
    $('store_info').textContent = '—';
    storeCache = null;
    previewData = null;
    submitKey = null;
    clearLastSubmission();
    $('apply_form').style.display = '';
    $('preview_box').style.display = 'none';
    $('result_card').style.display = 'none';
    showAlert($('form_error'), '', '');
  }

  $('urgent_reason').addEventListener('change', () => {
    const wrap = $('urgent_reason_other_wrap');
    const showOther = $('urgent_reason').value === URGENT_OTHER_CODE;
    wrap.style.display = showOther ? '' : 'none';
    if (!showOther) $('urgent_reason_other').value = '';
  });

  $('btn_preview').addEventListener('click', showPreview);
  $('btn_confirm').addEventListener('click', submit);
  $('btn_cancel_preview').addEventListener('click', () => {
    $('preview_box').style.display = 'none';
  });
  $('btn_again').addEventListener('click', resetForm);
  $('btn_copy_no').addEventListener('click', () => {
    copyText($('res_no').textContent.trim(), $('btn_copy_no'));
  });
  $('apply_form').addEventListener('submit', (e) => {
    e.preventDefault();
    showPreview();
  });

  async function loadWindowStatus() {
    try {
      const data = await api('/api/public/urgent/window');
      if (data && data.open === false) {
        const banner = $('window_banner');
        if (banner) {
          banner.style.display = '';
          banner.innerHTML = `<b>${escapeHtml(data.message || 'Urgent Order 提交時間已截止')}</b>`;
        }
        ['btn_submit', 'btn_preview', 'btn_confirm', 'btn_import'].forEach((id) => {
          const el = $(id);
          if (el) el.disabled = true;
        });
        const drop = $('file_drop');
        if (drop) {
          drop.style.pointerEvents = 'none';
          drop.style.opacity = '0.5';
        }
      }
    } catch {
      // Server-side enforcement remains authoritative; ignore client errors here.
    }
  }
  loadWindowStatus();

  const drop = $('file_drop');
  const fileInput = $('file_input');
  const IMPORT_STORAGE_KEY = 'ndrf_pending_import_urgent';
  function savedImportKeyFor(file) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(IMPORT_STORAGE_KEY) || 'null');
      if (saved && saved.name === file.name && saved.size === file.size && saved.lastModified === file.lastModified && saved.key) {
        return saved.key;
      }
    } catch {}
    return null;
  }
  function rememberImportKey(file, key) {
    try {
      sessionStorage.setItem(IMPORT_STORAGE_KEY, JSON.stringify({ name: file.name, size: file.size, lastModified: file.lastModified, key }));
    } catch {}
  }
  function clearImportKey() {
    try { sessionStorage.removeItem(IMPORT_STORAGE_KEY); } catch {}
  }
  const setPendingFile = (file) => {
    pendingFile = file;
    const savedKey = savedImportKeyFor(file);
    pendingImportKey = savedKey || createIdempotencyKey();
    if (!savedKey) rememberImportKey(file, pendingImportKey);
    $('file_label').textContent = `已選擇：${file.name}`;
  };
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files.length) setPendingFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) setPendingFile(fileInput.files[0]);
  });

  $('btn_import').addEventListener('click', async () => {
    if (!pendingFile) {
      showAlert($('import_result'), 'error', '請先選擇 .xlsx 檔案');
      return;
    }
    const btn = $('btn_import');
    btn.disabled = true;
    btn.textContent = '匯入中…';
    showAlert($('import_result'), '', '');
    const fd = new FormData();
    fd.append('file', pendingFile);
    const importKey = pendingImportKey || createIdempotencyKey();
    pendingImportKey = importKey;
    try {
      const data = await api('/api/public/urgent/import', {
        method: 'POST',
        headers: { 'Idempotency-Key': importKey },
        body: fd,
      });
      let html = `<div class="alert success"><b>${escapeHtml(data.message)}</b>（總行數：${data.totalRows}）</div>`;
      html += '<div class="import-appno-note">系統已為以下每筆申報產生「申請編號」，請記下申請編號。日後可於「<a href="/lookup.html">查詢／修改</a>」頁面輸入「申請編號 + Site Code」查看及在匯出前修改。</div>';
      html += '<table><thead><tr><th>Excel 行</th><th>申請編號</th><th>Site Code</th><th>SKU</th><th>QTY</th><th>Urgent Reason</th><th>Other Reason</th><th>已收件時間</th></tr></thead><tbody>';
      data.rows.forEach((r) => {
        html += `<tr><td>${r.row}</td><td class="cell-appno">${escapeHtml(r.application_no)}</td><td>${escapeHtml(r.site_code)}</td><td>${escapeHtml(r.sku)}</td><td>${escapeHtml(r.qty)}</td><td>${escapeHtml(r.urgent_reason_label || '')}</td><td>${escapeHtml(r.urgent_reason_other || '—')}</td><td>${escapeHtml(r.submitted_at)}</td></tr>`;
      });
      html += '</tbody></table><div class="btn-row"><button class="btn" id="btn_dl_record">下載匯入記錄 Excel（按店舖分頁）</button></div>';
      $('import_result').innerHTML = html;
      $('file_label').textContent = '拖曳 .xlsx 檔案到此處，或按一下選擇檔案';
      const importBatchKey = importKey;
      pendingFile = null;
      pendingImportKey = null;
      clearImportKey();
      fileInput.value = '';
      const dlBtn = $('btn_dl_record');
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = '下載中…';
        try {
          await downloadImportRecord('/api/public/urgent/import/record', data.batchId, importBatchKey, 'Urgent_Import_Record.xlsx');
        } catch (err) {
          showAlert($('import_result'), 'error', escapeHtml(err.message));
        } finally {
          dlBtn.disabled = false;
          dlBtn.textContent = '下載匯入記錄 Excel（按店舖分頁）';
        }
      });
    } catch (err) {
      let html = `<div class="alert error"><b>${escapeHtml(err.message)}</b></div>`;
      if (err.data?.errors?.length) {
        html += '<table><thead><tr><th>行</th><th>Site Code</th><th>欄位</th><th>原因</th></tr></thead><tbody>';
        err.data.errors.forEach((e) => {
          html += `<tr><td>${e.row || '—'}</td><td>${escapeHtml(e.siteCode || '—')}</td><td>${escapeHtml(e.field)}</td><td>${escapeHtml(e.reason)}</td></tr>`;
        });
        html += '</tbody></table>';
      }
      $('import_result').innerHTML = html;
    } finally {
      btn.disabled = false;
      btn.textContent = '上載並匯入';
    }
  });

  showLastSubmissionResult('urgent');
})();
