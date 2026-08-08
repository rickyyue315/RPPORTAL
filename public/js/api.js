async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `請求失敗 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}


function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function downloadImportRecord(path, batchId, idempotencyKey, fallbackName) {
  if (!batchId || !idempotencyKey) throw new Error('找不到匯入批次，請重新上載檔案');
  const res = await fetch(`${path}/${encodeURIComponent(batchId)}`, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  if (!res.ok) {
    let message = '無法下載匯入記錄';
    try {
      const data = await res.json();
      message = data?.error || message;
    } catch {}
    throw new Error(message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = match ? match[1] : fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const VERSION_FIELD_LABELS = {
  site_code: 'Site Code',
  sku: 'SKU',
  brand: 'Brand',
  rp_type: 'RP Type',
  safety_stock: 'Safety stock',
  nd_code: 'ND Code',
  remark: 'Remark',
  qty: 'QTY',
  urgent_reason: 'Urgent Reason',
  urgent_reason_other: 'Other Reason',
  return_qty: 'QTY',
  return_reason: 'REASON',
  return_confirmer_name: '確認人姓名',
  return_confirmer_phone: '確認人電話',
  return_window_key: '申請窗口',
};

const PLATFORM_OPTIONS = globalThis.NDRF_OPTIONS || {
  rpTypes: [],
  ndCodes: [],
  rfRemarkRequiredSites: [],
  urgentReasons: [],
  urgentQtyMin: 1,
  urgentQtyMax: 1000,
  urgentWebMaxItems: 5,
  urgentReasonOtherCode: '9',
  urgentReasonOtherMax: 2000,
  returnReasons: [],
  returnQtyMin: 1,
  returnQtyMax: 9999,
};

const URGENT_REASON_LABELS = Object.fromEntries(
  PLATFORM_OPTIONS.urgentReasons.map((reason) => [reason.code, reason.label]),
);

const RETURN_REASON_LABELS = Object.fromEntries(
  PLATFORM_OPTIONS.returnReasons.map((reason) => [reason.code, reason.label]),
);

function versionFieldDisplayValue(field, value) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) return '';
  if (field === 'urgent_reason' && URGENT_REASON_LABELS[raw]) return URGENT_REASON_LABELS[raw];
  if (field === 'return_reason' && RETURN_REASON_LABELS[raw]) return RETURN_REASON_LABELS[raw];
  return raw;
}

function versionDiffText(v) {
  const before = v.data_before || {};
  const after = v.data_after || {};
  const changes = [];
  for (const key of Object.keys(after)) {
    const label = VERSION_FIELD_LABELS[key] || key;
    const from = versionFieldDisplayValue(key, before[key]);
    const to = versionFieldDisplayValue(key, after[key]);
    if (from === to) continue;
    changes.push({ label, from: from || '—', to: to || '—' });
  }
  return changes;
}

function versionChangesHtml(v) {
  if (v.version === 1 && !v.data_before) return '<span class="hint">首次提交</span>';
  const changes = versionDiffText(v);
  if (!changes.length) return '<span class="hint">—</span>';
  return changes
    .map((c) => `<div class="version-change"><b>${escapeHtml(c.label)}</b>：${escapeHtml(c.from)} → ${escapeHtml(c.to)}</div>`)
    .join('');
}

const LAST_SUBMISSION_KEY = 'ndrf_last_submission';

function rememberSubmission(data, pageKey) {
  try {
    const submissions = Array.isArray(data.submissions) && data.submissions.length
      ? data.submissions.map((s) => ({
          application_no: s.application_no || '',
          sku: s.sku || '',
          qty: s.qty ?? '',
          urgent_reason_label: s.urgent_reason_label || '',
          urgent_reason_other: s.urgent_reason_other || '',
          submitted_at: s.submitted_at || '',
        }))
      : undefined;
    sessionStorage.setItem(LAST_SUBMISSION_KEY, JSON.stringify({
      page: pageKey,
      application_no: data.submission?.application_no || data.submissions?.[0]?.application_no || '',
      submitted_at: data.submission?.submitted_at || data.submissions?.[0]?.submitted_at || '',
      site_code: data.submission?.site_code || data.submissions?.[0]?.site_code || '',
      submissions,
    }));
  } catch {}
}

function restoreLastSubmission() {
  try {
    return JSON.parse(sessionStorage.getItem(LAST_SUBMISSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function clearLastSubmission() {
  try { sessionStorage.removeItem(LAST_SUBMISSION_KEY); } catch {}
}

function showLastSubmissionResult(pageKey) {
  const saved = restoreLastSubmission();
  if (!saved || saved.page !== pageKey || !saved.application_no) return;
  const resNo = document.getElementById('res_no');
  if (!resNo) return;
  resNo.textContent = saved.application_no;
  const resTime = document.getElementById('res_time');
  if (resTime) resTime.textContent = saved.submitted_at || '';
  const form = document.getElementById('apply_form');
  if (form) form.style.display = 'none';
  const preview = document.getElementById('preview_box');
  if (preview) preview.style.display = 'none';
  const resultCard = document.getElementById('result_card');
  if (resultCard) resultCard.style.display = '';
  setTimeout(() => {
    if (resultCard && resultCard.offsetParent) resultCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
}

async function copyText(text, button) {
  if (!text) return;
  const done = () => {
    if (!button) return;
    const original = button.textContent;
    button.textContent = '已複製';
    setTimeout(() => { button.textContent = original; }, 1500);
  };
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  done();
}

function showAlert(el, type, message) {
  if (!el) return;
  el.innerHTML = `<div class="alert ${type}">${message}</div>`;
}

const ND_CODE_OPTIONS = PLATFORM_OPTIONS.ndCodes;

function populateNdCodeDatalists() {
  document.querySelectorAll('datalist[id^="nd_code_list"]').forEach((dl) => {
    ND_CODE_OPTIONS.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt;
      dl.appendChild(o);
    });
  });
}

function populateSelect(id, options, placeholder) {
  const select = document.getElementById(id);
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>`
    + options.map((option) => `<option value="${escapeHtml(option.code ?? option)}">${escapeHtml(option.label ?? option)}</option>`).join('');
  if (current) select.value = current;
}

