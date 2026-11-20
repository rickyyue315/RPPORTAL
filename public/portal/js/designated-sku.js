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

  /** Safety 調整模式（reply_mode = 'safety'） */
  const SAFETY_AGREE = '同意';
  const SAFETY_DISAGREE = '不同意';

  /** 目前開啟事項的回覆設定（由批次帶落嚟） */
  let currentFields = [];
  let currentMode = 'stock_year';
  let currentScope = 'item';

  /* ---------------- 工具 ---------------- */

  /** 數字顯示：空白顯示「—」，可指定小數位；非數字原樣顯示 */
  function numText(raw, digits = 0) {
    const text = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!text) return '—';
    const n = Number(text.replace(/,/g, ''));
    if (!Number.isFinite(n)) return p.escapeHtml(text);
    return digits ? n.toFixed(digits) : String(Math.round(n));
  }

  function safetyDelta(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { text: '—', cls: '' };
    const n = Number(text.replace(/,/g, ''));
    if (!Number.isFinite(n)) return { text: p.escapeHtml(text), cls: '' };
    const rounded = Math.round(n);
    if (rounded > 0) return { text: `+${rounded}`, cls: 'ds-sf-up' };
    if (rounded < 0) return { text: String(rounded), cls: 'ds-sf-down' };
    return { text: '0', cls: '' };
  }

  function fmtStock(value) {
    return value === null || value === undefined ? '未提供' : `${value} 件`;
  }

  function matterStatusBadge(matter) {
    if (!matter.is_open) {
      if (matter.status === 'replied') return '<span class="badge-archived">已回覆 · 已截止</span>';
      return matter.is_expired
        ? '<span class="badge-archived">未回覆 · 已過截止</span>'
        : '<span class="badge-archived">未回覆 · 已截止</span>';
    }
    return matter.status === 'replied'
      ? '<span class="badge-replied">已回覆</span>'
      : '<span class="badge-pending">未回覆</span>';
  }

  function itemSummary(item, matter) {
    if (item.status !== 'replied') return '<span class="ds-line-pending">未回覆</span>';
    const mode = (matter && matter.reply_mode) || 'stock_year';
    const fields = (matter && matter.reply_fields) || [];
    if (mode === 'safety') {
      const values = item.reply_values || {};
      if (values.f1 === SAFETY_DISAGREE) {
        const bits = ['<span class="ds-sf-chip ds-sf-chip--no">不同意</span>'];
        if (values.f2) bits.push(`<span class="ds-cf-chip">原因 <b>${p.escapeHtml(values.f2)}</b></span>`);
        if (values.f3) bits.push(`<span class="ds-cf-chip">新 Safety <b>${p.escapeHtml(values.f3)}</b></span>`);
        return bits.join(' ');
      }
      return '<span class="ds-sf-chip ds-sf-chip--yes">同意</span>';
    }
    if (mode === 'custom') {
      const values = (item.reply_values || {});
      const parts = fields
        .filter((f) => values[f.key])
        .map((f) => `<span class="ds-cf-chip">${p.escapeHtml(f.label)} <b>${p.escapeHtml(values[f.key])}</b></span>`);
      return parts.length ? parts.join(' ') : '<span class="ds-line-none">已回覆</span>';
    }
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
      const skuCount = matters.reduce((sum, m) => sum + (m.reply_scope === 'matter' ? 0 : m.item_count), 0);
      const shopLevelCount = matters.filter((m) => m.reply_scope === 'matter').length;
      const parts = [];
      if (skuCount) parts.push(`${skuCount} 個 SKU`);
      if (shopLevelCount) parts.push(`${shopLevelCount} 個全店回覆事項`);
      $('ds_site_info').innerHTML =
        `<div class="site-banner">${p.escapeHtml(data.site_code)}${data.shop ? ` ${p.escapeHtml(data.shop)}` : ''}</div>` +
        `<div>共 ${matters.length} 個事項${parts.length ? `（${parts.join('｜')}）` : ''}${data.pending_count ? `｜<b class="ds-pending-count">${data.pending_count} 個事項未回覆</b>` : '｜全部已回覆'}</div>`;
      // 說明文字按實際模式切換：只有 Safety 事項就收起年期／自定欄位那段
      const hasSafety = matters.some((m) => m.reply_mode === 'safety');
      const hasOther = matters.some((m) => m.reply_mode !== 'safety');
      const introSafety = $('ds_intro_safety');
      const introDefault = $('ds_intro_default');
      if (introSafety) introSafety.hidden = !hasSafety;
      if (introDefault) introDefault.hidden = hasSafety && !hasOther;
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
      list.innerHTML = `<div class="empty" style="padding:36px 16px">${any ? '沒有符合條件的事項 — 試下轉「狀態」或清除搜尋字。' : '目前沒有指定 SKU 事項。有新事項時會在這裡顯示。'}</div>`;
      return;
    }
    list.innerHTML = rows.map((matter) => {
      const closed = !matter.is_open;
      const replied = matter.status === 'replied';
      const label = closed ? '查看回覆' : replied ? '修改回覆' : '回覆';
      const shopLevel = matter.reply_scope === 'matter';
      const safetyMode = matter.reply_mode === 'safety';
      const allItems = matter.items || [];
      // Safety 調整每店可達 40+ 行：列表只顯示頭 6 行，詳情在事項彈窗
      const visibleItems = safetyMode ? allItems.slice(0, 6) : allItems;
      const facts = [
        safetyMode ? '<b class="ds-sf-mode-tag">Safety 調整</b>' : '',
        shopLevel ? '<b>全店回覆一次</b>（不需逐個 SKU）' : `<b>${matter.item_count}</b> 個 SKU`,
        `批次 <span class="ds-code">${p.escapeHtml(matter.batch_code)}</span>`,
        matter.due_at ? `截止 <b>${p.escapeHtml(matter.due_at)}</b>（香港時間）` : '',
        matter.reference ? `參考 ${p.escapeHtml(matter.reference)}` : '',
      ].filter(Boolean).join('<span class="ds-sep">｜</span>');
      const skuRows = shopLevel ? '' : visibleItems.map((item) => {
        const stockText = safetyMode && item.safety
          ? `Safety ${numText(item.safety.safety_current)} → <b>${numText(item.safety.safety_recommend)}</b>`
          : `存貨 ${p.escapeHtml(fmtStock(item.stock_qty))}`;
        return `
        <div class="ds-sku-line">
          <div class="ds-sku-line-id"><b class="ds-code">${p.escapeHtml(item.sku)}</b><span>${p.escapeHtml(item.description || '')}</span></div>
          <div class="ds-sku-line-stock">${stockText}</div>
          <div class="ds-sku-line-reply">${itemSummary(item, matter)}</div>
        </div>`;
      }).join('') + (safetyMode && allItems.length > 6
        ? `<div class="ds-sku-more">…其餘 <b>${allItems.length - 6}</b> 個 SKU，按「${p.escapeHtml(label)}」查看全部</div>`
        : '');
      return `<article class="ds-matter${closed ? ' ds-matter--closed' : replied ? ' ds-matter--replied' : ' ds-matter--pending'}">
        <div class="ds-matter-head">
          <div class="ds-matter-head-left">${matterStatusBadge(matter)}<span class="ds-code ds-matter-code">${p.escapeHtml(matter.matter_code)}</span></div>
          <button class="btn ghost btn-sm ds-open" type="button" data-open="${p.escapeHtml(matter.matter_code)}"${!closed && !replied ? ' aria-label="此事項仍需要回覆"' : ''}>${label}</button>
        </div>
        <h3 class="ds-matter-title">${p.escapeHtml(matter.subject)}</h3>
        <div class="ds-matter-facts">${facts}${shopLevel && replied ? `<span class="ds-sep">｜</span>${itemSummary((matter.items || [])[0] || {}, matter)}` : ''}</div>
        ${skuRows ? `<div class="ds-sku-list">${skuRows}</div>` : ''}
        ${matter.instructions ? `<div class="ds-instructions">${p.escapeHtml(matter.instructions).replace(/\n/g, '<br>')}</div>` : ''}
      </article>`;
    }).join('');
    list.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openMatter(btn.dataset.open));
    });
  }

  /* ---------------- 回覆彈出視窗（多個 SKU） ---------------- */

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
    if (currentMode === 'safety') {
      updateSafetySummary();
      return;
    }
    if (currentMode === 'custom') {
      const inputs = Array.from($('ds_sku_sections').querySelectorAll('.ds-cf-input'));
      const filled = inputs.filter((el) => String(el.value || '').trim() !== '').length;
      const required = currentFields.filter((f) => f.required).length;
      const scopeText = currentScope === 'matter' ? '本店回覆' : `${currentMatter.item_count} 個 SKU`;
      $('ds_reply_summary').innerHTML = `${scopeText}｜已填 <b>${filled}</b> / ${inputs.length} 欄`
        + (required ? `｜其中 <b>${required}</b> 欄必填` : '');
      return;
    }
    let total = 0;
    const sections = Array.from($('ds_sku_sections').querySelectorAll('[data-item]'));
    for (const section of sections) {
      const skip = section.querySelector('.ds-no-transfer');
      if (!skip || !skip.checked) total += sectionTotal(section);
    }
    $('ds_reply_summary').innerHTML = `${currentMatter.item_count} 個 SKU｜合計 <b>${total}</b> 件`;
  }

  /* ---------------- 自定回覆欄位 ---------------- */

  function fieldInputHtml(field, value) {
    const v = value === null || value === undefined ? '' : String(value);
    const common = `class="ds-cf-input" data-field="${p.escapeHtml(field.key)}"`
      + ` aria-label="${p.escapeHtml(field.label)}"`
      + ` value="${p.escapeHtml(v)}"`;
    if (field.type === 'number') {
      return `<input ${common} type="number" min="0" step="any" inputmode="decimal" placeholder="${p.escapeHtml(field.hint || '')}">`;
    }
    if (field.type === 'choice') {
      const options = (field.options && field.options.length ? field.options : ['是', '否']);
      const selectAttr = `class="ds-cf-input" data-field="${p.escapeHtml(field.key)}" aria-label="${p.escapeHtml(field.label)}"`;
      return `<select ${selectAttr}>`
        + `<option value="">請選擇</option>`
        + options.map((o) => `<option value="${p.escapeHtml(o)}"${o === v ? ' selected' : ''}>${p.escapeHtml(o)}</option>`).join('')
        + `</select>`;
    }
    return `<input ${common} type="text" maxlength="300" placeholder="${p.escapeHtml(field.hint || '')}">`;
  }

  function fieldGridHtml(item) {
    if (!currentFields.length) return '';
    const values = (item && item.reply_values) || {};
    const cells = currentFields.map((field) => {
      const wide = field.type === 'text' && field.label.length > 16 ? ' ds-cf--wide' : '';
      return `<label class="ds-cf${wide}">
        <span class="ds-cf-label">${p.escapeHtml(field.label)}${field.required ? '<span class="ds-cf-req">*</span>' : ''}</span>
        ${fieldInputHtml(field, values[field.key])}
        ${field.hint ? `<small class="ds-cf-hint">${p.escapeHtml(field.hint)}</small>` : ''}
      </label>`;
    }).join('');
    return `<div class="ds-cf-grid">${cells}</div>`;
  }

  function fieldValuesReadonly(item) {
    const values = (item && item.reply_values) || {};
    const parts = currentFields
      .filter((f) => values[f.key])
      .map((f) => `<span class="ds-cf-chip">${p.escapeHtml(f.label)} <b>${p.escapeHtml(values[f.key])}</b></span>`);
    return parts.length ? parts.join(' ') : '<span class="ds-line-none">未填寫</span>';
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
    section.className = 'ds-sku' + (currentScope === 'matter' ? ' ds-sku--shop' : '');
    section.setAttribute('data-item', item.id);
    const isNoTransfer = item.no_transfer === true;

    const headHtml = currentScope === 'matter'
      ? `<div class="ds-sku-head">
          <div class="ds-sku-id"><b>本店回覆</b><span>適用於此事項的 ${currentMatter.item_count} 個 SKU</span></div>
        </div>`
      : `<div class="ds-sku-head">
          <div class="ds-sku-id"><b class="ds-code">${p.escapeHtml(item.sku)}</b><span>${p.escapeHtml(item.description || '')}</span></div>
          <div class="ds-sku-stock">存貨 <b>${p.escapeHtml(fmtStock(item.stock_qty))}</b></div>
        </div>`;

    if (readOnly) {
      // 只供查閱：自定欄位與年期一律顯示靜態值
      const linesHtml = currentMode === 'custom' ? '' : `<div class="ds-sku-readonly">${item.status !== 'replied'
        ? '<span class="ds-line-pending">店舖未提交回覆（已截止）</span>'
        : (item.no_transfer
          ? '<span class="ds-line-none">無可調撥件數</span>'
          : `${(item.lines || []).map((l) => `<span class="ds-chip"><b>${p.escapeHtml(l.year_code)}</b> × ${p.escapeHtml(String(l.qty))}</span>`).join(' ')}<span class="ds-total-inline">合計 <b>${item.reply_total ?? 0}</b> 件</span>`)}</div>`;
      section.innerHTML = headHtml
        + (currentFields.length ? `<div class="ds-cf-readonly">${fieldValuesReadonly(item)}</div>` : '')
        + linesHtml
        + (item.reply_note ? `<div class="hint">備註：${p.escapeHtml(item.reply_note)}</div>` : '');
      return section;
    }

    const linesBlock = currentMode === 'custom' ? '' : `
      <div class="ds-editor">
        <div class="ds-lines-head" aria-hidden="true"><span>貨品年期 (MMYY)</span><span>可調撥件數</span><span></span></div>
        <div class="ds-lines"></div>
        <button class="btn ghost btn-sm ds-add-line" type="button">＋ 新增年期</button>
      </div>
      <label class="ds-none"><input type="checkbox" class="ds-no-transfer"> 此 SKU 無可調撥件數</label>
      <div class="ds-total ds-sku-total"></div>`;

    section.innerHTML = headHtml + fieldGridHtml(item) + linesBlock + `
      <label class="ds-sku-note-label" for="ds_note_${p.escapeHtml(item.id)}">備註（選填）</label>
      <input class="ds-sku-note" id="ds_note_${p.escapeHtml(item.id)}" type="text" maxlength="2000" placeholder="例如：陳列品、包裝破損…" value="${p.escapeHtml(item.reply_note || '')}">
    `;

    if (currentFields.length) {
      section.querySelectorAll('.ds-cf-input').forEach((input) => {
        input.addEventListener('input', () => {
          input.classList.remove('is-invalid');
          updateOverallTotal();
        });
        input.addEventListener('change', updateOverallTotal);
      });
    }

    if (currentMode === 'custom') {
      updateOverallTotal();
      return section;
    }

    const wrap = section.querySelector('.ds-lines');
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

  /* ---------------- Safety 調整：逐行同意／不同意 ---------------- */

  /** 一行 = 一個 SKU；11 個顯示欄位 ＋ 回覆欄 */
  function safetyRowHtml(item) {
    const s = item.safety || {};
    const values = item.reply_values || {};
    const decision = values.f1 || '';
    const delta = safetyDelta(s.safety_change);
    const disabled = readOnly ? ' disabled' : '';
    let replyCell;
    if (readOnly) {
      if (!decision) {
        replyCell = '<span class="ds-line-pending">未回覆（已截止）</span>';
      } else if (decision === SAFETY_DISAGREE) {
        replyCell = `<div class="ds-sf-readonly"><span class="ds-sf-chip ds-sf-chip--no">不同意</span>`
          + (values.f2 ? `<div class="ds-sf-ro-line">原因：${p.escapeHtml(values.f2)}</div>` : '')
          + (values.f3 ? `<div class="ds-sf-ro-line">新 Safety：<b>${p.escapeHtml(values.f3)}</b></div>` : '')
          + '</div>';
      } else {
        replyCell = '<span class="ds-sf-chip ds-sf-chip--yes">同意</span>';
      }
    } else {
      replyCell = `<div class="ds-sf-btns" role="group" aria-label="SKU ${p.escapeHtml(item.sku)} 回覆">
          <button type="button" class="ds-sf-btn ds-sf-btn--yes${decision === SAFETY_AGREE ? ' is-on' : ''}" data-decision="${SAFETY_AGREE}" aria-pressed="${decision === SAFETY_AGREE}">${SAFETY_AGREE}</button>
          <button type="button" class="ds-sf-btn ds-sf-btn--no${decision === SAFETY_DISAGREE ? ' is-on' : ''}" data-decision="${SAFETY_DISAGREE}" aria-pressed="${decision === SAFETY_DISAGREE}">${SAFETY_DISAGREE}</button>
        </div>
        <div class="ds-sf-extra"${decision === SAFETY_DISAGREE ? '' : ' hidden'}>
          <input class="ds-sf-reason" type="text" maxlength="300" autocomplete="off" placeholder="原因（選填）" aria-label="SKU ${p.escapeHtml(item.sku)} 不同意原因" value="${p.escapeHtml(values.f2 || '')}">
          <label class="ds-sf-new"><span>新 Safety</span>
            <input class="ds-sf-newsafety" type="number" min="0" max="99999" step="1" inputmode="numeric" placeholder="選填" aria-label="SKU ${p.escapeHtml(item.sku)} 新 Safety 件數" value="${p.escapeHtml(values.f3 || '')}">
          </label>
        </div>`;
    }
    return `<tr data-sf-row data-item="${p.escapeHtml(item.id)}" data-sku="${p.escapeHtml(item.sku)}" data-decision="${p.escapeHtml(decision)}" class="${decision ? 'is-answered' : ''}${readOnly && !decision ? ' is-unanswered' : ''}">
      <td class="ds-sf-c-brand" title="${p.escapeHtml(s.brand || '')}">${p.escapeHtml(s.brand || '')}</td>
      <td class="ds-sf-c-sku"><b class="ds-code">${p.escapeHtml(item.sku)}</b></td>
      <td class="ds-sf-c-desc">${p.escapeHtml(s.description || item.description || '')}</td>
      <td class="ds-sf-c-issue"><span class="ds-sf-tag">${p.escapeHtml(s.issue_type || '—')}</span></td>
      <td class="ds-sf-c-method" title="${p.escapeHtml(s.suggestion || '')}"><div class="ds-sf-clamp">${p.escapeHtml(s.suggestion || '—')}</div></td>
      <td class="ds-sf-num">${numText(s.stock_qty)}</td>
      <td class="ds-sf-num">${numText(s.monthly_sold, 1)}</td>
      <td class="ds-sf-num">${numText(s.turnday, 1)}</td>
      <td class="ds-sf-num">${numText(s.safety_current)}</td>
      <td class="ds-sf-num ds-sf-num--rec">${numText(s.safety_recommend)}</td>
      <td class="ds-sf-num ${delta.cls}">${delta.text}</td>
      <td class="ds-sf-reply">${replyCell}</td>
    </tr>`;
  }

  function safetyTableHtml(matter) {
    const items = matter.items || [];
    return `<div class="ds-sf-wrap">
      <div class="ds-sf-toolbar">
        <div class="ds-sf-progress" id="ds_sf_progress" role="status"></div>
        ${readOnly ? '' : '<button type="button" class="btn ghost btn-sm" id="ds_sf_all_agree">全部同意</button>'}
      </div>
      <div class="ds-sf-scroll">
        <table class="ds-sf-table">
          <thead><tr>
            <th class="ds-sf-c-brand" scope="col">品牌</th>
            <th class="ds-sf-c-sku" scope="col">SKU</th>
            <th class="ds-sf-c-desc" scope="col">貨品描述</th>
            <th class="ds-sf-c-issue" scope="col">問題類型</th>
            <th class="ds-sf-c-method" scope="col">建議方法</th>
            <th class="ds-sf-num" scope="col">店舖存貨<br><span>（件）</span></th>
            <th class="ds-sf-num" scope="col">月均銷量<br><span>（P90D）</span></th>
            <th class="ds-sf-num" scope="col">可售日數<br><span>（Turnday）</span></th>
            <th class="ds-sf-num" scope="col">現時<br>Safety</th>
            <th class="ds-sf-num" scope="col">建議<br>Safety</th>
            <th class="ds-sf-num" scope="col">Safety<br>增減</th>
            <th class="ds-sf-reply" scope="col">回覆</th>
          </tr></thead>
          <tbody>${items.map(safetyRowHtml).join('')}</tbody>
        </table>
      </div>
      <p class="ds-sf-legend">可售日數＝以目前店舖存貨除以每日平均銷量（P90D），數字越低代表越快賣完。Safety 增減為「建議 − 現時」，正數代表需增加。<br><b>截止前未回覆的 SKU，會自動套用建議 Safety；如選「不同意」但未填新 Safety，則維持現時數值不變。</b></p>
    </div>`;
  }

  function setSafetyDecision(row, decision, silent = false) {
    if (!row) return;
    row.dataset.decision = decision;
    row.classList.remove('is-missing');
    row.classList.toggle('is-answered', Boolean(decision));
    row.querySelectorAll('[data-decision]').forEach((btn) => {
      const on = btn.dataset.decision === decision;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const extra = row.querySelector('.ds-sf-extra');
    if (extra) extra.hidden = decision !== SAFETY_DISAGREE;
    row.querySelectorAll('.ds-sf-reason, .ds-sf-newsafety').forEach((el) => el.classList.remove('is-invalid'));
    if (!silent) updateSafetySummary();
  }

  function updateSafetySummary() {
    if (!currentMatter || currentMode !== 'safety') return;
    const rows = Array.from($('ds_sku_sections').querySelectorAll('[data-sf-row]'));
    const answered = rows.filter((row) => row.dataset.decision).length;
    const agree = rows.filter((row) => row.dataset.decision === SAFETY_AGREE).length;
    const disagree = rows.filter((row) => row.dataset.decision === SAFETY_DISAGREE).length;
    const progress = $('ds_sf_progress');
    if (progress) {
      progress.innerHTML = `共 <b>${rows.length}</b> 個 SKU｜已回覆 <b>${answered}</b> / ${rows.length}`
        + `｜<span class="ds-sf-count-yes">同意 ${agree}</span>`
        + `｜<span class="ds-sf-count-no">不同意 ${disagree}</span>`
        + (answered < rows.length ? `｜<span class="ds-sf-count-left">尚餘 ${rows.length - answered}</span>` : '｜<b class="ds-sf-done">已全部選擇</b>');
    }
    const summary = $('ds_reply_summary');
    if (summary) {
      summary.innerHTML = `已回覆 <b>${answered}</b> / ${rows.length} 個 SKU`
        + (answered < rows.length ? ' — 請為每個 SKU 選擇同意或不同意' : '');
    }
  }

  function wireSafetyTable() {
    const wrap = $('ds_sku_sections');
    updateSafetySummary();
    if (readOnly) return;
    wrap.querySelectorAll('[data-decision]').forEach((btn) => {
      btn.addEventListener('click', () => setSafetyDecision(btn.closest('[data-sf-row]'), btn.dataset.decision));
    });
    const all = wrap.querySelector('#ds_sf_all_agree');
    if (all) {
      all.addEventListener('click', () => {
        wrap.querySelectorAll('[data-sf-row]').forEach((row) => setSafetyDecision(row, SAFETY_AGREE, true));
        updateSafetySummary();
      });
    }
    wrap.querySelectorAll('.ds-sf-reason, .ds-sf-newsafety').forEach((input) => {
      input.addEventListener('input', () => input.classList.remove('is-invalid'));
    });
  }

  /** 收集 Safety 回覆：每個 SKU 必須有 f1；不同意才送 f2／f3 */
  function collectSafetyItems() {
    const rows = Array.from($('ds_sku_sections').querySelectorAll('[data-sf-row]'));
    const missing = rows.filter((row) => !row.dataset.decision);
    if (missing.length) {
      const first = missing[0];
      first.classList.add('is-missing');
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      throw new Error(`仍有 ${missing.length} 個 SKU 未選擇「同意／不同意」，已跳到第一個未選擇的行`);
    }
    return rows.map((row) => {
      const decision = row.dataset.decision;
      const sku = row.dataset.sku || '—';
      const fields = { f1: decision };
      if (decision === SAFETY_DISAGREE) {
        const reasonEl = row.querySelector('.ds-sf-reason');
        const newEl = row.querySelector('.ds-sf-newsafety');
        const reason = reasonEl ? reasonEl.value.trim() : '';
        const newSafety = newEl ? newEl.value.trim() : '';
        if (newSafety && !/^\d+$/.test(newSafety)) {
          if (newEl) newEl.classList.add('is-invalid');
          throw new Error(`SKU ${sku}：新 Safety 必須為 0 或以上的整數`);
        }
        if (reason) fields.f2 = reason;
        if (newSafety) fields.f3 = newSafety;
      }
      return { item_id: row.dataset.item, lines: [], note: '', no_transfer: false, fields };
    });
  }

  function openMatter(code) {
    const matter = matters.find((m) => m.matter_code === code);
    if (!matter) return;
    currentMatter = matter;
    currentFields = matter.reply_fields || [];
    currentMode = matter.reply_mode || 'stock_year';
    currentScope = matter.reply_scope || 'item';
    readOnly = !matter.is_open;
    $('ds_reply_dialog').classList.toggle('ds-dialog--wide', currentMode === 'safety');
    $('ds_reply_title').textContent = readOnly
      ? `事項回覆（已截止） — ${matter.matter_code}`
      : matter.status === 'replied' ? `修改回覆 — ${matter.matter_code}` : `回覆事項 — ${matter.matter_code}`;
    $('ds_reply_matter').textContent = `${matter.subject}｜批次 ${matter.batch_code}`;
    $('ds_reply_sub').textContent = currentMode === 'safety'
      ? `Safety 調整｜${matter.item_count} 個 SKU`
        + (matter.due_at ? `｜截止 ${matter.due_at}（香港時間）` : '')
        + (matter.reference ? `｜參考 ${matter.reference}` : '')
      : (currentScope === 'matter' ? '全店回覆一次' : `${matter.item_count} 個 SKU`) +
        (currentFields.length ? `｜${currentFields.length} 個回覆欄位` : '') +
        (matter.due_at ? `｜截止 ${matter.due_at}（香港時間）` : '') +
        (matter.reference ? `｜參考 ${matter.reference}` : '');

    const notice = $('ds_reply_notice');
    if (readOnly) {
      notice.hidden = false;
      notice.className = 'ds-notice ds-notice--closed';
      notice.innerHTML = matter.is_expired
        ? `此事項已過截止時間（${p.escapeHtml(matter.due_at || '')}），只供查閱，不能再提交回覆。如需補交請聯絡 RP Team。`
        : '此事項已截止，只供查閱，不能再修改回覆。如需更正請聯絡 RP Team。';
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
    if (currentMode === 'safety') {
      wrap.innerHTML = safetyTableHtml(matter);
      wireSafetyTable();
    } else {
      (matter.items || []).forEach((item) => wrap.appendChild(buildSkuSection(item)));
    }

    $('ds_reply_summary').hidden = readOnly;
    $('ds_save').hidden = readOnly;
    $('ds_save').disabled = false;
    $('ds_save').textContent = '儲存回覆';
    p.showAlert($('ds_reply_error'), '', '');
    updateOverallTotal();
    $('ds_reply_dialog').showModal();
    if (readOnly) return;
    if (currentMode === 'safety') {
      const firstBtn = wrap.querySelector('.ds-sf-btn');
      if (firstBtn) setTimeout(() => firstBtn.focus(), 60);
      return;
    }
    const first = wrap.querySelector('.ds-year') || wrap.querySelector('.ds-cf-input');
    if (first) setTimeout(() => first.focus(), 60);
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
    if (!out.length) throw new Error(`SKU ${sku}：請填寫至少一個年期，或選取「無可調撥件數」`);
    return out;
  }

  /** 讀取自定欄位；必填未填或數字格式錯即時標紅並中止 */
  function collectFields(section, subject) {
    const out = {};
    for (const field of currentFields) {
      const el = section.querySelector(`.ds-cf-input[data-field="${field.key}"]`);
      const value = el ? String(el.value || '').trim() : '';
      if (!value) {
        if (field.required) {
          if (el) el.classList.add('is-invalid');
          throw new Error(`${subject}：「${field.label}」為必填`);
        }
        continue;
      }
      if (field.type === 'number' && !/^\d+(\.\d+)?$/.test(value)) {
        if (el) el.classList.add('is-invalid');
        throw new Error(`${subject}：「${field.label}」必須為數字（不接受負數或文字）`);
      }
      out[field.key] = value;
    }
    return out;
  }

  function collectItems() {
    if (currentMode === 'safety') return collectSafetyItems();
    return Array.from($('ds_sku_sections').querySelectorAll('[data-item]')).map((section) => {
      const item = (currentMatter.items || []).find((it) => it.id === section.dataset.item);
      const subject = currentScope === 'matter' ? '本店回覆' : `SKU ${item ? item.sku : '—'}`;
      const fields = collectFields(section, subject);
      const note = (section.querySelector('.ds-sku-note')?.value || '').trim();
      if (currentMode === 'custom') {
        if (!Object.keys(fields).length) throw new Error(`${subject}：請至少填寫一個回覆欄位`);
        return { item_id: section.dataset.item, lines: [], note, no_transfer: false, fields };
      }
      const checkbox = section.querySelector('.ds-no-transfer');
      if (checkbox && checkbox.checked) {
        return { item_id: section.dataset.item, lines: [], note, no_transfer: true, fields };
      }
      return {
        item_id: section.dataset.item,
        lines: collectSectionLines(section, item ? item.sku : '—'),
        note,
        no_transfer: false,
        fields,
      };
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
      const summary = data.matter.reply_mode === 'safety'
        ? `${data.matter.item_count} 個 SKU 已提交 Safety 回覆`
        : data.matter.reply_mode === 'custom'
          ? (data.matter.reply_scope === 'matter' ? '本店回覆已儲存' : `${data.matter.item_count} 個 SKU 已回覆`)
          : `${data.matter.item_count} 個 SKU，合計 ${data.matter.reply_total} 件`;
      p.showAlert($('ds_list_error'), 'success', `已儲存 <b>${p.escapeHtml(data.matter.matter_code)}</b> 的回覆（${summary}）。如發現輸入有誤，可在截止前再修改。`);
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
