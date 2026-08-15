(() => {
  const $ = (id) => document.getElementById(id);
  const p = window.portal;
  let currentMode = 'queue';
  let currentDetailId = null;

  function listTable(submissions, showRoute) {
    if (!submissions.length) return '<div class="hint">暫無申請</div>';
    return '<table><thead><tr>'
      + `<th>申請編號</th><th>Site Code</th><th>SKU</th><th>RP Type</th>${showRoute ? '<th>路由</th>' : ''}<th>狀態</th><th>提交時間</th><th></th></tr></thead><tbody>`
      + submissions.map((s) => `
        <tr>
          <td class="cell-appno">${p.escapeHtml(s.application_no)}</td>
          <td>${p.escapeHtml(s.site_code)}</td>
          <td>${p.escapeHtml(s.sku)}</td>
          <td>${p.escapeHtml(s.rp_type || '—')}</td>
          ${showRoute ? `<td>${p.escapeHtml(p.routeLabels[s.route] ?? s.route ?? '—')}</td>` : ''}
          <td>${p.workflowBadge(s.workflow_status)}</td>
          <td>${p.escapeHtml(s.submitted_at)}</td>
          <td><button class="btn ghost" data-detail="${s.id}">詳情</button></td>
        </tr>`).join('')
      + '</tbody></table>';
  }

  async function loadQueue() {
    const data = await p.api('/api/portal/reviewer/queue');
    $('queue_list').innerHTML = listTable(data.submissions, true);
    bindDetailButtons($('queue_list'));
  }

  async function loadHistory() {
    const data = await p.api('/api/portal/reviewer/history');
    $('history_list').innerHTML = listTable(data.submissions, true);
    bindDetailButtons($('history_list'));
  }

  function bindDetailButtons(container) {
    container.querySelectorAll('[data-detail]').forEach((btn) => {
      btn.addEventListener('click', () => showDetail(btn.dataset.detail));
    });
  }

  function showRejectForm() {
    const wrap = $('reject_wrap');
    const reasons = window.__rejectionReasons || [];
    if (!wrap) return;
    wrap.style.display = '';
    if (!$('reject_reason_code').options.length) {
      $('reject_reason_code').innerHTML = '<option value="">— 請選擇原因 —</option>'
        + reasons.map((r) => `<option value="${p.escapeHtml(r.code)}">${p.escapeHtml(r.label)}</option>`).join('');
    }
    $('reject_reason_note').value = '';
  }

  async function showDetail(id) {
    currentDetailId = id;
    const data = await p.api(`/api/portal/reviewer/submissions/${id}`);
    window.__rejectionReasons = data.rejectionReasons || [];
    const s = data.submission;
    const editable = s.workflow_status === 'pending' && !s.locked;
    $('detail_body').innerHTML = `
      <div class="dl">
        <dt>申請編號</dt><dd>${p.escapeHtml(s.application_no)}</dd>
        <dt>狀態</dt><dd>${p.workflowBadge(s.workflow_status)}</dd>
        <dt>Site Code</dt><dd>${p.escapeHtml(s.site_code)} ${p.escapeHtml(s.shop)}</dd>
        <dt>SKU</dt><dd>${p.escapeHtml(s.sku)}</dd>
        <dt>RP Type</dt><dd>${p.escapeHtml(s.rp_type || '—')}</dd>
        <dt>Safety stock</dt><dd>${p.escapeHtml(s.safety_stock || '—')}</dd>
        <dt>ND Code</dt><dd>${p.escapeHtml(s.nd_code || '—')}</dd>
        <dt>Remark</dt><dd>${p.escapeHtml(s.remark || '—')}</dd>
        ${s.rejected_at ? `<dt>拒絕時間</dt><dd>${p.escapeHtml(s.rejected_at)}</dd>` : ''}
      </div>
      <h3>審批時間線</h3>
      <div>${p.statusTimeline(data.events)}</div>
      ${editable ? `
        <h3>審批操作</h3>
        <div class="review-actions">
          <label>Review Remark</label>
          <textarea id="review_remark" rows="2"></textarea>
          <div class="btn-row">
            <button class="btn" id="btn_accept">批准 (Accept)</button>
            <button class="btn secondary" id="btn_reject">拒絕 (Reject)</button>
          </div>
          <div id="reject_wrap" style="display:none">
            <label>拒絕原因類別</label>
            <select id="reject_reason_code"></select>
            <label>補充說明 <span class="optional">（必填）</span></label>
            <textarea id="reject_reason_note" rows="2"></textarea>
            <div class="btn-row">
              <button class="btn" id="btn_confirm_reject">確認拒絕</button>
              <button class="btn ghost" id="btn_cancel_reject">取消</button>
            </div>
          </div>
          <div id="decision_error"></div>
        </div>` : ''}
    `;
    $('detail_card').style.display = '';
    $('detail_card').scrollIntoView({ behavior: 'smooth' });

    const btnAccept = $('btn_accept');
    const btnReject = $('btn_reject');
    if (btnAccept) btnAccept.addEventListener('click', () => decide('accept'));
    if (btnReject) btnReject.addEventListener('click', showRejectForm);
    const btnConfirm = $('btn_confirm_reject');
    if (btnConfirm) btnConfirm.addEventListener('click', () => decide('reject'));
    const btnCancel = $('btn_cancel_reject');
    if (btnCancel) btnCancel.addEventListener('click', () => { $('reject_wrap').style.display = 'none'; });
  }

  async function decide(decision) {
    const submissionId = currentDetailId;
    const payload = { decision };
    if (decision === 'accept') {
      payload.remark = $('review_remark')?.value.trim() || '';
    } else {
      payload.reject_reason_code = $('reject_reason_code')?.value || '';
      payload.reject_reason_note = $('reject_reason_note')?.value.trim() || '';
      payload.remark = $('review_remark')?.value.trim() || '';
    }
    const btn = decision === 'accept' ? $('btn_accept') : $('btn_confirm_reject');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    p.showAlert($('decision_error'), '', '');
    try {
      const res = await p.api(`/api/portal/reviewer/submissions/${submissionId}/decision`, {
        method: 'POST',
        headers: { 'Idempotency-Key': createIdempotencyKey() },
        body: JSON.stringify(payload),
      });
      p.showAlert($('decision_error'), 'success', `已${res.event?.event_type === 'reject' ? '拒絕' : '批准'}（${res.replayed ? '重複提交，已返回原結果' : ''}）`);
      await loadQueue();
      $('detail_card').style.display = 'none';
    } catch (err) {
      p.showAlert($('decision_error'), 'error', p.escapeHtml(err.message));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = decision === 'accept' ? '批准 (Accept)' : '確認拒絕'; }
    }
  }

  $('history_link').addEventListener('click', (e) => {
    e.preventDefault();
    currentMode = 'history';
    $('queue_card').style.display = 'none';
    $('history_card').style.display = '';
    loadHistory();
  });
  $('btn_back_queue').addEventListener('click', () => {
    currentMode = 'queue';
    $('history_card').style.display = 'none';
    $('queue_card').style.display = '';
    loadQueue();
  });
  $('btn_close_detail').addEventListener('click', () => { $('detail_card').style.display = 'none'; });
  $('logout_link').addEventListener('click', (e) => { e.preventDefault(); p.logout(); });

  (async () => {
    try {
      const me = await p.me();
      if (me.user.role !== 'buyer' && me.user.role !== 'sct') window.location.href = '/portal/';
      $('reviewer_header').textContent = `${me.user.role === 'sct' ? 'SCT' : 'Buyer'} 審批工作檯 — ${me.user.display_name || me.user.username}`;
      await loadQueue();
    } catch {
      window.location.href = '/portal/';
    }
  })();
})();
