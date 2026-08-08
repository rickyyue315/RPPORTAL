(() => {
  const $ = (id) => document.getElementById(id);
  let storeCache = null;
  let previewData = null;
  let pendingFile = null;
  let pendingImportKey = null;
  let submitKey = null;
  const SKU_RE = new RegExp(globalThis.NDRF_OPTIONS?.skuPattern || '^(?:\\d{7}|\\d{12})$');

  function readForm() {
    return {
      site_code: $('site_code').value.trim(),
      sku: $('sku').value.trim(),
      rp_type: $('rp_type').value,
      safety_stock: $('safety_stock').value.trim(),
      nd_code: $('nd_code').value.trim(),
      remark: $('remark').value.trim(),
    };
  }

  const LABELS = {
    site_code: 'Site Code',
    sku: 'SKU',
    rp_type: 'RP Type',
    safety_stock: 'Safety stock',
    nd_code: 'ND Code',
    remark: 'Remark',
  };

  let siteTimer = null;
  $('site_code').addEventListener('input', () => {
    $('site_code').value = $('site_code').value.toUpperCase();
    clearTimeout(siteTimer);
    siteTimer = setTimeout(validateSite, 300);
  });

  function syncRpTypeFields() {
    const rpType = $('rp_type').value;
    $('safety_stock_wrap').style.display = rpType === 'ND' ? 'none' : '';
    $('nd_code_wrap').style.display = rpType === 'RF' ? 'none' : '';
    if (rpType === 'RF') $('nd_code').value = '';
    if (rpType === 'ND') $('safety_stock').value = '';
  }
  $('rp_type').addEventListener('change', syncRpTypeFields);

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
    else if (!SKU_RE.test(d.sku)) errs.push('SKU 只容許 7 位或 12 位數字，每個申請只能輸入一個 SKU');
    validateBusinessFields(d, d.site_code).forEach((e) => errs.push(e.message));
    return errs;
  }

  function showPreview() {
    const d = readForm();
    const errs = validateForm();
    showAlert($('form_error'), 'error', errs.map((e) => `<div>${escapeHtml(e)}</div>`).join(''));
    if (errs.length) return;
    previewData = d;
    submitKey = createIdempotencyKey();
    const rows = Object.keys(LABELS)
      .map((k) => {
        const v = d[k];
        let val = v || '—';
        if (k === 'site_code' && storeCache) val += `（${escapeHtml(storeCache.shop)}）`;
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
      const data = await api('/api/public/submit', {
        method: 'POST',
        headers: { 'Idempotency-Key': submitKey },
        body: JSON.stringify(previewData),
      });
      rememberSubmission(data, 'apply');
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

  const drop = $('file_drop');
  const fileInput = $('file_input');
  const IMPORT_STORAGE_KEY = 'ndrf_pending_import_normal';
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
      const data = await api('/api/public/import', { method: 'POST', headers: { 'Idempotency-Key': importKey }, body: fd });
      let html = `<div class="alert success"><b>${escapeHtml(data.message)}</b>（總行數：${data.totalRows}）</div>`;
      html += '<div class="alert warning" style="margin:12px 0"><b>⚠️ 請務必抄低／下載保存以下「申請編號」</b> — 之後如需修改，必須於「<a href="/lookup.html">查詢／修改</a>」頁輸入「<b>申請編號 + Site Code</b>」先搵得返紀錄。<b>冇編號就無法自行修改</b>，請即按「下載匯入記錄 Excel」備存（匯出後鎖定，不能再改）。</div>';
      html += '<div class="hint" style="margin-bottom:8px">下表為已收件記錄（含原上載資料），請核對店舖填寫是否正確。</div>';
      html += '<table><thead><tr><th>Excel 行</th><th>申請編號</th><th>Site Code</th><th>SKU</th><th>RP Type</th><th>Safety stock</th><th>ND Code</th><th>Remark</th><th>已收件時間</th></tr></thead><tbody>';
      data.rows.forEach((r) => {
        html += `<tr><td>${r.row}</td><td class="cell-appno">${escapeHtml(r.application_no)}</td><td>${escapeHtml(r.site_code)}</td><td>${escapeHtml(r.sku)}</td><td>${escapeHtml(r.rp_type || '—')}</td><td>${escapeHtml(r.safety_stock || '—')}</td><td>${escapeHtml(r.nd_code || '—')}</td><td>${escapeHtml(r.remark || '—')}</td><td>${escapeHtml(r.submitted_at)}</td></tr>`;
      });
      html += '</tbody></table>';
      html += '<div class="btn-row"><button class="btn" id="btn_dl_record">下載匯入記錄 Excel（按店舖分頁）</button></div>';
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
          await downloadImportRecord('/api/public/import/record', data.batchId, importBatchKey, 'NDRF_Import_Record.xlsx');
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

  populateNdCodeDatalists();
  showLastSubmissionResult('apply');
})();
