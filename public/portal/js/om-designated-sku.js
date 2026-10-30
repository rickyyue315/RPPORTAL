/* OM 指定 SKU 代覆：沿用店舖版事項介面，加上店舖標示。
   只可存取 /api/portal/om/designated-sku/*（後端已按登入 OM 限定管轄店舖）。 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const om = () => window.omApp;
  const esc = (v) => (om() ? om().esc(v) : String(v ?? ''));

  let matters = [];
  let currentMatter = null;
  let readOnly = false;
  let saving = false;
  let searchTimer = null;

  const MAX_LINES = 20;
  const MAX_QTY = 9999;

  function fmtStock(value) {
    return value === null || value === undefined ? '未提供' : `${value} 件`;
  }

  function showError(message) {
    om()?.showAlert($('om_ds_error'), 'error', message);
  }

  function matterStatusBadge(matter) {
    if (!matter.is_open) {
      return matter.status === 'replied'
        ? '<span class="badge-archived">已回覆 · 已截止</span>'
        : `<span class="badge-archived">${matter.is_expired ? '未回覆 · 已過截止' : '未回覆 · 已截止'}</span>`;
    }
    return matter.status === 'replied'
      ? '<span class="badge-replied">已回覆</span>'
      : '<span class="badge-pending">未回覆</span>';
  }

  function itemSummary(item) {
    if (item.status !== 'replied') return '<span class="ds-line-pending">未回覆</span>';
    if (item.no_transfer) return '<span class="ds-line-none">無可調撥</span>';
    const chips = (item.lines || [])
      .map((line) => `<span class="ds-chip"><b>${esc(line.year_code)}</b> × ${esc(String(line.qty))}</span>`)
      .join(' ');
    return `${chips}<span class="ds-total-inline">合計 <b>${item.reply_total ?? 0}</b> 件</span>`;
  }

  function filteredMatters() {
    const q = ($('om_ds_search')?.value || '').trim().toUpperCase();
    const status = $('om_ds_status')?.value || '';
    return matters.filter((matter) => {
      if (status && matter.status !== status) return false;
      if (!q) return true;
      const skuText = (matter.items || []).map((it) => `${it.sku} ${it.description || ''}`).join(' ');
      const hay = `${matter.matter_code} ${matter.batch_code} ${matter.subject} ${matter.site_code} ${matter.shop || ''} ${skuText}`.toUpperCase();
      return hay.includes(q);
    });
  }

  function render() {
    const list = $('om_ds_list');
    if (!list) return;
    const rows = filteredMatters();
    const totalSku = matters.reduce((sum, m) => sum + Number(m.item_count || 0), 0);
    const pendingMatters = matters.filter((m) => m.status === 'pending' && m.is_open).length;
    if ($('om_ds_info')) {
      const site = $('om_ds_site')?.value || '';
      const scope = site ? om().storeLabel(site) : '全部管轄店舖';
      $('om_ds_info').innerHTML = `<div class="site-banner">${esc(scope)}</div>
        <div>共 ${matters.length} 個事項（${totalSku} 個 SKU）｜<b class="${pendingMatters ? 'ds-pending-count' : ''}">${pendingMatters} 個事項未回覆</b></div>`;
    }
    if (!rows.length) {
      list.innerHTML = `<div class="empty" style="padding:36px 16px">${matters.length ? '沒有符合條件的事項 — 試下轉狀態、店舖或清空搜尋字。' : '目前沒有指定 SKU 事項。'}</div>`;
      return;
    }
    list.innerHTML = rows.map((matter) => {
      const closed = !matter.is_open;
      const replied = matter.status === 'replied';
      const label = closed ? '查看回覆' : replied ? '修改代覆' : 'OM 代覆';
      const facts = [
        `<b>${matter.item_count}</b> 個 SKU`,
        `批次 <span class="ds-code">${esc(matter.batch_code)}</span>`,
        matter.due_at ? `截止 <b>${esc(matter.due_at)}</b>（香港時間）` : '',
        matter.reference ? `參考 ${esc(matter.reference)}` : '',
      ].filter(Boolean).join('<span class="ds-sep">｜</span>');
      const skuRows = (matter.items || []).map((item) => `
        <div class="ds-sku-line">
          <div class="ds-sku-line-id"><b class="ds-code">${esc(item.sku)}</b><span>${esc(item.description || '')}</span></div>
          <div class="ds-sku-line-stock">存貨 ${esc(fmtStock(item.stock_qty))}</div>
          <div class="ds-sku-line-reply">${itemSummary(item)}</div>
        </div>`).join('');
      return `<article class="ds-matter${closed ? ' ds-matter--closed' : replied ? ' ds-matter--replied' : ' ds-matter--pending'}">
        <div class="ds-matter-head">
          <div class="ds-matter-head-left">
            ${matterStatusBadge(matter)}
            <span class="om-matter-store">${esc(matter.site_code)}</span>
            <span class="om-matter-shop">${esc(matter.shop || '')}</span>
            <span class="ds-code ds-matter-code">${esc(matter.matter_code)}</span>
          </div>
          <button class="btn ghost btn-sm ds-open" type="button" data-om-ds-open="${esc(matter.matter_code)}"${!closed && !replied ? ' aria-label="此事項仍需要回覆"' : ''}>${label}</button>
        </div>
        <h3 class="ds-matter-title">${esc(matter.subject)}</h3>
        <div class="ds-matter-facts">${facts}</div>
        <div class="ds-sku-list">${skuRows}</div>
        ${matter.instructions ? `<div class="ds-instructions">${esc(matter.instructions).replace(/\n/g, '<br>')}</div>` : ''}
      </article>`;
    }).join('');
    list.querySelectorAll('[data-om-ds-open]').forEach((btn) => {
      btn.addEventListener('click', () => openMatter(btn.dataset.omDsOpen));
    });
  }

  async function load() {
    if (!om()) return;
    const params = new URLSearchParams();
    const site = $('om_ds_site')?.value || '';
    if (site) params.set('site_code', site);
    const status = $('om_ds_status')?.value || '';
    if (status) params.set('status', status);
    const q = ($('om_ds_search')?.value || '').trim();
    if (q) params.set('q', q);
    try {
      const data = await om().api(`/api/portal/om/designated-sku/matters${params.toString() ? `?${params}` : ''}`);
      matters = data.matters || [];
      render();
      om().showAlert($('om_ds_error'), '', '');
    } catch (err) {
      showError(err.message);
      if ($('om_ds_list')) $('om_ds_list').innerHTML = `<div class="empty" style="padding:28px">載入失敗：${esc(err.message)}</div>`;
    }
  }

  /* ---------------- 年期工具（與店舖版相同規則 MMYY） ---------------- */

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

  function addLine(wrap, line = {}) {
    if (wrap.querySelectorAll('[data-line]').length >= MAX_LINES) return;
    const row = document.createElement('div');
    row.className = 'ds-line';
    row.setAttribute('data-line', '');
    row.innerHTML = `
      <input class="ds-year" type="text" inputmode="numeric" autocomplete="off" maxlength="5"
             placeholder="0827" aria-label="貨品年期 MMYY" value="${line.year_code ? esc(line.year_code) : ''}">
      <input class="ds-qty" type="number" inputmode="numeric" min="1" max="${MAX_QTY}" step="1"
             placeholder="1" aria-label="可調撥件數" value="${line.qty ? esc(String(line.qty)) : ''}">
      <button class="ds-remove" type="button" aria-label="移除這一個年期">✕</button>`;
    wrap.appendChild(row);
    row.querySelector('.ds-remove').addEventListener('click', () => {
      if (wrap.querySelectorAll('[data-line]').length <= 1) {
        row.querySelector('.ds-year').value = '';
        row.querySelector('.ds-qty').value = '';
      } else {
        row.remove();
      }
      updateSectionTotal(row.closest('[data-item]'));
    });
    row.querySelectorAll('input').forEach((input) => input.addEventListener('input', () => updateSectionTotal(row.closest('[data-item]'))));
  }

  function sectionLines(section) {
    return Array.from(section.querySelectorAll('[data-line]'));
  }

  function sectionTotal(section) {
    let total = 0;
    for (const row of sectionLines(section)) {
      const qty = Number(row.querySelector('.ds-qty').value);
      if (Number.isFinite(qty) && qty > 0) total += qty;
    }
    return total;
  }

  function updateSectionTotal(section) {
    if (!section || !currentMatter) return;
    const item = (currentMatter.items || []).find((it) => it.id === section.dataset.item);
    if (!item) return;
    const box = section.querySelector('.ds-sku-total');
    const stock = item.stock_qty === null || item.stock_qty === undefined ? null : Number(item.stock_qty);
    const noTransfer = section.querySelector('.ds-no-transfer').checked;
    if (noTransfer) {
      box.classList.remove('ds-total--over');
      box.innerHTML = '無可調撥件數（合計 0 件）';
    } else {
      const total = sectionTotal(section);
      const over = stock !== null && total > stock;
      box.classList.toggle('ds-total--over', over);
      box.innerHTML = `合計 <b>${total}</b> 件${stock !== null ? `｜存貨 <b>${stock}</b> 件` : ''}`
        + (over ? ` <span class="ds-over">超出 ${total - stock} 件，請調整</span>` : (stock !== null && total < stock ? ` <span class="hint">其餘 ${stock - total} 件未填</span>` : ''));
    }
    updateOverallTotal();
  }

  function updateOverallTotal() {
    if (!currentMatter) return;
    let total = 0;
    const sections = Array.from($('om_ds_sections').querySelectorAll('[data-item]'));
    for (const section of sections) {
      if (!section.querySelector('.ds-no-transfer').checked) total += sectionTotal(section);
    }
    if ($('om_ds_summary')) {
      $('om_ds_summary').innerHTML = `${currentMatter.item_count} 個 SKU｜合計 <b>${total}</b> 件`;
    }
  }

  function setNoTransfer(section, on) {
    const editor = section.querySelector('.ds-editor');
    const checkbox = section.querySelector('.ds-no-transfer');
    checkbox.checked = on;
    if (on) {
      editor.hidden = true;
      section.classList.add('is-no-transfer');
    } else {
      editor.hidden = false;
      section.classList.remove('is-no-transfer');
      if (!sectionLines(section).length) addLine(section.querySelector('.ds-lines'), {});
    }
    updateSectionTotal(section);
  }

  function buildSkuSection(item) {
    const section = document.createElement('section');
    section.className = 'ds-sku';
    section.setAttribute('data-item', item.id);
    const isNoTransfer = item.no_transfer === true;

    section.innerHTML = `
      <div class="ds-sku-head">
        <div class="ds-sku-id"><b class="ds-code">${esc(item.sku)}</b><span>${esc(item.description || '')}</span></div>
        <div class="ds-sku-stock">存貨 <b>${esc(fmtStock(item.stock_qty))}</b></div>
      </div>
      <div class="ds-editor">
        <div class="ds-lines-head" aria-hidden="true"><span>貨品年期 (MMYY)</span><span>可調撥件數</span><span></span></div>
        <div class="ds-lines"></div>
        <button class="btn ghost btn-sm ds-add-line" type="button">＋ 新增年期</button>
      </div>
      <label class="ds-none"><input type="checkbox" class="ds-no-transfer"> 此 SKU 無可調撥件數</label>
      <div class="ds-total ds-sku-total"></div>
      <label class="ds-sku-note-label" for="om_ds_note_${esc(item.id)}">此 SKU 備註（選填）</label>
      <input class="ds-sku-note" id="om_ds_note_${esc(item.id)}" type="text" maxlength="2000" placeholder="例如：陳列品、包裝破損…" value="${esc(item.reply_note || '')}">
    `;

    const wrap = section.querySelector('.ds-lines');
    if (readOnly) {
      section.innerHTML = `
        <div class="ds-sku-head">
          <div class="ds-sku-id"><b class="ds-code">${esc(item.sku)}</b><span>${esc(item.description || '')}</span></div>
          <div class="ds-sku-stock">存貨 <b>${esc(fmtStock(item.stock_qty))}</b></div>
        </div>
        <div class="ds-sku-readonly">${item.status !== 'replied'
          ? '<span class="ds-line-pending">店舖未提交回覆（已截止）</span>'
          : (item.no_transfer
            ? '<span class="ds-line-none">無可調撥件數</span>'
            : `${(item.lines || []).map((line) => `<span class="ds-chip"><b>${esc(line.year_code)}</b> × ${esc(String(line.qty))}</span>`).join(' ')}<span class="ds-total-inline">合計 <b>${item.reply_total ?? 0}</b> 件</span>`)}</div>
        ${item.reply_note ? `<div class="hint">備註：${esc(item.reply_note)}</div>` : ''}`;
      return section;
    }

    (item.lines && item.lines.length ? item.lines : [{}]).forEach((line) => addLine(wrap, line));
    section.querySelector('.ds-add-line').addEventListener('click', () => {
      addLine(wrap, {});
      updateSectionTotal(section);
    });
    const checkbox = section.querySelector('.ds-no-transfer');
    checkbox.checked = isNoTransfer;
    checkbox.addEventListener('change', () => setNoTransfer(section, checkbox.checked));
    if (isNoTransfer) setNoTransfer(section, true);
    else updateSectionTotal(section);
    return section;
  }

  function openMatter(code) {
    const matter = matters.find((m) => m.matter_code === code);
    if (!matter) return;
    currentMatter = matter;
    readOnly = !matter.is_open;
    const title = readOnly
      ? `事項回覆（已截止） — ${matter.matter_code}`
      : matter.status === 'replied' ? `修改代覆 — ${matter.matter_code}` : `OM 代覆 — ${matter.matter_code}`;
    if ($('om_ds_dialog_title')) $('om_ds_dialog_title').textContent = title;
    if ($('om_ds_dialog_info')) {
      $('om_ds_dialog_info').textContent = `${matter.site_code} ${matter.shop || ''}｜${matter.subject}｜批次 ${matter.batch_code}`;
    }
    if ($('om_ds_dialog_sub')) {
      $('om_ds_dialog_sub').textContent = `${matter.item_count} 個 SKU`
        + (matter.due_at ? `｜截止 ${matter.due_at}（香港時間）` : '')
        + (matter.reference ? `｜參考 ${matter.reference}` : '');
    }
    const notice = $('om_ds_notice');
    if (notice) {
      if (readOnly) {
        notice.hidden = false;
        notice.className = 'ds-notice ds-notice--closed';
        notice.innerHTML = matter.is_expired
          ? `此事項已過截止時間（${esc(matter.due_at || '')}），只供查閱，不能再提交回覆。如需補交請聯絡 RP Team。`
          : '此事項已截止，只供查閱，不能再修改回覆。如需更正請聯絡 RP Team。';
      } else if (matter.instructions) {
        notice.hidden = false;
        notice.className = 'ds-notice';
        notice.innerHTML = `<b>事項說明</b><div>${esc(matter.instructions).replace(/\n/g, '<br>')}</div>`;
      } else {
        notice.hidden = true;
        notice.innerHTML = '';
      }
    }

    const wrap = $('om_ds_sections');
    if (!wrap) return;
    wrap.innerHTML = '';
    (matter.items || []).forEach((item) => wrap.appendChild(buildSkuSection(item)));
    if ($('om_ds_summary')) $('om_ds_summary').hidden = readOnly;
    if ($('om_ds_save')) {
      $('om_ds_save').hidden = readOnly;
      $('om_ds_save').disabled = false;
      $('om_ds_save').textContent = '儲存代覆';
    }
    om().showAlert($('om_ds_reply_error'), '', '');
    updateOverallTotal();
    $('om_ds_dialog')?.showModal();
    if (!readOnly) {
      const firstYear = wrap.querySelector('.ds-year');
      if (firstYear) setTimeout(() => firstYear.focus(), 60);
    }
  }

  /* ---------------- 提交 ---------------- */

  function collectSectionLines(section, sku) {
    const out = [];
    const seen = new Set();
    for (const row of sectionLines(section)) {
      const yearRaw = row.querySelector('.ds-year').value.trim();
      const qtyRaw = row.querySelector('.ds-qty').value.trim();
      if (!yearRaw && !qtyRaw) continue;
      if (!yearRaw) throw new Error(`SKU ${sku}：請填寫貨品年期（MMYY）`);
      if (!qtyRaw) throw new Error(`SKU ${sku}：年期「${yearRaw}」請填寫可調撥件數`);
      const year = normalizeYear(yearRaw);
      if (!year) throw new Error(`SKU ${sku}：年期「${yearRaw}」格式不正確，請填 MMYY（例：0827）`);
      if (seen.has(year)) throw new Error(`SKU ${sku}：年期 ${year} 重複，請合併為一行`);
      seen.add(year);
      const qty = Number(qtyRaw);
      if (!Number.isInteger(qty) || qty < 1) throw new Error(`SKU ${sku}：年期 ${year} 的件數必須為 1 或以上的整數`);
      if (qty > MAX_QTY) throw new Error(`SKU ${sku}：年期 ${year} 的件數不可超過 ${MAX_QTY}`);
      out.push({ year_code: year, qty });
    }
    if (!out.length) throw new Error(`SKU ${sku}：請填寫至少一個年期，或勾選「無可調撥件數」`);
    return out;
  }

  function collectItems() {
    return Array.from($('om_ds_sections').querySelectorAll('[data-item]')).map((section) => {
      const item = (currentMatter.items || []).find((it) => it.id === section.dataset.item);
      const sku = item ? item.sku : '—';
      const noTransfer = section.querySelector('.ds-no-transfer').checked;
      const note = (section.querySelector('.ds-sku-note')?.value || '').trim();
      if (noTransfer) return { item_id: section.dataset.item, lines: [], note, no_transfer: true };
      return { item_id: section.dataset.item, lines: collectSectionLines(section, sku), note, no_transfer: false };
    });
  }

  async function saveReply() {
    if (!currentMatter || readOnly || saving) return;
    const btn = $('om_ds_save');
    let items;
    try {
      items = collectItems();
      om().showAlert($('om_ds_reply_error'), '', '');
    } catch (err) {
      om().showAlert($('om_ds_reply_error'), 'error', esc(err.message));
      return;
    }
    saving = true;
    if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
    try {
      const data = await om().api(`/api/portal/om/designated-sku/matters/${encodeURIComponent(currentMatter.matter_code)}/reply`, {
        method: 'PUT',
        body: JSON.stringify({ items }),
      });
      const idx = matters.findIndex((m) => m.matter_code === data.matter.matter_code);
      if (idx >= 0) matters[idx] = data.matter;
      $('om_ds_dialog')?.close();
      await load();
      om().refreshOverview();
      om().showAlert($('om_ds_error'), 'success',
        `已代 ${esc(data.matter.site_code)} 儲存 <b>${esc(data.matter.matter_code)}</b> 的回覆（${data.matter.item_count} 個 SKU，合計 ${data.matter.reply_total} 件）。`);
    } catch (err) {
      if (err.status === 409 && err.data?.code === 'MATTER_CLOSED') {
        $('om_ds_dialog')?.close();
        await load();
        showError(err.message);
        return;
      }
      om().showAlert($('om_ds_reply_error'), 'error', esc(err.message));
    } finally {
      saving = false;
      if (btn) { btn.disabled = false; btn.textContent = '儲存代覆'; }
    }
  }

  function bind() {
    $('om_ds_refresh')?.addEventListener('click', () => load());
    $('om_ds_site')?.addEventListener('change', () => load());
    $('om_ds_status')?.addEventListener('change', () => load());
    $('om_ds_search')?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(), 350);
    });
    $('om_ds_cancel')?.addEventListener('click', () => $('om_ds_dialog')?.close());
    $('om_ds_save')?.addEventListener('click', saveReply);
  }

  bind();
  window.omDesignatedSku = { load };
})();
