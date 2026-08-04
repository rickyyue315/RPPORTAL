(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('login_form');
  const errorEl = $('login_error');
  let csrfToken = null;

  (async () => {
    try {
      const data = await api('/api/csrf');
      csrfToken = data.token;
    } catch {
      // CSRF cookie 由 /api/csrf 設定；失敗時仍嘗試提交。
    }
  })();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showAlert(errorEl, '', '');
    const btn = $('btn_login');
    btn.disabled = true;
    btn.textContent = '登入中…';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        body: JSON.stringify({
          username: $('login_username').value.trim(),
          password: $('login_password').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `登入失敗 (${res.status})`);
      }
      window.location.href = '/admin/index.html';
    } catch (err) {
      showAlert(errorEl, 'error', escapeHtml(err.message));
      btn.disabled = false;
      btn.textContent = '登入';
    }
  });
})();
