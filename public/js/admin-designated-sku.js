/* Admin 指定 SKU 回覆：上載 Excel、批次進度、事項明細、直 link、匯出
   一個事項可包含多個 SKU；獨立模組，唔改 admin.js 既有流程。 */
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = null;
  let page = 1;
  let currentBatch = null;
  let currentMatters = [];
  const PAGE_SIZE_KEY = 'ndrf_admin_dsku_page_size';
  const MAX_LINES = 20;

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
    const res = await fetch(url, { ...opts, credentials: 'same-origin' });
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

  function itemReply(item) {
    if (item.status !== 'replied') return '<span class="text-danger small">未回覆</span>';
    if (item.no_transfer) return '<span class="text-secondary small">無可調撥</span>';
    return `${fmtLines(item.lines)}<span class="text-secondary small">合計 ${item.reply_total ?? 0} 件</span>`;
  }

  function matterStatusTag(matter) {
    if (!matter.is_open) {
      return matter.status === 'replied'
        ? '<span class="badge-zs badge-zs-muted">已回覆 · 已封存</span>'
        : '<span class="badge-zs badge-zs-warn">未回覆 · 已截止</span>';
    }
    return matter.status === 'replied'
      ? '<span class="badge-zs badge-zs-ok">已回覆</span>'
      : '<span class="badge-zs badge-zs-warn">未回覆</span>';
  }

  function matterLink(code) {
    return `${location.origin}/portal/designated-sku.html?matter=${encodeURIComponent(code)}`;
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
      el.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2000;max-width:380px;padding:12px 16px;border-radius:10px;font-size:13.5px;box-shadow:0 8px 24px rgba(15,23,42,.18);background:#0a5c36;color:#fff;';
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
      const rate = s.matter_count ? Math.round((s.replied_count / s.matter_count) * 100) : 0;
      const items = [
        ['批次數', s.batch_count, `${s.open_batch_count} 個開放中`],
        ['事項數', s.matter_count, `${s.item_count} 個 SKU`],
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
        body.innerHTML = '<tr><td colspan="10" class="text-center text-secondary">暫無批次，請先上載 Excel 建立事項。</td></tr>';
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
            <td class="text-end">${b.matter_count ?? 0}</td>
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
              <button class="btn btn-sm btn-outline-danger" data-dsku-del="${esc(b.id)}" data-code="${esc(b.batch_code)}" data-rows="${b.matter_count ?? 0}">刪除</button>
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

  async function removeBatch(id, code, matters) {
    if (!confirm(`確定刪除批次「${code}」（${matters} 個事項）？此操作會一併刪除所有已提交回覆，無法復原。`)) return;
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
    currentMatters = [];
    $('dsku_detail_card').hidden = true;
  }

  function renderDetailMeta(batch) {
    const bits = [
      `<b class="dsku-code">${esc(batch.batch_code)}</b>`,
      `<b>${esc(batch.subject)}</b>`,
      batch.is_open ? '<span class="badge-zs badge-zs-ok">開放中</span>' : '<span class="badge-zs badge-zs-muted">已封存</span>',
      `${batch.matter_count} 個事項 / ${batch.row_count} 個 SKU / ${batch.store_count} 間店`,
      `${batch.replied_count} 個事項已回覆`,
      `${batch.pending_count} 個未回覆`,
      `建立：${esc(batch.created_by)} ${esc(batch.created_at)}`,
    ];
    // 預留欄位：空白時自動隱藏
    if (batch.due_date) bits.push(`截止日期：<b>${esc(batch.due_date)}</b>`);
    if (batch.reference) bits.push(`參考編號：${esc(batch.reference)}`);
    let html = `<div>${bits.join(' ｜ ')}</div>`;
    if (batch.instructions) {
      html += `<div class="mt-2 dsku-note"><b>事項說明</b><div>${esc(batch.instructions).replace(/\n/g, '<br>')}</div></div>`;
    }
    if (batch.note) {
      html += `<div class="mt-1 dsku-note dsku-note--internal"><b>內部備註</b><div>${esc(batch.note).replace(/\n/g, '<br>')}</div></div>`;
    }
    $('dsku_detail_meta').innerHTML = html;
  }

  async function loadMatters(opts = {}) {
    if (!currentBatch) return;
    const body = $('dsku_items_body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="7" class="text-center text-secondary">載入中…</td></tr>';
    try {
      const params = new URLSearchParams();
      const site = ($('dsku_filter_site').value || '').trim();
      const status = $('dsku_filter_status').value;
      if (site) params.set('site_code', site);
      if (status) params.set('status', status);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await aFetch(`/api/admin/designated-sku/batches/${currentBatch.id}/matters${qs}`);
      currentBatch = { ...data.batch };
      currentMatters = data.matters || [];
      renderDetailMeta(currentBatch);
      renderMatters();
      setBox('dsku_items_error', '');
    } catch (err) {
      body.innerHTML = '<tr><td colspan="7" class="text-center text-secondary">載入失敗</td></tr>';
      setBox('dsku_items_error', alertHtml('danger', esc(err.message)));
    }
  }

  function renderMatters() {
    const body = $('dsku_items_body');
    if (!body) return;
    if (!currentMatters.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-center text-secondary">沒有符合條件的事項。</td></tr>';
      return;
    }
    body.innerHTML = currentMatters.map((matter) => {
      const skuRows = (matter.items || []).map((item) => `
        <div class="dsku-sku-row">
          <div class="dsku-sku-row-head"><b class="dsku-code">${esc(item.sku)}</b><span>${esc(item.description || '')}</span><em>存貨 ${fmtStock(item.stock_qty)}</em></div>
          <div class="dsku-sku-row-reply">${itemReply(item)}</div>
        </div>`).join('');
      const adminNote = (matter.items || []).some((it) => it.admin_edited_at)
        ? `<div class="text-warning small">管理員於 ${esc((matter.items.find((it) => it.admin_edited_at) || {}).admin_edited_at || '')} 修改</div>`
        : '';
      return `<tr>
        <td><b class="dsku-code">${esc(matter.matter_code)}</b><div class="text-secondary small">${esc(matter.batch_code)}</div></td>
        <td>${esc(matter.site_code)}</td>
        <td>${esc(matter.shop || '')}</td>
        <td><div class="dsku-sku-list">${skuRows}</div></td>
        <td>${matterStatusTag(matter)}<div class="text-secondary small">${matter.replied_item_count} / ${matter.item_count} 個 SKU</div></td>
        <td class="text-secondary small">${matter.replied_by ? `${esc(matter.replied_by)}<div>${esc(matter.replied_at || '')}</div>` : '—'}${adminNote}</td>
        <td><div class="d-flex gap-1 flex-wrap">
          <button class="btn btn-sm btn-outline-primary" data-dsku-edit-reply="${esc(matter.id)}">${matter.status === 'replied' ? '編輯回覆' : '代回覆'}</button>
          <button class="btn btn-sm btn-outline-primary" data-dsku-copy="${esc(matter.matter_code)}">複製連結</button>
          <a class="btn btn-sm" href="${esc(matterLink(matter.matter_code))}" target="_blank" rel="noopener">開啟</a>
          <button class="btn btn-sm btn-outline-danger" data-dsku-del-matter="${esc(matter.id)}" data-code="${esc(matter.matter_code)}">刪除</button>
        </div></td></tr>`;
    }).join('');
    body.querySelectorAll('[data-dsku-edit-reply]').forEach((btn) => {
      btn.addEventListener('click', () => openAdminReply(btn.dataset.dskuEditReply, btn));
    });
    body.querySelectorAll('[data-dsku-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await copyText(matterLink(btn.dataset.dskuCopy));
        toast(ok ? `已複製 ${btn.dataset.dskuCopy} 的直 link` : '複製失敗，請手動複製網址', ok);
      });
    });
    body.querySelectorAll('[data-dsku-del-matter]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const code = btn.dataset.code;
        if (!confirm(`確定刪除事項「${code}」？事項內所有 SKU 的回覆會一併刪除。`)) return;
        try {
          await aFetch(`/api/admin/designated-sku/batches/${currentBatch.id}/matters/${btn.dataset.dskuDelMatter}`, { method: 'DELETE' });
          toast(`已刪除事項 ${code}`);
          await loadMatters();
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
      const data = await aFetch(`/api/admin/designated-sku/batches/${id}/matters`);
      currentBatch = data.batch;
      currentMatters = data.matters || [];
      $('dsku_detail_card').hidden = false;
      $('dsku_detail_title').textContent = `事項明細 — ${data.batch.batch_code}`;
      $('dsku_detail_export').href = `/api/admin/designated-sku/export?batch_id=${encodeURIComponent(id)}`;
      $('dsku_filter_site').value = '';
      $('dsku_filter_status').value = '';
      renderDetailMeta(currentBatch);
      renderMatters();
      if (!opts.silent) $('dsku_detail_card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setBox('dsku_batch_error', alertHtml('danger', esc(err.message)));
    }
  }

  /* ---------------- 管理員代店舖回覆（多個 SKU） ---------------- */

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
      box.style.maxWidth = '640px';
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

  function addAdminLine(wrap, line = {}) {
    if (wrap.querySelectorAll('[data-line]').length >= MAX_LINES) return;
    const row = document.createElement('div');
    row.className = 'dsku-line';
    row.setAttribute('data-line', '');
    row.innerHTML = `<input class="form-control dsku-year" type="text" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="0827" aria-label="貨品年期 MMYY" value="${line.year_code ? esc(line.year_code) : ''}">
      <input class="form-control dsku-qty" type="number" inputmode="numeric" min="1" max="9999" step="1" placeholder="1" aria-label="可調撥件數" value="${line.qty ? esc(String(line.qty)) : ''}">
      <button class="btn dsku-remove" type="button" aria-label="移除這一個年期">✕</button>`;
    wrap.appendChild(row);
    row.querySelector('.dsku-remove').addEventListener('click', () => {
      if (wrap.querySelectorAll('[data-line]').length <= 1) {
        row.querySelector('.dsku-year').value = '';
        row.querySelector('.dsku-qty').value = '';
      } else {
        row.remove();
      }
      updateAdminTotal();
    });
    row.querySelectorAll('input').forEach((input) => input.addEventListener('input', updateAdminTotal));
  }

  function sectionLines(section) {
    return Array.from(section.querySelectorAll('[data-line]'));
  }

  function sectionTotal(section) {
    let total = 0;
    for (const row of sectionLines(section)) {
      const qty = Number(row.querySelector('.dsku-qty').value);
      if (Number.isFinite(qty) && qty > 0) total += qty;
    }
    return total;
  }

  function updateSectionTotal(section) {
    if (!section) return;
    const stock = Number(section.dataset.stock);
    const hasStock = section.dataset.stock !== '';
    const noTransfer = section.querySelector('.dsku-no-transfer').checked;
    const box = section.querySelector('.dsku-sku-total');
    if (noTransfer) {
      box.classList.remove('dsku-total--over');
      box.innerHTML = '無可調撥件數（合計 0 件）';
    } else {
      const total = sectionTotal(section);
      const over = hasStock && total > stock;
      box.classList.toggle('dsku-total--over', over);
      box.innerHTML = `合計 <b>${total}</b> 件${hasStock ? `｜存貨 <b>${stock}</b> 件` : ''}` +
        (over ? ` <span class="text-danger">超出 ${total - stock} 件</span>` : '');
    }
    updateAdminTotal();
  }

  function updateAdminTotal() {
    const wrap = $('dsku_admin_sections');
    if (!wrap) return;
    let total = 0;
    wrap.querySelectorAll('[data-item]').forEach((section) => {
      if (!section.querySelector('.dsku-no-transfer').checked) total += sectionTotal(section);
    });
    const box = $('dsku_admin_total');
    if (box) box.innerHTML = `合計 <b>${total}</b> 件`;
  }

  function buildAdminSkuSection(item) {
    const section = document.createElement('section');
    section.className = 'dsku-sku';
    section.setAttribute('data-item', item.id);
    section.dataset.stock = item.stock_qty === null || item.stock_qty === undefined ? '' : String(item.stock_qty);
    section.innerHTML = `
      <div class="dsku-sku-head">
        <div><b class="dsku-code">${esc(item.sku)}</b> <span>${esc(item.description || '')}</span></div>
        <div class="text-secondary small">存貨 ${fmtStock(item.stock_qty)}</div>
      </div>
      <div class="dsku-editor">
        <div class="dsku-lines-head"><span>貨品年期 (MMYY)</span><span>可調撥件數</span><span></span></div>
        <div class="dsku-lines"></div>
        <button class="btn btn-sm dsku-add-line" type="button" data-add>＋ 新增年期</button>
      </div>
      <label class="dsku-none"><input type="checkbox" class="dsku-no-transfer"> 此 SKU 無可調撥件數</label>
      <div class="dsku-total dsku-sku-total"></div>
      <label class="dsku-sku-note-label" for="dsku_note_${esc(item.id)}">此 SKU 備註（選填）</label>
      <input class="form-control dsku-sku-note" id="dsku_note_${esc(item.id)}" type="text" maxlength="2000" placeholder="例如：店舖 email 補交、陳列品…" value="${esc(item.reply_note || '')}">
    `;
    const wrap = section.querySelector('.dsku-lines');
    (item.lines && item.lines.length ? item.lines : [{}]).forEach((line) => addAdminLine(wrap, line));
    section.querySelector('[data-add]').addEventListener('click', () => {
      addAdminLine(wrap, {});
      updateSectionTotal(section);
    });
    const checkbox = section.querySelector('.dsku-no-transfer');
    checkbox.checked = item.no_transfer === true;
    checkbox.addEventListener('change', () => {
      const editor = section.querySelector('.dsku-editor');
      editor.hidden = checkbox.checked;
      section.classList.toggle('is-no-transfer', checkbox.checked);
      updateSectionTotal(section);
    });
    if (checkbox.checked) {
      section.querySelector('.dsku-editor').hidden = true;
      section.classList.add('is-no-transfer');
    }
    updateSectionTotal(section);
    return section;
  }

  function openAdminReply(matterId, triggerBtn) {
    const matter = currentMatters.find((m) => m.id === matterId);
    if (!matter) return;
    if (document.getElementById('dsku_edit_reply_overlay')) return;
    const entering = matter.status !== 'replied';
    const overlay = document.createElement('div');
    overlay.id = 'dsku_edit_reply_overlay';
    overlay.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-label="${entering ? '代店舖輸入回覆' : '編輯店舖回覆'}">
      <h3>${entering ? '代店舖輸入回覆' : '編輯店舖回覆'}</h3>
      <p class="text-secondary small" style="margin:6px 0">
        事項：<b class="dsku-code">${esc(matter.matter_code)}</b>｜${esc(matter.site_code)} ${esc(matter.shop || '')}｜${matter.item_count} 個 SKU｜${matter.is_open ? '批次開放中' : '<b class="text-warning">批次已封存</b>'}
        ${matter.replied_by ? `<br>原回覆人：${esc(matter.replied_by)}${matter.replied_at ? `（${esc(matter.replied_at)}）` : ''}` : ''}
      </p>
      <div id="dsku_admin_sections"></div>
      <div id="dsku_admin_total" class="dsku-total"></div>
      <p class="text-secondary small" style="margin:8px 0 0">${entering
        ? '儲存後未回覆的 SKU 會轉為「已回覆」，回覆人記錄為「管理員代填（你的帳號）」，並寫入審計日誌。'
        : '管理員修改不佔用店舖的修改次數；店舖原本的回覆人及時間會保留，另記錄今次修改的管理員及時間。'}${matter.is_open ? '' : ' 此批次已封存，店舖不能修改，但管理員仍可更正紀錄。'}</p>
      <div id="dsku_admin_error" class="text-danger small"></div>
      <div class="d-flex gap-2 justify-content-end mt-3">
        <button class="btn btn-primary" data-save type="button">儲存</button>
        <button class="btn" data-cancel type="button">取消</button>
      </div></div>`;
    document.body.appendChild(overlay);
    applyModalFallback(overlay);
    lockBodyScroll();

    const wrap = overlay.querySelector('#dsku_admin_sections');
    (matter.items || []).forEach((item) => wrap.appendChild(buildAdminSkuSection(item)));
    updateAdminTotal();

    const errBox = overlay.querySelector('#dsku_admin_error');
    const saveBtn = overlay.querySelector('[data-save]');
    const cancelBtn = overlay.querySelector('[data-cancel]');

    const collect = () => {
      return Array.from(wrap.querySelectorAll('[data-item]')).map((section) => {
        const item = matter.items.find((it) => it.id === section.dataset.item);
        const sku = item ? item.sku : '—';
        const noTransfer = section.querySelector('.dsku-no-transfer').checked;
        const note = section.querySelector('.dsku-sku-note').value.trim();
        if (noTransfer) return { item_id: section.dataset.item, lines: [], note, no_transfer: true };
        const lines = [];
        const seen = new Set();
        for (const row of sectionLines(section)) {
          const yearRaw = row.querySelector('.dsku-year').value.trim();
          const qtyRaw = row.querySelector('.dsku-qty').value.trim();
          if (!yearRaw && !qtyRaw) continue;
          if (!yearRaw) throw new Error(`SKU ${sku}：請填寫貨品年期（MMYY）`);
          if (!qtyRaw) throw new Error(`SKU ${sku}：年期「${yearRaw}」請填寫可調撥件數`);
          const year = normalizeYear(yearRaw);
          if (!year) throw new Error(`SKU ${sku}：年期「${yearRaw}」格式不正確，請填 MMYY（例：0827）`);
          if (seen.has(year)) throw new Error(`SKU ${sku}：年期 ${year} 重複，請合併為一行`);
          seen.add(year);
          const qty = Number(qtyRaw);
          if (!Number.isInteger(qty) || qty < 1) throw new Error(`SKU ${sku}：年期 ${year} 的件數必須為 1 或以上的整數`);
          if (qty > 9999) throw new Error(`SKU ${sku}：年期 ${year} 的件數不可超過 9999`);
          lines.push({ year_code: year, qty });
        }
        if (!lines.length) throw new Error(`SKU ${sku}：請填寫至少一個年期，或勾選「無可調撥件數」`);
        return { item_id: section.dataset.item, lines, note, no_transfer: false };
      });
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

    saveBtn.addEventListener('click', async () => {
      errBox.textContent = '';
      let items;
      try {
        items = collect();
        if (items.length !== (matter.items || []).length) throw new Error('請為事項內每個 SKU 填寫回覆');
      } catch (err) {
        errBox.textContent = err.message;
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = '儲存中…';
      const y = window.scrollY;
      try {
        const saved = await aFetch(`/api/admin/designated-sku/batches/${matter.batch_id}/matters/${matter.id}/reply`, {
          method: 'PUT',
          body: JSON.stringify({ items }),
        });
        close();
        await loadMatters();
        await loadBatches();
        await loadSummary();
        window.scrollTo(0, y);
        toast(saved?.entered ? `已代填回覆：${matter.matter_code}` : `已更新回覆：${matter.matter_code}`);
      } catch (err) {
        errBox.textContent = err.message;
        saveBtn.disabled = false;
        saveBtn.textContent = '儲存';
      }
    });
    document.addEventListener('keydown', onKey);
  }

  /* ---------------- 上載 ---------------- */

  async function uploadBatch() {
    const res = $('dsku_upload_result');
    const subject = ($('dsku_subject').value || '').trim();
    const file = $('dsku_file').files[0];
    if (!subject) {
      res.innerHTML = alertHtml('danger', '請輸入事項主題');
      $('dsku_subject').focus();
      return;
    }
    if (!file) {
      res.innerHTML = alertHtml('danger', '請選擇 .xlsx 檔案');
      return;
    }
    const fd = new FormData();
    fd.append('subject', subject);
    fd.append('matter_type', $('dsku_matter_type').value || 'stock_year_breakdown');
    fd.append('due_date', $('dsku_due_date').value || '');
    fd.append('reference', ($('dsku_reference').value || '').trim());
    fd.append('instructions', ($('dsku_instructions').value || '').trim());
    fd.append('note', ($('dsku_note').value || '').trim());
    if ($('dsku_force').checked) fd.append('force', '1');
    fd.append('file', file);

    const btn = $('btn_dsku_upload');
    btn.disabled = true;
    res.innerHTML = alertHtml('info', '上載及建立事項中…');
    try {
      const data = await aFetch('/api/admin/designated-sku/batches', { method: 'POST', body: fd });
      const warnRows = (data.warnings || []).slice(0, 8).map((w) =>
        `<li>第 ${esc(String(w.row))} 行${w.siteCode ? `（${esc(w.siteCode)}）` : ''}：${esc(w.reason)}</li>`).join('');
      res.innerHTML = `
        <div class="alert alert-success">
          已建立批次 <b class="dsku-code">${esc(data.batchCode)}</b>：${data.matterCount} 個事項 / ${data.itemCount} 個 SKU（${data.storeCount} 間店舖）。
          ${data.skippedRows ? `已剔除 ${data.skippedRows} 個合計／空白列。` : ''}
          <div class="small mt-1">同店多個 SKU 已歸入同一事項；店舖只會見到屬於自己 Site Code 的事項。可按「批次列表 → 明細」複製直 link。</div>
        </div>
        ${warnRows ? `<div class="alert alert-warning"><b>${data.warnings.length} 個匯入提示</b>（事項已建立，請核對）<ul class="mb-0">${warnRows}</ul></div>` : ''}`;
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
      box.innerHTML = alertHtml('success', '已匯出 Excel（事項回覆 / 年期明細 / 未回覆事項）。');
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
    $('btn_dsku_apply_filter').addEventListener('click', () => loadMatters());
    $('dsku_filter_site').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadMatters(); });
    $('btn_dsku_copy_all').addEventListener('click', async () => {
      const pending = currentMatters.filter((m) => m.status === 'pending' && m.is_open);
      if (!pending.length) { toast('此批次已沒有未回覆事項', false); return; }
      const text = pending.map((m) => `${m.site_code}\t${m.matter_code}\t${matterLink(m.matter_code)}`).join('\n');
      const ok = await copyText(text);
      toast(ok ? `已複製 ${pending.length} 條未回覆直 link（Site / 事項編號 / 網址）` : '複製失敗', ok);
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