function populatePlatformSelects() {
  const rpTypes = PLATFORM_OPTIONS.rpTypes.map((code) => ({ code, label: code }));
  ['rp_type', 'f_rp_type', 'a_rp_type'].forEach((id) => populateSelect(id, rpTypes, '—'));
  populateSelect('f_nd_code', PLATFORM_OPTIONS.ndCodes, '全部');
  ['f_u_urgent_reason', 'a_urgent_reason'].forEach((id) => populateSelect(id, PLATFORM_OPTIONS.urgentReasons, '請選擇申請原因'));
  ['f_return_reason', 'a_return_reason', 'reason'].forEach((id) => populateSelect(id, PLATFORM_OPTIONS.returnReasons, '請選擇申請退貨原因'));
}

const RF_REMARK_REQUIRED_SITES = new Set(PLATFORM_OPTIONS.rfRemarkRequiredSites);

async function loadRfRemarkRequiredStores() {
  const container = document.getElementById('rf_remark_required_stores');
  if (!container) return;
  try {
    const data = await api('/api/public/rf-remark-required-stores');
    container.innerHTML = data.stores.map((store) => `
      <div class="rf-store-row">
        <span>${escapeHtml(store.site_code)}</span>
        <span>${escapeHtml(store.shop || '—')}</span>
      </div>
    `).join('');
  } catch {
    container.innerHTML = [...RF_REMARK_REQUIRED_SITES].map((siteCode) => `
      <div class="rf-store-row">
        <span>${escapeHtml(siteCode)}</span>
        <span>—</span>
      </div>
    `).join('');
  }
}

function validateBusinessFields(fields, siteCode) {
  const errors = [];
  const rpType = (fields.rp_type || '').trim();
  const safetyStock = (fields.safety_stock || '').trim();
  const ndCode = (fields.nd_code || '').trim();
  const remark = (fields.remark || '').trim();
  if (!rpType) {
    errors.push({ field: 'rp_type', message: 'RP Type 為必填' });
    return errors;
  }
  if (!PLATFORM_OPTIONS.rpTypes.includes(rpType)) {
    errors.push({ field: 'rp_type', message: 'RP Type 必須為 ND 或 RF' });
    return errors;
  }
  if (rpType === 'RF') {
    if (!safetyStock) {
      errors.push({ field: 'safety_stock', message: 'RP Type 為 RF 時必須填寫 Safety stock' });
    } else if (!/^\d+(\.\d+)?$/.test(safetyStock) || Number(safetyStock) <= 0) {
      errors.push({ field: 'safety_stock', message: 'Safety stock 必須為大於 0 的數字' });
    }
    if (ndCode) {
      errors.push({ field: 'nd_code', message: 'RP Type 為 RF 時不可填寫 ND Code' });
    }
    if (RF_REMARK_REQUIRED_SITES.has((siteCode || '').trim().toUpperCase()) && !remark) {
      errors.push({ field: 'remark', message: '此店舖轉 RF 時必須填寫 Remark' });
    }
  } else if (rpType === 'ND') {
    if (safetyStock) {
      errors.push({ field: 'safety_stock', message: 'RP Type 為 ND 時不可填寫 Safety stock' });
    }
    if (!ndCode) {
      errors.push({ field: 'nd_code', message: 'RP Type 為 ND 時必須填寫 ND Code' });
    } else if (!ND_CODE_OPTIONS.includes(ndCode)) {
      errors.push({ field: 'nd_code', message: 'ND Code 必須為系統提供的選項' });
    }
  }
  return errors;
}

populatePlatformSelects();
loadRfRemarkRequiredStores();
