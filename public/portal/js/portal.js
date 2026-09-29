/* Shared helpers for the Store / Buyer / SCT portal pages. */
(() => {
  let _csrfToken = null;

  async function ensureCsrf() {
    if (_csrfToken) return _csrfToken;
    try {
      const data = await fetch('/api/csrf', { credentials: 'same-origin' }).then((r) => r.json());
      _csrfToken = data?.token ?? '';
    } catch {
      _csrfToken = '';
    }
    return _csrfToken;
  }

  async function portalApi(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
      const token = await ensureCsrf();
      headers['X-CSRF-Token'] = token;
    }
    const res = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401 && !options.noRedirect) {
        // Keep ?user= so the login page can pick it up again.
        window.location.href = '/portal/' + window.location.search;
        throw new Error('登入已過期');
      }
      if (res.status === 401) {
        const err = new Error(data?.error || '登入已過期');
        err.status = res.status;
        err.data = data;
        throw err;
      }
      const err = new Error(data?.error || `請求失敗 (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function presetUsername() {
    try {
      const v = new URLSearchParams(window.location.search).get('user');
      return v && v.trim() ? v.trim() : '';
    } catch {
      return '';
    }
  }

  const SITE_KEY = 'ndrf_site';
  function storedSite() {
    try {
      return localStorage.getItem(SITE_KEY) || '';
    } catch {
      return '';
    }
  }
  function rememberSite(site) {
    try {
      localStorage.setItem(SITE_KEY, site);
    } catch {}
  }

  async function silentLogin(username) {
    await portalApi('/api/portal/auth/login', {
      method: 'POST',
      noRedirect: true,
      body: JSON.stringify({ username }),
    });
    return portalApi('/api/portal/auth/me', { noRedirect: true });
  }

  function showSiteGate() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'site_gate';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.96);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
      overlay.innerHTML = `<div class="portal-login-card" style="margin:0">
        <h1>NDRF Store Portal</h1>
        <p class="hint">請輸入你店舖嘅 Site Code（例如 HA02），唔使密碼。</p>
        <div id="site_gate_error"></div>
        <label for="site_gate_input">Site Code</label>
        <input type="text" id="site_gate_input" autocomplete="off" placeholder="例如 HA02" style="text-transform:uppercase">
        <div class="btn-row" style="margin-top:16px">
          <button class="btn" type="button" id="site_gate_go">進入</button>
        </div>
      </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#site_gate_input');
      const go = async () => {
        const btn = overlay.querySelector('#site_gate_go');
        btn.disabled = true;
        btn.textContent = '載入中…';
        showAlert(overlay.querySelector('#site_gate_error'), '', '');
        try {
          const me = await silentLogin(input.value.trim());
          if ((me.user.role === 'buyer' || me.user.role === 'sct')) {
            window.location.href = '/portal/reviewer.html';
            return;
          }
          if (me.user.role !== 'store' || !me.user.site_code) throw new Error('帳戶無效');
          rememberSite(me.user.site_code);
          overlay.remove();
          resolve(me.user.site_code);
        } catch (err) {
          showAlert(overlay.querySelector('#site_gate_error'), 'error', escapeHtml(err.message));
          btn.disabled = false;
          btn.textContent = '進入';
        }
      };
      overlay.querySelector('#site_gate_go').addEventListener('click', go);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      setTimeout(() => input.focus(), 50);
    });
  }

  /**
   * Store page guard with no visible login: existing session, ?user= link,
   * remembered device, then a Site Code box on the page itself.
   * Resolves with the Site Code.
   */
  async function ensureStoreSite() {
    try {
      const me = await portalApi('/api/portal/auth/me', { noRedirect: true });
      if (me.user.role === 'store' && me.user.site_code) {
        rememberSite(me.user.site_code);
        return me.user.site_code;
      }
      if (me.user.role === 'buyer' || me.user.role === 'sct') {
        window.location.href = '/portal/reviewer.html';
        throw new Error('role');
      }
    } catch (err) {
      if (err && err.message === 'role') throw err;
    }
    for (const name of [presetUsername(), storedSite()]) {
      if (!name) continue;
      try {
        const me = await silentLogin(name);
        if (me.user.role === 'store' && me.user.site_code) {
          rememberSite(me.user.site_code);
          return me.user.site_code;
        }
        if (me.user.role === 'buyer' || me.user.role === 'sct') {
          window.location.href = '/portal/reviewer.html';
          throw new Error('role');
        }
      } catch (err) {
        if (err && err.message === 'role') throw err;
      }
    }
    try {
      localStorage.removeItem(SITE_KEY);
    } catch {}
    return showSiteGate();
  }

  function goLogin() {
    const name = presetUsername();
    window.location.href = name ? `/portal/?user=${encodeURIComponent(name)}` : '/portal/';
  }

  /**
   * Page guard for store / reviewer pages. Returns the logged-in user when
   * their role is allowed. When the session is missing but the link carries
   * ?user=, it logs in automatically so deep links (e.g. zero-sales.html)
   * open directly with no extra click.
   */
  async function ensureUser(roles) {
    const check = (me) => {
      if (me && me.user && roles.includes(me.user.role)) return me;
      goLogin();
      throw new Error('role');
    };
    try {
      return check(await portalApi('/api/portal/auth/me', { noRedirect: true }));
    } catch (err) {
      const name = presetUsername();
      if (!name) {
        goLogin();
        throw err;
      }
      try {
        await portalApi('/api/portal/auth/login', {
          method: 'POST',
          noRedirect: true,
          body: JSON.stringify({ username: name }),
        });
        return check(await portalApi('/api/portal/auth/me', { noRedirect: true }));
      } catch (err2) {
        goLogin();
        throw err2;
      }
    }
  }

  async function portalMe() {
    return portalApi('/api/portal/auth/me');
  }

  async function portalLogout() {
    try {
      await portalApi('/api/portal/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch {}
    try {
      localStorage.removeItem(SITE_KEY);
    } catch {}
    window.location.href = '/portal/';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  function showAlert(el, type, message) {
    if (!el) return;
    el.innerHTML = `<div class="alert ${type}">${message}</div>`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const WORKFLOW_LABELS = {
    legacy: 'Legacy',
    pending: '待審批',
    ready_for_rp: '可供 RP 匯出',
    accepted: '已批准',
    rejected: '已拒絕',
  };

  const ROUTE_LABELS = {
    buyer: 'Buyer',
    sct: 'SCT',
    rp: 'RP',
    legacy: 'Legacy',
  };

  function workflowBadge(status) {
    const label = WORKFLOW_LABELS[status] ?? status ?? '—';
    return `<span class="badge badge-${status ?? 'unknown'}">${escapeHtml(label)}</span>`;
  }

  function statusTimeline(events) {
    if (!Array.isArray(events) || events.length === 0) return '<div class="hint">暫無審批紀錄</div>';
    return events.map((event) => {
      const labels = {
        remark: 'Review Remark',
        accept: '批准 (Accept)',
        reject: '拒絕 (Reject)',
        override: 'Admin Override',
        reopen: 'Admin Reopen',
      };
      const label = labels[event.event_type] ?? event.event_type;
      const detail = event.reject_reason_label
        ? `｜原因：${escapeHtml(event.reject_reason_label)}${event.reject_reason_note ? `（${escapeHtml(event.reject_reason_note)}）` : ''}`
        : '';
      const remark = event.remark ? `<div class="hint">Remark：${escapeHtml(event.remark)}</div>` : '';
      return `<div class="tl-item">
        <div><b>${escapeHtml(label)}</b>（第 ${event.review_round} 回合）${workflowBadge(event.event_type === 'accept' ? 'accepted' : event.event_type === 'reject' ? 'rejected' : '')}</div>
        <div class="hint">${escapeHtml(event.actor)}｜${escapeHtml(event.created_at)}</div>
        ${detail ? `<div class="hint">${detail}</div>` : ''}
        ${remark}
      </div>`;
    }).join('');
  }

  window.portal = {
    api: portalApi,
    me: portalMe,
    ensureUser,
    ensureStoreSite,
    presetUsername,
    logout: portalLogout,
    escapeHtml,
    showAlert,
    el,
    workflowBadge,
    statusTimeline,
    workflowLabels: WORKFLOW_LABELS,
    routeLabels: ROUTE_LABELS,
  };
})();
