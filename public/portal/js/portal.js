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
      if (res.status === 401) {
        window.location.href = '/portal/';
        throw new Error('登入已過期');
      }
      const err = new Error(data?.error || `請求失敗 (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
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
