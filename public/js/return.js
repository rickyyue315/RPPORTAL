(() => {
  const $ = (id) => document.getElementById(id);
  let storeCache = null;
  let previewData = null;
  let pendingFile = null;
  let pendingImportKey = null;
  let submitKey = null;
  let returnWindowOpen = false;

  const fmt = (value) => value ? value.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2月$3日') : '';
  const fmtWithWeekday = (value) => {
    if (!value) return '';
    const date = new Date(`${value}T12:00:00+08:00`);
    const weekday = new Intl.DateTimeFormat('zh-Hant-HK', { weekday: 'long', timeZone: 'Asia/Hong_Kong' }).format(date);
    return `${fmt(value)}${weekday}`;
  };

  function renderSchedule(data) {
    returnWindowOpen = Boolean(data.open);
    $('window_status').innerHTML = data.open
      ? `<div class="alert success">目前申請期：${fmt(data.window.applicationStart)} 至 ${fmt(data.window.applicationEnd)}（香港時間）</div>`
      : `<div class="alert warning">${escapeHtml(data.message)}</div>`;
    $('btn_preview').disabled = !data.open;
    $('btn_import').disabled = !data.open;
    $('reason').innerHTML = '<option value="">請選擇申請退貨原因</option>'
      + data.reasons.map((reason) => `<option value="${escapeHtml(reason.code)}">${escapeHtml(reason.label)}</option>`).join('');
    $('schedule_table').querySelector('tbody').innerHTML = data.windows
      .map((window) => `<tr><td>${fmtWithWeekday(window.applicationStart)} 至 ${fmtWithWeekday(window.applicationEnd)}</td><td>${fmtWithWeekday(window.buyerStart)} 至 ${fmtWithWeekday(window.buyerEnd)}</td><td>${fmtWithWeekday(window.returnNoDate)}</td></tr>`)
      .join('');
  }

  function readForm() {
    return {
      site_code: $('site_code').value.trim(),
      sku: $('sku').value.trim(),
      qty: $('qty').value === '' ? null : Number($('qty').value),
      reason: $('reason').value,
      confirmer_name: $('confirmer_name').value.trim(),
      confirmer_phone: $('confirmer_phone').value.trim(),
    };
  }

  function validate(data) {
    const errors = [];
    if (!data.site_code) errors.push('Site Code 為必填');
    if (!data.sku) errors.push('SKU 為必填');
    else if (!/^(?:\d{7}|\d{12})$/.test(data.sku)) errors.push('SKU 只容許 7 位或 12 位數字，每個申請只能輸入一個 SKU');
    if (!Number.isInteger(data.qty) || data.qty < 1 || data.qty > 9999) errors.push('QTY 必須為 1 至 9999 的整數');
    if (!data.reason) errors.push('REASON 為必填');
    if (!data.confirmer_name) errors.push('確認人姓名為必填');
    if (!data.confirmer_phone) errors.push('確認人電話為必填');
    return errors;
  }

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

  let siteTimer;
  $('site_code').addEventListener('input', () => {
    $('site_code').value = $('site_code').value.toUpperCase();
    clearTimeout(siteTimer);
    siteTimer = setTimeout(validateSite, 300);
  });

  $('apply_form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = readForm();
    const errors = validate(data);
    showAlert($('form_error'), errors.length ? 'error' : '', errors.map(escapeHtml).join('<br>'));
    if (errors.length || !returnWindowOpen) return;
    previewData = data;
    submitKey = createIdempotencyKey();
    const site = storeCache ? `${data.site_code}（${storeCache.shop}）` : data.site_code;
    $('preview_body').innerHTML = `<dt>Site Code</dt><dd>${escapeHtml(site)}</dd><dt>SKU</dt><dd>${escapeHtml(data.sku)}</dd><dt>QTY</dt><dd>${data.qty}</dd><dt>REASON</dt><dd>${escapeHtml($('reason').selectedOptions[0].textContent)}</dd><dt>確認人姓名</dt><dd>${escapeHtml(data.confirmer_name)}</dd><dt>確認人電話</dt><dd>${escapeHtml(data.confirmer_phone)}</dd>`;
    $('preview_box').style.display = '';
  });

  $('btn_cancel').addEventListener('click', () => { $('preview_box').style.display = 'none'; });
  $('btn_confirm').addEventListener('click', async () => {
    const button = $('btn_confirm');
    button.disabled = true;
    showAlert($('confirm_error'), '', '');
    try {
      const data = await api('/api/public/return/submit', {
        method: 'POST',
        headers: { 'Idempotency-Key': submitKey },
        body: JSON.stringify(previewData),
      });
      rememberSubmission(data, 'return');
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
    }
  });

  $('btn_again').addEventListener('click', () => {
    $('apply_form').reset();
    $('store_info').textContent = '—';
    $('result_card').style.display = 'none';
    $('apply_form').style.display = '';
    $('preview_box').style.display = 'none';
    previewData = null;
    submitKey = null;
    storeCache = null;
    clearLastSubmission();
  });
  $('btn_copy_no').addEventListener('click', () => {
    copyText($('res_no').textContent.trim(), $('btn_copy_no'));
  });

  const drop = $('file_drop');
  const fileInput = $('file_input');
  const IMPORT_STORAGE_KEY = 'ndrf_pending_import_return';
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
    showAlert($('import_result'), '', '');
    const fd = new FormData();
    fd.append('file', pendingFile);
    const importKey = pendingImportKey || createIdempotencyKey();
    pendingImportKey = importKey;
    try {
      const data = await api('/api/public/return/import', {
        method: 'POST',
        headers: { 'Idempotency-Key': importKey },
        body: fd,
      });
      let html = `<div class="alert success"><b>${escapeHtml(data.message)}</b></div>`;
      html += '<div class="import-appno-note">系統已為以下每筆申報產生「申請編號」，請記下申請編號。日後可於「<a href="/lookup.html">查詢／修改</a>」頁面輸入申請編號及 Site Code 查詢。</div>';
      html += '<table><thead><tr><th>Excel 行</th><th>申請編號</th><th>Site Code</th><th>SKU</th><th>QTY</th><th>REASON</th><th>確認人</th><th>已收件時間</th></tr></thead><tbody>';
      data.rows.forEach((row) => {
        html += `<tr><td>${row.row}</td><td class="cell-appno">${escapeHtml(row.application_no)}</td><td>${escapeHtml(row.site_code)}</td><td>${escapeHtml(row.sku)}</td><td>${row.qty}</td><td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.confirmer_name)}</td><td>${escapeHtml(row.submitted_at)}</td></tr>`;
      });
      html += '</tbody></table><button class="btn" id="btn_dl_record">下載匯入記錄 Excel</button>';
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
          await downloadImportRecord('/api/public/return/import/record', data.batchId, importBatchKey, 'Return_Goods_Import_Record.xlsx');
        } catch (error) {
          showAlert($('import_result'), 'error', escapeHtml(error.message));
        } finally {
          downloadButton.disabled = false;
        }
      });
    } catch (error) {
      let html = `<div class="alert error">${escapeHtml(error.message)}</div>`;
      if (error.data?.errors?.length) {
        html += `<table><thead><tr><th>行</th><th>Site Code</th><th>欄位</th><th>原因</th></tr></thead><tbody>${error.data.errors.map((item) => `<tr><td>${item.row || '—'}</td><td>${escapeHtml(item.siteCode || '—')}</td><td>${escapeHtml(item.field)}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('')}</tbody></table>`;
      }
      $('import_result').innerHTML = html;
    } finally {
      button.disabled = false;
    }
  });

  api('/api/public/return/schedule').then(renderSchedule).catch(() => showAlert($('window_status'), 'error', '無法載入退行貨時間表，請稍後再試。'));
  showLastSubmissionResult('return');
})();