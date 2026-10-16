/* Store 90日零銷售回覆 */
(() => {
  const $ = (id) => document.getElementById(id);
  const p = window.portal;
  let items = [];
  let reasons = [];
  let batches = [];
  let currentId = null;
  let onlyRepeat = false;

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

  function repeatCount(it) {
    return typeof it.occurrence_count === 'number' ? it.occurrence_count : (it.is_repeat ? 2 : 1);
  }

  function isRepeat(it) {
    if (typeof it.is_repeat === 'boolean') return it.is_repeat;
    return repeatCount(it) >= 2;
  }

  function prevSummary(it) {
    if (!isRepeat(it) || !it.prev_week_label) return '';
    const reason = it.prev_reason_label || (it.prev_status === 'replied' ? '已回覆' : '未回覆');
    return `上次 ${it.prev_week_label}：${reason}`;
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

  async function loadBatches(preserveSelection = false) {
    const prev = preserveSelection && $('f_batch') ? $('f_batch').value : '';
    const data = await p.api('/api/portal/zero-sales/batches');
    batches = data.batches || [];
    const sel = $('f_batch');
    if (!batches.length) {
      sel.innerHTML = '<option value="all">暫無派發</option>';
      sel.value = 'all';
      return;
    }
    sel.innerHTML =
      batches.map((b, i) => `<option value="${p.escapeHtml(b.id)}">${p.escapeHtml(b.week_label)}（${b.pending} 未回覆 / ${b.total}）${i === 0 ? ' — 最新' : ''}</option>`).join('') +
      '<option value="all">全部週次</option>';
    // 預設最新一週，避免 W41+W42 累積愈來愈長；refresh 時保留原選擇
    if (preserveSelection && prev) {
      const stillThere = [...sel.options].some((o) => o.value === prev);
      sel.value = stillThere ? prev : batches[0].id;
    } else {
      sel.value = batches[0].id;
    }
  }

  /** 週次 + 狀態（含重複上榜）篩選；列表與匯出共用，確保匯出 = 畫面所見 */
  function filterParams() {
    const statusVal = $('f_status').value;
    const params = new URLSearchParams();
    if (statusVal === 'repeat') {
      params.set('repeat', '1');
    } else if (statusVal) {
      params.set('status', statusVal);
    }
    const batch = $('f_batch') ? $('f_batch').value : '';
    // 空 / all = 跨週全部；否則只取該週，預設為最新一週
    if (batch && batch !== 'all') params.set('batch_id', batch);
    return params;
  }

  async function loadList() {
    // 「重複上榜」為前端篩選（後端 status 只支援 pending / replied）
    onlyRepeat = $('f_status').value === 'repeat';
    const params = filterParams();
    const qs = params.toString() ? `?${params.toString()}` : '';
    const data = await p.api(`/api/portal/zero-sales/my${qs}`);
    const all = data.items || [];
    items = onlyRepeat ? all.filter(isRepeat) : all;
    const replied = items.filter((i) => i.status === 'replied').length;
    const rate = items.length ? Math.round((replied / items.length) * 100) : 0;
    const repeatN = all.filter(isRepeat).length;
    const shop = data.shop ? ` ${p.escapeHtml(data.shop)}` : '';
    const weekLabel = batch && batch !== 'all' ? (batches.find((b) => b.id === batch) || {}).week_label : '全部週次';
    const bar = document.getElementById('zs_progress_bar');
    if (bar) bar.style.width = `${rate}%`;
    $('site_info').innerHTML =
      `<div class="site-banner">${p.escapeHtml(data.site_code)}${shop}</div>` +
      `<div>${p.escapeHtml(weekLabel || '')}：共 ${items.length} 個指定 SKU（${replied} 已回覆 · ${rate}%）${repeatN ? `｜其中 <b>${repeatN}</b> 個重複上榜（≥2次）` : ''}${onlyRepeat ? '｜現只顯示重複上榜' : ''}</div>` +
      `<div class="hint">預設只顯示最新一週，如需查看舊週次請切換上方「週次」。重複上榜會顯示上次回覆及第幾次，提醒跟進改善。如非你店舖，請按右上「登出」再重新輸入自己嘅 Site Code。</div>`;
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
      $('zs_list').innerHTML = '<div class="empty" style="padding:36px 16px">暫無指定 SKU — 試下轉「狀態」或清空搜尋字。</div>';
      const c0 = document.getElementById('zs_count');
      if (c0) c0.textContent = '';
      return;
    }
    let html = '<table class="zs-table"><thead><tr><th>週次</th>';
    COLS.forEach((c) => { html += `<th>${p.escapeHtml(c.label)}</th>`; });
    html += '<th>SKU上載日期</th><th>狀態</th><th>店舖回覆</th><th>重複提示</th><th></th></tr></thead><tbody>';
    filtered.forEach((it) => {
      const badge = it.status === 'replied' ? '<span class="badge-replied">已回覆</span>' : '<span class="badge-pending">未回覆</span>';
      const reply = it.status === 'replied' ? `${p.escapeHtml(it.reason_label || '')}${it.reason_note ? `<div class="hint">${p.escapeHtml(it.reason_note)}</div>` : ''}` : '—';
      const n = editCount(it);
      const locked = !canEdit(it);
      const btnLabel = n === 0 ? '回覆' : locked ? '已鎖定' : '修改';
      const rc = repeatCount(it);
      let repeatCell = '—';
      if (isRepeat(it)) {
        const prev = prevSummary(it);
        const prevNote = it.prev_reason_note ? `（${p.escapeHtml(it.prev_reason_note)}）` : '';
        const notImproved = it.prev_status === 'pending'
          ? '<div class="hint" style="color:#b42318">上次未回覆，仍未改善</div>'
          : '';
        repeatCell = `<span class="badge-repeat">第${rc}次上榜</span>` +
          (prev ? `<div class="hint">${p.escapeHtml(prev)}${prevNote}</div>` : '') + notImproved;
      }
      html += `<tr${isRepeat(it) ? ' class="zs-repeat"' : ''}><td>${p.escapeHtml(it.week_label || '')}</td>`;
      COLS.forEach((c) => {
        const val = c.key === 'Brand' ? brandCode(it) : payloadVal(it, c.key);
        html += `<td>${p.escapeHtml(val)}</td>`;
      });
      html += `<td>${p.escapeHtml(uploadDate(it))}</td><td>${badge}</td><td>${reply}</td><td>${repeatCell}</td><td><button class="btn ghost" data-reply="${it.id}" ${locked ? 'disabled' : ''}>${btnLabel}</button></td></tr>`;
    });
    html += '</tbody></table>';
    $('zs_list').innerHTML = html;
    const cc = document.getElementById('zs_count');
    if (cc) cc.textContent = `顯示 ${filtered.length} / ${items.length} 筆`;
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
    const histEl = $('reply_history');
    if (histEl) {
      if (isRepeat(it) && it.prev_week_label) {
        const prevReason = it.prev_reason_label || (it.prev_status === 'replied' ? '已回覆' : '未回覆');
        const prevNote = it.prev_reason_note ? `（${it.prev_reason_note}）` : '';
        const warn = it.prev_status === 'pending' ? '上次未回覆，仍未改善，請今次務必跟進。' : '上次已回覆但今週又再上榜，請檢視上次措施是否有效。';
        histEl.textContent = `此 SKU 第${repeatCount(it)}次上榜。上次（${it.prev_week_label}）：${prevReason}${prevNote}。${warn}`;
      } else {
        histEl.textContent = '此 SKU 首次上榜。';
      }
    }
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
      // 回覆後更新週次計數，但保留店舖正睇緊嘅週次選擇
      await loadBatches(true);
      await loadList();
    } catch (err) {
      p.showAlert($('reply_error'), 'error', p.escapeHtml(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  $('btn_refresh').addEventListener('click', async () => {
    try { await loadBatches(true); await loadList(); } catch (err) { p.showAlert($('list_error'), 'error', p.escapeHtml(err.message)); }
  });

  $('btn_export').addEventListener('click', async () => {
    const btn = $('btn_export');
    btn.disabled = true;
    try {
      // 與列表同一篩選（週次 / 狀態 / 重複上榜）+ 搜尋字，匯出 = 畫面所見；後端以登入店舖限定，只含本舖 SKU
      const params = filterParams();
      const q = ($('f_search').value || '').trim();
      if (q) params.set('q', q);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await fetch(`/api/portal/zero-sales/my/export${qs}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '匯出失敗');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      a.href = url;
      a.download = match ? match[1] : 'Zero_Sales_Export.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      p.showAlert($('list_error'), 'error', p.escapeHtml(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  $('f_status').addEventListener('change', () => $('btn_refresh').click());
  if ($('f_batch')) $('f_batch').addEventListener('change', () => $('btn_refresh').click());
  $('f_search').addEventListener('input', render);
  $('logout_link').addEventListener('click', (e) => { e.preventDefault(); p.logout(); });

  (async () => {
    let site;
    try {
      site = await p.ensureStoreSite();
    } catch { return; }
    $('store_header').textContent = `90日零銷售回覆 — ${site}`;
    await loadReasons();
    await loadBatches();
    await loadList();
  })();
})();
