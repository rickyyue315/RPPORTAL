/*!
 * rename-notice.js — 「RP Portal 已改名」一次性通知橫幅
 *
 * 公司另有系統叫「Portal」，店舖見到 RP 平台時容易混淆，所以改名後要主動通知一次：
 *   RP Portal → RP Connect — RP 連繫網申報平台
 *
 * 規則：
 *  1. **只出現一次，直到店舖按 X 為止**：關閉後寫入 localStorage 記號，之後不再打擾。
 *     刻意不用 sessionStorage——店舖關掉瀏覽器再開，不應該重新提示。
 *  2. 記號帶版本（`_v1`）：日後再有改名或第二輪通知，改 key 即可重新提示一次，
 *     毋須改動已安裝在店舖電腦上的任何東西。
 *  3. 未登入的公開頁（Urgent／銷售／退貨／查詢／說明）同樣顯示：店舖未登入也會見到。
 *  4. 任何失敗（localStorage 被封、頁面冇 <main>）都靜靜收工，絕不影響頁面。
 */
(() => {
  'use strict';

  /** 改動此 key 尾碼即可重新向所有店舖提示一次。 */
  const STORAGE_KEY = 'ndrf_rename_notice_v1';
  const DISMISSED = 'dismissed';

  const ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M18 8a3 3 0 0 1 0 6"></path>
      <path d="M10 8v11a1 1 0 0 1 -1 1h-1a1 1 0 0 1 -1 -1v-9"></path>
      <path d="M3 10h11l5 -3v12l-5 -3h-11z"></path>
    </svg>`;

  const CLOSE_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M18 6l-12 12"></path>
      <path d="M6 6l12 12"></path>
    </svg>`;

  function isDismissed() {
    try {
      return localStorage.getItem(STORAGE_KEY) === DISMISSED;
    } catch {
      // 無痕模式或封鎖 cookie 的瀏覽器：當成未關閉，寧願多提一次也不要漏提。
      return false;
    }
  }

  function rememberDismissed() {
    try {
      localStorage.setItem(STORAGE_KEY, DISMISSED);
    } catch {
      /* 記不到就算了，畫面已即時移除 */
    }
  }

  function mount() {
    if (isDismissed()) return;
    const main = document.querySelector('main');
    // 已插入過（同一頁重複載入腳本）就不要再插一個
    if (!main || main.querySelector('.rename-notice')) return;

    const banner = document.createElement('section');
    banner.className = 'rename-notice';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', '平台改名通知');
    banner.innerHTML = `
      <span class="rename-notice-icon">${ICON}</span>
      <div class="rename-notice-body">
        <p class="rename-notice-title">RP Portal 已改名為 <strong>RP Connect — RP 連繫網申報平台</strong></p>
        <p class="rename-notice-desc">網址、登入帳號及密碼全部不變。此平台與公司另一個「SASA Portal」無關，是 RP Team 向店舖發通告及收集回覆的平台。</p>
      </div>
      <button type="button" class="rename-notice-cta">知道了</button>
      <button type="button" class="rename-notice-close" aria-label="關閉改名通知">${CLOSE_ICON}</button>`;

    function dismiss() {
      rememberDismissed();
      banner.remove();
    }

    banner.querySelector('.rename-notice-close').addEventListener('click', dismiss);
    banner.querySelector('.rename-notice-cta').addEventListener('click', dismiss);

    main.prepend(banner);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
