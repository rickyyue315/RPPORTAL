/* Admin 90日零銷售批次管理 (獨立於 admin.js，避免衝突) */
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = null;
  let currentBatch = null;

  async function getCsrf() {
    if (!csrf) {
      const d = await fetch('/api/csrf', { credentials: 'same-origin' }).then((r) => r.json());
      csrf = d.token;
    }
    return csrf;
  }
  async function aFetch(url, opts = {}) {
    const token = await getCsrf();
    const headers = { ...(opts.headers || {}), 'x-csrf-token': token };
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `請求失敗 (${res.status})`);
    return data;
  }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  async function loadBatches() {
    const body = $('zs_batches_body');
    if (!body) return;
    try {
      const data = await aFetch('/api/admin/zero-sales/batches');
      const rows = data.batches || [];
      if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="text-center text-secondary">暫無批次</td></tr>'; return; }
      body.innerHTML = rows.map((b) => `<tr>
        <td><b>${esc(b.week_label)}</b><div class="text-secondary small">${esc(b.note || '')}</div></td>
        <td>${b.row_count}</td><td>${b.store_count}</td>
        <td class="text-success">${b.replied_count ?? 0}</td><td class="text-danger">${b.pending_count ?? 0}</td>
        <td>${esc(b.created_by)}</td><td>${esc(b.created_at)}</td>
        <td><div class="d-flex gap-1 flex-wrap">
          <button class="btn btn-sm" data-zs-view="${b.id}">明細</button>
          <a class="btn btn-sm btn-outline-primary" href="/api/admin/zero-sales/batches/${b.id}/export">匯出</a>
        </div></td></tr>`).join('');
      body.querySelectorAll('[data-zs-view]').forEach((btn) => {
        btn.addEventListener('click', () => { currentBatch = btn.dataset.zsView; loadItems(); });
      });
      if (!currentBatch && rows[0]) currentBatch = rows[0].id;
    } catch (err) {
      body.innerHTML = `<tr><td colspan="8" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  async function loadItems() {
    const res = $('zs_items_result');
    const body = $('zs_items_body');
    if (!currentBatch) { if (res) res.innerHTML = '<div class="alert alert-info">請先選擇批次</div>'; return; }
    const site = ($('zs_filter_site').value || '').trim();
    const status = $('zs_filter_status').value;
    const qs = new URLSearchParams();
    if (site) qs.set('site_code', site);
    if (status) qs.set('status', status);
    try {
      const data = await aFetch(`/api/admin/zero-sales/batches/${currentBatch}/items?${qs.toString()}`);
      const rows = data.items || [];
      if (res) res.innerHTML = `<div class="text-secondary small">批次 ${esc(currentBatch.slice(0, 8))}｜共 ${rows.length} 筆｜已回覆 ${rows.filter((r) => r.status === 'replied').length}｜已鎖定（用完修改） ${rows.filter((r) => (r.reply_count ?? (r.status === 'replied' ? 1 : 0)) >= 2).length} <a href="/api/admin/zero-sales/batches/${currentBatch}/export">匯出 Excel</a></div>`;
      body.innerHTML = rows.slice(0, 200).map((i) => {
        const n = i.reply_count ?? (i.status === 'replied' ? 1 : 0);
        const upDate = i.batch_date || (i.batch_created_at || '').slice(0, 10);
        const lockTag = n >= 2 ? ' <span class="badge bg-secondary">已鎖定</span>' : n === 1 ? ' <span class="text-secondary small">可再改1次</span>' : '';
        return `<tr>
        <td>${esc(i.site_code)}</td><td>${esc(i.sku)}</td>
        <td>${esc(i.payload?.['Brand'] || '')}</td><td>${esc(i.payload?.['SKU Desc'] || '')}</td>
        <td>${esc(upDate)}</td>
        <td>${i.status === 'replied' ? '<span class="badge bg-success">已回覆</span>' : '<span class="badge bg-warning">未回覆</span>'}</td>
        <td>${n}次${lockTag}</td>
        <td>${esc(i.reason_label || '')}${i.reason_note ? `（${esc(i.reason_note)}）` : ''}</td></tr>`;
      }).join('')
        + (rows.length > 200 ? `<tr><td colspan="8" class="text-center text-secondary">只顯示首 200 筆，請匯出 Excel 查看全部</td></tr>` : '');
    } catch (err) {
      if (res) res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  async function upload() {
    const res = $('zs_upload_result');
    const file = $('zs_file').files[0];
    const week = ($('zs_week').value || '').trim();
    if (!week) { res.innerHTML = '<div class="alert alert-danger">請填寫週次</div>'; return; }
    if (!file) { res.innerHTML = '<div class="alert alert-danger">請選擇 .xlsx</div>'; return; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('week_label', week);
    fd.append('note', $('zs_note').value || '');
    res.innerHTML = '<div class="alert alert-info">上載中…</div>';
    try {
      const data = await aFetch('/api/admin/zero-sales/batches', { method: 'POST', body: fd });
      res.innerHTML = `<div class="alert alert-success">已建立批次（${data.totalRows} 行）</div>`;
      $('zs_file').value = '';
      await loadBatches();
    } catch (err) {
      let html = `<div class="alert alert-danger">${esc(err.message)}</div>`;
      try {
        // aFetch 已拋出 Error，但後端 errors 在 response；重新抓一次顯示
      } catch {}
      res.innerHTML = html;
    }
  }

  function init() {
    if (!$('zs_batches_body')) return;
    $('btn_zs_upload').addEventListener('click', upload);
    $('btn_zs_view').addEventListener('click', loadItems);
    const reasonBtn = $('btn_zs_reason_save');
    if (reasonBtn) reasonBtn.addEventListener('click', saveReason);
    loadBatches();
    loadReasons();
  }

  async function loadReasons() {
    const body = $('zs_reasons_body');
    if (!body) return;
    try {
      const data = await aFetch('/api/admin/zero-sales/reasons');
      const rows = data.reasons || [];
      if (!rows.length) { body.innerHTML = '<tr><td colspan="6" class="text-center text-secondary">暫無原因</td></tr>'; return; }
      body.innerHTML = rows.map((r) => `<tr>
        <td>${esc(r.code)}</td><td>${esc(r.label)}</td><td>${r.sort_order}</td>
        <td>${r.require_note ? '是' : '否'}</td><td>${r.active ? '<span class="badge bg-success">啟用</span>' : '<span class="badge bg-secondary">停用</span>'}</td>
        <td><div class="d-flex gap-1">
          <button class="btn btn-sm" data-zs-reason-edit="${esc(r.code)}">編輯</button>
          <button class="btn btn-sm btn-outline-danger" data-zs-reason-toggle="${esc(r.code)}" data-active="${r.active ? 0 : 1}">${r.active ? '停用' : '啟用'}</button>
        </div></td></tr>`).join('');
      body.querySelectorAll('[data-zs-reason-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = rows.find((x) => x.code === btn.dataset.zsReasonEdit);
          if (!row) return;
          $('zs_reason_code').value = row.code;
          $('zs_reason_label').value = row.label;
          $('zs_reason_sort').value = row.sort_order;
          $('zs_reason_reqnote').value = String(Boolean(row.require_note));
          $('zs_reason_active').value = String(Boolean(row.active));
          $('zs_reason_label').focus();
        });
      });
      body.querySelectorAll('[data-zs-reason-toggle]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = rows.find((x) => x.code === btn.dataset.zsReasonToggle);
          if (!row) return;
          await aFetch('/api/admin/zero-sales/reasons', {
            method: 'PUT',
            body: JSON.stringify({ code: row.code, label: row.label, sort_order: row.sort_order, active: btn.dataset.active === '1', require_note: row.require_note }),
          });
          await loadReasons();
        });
      });
    } catch (err) {
      body.innerHTML = `<tr><td colspan="6" class="text-center text-danger">${esc(err.message)}</td></tr>`;
    }
  }

  async function saveReason() {
    const res = $('zs_reason_result');
    const code = ($('zs_reason_code').value || '').trim();
    const label = ($('zs_reason_label').value || '').trim();
    if (!code || !label) { res.innerHTML = '<div class="alert alert-danger">Code 及顯示名稱為必填</div>'; return; }
    try {
      await aFetch('/api/admin/zero-sales/reasons', {
        method: 'PUT',
        body: JSON.stringify({
          code,
          label,
          sort_order: Number($('zs_reason_sort').value || 0),
          active: $('zs_reason_active').value === 'true',
          require_note: $('zs_reason_reqnote').value === 'true',
        }),
      });
      res.innerHTML = '<div class="alert alert-success">已儲存</div>';
      await loadReasons();
    } catch (err) {
      res.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
