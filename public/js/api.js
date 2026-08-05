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

function showAlert(el, type, message) {
  if (!el) return;
  el.innerHTML = `<div class="alert ${type}">${message}</div>`;
}

const ND_CODE_OPTIONS = [
  'ND20-SO-Not displayed in small stores',
  'ND21-SO-Seasonal item(Winter)',
  'ND22-SO-Seasonal item(Summer)',
  'ND23-SO-Due to OM/SUP reason',
  'ND29-SO-Optimized SKU(Specific store)',
];

function populateNdCodeDatalists() {
  document.querySelectorAll('datalist[id^="nd_code_list"]').forEach((dl) => {
    ND_CODE_OPTIONS.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt;
      dl.appendChild(o);
    });
  });
}

const RF_REMARK_REQUIRED_SITES = new Set([
  'HA19', 'HA21', 'HA33', 'HA37',
  'HB77', 'HB86', 'HB87', 'HB91', 'HBA5', 'HBA7',
  'HC13', 'HC44', 'HC68', 'HC70',
]);

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
  if (rpType === 'RF') {
    if (!safetyStock) {
      errors.push({ field: 'safety_stock', message: 'RP Type 為 RF 時必須填寫 Safety stock' });
    } else if (!/^\d+(\.\d+)?$/.test(safetyStock) || Number(safetyStock) <= 0) {
      errors.push({ field: 'safety_stock', message: 'Safety stock 必須為大於 0 的數字' });
    }
    if (RF_REMARK_REQUIRED_SITES.has((siteCode || '').trim().toUpperCase()) && !remark) {
      errors.push({ field: 'remark', message: '此店舖轉 RF 時必須填寫 Remark' });
    }
  } else if (rpType === 'ND') {
    if (!ndCode) {
      errors.push({ field: 'nd_code', message: 'RP Type 為 ND 時必須填寫 ND Code' });
    }
  }
  return errors;
}

loadRfRemarkRequiredStores();
