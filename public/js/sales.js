(() => {
  const $ = (id) => document.getElementById(id);
  let storeCache = null;
  let previewData = null;
  let pendingFile = null;
  let pendingImportKey = null;
  let submitKey = null;

  function readForm() {
    return {
      site_code: $('site_code').value.trim(),
      sku: $('sku').value.trim(),
    };
  }

  function validateForm() {
    const data = readForm();
    const errors = [];
    if (!data.site_code) errors.push('Site Code 為必填');
    if (!data.sku) errors.push('SKU 為必填');
    else if (!/^(?:\d{7}|\d{12})$/.test(data.sku)) errors.push('SKU 只容許 7 位或 12 位數字，每個申請只能輸入一個 SKU');
    return errors;
  }

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
    } catch {
      storeCache = null;
      $('store_info').innerHTML = '<span style="color:var(--danger)">Site Code 不存在</span>';
    }
  }

  function showPreview() {
    const data = readForm();
    const errors = validateForm();
    showAlert($('form_error'), 'error', errors.map((error) => `<div>${escapeHtml(error)}</div>`).join(''));
    if (errors.length) return;
    previewData = data;
    submitKey = createIdempotencyKey();
    const site = storeCache ? `${data.site_code}（${storeCache.shop}）` : data.site_code;
    $('preview_body').innerHTML = `<dt>Site Code</dt><dd>${escapeHtml(site)}</dd><dt>SKU</dt><dd>${escapeHtml(data.sku)}</dd>`;
    $('preview_box').style.display = '';
  }

  async function submit() {
    const button = $('btn_confirm');
    button.disabled = true;
    button.textContent = '提交中…';
    showAlert($('confirm_error'), '', '');
    try {
      const data = await api('/api/public/sales/submit', { method: 'POST', headers: { 'Idempotency-Key': submitKey }, body: JSON.stringify(previewData) });
      rememberSubmission(data, 'sales');
      $('res_no').textContent = data.submission.application_no;
      $('res_time').textContent = data.submission.submitted_at;
      $('apply_form').style.display = 'none';
      $('preview_box').style.display = 'none';
      $('result_card').style.display = '';
      $('result_card').scrollIntoView({ behavior: 'smooth' });
    } catch (error) {
      showAlert($('confirm_error'), 'error', escapeHtml(error.message));
    } finally {
      button.disabled = false;
      button.textContent = '確認提交';
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

  $('apply_form').addEventListener('submit', (event) => { event.preventDefault(); showPreview(); });
  $('btn_preview').addEventListener('click', showPreview);
  $('btn_confirm').addEventListener('click', submit);
  $('btn_cancel_preview').addEventListener('click', () => { $('preview_box').style.display = 'none'; });
  $('btn_again').addEventListener('click', resetForm);
  $('btn_copy_no').addEventListener('click', () => {
    copyText($('res_no').textContent.trim(), $('btn_copy_no'));
  });

  const drop = $('file_drop');
  const fileInput = $('file_input');
  const IMPORT_STORAGE_KEY = 'ndrf_pending_import_sales';
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
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('dragover');
    if (event.dataTransfer.files.length) setPendingFile(event.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) setPendingFile(fileInput.files[0]); });
  $('btn_import').addEventListener('click', async () => {
    if (!pendingFile) {
      showAlert($('import_result'), 'error', '請先選擇 .xlsx 檔案');
      return;
    }
    const button = $('btn_import');
    button.disabled = true;
    button.textContent = '匯入中…';
    showAlert($('import_result'), '', '');
    const formData = new FormData();
    formData.append('file', pendingFile);
    const importKey = pendingImportKey || createIdempotencyKey();
    pendingImportKey = importKey;
    try {
      const data = await api('/api/public/sales/import', { method: 'POST', headers: { 'Idempotency-Key': importKey }, body: formData });
      let html = `<div class="alert success"><b>${escapeHtml(data.message)}</b>（總行數：${data.totalRows}）</div>`;
      html += '<div class="import-appno-note">系統已為以下每筆申報產生「申請編號」，請記下申請編號。日後可於「<a href="/lookup.html">查詢／修改</a>」頁面輸入「申請編號 + Site Code」查看及在匯出前修改。</div>';
      html += '<table><thead><tr><th>Excel 行</th><th>申請編號</th><th>Site Code</th><th>SKU</th><th>已收件時間</th></tr></thead><tbody>';
      data.rows.forEach((row) => {
        html += `<tr><td>${row.row}</td><td class="cell-appno">${escapeHtml(row.application_no)}</td><td>${escapeHtml(row.site_code)}</td><td>${escapeHtml(row.sku)}</td><td>${escapeHtml(row.submitted_at)}</td></tr>`;
      });
      html += '</tbody></table><div class="btn-row"><button class="btn" id="btn_dl_record">下載匯入記錄 Excel（按店舖分頁）</button></div>';
      $('import_result').innerHTML = html;
      $('file_label').textContent = '拖曳 .xlsx 檔案到此處，或按一下選擇檔案';
       const importBatchKey = importKey;
       pendingFile = null;
       pendingImportKey = null;
       clearImportKey();
       fileInput.value = '';
      $('btn_dl_record').addEventListener('click', async () => {
        const downloadButton = $('btn_dl_record');
        downloadButton.disabled = true;
        try {
          await downloadImportRecord('/api/public/sales/import/record', data.batchId, importBatchKey, 'Sudden_Sales_Import_Record.xlsx');
          } catch (error) {
          showAlert($('import_result'), 'error', escapeHtml(error.message));
        } finally {
          downloadButton.disabled = false;
        }
      });
    } catch (error) {
      let html = `<div class="alert error"><b>${escapeHtml(error.message)}</b></div>`;
      if (error.data?.errors?.length) {
        html += '<table><thead><tr><th>行</th><th>Site Code</th><th>欄位</th><th>原因</th></tr></thead><tbody>';
        error.data.errors.forEach((item) => {
          html += `<tr><td>${item.row || '—'}</td><td>${escapeHtml(item.siteCode || '—')}</td><td>${escapeHtml(item.field)}</td><td>${escapeHtml(item.reason)}</td></tr>`;
        });
        html += '</tbody></table>';
      }
      $('import_result').innerHTML = html;
    } finally {
      button.disabled = false;
      button.textContent = '上載並匯入';
    }
  });

  showLastSubmissionResult('sales');
})();
