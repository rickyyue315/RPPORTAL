/* Public site gate — shared Store Portal login.
 * Every shop page (90日零銷售回覆、一般 NDRF、Urgent、突發性銷售、行貨退貨)
 * uses the SAME login: Site Code + 密碼 creates one portal session, so
 * logging in on any page unlocks all the others. The session is enforced
 * server-side on submissions; credentials are remembered on this device
 * (same keys as portal.js: 'ndrf_site' / 'ndrf_portal_pass') so return
 * visits stay automatic. Switching shops is done via the switch button.
 */
(() => {
  const SITE_KEY = 'ndrf_site';
  const SHOP_KEY = 'ndrf_shop';
  const PASS_KEY = 'ndrf_portal_pass';

  function storedSite() {
    try { return (localStorage.getItem(SITE_KEY) || '').trim().toUpperCase(); } catch { return ''; }
  }
  function storedShop() {
    try { return localStorage.getItem(SHOP_KEY) || ''; } catch { return ''; }
  }
  function storedPass() {
    try { return localStorage.getItem(PASS_KEY) || ''; } catch { return ''; }
  }
  function rememberSite(site, shop) {
    try {
      localStorage.setItem(SITE_KEY, site);
      if (shop) localStorage.setItem(SHOP_KEY, shop);
    } catch {}
  }
  function rememberPass(pass) {
    try { localStorage.setItem(PASS_KEY, pass); } catch {}
  }
  function clearSite() {
    try {
      localStorage.removeItem(SITE_KEY);
      localStorage.removeItem(SHOP_KEY);
      localStorage.removeItem(PASS_KEY);
    } catch {}
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  async function fetchMe() {
    try {
      const res = await fetch('/api/portal/auth/me', { credentials: 'same-origin' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Real portal login: sets the same session cookie as the portal pages. */
  async function loginPortal(username, password) {
    const res = await fetch('/api/portal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username, password }),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || '登入失敗，請稍後再試');
    return data;
  }

  async function fetchStore(code) {
    const res = await fetch(`/api/public/stores/${encodeURIComponent(code)}`, { credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || 'Site Code 不存在');
    return data.store;
  }

  async function applySessionSite(siteCode) {
    let shop = '';
    try {
      const store = await fetchStore(siteCode);
      shop = store.shop || '';
    } catch {}
    rememberSite(siteCode, shop);
    return { site_code: siteCode, shop };
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
          '<p class="hint">請輸入你店舖嘅 Site Code（例如 HA02）及密碼，輸入一次後所有頁面（90日零銷售、Urgent、突發性銷售、行貨退貨）會自動認到係你嘅店舖。店舖首頁為「90日零銷售回覆」。</p>' +
          '<div id="site_gate_error"></div>' +
          '<label for="site_gate_input">Site Code</label>' +
          '<input type="text" id="site_gate_input" autocomplete="off" placeholder="例如 HA02">' +
          '<label for="site_gate_pass" style="margin-top:12px">密碼</label>' +
          '<input type="password" id="site_gate_pass" autocomplete="current-password" placeholder="密碼">' +
          '<div class="btn-row" style="margin-top:16px">' +
            '<button class="btn" type="button" id="site_gate_go">進入</button>' +
            '<a class="btn ghost" href="/portal/zero-sales.html">先去零銷售回覆（店舖首頁）</a>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#site_gate_input');
      const passInput = overlay.querySelector('#site_gate_pass');
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
          const me = await loginPortal(code, passInput.value);
          const user = me && me.user;
          if (user && (user.role === 'buyer' || user.role === 'sct')) {
            window.location.href = '/portal/reviewer.html';
            return;
          }
          if (!user || user.role !== 'store' || !user.site_code) throw new Error('帳戶無效');
          rememberPass(passInput.value);
          const applied = await applySessionSite(user.site_code);
          overlay.remove();
          resolve(applied);
        } catch (err) {
          showErr(err.message || '登入失敗');
          btn.disabled = false;
          btn.textContent = '進入';
        }
      };
      btn.addEventListener('click', go);
      const submitOnEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
      input.addEventListener('keydown', submitOnEnter);
      passInput.addEventListener('keydown', submitOnEnter);
      input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
      setTimeout(() => (initial ? passInput : input).focus(), 50);
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
        try {
          // The shared session is bound to one store; drop it so the next
          // login re-creates it for the other shop.
          await fetch('/api/portal/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch {}
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

    // One shared session across every shop page.
    const me = await fetchMe();
    if (me && me.user && (me.user.role === 'buyer' || me.user.role === 'sct')) {
      window.location.href = '/portal/reviewer.html';
      return;
    }
    const sessionSite = me && me.user && me.user.role === 'store' ? me.user.site_code : '';

    // Lookup page: auto-fill from session or remembered shop, no forced gate.
    if (!hasSiteInput) {
      const site = sessionSite || storedSite();
      if (site) {
        if (qSite && !qSite.value) qSite.value = site;
        if (rSite && !rSite.value) rSite.value = site;
      }
      return;
    }

    // 1) Live session (e.g. logged in on 零銷售回覆 already) → straight in.
    if (sessionSite) {
      const applied = await applySessionSite(sessionSite);
      applySiteToPage(applied.site_code, applied.shop);
      return;
    }

    // 2) Remembered credentials → silent re-login.
    const remembered = storedSite();
    const pass = storedPass();
    if (remembered && pass) {
      try {
        await loginPortal(remembered, pass);
        const me2 = await fetchMe();
        if (me2 && me2.user && me2.user.role === 'store' && me2.user.site_code) {
          const applied = await applySessionSite(me2.user.site_code);
          applySiteToPage(applied.site_code, applied.shop);
          return;
        }
      } catch {
        clearSite();
      }
    } else if (remembered) {
      clearSite();
    }

    // 3) Ask for Site Code + 密碼.
    const next = await showSiteGate('');
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
