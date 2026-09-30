/* Admin 90日零銷售批次管理 (獨立於 admin.js，避免衝突) */
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = null;
  let currentBatch = null;
  let reasonsCache = [];
  let itemRows = [];

  async function getCsrf() {
    if (!csrf) {
      const d = await fetch('/api/csrf', { credentials: 'same-origin' }).then((r) => r.json());
      csrf = d.token;
    }
    return csrf;
  }
  async function aFetch(url, opts = {}) {
    const token = await getCsrf();
    const headers = { ...(opts.headers || {}), 'x-csrf-token': token };
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `請求失敗 (${res.status})`);
    return data;
  }
  // 統計/匯出用 GET：不經 CSRF（與現有批次匯出 <a href> 一致，只帶 cookie）
  async function gFetch(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const ct = res.headers.get('Content-Type') || '';
    if (!res.ok) {
      if (ct.includes('json')) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `請求失敗 (${res.status})`);
      }
      throw new Error(`請求失敗 (${res.status})`);
    }
    if (ct.includes('json')) return res.json();
    return res.blob();
  }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }
  function setText(id, v) {
    const el = $(id);
    if (el) el.textContent = v;
  }

  /* ISO 8601 週次（星期一開始，適用 2026/2027/2028 及任何年份） */
  function parseDateInput(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return null;
    const d = new Date(`${str}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function isoWeekOfDate(d) {
    const day = (d.getDay() + 6) % 7; // Mon=0..Sun=6
    const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 3, 12);
    const isoYear = thursday.getFullYear();
    const jan4 = new Date(isoYear, 0, 4, 12);
    const jan4day = (jan4.getDay() + 6) % 7;
    const week1Mon = new Date(isoYear, 0, 4 - jan4day, 12);
    const week = Math.round((thursday.getTime() - week1Mon.getTime()) / (7 * 86400000)) + 1;
    const monday = new Date(week1Mon.getTime() + (week - 1) * 7 * 86400000);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    return { isoYear, week, label: `${isoYear}-W${String(week).padStart(2, '0')}`, monday, sunday };
  }
  function mondayOfIsoWeek(isoYear, week) {
    const jan4 = new Date(isoYear, 0, 4, 12);
    const jan4day = (jan4.getDay() + 6) % 7;
    return new Date(isoYear, 0, 4 - jan4day + (week - 1) * 7, 12);
  }
  function setWeekHint(html) {
    const hint = $('zs_week_hint');
    if (hint) hint.innerHTML = html;
  }
  function refreshWeekFromDate() {
    const dateEl = $('zs_week_date');
    const weekEl = $('zs_week');
    if (!dateEl || !weekEl) return;
    const d = parseDateInput(dateEl.value);
    if (!d) {
      setWeekHint('選擇日期後自動填入 ISO 週次，可再手改');
      return;
    }
    const info = isoWeekOfDate(d);
    weekEl.value = info.label;
    setWeekHint(`${esc(info.label)} ｜ ${esc(fmtDate(info.monday))}（一）至 ${esc(fmtDate(info.sunday))}（日）`);
  }
  function refreshHintFromWeek() {
    const weekEl = $('zs_week');
    if (!weekEl) return;
    const m = /^(\d{4})-W(\d{2})$/.exec((weekEl.value || '').trim());
    if (!m) {
      setWeekHint('格式例如 2026-W40（星期一開始的 ISO 週）');
      return;
    }
    const isoYear = Number(m[1]);
    const week = Number(m[2]);
    if (week < 1 || week > 53) {
      setWeekHint('週數應為 01 至 53');
      return;
    }
    const monday = mondayOfIsoWeek(isoYear, week);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    // 驗證該週確實屬於該 ISO 年（例如 2026 沒有 W01 以外的邊界問題由 Date 自動處理，仍顯示實際範圍）
    setWeekHint(`${esc(weekEl.value.trim())} ｜ ${esc(fmtDate(monday))}（一）至 ${esc(fmtDate(sunday))}（日）`);
  }

  async function loadBatches() {
    const body = $('zs_batches_body');
    if (!body) return;
    try {
      const data = await aFetch('/api/admin/zero-sales/batches');
      const rows = data.batches || [];
      fillExportBatchSelect(rows);
      if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="text-center text-secondary">暫無批次</td></tr>'; return; }
      body.innerHTML = rows.map((b) => `<tr>
        <td><b>${esc(b.week_label)}</b><div class="text-secondary small">${esc(b.note || '')}</div></td>
        <td>${b.row_count}</td><td>${b.store_count}</td>
        <td class="text-success">${b.replied_count ?? 0}</td><td class="text-danger">${b.pending_count ?? 0}</td>
        <td>${esc(b.created_by)}</td><td>${esc(b.created_at)}</td>
        <td><div class="d-flex gap-1 flex-wrap">
          <button class="btn btn-sm" data-zs-view="${b.id}">明細</button>
          <a class="btn btn-sm btn-outline-primary" href="/api/admin/zero-sales/batches/${b.id}/export">匯出</a>
          <button class="btn btn-sm btn-outline-danger" data-zs-del="${b.id}" data-week="${esc(b.week_label)}" data-rows="${b.row_count}">刪除</button>
        </div></td></tr>`).join('');
      body.querySelectorAll('[data-zs-view]').forEach((btn) => {
        btn.addEventListener('click', () => { currentBatch = btn.dataset.zsView; syncExportBatchSelect(); loadItems(); });
      });
      body.querySelectorAll('[data-zs-del]').forEach((btn) => {
        btn.addEventListener('click', () => deleteBatch(btn.dataset.zsDel, btn.dataset.week || '', Number(btn.dataset.rows || 0)));
      });
      if (!currentBatch && rows[0]) currentBatch = rows[0].id;
      syncExportBatchSelect();
    } catch (err) {
      body.innerHTML = `<tr><td colspan="8" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  function fillExportBatchSelect(rows) {
    const sel = $('zs_exp_batch');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部批次</option>' + rows.map((b) => {
      const total = (b.replied_count ?? 0) + (b.pending_count ?? 0);
      return `<option value="${b.id}">${esc(b.week_label)}（共 ${total}｜未 ${b.pending_count ?? 0}）</option>`;
    }).join('');
    if (cur) sel.value = cur;
  }

  function syncExportBatchSelect() {
    const sel = $('zs_exp_batch');
    if (sel && currentBatch) {
      const has = [...sel.options].some((o) => o.value === currentBatch);
      if (has) sel.value = currentBatch;
    }
  }

  async function loadItems() {
    const res = $('zs_items_result');
    const body = $('zs_items_body');
    if (!currentBatch) { if (res) res.innerHTML = '<div class="alert alert-info">請先選擇批次</div>'; return; }
    const site = ($('zs_filter_site').value || '').trim();
    const status = $('zs_filter_status').value;
    const qs = new URLSearchParams();
    if (site) qs.set('site_code', site);
    if (status) qs.set('status', status);
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${currentBatch}/items?${qs.toString()}`);
      const rows = data.items || [];
      itemRows = rows;
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="9" class="text-center text-secondary">此篩選沒有資料</td></tr>';
        return;
      }
      if (res) res.innerHTML = `<div class="text-secondary small">批次 ${esc(currentBatch.slice(0, 8))}｜共 ${rows.length} 筆｜已回覆 ${rows.filter((r) => r.status === 'replied').length}｜已鎖定（用完修改） ${rows.filter((r) => (r.reply_count ?? (r.status === 'replied' ? 1 : 0)) >= 2).length} <a href="/api/admin/zero-sales/batches/${currentBatch}/export">匯出 Excel</a></div>`;
      body.innerHTML = rows.slice(0, 200).map((i) => {
        const n = i.reply_count ?? (i.status === 'replied' ? 1 : 0);
        const upDate = i.batch_date || (i.batch_created_at || '').slice(0, 10);
        const lockTag = n >= 2 ? ' <span class="badge bg-secondary">已鎖定</span>' : n === 1 ? ' <span class="text-secondary small">可再改1次</span>' : '';
        const editBtn = i.status === 'replied'
          ? `<button class="btn btn-sm" data-zs-item-edit="${i.id}">編輯回覆</button>`
          : '';
        return `<tr>
        <td>${esc(i.site_code)}</td><td>${esc(i.sku)}</td>
        <td>${esc(i.payload?.['Brand'] || '')}</td><td>${esc(i.payload?.['SKU Desc'] || '')}</td>
        <td>${esc(upDate)}</td>
        <td>${i.status === 'replied' ? '<span class="badge bg-success">已回覆</span>' : '<span class="badge bg-warning">未回覆</span>'}</td>
        <td>${n}次${lockTag}</td>
        <td>${esc(i.reason_label || '')}${i.reason_note ? `（${esc(i.reason_note)}）` : ''}</td>
        <td><div class="d-flex gap-1 flex-wrap">${editBtn}<button class="btn btn-sm btn-outline-danger" data-zs-item-del="${i.id}" data-site="${esc(i.site_code)}" data-sku="${esc(i.sku)}">刪除</button></div></td></tr>`;
      }).join('')
        + (rows.length > 200 ? `<tr><td colspan="9" class="text-center text-secondary">只顯示首 200 筆，請匯出 Excel 查看全部</td></tr>` : '');
      body.querySelectorAll('[data-zs-item-edit]').forEach((btn) => {
        btn.addEventListener('click', () => openEditReply(btn.dataset.zsItemEdit));
      });
      body.querySelectorAll('[data-zs-item-del]').forEach((btn) => {
        btn.addEventListener('click', () => deleteItem(currentBatch, btn.dataset.zsItemDel, btn.dataset.site || '', btn.dataset.sku || '', btn));
      });
    } catch (err) {
      if (res) res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  async function upload() {
    const res = $('zs_upload_result');
    const file = $('zs_file').files[0];
    let week = ($('zs_week').value || '').trim();
    if (!week && $('zs_week_date')?.value) {
      refreshWeekFromDate();
      week = ($('zs_week').value || '').trim();
    }
    if (!week) { res.innerHTML = '<div class="alert alert-danger">請選擇日期或填寫週次（例如 2026-W40）</div>'; return; }
    if (!file) { res.innerHTML = '<div class="alert alert-danger">請選擇 .xlsx</div>'; return; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('week_label', week);
    fd.append('note', $('zs_note').value || '');
    res.innerHTML = '<div class="alert alert-info">上載中…</div>';
    try {
      const data = await aFetch('/api/admin/zero-sales/batches', { method: 'POST', body: fd });
      res.innerHTML = `<div class="alert alert-success">已建立批次（${data.totalRows} 行）</div>`;
      $('zs_file').value = '';
      await loadBatches();
      await loadSummary();
    } catch (err) {
      res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  /* 統計總覽 -------------------------------------------------------- */
  async function loadSummary() {
    const note = $('zs_summary_note');
    const statBox = $('zs_stats_result');
    const reasonBody = $('zs_reason_stats_body');
    const storeBody = $('zs_store_stats_body');
    try {
      const s = await gFetch('/api/admin/zero-sales/summary');
      // 頂部總覽卡
      setText('s_zs_total', String(s.total ?? 0));
      setText('s_zs_replied', String(s.replied ?? 0));
      setText('s_zs_pending', String(s.pending ?? 0));
      setText('s_zs_rate', `${s.reply_rate ?? 0}%`);
      setText('s_zs_stores', `${s.stores_total ?? 0} / ${s.stores_pending ?? 0}`);
      const lb = s.latest_batch;
      setText('s_zs_latest', lb ? `${lb.week_label} ${lb.replied}/${lb.total}` : '—');
      if (note) {
        note.textContent = s.total
          ? `共 ${s.batches} 個批次｜${s.total} 行｜回覆率 ${s.reply_rate}%｜已鎖定 ${s.locked} 行`
          : '暫無零銷售資料';
      }
      // 區內統計文字
      if (statBox) {
        statBox.innerHTML = `共 <b>${s.batches}</b> 個批次｜總 <b>${s.total}</b> 行｜已回覆 <b class="text-success">${s.replied}</b>｜未回覆 <b class="text-danger">${s.pending}</b>｜回覆率 <b>${s.reply_rate}%</b>｜涉及 <b>${s.stores_total}</b> 間店（<b>${s.stores_pending}</b> 間仍有待回覆，<b>${s.stores_done}</b> 間已完成）｜已鎖定（用完修改） <b>${s.locked}</b> 行`
          + (lb ? `<br>最新批次：<b>${esc(lb.week_label)}</b> ${lb.replied}/${lb.total}（未 ${lb.pending}）｜${esc(lb.created_at)}` : '');
      }
      // 原因分佈
      if (reasonBody) {
        const rows = s.by_reason || [];
        if (!rows.length) {
          reasonBody.innerHTML = '<tr><td colspan="3" class="text-center text-secondary">暫無已回覆資料</td></tr>';
        } else {
          const denom = Math.max(1, s.replied || 0);
          reasonBody.innerHTML = rows.map((r) => {
            const pct = Math.round((r.count / denom) * 1000) / 10;
            return `<tr><td>${esc(r.reason_label || r.reason_code)}</td><td>${r.count}</td><td>${pct}%</td></tr>`;
          }).join('');
        }
      }
      // 待回覆店舖
      if (storeBody) {
        const rows = s.pending_by_store || [];
        const pendingRows = rows.filter((r) => r.pending > 0);
        if (!pendingRows.length) {
          storeBody.innerHTML = '<tr><td colspan="5" class="text-center text-secondary">全部店舖已回覆完成</td></tr>';
        } else {
          storeBody.innerHTML = pendingRows.slice(0, 50).map((r) => `<tr>
            <td><b>${esc(r.site_code)}</b></td><td>${esc(r.shop || '—')}</td>
            <td>${r.total}</td><td class="text-success">${r.replied}</td><td class="text-danger"><b>${r.pending}</b></td>
          </tr>`).join('');
        }
      }
    } catch (err) {
      if (note) note.textContent = `統計載入失敗：${err.message}`;
      if (statBox) statBox.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
      if (reasonBody) reasonBody.innerHTML = `<tr><td colspan="3" class="text-center text-danger">${esc(err.message)}</td></tr>`;
      if (storeBody) storeBody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  /* 刪除：批次 / 批次某店 / 批次某店某SKU（二次確認，不可還原） ---- */

  function confirmZsDelete(title, lines) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'zs_delete_overlay';
      overlay.innerHTML = `<div class="modal-box" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
        <h3 class="text-danger">${esc(title)}</h3>
        ${(lines || []).map((l) => `<p class="text-secondary small" style="margin:6px 0">${esc(l)}</p>`).join('')}
        <div class="d-flex gap-2 justify-content-end mt-4">
          <button class="btn btn-danger" data-ok>確認刪除</button>
          <button class="btn" data-cancel>取消</button>
        </div></div>`;
      document.body.appendChild(overlay);
      const done = (v) => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      overlay.querySelector('[data-ok]').addEventListener('click', () => done(true));
      overlay.querySelector('[data-cancel]').addEventListener('click', () => done(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
      document.addEventListener('keydown', onKey);
      overlay.querySelector('[data-cancel]').focus();
    });
  }

  function zsDeleteResult(html) {
    const el = $('zs_delete_result');
    if (el) {
      el.innerHTML = html;
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async function refreshAfterDelete() {
    await loadBatches();
    await loadSummary();
    if (currentBatch) await loadItems();
  }

  async function deleteBatch(batchId, weekLabel, rowCount) {
    if (!batchId) return;
    const ok = await confirmZsDelete('確認刪除整個批次？', [
      `批次：${weekLabel || batchId.slice(0, 8)}（共 ${rowCount} 行）`,
      '該批次全部 SKU 行（含店舖已提交的回覆）將一併清除，店舖不再看到這些指派。',
      '此操作不可還原。如只上載錯部分店舖，請改用下面的店舖級刪除。',
    ]);
    if (!ok) return;
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${batchId}`, { method: 'DELETE' });
      if (currentBatch === batchId) currentBatch = null;
      zsDeleteResult(`<div class="alert alert-success">已刪除批次「${esc(weekLabel)}」（${data.deleted_items ?? rowCount} 行）。</div>`);
      await refreshAfterDelete();
    } catch (err) {
      zsDeleteResult(`<div class="alert alert-danger">${esc(err.message)}</div>`);
    }
  }

  async function deleteBatchSite() {
    const res = $('zs_delete_result');
    if (!currentBatch) {
      if (res) res.innerHTML = '<div class="alert alert-danger">請先按「明細」選擇一個批次</div>';
      return;
    }
    const site = (($('zs_filter_site')?.value || '').trim() || '').toUpperCase();
    if (!site) {
      if (res) res.innerHTML = '<div class="alert alert-danger">請先在「篩選 Site Code」填寫店舖（例如 HC63），再按刪除</div>';
      return;
    }
    const ok = await confirmZsDelete('確認刪除此店此批次資料？', [
      `店舖：${site}`,
      '該店在此批次的全部 SKU 行（含已回覆）將被清除，其他店不受影響。',
      '此操作不可還原。',
    ]);
    if (!ok) return;
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${currentBatch}/sites/${encodeURIComponent(site)}`, { method: 'DELETE' });
      zsDeleteResult(`<div class="alert alert-success">已刪除「${esc(site)}」在此批次的 ${data.deleted_items} 行。</div>`);
      await refreshAfterDelete();
    } catch (err) {
      zsDeleteResult(`<div class="alert alert-danger">${esc(err.message)}</div>`);
    }
  }

  async function deleteItem(batchId, itemId, site, sku, btn) {
    if (!batchId || !itemId) return;
    const ok = await confirmZsDelete('確認刪除此 SKU 行？', [
      `店舖：${site}｜SKU：${sku}`,
      '該行（含店舖已提交的回覆，如有）將被清除，同批次其他行不受影響。',
      '此操作不可還原。',
    ]);
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.textContent = '刪除中…'; }
    try {
      await aFetch(`/api/admin/zero-sales/batches/${batchId}/items/${itemId}`, { method: 'DELETE' });
      zsDeleteResult(`<div class="alert alert-success">已刪除「${esc(site)}｜${esc(sku)}」。</div>`);
      await refreshAfterDelete();
    } catch (err) {
      zsDeleteResult(`<div class="alert alert-danger">${esc(err.message)}</div>`);
      if (btn) { btn.disabled = false; btn.textContent = '刪除'; }
    }
  }

  /* 管理員代改店舖回覆（不受鎖定限制，不佔用店舖修改次數） ---- */

  async function ensureReasons() {
    if (reasonsCache.length) return reasonsCache;
    const data = await aFetch('/api/admin/zero-sales/reasons');
    reasonsCache = (data.reasons || []).filter((r) => r.active);
    return reasonsCache;
  }

  function openEditReply(itemId) {
    const item = itemRows.find((x) => x.id === itemId);
    if (!item || item.status !== 'replied') return;
    openEditReplyOverlay(item);
  }

  function openEditReplyOverlay(item) {
    const overlay = document.createElement('div');
    overlay.id = 'zs_edit_reply_overlay';
    overlay.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-label="編輯店舖回覆">
      <h3>編輯店舖回覆</h3>
      <p class="text-secondary small" style="margin:6px 0">店舖：${esc(item.site_code)}｜SKU：${esc(item.sku)}${item.replied_by ? `｜原回覆人：${esc(item.replied_by)}` : ''}</p>
      <div class="mb-2"><label class="form-label">回覆原因</label><select id="zs_edit_reason" class="form-select"></select></div>
      <div class="mb-2"><label class="form-label">補充說明</label><textarea id="zs_edit_note" class="form-control" rows="3" maxlength="2000" placeholder="選擇須補充的原因時必填"></textarea></div>
      <p class="text-secondary small" style="margin:6px 0">管理員修改不受鎖定限制，亦不佔用店舖的修改次數；更改會記錄在審計日誌。</p>
      <div id="zs_edit_reply_error" class="text-danger small"></div>
      <div class="d-flex gap-2 justify-content-end mt-3">
        <button class="btn btn-primary" data-save>儲存</button>
        <button class="btn" data-cancel>取消</button>
      </div></div>`;
    document.body.appendChild(overlay);
    const sel = overlay.querySelector('#zs_edit_reason');
    const note = overlay.querySelector('#zs_edit_note');
    const errBox = overlay.querySelector('#zs_edit_reply_error');
    const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-cancel]').addEventListener('click', close);
    overlay.querySelector('[data-save]').addEventListener('click', async () => {
      const btn = overlay.querySelector('[data-save]');
      errBox.textContent = '';
      const reasonCode = sel.value;
      const reason = reasonsCache.find((r) => r.code === reasonCode);
      const noteVal = (note.value || '').trim();
      if (reason?.require_note && !noteVal) {
        errBox.textContent = `選擇「${reason.label}」必須填寫補充說明`;
        return;
      }
      btn.disabled = true; btn.textContent = '儲存中…';
      try {
        await aFetch(`/api/admin/zero-sales/batches/${currentBatch}/items/${item.id}/reply`, {
          method: 'PUT',
          body: JSON.stringify({ reason_code: reasonCode, reason_note: noteVal }),
        });
        close();
        zsDeleteResult(`<div class="alert alert-success">已更新回覆：${esc(item.site_code)}｜${esc(item.sku)}。</div>`);
        if (currentBatch) await loadItems();
      } catch (err) {
        errBox.textContent = err.message;
        btn.disabled = false; btn.textContent = '儲存';
      }
    });
    ensureReasons().then((reasons) => {
      if (!reasons.length) { errBox.textContent = '沒有可用的回覆原因選項'; return; }
      sel.innerHTML = reasons.map((r) => `<option value="${esc(r.code)}"${r.code === item.reason_code ? ' selected' : ''}>${esc(r.label)}</option>`).join('');
      note.value = item.reason_note || '';
      sel.focus();
    }).catch((err) => { errBox.textContent = err.message; });
    document.addEventListener('keydown', onKey);
  }

  /* 統一匯出 -------------------------------------------------------- */
  function buildExportQuery(onlyUnreplied) {
    const qs = new URLSearchParams();
    const batch = $('zs_exp_batch')?.value || '';
    const site = ($('zs_exp_site')?.value || '').trim();
    const status = $('zs_exp_status')?.value || '';
    const reason = $('zs_exp_reason')?.value || '';
    if (batch) qs.set('batch_id', batch);
    if (site) qs.set('site_code', site);
    if (onlyUnreplied) qs.set('status', 'pending');
    else if (status) qs.set('status', status);
    if (reason) qs.set('reason_code', reason);
    return qs.toString();
  }

  async function downloadExport(onlyUnreplied) {
    const res = $('zs_export_result');
    const btn = onlyUnreplied ? $('btn_zs_export_unreplied') : $('btn_zs_export');
    const qs = buildExportQuery(onlyUnreplied);
    if (btn) { btn.disabled = true; btn.textContent = '匯出中…'; }
    if (res) res.innerHTML = '<div class="alert alert-info">匯出中…</div>';
    try {
      const response = await fetch(`/api/admin/zero-sales/export?${qs}`, { credentials: 'same-origin' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: '匯出失敗' }));
        throw new Error(data.error || '匯出失敗');
      }
      const blob = await response.blob();
      const disp = response.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? match[1] : 'Zero_Sales_Export.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (res) res.innerHTML = '<div class="alert alert-success">匯出成功（唯讀，不會鎖定店舖回覆）。</div>';
    } catch (err) {
      if (res) res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = onlyUnreplied ? '只匯出未回覆' : '匯出 Excel'; }
    }
  }

  function init() {
    if (!$('zs_batches_body')) return;
    $('btn_zs_upload').addEventListener('click', upload);
    // 日期選擇自動計 ISO 週次（星期一開始）
    const dateEl = $('zs_week_date');
    const weekEl = $('zs_week');
    if (dateEl) dateEl.addEventListener('change', refreshWeekFromDate);
    if (weekEl) weekEl.addEventListener('input', refreshHintFromWeek);
    // 預設帶今日日期並自動填週次（例如 2026/09/29 = 2026-W40）
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (dateEl && !dateEl.value) dateEl.value = today;
      if (weekEl && !weekEl.value.trim()) refreshWeekFromDate();
      else refreshHintFromWeek();
    } catch {}
    $('btn_zs_view').addEventListener('click', loadItems);
    const delSiteBtn = $('btn_zs_delete_site');
    if (delSiteBtn) delSiteBtn.addEventListener('click', deleteBatchSite);
    const reasonBtn = $('btn_zs_reason_save');
    if (reasonBtn) reasonBtn.addEventListener('click', saveReason);
    const statsBtn = $('btn_zs_stats_refresh');
    if (statsBtn) statsBtn.addEventListener('click', loadSummary);
    const expBtn = $('btn_zs_export');
    if (expBtn) expBtn.addEventListener('click', () => downloadExport(false));
    const expUnreplied = $('btn_zs_export_unreplied');
    if (expUnreplied) expUnreplied.addEventListener('click', () => downloadExport(true));
    const expBatch = $('zs_exp_batch');
    if (expBatch) expBatch.addEventListener('change', () => {
      const v = expBatch.value;
      if (v) { currentBatch = v; loadItems(); }
    });
    // 懶載入：捲動到零銷售區塊才請求 batches / reasons / summary，首屏更快
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      loadBatches();
      loadReasons();
      loadSummary();
    };
    // 供頂部「立即更新」一併刷新
    globalThis.__zsRefresh = () => { started = true; loadBatches(); loadReasons(); loadSummary(); };
    const anchor = $('zs_card') || $('zs_batches_body');
    if (!('IntersectionObserver' in window)) { start(); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { start(); io.disconnect(); }
      });
    }, { rootMargin: '500px 0px' });
    io.observe(anchor);
  }

  async function loadReasons() {
    const body = $('zs_reasons_body');
    if (!body) return;
    try {
      const data = await aFetch('/api/admin/zero-sales/reasons');
      const rows = data.reasons || [];
      reasonsCache = rows.filter((r) => r.active);
      // 同步匯出篩選的原因下拉
      const expReason = $('zs_exp_reason');
      if (expReason) {
        const cur = expReason.value;
        expReason.innerHTML = '<option value="">全部原因</option>' + rows.filter((r) => r.active).map((r) => `<option value="${esc(r.code)}">${esc(r.label)}</option>`).join('');
        if (cur) expReason.value = cur;
      }
      if (!rows.length) { body.innerHTML = '<tr><td colspan="6" class="text-center text-secondary">暫無原因</td></tr>'; return; }
      body.innerHTML = rows.map((r) => `<tr>
        <td>${esc(r.code)}</td><td>${esc(r.label)}</td><td>${r.sort_order}</td>
        <td>${r.require_note ? '是' : '否'}</td><td>${r.active ? '<span class="badge bg-success">啟用</span>' : '<span class="badge bg-secondary">停用</span>'}</td>
        <td><div class="d-flex gap-1">
          <button class="btn btn-sm" data-zs-reason-edit="${esc(r.code)}">編輯</button>
          <button class="btn btn-sm btn-outline-danger" data-zs-reason-toggle="${esc(r.code)}" data-active="${r.active ? 0 : 1}">${r.active ? '停用' : '啟用'}</button>
        </div></td></tr>`).join('');
      body.querySelectorAll('[data-zs-reason-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = rows.find((x) => x.code === btn.dataset.zsReasonEdit);
          if (!row) return;
          $('zs_reason_code').value = row.code;
          $('zs_reason_label').value = row.label;
          $('zs_reason_sort').value = row.sort_order;
          $('zs_reason_reqnote').value = String(Boolean(row.require_note));
          $('zs_reason_active').value = String(Boolean(row.active));
          $('zs_reason_label').focus();
        });
      });
      body.querySelectorAll('[data-zs-reason-toggle]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = rows.find((x) => x.code === btn.dataset.zsReasonToggle);
          if (!row) return;
          await aFetch('/api/admin/zero-sales/reasons', {
            method: 'PUT',
            body: JSON.stringify({ code: row.code, label: row.label, sort_order: row.sort_order, active: btn.dataset.active === '1', require_note: row.require_note }),
          });
          await loadReasons();
        });
      });
    } catch (err) {
      body.innerHTML = `<tr><td colspan="6" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  async function saveReason() {
    const res = $('zs_reason_result');
    const code = ($('zs_reason_code').value || '').trim();
    const label = ($('zs_reason_label').value || '').trim();
    if (!code || !label) { res.innerHTML = '<div class="alert alert-danger">Code 及顯示名稱為必填</div>'; return; }
    try {
      await aFetch('/api/admin/zero-sales/reasons', {
        method: 'PUT',
        body: JSON.stringify({
          code,
          label,
          sort_order: Number($('zs_reason_sort').value || 0),
          active: $('zs_reason_active').value === 'true',
          require_note: $('zs_reason_reqnote').value === 'true',
        }),
      });
      res.innerHTML = '<div class="alert alert-success">已儲存</div>';
      await loadReasons();
    } catch (err) {
      res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
