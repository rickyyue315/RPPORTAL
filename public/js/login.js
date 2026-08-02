(() => {
  const $ = (id) => document.getElementById(id);

  async function getCsrfToken() {
    const data = await api('/api/csrf').catch(() => ({ token: null }));
    return data?.token;
  }

  $('login_form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showAlert($('login_error'), '', '');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const token = await getCsrfToken();
      const data = await api('/api/admin/login', {
        method: 'POST',
        headers: { 'x-csrf-token': token || '' },
        body: JSON.stringify({
          username: $('username').value.trim(),
          password: $('password').value,
        }),
      });
      if (data.ok) {
        window.location.href = '/admin/index.html';
      }
    } catch (err) {
      showAlert($('login_error'), 'error', escapeHtml(err.message));
    } finally {
      btn.disabled = false;
    }
  });
})();
