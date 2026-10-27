/* Store 90日零銷售回覆 */
(() => {
  const $ = (id) => document.getElementById(id);
  const p = window.portal;
  let items = [];
  let reasons = [];
  let batches = [];
  let currentId = null;
  let onlyRepeat = false;
  /** 目前檢視的批次（null = 未載入）；is_open=false 代表已封存、只供查閱 */
  let currentBatch = null;

  /**
   * 指定 SKU 回覆的直 link 可能經 /portal/ 登入頁回到這一頁（?matter=CODE）。
   * 認得就直接轉去事項頁，唔會丟失事項編號；舊 ?task= 連結亦兼容。
   */
  const deepMatter = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return (params.get('matter') || params.get('task') || '').trim();
    } catch {
      return '';
    }
  })();
  if (deepMatter) {
    window.location.replace(`/portal/designated-sku.html?matter=${encodeURIComponent(deepMatter)}`);
    return;
  }

  /** 導覽列「指定SKU回覆」待回覆事項數（後端只計仍開放的批次） */
  async function refreshDesignatedBadge() {
    try {
      const data = await p.api('/api/portal/designated-sku/pending-count');
      const n = Number(data.pending_count) || 0;
      const badge = document.getElementById('nav_dsku_badge');
      if (badge) {
        badge.hidden = n <= 0;
        badge.textContent = n > 9 ? '9+' : String(n);
      }
      const banner = document.getElementById('ds_pending_banner');
      if (banner) {
        banner.hidden = n <= 0;
        banner.innerHTML = n > 0
          ? `<div class="ds-pending-banner"><span>你有 <b>${n}</b> 個指定 SKU 事項需要回覆。</span><a href="/portal/designated-sku.html">立即前往填寫 →</a></div>`
          : '';
      }
    } catch {
      /* 徽章只屬提示，失敗不影響零銷售頁 */
    }
  }

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

  function isAutoFilled(it) {
    if (typeof it.auto_filled === 'boolean') return it.auto_filled;
    return !!it.auto_filled_at;
  }

  /** 2 = 初次回覆 + 1 次修改；3 = 系統自動套用 + 2 次修改 */
  function replyLimit(it) {
    const limit = Number(it.reply_limit);
    if (Number.isFinite(limit) && limit >= 2) return limit;
    return isAutoFilled(it) ? 3 : 2;
  }

  function remainingEdits(it) {
    return Math.max(0, replyLimit(it) - editCount(it));
  }

  function canEdit(it) {
    return editCount(it) < replyLimit(it);
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

  /** 已封存（只供查閱）：is_archived 為新欄位；舊回應只有 is_open，故以其推斷 */
  function isArchivedBatch(b) {
    if (!b) return false;
    if (typeof b.is_archived === 'boolean') return b.is_archived;
    return b.is_open === false && b.reply_required !== false;
  }

  /** 本週無須回覆：批次未封存，但 RP Team 已設定店舖不必逐條回覆 */
  function isNoReplyBatch(b) {
    return !!b && !isArchivedBatch(b) && b.reply_required === false;
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
    // 預設落在最新一個「仍可回覆」的週次；若最新一週是「無須回覆」，就停在該週（讓店舖看到 Top 10）；
    // 只有全部已封存（管理員手動封存）才退回最新一週
    const fallback = (batches.find((b) => b.is_open)
      || batches.find((b) => !isArchivedBatch(b))
      || batches[0]).id;
    sel.innerHTML = batches.map((b) => {
      // 已封存的週次不再顯示「未回覆」數字，避免變成永遠清不完的 to-do list
      // 「本週無須回覆」亦不顯示未回覆數，只顯示 SKU 數
      const archived = isArchivedBatch(b);
      const noReply = isNoReplyBatch(b);
      const latest = b.id === batches[0].id ? ' — 最新' : '';
      const label = archived
        ? `${b.week_label}（已封存 · ${b.total} 個 SKU）`
        : noReply
          ? `${b.week_label}（無須回覆 · ${b.total} 個 SKU）${latest}`
          : `${b.week_label}（${b.pending} 未回覆 / ${b.total}）${latest}`;
      return `<option value="${p.escapeHtml(b.id)}">${p.escapeHtml(label)}</option>`;
    }).join('');
    // refresh 時保留店舖正在看的週次（即使該週已被封存，仍可查看歷史）
    if (preserveSelection && prev && batches.some((b) => b.id === prev)) sel.value = prev;
    else sel.value = fallback;
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
    const batchVal = $('f_batch') ? $('f_batch').value : '';
    currentBatch = batches.find((b) => b.id === batchVal) || null;
    const archived = isArchivedBatch(currentBatch);
    const noReply = isNoReplyBatch(currentBatch);
    // 無須回覆的週次沒有「未回覆／已回覆」的分別，狀態篩選隱藏並重設，避免清單被隱藏的條件過濾
    const statusField = $('f_status_field');
    if (statusField) statusField.hidden = noReply;
    if (noReply && $('f_status').value) $('f_status').value = '';
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
    const weekLabel = currentBatch ? currentBatch.week_label : '全部週次';
    const latestOpen = batches.find((b) => b.is_open);
    const bar = document.getElementById('zs_progress_bar');
    const progress = document.getElementById('zs_progress');
    // 無須回覆：不顯示進度條，避免看起來仍有「未完成」的壓力
    if (progress) progress.hidden = noReply;
    if (bar) {
      // 已封存週次用中性灰進度，避免看起來仍有「待完成」的感覺
      const archivedRate = currentBatch && currentBatch.total
        ? Math.round((currentBatch.replied / currentBatch.total) * 100)
        : 0;
      bar.style.width = `${archived ? archivedRate : rate}%`;
      bar.classList.toggle('is-archived', archived || noReply);
    }
    if (archived) {
      const histReplied = currentBatch ? currentBatch.replied : replied;
      const histTotal = currentBatch ? currentBatch.total : items.length;
      $('site_info').innerHTML =
        `<div class="site-banner">${p.escapeHtml(data.site_code)}${shop}</div>` +
        `<div class="zs-archived-banner"><b>${p.escapeHtml(weekLabel)} 已封存</b> — 此週次只供查閱，不能回覆。` +
        (latestOpen
          ? ` 最新一週為 <b>${p.escapeHtml(latestOpen.week_label)}</b>。 <button type="button" class="btn ghost btn-sm" id="zs_goto_latest">前往最新一週</button>`
          : ' 目前沒有可回覆的週次，請等待 RP Team 派發新一週。') +
        `</div>` +
        `<div>歷史紀錄：${histTotal} 個指定 SKU（${histReplied} 已回覆）${repeatN ? `｜<b>${repeatN}</b> 個重複上榜（≥2 次）` : ''}${onlyRepeat ? '｜現只顯示重複上榜' : ''}</div>` +
        `<div class="hint">如非你店舖，請按右上「登出」再輸入 Site Code。</div>`;
    } else if (noReply) {
      const notice = (currentBatch && currentBatch.reply_notice ? String(currentBatch.reply_notice).trim() : '');
      $('site_info').innerHTML =
        `<div class="site-banner">${p.escapeHtml(data.site_code)}${shop}</div>` +
        `<div class="zs-no-reply-banner"><b>${p.escapeHtml(weekLabel)} 本週無須回覆</b> — RP Team 已設定此週不用逐條回覆。` +
        `<div style="margin-top:4px">以下 <b>${items.length}</b> 個 SKU 就是你店舖本週的 <b>Top 10</b> 名單（90 日零銷售、庫存最高），請把握本週優先安排<b>銷售／調撥</b>。</div>` +
        (notice ? `<div class="zs-no-reply-notice">RP Team 訊息：${p.escapeHtml(notice)}</div>` : '') +
        `</div>` +
        `<div>清單 ${items.length} 個 SKU${replied ? `｜其中 ${replied} 個曾有回覆紀錄` : ''}${repeatN ? `｜<b>${repeatN}</b> 個重複上榜（≥2 次）` : ''}</div>` +
        `<div class="hint">此週不會計算回覆率，亦不會因為未回覆而變成逾期。清單仍可搜尋及匯出 Excel。如非你店舖，請按右上「登出」再輸入 Site Code。</div>`;
    } else {
      $('site_info').innerHTML =
        `<div class="site-banner">${p.escapeHtml(data.site_code)}${shop}</div>` +
        `<div>${p.escapeHtml(weekLabel || '')}：${items.length} 個指定 SKU｜${replied} 已回覆（${rate}%）${repeatN ? `｜<b>${repeatN}</b> 個重複上榜（≥2 次）` : ''}${onlyRepeat ? '｜現只顯示重複上榜' : ''}</div>` +
        `<div class="hint">黃色「回覆」＝未回覆（排最前）；橙色「修改」＝已自動套用上次回覆，請確認或更正。如非你店舖，請按右上「登出」再輸入 Site Code。</div>`;
    }
    const goto = document.getElementById('zs_goto_latest');
    if (goto && latestOpen) {
      goto.addEventListener('click', () => {
        $('f_batch').value = latestOpen.id;
        $('btn_refresh').click();
      });
    }
    render();
  }

  function render() {
    const archived = isArchivedBatch(currentBatch);
    const noReply = isNoReplyBatch(currentBatch);
    const q = ($('f_search').value || '').trim().toUpperCase();
    const filtered = items.filter((it) => {
      if (!q) return true;
      const hay = `${it.sku} ${(it.payload && it.payload['Brand']) || ''} ${(it.payload && it.payload['SKU Desc']) || ''}`.toUpperCase();
      return hay.includes(q);
    }).sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
    if (!filtered.length) {
      $('zs_list').innerHTML = `<div class="empty" style="padding:36px 16px">${archived ? '此週次沒有符合條件的歷史紀錄。' : (noReply ? '此週次沒有符合條件的 SKU — 試下清空搜尋字。' : '暫無指定 SKU — 試下轉「狀態」或清空搜尋字。')}</div>`;
      const c0 = document.getElementById('zs_count');
      if (c0) c0.textContent = '';
      return;
    }
    let html = '<table class="zs-table"><thead><tr><th>週次</th>';
    COLS.forEach((c) => { html += `<th>${p.escapeHtml(c.label)}</th>`; });
    html += '<th>SKU上載日期</th><th>狀態</th><th>店舖回覆</th><th>重複提示</th><th></th></tr></thead><tbody>';
    filtered.forEach((it) => {
      const replied = it.status === 'replied';
      const auto = isAutoFilled(it);
      const n = editCount(it);
      const left = remainingEdits(it);
      const locked = !canEdit(it);
      // 逐行判斷：即使切換期間狀態改變，行本身仍以其批次資料為準
      const rowNoReply = it.reply_required === false;
      const badge = archived
        ? `<span class="badge-archived">${replied ? '已回覆 · 已封存' : (rowNoReply ? '無須回覆 · 已封存' : '未回覆 · 已截止')}</span>`
        : (replied
          ? `<span class="badge-replied">已回覆</span>${auto ? '<span class="badge-auto">自動套用</span>' : ''}`
          : (rowNoReply
            ? '<span class="badge-no-reply">無須回覆</span>'
            : '<span class="badge-pending">未回覆</span>'));
      let reply = replied ? `${p.escapeHtml(it.reason_label || '')}${it.reason_note ? `<div class="hint">${p.escapeHtml(it.reason_note)}</div>` : ''}` : '—';
      if (replied && auto) {
        const source = it.auto_filled_from_week ? `上次（${it.auto_filled_from_week}）回覆` : '上次回覆';
        reply += `<div class="zs-auto-note">系統已自動套用${p.escapeHtml(source)}${locked ? '；修改機會已用完' : `；可再修改 ${left} 次`}</div>`;
      }
      const extended = replyLimit(it) === 3;
      const btnLabel = n === 0 ? '回覆' : locked ? '已鎖定' : (extended ? (left === 1 ? '修改（最後 1 次）' : `修改（可改 ${left} 次）`) : '修改');
      const rc = repeatCount(it);
      let repeatCell = '—';
      if (isRepeat(it)) {
        const prev = prevSummary(it);
        const prevNote = it.prev_reason_note ? `（${p.escapeHtml(it.prev_reason_note)}）` : '';
        const notImproved = it.prev_status === 'pending'
          ? '<div class="hint" style="color:#b42318">上次未回覆，仍未改善</div>'
          : '';
        repeatCell = `<span class="badge-repeat">第${rc}次上榜</span>` +
          (prev ? `<div class="hint">${p.escapeHtml(prev)}${prevNote}</div>` : '') + notImproved +
          // 上次已回覆 → 開啟回覆彈窗時自動帶入上次內容（按鍵在彈窗內可重設）
          (it.prev_status === 'replied' && !archived && !rowNoReply && !locked && !auto ? '<div class="hint">回覆時會自動帶入上次內容</div>' : '');
      }
      const rowClass = archived ? 'zs-archived' : (isRepeat(it) ? 'zs-repeat' : '');
      const weekCell = `${p.escapeHtml(it.week_label || '')}${archived ? '<span class="zs-week-tag">已封存</span>' : (rowNoReply ? '<span class="zs-week-tag">無須回覆</span>' : '')}`;
      const highlight = replyLimit(it) === 3 && !locked && !archived && !rowNoReply && n > 0;
      const needReply = it.status === 'pending' && !archived && !rowNoReply;
      const action = (archived || rowNoReply)
        ? `<span class="zs-closed">${archived ? '已截止' : '無須回覆'}</span>`
        : `<button class="btn ghost${needReply ? ' zs-reply-needed' : ''}${highlight ? ' zs-edit-highlight' : ''}" data-reply="${it.id}" ${locked ? 'disabled' : ''}${needReply ? ' title="此 SKU 仍需要回覆"' : (highlight ? ` title="此 SKU 可再修改 ${left} 次"` : '')}>${btnLabel}</button>`;
      html += `<tr${rowClass ? ` class="${rowClass}"` : ''}><td>${weekCell}</td>`;
      COLS.forEach((c) => {
        const val = c.key === 'Brand' ? brandCode(it) : payloadVal(it, c.key);
        html += `<td>${p.escapeHtml(val)}</td>`;
      });
      html += `<td>${p.escapeHtml(uploadDate(it))}</td><td>${badge}</td><td>${reply}</td><td>${repeatCell}</td><td>${action}</td></tr>`;
    });
    html += '</tbody></table>';
    $('zs_list').innerHTML = html;
    // 一次過顯示 10 筆：按表頭 + 首 10 行實際高度設定容器上限（--zs-fit）；
    // 多過 10 筆時上限止於第 10 行，照舊在容器內捲動；≤10 筆則完全展開不設捲軸
    const wrap = document.querySelector('.zs-table-wrap');
    const table = $('zs_list').querySelector('table.zs-table');
    if (wrap && table) {
      const rows = table.querySelectorAll('tbody tr');
      let fit = table.querySelector('thead tr').getBoundingClientRect().height;
      for (let i = 0; i < rows.length && i < 10; i++) fit += rows[i].getBoundingClientRect().height;
      // +3 = 容器上下 border 各 1px + 高度取整余數
      wrap.style.setProperty('--zs-fit', `${Math.ceil(fit) + 3}px`);
    }
    const cc = document.getElementById('zs_count');
    if (cc) cc.textContent = `顯示 ${filtered.length} / ${items.length} 筆`;
    $('zs_list').querySelectorAll('[data-reply]').forEach((btn) => {
      btn.addEventListener('click', () => openReply(btn.dataset.reply));
    });
  }

  /**
   * 快捷「帶入上次回覆」：將上一次上榜（前一筆同店同 SKU 記錄）的回覆內容填入目前欄位。
   * 只填入、不自動提交 — 店舖確認或修改後按「儲存回覆」才會生效。
   */
  function fillFromPrev(it, opts = {}) {
    const sel = $('reply_reason');
    const options = Array.from(sel.options || []);
    // 上次的原因選項可能已被管理員停用：先以 code 對應，對不上再以顯示標籤對應
    const match = options.find((o) => o.value === it.prev_reason_code) ||
      (it.prev_reason_label ? options.find((o) => o.textContent === it.prev_reason_label) : null);
    if (match) sel.value = match.value;
    $('reply_note').value = it.prev_reason_note || '';
    if (opts.silent) {
      // 開啟彈窗時自動帶入：只更新歷史提示，不使用紅色／藍色錯誤區
      const histEl = $('reply_history');
      if (histEl) {
        histEl.textContent += match
          ? ` 已自動帶入上次（${it.prev_week_label}）的回覆內容，請確認或修改後按「儲存回覆」。`
          : ' 上次回覆的原因選項已停用，請重新選擇最接近的原因。';
      }
      return Boolean(match);
    }
    const msg = match
      ? `已帶入上次（${it.prev_week_label}）的回覆內容：${it.prev_reason_label || match.textContent}` +
        `${it.prev_reason_note ? `／${it.prev_reason_note}` : ''}。請確認或修改後按「儲存回覆」，未儲存前不會生效。`
      : '上次回覆的原因選項現已停用，已帶入補充說明，請重新選擇最接近的原因。';
    p.showAlert($('reply_error'), 'info', p.escapeHtml(msg));
    return Boolean(match);
  }

  function setAutoNotice(text) {
    const el = $('reply_auto_notice');
    if (!el) return;
    el.hidden = !text;
    el.innerHTML = text || '';
  }

  function openReply(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    if (isArchivedBatch(currentBatch)) {
      p.showAlert($('list_error'), 'error', `「${p.escapeHtml(currentBatch.week_label)}」已封存，只供查閱，不能回覆。請切換到最新一週。`);
      return;
    }
    if (isNoReplyBatch(currentBatch) || it.reply_required === false) {
      p.showAlert($('list_error'), 'info', `「${p.escapeHtml(currentBatch.week_label)}」本週無須回覆，只供參考銷售；如要補充說明，請直接聯絡 RP Team。`);
      return;
    }
    if (!canEdit(it)) {
      p.showAlert($('list_error'), 'error', `此 SKU 已用完修改機會（可修改 ${Math.max(1, replyLimit(it) - 1)} 次），如需再更改請聯絡 RP Team`);
      return;
    }
    currentId = id;
    const n = editCount(it);
    const auto = isAutoFilled(it);
    const left = remainingEdits(it);
    $('reply_title').textContent = auto
      ? `確認／修改自動套用回覆 — ${it.sku}`
      : (n === 0 ? `回覆 — ${it.sku}` : `修改回覆 — ${it.sku}`);
    const autoFrom = it.auto_filled_from_week ? ` ${it.auto_filled_from_week} ` : '上次';
    $('reply_sku_info').textContent = `${it.week_label || ''}｜${payloadVal(it, 'Brand')}｜${payloadVal(it, 'SKU Desc')}` +
      (auto
        ? `｜系統已自動套用${autoFrom}的回覆；你仍可修改 ${left} 次`
        : (n >= 1 ? `｜剩餘修改次數：${left} 次` : ''));
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
    setAutoNotice(auto
      ? `<b>系統已自動套用上次回覆。</b>請確認內容是否仍適用；如不適用，請直接修改後按「儲存回覆」。你仍可修改 <b>${left}</b> 次。`
      : '');
    // 快捷按鍵顯示時機：重複上榜 且 上次已有回覆記錄（prev_status === 'replied'）
    const canFillPrev = !auto && !!(isRepeat(it) && it.prev_week_label && it.prev_status === 'replied');
    const fillWrap = $('reply_fill_wrap');
    if (fillWrap) {
      fillWrap.hidden = !canFillPrev;
      if (canFillPrev) {
        const fillBtn = $('btn_fill_prev');
        fillBtn.textContent = `重設為上次回覆（${it.prev_week_label}）`;
        fillBtn.onclick = () => fillFromPrev(it);
      }
    }
    $('reply_reason').value = it.reason_code || (reasons[0] && reasons[0].code) || '';
    $('reply_note').value = it.reason_note || '';
    // 未自動套用的 pending 重複 SKU：開啟彈窗時先自動帶入上次回覆，店舖確認後再儲存
    if (!auto && it.status === 'pending' && canFillPrev) fillFromPrev(it, { silent: true });
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
      // 週次在開啟彈窗後被新批次封存 / 被設為無須回覆：關窗、重新載入並顯示原因
      if (err.status === 409 && (err.data?.code === 'BATCH_CLOSED' || err.data?.code === 'REPLY_NOT_REQUIRED')) {
        $('reply_dialog').close();
        await loadBatches(true);
        await loadList();
        p.showAlert($('list_error'), err.data?.code === 'REPLY_NOT_REQUIRED' ? 'info' : 'error', p.escapeHtml(err.message));
        return;
      }
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
    refreshDesignatedBadge();
    await loadReasons();
    await loadBatches();
    await loadList();
  })();
})();
