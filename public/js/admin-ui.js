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

  /* ---------- 分區 Tabs（?tab= 深層連結） ---------- */
  // 已合併的舊分頁：舊 ?tab= 連結或書籤會自動跳去新分頁，並捲到對應分組
  const TAB_ALIAS = {
    batches: { tab: 'export', anchor: 'sec-batches' },
    accounts: { tab: 'system', anchor: 'sec-accounts' },
    review: { tab: 'system', anchor: 'sec-review' },
  };

  function initTabs() {
    const tabs = [...document.querySelectorAll('#admin_nav_links [data-tab]')];
    const panels = [...document.querySelectorAll('[data-tab-panel]')];
    if (!tabs.length || !panels.length) return;
    const valid = new Set(tabs.map((t) => t.dataset.tab));

    // 接受分頁名、舊分頁名或頁內錨點 id，一律解析成 { tab, anchor }
    function resolveTarget(raw) {
      if (!raw) return null;
      if (TAB_ALIAS[raw]) return TAB_ALIAS[raw];
      if (valid.has(raw)) return { tab: raw, anchor: '' };
      const el = document.getElementById(raw);
      const panel = el && el.closest('[data-tab-panel]');
      if (panel && valid.has(panel.dataset.tabPanel)) return { tab: panel.dataset.tabPanel, anchor: raw };
      return null;
    }

    function fromLocation() {
      const q = new URLSearchParams(location.search).get('tab');
      const hash = location.hash.replace(/^#/, '');
      return resolveTarget(q) || resolveTarget(hash) || { tab: 'overview', anchor: '' };
    }

    function setPillActive(a, on) {
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }

    function highlightSubnav(name, anchor) {
      const nav = panels.find((p) => p.dataset.tabPanel === name)?.querySelector('.panel-subnav');
      if (!nav) return;
      const links = [...nav.querySelectorAll('[data-subnav-target]')];
      if (!links.length) return;
      const target = anchor || links[0].dataset.subnavTarget;
      links.forEach((a) => setPillActive(a, a.dataset.subnavTarget === target));
    }

    function activate(name, opts = {}) {
      if (!valid.has(name)) name = 'overview';
      const changed = globalThis.__adminActiveTab !== name;
      panels.forEach((p) => { p.hidden = p.dataset.tabPanel !== name; });
      tabs.forEach((t) => {
        const on = t.dataset.tab === name;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      });
      globalThis.__adminActiveTab = name;
      highlightSubnav(name, opts.anchor);
      const url = new URL(location.href);
      url.searchParams.set('tab', name);
      url.hash = opts.anchor || '';
      const method = opts.push ? 'pushState' : 'replaceState';
      history[method]({ tab: name, anchor: opts.anchor || '' }, '', url.toString());
      if (opts.scroll !== false) {
        const target = opts.anchor ? document.getElementById(opts.anchor) : null;
        if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
        else window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      }
      if (changed || opts.force) {
        document.dispatchEvent(new CustomEvent('admin:tab-activated', { detail: { tab: name } }));
      }
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        if (tab.dataset.tab === globalThis.__adminActiveTab) return;
        activate(tab.dataset.tab, { push: true });
      });
      tab.addEventListener('keydown', (e) => {
        let next = null;
        if (e.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        else if (e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          tab.click();
          return;
        }
        if (!next) return;
        e.preventDefault();
        next.focus();
        activate(next.dataset.tab, { push: true });
      });
    });
    document.addEventListener('click', (e) => {
      const link = e.target instanceof Element ? e.target.closest('[data-tab-link]') : null;
      if (!link) return;
      const name = link.dataset.tabLink;
      if (!valid.has(name)) return;
      e.preventDefault();
      activate(name, { push: true });
    });
    // 頁內分組導覽（合併版面用）
    document.querySelectorAll('.panel-subnav').forEach((nav) => {
      const panelTab = nav.closest('[data-tab-panel]')?.dataset.tabPanel;
      nav.querySelectorAll('[data-subnav-target]').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          activate(panelTab || globalThis.__adminActiveTab || 'overview', {
            push: true,
            anchor: a.dataset.subnavTarget,
          });
        });
      });
    });
    let spyTick = false;
    function syncSubnavFromScroll() {
      const nav = panels.find((p) => !p.hidden)?.querySelector('.panel-subnav');
      if (!nav) return;
      const links = [...nav.querySelectorAll('[data-subnav-target]')];
      const offset = (document.querySelector('.admin-nav')?.offsetHeight || 0) + 28;
      let current = null;
      links.forEach((a) => {
        const el = document.getElementById(a.dataset.subnavTarget);
        if (el && el.getBoundingClientRect().top - offset <= 0) current = a.dataset.subnavTarget;
      });
      if (!current && links.length) current = links[0].dataset.subnavTarget;
      links.forEach((a) => setPillActive(a, a.dataset.subnavTarget === current));
    }
    window.addEventListener('scroll', () => {
      if (spyTick) return;
      spyTick = true;
      requestAnimationFrame(() => { spyTick = false; syncSubnavFromScroll(); });
    }, { passive: true });
    window.addEventListener('popstate', () => {
      const t = fromLocation();
      activate(t.tab, { scroll: !!t.anchor, anchor: t.anchor });
    });
    const start = fromLocation();
    activate(start.tab, { scroll: !!start.anchor, anchor: start.anchor, force: true });
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
    initTabs();
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
