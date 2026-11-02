/* Admin 平台通告：店舖／OM 一開頁見到的橫幅，由此處新增、排程、停用、重新推送。
   獨立模組，唔改 admin.js 既有流程；卡片捲到視線內才載入。 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CARD = $('notice_list_card');
  if (!CARD) return;

  let csrf = null;
  let loaded = false;
  let editingId = null;
  let notices = [];

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  function alertHtml(type, message) {
    const kind = type === 'danger' ? 'error' : type;
    return `<div class="alert ${kind}">${esc(message)}</div>`;
  }

  async function getCsrf(force = false) {
    if (force || !csrf) {
      const d = await fetch('/api/csrf', { credentials: 'same-origin' }).then((r) => r.json());
      csrf = d.token;
    }
    return csrf;
  }

  async function aFetch(url, opts = {}, retried = false) {
    const token = await getCsrf();
    const headers = { ...(opts.headers || {}), 'x-csrf-token': token };
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // Cookie 過期或被其他分頁換過：重取 token 再試一次（與其他 admin 模組一致）
      if (res.status === 403 && !retried) {
        await getCsrf(true);
        return aFetch(url, opts, true);
      }
      const err = new Error(data?.error || `請求失敗 (${res.status})`);
      err.data = data;
      throw err;
    }
    return data;
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** ISO → 瀏覽器本地時間，供 datetime-local 輸入框使用。 */
  function isoToLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** datetime-local 的值是本地時間；轉成 ISO（含時區位移）交給後端。 */
  function localInputToIso(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function formatHk(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function statusOf(notice) {
    if (!notice.is_active) return { label: '已停用', cls: 'bg-secondary-lt' };
    const now = Date.now();
    if (notice.starts_at && new Date(notice.starts_at).getTime() > now) {
      return { label: '未開始', cls: 'bg-yellow-lt' };
    }
    if (notice.ends_at && new Date(notice.ends_at).getTime() <= now) {
      return { label: '已結束', cls: 'bg-secondary-lt' };
    }
    return { label: '生效中', cls: 'bg-green-lt' };
  }

  function periodOf(notice) {
    if (!notice.starts_at && !notice.ends_at) return '即日起，長期';
    const from = notice.starts_at ? formatHk(notice.starts_at) : '即日起';
    const to = notice.ends_at ? formatHk(notice.ends_at) : '長期';
    return `${from} → ${to}`;
  }

  function renderRows() {
    const body = $('notice_rows');
    if (!notices.length) {
      body.innerHTML = '<tr><td colspan="5" class="text-center text-secondary">暫時未有通告。按右上角「新增通告」開始。</td></tr>';
      return;
    }
    body.innerHTML = notices.map((n) => {
      const status = statusOf(n);
      return `<tr>
        <td>
          <div class="fw-bold">${esc(n.title)}</div>
          ${n.body ? `<div class="text-secondary small">${esc(n.body).slice(0, 80)}${n.body.length > 80 ? '…' : ''}</div>` : ''}
        </td>
        <td><span class="badge ${status.cls}">${status.label}</span></td>
        <td class="text-secondary small">${esc(periodOf(n))}</td>
        <td class="text-secondary small">v${n.revision}</td>
        <td class="text-nowrap">
          <button class="btn btn-sm btn-ghost" type="button" data-act="edit" data-id="${n.id}">編輯</button>
          <button class="btn btn-sm btn-ghost" type="button" data-act="republish" data-id="${n.id}" title="版本 +1，所有店舖（包括已按 X 的）會再見一次">重新推送</button>
          <button class="btn btn-sm btn-ghost text-danger" type="button" data-act="delete" data-id="${n.id}">刪除</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function loadNotices() {
    try {
      const data = await aFetch('/api/admin/notices');
      notices = data.notices ?? [];
      loaded = true;
      renderRows();
    } catch (err) {
      $('notice_rows').innerHTML = `<tr><td colspan="5" class="text-center text-secondary">載入失敗：${esc(err.message)}</td></tr>`;
    }
  }

  function openEditor(notice) {
    editingId = notice?.id ?? null;
    $('notice_editor_heading').textContent = notice ? '編輯通告' : '新增通告';
    $('notice_title').value = notice?.title ?? '';
    $('notice_body').value = notice?.body ?? '';
    $('notice_link_text').value = notice?.link_text ?? '';
    $('notice_link_url').value = notice?.link_url ?? '';
    $('notice_tone').value = notice?.tone ?? 'info';
    $('notice_start').value = isoToLocalInput(notice?.starts_at);
    $('notice_end').value = isoToLocalInput(notice?.ends_at);
    $('notice_active').checked = notice ? Boolean(notice.is_active) : true;
    $('notice_result').innerHTML = '';
    $('notice_editor_card').hidden = false;
    $('notice_title').focus();
  }

  function closeEditor() {
    editingId = null;
    $('notice_editor_card').hidden = true;
  }

  function payloadFromForm() {
    return {
      title: $('notice_title').value.trim(),
      body: $('notice_body').value.trim(),
      linkText: $('notice_link_text').value.trim() || null,
      linkUrl: $('notice_link_url').value.trim() || null,
      tone: $('notice_tone').value,
      isActive: $('notice_active').checked,
      startsAt: localInputToIso($('notice_start').value),
      endsAt: localInputToIso($('notice_end').value),
    };
  }

  async function save() {
    const payload = payloadFromForm();
    if (!payload.title) {
      $('notice_result').innerHTML = alertHtml('danger', '請輸入標題。');
      return;
    }
    const btn = $('btn_notice_save');
    btn.disabled = true;
    try {
      const url = editingId ? `/api/admin/notices/${editingId}` : '/api/admin/notices';
      await aFetch(url, {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      closeEditor();
      $('notice_result').innerHTML = alertHtml('success', editingId ? '已更新通告。' : '已新增通告，店舖下次開頁即見。');
      await loadNotices();
    } catch (err) {
      $('notice_result').innerHTML = alertHtml('danger', err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function remove(id) {
    const notice = notices.find((n) => n.id === id);
    if (!window.confirm(`刪除通告「${notice?.title ?? ''}」？\n\n店舖不會再見到它，已關閉的記號亦會失效。`)) return;
    try {
      await aFetch(`/api/admin/notices/${id}`, { method: 'DELETE' });
      $('notice_result').innerHTML = alertHtml('success', '已刪除通告。');
      await loadNotices();
    } catch (err) {
      $('notice_result').innerHTML = alertHtml('danger', err.message);
    }
  }

  async function republish(id) {
    const notice = notices.find((n) => n.id === id);
    if (!window.confirm(`重新推送「${notice?.title ?? ''}」？\n\n所有店舖（包括之前已按 X 關閉的）都會再見一次這條通告。`)) return;
    try {
      const data = await aFetch(`/api/admin/notices/${id}/republish`, { method: 'POST' });
      $('notice_result').innerHTML = alertHtml('success', `已重新推送（版本 v${data.notice?.revision ?? ''}）。`);
      await loadNotices();
    } catch (err) {
      $('notice_result').innerHTML = alertHtml('danger', err.message);
    }
  }

  $('btn_notice_new')?.addEventListener('click', () => openEditor(null));
  $('btn_notice_cancel')?.addEventListener('click', closeEditor);
  $('btn_notice_save')?.addEventListener('click', save);

  $('notice_rows')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === 'edit') openEditor(notices.find((n) => n.id === id) ?? null);
    else if (act === 'republish') republish(id);
    else if (act === 'delete') remove(id);
  });

  // 捲到卡片才載入（與其他 admin 卡片一致，切分頁不會一次過打所有 API）
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    if (!loaded) loadNotices();
  }, { rootMargin: '120px' });
  observer.observe(CARD);
})();
