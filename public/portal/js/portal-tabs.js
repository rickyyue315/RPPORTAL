/*!
 * portal-tabs.js — 店舖端分頁籤（零銷售回覆 / 存貨走勢）
 *
 * 只做四件事：
 *  1. 切換 panel 的 hidden、aria-selected、tabindex
 *  2. 記住選擇（網址 hash：#stock），重新載入仍停在同一頁
 *  3. 更新頁首副標題（例：存貨走勢 — HA02）
 *  4. 廣播 `portal:tab` 事件，讓 dashboard.js 在面板可見後才量寬度畫圖
 *
 * 零銷售回覆是預設頁，任何時候都不會因為這個檔而延遲或改變行為。
 */
(() => {
  'use strict';

  const header = document.getElementById('store_header');
  const tabs = Array.from(document.querySelectorAll('[role="tab"][data-panel]'));
  if (!tabs.length) return;

  /** 存貨走勢的「新功能」提示：未打開過就脈動，打開過一次就停 */
  const SEEN_KEY = 'portal_stock_tab_seen';
  const accentTab = document.querySelector('[role="tab"].portal-tab--accent');
  let seen = true;
  try {
    seen = window.localStorage.getItem(SEEN_KEY) === '1';
  } catch { seen = true; }

  if (accentTab && !seen) accentTab.classList.add('is-pulsing');

  let applying = false;

  /** 由副標題「標籤 — 店號」取出店號；未有店號時回空字串 */
  function currentSite() {
    if (!header) return '';
    const parts = String(header.textContent || '').split('—');
    return parts.length > 1 ? parts.slice(1).join('—').trim() : '';
  }

  function applySubtitle() {
    if (!header) return;
    const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    const label = active ? active.dataset.subtitle || '' : '';
    if (!label) return;
    const site = currentSite();
    const next = site ? `${label} — ${site}` : label;
    if (header.textContent === next) return;
    applying = true;
    header.textContent = next;
    applying = false;
  }

  function panelOf(tab) {
    return document.getElementById(tab.dataset.panel);
  }

  function activate(tab, opts) {
    if (!tab) return;
    const options = opts || {};
    const panel = panelOf(tab);
    if (!panel) return;

    tabs.forEach((item) => {
      const isTarget = item === tab;
      item.setAttribute('aria-selected', isTarget ? 'true' : 'false');
      item.tabIndex = isTarget ? 0 : -1;
      item.classList.toggle('is-active', isTarget);
      const target = panelOf(item);
      if (target) target.hidden = !isTarget;
      // 選中就不再閃；未選中且未打開過才繼續提示
      if (item === accentTab) item.classList.toggle('is-pulsing', !seen && !isTarget);
    });

    if (tab === accentTab && !seen) {
      seen = true;
      try {
        window.localStorage.setItem(SEEN_KEY, '1');
      } catch { /* 私密模式寫不到，忽略 */ }
    }

    applySubtitle();

    if (!options.silentHash) {
      const hash = tab.dataset.panel === 'panel_zs' ? '' : `#${tab.id === 'tab_stock' ? 'stock' : 'zs'}`;
      try {
        const url = `${window.location.pathname}${window.location.search}${hash}`;
        window.history.replaceState(null, '', url);
      } catch { /* 舊瀏覽器忽略 */ }
    }

    if (!options.silent) {
      document.dispatchEvent(new CustomEvent('portal:tab', {
        detail: { tab: tab.dataset.panel === 'panel_stock' ? 'stock' : 'zs' },
      }));
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const index = tabs.indexOf(tab);
      const next = e.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : tabs[(index - 1 + tabs.length) % tabs.length];
      next.focus();
      activate(next);
    });
  });

  // 深連結：/portal/zero-sales.html#stock
  const wanted = /^#stock$/i.test(window.location.hash || '') ? 'tab_stock' : null;
  const initial = wanted ? document.getElementById(wanted) : tabs[0];
  activate(initial, { silentHash: true });

  // 副標題由 zero-sales.js 於登入後才寫入店號，寫入後重新套用對應分頁的標籤
  if (header && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      if (applying) return;
      applySubtitle();
    });
    observer.observe(header, { childList: true, characterData: true, subtree: true });
  }
})();
