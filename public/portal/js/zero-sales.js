/* Store 90日零銷售回覆 */
(() => {
  const $ = (id) => document.getElementById(id);
  const p = window.portal;
  let items = [];
  let reasons = [];
  let currentId = null;

  const COLS = [
    { key: 'Brand', label: 'Brand' },
    { key: 'SKU', label: 'SKU' },
    { key: 'SKU Desc', label: '描述' },
  ];

  function uploadDate(it) {
    return it.batch_date || (it.batch_created_at || '').slice(0, 10);
  }

  function editCount(it) {
    if (typeof it.reply_count === 'number') return it.reply_count;
    return it.status === 'replied' ? 1 : 0;
  }

  function canEdit(it) {
    return editCount(it) < 2;
  }

  function payloadVal(it, key) {
    return (it.payload && it.payload[key]) || (key === 'SKU' ? it.sku : key === 'Brand' ? '' : '');
  }

  /** 'EYG - EO YUNG GAM(HAN BANG)' 只顯示 Brand Code 'EYG' */
  function brandCode(it) {
    const full = payloadVal(it, 'Brand');
    const code = (full.split(' - ')[0] || '').trim();
    return code || full;
  }

  async function loadReasons() {
    const data = await p.api('/api/portal/zero-sales/reasons');
    reasons = data.reasons || [];
    $('reply_reason').innerHTML = reasons.map((r) => `<option value="${p.escapeHtml(r.code)}">${p.escapeHtml(r.label)}</option>`).join('');
  }

  async function loadList() {
    const status = $('f_status').value;
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const data = await p.api(`/api/portal/zero-sales/my${qs}`);
    items = data.items || [];
    const replied = items.filter((i) => i.status === 'replied').length;
    const shop = data.shop ? ` ${p.escapeHtml(data.shop)}` : '';
    $('site_info').innerHTML =
      `<div class="site-banner">${p.escapeHtml(data.site_code)}${shop}</div>` +
      `<div>共 ${items.length} 個指定 SKU（${replied} 已回覆）</div>` +
      `<div class="hint">如非你店舖，請按右上「登出」再重新輸入自己嘅 Site Code。</div>`;
    render();
  }

  function render() {
    const q = ($('f_search').value || '').trim().toUpperCase();
    const filtered = items.filter((it) => {
      if (!q) return true;
      const hay = `${it.sku} ${(it.payload && it.payload['Brand']) || ''} ${(it.payload && it.payload['SKU Desc']) || ''}`.toUpperCase();
      return hay.includes(q);
    });
    if (!filtered.length) {
      $('zs_list').innerHTML = '<div class="hint">暫無指定 SKU</div>';
      return;
    }
    let html = '<table class="zs-table"><thead><tr><th>週次</th>';
    COLS.forEach((c) => { html += `<th>${p.escapeHtml(c.label)}</th>`; });
    html += '<th>SKU上載日期</th><th>狀態</th><th>店舖回覆</th><th></th></tr></thead><tbody>';
    filtered.forEach((it) => {
      const badge = it.status === 'replied' ? '<span class="badge-replied">已回覆</span>' : '<span class="badge-pending">未回覆</span>';
      const reply = it.status === 'replied' ? `${p.escapeHtml(it.reason_label || '')}${it.reason_note ? `<div class="hint">${p.escapeHtml(it.reason_note)}</div>` : ''}` : '—';
      const n = editCount(it);
      const locked = !canEdit(it);
      const btnLabel = n === 0 ? '回覆' : locked ? '已鎖定' : '修改';
      html += `<tr><td>${p.escapeHtml(it.week_label || '')}</td>`;
      COLS.forEach((c) => {
        const val = c.key === 'Brand' ? brandCode(it) : payloadVal(it, c.key);
        html += `<td>${p.escapeHtml(val)}</td>`;
      });
      html += `<td>${p.escapeHtml(uploadDate(it))}</td><td>${badge}</td><td>${reply}</td><td><button class="btn ghost" data-reply="${it.id}" ${locked ? 'disabled' : ''}>${btnLabel}</button></td></tr>`;
    });
    html += '</tbody></table>';
    $('zs_list').innerHTML = html;
    $('zs_list').querySelectorAll('[data-reply]').forEach((btn) => {
      btn.addEventListener('click', () => openReply(btn.dataset.reply));
    });
  }

  function openReply(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    if (!canEdit(it)) {
      p.showAlert($('list_error'), 'error', '此 SKU 已用完修改機會（只可修改一次），如需再更改請聯絡 RP Team');
      return;
    }
    currentId = id;
    const n = editCount(it);
    $('reply_title').textContent = n === 0 ? `回覆 — ${it.sku}` : `修改回覆（最後一次機會） — ${it.sku}`;
    $('reply_sku_info').textContent = `${it.week_label || ''}｜${payloadVal(it, 'Brand')}｜${payloadVal(it, 'SKU Desc')}${n >= 1 ? '｜注意：每 SKU 只可修改一次，儲存後將鎖定' : ''}`;
    $('reply_reason').value = it.reason_code || (reasons[0] && reasons[0].code) || '';
    $('reply_note').value = it.reason_note || '';
    p.showAlert($('reply_error'), '', '');
    $('reply_dialog').showModal();
  }

  $('btn_reply_cancel').addEventListener('click', () => $('reply_dialog').close());
  $('btn_reply_save').addEventListener('click', async () => {
    const btn = $('btn_reply_save');
    btn.disabled = true;
    try {
      await p.api(`/api/portal/zero-sales/items/${currentId}/reply`, {
        method: 'PUT',
        body: JSON.stringify({ reason_code: $('reply_reason').value, reason_note: $('reply_note').value }),
      });
      $('reply_dialog').close();
      await loadList();
    } catch (err) {
      p.showAlert($('reply_error'), 'error', p.escapeHtml(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  $('btn_refresh').addEventListener('click', async () => {
    try { await loadList(); } catch (err) { p.showAlert($('list_error'), 'error', p.escapeHtml(err.message)); }
  });
  $('f_status').addEventListener('change', () => $('btn_refresh').click());
  $('f_search').addEventListener('input', render);
  $('logout_link').addEventListener('click', (e) => { e.preventDefault(); p.logout(); });

  (async () => {
    let site;
    try {
      site = await p.ensureStoreSite();
    } catch { return; }
    $('store_header').textContent = `90日零銷售回覆 — ${site}`;
    await loadReasons();
    await loadList();
  })();
})();
