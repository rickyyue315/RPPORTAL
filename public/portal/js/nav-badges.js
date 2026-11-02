/*!
 * nav-badges.js — 店舖導覽「仲有幾多樣嘢等你做」
 *
 * 原本只有零銷售頁的導覽會顯示「指定SKU回覆 1」，店舖一轉頁就唔見，
 * 容易漏做。呢支腳本每個店舖頁面都跑，一次過向 /api/portal/nav-badges 取數：
 *   零銷售回覆  → 仍開放週次中未回覆的 SKU 數
 *   指定SKU回覆 → 待回覆事項數
 *
 * 規則：
 *  1. 0 不顯示；只屬提示，任何失敗都靜靜收工，絕不影響頁面
 *  2. 目前所在頁面不顯示（列表就在下面，數字冇意義）
 *  3. 未登入（401）不跳轉登入頁——公開頁面（Urgent／退貨／查詢）都共用這條導覽
 *  4. 結果以 `portal:nav-badges` 事件廣播，頁面自己的提示橫幅可重用同一份數字
 */
(() => {
  'use strict';

  const TARGETS = [
    { key: 'zero_sales', href: '/portal/zero-sales.html', unit: '個 SKU 待回覆' },
    { key: 'designated_sku', href: '/portal/designated-sku.html', unit: '個事項待回覆' },
  ];

  const counts = {};
  window.portalNavBadges = { counts, refresh };

  function linkFor(href) {
    return document.querySelector(`nav[aria-label="主要導覽"] a[href="${href}"]`);
  }

  function badgeFor(link) {
    let badge = link.querySelector('.nav-badge');
    if (!badge) {
      badge = document.createElement('b');
      badge.className = 'nav-badge';
      badge.hidden = true;
      link.appendChild(badge);
    }
    return badge;
  }

  function paint(target, n) {
    const link = linkFor(target.href);
    if (!link) return;
    const badge = badgeFor(link);
    const onThisPage = link.getAttribute('aria-current') === 'page';
    const show = n > 0 && !onThisPage;
    badge.hidden = !show;
    badge.textContent = show ? (n > 9 ? '9+' : String(n)) : '';
    if (show) badge.title = `${n} ${target.unit}`;
    else badge.removeAttribute('title');
  }

  async function refresh() {
    let payload = null;
    try {
      const res = await fetch('/api/portal/nav-badges', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      // 401 = 未登入；公開頁面本來就冇 session，靜靜收工即可
      if (!res.ok) return;
      payload = await res.json();
    } catch {
      return;
    }
    TARGETS.forEach((target) => {
      const n = Math.max(0, Number(payload?.[target.key]) || 0);
      counts[target.key] = n;
      paint(target, n);
    });
    document.dispatchEvent(new CustomEvent('portal:nav-badges', { detail: { ...counts } }));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh, { once: true });
  } else {
    refresh();
  }
})();
