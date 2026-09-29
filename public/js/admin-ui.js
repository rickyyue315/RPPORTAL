/* 管理後台 UI 增強：導航、匯出 Tab、預設篩選、chips、回頂（不碰 API） */
(() => {
  const $ = (id) => document.getElementById(id);

  function todayHK() {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const v = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
      return `${v.year}-${v.month}-${v.day}`;
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  /* ---------- 導航高亮 ---------- */
  function initNavSpy() {
    const links = [...document.querySelectorAll('#admin_nav_links a[data-nav]')];
    if (!links.length) return;
    const map = new Map(links.map((a) => [a.dataset.nav, a]));
    const sections = [...document.querySelectorAll('.admin-section[id]')];
    const setActive = (id) => {
      links.forEach((a) => a.classList.toggle('active', a.dataset.nav === id));
    };
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) setActive(e.target.id);
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    sections.forEach((s) => io.observe(s));
    links.forEach((a) => {
      a.addEventListener('click', (e) => {
        // 原生錨點跳轉即可，只更新高亮
        setActive(a.dataset.nav);
      });
    });
  }

  /* ---------- 匯出 Tabs ---------- */
  function initExportTabs() {
    const tabs = [...document.querySelectorAll('[data-export-tab]')];
    if (!tabs.length) return;
    const panels = {
      normal: $('export_panel_normal'),
      urgent: $('export_panel_urgent'),
      sales: $('export_panel_sales'),
      return: $('export_panel_return'),
    };
    let saved = null;
    try { saved = localStorage.getItem('ndrf_admin_export_tab'); } catch {}
    function activate(name) {
      tabs.forEach((t) => {
        const on = t.dataset.exportTab === name;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      Object.entries(panels).forEach(([k, el]) => {
        if (el) el.classList.toggle('active', k === name);
      });
      try { localStorage.setItem('ndrf_admin_export_tab', name); } catch {}
    }
    tabs.forEach((t) => t.addEventListener('click', () => activate(t.dataset.exportTab)));
    if (saved && panels[saved]) activate(saved);
  }

  /* ---------- 進階篩選摺疊 ---------- */
  function initAdvancedToggle() {
    const btn = $('filter_advanced_toggle');
    const panel = $('filter_advanced');
    if (!btn || !panel) return;
    const hasValue = ['f_workflow_status', 'f_auto_approved', 'f_modified', 'f_rp_type', 'f_nd_code', 'f_appno']
      .some((id) => $(id)?.value);
    if (hasValue) {
      panel.style.display = '';
      btn.setAttribute('aria-expanded', 'true');
      btn.textContent = '－ 收起進階篩選';
    }
    btn.addEventListener('click', () => {
      const open = panel.style.display === 'none';
      panel.style.display = open ? '' : 'none';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? '－ 收起進階篩選' : '＋ 進階篩選（審批狀態、RP Type、ND Code、申請編號…）';
    });
  }

  /* ---------- 常用篩選預設 ---------- */
  function initPresets() {
    const wrap = $('filter_presets');
    if (!wrap) return;
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    const presets = {
      today_unexported() {
        const t = todayHK();
        set('f_from', t); set('f_to', t);
        set('f_type', ''); set('f_exported', 'no');
        set('f_workflow_status', ''); set('f_auto_approved', ''); set('f_modified', '');
        set('f_site', ''); set('f_sku', ''); set('f_rp_type', ''); set('f_nd_code', ''); set('f_appno', ''); set('f_source', '');
      },
      today_all() {
        const t = todayHK();
        set('f_from', t); set('f_to', t);
        ['f_site', 'f_source', 'f_type', 'f_exported', 'f_workflow_status', 'f_auto_approved', 'f_modified', 'f_sku', 'f_rp_type', 'f_nd_code', 'f_appno'].forEach((id) => set(id, ''));
      },
      urgent_today() {
        const t = todayHK();
        set('f_from', t); set('f_to', t);
        set('f_type', 'urgent'); set('f_exported', '');
        set('f_workflow_status', ''); set('f_site', ''); set('f_sku', ''); set('f_appno', '');
      },
      normal_pending() {
        set('f_from', ''); set('f_to', '');
        set('f_type', 'normal'); set('f_workflow_status', 'pending'); set('f_exported', '');
        set('f_site', ''); set('f_sku', ''); set('f_appno', '');
      },
      unexported_all() {
        set('f_from', ''); set('f_to', '');
        set('f_exported', 'no'); set('f_type', '');
        set('f_workflow_status', ''); set('f_site', ''); set('f_sku', ''); set('f_appno', '');
      },
    };
    wrap.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fn = presets[btn.dataset.preset];
        if (!fn) return;
        fn();
        wrap.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        $('btn_filter')?.click();
      });
    });
  }

  /* ---------- 已選篩選 chips ---------- */
  const CHIP_LABELS = {
    f_from: '由', f_to: '至', f_site: 'Site', f_source: '來源', f_type: '類型',
    f_exported: '匯出', f_workflow_status: '審批', f_auto_approved: 'SLA',
    f_modified: '修改', f_sku: 'SKU', f_rp_type: 'RP', f_nd_code: 'ND Code', f_appno: '編號',
  };
  const CHIP_VALUE_LABEL = {
    f_source: { web: '網頁', excel: 'Excel' },
    f_type: { normal: '一般', urgent: 'Urgent', sales: '突發', return: '退貨' },
    f_exported: { no: '未匯出', yes: '已匯出' },
    f_workflow_status: { pending: '待審批', ready_for_rp: '可供RP', accepted: '已批准', rejected: '已拒絕', legacy: 'Legacy' },
    f_auto_approved: { yes: '自動批准', no: '非自動' },
    f_modified: { yes: '有修改', no: '無修改' },
  };
  function renderChips() {
    const box = $('active_filters');
    if (!box) return;
    box.innerHTML = '';
    Object.keys(CHIP_LABELS).forEach((id) => {
      const el = $(id);
      const v = el?.value.trim();
      if (!v) return;
      const label = CHIP_LABELS[id];
      const pretty = CHIP_VALUE_LABEL[id]?.[v] ?? (v.length > 18 ? `${v.slice(0, 18)}…` : v);
      const chip = document.createElement('span');
      chip.className = 'filter-chip';
      chip.innerHTML = `<span>${label}：${escapeHtml(pretty)}</span>`;
      const x = document.createElement('button');
      x.type = 'button';
      x.title = `清除${label}`;
      x.textContent = '✕';
      x.addEventListener('click', () => {
        el.value = '';
        if (id === 'f_from' || id === 'f_to') {
          // 日期清空後不自動填今日，直接查詢
        }
        document.querySelectorAll('#filter_presets .preset-btn').forEach((b) => b.classList.remove('active'));
        $('btn_filter')?.click();
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  /* ---------- 回頂 + 手動更新 ---------- */
  function initBackTop() {
    const btn = $('btn_back_top');
    if (!btn) return;
    window.addEventListener('scroll', () => {
      btn.classList.toggle('show', window.scrollY > 600);
    }, { passive: true });
    btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  function initManualRefresh() {
    $('btn_manual_refresh')?.addEventListener('click', () => {
      if (typeof globalThis.__adminRefresh === 'function') globalThis.__adminRefresh();
      else $('btn_filter')?.click();
      if (typeof globalThis.__zsRefresh === 'function') {
        try { globalThis.__zsRefresh(); } catch {}
      }
    });
  }

  function init() {
    initNavSpy();
    initExportTabs();
    initAdvancedToggle();
    initPresets();
    initBackTop();
    initManualRefresh();
    renderChips();
    document.addEventListener('admin:list-updated', renderChips);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
