/* Store 指定 SKU 回覆：只顯示屬於本店 Site Code 的任務（後端強制隔離） */
(() => {
  const $ = (id) => document.getElementById(id);
  const p = window.portal;

  let tasks = [];
  let currentTask = null;
  let readOnly = false;
  let saving = false;
  /** 頁面帶 ?task=CODE 時，載入後自動開啟該任務（直 link） */
  let wantedTaskCode = '';

  const MAX_LINES = 20;
  const MAX_QTY = 9999;

  /* ---------------- 工具 ---------------- */

  function fmtStock(value) {
    return value === null || value === undefined ? '未提供' : `${value} 件`;
  }

  function taskStatus(task) {
    if (!task.is_open) {
      return task.status === 'replied'
        ? '<span class="badge-archived">已回覆 · 已截止</span>'
        : '<span class="badge-archived">未回覆 · 已截止</span>';
    }
    return task.status === 'replied'
      ? '<span class="badge-replied">已回覆</span>'
      : '<span class="badge-pending">未回覆</span>';
  }

  function lineChips(task) {
    if (!task.lines || !task.lines.length) return '';
    return task.lines
      .map((l) => `<span class="ds-chip"><b>${p.escapeHtml(l.year_code)}</b> × ${p.escapeHtml(String(l.qty))}</span>`)
      .join(' ');
  }

  function setPageError(message) {
    const el = $('ds_page_error');
    if (!el) return;
    el.innerHTML = message ? `<div class="alert error">${message}</div>` : '';
  }

  /** 與後端 normalizeYearCode 相同的規則：MMYY，月份 01–12 */
  function normalizeYear(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const compact = text.replace(/[\s/\-.]/g, '');
    if (!/^\d{1,4}$/.test(compact)) return null;
    let mm;
    let yy;
    if (compact.length === 4) {
      mm = compact.slice(0, 2);
      yy = compact.slice(2);
    } else if (compact.length === 3) {
      mm = `0${compact.slice(0, 1)}`;
      yy = compact.slice(1);
    } else {
      return null;
    }
    const month = Number(mm);
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    return `${mm}${yy}`;
  }

  /* ---------------- 載入 ---------------- */

  async function loadTasks() {
    const list = $('ds_list');
    try {
      const data = await p.api('/api/portal/designated-sku/tasks');
      tasks = data.tasks || [];
      $('ds_site_info').innerHTML =
        `<div class="site-banner">${p.escapeHtml(data.site_code)}${data.shop ? ` ${p.escapeHtml(data.shop)}` : ''}</div>` +
        `<div>共 ${tasks.length} 個任務${data.pending_count ? `｜<b class="ds-pending-count">${data.pending_count} 個未回覆</b>` : '｜全部已回覆'}</div>`;
      render();
      if (wantedTaskCode) {
        const code = wantedTaskCode;
        wantedTaskCode = '';
        await openByCode(code);
      }
      setPageError('');
    } catch (err) {
      list.innerHTML = '<div class="empty" style="padding:28px">暫時無法載入任務，請按「重新整理」再試。</div>';
      setPageError(p.escapeHtml(err.message));
    }
  }

  function filteredTasks() {
    const q = ($('ds_search').value || '').trim().toUpperCase();
    const status = $('ds_status').value;
    return tasks.filter((task) => {
      if (status && task.status !== status) return false;
      if (!q) return true;
      const hay = `${task.task_code} ${task.batch_code} ${task.sku} ${task.subject} ${task.description || ''}`.toUpperCase();
      return hay.includes(q);
    });
  }

  function render() {
    const list = $('ds_list');
    const rows = filteredTasks();
    if (!rows.length) {
      const any = tasks.length > 0;
      list.innerHTML = `<div class="empty" style="padding:36px 16px">${any ? '沒有符合條件的任務 — 試下轉「狀態」或清空搜尋字。' : '目前沒有指定 SKU 任務。有新任務時會在這裡顯示。'}</div>`;
      return;
    }
    list.innerHTML = rows.map((task) => {
      const closed = !task.is_open;
      const replied = task.status === 'replied';
      const label = closed ? '查看回覆' : replied ? '修改回覆' : '回覆';
      const facts = [
        `存貨 <b>${p.escapeHtml(fmtStock(task.stock_qty))}</b>`,
        `批次 <span class="ds-code">${p.escapeHtml(task.batch_code)}</span>`,
        task.due_date ? `截止 <b>${p.escapeHtml(task.due_date)}</b>` : '',
        task.reference ? `參考 ${p.escapeHtml(task.reference)}` : '',
      ].filter(Boolean).join('<span class="ds-sep">｜</span>');
      const summary = replied
        ? `<div class="ds-reply-summary"><div>${lineChips(task)}${task.reply_total !== null && task.reply_total !== undefined ? `<span class="ds-total-inline">合計 <b>${task.reply_total}</b> 件</span>` : ''}</div>${task.reply_note ? `<div class="hint">備註：${p.escapeHtml(task.reply_note)}</div>` : ''}</div>`
        : '';
      return `<article class="ds-task${closed ? ' ds-task--closed' : replied ? ' ds-task--replied' : ' ds-task--pending'}">
        <div class="ds-task-head">
          <div class="ds-task-head-left">${taskStatus(task)}<span class="ds-task-code">${p.escapeHtml(task.task_code)}</span></div>
          <button class="btn ghost btn-sm ds-open" type="button" data-open="${p.escapeHtml(task.task_code)}"${!closed && !replied ? ' aria-label="此任務仍需要回覆"' : ''}>${label}</button>
        </div>
        <h3 class="ds-task-title">${p.escapeHtml(task.subject)}</h3>
        <div class="ds-task-sku"><b class="ds-code">${p.escapeHtml(task.sku)}</b><span>${p.escapeHtml(task.description || '')}</span></div>
        <div class="ds-task-facts">${facts}</div>
        ${task.instructions ? `<div class="ds-instructions">${p.escapeHtml(task.instructions).replace(/\n/g, '<br>')}</div>` : ''}
        ${summary}
      </article>`;
    }).join('');
    list.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openTask(btn.dataset.open));
    });
  }

  /* ---------------- 回覆彈窗 ---------------- */

  function stockLimit() {
    if (!currentTask) return null;
    return currentTask.stock_qty === null || currentTask.stock_qty === undefined
      ? null
      : Number(currentTask.stock_qty);
  }

  function addLine(line = {}) {
    const wrap = $('ds_lines');
    if (wrap.querySelectorAll('[data-line]').length >= MAX_LINES) return;
    const row = document.createElement('div');
    row.className = 'ds-line';
    row.setAttribute('data-line', '');
    row.innerHTML = `
      <input class="ds-year" type="text" inputmode="numeric" autocomplete="off" maxlength="5"
             placeholder="0827" aria-label="貨品年期 MMYY" value="${line.year_code ? p.escapeHtml(line.year_code) : ''}">
      <input class="ds-qty" type="number" inputmode="numeric" min="1" max="${MAX_QTY}" step="1"
             placeholder="1" aria-label="可調撥件數" value="${line.qty ? p.escapeHtml(String(line.qty)) : ''}">
      <button class="ds-remove" type="button" aria-label="移除這一個年期">✕</button>`;
    wrap.appendChild(row);
    row.querySelector('.ds-remove').addEventListener('click', () => {
      if (wrap.querySelectorAll('[data-line]').length <= 1) {
        row.querySelector('.ds-year').value = '';
        row.querySelector('.ds-qty').value = '';
        updateTotal();
        return;
      }
      row.remove();
      updateTotal();
    });
    row.querySelectorAll('input').forEach((input) => input.addEventListener('input', updateTotal));
    if (readOnly) {
      row.querySelectorAll('input').forEach((input) => { input.disabled = true; });
      row.querySelector('.ds-remove').hidden = true;
    }
    updateTotal();
    return row;
  }

  function updateTotal() {
    const box = $('ds_total');
    if (!box) return;
    let total = 0;
    let bad = false;
    $('ds_lines').querySelectorAll('[data-line]').forEach((row) => {
      const qty = Number(row.querySelector('.ds-qty').value);
      if (Number.isFinite(qty) && qty > 0) total += qty;
      const year = normalizeYear(row.querySelector('.ds-year').value);
      if (row.querySelector('.ds-year').value.trim() && !year) bad = true;
    });
    const stock = stockLimit();
    const over = stock !== null && total > stock;
    const parts = [`合計 <b>${total}</b> 件`];
    if (stock !== null) parts.push(`存貨 <b>${stock}</b> 件`);
    if (over) parts.push(`<span class="ds-over">超出存貨 ${total - stock} 件，請調整</span>`);
    else if (stock !== null && total < stock) parts.push(`<span class="hint">其餘 ${stock - total} 件未填（如不需調撥可留空）</span>`);
    if (bad) parts.push('<span class="ds-over">有年期中格式不正確</span>');
    box.innerHTML = parts.join('｜');
    box.classList.toggle('ds-total--over', over || bad);
  }

  function collectLines() {
    const rows = Array.from($('ds_lines').querySelectorAll('[data-line]'));
    const out = [];
    const seen = new Set();
    for (const row of rows) {
      const yearRaw = row.querySelector('.ds-year').value.trim();
      const qtyRaw = row.querySelector('.ds-qty').value.trim();
      if (!yearRaw && !qtyRaw) continue;
      if (!yearRaw) throw new Error('請填寫貨品年期（MMYY）');
      if (!qtyRaw) throw new Error(`年期「${yearRaw}」請填寫可調撥件數`);
      const year = normalizeYear(yearRaw);
      if (!year) throw new Error(`年期「${yearRaw}」格式不正確，請填 4 位數字 MMYY（例：0827 = 2027 年 8 月）`);
      if (seen.has(year)) throw new Error(`年期 ${year} 重複，請合併為一行`);
      seen.add(year);
      const qty = Number(qtyRaw);
      if (!Number.isInteger(qty) || qty < 1) throw new Error(`年期 ${year} 的可調撥件數必須為 1 或以上的整數`);
      if (qty > MAX_QTY) throw new Error(`年期 ${year} 的可調撥件數不可超過 ${MAX_QTY} 件`);
      out.push({ year_code: year, qty });
    }
    if (!out.length) throw new Error('請至少填寫一個貨品年期及可調撥件數');
    const stock = stockLimit();
    const total = out.reduce((sum, line) => sum + line.qty, 0);
    if (stock !== null && total > stock) {
      throw new Error(`可調撥件數合計 ${total} 件，不可多於存貨 ${stock} 件`);
    }
    return out;
  }

  function openTask(code) {
    const task = tasks.find((t) => t.task_code === code);
    if (!task) return;
    currentTask = task;
    readOnly = !task.is_open;
    $('ds_reply_title').textContent = readOnly
      ? `任務回覆（已截止） — ${task.sku}`
      : task.status === 'replied' ? `修改回覆 — ${task.sku}` : `回覆任務 — ${task.sku}`;
    $('ds_reply_task').textContent = `${task.task_code}｜${task.subject}｜批次 ${task.batch_code}`;
    $('ds_reply_sku').textContent = `${task.description || ''}｜存貨 ${fmtStock(task.stock_qty)}` +
      (task.due_date ? `｜截止 ${task.due_date}` : '') +
      (task.reference ? `｜參考 ${task.reference}` : '') +
      (task.reply_count ? `｜已提交 ${task.reply_count} 次` : '');

    const notice = $('ds_reply_notice');
    if (readOnly) {
      notice.hidden = false;
      notice.className = 'ds-notice ds-notice--closed';
      notice.innerHTML = '此任務已截止，只供查閱，不能再修改回覆。如需更正請聯絡 RP Team。';
    } else if (task.instructions) {
      notice.hidden = false;
      notice.className = 'ds-notice';
      notice.innerHTML = `<b>任務說明</b><div>${p.escapeHtml(task.instructions).replace(/\n/g, '<br>')}</div>`;
    } else {
      notice.hidden = true;
      notice.innerHTML = '';
    }

    $('ds_lines').innerHTML = '';
    const existing = task.lines && task.lines.length ? task.lines : (readOnly ? [] : [{}]);
    $('ds_lines_head').hidden = existing.length === 0;
    $('ds_total').hidden = existing.length === 0;
    existing.forEach((line) => addLine(line));
    if (readOnly && !existing.length) {
      notice.hidden = false;
      notice.className = 'ds-notice ds-notice--closed';
      notice.innerHTML = '此任務已截止，店舖未提交回覆。如需補交請聯絡 RP Team。';
    }
    $('ds_note').value = task.reply_note || '';
    $('ds_note').disabled = readOnly;
    $('ds_add_line').hidden = readOnly;
    $('ds_save').hidden = readOnly;
    $('ds_save').disabled = false;
    p.showAlert($('ds_reply_error'), '', '');
    updateTotal();
    $('ds_reply_dialog').showModal();
    // 未回覆時 focus 第一個年期，方便直接輸入
    if (!readOnly && task.status === 'pending') {
      const first = $('ds_lines').querySelector('.ds-year');
      if (first && !first.value) setTimeout(() => first.focus(), 60);
    }
  }

  /** 直 link：先在本店清單找；找不到再向伺服器查（會被 403 / 404 擋） */
  async function openByCode(code) {
    const local = tasks.find((t) => t.task_code === code);
    if (local) {
      openTask(code);
      return;
    }
    try {
      const data = await p.api(`/api/portal/designated-sku/tasks/${encodeURIComponent(code)}`);
      tasks = [data.task, ...tasks];
      render();
      openTask(data.task.task_code);
    } catch (err) {
      if (err.status === 403) {
        setPageError(`<b>此任務不屬於你店舖。</b>${p.escapeHtml(err.message)}<div class="hint" style="margin-top:4px">如你剛登入其他店舖，請按「登出」再以正確 Site Code 進入。</div>`);
      } else if (err.status === 404) {
        setPageError(`<b>找不到任務 ${p.escapeHtml(code)}。</b>可能已被 RP Team 刪除，或連結有誤。`);
      } else {
        setPageError(p.escapeHtml(err.message));
      }
    }
  }

  /* ---------------- 提交 ---------------- */

  async function saveReply() {
    if (!currentTask || readOnly || saving) return;
    const btn = $('ds_save');
    let lines;
    try {
      lines = collectLines();
      p.showAlert($('ds_reply_error'), '', '');
    } catch (err) {
      p.showAlert($('ds_reply_error'), 'error', p.escapeHtml(err.message));
      return;
    }
    saving = true;
    btn.disabled = true;
    btn.textContent = '儲存中…';
    try {
      const data = await p.api(`/api/portal/designated-sku/tasks/${encodeURIComponent(currentTask.task_code)}/reply`, {
        method: 'PUT',
        body: JSON.stringify({ lines, note: $('ds_note').value }),
      });
      const idx = tasks.findIndex((t) => t.task_code === data.task.task_code);
      if (idx >= 0) tasks[idx] = data.task;
      $('ds_reply_dialog').close();
      render();
      await loadTasks();
      p.showAlert($('ds_list_error'), 'success', `已儲存 <b>${p.escapeHtml(data.task.task_code)}</b> 的回覆（合計 ${data.task.reply_total} 件）。如發現輸入有誤，可在任務截止前再修改。`);
    } catch (err) {
      if (err.status === 409 && err.data?.code === 'TASK_CLOSED') {
        $('ds_reply_dialog').close();
        await loadTasks();
        p.showAlert($('ds_list_error'), 'error', p.escapeHtml(err.message));
        return;
      }
      p.showAlert($('ds_reply_error'), 'error', p.escapeHtml(err.message));
    } finally {
      saving = false;
      btn.disabled = false;
      btn.textContent = '儲存回覆';
    }
  }

  /* ---------------- 初始化 ---------------- */

  $('btn_ds_refresh').addEventListener('click', async () => {
    try {
      await loadTasks();
    } catch (err) {
      setPageError(p.escapeHtml(err.message));
    }
  });
  $('ds_status').addEventListener('change', render);
  $('ds_search').addEventListener('input', render);
  $('ds_add_line').addEventListener('click', () => addLine({}));
  $('ds_cancel').addEventListener('click', () => $('ds_reply_dialog').close());
  $('ds_save').addEventListener('click', saveReply);
  $('logout_link').addEventListener('click', (e) => { e.preventDefault(); p.logout(); });

  (async () => {
    try {
      wantedTaskCode = (new URLSearchParams(window.location.search).get('task') || '').trim();
    } catch {
      wantedTaskCode = '';
    }
    let site;
    try {
      site = await p.ensureStoreSite();
    } catch {
      return;
    }
    $('store_header').textContent = `指定 SKU 回覆 — ${site}`;
    await loadTasks();
  })();
})();
