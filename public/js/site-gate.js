/* Public site gate — same pattern as 90日零銷售回覆.
 * Shop inputs Site Code once, it is validated via /api/public/stores/:code,
 * remembered in localStorage (same key as portal.js: 'ndrf_site') and shared
 * across Urgent / Sales / Return / Lookup pages. The Site Code field is then
 * locked to the recognised shop; switching is done via the switch button.
 */
(() => {
  const SITE_KEY = 'ndrf_site';
  const SHOP_KEY = 'ndrf_shop';

  function storedSite() {
    try { return (localStorage.getItem(SITE_KEY) || '').trim().toUpperCase(); } catch { return ''; }
  }
  function storedShop() {
    try { return localStorage.getItem(SHOP_KEY) || ''; } catch { return ''; }
  }
  function rememberSite(site, shop) {
    try {
      localStorage.setItem(SITE_KEY, site);
      if (shop) localStorage.setItem(SHOP_KEY, shop);
    } catch {}
  }
  function clearSite() {
    try {
      localStorage.removeItem(SITE_KEY);
      localStorage.removeItem(SHOP_KEY);
    } catch {}
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  async function fetchStore(code) {
    const res = await fetch(`/api/public/stores/${encodeURIComponent(code)}`, { credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || 'Site Code 不存在');
    return data.store;
  }

  function showSiteGate(initial) {
    return new Promise((resolve) => {
      const old = document.getElementById('site_gate');
      if (old) old.remove();
      const overlay = document.createElement('div');
      overlay.id = 'site_gate';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', '選擇店舖');
      overlay.innerHTML =
        '<div class="site-gate-card">' +
          '<h1>選擇店舖</h1>' +
          '<p class="hint">請輸入你店舖嘅 Site Code（例如 HA02），輸入一次後所有頁面（90日零銷售、Urgent、突發性銷售、行貨退貨）會自動認到係你嘅店舖。店舖首頁為「90日零銷售回覆」。</p>' +
          '<div id="site_gate_error"></div>' +
          '<label for="site_gate_input">Site Code</label>' +
          '<input type="text" id="site_gate_input" autocomplete="off" placeholder="例如 HA02">' +
          '<div class="btn-row" style="margin-top:16px">' +
            '<button class="btn" type="button" id="site_gate_go">進入</button>' +
            '<a class="btn ghost" href="/portal/zero-sales.html">先去零銷售回覆（店舖首頁）</a>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#site_gate_input');
      const errBox = overlay.querySelector('#site_gate_error');
      const btn = overlay.querySelector('#site_gate_go');
      if (initial) input.value = initial;
      const showErr = (msg) => {
        errBox.innerHTML = msg ? `<div class="alert error">${esc(msg)}</div>` : '';
      };
      const go = async () => {
        const code = (input.value || '').trim().toUpperCase();
        if (!code) { showErr('請輸入 Site Code'); return; }
        btn.disabled = true;
        btn.textContent = '載入中…';
        showErr('');
        try {
          const store = await fetchStore(code);
          rememberSite(store.site_code || code, store.shop || '');
          overlay.remove();
          resolve({ site_code: store.site_code || code, shop: store.shop || '' });
        } catch (err) {
          showErr(err.message || 'Site Code 不存在');
          btn.disabled = false;
          btn.textContent = '進入';
        }
      };
      btn.addEventListener('click', go);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
      setTimeout(() => input.focus(), 50);
    });
  }

  function ensureLockBar() {
    let bar = document.getElementById('site_lock_bar');
    if (bar) return bar;
    const anchor = document.getElementById('site_code');
    if (!anchor) return null;
    bar = document.createElement('div');
    bar.id = 'site_lock_bar';
    bar.className = 'site-lock-bar';
    anchor.parentElement.insertBefore(bar, anchor.nextSibling);
    // Keep the raw input for submission but lock it visually.
    return bar;
  }

  function renderLockBar(site, shop) {
    const bar = ensureLockBar();
    if (!bar) return;
    bar.innerHTML =
      `<span class="site-lock-text">已認店：<b>${esc(site)}</b>${shop ? `（${esc(shop)}）` : ''}</span>` +
      ' <button type="button" class="btn ghost btn-switch-site" id="btn_switch_site">轉換店舖</button>';
    const btn = bar.querySelector('#btn_switch_site');
    if (btn) {
      btn.addEventListener('click', async () => {
        clearSite();
        const input = document.getElementById('site_code');
        if (input) { input.value = ''; input.readOnly = false; }
        const info = document.getElementById('store_info');
        if (info) info.textContent = '—';
        const next = await showSiteGate('');
        applySiteToPage(next.site_code, next.shop);
      });
    }
  }

  function applySiteToPage(site, shop) {
    const input = document.getElementById('site_code');
    if (input) {
      input.value = site;
      input.readOnly = true;
      input.setAttribute('aria-readonly', 'true');
      // Trigger the page's own validateSite (urgent.js / sales.js / return.js
      // listen for input and fetch the shop name into #store_info).
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
      // Fallback display in case the page script has not run yet.
      const info = document.getElementById('store_info');
      if (info && shop && (info.textContent || '').trim() === '—') {
        info.innerHTML = `<b>${esc(shop)}</b>`;
      }
    }
    renderLockBar(site, shop);
    // Excel hint: rows must belong to the locked shop.
    const drop = document.getElementById('file_drop');
    if (drop && site && !document.getElementById('site_excel_hint')) {
      const hint = document.createElement('div');
      hint.id = 'site_excel_hint';
      hint.className = 'hint';
      hint.style.marginTop = '8px';
      hint.innerHTML = `已鎖定店舖 <b>${esc(site)}</b>，Excel 內所有 Site Code 須為同一店舖。`;
      drop.parentElement.insertBefore(hint, drop);
    }
  }

  async function initPublicSiteGate() {
    const hasSiteInput = !!document.getElementById('site_code');
    const qSite = document.getElementById('q_site');
    const rSite = document.getElementById('r_site');

    // Lookup page: auto-fill from remembered shop, no forced gate.
    if (!hasSiteInput && (qSite || rSite)) {
      const s = storedSite();
      if (s) {
        if (qSite && !qSite.value) qSite.value = s;
        if (rSite && !rSite.value) rSite.value = s;
      }
      return;
    }
    if (!hasSiteInput) return;

    let site = storedSite();
    let shop = storedShop();
    if (site) {
      try {
        const store = await fetchStore(site);
        site = store.site_code || site;
        shop = store.shop || shop;
        rememberSite(site, shop);
        applySiteToPage(site, shop);
        return;
      } catch {
        clearSite();
        site = '';
      }
    }
    const next = await showSiteGate(site || '');
    applySiteToPage(next.site_code, next.shop);
  }

  window.PublicSiteGate = {
    ensure: initPublicSiteGate,
    getSite: storedSite,
    clear: clearSite,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPublicSiteGate);
  } else {
    initPublicSiteGate();
  }
})();
