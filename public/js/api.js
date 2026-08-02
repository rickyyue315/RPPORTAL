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
  'ND00-Default SKU ND status when created',
  'ND01-Under ND Classification',
  'ND10-CMPD-Not assigned to specific store',
  'ND11-CMPD-Seasona item(Winter)',
  'ND12-CMPD-Seasona item(Summer)',
  'ND13-CMPD-Non Active SKU',
  'ND14-CMPD-One-time purchase',
  'ND20-SO-Not displayed in small stores',
  'ND21-SO-Seasonal item(Winter)',
  'ND22-SO-Seasonal item(Summer)',
  'ND23-SO-Due to OM/SUP reason',
  'ND29-SO-Optimized SKU(Specific store)',
  'ND30-Legal & Regulatory Restrictions',
  'ND31-Hazardous Goods',
  'ND32-Health Products-Macau',
  'ND33-Outlets',
  'ND34-Health Products-HK',
  'ND35-SSDC Exclusive',
  'ND40-Product Issue-Quality',
  'ND41-Product Issue-Label',
  'ND50-Vendor Return',
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
