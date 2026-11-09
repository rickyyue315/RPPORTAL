/* Admin 審批設定：Urgent Order 旺季限額（倍數 + 生效日期）。
   獨立模組，唔改 admin.js 既有流程；卡片捲到視線內才載入。 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CARD = $('urgent_limits_card');
  if (!CARD) return;

  let csrf = null;
  let loaded = false;
  let loading = false;
  let current = null;

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  function alertHtml(type, message) {
    const kind = type === 'danger' ? 'error' : type;
    return `<div class="alert ${kind}">${esc(message)}</div>`;
  }

  async function getCsrf(force = false) {
    if (force || !csrf) {
      const d = await fetch('/api/csrf', { credentials: 'same-origin' }).then((r) => r.json());
      csrf = d.token;
    }
    return csrf;
  }

  async function aFetch(url, opts = {}, retried = false) {
    const token = await getCsrf();
    const headers = { ...(opts.headers || {}), 'x-csrf-token': token };
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 403 && !retried) {
        await getCsrf(true);
        return aFetch(url, opts, true);
      }
      const err = new Error(data?.error || `請求失敗 (${res.status})`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function formatMultiplier(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '1';
    return String(Math.round(n * 100) / 100);
  }

  function statusOf(phase) {
    return ({
      active: { label: '生效中', cls: 'bg-green-lt' },
      scheduled: { label: '未開始', cls: 'bg-yellow-lt' },
      ended: { label: '已結束', cls: 'bg-secondary-lt' },
      none: { label: '未設定旺季', cls: 'bg-secondary-lt' },
    })[phase] || { label: '未設定旺季', cls: 'bg-secondary-lt' };
  }

  function renderPreview(multiplier) {
    const tbody = $('ul_preview_body');
    if (!tbody || !current) return;
    const m = Number.isFinite(Number(multiplier)) && Number(multiplier) >= 1 ? Number(multiplier) : 1;
    tbody.textContent = '';
    (current.tiers || []).forEach((tier) => {
      const peak = Math.floor(Number(tier.baseLimit) * m);
      const tr = document.createElement('tr');
      const label = document.createElement('td');
      label.textContent = tier.label;
      const base = document.createElement('td');
      base.className = 'text-end';
      base.textContent = `≤ ${tier.baseLimit}`;
      const peakCell = document.createElement('td');
      peakCell.className = 'text-end';
      peakCell.textContent = `≤ ${peak}`;
      tr.append(label, base, peakCell);
      tbody.appendChild(tr);
    });
  }

  function render(data) {
    current = data;
    $('ul_multiplier').value = data.multiplier ?? 1;
    $('ul_from').value = data.effectiveFrom || '';
    $('ul_to').value = data.effectiveTo || '';
    $('ul_note').value = data.note || '';

    // 旺季上限同時影響後台「申報詳情」的 QTY 輸入框。
    const qtyMax = Number(data.qtyMax);
    if (Number.isFinite(qtyMax) && qtyMax >= 1) {
      globalThis.__setUrgentQtyMax?.(qtyMax);
      const qtyInput = $('a_qty');
      if (qtyInput) qtyInput.max = String(qtyMax);
      const label = $('a_qty_max');
      if (label) label.textContent = String(qtyMax);
      const note = $('urgent_note');
      if (note) {
        note.textContent = `Urgent Order：可修改 SKU、QTY（1 至 ${qtyMax}）及 Urgent Reason，Site Code 不可修改。選擇「9. 其他」時必須填寫 Other Reason。`;
      }
    }

    const status = statusOf(data.phase);
    $('ul_status').className = `badge ${status.cls}`;
    $('ul_status').textContent = status.label;

    const who = data.updatedBy ? ` · ${data.updatedBy}` : '';
    $('ul_updated').textContent = data.updatedAt ? `最後更新：${data.updatedAt}${who}` : '尚未設定';

    const mult = formatMultiplier(data.multiplier);
    if (data.phase === 'active') {
      $('ul_current').textContent = `店舖目前見到：旺季限額 ×${mult}（${data.effectiveFrom} 至 ${data.effectiveTo}）；每筆上限 ${data.qtyMax} 件`;
    } else if (data.phase === 'scheduled') {
      $('ul_current').textContent = `店舖目前見到：基本限額（每筆上限 ${data.qtyMax} 件）；旺季期間上限 ${data.peakQtyMax} 件，將於 ${data.effectiveFrom} 起生效`;
    } else if (data.phase === 'ended') {
      $('ul_current').textContent = `店舖目前見到：基本限額（每筆上限 ${data.qtyMax} 件；對上一次旺季已於 ${data.effectiveTo} 結束）`;
    } else {
      $('ul_current').textContent = `店舖目前見到：基本限額（每筆上限 ${data.qtyMax} 件）`;
    }

    renderPreview(data.multiplier);
  }

  async function load(force = false) {
    if (loading) return;
    if (loaded && !force) return;
    loading = true;
    try {
      const data = await aFetch('/api/admin/urgent-limits');
      loaded = true;
      render(data);
    } catch (err) {
      loaded = false;
      $('ul_preview_body').innerHTML = `<tr><td colspan="3" class="text-center text-secondary">載入失敗：${esc(err.message)}</td></tr>`;
      $('ul_status').className = 'badge bg-red-lt';
      $('ul_status').textContent = '載入失敗';
    } finally {
      loading = false;
    }
  }

  function readForm() {
    return {
      multiplier: Number($('ul_multiplier').value),
      effectiveFrom: $('ul_from').value || null,
      effectiveTo: $('ul_to').value || null,
      note: $('ul_note').value.trim(),
    };
  }

  function validate(payload) {
    if (!Number.isFinite(payload.multiplier) || payload.multiplier < 1 || payload.multiplier > 5) {
      return '旺季倍數必須為 1 至 5。';
    }
    if (payload.multiplier > 1 && !payload.effectiveFrom) return '請填寫生效日期（From）。';
    if (payload.multiplier > 1 && !payload.effectiveTo) return '請填寫結束日期（To）。';
    if (Boolean(payload.effectiveFrom) !== Boolean(payload.effectiveTo)) {
      return '請同時填寫生效日期及結束日期。';
    }
    if (payload.effectiveFrom && payload.effectiveTo && payload.effectiveFrom > payload.effectiveTo) {
      return '結束日期不可早於生效日期。';
    }
    if (payload.effectiveFrom && payload.multiplier <= 1) {
      return '旺季倍數必須大於 1；如不使用旺季設定，請按「清除旺季設定」。';
    }
    return null;
  }

  async function save() {
    const payload = readForm();
    const error = validate(payload);
    if (error) {
      $('ul_result').innerHTML = alertHtml('danger', error);
      return;
    }
    const btn = $('btn_ul_save');
    btn.disabled = true;
    btn.textContent = '儲存中…';
    $('ul_result').innerHTML = '';
    try {
      const data = await aFetch('/api/admin/urgent-limits', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      loaded = true;
      render(data);
      $('ul_result').innerHTML = alertHtml('success', '已儲存。店舖 Urgent Order 頁重新載入後會顯示新的 Limit Qty。');
    } catch (err) {
      $('ul_result').innerHTML = alertHtml('danger', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '儲存設定';
    }
  }

  async function reset() {
    if (!window.confirm('清除旺季限額？\n\n店舖會用回基本 Limit Qty；改動會寫入審計日誌。')) return;
    const btn = $('btn_ul_reset');
    btn.disabled = true;
    $('ul_result').innerHTML = '';
    try {
      const data = await aFetch('/api/admin/urgent-limits', {
        method: 'PUT',
        body: JSON.stringify({ multiplier: 1, effectiveFrom: null, effectiveTo: null, note: '' }),
      });
      loaded = true;
      render(data);
      $('ul_result').innerHTML = alertHtml('success', '已清除旺季設定，店舖會用回基本 Limit Qty。');
    } catch (err) {
      $('ul_result').innerHTML = alertHtml('danger', err.message);
    } finally {
      btn.disabled = false;
    }
  }

  $('btn_ul_save')?.addEventListener('click', save);
  $('btn_ul_reset')?.addEventListener('click', reset);

  // 輸入倍數／日期時即時預覽，儲存後才真正套用到店舖頁。
  ['ul_multiplier', 'ul_from', 'ul_to'].forEach((id) => {
    $(id)?.addEventListener('input', () => {
      if (!current) return;
      const m = Number($('ul_multiplier').value);
      renderPreview(Number.isFinite(m) && m >= 1 ? m : 1);
    });
  });

  globalThis.__urgentLimitsRefresh = load;

  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    load();
  }, { rootMargin: '120px' });
  observer.observe(CARD);
})();
