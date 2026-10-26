/* Store 指定 SKU 回覆：只顯示屬於本店 Site Code 的事項（後端強制隔離）
   一個事項可包含多個 SKU，店舖一次過回覆整份清單。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const p = window.portal;

  let matters = [];
  let currentMatter = null;
  let readOnly = false;
  let saving = false;
  /** 頁面帶 ?matter=CODE 時，載入後自動開啟該事項（直 link） */
  let wantedMatterCode = '';

  const MAX_LINES = 20;
  const MAX_QTY = 9999;

  /* ---------------- 工具 ---------------- */

  function fmtStock(value) {
    return value === null || value === undefined ? '未提供' : `${value} 件`;
  }

  function matterStatusBadge(matter) {
    if (!matter.is_open) {
      return matter.status === 'replied'
        ? '<span class="badge-archived">已回覆 · 已截止</span>'
        : '<span class="badge-archived">未回覆 · 已截止</span>';
    }
    return matter.status === 'replied'
      ? '<span class="badge-replied">已回覆</span>'
      : '<span class="badge-pending">未回覆</span>';
  }

  function itemSummary(item) {
    if (item.status !== 'replied') return '<span class="ds-line-pending">未回覆</span>';
    if (item.no_transfer) return '<span class="ds-line-none">無可調撥</span>';
    const chips = (item.lines || [])
      .map((l) => `<span class="ds-chip"><b>${p.escapeHtml(l.year_code)}</b> × ${p.escapeHtml(String(l.qty))}</span>`)
      .join(' ');
    return `${chips}<span class="ds-total-inline">合計 <b>${item.reply_total ?? 0}</b> 件</span>`;
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

  async function loadMatters() {
    const list = $('ds_list');
    try {
      const data = await p.api('/api/portal/designated-sku/matters');
      matters = data.matters || [];
      const skuCount = matters.reduce((sum, m) => sum + m.item_count, 0);
      $('ds_site_info').innerHTML =
        `<div class="site-banner">${p.escapeHtml(data.site_code)}${data.shop ? ` ${p.escapeHtml(data.shop)}` : ''}</div>` +
        `<div>共 ${matters.length} 個事項（${skuCount} 個 SKU）${data.pending_count ? `｜<b class="ds-pending-count">${data.pending_count} 個事項未回覆</b>` : '｜全部已回覆'}</div>`;
      render();
      if (wantedMatterCode) {
        const code = wantedMatterCode;
        wantedMatterCode = '';
        await openByCode(code);
      }
      setPageError('');
    } catch (err) {
      list.innerHTML = '<div class="empty" style="padding:28px">暫時無法載入事項，請按「重新整理」再試。</div>';
      setPageError(p.escapeHtml(err.message));
    }
  }

  function filteredMatters() {
    const q = ($('ds_search').value || '').trim().toUpperCase();
    const status = $('ds_status').value;
    return matters.filter((matter) => {
      if (status && matter.status !== status) return false;
      if (!q) return true;
      const skuText = (matter.items || []).map((it) => `${it.sku} ${it.description || ''}`).join(' ');
      const hay = `${matter.matter_code} ${matter.batch_code} ${matter.subject} ${skuText}`.toUpperCase();
      return hay.includes(q);
    });
  }

  function render() {
    const list = $('ds_list');
    const rows = filteredMatters();
    if (!rows.length) {
      const any = matters.length > 0;
      list.innerHTML = `<div class="empty" style="padding:36px 16px">${any ? '沒有符合條件的事項 — 試下轉「狀態」或清空搜尋字。' : '目前沒有指定 SKU 事項。有新事項時會在這裡顯示。'}</div>`;
      return;
    }
    list.innerHTML = rows.map((matter) => {
      const closed = !matter.is_open;
      const replied = matter.status === 'replied';
      const label = closed ? '查看回覆' : replied ? '修改回覆' : '回覆';
      const facts = [
        `<b>${matter.item_count}</b> 個 SKU`,
        `批次 <span class="ds-code">${p.escapeHtml(matter.batch_code)}</span>`,
        matter.due_date ? `截止 <b>${p.escapeHtml(matter.due_date)}</b>` : '',
        matter.reference ? `參考 ${p.escapeHtml(matter.reference)}` : '',
      ].filter(Boolean).join('<span class="ds-sep">｜</span>');
      const skuRows = (matter.items || []).map((item) => `
        <div class="ds-sku-line">
          <div class="ds-sku-line-id"><b class="ds-code">${p.escapeHtml(item.sku)}</b><span>${p.escapeHtml(item.description || '')}</span></div>
          <div class="ds-sku-line-stock">存貨 ${p.escapeHtml(fmtStock(item.stock_qty))}</div>
          <div class="ds-sku-line-reply">${itemSummary(item)}</div>
        </div>`).join('');
      return `<article class="ds-matter${closed ? ' ds-matter--closed' : replied ? ' ds-matter--replied' : ' ds-matter--pending'}">
        <div class="ds-matter-head">
          <div class="ds-matter-head-left">${matterStatusBadge(matter)}<span class="ds-code ds-matter-code">${p.escapeHtml(matter.matter_code)}</span></div>
          <button class="btn ghost btn-sm ds-open" type="button" data-open="${p.escapeHtml(matter.matter_code)}"${!closed && !replied ? ' aria-label="此事項仍需要回覆"' : ''}>${label}</button>
        </div>
        <h3 class="ds-matter-title">${p.escapeHtml(matter.subject)}</h3>
        <div class="ds-matter-facts">${facts}</div>
        <div class="ds-sku-list">${skuRows}</div>
        ${matter.instructions ? `<div class="ds-instructions">${p.escapeHtml(matter.instructions).replace(/\n/g, '<br>')}</div>` : ''}
      </article>`;
    }).join('');
    list.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openMatter(btn.dataset.open));
    });
  }

  /* ---------------- 回覆彈窗（多個 SKU） ---------------- */

  function addLine(wrap, line = {}) {
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
    if (!section) return;
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
      box.innerHTML = `合計 <b>${total}</b> 件${stock !== null ? `｜存貨 <b>${stock}</b> 件` : ''}` +
        (over ? ` <span class="ds-over">超出 ${total - stock} 件，請調整</span>` : (stock !== null && total < stock ? ` <span class="hint">其餘 ${stock - total} 件未填</span>` : ''));
    }
    updateOverallTotal();
  }

  function updateOverallTotal() {
    if (!currentMatter) return;
    let total = 0;
    const sections = Array.from($('ds_sku_sections').querySelectorAll('[data-item]'));
    for (const section of sections) {
      if (!section.querySelector('.ds-no-transfer').checked) total += sectionTotal(section);
    }
    $('ds_reply_summary').innerHTML = `${currentMatter.item_count} 個 SKU｜合計 <b>${total}</b> 件`;
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
    const stock = item.stock_qty === null || item.stock_qty === undefined ? null : Number(item.stock_qty);
    const isNoTransfer = item.no_transfer === true;

    section.innerHTML = `
      <div class="ds-sku-head">
        <div class="ds-sku-id"><b class="ds-code">${p.escapeHtml(item.sku)}</b><span>${p.escapeHtml(item.description || '')}</span></div>
        <div class="ds-sku-stock">存貨 <b>${p.escapeHtml(fmtStock(item.stock_qty))}</b></div>
      </div>
      <div class="ds-editor">
        <div class="ds-lines-head" aria-hidden="true"><span>貨品年期 (MMYY)</span><span>可調撥件數</span><span></span></div>
        <div class="ds-lines"></div>
        <button class="btn ghost btn-sm ds-add-line" type="button">＋ 新增年期</button>
      </div>
      <label class="ds-none"><input type="checkbox" class="ds-no-transfer"> 此 SKU 無可調撥件數</label>
      <div class="ds-total ds-sku-total"></div>
      <label class="ds-sku-note-label" for="ds_note_${p.escapeHtml(item.id)}">此 SKU 備註（選填）</label>
      <input class="ds-sku-note" id="ds_note_${p.escapeHtml(item.id)}" type="text" maxlength="2000" placeholder="例如：陳列品、包裝破損…" value="${p.escapeHtml(item.reply_note || '')}">
    `;

    const wrap = section.querySelector('.ds-lines');
    if (readOnly) {
      // 只供查閱：顯示靜態年期，不提供輸入
      section.innerHTML = `
        <div class="ds-sku-head">
          <div class="ds-sku-id"><b class="ds-code">${p.escapeHtml(item.sku)}</b><span>${p.escapeHtml(item.description || '')}</span></div>
          <div class="ds-sku-stock">存貨 <b>${p.escapeHtml(fmtStock(item.stock_qty))}</b></div>
        </div>
        <div class="ds-sku-readonly">${item.status !== 'replied'
          ? '<span class="ds-line-pending">店舖未提交回覆（已截止）</span>'
          : (item.no_transfer
            ? '<span class="ds-line-none">無可調撥件數</span>'
            : `${(item.lines || []).map((l) => `<span class="ds-chip"><b>${p.escapeHtml(l.year_code)}</b> × ${p.escapeHtml(String(l.qty))}</span>`).join(' ')}<span class="ds-total-inline">合計 <b>${item.reply_total ?? 0}</b> 件</span>`)}</div>
        ${item.reply_note ? `<div class="hint">備註：${p.escapeHtml(item.reply_note)}</div>` : ''}`;
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
    $('ds_reply_title').textContent = readOnly
      ? `事項回覆（已截止） — ${matter.matter_code}`
      : matter.status === 'replied' ? `修改回覆 — ${matter.matter_code}` : `回覆事項 — ${matter.matter_code}`;
    $('ds_reply_matter').textContent = `${matter.subject}｜批次 ${matter.batch_code}`;
    $('ds_reply_sub').textContent = `${matter.item_count} 個 SKU` +
      (matter.due_date ? `｜截止 ${matter.due_date}` : '') +
      (matter.reference ? `｜參考 ${matter.reference}` : '');

    const notice = $('ds_reply_notice');
    if (readOnly) {
      notice.hidden = false;
      notice.className = 'ds-notice ds-notice--closed';
      notice.innerHTML = '此事項已截止，只供查閱，不能再修改回覆。如需更正請聯絡 RP Team。';
    } else if (matter.instructions) {
      notice.hidden = false;
      notice.className = 'ds-notice';
      notice.innerHTML = `<b>事項說明</b><div>${p.escapeHtml(matter.instructions).replace(/\n/g, '<br>')}</div>`;
    } else {
      notice.hidden = true;
      notice.innerHTML = '';
    }

    const wrap = $('ds_sku_sections');
    wrap.innerHTML = '';
    (matter.items || []).forEach((item) => wrap.appendChild(buildSkuSection(item)));

    $('ds_reply_summary').hidden = readOnly;
    $('ds_save').hidden = readOnly;
    $('ds_save').disabled = false;
    $('ds_save').textContent = '儲存回覆';
    p.showAlert($('ds_reply_error'), '', '');
    updateOverallTotal();
    $('ds_reply_dialog').showModal();
    if (!readOnly) {
      const firstYear = wrap.querySelector('.ds-year');
      if (firstYear) setTimeout(() => firstYear.focus(), 60);
    }
  }

  /** 直 link：先在本店清單找；找不到再向伺服器查（會被 403 / 404 擋） */
  async function openByCode(code) {
    const local = matters.find((m) => m.matter_code === code);
    if (local) {
      openMatter(code);
      return;
    }
    try {
      const data = await p.api(`/api/portal/designated-sku/matters/${encodeURIComponent(code)}`);
      matters = [data.matter, ...matters];
      render();
      openMatter(data.matter.matter_code);
    } catch (err) {
      if (err.status === 403) {
        setPageError(`<b>此事項不屬於你店舖。</b>${p.escapeHtml(err.message)}<div class="hint" style="margin-top:4px">如你剛登入其他店舖，請按「登出」再以正確 Site Code 進入。</div>`);
      } else if (err.status === 404) {
        setPageError(`<b>找不到事項 ${p.escapeHtml(code)}。</b>可能已被 RP Team 刪除，或連結有誤。`);
      } else {
        setPageError(p.escapeHtml(err.message));
      }
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
    return Array.from($('ds_sku_sections').querySelectorAll('[data-item]')).map((section) => {
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
    const btn = $('ds_save');
    let items;
    try {
      items = collectItems();
      p.showAlert($('ds_reply_error'), '', '');
    } catch (err) {
      p.showAlert($('ds_reply_error'), 'error', p.escapeHtml(err.message));
      return;
    }
    saving = true;
    btn.disabled = true;
    btn.textContent = '儲存中…';
    try {
      const data = await p.api(`/api/portal/designated-sku/matters/${encodeURIComponent(currentMatter.matter_code)}/reply`, {
        method: 'PUT',
        body: JSON.stringify({ items }),
      });
      const idx = matters.findIndex((m) => m.matter_code === data.matter.matter_code);
      if (idx >= 0) matters[idx] = data.matter;
      $('ds_reply_dialog').close();
      render();
      await loadMatters();
      p.showAlert($('ds_list_error'), 'success', `已儲存 <b>${p.escapeHtml(data.matter.matter_code)}</b> 的回覆（${data.matter.item_count} 個 SKU，合計 ${data.matter.reply_total} 件）。如發現輸入有誤，可在截止前再修改。`);
    } catch (err) {
      if (err.status === 409 && err.data?.code === 'MATTER_CLOSED') {
        $('ds_reply_dialog').close();
        await loadMatters();
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
      await loadMatters();
    } catch (err) {
      setPageError(p.escapeHtml(err.message));
    }
  });
  $('ds_status').addEventListener('change', render);
  $('ds_search').addEventListener('input', render);
  $('ds_cancel').addEventListener('click', () => $('ds_reply_dialog').close());
  $('ds_save').addEventListener('click', saveReply);
  $('logout_link').addEventListener('click', (e) => { e.preventDefault(); p.logout(); });

  (async () => {
    try {
      const params = new URLSearchParams(window.location.search);
      wantedMatterCode = (params.get('matter') || '').trim();
      // 兼容舊連結：?task= 自動轉為 ?matter=
      if (!wantedMatterCode && params.get('task')) {
        wantedMatterCode = params.get('task').trim();
        params.delete('task');
        params.set('matter', wantedMatterCode);
        history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
      }
    } catch {
      wantedMatterCode = '';
    }
    let site;
    try {
      site = await p.ensureStoreSite();
    } catch {
      return;
    }
    $('store_header').textContent = `指定 SKU 回覆 — ${site}`;
    await loadMatters();
  })();
})();
