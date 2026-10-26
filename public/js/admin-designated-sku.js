/* Admin 指定 SKU 回覆：上載任務、批次進度、任務明細、直 link、匯出
   獨立模組，唔改 admin.js 既有流程；只在切換到此 tab 時才載入資料。 */
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = null;
  let page = 1;
  let currentBatch = null;
  let currentItems = [];
  const PAGE_SIZE_KEY = 'ndrf_admin_dsku_page_size';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  function setBox(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  function alertHtml(type, message) {
    // 用 admin.css 的自訂 alert 顏色（唔依賴 CDN 的 Tabler class）
    const kind = type === 'danger' ? 'error' : type;
    return `<div class="alert ${kind}">${message}</div>`;
  }

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
    if (!res.ok) {
      const err = new Error(data?.error || `請求失敗 (${res.status})`);
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

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

  function pageSize() {
    const v = Number($('dsku_page_size')?.value || 20);
    return [20, 50, 100].includes(v) ? v : 20;
  }

  function fmtStock(value) {
    return value === null || value === undefined ? '<span class="text-secondary">未提供</span>' : esc(String(value));
  }

  function fmtLines(lines) {
    if (!Array.isArray(lines) || !lines.length) return '<span class="text-secondary">—</span>';
    return lines
      .map((l) => `<span class="dsku-line-chip"><b>${esc(l.year_code)}</b> × ${esc(String(l.qty))}</span>`)
      .join(' ');
  }

  function statusTag(item) {
    if (!item.is_open) {
      return item.status === 'replied'
        ? '<span class="badge-zs badge-zs-muted">已回覆 · 已封存</span>'
        : '<span class="badge-zs badge-zs-warn">未回覆 · 已截止</span>';
    }
    return item.status === 'replied'
      ? '<span class="badge-zs badge-zs-ok">已回覆</span>'
      : '<span class="badge-zs badge-zs-warn">未回覆</span>';
  }

  function taskLink(code) {
    return `${location.origin}/portal/designated-sku.html?task=${encodeURIComponent(code)}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  let toastTimer = null;
  function toast(message, ok = true) {
    let el = $('dsku_toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dsku_toast';
      el.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2000;max-width:360px;padding:12px 16px;border-radius:10px;font-size:13.5px;box-shadow:0 8px 24px rgba(15,23,42,.18);background:#0a5c36;color:#fff;';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.background = ok ? '#0a5c36' : '#b42318';
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
  }

  /* ---------------- 總覽 KPI ---------------- */

  async function loadSummary() {
    const box = $('dsku_kpi');
    if (!box) return;
    try {
      const s = await gFetch('/api/admin/designated-sku/summary');
      const rate = s.task_count ? Math.round((s.replied_count / s.task_count) * 100) : 0;
      const items = [
        ['批次數', s.batch_count, `${s.open_batch_count} 個開放中`],
        ['任務數', s.task_count, `${s.store_count} 間店舖`],
        ['已回覆', s.replied_count, `${rate}% 完成`],
        ['未回覆', s.pending_count, s.pending_count ? `${s.pending_store_count} 間店待回覆` : '全部完成'],
      ];
      box.innerHTML = items.map(([label, value, note]) => `
        <div class="stk-kpi">
          <div class="stk-kpi-value">${esc(String(value))}</div>
          <div class="stk-kpi-label">${esc(label)}</div>
          <div class="stk-kpi-sub">${esc(note)}</div>
        </div>`).join('');
      $('dsku_kpi_note').textContent = '即時統計全部批次';
      setBox('dsku_kpi_error', '');
    } catch (err) {
      setBox('dsku_kpi_error', alertHtml('danger', esc(err.message)));
    }
  }

  /* ---------------- 批次列表 ---------------- */

  function fillBatchSelects(options) {
    const exp = $('dsku_exp_batch');
    if (exp) {
      const keep = exp.value;
      exp.innerHTML = '<option value="">全部批次</option>' + options
        .map((b) => `<option value="${esc(b.id)}">${esc(b.batch_code)} — ${esc(b.subject)}</option>`)
        .join('');
      if (keep && options.some((b) => b.id === keep)) exp.value = keep;
    }
  }

  async function loadBatches(resetPage = false) {
    if (resetPage) page = 1;
    const body = $('dsku_batches_body');
    if (!body) return;
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize()) });
      const data = await aFetch(`/api/admin/designated-sku/batches?${params.toString()}`);
      const pages = Number(data.total_pages) || 0;
      if (pages > 0 && Number(data.page) > pages) {
        page = pages;
        return loadBatches();
      }
      page = Number(data.page) || 1;
      fillBatchSelects(data.batch_options || []);
      const rows = data.batches || [];
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="9" class="text-center text-secondary">暫無批次，請先上載 Excel 建立任務。</td></tr>';
      } else {
        body.innerHTML = rows.map((b) => {
          const status = b.is_open
            ? '<span class="badge-zs badge-zs-ok">開放中</span>'
            : `<span class="badge-zs badge-zs-muted">已封存</span><div class="text-secondary small">${esc(b.closed_at || '')}</div>`;
          const optional = [
            b.due_date ? `截止 ${b.due_date}` : '',
            b.reference ? `參考 ${b.reference}` : '',
          ].filter(Boolean).join(' ｜ ');
          return `<tr>
            <td><b class="dsku-code">${esc(b.batch_code)}</b><div class="text-secondary small">${esc(b.created_by)}</div></td>
            <td><b>${esc(b.subject)}</b>${optional ? `<div class="text-secondary small">${esc(optional)}</div>` : ''}${b.warn_count ? `<div class="text-warning small">${b.warn_count} 個匯入提示</div>` : ''}</td>
            <td class="text-end">${b.row_count}</td>
            <td class="text-end">${b.store_count}</td>
            <td class="text-end text-success">${b.replied_count ?? 0}</td>
            <td class="text-end ${b.is_open && b.pending_count ? 'text-danger' : 'text-secondary'}">${b.pending_count ?? 0}</td>
            <td>${status}</td>
            <td class="text-secondary small">${esc(b.created_at)}</td>
            <td><div class="d-flex gap-1 flex-wrap">
              <button class="btn btn-sm" data-dsku-view="${esc(b.id)}">明細</button>
              <a class="btn btn-sm btn-outline-primary" href="/api/admin/designated-sku/export?batch_id=${encodeURIComponent(b.id)}">匯出</a>
              ${b.is_open
                ? `<button class="btn btn-sm btn-outline-secondary" data-dsku-close="${esc(b.id)}" data-code="${esc(b.batch_code)}">封存</button>`
                : `<button class="btn btn-sm btn-outline-primary" data-dsku-reopen="${esc(b.id)}" data-code="${esc(b.batch_code)}">重開</button>`}
              <button class="btn btn-sm btn-outline-danger" data-dsku-del="${esc(b.id)}" data-code="${esc(b.batch_code)}" data-rows="${b.row_count}">刪除</button>
            </div></td></tr>`;
        }).join('');
        body.querySelectorAll('[data-dsku-view]').forEach((btn) => {
          btn.addEventListener('click', () => openBatch(btn.dataset.dskuView));
        });
        body.querySelectorAll('[data-dsku-close]').forEach((btn) => {
          btn.addEventListener('click', () => toggleBatch(btn.dataset.dskuClose, 'close', btn.dataset.code));
        });
        body.querySelectorAll('[data-dsku-reopen]').forEach((btn) => {
          btn.addEventListener('click', () => toggleBatch(btn.dataset.dskuReopen, 'reopen', btn.dataset.code));
        });
        body.querySelectorAll('[data-dsku-del]').forEach((btn) => {
          btn.addEventListener('click', () => removeBatch(btn.dataset.dskuDel, btn.dataset.code, btn.dataset.rows));
        });
      }
      AdminPager.render({
        nav: $('dsku_page_numbers'),
        range: $('dsku_page_range'),
        page,
        total: data.total,
        pageSize: pageSize(),
        onPage: (p) => { page = p; loadBatches(); },
        unit: '個批次',
      });
      setBox('dsku_batch_error', '');
    } catch (err) {
      setBox('dsku_batch_error', alertHtml('danger', esc(err.message)));
    }
  }

  async function toggleBatch(id, action, code) {
    const verb = action === 'close' ? '封存' : '重開';
    if (action === 'close' && !confirm(`確定封存批次「${code}」？封存後店舖只可查閱，不能再提交回覆。`)) return;
    try {
      await aFetch(`/api/admin/designated-sku/batches/${id}/${action}`, { method: 'PUT', body: '{}' });
      toast(`已${verb}批次 ${code}`);
      await loadBatches();
      await loadSummary();
      if (currentBatch && currentBatch.id === id) await openBatch(id, { silent: true });
    } catch (err) {
      setBox('dsku_batch_error', alertHtml('danger', esc(err.message)));
    }
  }

  async function removeBatch(id, code, rows) {
    if (!confirm(`確定刪除批次「${code}」（${rows} 個任務）？此操作會一併刪除所有已提交回覆，無法復原。`)) return;
    try {
      await aFetch(`/api/admin/designated-sku/batches/${id}`, { method: 'DELETE' });
      if (currentBatch && currentBatch.id === id) closeDetail();
      toast(`已刪除批次 ${code}`);
      await loadBatches();
      await loadSummary();
    } catch (err) {
      setBox('dsku_batch_error', alertHtml('danger', esc(err.message)));
    }
  }

  /* ---------------- 批次明細 ---------------- */

  function closeDetail() {
    currentBatch = null;
    currentItems = [];
    $('dsku_detail_card').hidden = true;
  }

  function renderDetailMeta(batch) {
    const bits = [
      `<b class="dsku-code">${esc(batch.batch_code)}</b>`,
      `<b>${esc(batch.subject)}</b>`,
      batch.is_open ? '<span class="badge-zs badge-zs-ok">開放中</span>' : '<span class="badge-zs badge-zs-muted">已封存</span>',
      `${batch.row_count} 個任務 / ${batch.store_count} 間店`,
      `${batch.replied_count} 已回覆`,
      `${batch.pending_count} 未回覆`,
      `建立：${esc(batch.created_by)} ${esc(batch.created_at)}`,
    ];
    // 預留欄位：空白時自動隱藏
    if (batch.due_date) bits.push(`截止日期：<b>${esc(batch.due_date)}</b>`);
    if (batch.reference) bits.push(`參考編號：${esc(batch.reference)}`);
    let html = `<div>${bits.join(' ｜ ')}</div>`;
    if (batch.instructions) {
      html += `<div class="mt-2 dsku-note"><b>任務說明</b><div>${esc(batch.instructions).replace(/\n/g, '<br>')}</div></div>`;
    }
    if (batch.note) {
      html += `<div class="mt-1 dsku-note dsku-note--internal"><b>內部備註</b><div>${esc(batch.note).replace(/\n/g, '<br>')}</div></div>`;
    }
    $('dsku_detail_meta').innerHTML = html;
  }

  async function loadItems(opts = {}) {
    if (!currentBatch) return;
    const body = $('dsku_items_body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="10" class="text-center text-secondary">載入中…</td></tr>';
    try {
      const params = new URLSearchParams();
      const site = ($('dsku_filter_site').value || '').trim();
      const status = $('dsku_filter_status').value;
      if (site) params.set('site_code', site);
      if (status) params.set('status', status);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await aFetch(`/api/admin/designated-sku/batches/${currentBatch.id}/items${qs}`);
      currentBatch = { ...data.batch };
      currentItems = data.items || [];
      renderDetailMeta(currentBatch);
      renderItems();
      setBox('dsku_items_error', '');
    } catch (err) {
      body.innerHTML = `<tr><td colspan="10" class="text-center text-secondary">載入失敗</td></tr>`;
      setBox('dsku_items_error', alertHtml('danger', esc(err.message)));
    }
  }

  function renderItems() {
    const body = $('dsku_items_body');
    if (!body) return;
    if (!currentItems.length) {
      body.innerHTML = '<tr><td colspan="10" class="text-center text-secondary">沒有符合條件的任務。</td></tr>';
      return;
    }
    body.innerHTML = currentItems.map((it) => `<tr>
      <td><b class="dsku-code">${esc(it.task_code)}</b><div class="text-secondary small">${esc(it.batch_code)}</div></td>
      <td>${esc(it.site_code)}</td>
      <td>${esc(it.shop || '')}</td>
      <td class="dsku-code">${esc(it.sku)}</td>
      <td class="dsku-desc">${esc(it.description || '')}</td>
      <td class="text-end">${fmtStock(it.stock_qty)}</td>
      <td>${statusTag(it)}</td>
      <td>${fmtLines(it.lines)}${it.reply_total !== null && it.reply_total !== undefined ? `<div class="text-secondary small">合計 ${it.reply_total} 件${it.reply_note ? ` ｜ ${esc(it.reply_note)}` : ''}</div>` : ''}</td>
      <td class="text-secondary small">${it.replied_by ? `${esc(it.replied_by)}<div>${esc(it.replied_at || '')}</div>` : '—'}${it.admin_edited_at ? `<div class="text-warning">管理員 ${esc(it.admin_edited_by)} 於 ${esc(it.admin_edited_at)} 修改</div>` : ''}</td>
      <td><div class="d-flex gap-1 flex-wrap">
        <button class="btn btn-sm btn-outline-primary" data-dsku-edit-reply="${esc(it.id)}">${it.status === 'replied' ? '編輯回覆' : '代回覆'}</button>
        <button class="btn btn-sm btn-outline-primary" data-dsku-copy="${esc(it.task_code)}">複製連結</button>
        <a class="btn btn-sm" href="${esc(taskLink(it.task_code))}" target="_blank" rel="noopener">開啟</a>
        <button class="btn btn-sm btn-outline-danger" data-dsku-del-item="${esc(it.id)}" data-task="${esc(it.task_code)}">刪除</button>
      </div></td></tr>`).join('');
    body.querySelectorAll('[data-dsku-edit-reply]').forEach((btn) => {
      btn.addEventListener('click', () => openAdminReply(btn.dataset.dskuEditReply, btn));
    });
    body.querySelectorAll('[data-dsku-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await copyText(taskLink(btn.dataset.dskuCopy));
        toast(ok ? `已複製 ${btn.dataset.dskuCopy} 的直 link` : '複製失敗，請手動複製網址', ok);
      });
    });
    body.querySelectorAll('[data-dsku-del-item]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const task = btn.dataset.task;
        if (!confirm(`確定刪除此任務「${task}」？已提交的回覆會一併刪除。`)) return;
        try {
          await aFetch(`/api/admin/designated-sku/batches/${currentBatch.id}/items/${btn.dataset.dskuDelItem}`, { method: 'DELETE' });
          toast(`已刪除任務 ${task}`);
          await loadItems();
          await loadBatches();
          await loadSummary();
        } catch (err) {
          setBox('dsku_items_error', alertHtml('danger', esc(err.message)));
        }
      });
    });
  }

  async function openBatch(id, opts = {}) {
    try {
      const data = await aFetch(`/api/admin/designated-sku/batches/${id}/items`);
      currentBatch = data.batch;
      currentItems = data.items || [];
      $('dsku_detail_card').hidden = false;
      $('dsku_detail_title').textContent = `任務明細 — ${data.batch.batch_code}`;
      $('dsku_detail_export').href = `/api/admin/designated-sku/export?batch_id=${encodeURIComponent(id)}`;
      $('dsku_filter_site').value = '';
      $('dsku_filter_status').value = '';
      renderDetailMeta(currentBatch);
      renderItems();
      if (!opts.silent) $('dsku_detail_card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setBox('dsku_batch_error', alertHtml('danger', esc(err.message)));
    }
  }

  /* ---------------- 管理員代店舖回覆 ---------------- */

  function lockBodyScroll() {
    document.body.classList.add('zs-modal-open');
  }

  function unlockBodyScroll() {
    if (!document.querySelector('#dsku_edit_reply_overlay')) {
      document.body.classList.remove('zs-modal-open');
    }
  }

  /** 舊版 admin.css 未載入新規則時，仍確保彈窗置中顯示 */
  function applyModalFallback(overlay) {
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,.45)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '1056';
    overlay.style.padding = '16px';
    const box = overlay.querySelector('.modal-box');
    if (box) {
      box.style.background = '#fff';
      box.style.borderRadius = '12px';
      box.style.padding = '26px';
      box.style.maxWidth = '520px';
      box.style.width = '100%';
      box.style.boxShadow = '0 10px 30px rgba(0,0,0,.25)';
      box.style.maxHeight = 'calc(100vh - 48px)';
      box.style.overflowY = 'auto';
      box.style.boxSizing = 'border-box';
    }
  }

  /** 與後端 normalizeYearCode 相同：MMYY，月份 01–12 */
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

  function openAdminReply(itemId, triggerBtn) {
    const item = currentItems.find((x) => x.id === itemId);
    if (!item) return;
    if (document.getElementById('dsku_edit_reply_overlay')) return;
    const entering = item.status !== 'replied';
    const stock = item.stock_qty === null || item.stock_qty === undefined ? null : Number(item.stock_qty);
    const overlay = document.createElement('div');
    overlay.id = 'dsku_edit_reply_overlay';
    overlay.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-label="${entering ? '代店舖輸入回覆' : '編輯店舖回覆'}">
      <h3>${entering ? '代店舖輸入回覆' : '編輯店舖回覆'}</h3>
      <p class="text-secondary small" style="margin:6px 0">
        任務：<b class="dsku-code">${esc(item.task_code)}</b>｜${esc(item.site_code)} ${esc(item.shop || '')}｜SKU ${esc(item.sku)}｜存貨 ${item.stock_qty === null || item.stock_qty === undefined ? '未提供' : `${item.stock_qty} 件`}｜${item.is_open ? '批次開放中' : '<b class="text-warning">批次已封存</b>'}
        ${item.replied_by ? `<br>原回覆人：${esc(item.replied_by)}${item.replied_at ? `（${esc(item.replied_at)}）` : ''}` : ''}
      </p>
      <div class="dsku-lines-head"><span>貨品年期 (MMYY)</span><span>可調撥件數</span><span></span></div>
      <div id="dsku_admin_lines"></div>
      <button type="button" class="btn btn-sm dsku-add-line" data-add>＋ 新增年期</button>
      <div id="dsku_admin_total" class="dsku-total"></div>
      <div class="mt-2"><label class="form-label" for="dsku_admin_note">備註（選填）</label><textarea id="dsku_admin_note" class="form-control" rows="2" maxlength="2000" placeholder="例如：店舖以 email 補交／更正年期"></textarea></div>
      <p class="text-secondary small" style="margin:8px 0 0">${entering
        ? '儲存後狀態轉為「已回覆」，回覆人記錄為「管理員代填（你的帳號）」，並寫入審計日誌。'
        : '管理員修改不佔用店舖的修改次數；店舖原本的回覆人及時間會保留，另記錄今次修改的管理員及時間。'}${item.is_open ? '' : ' 此批次已封存，店舖不能修改，但管理員仍可更正紀錄。'}</p>
      <div id="dsku_admin_error" class="text-danger small"></div>
      <div class="d-flex gap-2 justify-content-end mt-3">
        <button class="btn btn-primary" data-save type="button">儲存</button>
        <button class="btn" data-cancel type="button">取消</button>
      </div></div>`;
    document.body.appendChild(overlay);
    applyModalFallback(overlay);
    lockBodyScroll();

    const linesWrap = overlay.querySelector('#dsku_admin_lines');
    const note = overlay.querySelector('#dsku_admin_note');
    const errBox = overlay.querySelector('#dsku_admin_error');
    const totalBox = overlay.querySelector('#dsku_admin_total');
    const saveBtn = overlay.querySelector('[data-save]');
    const cancelBtn = overlay.querySelector('[data-cancel]');

    const updateTotal = () => {
      let total = 0;
      linesWrap.querySelectorAll('[data-line]').forEach((row) => {
        const qty = Number(row.querySelector('.dsku-qty').value);
        if (Number.isFinite(qty) && qty > 0) total += qty;
      });
      const over = stock !== null && total > stock;
      totalBox.classList.toggle('dsku-total--over', over);
      totalBox.innerHTML = `合計 <b>${total}</b> 件${stock !== null ? `｜存貨 <b>${stock}</b> 件` : ''}` +
        (over ? ` <span class="text-danger">超出 ${total - stock} 件，請調整</span>` : '');
    };

    const addLine = (line = {}) => {
      if (linesWrap.querySelectorAll('[data-line]').length >= 20) return;
      const row = document.createElement('div');
      row.className = 'dsku-line';
      row.setAttribute('data-line', '');
      row.innerHTML = `<input class="form-control dsku-year" type="text" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="0827" aria-label="貨品年期 MMYY" value="${line.year_code ? esc(line.year_code) : ''}">
        <input class="form-control dsku-qty" type="number" inputmode="numeric" min="1" max="9999" step="1" placeholder="1" aria-label="可調撥件數" value="${line.qty ? esc(String(line.qty)) : ''}">
        <button class="btn dsku-remove" type="button" aria-label="移除這一個年期">✕</button>`;
      linesWrap.appendChild(row);
      row.querySelector('.dsku-remove').addEventListener('click', () => {
        if (linesWrap.querySelectorAll('[data-line]').length <= 1) {
          row.querySelector('.dsku-year').value = '';
          row.querySelector('.dsku-qty').value = '';
        } else {
          row.remove();
        }
        updateTotal();
      });
      row.querySelectorAll('input').forEach((input) => input.addEventListener('input', updateTotal));
      updateTotal();
    };

    const collect = () => {
      const rows = Array.from(linesWrap.querySelectorAll('[data-line]'));
      const out = [];
      const seen = new Set();
      for (const row of rows) {
        const yearRaw = row.querySelector('.dsku-year').value.trim();
        const qtyRaw = row.querySelector('.dsku-qty').value.trim();
        if (!yearRaw && !qtyRaw) continue;
        if (!yearRaw) throw new Error('請填寫貨品年期（MMYY）');
        if (!qtyRaw) throw new Error(`年期「${yearRaw}」請填寫可調撥件數`);
        const year = normalizeYear(yearRaw);
        if (!year) throw new Error(`年期「${yearRaw}」格式不正確，請填 MMYY（例：0827）`);
        if (seen.has(year)) throw new Error(`年期 ${year} 重複，請合併為一行`);
        seen.add(year);
        const qty = Number(qtyRaw);
        if (!Number.isInteger(qty) || qty < 1) throw new Error(`年期 ${year} 的件數必須為 1 或以上的整數`);
        if (qty > 9999) throw new Error(`年期 ${year} 的件數不可超過 9999`);
        out.push({ year_code: year, qty });
      }
      if (!out.length) throw new Error('請至少填寫一個貨品年期及可調撥件數');
      const total = out.reduce((sum, line) => sum + line.qty, 0);
      if (stock !== null && total > stock) throw new Error(`可調撥件數合計 ${total} 件，不可多於存貨 ${stock} 件`);
      return out;
    };

    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      unlockBodyScroll();
      if (triggerBtn && document.contains(triggerBtn)) triggerBtn.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    cancelBtn.addEventListener('click', close);
    overlay.querySelector('[data-add]').addEventListener('click', () => addLine({}));

    (item.lines && item.lines.length ? item.lines : [{}]).forEach((line) => addLine(line));
    note.value = item.reply_note || '';

    saveBtn.addEventListener('click', async () => {
      errBox.textContent = '';
      let lines;
      try {
        lines = collect();
      } catch (err) {
        errBox.textContent = err.message;
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = '儲存中…';
      const y = window.scrollY;
      try {
        const saved = await aFetch(`/api/admin/designated-sku/batches/${item.batch_id}/items/${item.id}/reply`, {
          method: 'PUT',
          body: JSON.stringify({ lines, note: note.value }),
        });
        close();
        await loadItems();
        await loadBatches();
        await loadSummary();
        window.scrollTo(0, y);
        toast(saved?.entered ? `已代填回覆：${item.task_code}` : `已更新回覆：${item.task_code}`);
      } catch (err) {
        errBox.textContent = err.message;
        saveBtn.disabled = false;
        saveBtn.textContent = '儲存';
      }
    });
    document.addEventListener('keydown', onKey);
    const firstYear = linesWrap.querySelector('.dsku-year');
    if (firstYear && !firstYear.value) firstYear.focus();
    else if (firstQty) firstQty.focus();
  }

  /* ---------------- 上載 ---------------- */

  async function uploadBatch() {
    const res = $('dsku_upload_result');
    const subject = ($('dsku_subject').value || '').trim();
    const file = $('dsku_file').files[0];
    if (!subject) {
      res.innerHTML = alertHtml('danger', '請輸入任務主題');
      $('dsku_subject').focus();
      return;
    }
    if (!file) {
      res.innerHTML = alertHtml('danger', '請選擇 .xlsx 檔案');
      return;
    }
    const fd = new FormData();
    fd.append('subject', subject);
    fd.append('task_type', $('dsku_task_type').value || 'stock_year_breakdown');
    fd.append('due_date', $('dsku_due_date').value || '');
    fd.append('reference', ($('dsku_reference').value || '').trim());
    fd.append('instructions', ($('dsku_instructions').value || '').trim());
    fd.append('note', ($('dsku_note').value || '').trim());
    if ($('dsku_force').checked) fd.append('force', '1');
    fd.append('file', file);

    const btn = $('btn_dsku_upload');
    btn.disabled = true;
    res.innerHTML = alertHtml('info', '上載及建立任務中…');
    try {
      const data = await aFetch('/api/admin/designated-sku/batches', { method: 'POST', body: fd });
      const warnRows = (data.warnings || []).slice(0, 8).map((w) =>
        `<li>第 ${esc(String(w.row))} 行${w.siteCode ? `（${esc(w.siteCode)}）` : ''}：${esc(w.reason)}</li>`).join('');
      res.innerHTML = `
        <div class="alert alert-success">
          已建立批次 <b class="dsku-code">${esc(data.batchCode)}</b>：${data.taskCount} 個任務 / ${data.storeCount} 間店舖。
          ${data.skippedRows ? `已剔除 ${data.skippedRows} 個合計／空白列。` : ''}
          <div class="small mt-1">店舖登入後只會見到屬於自己 Site Code 的任務；可按「批次列表 → 明細」複製直 link。</div>
        </div>
        ${warnRows ? `<div class="alert alert-warning"><b>${data.warnings.length} 個匯入提示</b>（任務已建立，請核對）<ul class="mb-0">${warnRows}</ul></div>` : ''}`;
      $('dsku_force').checked = false;
      $('dsku_file').value = '';
      await loadBatches(true);
      await loadSummary();
      if (data.batchId) await openBatch(data.batchId, { silent: true });
    } catch (err) {
      if (err.status === 409 && err.data?.code === 'DUPLICATE_FILE') {
        res.innerHTML = alertHtml('warning', `${esc(err.message)}<div class="small mt-1">如確定要重新派發，請勾選「仍要重新上載」再試。</div>`);
        $('dsku_force').checked = true;
      } else {
        const list = (err.data?.errors || []).slice(0, 12)
          .map((e) => `<li>第 ${esc(String(e.row))} 行${e.siteCode ? `（${esc(e.siteCode)}）` : ''}：${esc(e.field)} — ${esc(e.reason)}</li>`)
          .join('');
        const warn = (err.data?.warnings || []).slice(0, 6)
          .map((w) => `<li>第 ${esc(String(w.row))} 行${w.siteCode ? `（${esc(w.siteCode)}）` : ''}：${esc(w.reason)}</li>`)
          .join('');
        res.innerHTML = alertHtml('danger', `${esc(err.message)}${list ? `<ul class="mb-0 mt-1">${list}</ul>` : ''}${warn ? `<div class="small mt-1">其他提示：</div><ul class="mb-0">${warn}</ul>` : ''}`);
      }
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- 匯出 ---------------- */

  async function exportExcel(statusOverride) {
    const params = new URLSearchParams();
    const batch = $('dsku_exp_batch').value;
    const site = ($('dsku_exp_site').value || '').trim();
    const status = statusOverride ?? $('dsku_exp_status').value;
    if (batch) params.set('batch_id', batch);
    if (site) params.set('site_code', site);
    if (status) params.set('status', status);
    const box = $('dsku_export_result');
    box.innerHTML = alertHtml('info', '匯出中…');
    try {
      const blob = await gFetch(`/api/admin/designated-sku/export?${params.toString()}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      a.href = url;
      a.download = `Designated_SKU_${stamp}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      box.innerHTML = alertHtml('success', '已匯出 Excel（任務回覆 / 年期明細 / 未回覆店舖）。');
    } catch (err) {
      box.innerHTML = alertHtml('danger', esc(err.message));
    }
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    if (!$('panel-designated-sku')) return;
    AdminPager.bindSize($('dsku_page_size'), PAGE_SIZE_KEY, () => loadBatches(true));
    $('btn_dsku_upload').addEventListener('click', uploadBatch);
    $('btn_dsku_refresh').addEventListener('click', async () => { await loadBatches(); await loadSummary(); });
    $('btn_dsku_detail_close').addEventListener('click', closeDetail);
    $('btn_dsku_apply_filter').addEventListener('click', () => loadItems());
    $('dsku_filter_site').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadItems(); });
    $('btn_dsku_copy_all').addEventListener('click', async () => {
      const pending = currentItems.filter((it) => it.status === 'pending' && it.is_open);
      if (!pending.length) { toast('此批次已沒有未回覆任務', false); return; }
      const text = pending.map((it) => `${it.site_code}\t${it.task_code}\t${taskLink(it.task_code)}`).join('\n');
      const ok = await copyText(text);
      toast(ok ? `已複製 ${pending.length} 條未回覆直 link（Site / 任務編號 / 網址）` : '複製失敗', ok);
    });
    $('btn_dsku_export').addEventListener('click', () => exportExcel());
    $('btn_dsku_export_pending').addEventListener('click', () => exportExcel('pending'));

    // 由 admin.js 在切換到此 tab 時呼叫；第一次才真正載入
    globalThis.__dskuRefresh = async () => {
      await loadBatches();
      await loadSummary();
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
