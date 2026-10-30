/* OM（區域主管）Portal：登入、總覽、零銷售代覆、存貨走勢。
   指定 SKU 代覆在 om-designated-sku.js，透過 window.omApp 共用 API。 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const p = window.portal || {};
  const esc = p.escapeHtml || ((v) => String(v ?? ''));
  let csrfToken = null;

  const state = {
    user: null,
    overview: null,
    stores: [],
    loaded: { overview: false, zero: false, dsku: false, stock: false },
    zero: { batches: [], items: [], reasons: [], currentId: null },
  };

  /* ------------------------------------------------------------------ */
  /* API / 登入                                                          */
  /* ------------------------------------------------------------------ */

  async function ensureCsrf() {
    if (csrfToken) return csrfToken;
    try {
      const data = await fetch('/api/csrf', { credentials: 'same-origin' }).then((r) => r.json());
      csrfToken = data?.token || '';
    } catch {
      csrfToken = '';
    }
    return csrfToken;
  }

  async function omApi(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
      headers['X-CSRF-Token'] = await ensureCsrf();
    }
    const res = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401) {
        showLogin('登入已過期，請重新輸入 OM 名稱及密碼。');
      }
      const err = new Error(data?.error || `請求失敗 (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showAlert(el, type, message) {
    if (!el) return;
    if (p.showAlert) p.showAlert(el, type, message);
    else el.innerHTML = message ? `<div class="alert ${type}">${message}</div>` : '';
  }

  function showLogin(message) {
    const app = $('om_app');
    const login = $('om_login_section');
    if (app) app.hidden = true;
    if (login) login.hidden = false;
    if ($('om_logout_link')) $('om_logout_link').hidden = true;
    if (message) showAlert($('om_login_error'), 'info', esc(message));
  }

  function showApp(user) {
    state.user = user;
    if ($('om_login_section')) $('om_login_section').hidden = true;
    if ($('om_app')) $('om_app').hidden = false;
    if ($('om_logout_link')) $('om_logout_link').hidden = false;
    if ($('om_who')) $('om_who').textContent = user.display_name || user.username || '';
    setHeader('總覽');
  }

  function setHeader(label) {
    const name = state.user ? (state.user.display_name || state.user.username) : '';
    if ($('om_header')) $('om_header').textContent = `區域主管${name ? ` · ${name}` : ''} · ${label}`;
  }

  async function login(event) {
    event.preventDefault();
    const btn = $('om_login_btn');
    const name = ($('om_login_name')?.value || '').trim();
    const pass = $('om_login_pass')?.value || '';
    showAlert($('om_login_error'), '', '');
    if (!name || !pass) {
      showAlert($('om_login_error'), 'error', '請輸入 OM 名稱及密碼');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '登入中…'; }
    try {
      await ensureCsrf();
      const data = await omApi('/api/portal/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: name, password: pass }),
      });
      if (!data?.user || data.user.role !== 'om') throw new Error('此帳戶不是 OM 帳戶');
      csrfToken = null;
      $('om_login_pass').value = '';
      showApp(data.user);
      await loadOverview();
      loadZeroReasons().catch(() => {});
      activateTab('tab_om_overview', { silent: true });
    } catch (err) {
      showAlert($('om_login_error'), 'error', esc(err.message));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '登入'; }
    }
  }

  async function logout(event) {
    if (event) event.preventDefault();
    try {
      await omApi('/api/portal/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch {}
    csrfToken = null;
    state.user = null;
    state.overview = null;
    state.stores = [];
    state.loaded = { overview: false, zero: false, dsku: false, stock: false };
    showLogin('');
    const name = new URLSearchParams(window.location.search).get('user');
    if (name && $('om_login_name')) $('om_login_name').value = name;
  }

  async function checkSession() {
    try {
      const data = await fetch('/api/portal/auth/me', { credentials: 'same-origin' });
      if (!data.ok) throw new Error('未登入');
      const body = await data.json();
      if (body?.user?.role !== 'om') {
        showLogin('目前以其他身份登入。OM 請使用 OM 名稱及 OM 密碼登入（會切換目前的登入身份）。');
        return;
      }
      showApp(body.user);
      await loadOverview();
      loadZeroReasons().catch(() => {});
    } catch {
      showLogin('');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 分頁                                                                */
  /* ------------------------------------------------------------------ */

  const TABS = ['tab_om_overview', 'tab_om_zero', 'tab_om_dsku', 'tab_om_stock'];

  function activateTab(tabId, opts = {}) {
    const tab = $(tabId);
    if (!tab) return;
    TABS.forEach((id) => {
      const item = $(id);
      if (!item) return;
      const active = id === tabId;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
      item.tabIndex = active ? 0 : -1;
      const panel = $(item.dataset.panel);
      if (panel) panel.hidden = !active;
    });
    setHeader(tab.dataset.subtitle || '');
    if (!opts.silent) {
      if (tabId === 'tab_om_overview') loadOverview();
      if (tabId === 'tab_om_zero') loadZeroTab();
      if (tabId === 'tab_om_dsku' && window.omDesignatedSku) window.omDesignatedSku.load();
      if (tabId === 'tab_om_stock') loadStock();
    }
    if (!opts.silent) {
      const hash = tabId === 'tab_om_zero' ? '#zero'
        : tabId === 'tab_om_dsku' ? '#designated-sku'
          : tabId === 'tab_om_stock' ? '#stock' : '';
      try {
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
      } catch {}
    }
  }

  function bindTabs() {
    TABS.forEach((id) => {
      const tab = $(id);
      if (!tab) return;
      tab.addEventListener('click', () => activateTab(id));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const index = TABS.indexOf(id);
        const next = event.key === 'ArrowRight'
          ? TABS[(index + 1) % TABS.length]
          : TABS[(index - 1 + TABS.length) % TABS.length];
        $(next)?.focus();
        activateTab(next);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 共用格式化                                                          */
  /* ------------------------------------------------------------------ */

  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmtMoney(value) {
    const n = num(value);
    if (n === null) return '—';
    return `$${Math.round(n).toLocaleString('en-US')}`;
  }

  function fmtRatio(value) {
    const n = num(value);
    if (n === null) return '—';
    return `${(n * 100).toFixed(2)}%`;
  }

  function fmtPt(value) {
    const n = num(value);
    if (n === null) return '—';
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}pt`;
  }

  function deltaClass(value) {
    const n = num(value);
    if (n === null) return '';
    if (n > 0.0001) return 'dash-worse';
    if (n < -0.0001) return 'dash-better';
    return '';
  }

  function deltaArrow(value) {
    const n = num(value);
    if (n === null) return '';
    if (n > 0.0001) return '▲ ';
    if (n < -0.0001) return '▼ ';
    return '＝ ';
  }

  function fmtDate(value) {
    return String(value ?? '').slice(0, 10);
  }

  function deltaHtml(value, opts = {}) {
    if (value === null || value === undefined) return '<span class="om-muted">—</span>';
    const text = `${deltaArrow(value)}${fmtPt(value)}`;
    if (opts.reversed) {
      const n = num(value);
      const cls = n > 0.0001 ? 'dash-better' : n < -0.0001 ? 'dash-worse' : '';
      return `<span class="${cls}">${esc(text)}</span>`;
    }
    return `<span class="${deltaClass(value)}">${esc(text)}</span>`;
  }

  function storeLabel(siteCode) {
    const store = state.stores.find((s) => s.site_code === siteCode);
    return store ? `${store.site_code} ${store.shop}` : siteCode;
  }

  function syncStoreSelects() {
    const stores = state.stores;
    const options = stores
      .map((s) => `<option value="${esc(s.site_code)}">${esc(s.site_code)}${s.shop ? ` — ${esc(s.shop)}` : ''}</option>`)
      .join('');
    const all = `<option value="">全部管轄店舖</option>`;
    ['om_zs_site', 'om_ds_site'].forEach((id) => {
      const sel = $(id);
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = all + options;
      if (current && stores.some((s) => s.site_code === current)) sel.value = current;
    });
    const stockSel = $('om_stock_site');
    if (stockSel) {
      const current = stockSel.value;
      stockSel.innerHTML = `<option value="">OM 管轄合計</option>` + options;
      if (current && stores.some((s) => s.site_code === current)) stockSel.value = current;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 總覽                                                                */
  /* ------------------------------------------------------------------ */

  async function refreshOverview() {
    try {
      const data = await omApi('/api/portal/om/overview');
      state.overview = data;
      state.stores = data.stores || [];
      state.loaded.overview = true;
      syncStoreSelects();
      renderOverview(data);
      showAlert($('om_overview_error'), '', '');
      if ($('om_scope')) {
        $('om_scope').textContent = `管轄 ${state.stores.length} 間店舖：${state.stores.map((s) => s.site_code).join('、') || '—'}`;
      }
    } catch (err) {
      showAlert($('om_overview_error'), 'error', esc(err.message));
      if ($('om_store_body')) {
        $('om_store_body').innerHTML = `<tr><td colspan="7" class="text-center text-secondary">載入失敗：${esc(err.message)}</td></tr>`;
      }
    }
  }

  async function loadOverview() {
    await refreshOverview();
  }

  function stockBySite() {
    const map = new Map();
    for (const row of state.overview?.stock?.stores || []) map.set(row.site_code, row);
    return map;
  }

  function zeroBySite() {
    const map = new Map();
    for (const row of state.overview?.zero_sales?.stores || []) map.set(row.site_code, row);
    return map;
  }

  function dskuBySite() {
    const map = new Map();
    for (const row of state.overview?.designated_sku?.stores || []) map.set(row.site_code, row);
    return map;
  }

  function renderOverview(data) {
    const kpi = $('om_kpi');
    const zs = data.zero_sales || {};
    const ds = data.designated_sku || {};
    const stock = data.stock?.kpi || null;
    if (kpi) {
      kpi.innerHTML = [
        kpiCard(String(state.stores.length), '管轄店舖', '只包括 stores.om 等於你的店舖'),
        kpiCard(String(zs.pending_total ?? 0), '零銷售待回覆 SKU',
          `${zs.stores_pending ?? 0} 間店舖有未回覆項目`, (zs.pending_total ?? 0) > 0 ? 'dash-worse' : 'dash-better'),
        kpiCard(String(ds.pending_matters ?? 0), '指定 SKU 待回事項',
          `${ds.pending_items ?? 0} 個 SKU 明細未回覆`, (ds.pending_matters ?? 0) > 0 ? 'dash-worse' : 'dash-better'),
        kpiCard(stock ? fmtRatio(stock.ratio) : '—', '最新不良存貨佔比',
          stock
            ? `${fmtDate(stock.report_date)}｜全公司 ${fmtRatio(stock.company_ratio)}`
            : '尚未有存貨報表',
          stock ? deltaClass(stock.wow_delta_pt) : ''),
      ].join('');
    }

    const zero = zeroBySite();
    const dsMap = dskuBySite();
    const stockMap = stockBySite();
    const body = $('om_store_body');
    if (!body) return;
    if (!state.stores.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-center text-secondary">你目前沒有管轄店舖。</td></tr>';
      return;
    }
    body.innerHTML = state.stores.map((store) => {
      const z = zero.get(store.site_code);
      const d = dsMap.get(store.site_code);
      const s = stockMap.get(store.site_code);
      const total = z ? Number(z.total) : 0;
      const pending = z ? Number(z.pending) : 0;
      const rate = total > 0 ? ((total - pending) / total) * 100 : null;
      const zText = z
        ? `${pending} / ${total} 未回覆<div class="hint">${esc(z.week_label)}${z.is_open ? '' : '（已封存）'}</div>`
        : '<span class="om-muted">—</span>';
      const dText = d && Number(d.total_matters) > 0
        ? `${Number(d.pending_matters)} / ${Number(d.total_matters)} 事項<div class="hint">${Number(d.pending_items)} 個 SKU 未回覆</div>`
        : '<span class="om-muted">—</span>';
      return `<tr>
        <td><span class="om-site">${esc(store.site_code)}</span><div class="om-shop">${esc(store.shop || '')}</div></td>
        <td>${zText}</td>
        <td>${rate === null ? '<span class="om-muted">—</span>' : `${rate.toFixed(0)}%`}</td>
        <td>${dText}</td>
        <td>${s ? `${fmtRatio(s.ratio)}<div class="hint">SKU ${fmtRatio(s.ovs_carry_ratio)}（${esc(String(s.sku_count_0sale ?? '—'))} / ${esc(String(s.total_sku_carry ?? '—'))}）</div>` : '<span class="om-muted">—</span>'}</td>
        <td>${s ? deltaHtml(s.wow_delta_pt) : '<span class="om-muted">—</span>'}</td>
        <td><div class="om-store-actions">
          <button type="button" data-action="zero" data-site="${esc(store.site_code)}">零銷售</button>
          <button type="button" data-action="dsku" data-site="${esc(store.site_code)}">指定 SKU</button>
          <button type="button" data-action="stock" data-site="${esc(store.site_code)}">走勢</button>
        </div></td>
      </tr>`;
    }).join('');

    body.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const site = btn.dataset.site;
        if (btn.dataset.action === 'zero') {
          if ($('om_zs_site')) $('om_zs_site').value = site;
          activateTab('tab_om_zero');
        } else if (btn.dataset.action === 'dsku') {
          if ($('om_ds_site')) $('om_ds_site').value = site;
          activateTab('tab_om_dsku');
        } else {
          if ($('om_stock_site')) $('om_stock_site').value = site;
          activateTab('tab_om_stock');
        }
      });
    });
  }

  function kpiCard(value, label, sub, tone) {
    return `<div class="dash-kpi">
      <div class="dash-kpi-value ${tone || ''}">${esc(value)}</div>
      <div class="dash-kpi-label">${esc(label)}</div>
      ${sub ? `<div class="dash-kpi-sub">${esc(sub)}</div>` : ''}
    </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 零銷售                                                              */
  /* ------------------------------------------------------------------ */

  async function loadZeroReasons() {
    if (state.zero.reasons.length) return;
    const data = await omApi('/api/portal/om/zero-sales/reasons');
    state.zero.reasons = data.reasons || [];
    const sel = $('om_zs_reason');
    if (sel) {
      sel.innerHTML = state.zero.reasons
        .map((r) => `<option value="${esc(r.code)}">${esc(r.label)}</option>`)
        .join('');
    }
  }

  async function loadZeroBatches() {
    const data = await omApi('/api/portal/om/zero-sales/batches');
    state.zero.batches = data.batches || [];
    const sel = $('om_zs_batch');
    if (!sel) return;
    const prev = sel.value;
    if (!state.zero.batches.length) {
      sel.innerHTML = '<option value="">暫無派發</option>';
      return;
    }
    const fallback = (state.zero.batches.find((b) => b.is_open)
      || state.zero.batches.find((b) => !b.is_archived)
      || state.zero.batches[0]).id;
    sel.innerHTML = '<option value="all">全部週次</option>' + state.zero.batches.map((b) => {
      const latest = b.id === state.zero.batches[0].id ? ' — 最新' : '';
      const label = b.is_archived
        ? `${b.week_label}（已封存 · ${b.total} 個 SKU）`
        : b.reply_required === false
          ? `${b.week_label}（無須回覆 · ${b.total} 個 SKU）${latest}`
          : `${b.week_label}（${b.pending} 未回覆 / ${b.total}）${latest}`;
      return `<option value="${esc(b.id)}">${esc(label)}</option>`;
    }).join('');
    if (prev === 'all') sel.value = 'all';
    else if (prev && state.zero.batches.some((b) => b.id === prev)) sel.value = prev;
    else sel.value = fallback;
  }

  function zeroFilterParams() {
    const params = new URLSearchParams();
    const batch = $('om_zs_batch')?.value || '';
    if (batch && batch !== 'all') params.set('batch_id', batch);
    const site = $('om_zs_site')?.value || '';
    if (site) params.set('site_code', site);
    const status = $('om_zs_status')?.value || '';
    if (status) params.set('status', status);
    const q = ($('om_zs_search')?.value || '').trim();
    if (q) params.set('q', q);
    return params;
  }

  async function loadZeroItems() {
    const params = zeroFilterParams();
    try {
      const data = await omApi(`/api/portal/om/zero-sales/items${params.toString() ? `?${params}` : ''}`);
      state.zero.items = data.items || [];
      renderZeroItems();
      showAlert($('om_zs_error'), '', '');
    } catch (err) {
      showAlert($('om_zs_error'), 'error', esc(err.message));
      if ($('om_zs_list')) $('om_zs_list').innerHTML = `<div class="empty" style="padding:28px">載入失敗：${esc(err.message)}</div>`;
    }
  }

  async function loadZeroTab() {
    try {
      await loadZeroReasons();
      await loadZeroBatches();
      await loadZeroItems();
    } catch (err) {
      showAlert($('om_zs_error'), 'error', esc(err.message));
    }
  }

  function zeroBatchInfo() {
    const id = $('om_zs_batch')?.value || '';
    if (!id || id === 'all') return null;
    return state.zero.batches.find((b) => b.id === id) || null;
  }

  function renderZeroItems() {
    const list = $('om_zs_list');
    if (!list) return;
    const batch = zeroBatchInfo();
    const items = state.zero.items;
    const replied = items.filter((i) => i.status === 'replied').length;
    const rate = items.length ? Math.round((replied / items.length) * 100) : 0;
    const week = batch ? batch.week_label : '全部週次';
    const site = $('om_zs_site')?.value || '';
    if ($('om_zs_info')) {
      $('om_zs_info').innerHTML = `<div class="site-banner">${esc(week)}${site ? ` · ${esc(storeLabel(site))}` : ' · 全部管轄店舖'}</div>
        <div>${items.length} 個 SKU｜${replied} 已回覆（${rate}%）${batch && batch.is_archived ? '｜此週次已封存，只供查閱' : ''}</div>`;
    }
    if (!items.length) {
      list.innerHTML = '<div class="empty" style="padding:36px 16px">沒有符合條件的零銷售資料。試下轉狀態、店舖或清空搜尋字。</div>';
      if ($('om_zs_count')) $('om_zs_count').textContent = '';
      return;
    }
    let html = '<table class="zs-table"><thead><tr><th>店舖</th><th>週次</th><th>SKU</th><th>Brand</th><th>描述</th><th>狀態</th><th>店舖回覆</th><th>SKU 上載日期</th><th></th></tr></thead><tbody>';
    for (const item of items) {
      const payload = item.payload || {};
      const brand = String(payload.Brand || '').split(' - ')[0] || payload.Brand || '';
      const archived = item.is_open === false;
      const repliedItem = item.status === 'replied';
      const badge = archived
        ? `<span class="badge-archived">${repliedItem ? '已回覆 · 已封存' : '未回覆 · 已封存'}</span>`
        : repliedItem
          ? '<span class="badge-replied">已回覆</span>'
          : '<span class="badge-pending">未回覆</span>';
      const reply = repliedItem
        ? `${esc(item.reason_label || '')}${item.reason_note ? `<div class="hint">${esc(item.reason_note)}</div>` : ''}`
        : '—';
      const action = archived
        ? '<span class="zs-closed">已封存</span>'
        : `<button class="btn ghost${repliedItem ? '' : ' zs-reply-needed'}" data-om-zs-reply="${esc(item.id)}" type="button">${repliedItem ? '修改代覆' : 'OM 代覆'}</button>`;
      html += `<tr><td><span class="om-site">${esc(item.site_code)}</span></td>
        <td>${esc(item.week_label || '')}</td>
        <td>${esc(item.sku)}</td>
        <td>${esc(brand)}</td>
        <td>${esc(payload['SKU Desc'] || '')}</td>
        <td>${badge}</td>
        <td>${reply}</td>
        <td>${esc(item.batch_date || fmtDate(item.batch_created_at))}</td>
        <td>${action}</td></tr>`;
    }
    html += '</tbody></table>';
    list.innerHTML = html;
    list.querySelectorAll('[data-om-zs-reply]').forEach((btn) => {
      btn.addEventListener('click', () => openZeroReply(btn.dataset.omZsReply));
    });
    if ($('om_zs_count')) $('om_zs_count').textContent = `顯示 ${items.length} 筆`;
  }

  async function openZeroReply(itemId) {
    const item = state.zero.items.find((i) => i.id === itemId);
    if (!item) return;
    if (item.is_open === false) {
      showAlert($('om_zs_error'), 'error', '此週次已封存，OM 不可代覆；如需更正請聯絡 RP Team。');
      return;
    }
    state.zero.currentId = itemId;
    const payload = item.payload || {};
    if ($('om_zs_dialog_title')) {
      $('om_zs_dialog_title').textContent = `${item.status === 'replied' ? '修改代覆' : 'OM 代覆'} — ${item.sku}`;
    }
    if ($('om_zs_dialog_info')) {
      $('om_zs_dialog_info').textContent = `${item.site_code} ${storeLabel(item.site_code)}｜${item.week_label || ''}｜${payload.Brand || ''}｜${payload['SKU Desc'] || ''}`;
    }
    const reasonSel = $('om_zs_reason');
    if (reasonSel) reasonSel.value = item.reason_code || (state.zero.reasons[0]?.code || '');
    if ($('om_zs_note')) $('om_zs_note').value = item.reason_note || '';
    showAlert($('om_zs_reply_error'), '', '');
    $('om_zs_dialog')?.showModal();
  }

  async function saveZeroReply() {
    const itemId = state.zero.currentId;
    if (!itemId) return;
    const btn = $('om_zs_save');
    if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
    try {
      await omApi(`/api/portal/om/zero-sales/items/${encodeURIComponent(itemId)}/reply`, {
        method: 'PUT',
        body: JSON.stringify({
          reason_code: $('om_zs_reason')?.value || '',
          reason_note: $('om_zs_note')?.value || '',
        }),
      });
      $('om_zs_dialog')?.close();
      state.zero.currentId = null;
      await loadZeroBatches();
      await loadZeroItems();
      refreshOverview();
    } catch (err) {
      if (err.status === 409) {
        $('om_zs_dialog')?.close();
        await loadZeroBatches();
        await loadZeroItems();
        showAlert($('om_zs_error'), 'error', esc(err.message));
        return;
      }
      showAlert($('om_zs_reply_error'), 'error', esc(err.message));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '儲存代覆'; }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 存貨走勢                                                            */
  /* ------------------------------------------------------------------ */

  function renderStockKpi(data) {
    const kpi = $('om_stock_kpi');
    if (!kpi) return;
    const k = data.selected_store?.kpi || data.kpi;
    const scope = data.selected_store
      ? `${data.selected_store.site_code} ${data.selected_store.shop || ''}`.trim()
      : '管轄店舖合計';
    if (!k) {
      kpi.innerHTML = '<div class="dash-kpi"><div class="dash-kpi-value">—</div><div class="dash-kpi-label">暫無存貨數據</div><div class="dash-kpi-sub">待 RP Team 上載 I14 報表</div></div>';
      return;
    }
    const skuCounts = k.total_sku_carry === null
      ? 'Carry SKU 未提供'
      : `不良 ${k.sku_count_0sale ?? '—'} / Carry ${k.total_sku_carry}`;
    const companySku = k.company_ovs_carry_ratio === null
      ? '全公司暫無對比'
      : `全公司 ${fmtRatio(k.company_ovs_carry_ratio)}`;
    kpi.innerHTML = [
      kpiCard(fmtRatio(k.ratio), '不良存貨佔比',
        `${fmtDate(k.report_date)}｜${scope}`, deltaClass(k.wow_delta_pt)),
      kpiCard(fmtMoney(k.total_excess), '不良存貨值（P90D 0 Sales）', scope),
      kpiCard(fmtMoney(k.total_soh), '店舖存貨值（CM）', scope),
      kpiCard(fmtRatio(k.ovs_carry_ratio), '不良存貨 SKU ÷ Carry SKU',
        `${skuCounts}｜${companySku}`,
        deltaClass(k.ovs_wow_delta_pt)),
    ].join('');
  }

  /** 兩個存貨走勢圖共用：valueKey 可選 ratio 或 ovs_carry_ratio。 */
  function renderRatioTrend(opts) {
    const el = $(opts.elId);
    const note = $(opts.noteId);
    const period = $(opts.periodId);
    if (!el) return;
    const series = opts.series || [];
    const company = opts.company || [];
    const usable = series.filter((row) => row[opts.valueKey] !== null);
    const companyUsable = company.filter((row) => row[opts.valueKey] !== null);
    if (period) period.textContent = '';
    if (note) note.textContent = '';
    if (!usable.length) {
      el.innerHTML = `<div class="ct-empty">${opts.emptyText || '暫無可顯示的走勢。'}</div>`;
      if (note) note.textContent = opts.emptyNote || '待 RP Team 上載最新一期 I14「By Shop」報表後會自動更新。';
      return;
    }
    if (usable.length === 1) {
      el.innerHTML = '<div class="ct-empty">目前只有 1 期資料，下期上載後會顯示走勢。</div>';
      if (period) period.textContent = fmtDate(usable[0].report_date);
      if (note) note.textContent = opts.singleText ? opts.singleText(usable[0]) : `本期數值 ${fmtRatio(usable[0][opts.valueKey])}。`;
      return;
    }
    const chartApi = globalThis.ChartLite;
    if (!chartApi) {
      el.innerHTML = '<div class="ct-empty">圖表元件未載入，請重新整理頁面。</div>';
      return;
    }
    if (period) {
      period.textContent = `${fmtDate(usable[0].report_date)} 至 ${fmtDate(usable[usable.length - 1].report_date)}，共 ${usable.length} 期`;
    }
    const chartSeries = [{
      key: 'self',
      label: opts.selfLabel || 'OM 管轄合計',
      color: '#0f5c9c',
      points: series.map((row) => ({ date: row.report_date, value: row[opts.valueKey] })),
    }];
    if (companyUsable.length) {
      chartSeries.push({
        key: 'company',
        label: '全公司合計（加權）',
        color: '#94a3b8',
        dashed: true,
        points: companyUsable.map((row) => ({ date: row.report_date, value: row[opts.valueKey] })),
      });
    }
    chartApi.renderLine(el, {
      series: chartSeries,
      height: 260,
      emptyText: opts.emptyText || '暫無數據',
      yFormat: (v) => `${(Number(v) * 100).toFixed(1)}%`,
      tipFormat: (v) => fmtRatio(v),
      ariaLabel: `${opts.selfLabel || 'OM 管轄合計'}${opts.ariaLabel || '走勢'}，共 ${usable.length} 期`,
    });
    if (note) note.textContent = opts.noteText ? opts.noteText(usable) : '點或懸停圖表可查看該期數值。';
  }

  function currentSelfLabel(data) {
    return data.selected_store
      ? `${data.selected_store.site_code} ${data.selected_store.shop || ''}`.trim()
      : 'OM 管轄合計';
  }

  function renderStockChart(data) {
    const selected = data.selected_store;
    const selfLabel = currentSelfLabel(data);
    if ($('om_stock_legend_self')) $('om_stock_legend_self').textContent = selfLabel;
    renderRatioTrend({
      elId: 'om_stock_chart',
      periodId: 'om_stock_period',
      noteId: 'om_stock_note',
      valueKey: 'ratio',
      series: selected ? selected.series : data.series,
      company: data.company_series || [],
      selfLabel,
      emptyText: '暫無可顯示的存貨走勢。',
      ariaLabel: '不良存貨佔比趨勢',
      noteText: () => '點或懸停圖表可查看該期數值；OM 合計以管轄店舖加權計算。',
    });
  }

  function renderSkuChart(data) {
    const selected = data.selected_store;
    const selfLabel = currentSelfLabel(data);
    if ($('om_sku_legend_self')) $('om_sku_legend_self').textContent = selfLabel;
    const company = (data.company_series || []).filter((row) => row.ovs_carry_ratio !== null);
    const companyByDate = new Map((data.company_series || []).map((row) => [row.report_date, row.ovs_carry_ratio]));
    renderRatioTrend({
      elId: 'om_sku_chart',
      periodId: 'om_sku_period',
      noteId: 'om_sku_note',
      valueKey: 'ovs_carry_ratio',
      series: selected ? selected.series : data.series,
      company,
      selfLabel,
      emptyText: '暫無可顯示的 SKU 比率走勢。',
      ariaLabel: '不良存貨 SKU ÷ Carry SKU 趨勢',
      singleText: (row) => `本期 SKU 比率 ${fmtRatio(row.ovs_carry_ratio)}（不良 ${row.sku_count_0sale ?? '—'} / Carry ${row.total_sku_carry ?? '—'}）。`,
      noteText: (usable) => {
        const last = usable[usable.length - 1];
        const cmp = companyByDate.get(last.report_date);
        return `最新一期：不良 SKU ${last.sku_count_0sale ?? '—'} / Carry SKU ${last.total_sku_carry ?? '—'} = ${fmtRatio(last.ovs_carry_ratio)}` +
          (cmp === null || cmp === undefined ? '；全公司暫無對比。' : `；全公司 ${fmtRatio(cmp)}。`) +
          ' Carry SKU = No. of RF SKU + ND with Stock。';
      },
    });
  }

  function renderStockStores(data) {
    const body = $('om_stock_table_body');
    if (!body) return;
    const rows = (data.stores || []).slice().sort((a, b) => {
      if (a.ratio === null && b.ratio === null) return a.site_code.localeCompare(b.site_code);
      if (a.ratio === null) return 1;
      if (b.ratio === null) return -1;
      return b.ratio - a.ratio;
    });
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="text-center text-secondary">暫無存貨數據。</td></tr>';
      return;
    }
    body.innerHTML = rows.map((row) => `<tr>
      <td><button type="button" class="om-link-btn" data-stock-site="${esc(row.site_code)}">${esc(row.site_code)}</button><div class="om-shop">${esc(row.shop || '')}</div></td>
      <td>${row.report_date ? `${esc(fmtDate(row.report_date))}<div class="hint">${esc(row.report_kind || '')}</div>` : '<span class="om-muted">—</span>'}</td>
      <td>${fmtMoney(row.total_excess)}</td>
      <td>${fmtMoney(row.total_soh)}</td>
      <td>${fmtRatio(row.ratio)}</td>
      <td>${deltaHtml(row.wow_delta_pt)}</td>
      <td>${esc(String(row.sku_count_0sale ?? '—'))} / ${esc(String(row.total_sku_carry ?? '—'))}${row.rf_sku_count !== null && row.rf_sku_count !== undefined ? `<div class="hint">RF ${esc(String(row.rf_sku_count))}</div>` : ''}</td>
      <td>${fmtRatio(row.ovs_carry_ratio)}${row.ovs_wow_delta_pt == null ? '' : `<div class="hint">${deltaHtml(row.ovs_wow_delta_pt)}</div>`}</td>
    </tr>`).join('');
    body.querySelectorAll('[data-stock-site]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if ($('om_stock_site')) $('om_stock_site').value = btn.dataset.stockSite;
        loadStock();
      });
    });
  }

  async function loadStock() {
    const site = $('om_stock_site')?.value || '';
    try {
      const data = await omApi(`/api/portal/om/stock${site ? `?site_code=${encodeURIComponent(site)}` : ''}`);
      renderStockKpi(data);
      renderStockChart(data);
      renderSkuChart(data);
      renderStockStores(data);
      showAlert($('om_stock_error'), '', '');
    } catch (err) {
      showAlert($('om_stock_error'), 'error', esc(err.message));
    }
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    $('om_login_form')?.addEventListener('submit', login);
    $('om_logout_link')?.addEventListener('click', logout);
    $('om_refresh')?.addEventListener('click', async () => {
      await loadOverview();
      if ($('tab_om_zero')?.getAttribute('aria-selected') === 'true') await loadZeroTab();
      if ($('tab_om_dsku')?.getAttribute('aria-selected') === 'true' && window.omDesignatedSku) await window.omDesignatedSku.load();
      if ($('tab_om_stock')?.getAttribute('aria-selected') === 'true') await loadStock();
    });
    $('om_zs_refresh')?.addEventListener('click', () => loadZeroTab());
    $('om_zs_batch')?.addEventListener('change', () => loadZeroItems());
    $('om_zs_site')?.addEventListener('change', () => loadZeroItems());
    $('om_zs_status')?.addEventListener('change', () => loadZeroItems());
    $('om_zs_search')?.addEventListener('input', () => {
      clearTimeout(state.zero.searchTimer);
      state.zero.searchTimer = setTimeout(() => loadZeroItems(), 350);
    });
    $('om_zs_cancel')?.addEventListener('click', () => $('om_zs_dialog')?.close());
    $('om_zs_save')?.addEventListener('click', saveZeroReply);
    $('om_stock_refresh')?.addEventListener('click', () => loadStock());
    $('om_stock_site')?.addEventListener('change', () => loadStock());
    bindTabs();
  }

  function initialTab() {
    const hash = window.location.hash;
    if (hash === '#zero') return 'tab_om_zero';
    if (hash === '#designated-sku' || hash === '#ds') return 'tab_om_dsku';
    if (hash === '#stock') return 'tab_om_stock';
    return 'tab_om_overview';
  }

  async function init() {
    bindEvents();
    const name = new URLSearchParams(window.location.search).get('user');
    if (name && $('om_login_name')) $('om_login_name').value = name;
    await checkSession();
    if (state.user) {
      const tab = initialTab();
      if (tab !== 'tab_om_overview') activateTab(tab);
      else activateTab('tab_om_overview', { silent: true });
    }
  }

  // 供 om-designated-sku.js 使用
  window.omApp = {
    api: omApi,
    state,
    esc,
    fmtDate,
    fmtMoney,
    fmtRatio,
    fmtPt,
    deltaHtml,
    storeLabel,
    showAlert,
    refreshOverview,
    ensureCsrf,
  };

  init();
})();
