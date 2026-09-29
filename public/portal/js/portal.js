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
