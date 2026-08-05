(() => {
  const $ = (id) => document.getElementById(id);
  let storeCache = null;
  let previewData = null;
  let pendingFile = null;
  let returnWindowOpen = false;
  const fmt = (v) => v ? v.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2月$3日') : '';
  const fmtWithWeekday = (v) => {
    if (!v) return '';
    const date = new Date(`${v}T12:00:00+08:00`);
    const weekday = new Intl.DateTimeFormat('zh-Hant-HK', { weekday: 'long', timeZone: 'Asia/Hong_Kong' }).format(date);
    return `${fmt(v)}${weekday}`;
  };

  function renderSchedule(data) {
    returnWindowOpen = Boolean(data.open);
    $('window_status').innerHTML = data.open
      ? `<div class="alert success">目前申請期：${fmt(data.window.applicationStart)} 至 ${fmt(data.window.applicationEnd)}（香港時間）</div>`
      : `<div class="alert warning">${escapeHtml(data.message)}</div>`;
    $('btn_preview').disabled = !data.open;
    $('btn_import').disabled = !data.open;
    $('reason').innerHTML = '<option value="">請選擇申請退貨原因</option>' + data.reasons.map((r) => `<option value="${escapeHtml(r.code)}">${escapeHtml(r.label)}</option>`).join('');
    $('schedule_table').querySelector('tbody').innerHTML = data.windows.map((w) => `<tr><td>${fmtWithWeekday(w.applicationStart)} 至 ${fmtWithWeekday(w.applicationEnd)}</td><td>${fmtWithWeekday(w.buyerStart)} 至 ${fmtWithWeekday(w.buyerEnd)}</td><td>${fmtWithWeekday(w.returnNoDate)}</td></tr>`).join('');
  }

  function readForm() {
    return { site_code: $('site_code').value.trim(), sku: $('sku').value.trim(), qty: $('qty').value === '' ? null : Number($('qty').value), reason: $('reason').value, confirmer_name: $('confirmer_name').value.trim(), confirmer_phone: $('confirmer_phone').value.trim() };
  }

  function validate(data) {
    const errors = [];
    if (!data.site_code) errors.push('Site Code 為必填');
    if (!data.sku) errors.push('SKU 為必填'); else if (!/^(?:\d{7}|\d{12})$/.test(data.sku)) errors.push('SKU 只容許 7 位或 12 位數字，每個申請只能輸入一個 SKU');
    if (!Number.isInteger(data.qty) || data.qty < 1 || data.qty > 9999) errors.push('QTY 必須為 1 至 9999 的整數');
    if (!data.reason) errors.push('REASON 為必填');
    if (!data.confirmer_name) errors.push('確認人姓名為必填');
    if (!data.confirmer_phone) errors.push('確認人電話為必填');
    return errors;
  }

  async function validateSite() {
    const code = $('site_code').value.trim();
    if (!code) { $('store_info').textContent = '—'; storeCache = null; return; }
    try { const data = await api(`/api/public/stores/${encodeURIComponent(code)}`); storeCache = data.store; $('store_info').innerHTML = `<b>${escapeHtml(data.store.shop)}</b>`; }
    catch { storeCache = null; $('store_info').innerHTML = '<span style="color:var(--danger)">Site Code 不存在</span>'; }
  }

  let siteTimer;
  $('site_code').addEventListener('input', () => { $('site_code').value = $('site_code').value.toUpperCase(); clearTimeout(siteTimer); siteTimer = setTimeout(validateSite, 300); });
  $('apply_form').addEventListener('submit', (event) => { event.preventDefault(); const data = readForm(); const errors = validate(data); showAlert($('form_error'), errors.length ? 'error' : '', errors.map(escapeHtml).join('<br>')); if (errors.length || !returnWindowOpen) return; previewData = data; const site = storeCache ? `${data.site_code}（${storeCache.shop}）` : data.site_code; $('preview_body').innerHTML = `<dt>Site Code</dt><dd>${escapeHtml(site)}</dd><dt>SKU</dt><dd>${escapeHtml(data.sku)}</dd><dt>QTY</dt><dd>${data.qty}</dd><dt>REASON</dt><dd>${escapeHtml($('reason').selectedOptions[0].textContent)}</dd><dt>確認人姓名</dt><dd>${escapeHtml(data.confirmer_name)}</dd><dt>確認人電話</dt><dd>${escapeHtml(data.confirmer_phone)}</dd>`; $('preview_box').style.display = ''; });
  $('btn_cancel').addEventListener('click', () => { $('preview_box').style.display = 'none'; });
  $('btn_confirm').addEventListener('click', async () => { const button = $('btn_confirm'); button.disabled = true; showAlert($('confirm_error'), '', ''); try { const data = await api('/api/public/return/submit', { method: 'POST', body: JSON.stringify(previewData) }); $('res_no').textContent = data.submission.application_no; $('res_time').textContent = data.submission.submitted_at; $('apply_form').style.display = 'none'; $('preview_box').style.display = 'none'; $('result_card').style.display = ''; } catch (error) { showAlert($('confirm_error'), 'error', escapeHtml(error.message)); } finally { button.disabled = false; } });
  $('btn_again').addEventListener('click', () => { $('apply_form').reset(); $('store_info').textContent = '—'; $('result_card').style.display = 'none'; $('apply_form').style.display = ''; previewData = null; });

  const drop = $('file_drop'); const fileInput = $('file_input'); const setFile = (file) => { pendingFile = file; $('file_label').textContent = `已選擇：${file.name}`; }; drop.addEventListener('click', () => fileInput.click()); drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); }); drop.addEventListener('dragleave', () => drop.classList.remove('dragover')); drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('dragover'); if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]); }); fileInput.addEventListener('change', () => { if (fileInput.files.length) setFile(fileInput.files[0]); });
  $('btn_import').addEventListener('click', async () => { if (!pendingFile) { showAlert($('import_result'), 'error', '請先選擇 .xlsx 檔案'); return; } const button = $('btn_import'); button.disabled = true; try { const fd = new FormData(); fd.append('file', pendingFile); const data = await api('/api/public/return/import', { method: 'POST', body: fd }); let html = `<div class="alert success"><b>${escapeHtml(data.message)}</b></div><table><thead><tr><th>Excel 行</th><th>申請編號</th><th>Site Code</th><th>SKU</th><th>QTY</th><th>REASON</th><th>確認人</th><th>已收件時間</th></tr></thead><tbody>`; data.rows.forEach((row) => { html += `<tr><td>${row.row}</td><td>${escapeHtml(row.application_no)}</td><td>${escapeHtml(row.site_code)}</td><td>${escapeHtml(row.sku)}</td><td>${row.qty}</td><td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.confirmer_name)}</td><td>${escapeHtml(row.submitted_at)}</td></tr>`; }); html += '</tbody></table><button class="btn" id="btn_dl_record">下載匯入記錄 Excel</button>'; $('import_result').innerHTML = html; $('btn_dl_record').addEventListener('click', async () => { const response = await fetch('/api/public/return/import/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: data.rows }) }); const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'Return_Goods_Import_Record.xlsx'; anchor.click(); URL.revokeObjectURL(url); }); pendingFile = null; $('file_label').textContent = '拖曳 .xlsx 檔案到此處，或按一下選擇檔案'; } catch (error) { let html = `<div class="alert error">${escapeHtml(error.message)}</div>`; if (error.data?.errors?.length) html += `<table><thead><tr><th>行</th><th>Site Code</th><th>欄位</th><th>原因</th></tr></thead><tbody>${error.data.errors.map((e) => `<tr><td>${e.row || '—'}</td><td>${escapeHtml(e.siteCode || '—')}</td><td>${escapeHtml(e.field)}</td><td>${escapeHtml(e.reason)}</td></tr>`).join('')}</tbody></table>`; $('import_result').innerHTML = html; } finally { button.disabled = !returnWindowOpen; } });
  api('/api/public/return/schedule').then(renderSchedule).catch(() => showAlert($('window_status'), 'error', '無法載入退行貨時間表，請稍後再試。'));
})();
