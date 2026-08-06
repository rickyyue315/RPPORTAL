(() => {
  const $ = (id) => document.getElementById(id);
  const QTY_MIN = 1;
  const QTY_MAX = 1000;
  const MAX_ITEMS = 5;
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

  function collectRowValues() {
    const values = [];
    for (let n = 1; n <= MAX_ITEMS; n++) {
      const skuEl = $(`item_${n}_sku`);
      if (!skuEl) {
        values.push({ sku: '', qty: '', reason: '', other: '' });
        continue;
      }
      values.push({
        sku: skuEl.value,
        qty: $(`item_${n}_qty`).value,
        reason: $(`item_${n}_reason`).value,
        other: $(`item_${n}_other`).value,
      });
    }
    return values;
  }

  function renderItems() {
    const count = Math.min(MAX_ITEMS, Math.max(1, Number($('item_count').value) || 1));
    const values = collectRowValues();
    const container = $('items_container');
    let html = '';
    for (let n = 1; n <= count; n++) {
      html += `<div class="form-grid urgent-item" data-item="${n}">
        <div class="full urgent-item-title">SKU ${n}</div>
        <div>
          <label for="item_${n}_sku">SKU <span class="optional">（必填）</span></label>
          <input type="text" id="item_${n}_sku" class="item-sku" autocomplete="off">
          <div class="hint">7 位或 12 位數字，只可一個 SKU。</div>
        </div>
        <div>
          <label for="item_${n}_qty">QTY <span class="optional">（必填，1 至 1000）</span></label>
          <input type="number" id="item_${n}_qty" min="1" max="1000" step="1" inputmode="numeric" autocomplete="off" class="item-qty">
        </div>
        <div class="full">
          <label for="item_${n}_reason">Urgent Reason <span class="optional">（必填）</span></label>
          <select id="item_${n}_reason" class="item-reason">
            <option value="">請選擇申請原因</option>
            ${URGENT_REASONS.map((r) => `<option value="${r.code}">${escapeHtml(r.label)}</option>`).join('')}
          </select>
        </div>
        <div class="full" id="item_${n}_other_wrap" style="display:none">
          <label for="item_${n}_other">Other Reason <span class="optional">（選擇「9. 其他」時必填）</span></label>
          <input type="text" id="item_${n}_other" class="item-other" autocomplete="off" maxlength="2000">
        </div>
      </div>`;
    }
    container.innerHTML = html;
    for (let n = 1; n <= count; n++) {
      const v = values[n - 1] || {};
      if (v.sku) $(`item_${n}_sku`).value = v.sku;
      if (v.qty) $(`item_${n}_qty`).value = v.qty;
      if (v.reason) $(`item_${n}_reason`).value = v.reason;
      if (v.other) $(`item_${n}_other`).value = v.other;
    }
    $('count_hint').textContent = `需要填寫 ${count} 個 SKU`;
    syncItemReasonWraps();
  }

  function syncItemReasonWraps() {
    const count = Math.min(MAX_ITEMS, Math.max(1, Number($('item_count').value) || 1));
    for (let n = 1; n <= count; n++) {
      const select = $(`item_${n}_reason`);
      const wrap = $(`item_${n}_other_wrap`);
      if (!select || !wrap) continue;
      const show = select.value === URGENT_OTHER_CODE;
      wrap.style.display = show ? '' : 'none';
      if (!show) {
        const other = $(`item_${n}_other`);
        if (other) other.value = '';
      }
    }
  }

  $('item_count').addEventListener('change', renderItems);
  $('items_container').addEventListener('change', (e) => {
    const target = e.target;
    if (target && target.classList && target.classList.contains('item-reason')) {
      const itemEl = target.closest('.urgent-item');
      const n = itemEl ? Number(itemEl.dataset.item) : 0;
      const wrap = $(`item_${n}_other_wrap`);
      const show = target.value === URGENT_OTHER_CODE;
      wrap.style.display = show ? '' : 'none';
      if (!show) $(`item_${n}_other`).value = '';
    }
  });

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

  function readForm() {
    const count = Math.min(MAX_ITEMS, Math.max(1, Number($('item_count').value) || 1));
    const items = [];
    for (let n = 1; n <= count; n++) {
      items.push({
        sku: $(`item_${n}_sku`).value.trim(),
        qty: $(`item_${n}_qty`).value === '' ? '' : Number($(`item_${n}_qty`).value),
        urgent_reason: $(`item_${n}_reason`).value,
        urgent_reason_other: $(`item_${n}_other`).value.trim(),
      });
    }
    return { site_code: $('site_code').value.trim(), items };
  }

  const SKU_RE = /^(?:\d{7}|\d{12})$/;

  function validateForm(d) {
    const errs = [];
    if (!d.site_code) errs.push({ item: 0, field: 'site_code', message: 'Site Code 為必填' });
    const seen = new Map();
    d.items.forEach((item, i) => {
      const n = i + 1;
      if (!item.sku) {
        errs.push({ item: n, field: 'sku', message: 'SKU 為必填' });
      } else if (!SKU_RE.test(item.sku)) {
        errs.push({ item: n, field: 'sku', message: 'SKU 只容許 7 位或 12 位數字，每個 SKU 只能輸入一個' });
      } else if (seen.has(item.sku)) {
        errs.push({ item: n, field: 'sku', message: `SKU「${item.sku}」與第 ${seen.get(item.sku)} 行重複` });
      } else {
        seen.set(item.sku, n);
      }
      if (item.qty === '' || !Number.isInteger(item.qty)) {
        errs.push({ item: n, field: 'qty', message: `QTY 必須為 ${QTY_MIN} 至 ${QTY_MAX} 的整數` });
      } else if (item.qty < QTY_MIN || item.qty > QTY_MAX) {
        errs.push({ item: n, field: 'qty', message: `QTY 必須為 ${QTY_MIN} 至 ${QTY_MAX} 的整數` });
      }
      if (!item.urgent_reason) {
        errs.push({ item: n, field: 'urgent_reason', message: 'Urgent Reason 為必填' });
      } else if (item.urgent_reason === URGENT_OTHER_CODE) {
        if (!item.urgent_reason_other) {
          errs.push({ item: n, field: 'urgent_reason_other', message: '選擇「9. 其他」時必須填寫 Other Reason' });
        }
      } else if (item.urgent_reason_other) {
        errs.push({ item: n, field: 'urgent_reason_other', message: '僅選擇「9. 其他」時才可填寫 Other Reason' });
      }
    });
    return errs;
  }

  function renderErrors(errs, container) {
    if (!errs.length) {
      showAlert(container, '', '');
      return;
    }
    showAlert(container, 'error', errs.map((e) => `<div>${e.item ? `第 ${e.item} 行：` : ''}${escapeHtml(e.message)}</div>`).join(''));
  }

  function applyFieldErrors(errs) {
    document.querySelectorAll('.urgent-item input, .urgent-item select').forEach((el) => {
      el.style.borderColor = '';
    });
    errs.forEach((e) => {
      if (!e.item) return;
      const suffix = e.field === 'sku' ? 'sku' : e.field === 'qty' ? 'qty' : e.field === 'urgent_reason_other' ? 'other' : 'reason';
      const el = $(`item_${e.item}_${suffix}`);
      if (el) el.style.borderColor = 'var(--danger)';
    });
  }

  function showPreview() {
    const d = readForm();
    const errs = validateForm(d);
    renderErrors(errs, $('form_error'));
    applyFieldErrors(errs);
    if (errs.length) return;
    previewData = d;
    submitKey = createIdempotencyKey();
    const tbody = $('preview_table').querySelector('tbody');
    tbody.innerHTML = '';
    d.items.forEach((item, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(item.sku)}</td><td>${item.qty}</td><td>${escapeHtml(reasonLabel(item.urgent_reason))}</td><td>${item.urgent_reason === URGENT_OTHER_CODE ? escapeHtml(item.urgent_reason_other) : '—'}</td>`;
      tbody.appendChild(tr);
    });
    $('preview_box').style.display = '';
  }

  function renderResultTable(rows) {
    const tbody = $('res_table').querySelector('tbody');
    tbody.innerHTML = '';
    rows.forEach((s, i) => {
      const appNo = s.application_no || '';
      const reason = s.urgent_reason_label || '';
      const other = s.urgent_reason_other || '';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(s.sku || '')}</td><td>${escapeHtml(s.qty ?? '')}</td><td>${escapeHtml(reason)}${other ? `（${escapeHtml(other)}）` : ''}</td><td class="cell-appno">${escapeHtml(appNo)}</td><td><button type="button" class="btn ghost btn-copy" data-copy-appno="${escapeHtml(appNo)}">複製</button></td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-copy-appno]').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.dataset.copyAppno, btn));
    });
  }

  function showSuccess(data) {
    rememberSubmission(data, 'urgent');
    const submissions = (data.submissions && data.submissions.length)
      ? data.submissions
      : (data.submission ? [data.submission] : []);
    $('form_error').innerHTML = '';
    $('apply_form').style.display = 'none';
    $('preview_box').style.display = 'none';
    $('res_time').textContent = submissions[0]?.submitted_at || '';
    renderResultTable(submissions);
    $('result_card').style.display = '';
    $('result_card').scrollIntoView({ behavior: 'smooth' });
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
      showSuccess(data);
    } catch (err) {
      const msg = err.data?.errors?.length
        ? err.data.errors.map((e) => `<div>第 ${e.item} 行：${escapeHtml(e.message)}</div>`).join('')
        : escapeHtml(err.message);
      showAlert($('confirm_error'), 'error', msg);
    } finally {
      btn.disabled = false;
      btn.textContent = '確認提交';
    }
  }

  function resetForm() {
    $('apply_form').reset();
    renderItems();
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
  $('apply_form').addEventListener('submit', (e) => {
    e.preventDefault();
    showPreview();
  });

  function setWindowClosed(closed) {
    const banner = $('window_banner');
    if (banner) banner.style.display = closed ? '' : 'none';
    ['btn_submit', 'btn_preview', 'btn_confirm', 'btn_import'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = closed;
    });
    const drop = $('file_drop');
    if (drop) {
      drop.style.pointerEvents = closed ? 'none' : '';
      drop.style.opacity = closed ? '0.5' : '';
    }
  }

  async function loadWindowStatus() {
    try {
      const data = await api('/api/public/urgent/window');
      setWindowClosed(data && data.open === false);
      if (data && data.open === false) {
        const banner = $('window_banner');
        if (banner) {
          banner.innerHTML = `<b>${escapeHtml(data.message || 'Urgent Order 提交時間已截止')}</b>`;
        }
      }
      lastKnownOpen = data ? Boolean(data.open) : lastKnownOpen;
    } catch {
      // Server-side enforcement remains authoritative; ignore client errors here.
    }
  }
  loadWindowStatus();

  const CUTOFF_HOUR = 14;
  const CUTOFF_MINUTE = 30;
  function hkParts(date) {
    const parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .forEach((p) => {
        parts[p.type] = p.value;
      });
    return parts;
  }
  function cutdownState() {
    const p = hkParts(new Date());
    const nowHk = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    let cutoff = Date.UTC(+p.year, +p.month - 1, +p.day, CUTOFF_HOUR, CUTOFF_MINUTE, 0);
    const open = nowHk < cutoff;
    if (!open) cutoff += 86400000;
    return { remaining: Math.round((cutoff - nowHk) / 1000), open };
  }
  function formatCountdown(totalSeconds) {
    const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const ss = String(totalSeconds % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  let lastKnownOpen = null;
  function tickCutdown() {
    const { remaining, open } = cutdownState();
    $('cutdown_label').textContent = open
      ? '距離今日截單時間（14:30 香港時間）尚有：'
      : '已截止，距離翌日截單時間（14:30 香港時間）尚有：';
    $('cutdown').textContent = formatCountdown(remaining);
    $('cutdown_box').className = `alert ${open ? 'info' : 'warning'}`;
    if (lastKnownOpen !== null && open !== lastKnownOpen) {
      loadWindowStatus();
    }
    lastKnownOpen = open;
  }
  tickCutdown();
  setInterval(tickCutdown, 1000);

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
      html += '<div class="alert warning" style="margin:12px 0"><b>⚠️ 請務必抄低／下載保存以下「申請編號」</b> — 之後如需修改，必須於「<a href="/lookup.html">查詢／修改</a>」頁輸入「<b>申請編號 + Site Code</b>」先搵得返紀錄。<b>冇編號就無法自行修改</b>，請即按「下載匯入記錄 Excel」備存（匯出後鎖定，不能再改）。</div>';
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

  function restoreLastUrgentResult() {
    const saved = restoreLastSubmission();
    if (!saved || saved.page !== 'urgent') return;
    const resultCard = $('result_card');
    if (!resultCard) return;
    const rows = (saved.submissions && saved.submissions.length)
      ? saved.submissions
      : (saved.application_no ? [{ application_no: saved.application_no, sku: '', qty: '', urgent_reason_label: '', urgent_reason_other: '' }] : []);
    if (!rows.length) return;
    $('apply_form').style.display = 'none';
    $('preview_box').style.display = 'none';
    $('res_time').textContent = saved.submitted_at || '';
    renderResultTable(rows);
    resultCard.style.display = '';
    setTimeout(() => {
      if (resultCard.offsetParent) resultCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }

  renderItems();
  restoreLastUrgentResult();
})();
