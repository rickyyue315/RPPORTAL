/* 店舖「沒有回覆次數」統計（唯讀；後端以登入店舖強制過濾，前端不會也無法查別店數據） */
(() => {
  const $ = (id) => document.getElementById(id);
  const p = window.portal;
  const COLOR_MISSED = '#b42318';
  const COLOR_DISPATCHED = '#94a3b8';

  /** 每週狀態 → 畫面文字。'replied' 同時代表「已封存全部回覆」與「開放中已全部回覆」 */
  const STATUS = {
    replied: { label: '已全部回覆', cls: 'replied' },
    partial: { label: '部分沒回覆', cls: 'partial' },
    missed: { label: '完全沒回覆', cls: 'missed' },
    open_pending: { label: '本週待回覆', cls: 'open' },
    not_required: { label: '無須回覆', cls: 'na' },
  };

  let loading = false;
  let started = false;
  let currentSite = '';
  let weeks = [];

  /* ---------- 數值／文字工具 ---------- */

  function num(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmtInt(value) {
    const n = num(value);
    if (n === null) return '—';
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtPct(value) {
    const n = num(value);
    if (n === null) return '—';
    return `${(n * 100).toFixed(1)}%`;
  }

  function dashDate(value) {
    const s = String(value == null ? '' : value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return `${s.slice(5, 7)}/${s.slice(8, 10)}`;
  }

  function statusOf(week) {
    return STATUS[week.status] || STATUS.replied;
  }

  /** 開放中的週次即使已全部回覆，也不說「已封存」 */
  function statusLabel(week) {
    if (week.status === 'replied' && !week.is_archived) return '本週已全部回覆';
    return statusOf(week).label;
  }

  /* ---------- 畫面 ---------- */

  function showError(message, type) {
    p.showAlert($('miss_error'), type || 'error', p.escapeHtml(message));
  }

  function clearError() {
    const box = $('miss_error');
    if (box) box.innerHTML = '';
  }

  function kpiCard(label, value, sub, subNote) {
    const subHtml = [sub || '', subNote || ''].filter(Boolean).join('｜');
    return `<div class="dash-kpi">
      <div class="dash-kpi-value">${value}</div>
      <div class="dash-kpi-label">${label}</div>
      ${subHtml ? `<div class="dash-kpi-sub">${subHtml}</div>` : ''}
    </div>`;
  }

  function renderSiteInfo(site, summary) {
    const box = $('miss_site_info');
    if (!box) return;
    const days = summary && summary.window_weeks
      ? `範圍：最近 <b>${summary.window_weeks}</b> 個派發週次`
      : '尚未有派發紀錄';
    box.innerHTML = `<div class="dash-site-code">店舖 Site Code：<b>${p.escapeHtml(site)}</b></div>`
      + `<div class="hint">${days}</div>`;
  }

  function renderKpi(summary) {
    const wrap = $('miss_kpi');
    if (!wrap) return;
    const s = summary || {};
    const finalized = num(s.finalized_weeks) || 0;
    const missed = num(s.missed_weeks) || 0;
    const full = num(s.missed_full_weeks) || 0;
    const streak = num(s.streak) || 0;
    const itemsMissed = num(s.items_missed) || 0;
    const itemsReplied = num(s.items_replied) || 0;
    const itemsRequired = num(s.items_required) || 0;
    const openPending = num(s.open_pending) || 0;
    const openWeek = s.open_week || '';

    const missedSub = finalized
      ? `共 ${finalized} 個已封存週次`
      : '尚未有已封存週次';
    const missedNote = full > 0 ? `其中 ${full} 週完全沒回覆` : '';

    let streakSub;
    if (!finalized) streakSub = '尚未有已封存週次';
    else if (streak > 0) streakSub = `最近：${s.last_missed_week || '—'}${s.last_missed_date ? `（${dashDate(s.last_missed_date)}）` : ''}`;
    else if (s.last_missed_week) streakSub = `最近一次：${s.last_missed_week}，之後已回覆`;
    else streakSub = '一直保持全部回覆';

    const rateSub = finalized
      ? `按件數計：已回覆 ÷ 派發 ${fmtInt(itemsRequired)} 件`
      : '尚無已封存週次可計算';
    const rateNote = openWeek
      ? (openPending > 0 ? `本週（${openWeek}）仍有 ${openPending} 件待回覆` : `本週（${openWeek}）已全部回覆`)
      : '';

    wrap.innerHTML = [
      kpiCard('沒回覆次數（已封存週次）', finalized ? `${missed} 次` : '—', missedSub, missedNote),
      kpiCard('連續沒回覆', streak > 0 ? `${streak} 週` : '0 週', streakSub),
      kpiCard('累計沒回覆 SKU', finalized ? `${fmtInt(itemsMissed)} 件` : '—',
        finalized ? `已回覆 ${fmtInt(itemsReplied)} / ${fmtInt(itemsRequired)} 件` : '尚無已封存週次'),
      kpiCard('回覆率（已封存週次）', fmtPct(s.reply_rate), rateSub, rateNote),
    ].join('');
  }

  /** 由舊到新排序（圖表時間軸由左至右） */
  function chronological(list) {
    return (Array.isArray(list) ? list.slice() : [])
      .filter((w) => w && w.batch_id)
      .sort((a, b) => String(a.date).localeCompare(String(b.date))
        || String(a.week_label).localeCompare(String(b.week_label)));
  }

  function renderChart(list) {
    const el = $('miss_chart');
    const note = $('miss_chart_note');
    const period = $('miss_chart_period');
    if (!el) return;
    if (note) note.textContent = '';
    if (period) period.textContent = '';

    const rows = chronological(list);
    const required = rows.filter((w) => w.reply_required);
    const chartApi = globalThis.ChartLite;

    if (!required.length) {
      if (chartApi) chartApi.clear(el); else el.innerHTML = '';
      el.innerHTML = '<div class="ct-empty">暫無需要回覆的週次。</div>';
      if (note) note.textContent = 'RP Team 派發新一週後，這裡會自動顯示走勢。';
      return;
    }

    if (!chartApi) {
      el.innerHTML = '<div class="ct-empty">圖表元件未載入，請重新整理頁面。</div>';
      return;
    }

    if (required.length === 1) {
      // 只有 1 個週次：單點不構成走勢，只給文字（與存貨走勢一致）
      chartApi.clear(el);
      const only = required[0];
      el.innerHTML = `<div class="ct-empty">目前只有 1 個週次（${p.escapeHtml(only.week_label)}），下週派發後會顯示走勢。</div>`;
      if (period) period.textContent = String(only.date).slice(0, 10);
      if (note) {
        note.textContent = only.pending > 0
          ? `該週派發 ${only.total} 件，其中 ${only.pending} 件未回覆。`
          : `該週派發 ${only.total} 件，已全部回覆。`;
      }
      return;
    }

    // 「本週無須回覆」的週次不畫點（該週沒有回覆責任），線會斷開，避免看成 0 件沒回覆
    const toPoint = (week, value) => ({ date: week.date, value: week.reply_required ? value : null });
    const missedPoints = rows.map((w) => toPoint(w, w.pending));
    const totalPoints = rows.map((w) => toPoint(w, w.total));

    if (period) {
      const first = required[0];
      const last = required[required.length - 1];
      period.textContent = `${String(first.date).slice(0, 10)} 至 ${String(last.date).slice(0, 10)}，共 ${required.length} 個週次`;
    }

    chartApi.renderLine(el, {
      series: [
        { key: 'missed', label: '沒回覆 SKU', color: COLOR_MISSED, points: missedPoints },
        { key: 'dispatched', label: '每週派發 SKU', color: COLOR_DISPATCHED, dashed: true, points: totalPoints },
      ],
      height: 240,
      emptyText: '暫無回覆數據',
      yFormat: (v) => String(Math.round(Number(v))),
      tipFormat: (v) => `${Math.round(Number(v))} 件`,
      ariaLabel: `每週沒回覆 SKU 件數，共 ${required.length} 個週次`,
    });

    const openWeek = rows.find((w) => w.status === 'open_pending');
    const parts = ['點或懸停圖表可看該週件數。'];
    if (openWeek) parts.push(`最新一週（${openWeek.week_label}）仍未封存，圖中顯示的是目前仍未回覆的件數，仍可回覆。`);
    if (rows.some((w) => !w.reply_required)) parts.push('「本週無須回覆」的週次不畫點（斷線），不當成 0 件。');
    if (note) note.textContent = parts.join(' ');
  }

  function renderLegend() {
    const box = $('miss_legend');
    if (!box) return;
    const order = ['replied', 'partial', 'missed', 'open_pending', 'not_required'];
    box.innerHTML = order.map((key) => {
      const item = STATUS[key];
      return `<span class="miss-legend-item"><i class="miss-swatch miss-swatch--${item.cls}" aria-hidden="true"></i>${item.label}</span>`;
    }).join('');
  }

  function renderStrip(list) {
    const box = $('miss_strip');
    const period = $('miss_strip_period');
    if (!box) return;
    const rows = chronological(list);
    if (!rows.length) {
      box.innerHTML = '<div class="empty">暫無派發紀錄。</div>';
      if (period) period.textContent = '';
      return;
    }
    if (period) period.textContent = `共 ${rows.length} 個週次`;
    box.innerHTML = '';
    rows.forEach((w) => {
      // 用 DOM 逐格建立（不用字串拼 title）：週次是管理員自由輸入，可能含引號
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `miss-cell miss-cell--${statusOf(w).cls}`;
      cell.dataset.batch = w.batch_id;
      const detail = w.reply_required
        ? `${statusLabel(w)}：沒回覆 ${w.pending} / ${w.total} 件`
        : `${statusLabel(w)}：${w.total} 個 SKU 只供參考`;
      const title = `${w.week_label}（${w.date}）· ${detail}`;
      cell.title = title;
      cell.setAttribute('aria-label', title);
      cell.addEventListener('click', () => jumpToWeek(w.batch_id));
      box.appendChild(cell);
    });
  }

  function renderTable(list) {
    const box = $('miss_table');
    const count = $('miss_table_count');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="empty" style="padding:28px 16px">暫無派發紀錄。RP Team 派發新一週後會自動顯示。</div>';
      if (count) count.textContent = '';
      return;
    }
    let html = '<table class="miss-table"><thead><tr>'
      + '<th>週次</th><th>派發日期</th><th>派發 SKU</th><th>已回覆</th><th>沒回覆</th><th>狀態</th><th></th>'
      + '</tr></thead><tbody>';
    list.forEach((w) => {
      const cls = statusOf(w).cls;
      const missed = w.pending > 0;
      const rowClass = w.status === 'missed' || w.status === 'partial' ? ' class="miss-row--missed"' : '';
      html += `<tr${rowClass}>`
        + `<td>${p.escapeHtml(w.week_label)}${w.is_archived ? '' : '<span class="miss-week-tag">最新</span>'}</td>`
        + `<td>${p.escapeHtml(w.date)}</td>`
        + `<td class="miss-num">${fmtInt(w.total)}</td>`
        + `<td class="miss-num">${fmtInt(w.replied)}</td>`
        + `<td class="miss-num${missed ? ' miss-num--bad' : ''}">${fmtInt(w.pending)}</td>`
        + `<td><span class="miss-pill miss-pill--${cls}">${statusLabel(w)}</span></td>`
        + `<td><button type="button" class="btn ghost btn-sm" data-batch="${p.escapeHtml(w.batch_id)}">查看</button></td>`
        + '</tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
    const shown = list.length;
    if (count) count.textContent = `共 ${shown} 個週次（新到舊）`;
    box.querySelectorAll('[data-batch]').forEach((btn) => {
      btn.addEventListener('click', () => jumpToWeek(btn.dataset.batch));
    });
  }

  /** 跳到「零銷售回覆」並選中該週次；選項未載入（極少數）就只切分頁 */
  function jumpToWeek(batchId) {
    if (!batchId) return;
    const tab = $('tab_zs');
    const sel = $('f_batch');
    if (tab) tab.click();
    if (!sel) return;
    const has = Array.from(sel.options || []).some((o) => o.value === batchId);
    if (!has) return;
    sel.value = batchId;
    sel.dispatchEvent(new Event('change'));
  }

  /* ---------- 載入 ---------- */

  async function load(site) {
    if (loading) return;
    loading = true;
    clearError();
    try {
      const data = (await p.api('/api/portal/zero-sales/reply-stats')) || {};
      weeks = Array.isArray(data.weeks) ? data.weeks : [];
      const summary = data.summary || {};
      renderSiteInfo(site || data.site_code || '', summary);
      renderKpi(summary);
      renderChart(weeks);
      renderStrip(weeks);
      renderTable(weeks);
    } catch (err) {
      if (err && err.status === 401) return; // portalApi 已導向登入
      showError(err && err.message ? err.message : '載入失敗');
      const kpi = $('miss_kpi');
      if (kpi) {
        kpi.innerHTML = '<div class="dash-kpi"><div class="dash-kpi-value">—</div>'
          + '<div class="dash-kpi-label">未能載入數據</div>'
          + '<div class="dash-kpi-sub">可切換分頁或重新載入頁面再試</div></div>';
      }
      const chart = $('miss_chart');
      if (chart) chart.innerHTML = '<div class="ct-empty">未能載入走勢圖，請重新載入頁面。</div>';
    } finally {
      loading = false;
    }
  }

  /* ---------- 啟動 ---------- */

  let starting = null;

  /**
   * 首次載入由 portal-tabs.js 在切到「沒回覆次數」時呼叫（確保面板已可見、
   * 圖表量得到闊度）。重複呼叫不會重複請求。
   */
  async function start() {
    if (started) return;
    if (starting) return starting;
    starting = (async () => {
      let site;
      try {
        site = await p.ensureStoreSite();
      } catch {
        return; // 由現有 gate / 角色導向處理
      }
      currentSite = site;
      await load(site);
      started = true;
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  /* ---------- 圖表放大／匯出（PDF／SVG／JPG／PNG） ---------- */

  if (globalThis.ChartZoom && $('miss_chart_export')) {
    globalThis.ChartZoom.mount('miss_chart_export', {
      target: () => $('miss_chart_card'),
      dialogLabel: '每週沒回覆 SKU 件數',
    });
  }

  if (globalThis.ChartExport && $('miss_chart_export')) {
    globalThis.ChartExport.mount('miss_chart_export', {
      target: () => $('miss_chart'),
      title: '每週沒回覆 SKU 件數',
      subtitle: () => {
        const period = $('miss_chart_period')?.textContent || '';
        return [currentSite, period].filter(Boolean).join(' · ');
      },
      filename: () => `NDRF_沒回覆次數_${currentSite || '本店'}`,
      dataTable: true,
    });
  }

  document.addEventListener('portal:tab', (e) => {
    const tab = e && e.detail ? e.detail.tab : '';
    if (tab !== 'missed') return;
    // 首次 → 完整載入；之後每次切回來都重新抓一次，確保看到最新統計
    if (started) load(currentSite);
    else start();
  });

  // 面板本來就可見（例如深連結但事件較慢）時立即載入；否則等分頁籤通知。
  const panel = $('panel_missed');
  if (panel && !panel.hidden) start();

  renderLegend();
})();
