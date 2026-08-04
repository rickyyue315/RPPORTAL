(() => {
  const $ = (id) => document.getElementById(id);
  let storeCache = null;
  let previewData = null;
  let pendingFile = null;

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
      const data = await api('/api/public/sales/submit', { method: 'POST', body: JSON.stringify(previewData) });
      $('res_no').textContent = data.submission.application_no;
      $('res_time').textContent = data.submission.submitted_at;
      $('apply_form').style.display = 'none';
      $('preview_box').style.display = 'none';
      $('result_card').style.display = '';
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

  const drop = $('file_drop');
  const fileInput = $('file_input');
  const setFile = (file) => {
    pendingFile = file;
    $('file_label').textContent = `已選擇：${file.name}`;
  };
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('dragover');
    if (event.dataTransfer.files.length) setFile(event.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) setFile(fileInput.files[0]); });

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
    try {
      const data = await api('/api/public/sales/import', { method: 'POST', body: formData });
      let html = `<div class="alert success"><b>${escapeHtml(data.message)}</b>（總行數：${data.totalRows}）</div>`;
      html += '<table><thead><tr><th>Excel 行</th><th>申請編號</th><th>Site Code</th><th>SKU</th><th>已收件時間</th></tr></thead><tbody>';
      data.rows.forEach((row) => {
        html += `<tr><td>${row.row}</td><td>${escapeHtml(row.application_no)}</td><td>${escapeHtml(row.site_code)}</td><td>${escapeHtml(row.sku)}</td><td>${escapeHtml(row.submitted_at)}</td></tr>`;
      });
      html += '</tbody></table><div class="btn-row"><button class="btn" id="btn_dl_record">下載匯入記錄 Excel（按店舖分頁）</button></div>';
      $('import_result').innerHTML = html;
      $('file_label').textContent = '拖曳 .xlsx 檔案到此處，或按一下選擇檔案';
      pendingFile = null;
      $('btn_dl_record').addEventListener('click', async () => {
        const downloadButton = $('btn_dl_record');
        downloadButton.disabled = true;
        try {
          const response = await fetch('/api/public/sales/import/record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: data.rows }),
          });
          if (!response.ok) throw new Error('無法下載匯入記錄');
          const blob = await response.blob();
          const disposition = response.headers.get('Content-Disposition') || '';
          const match = disposition.match(/filename="([^"]+)"/);
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = match ? match[1] : 'Sudden_Sales_Import_Record.xlsx';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
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
})();
