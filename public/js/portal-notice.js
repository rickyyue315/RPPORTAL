/*!
 * portal-notice.js — 後台推送的平台通告（店舖頁與 OM 頁共用）
 *
 * 通告內容存在資料庫，由「後台 → 系統 → 平台通告」維護，所以改字、開關、排程
 * 都不用再改程式碼。頁面開一次就打一支 `GET /api/public/notice`。
 *
 * 規則：
 *  1. **同一個版本只提示一次**：按 X 後寫入 `localStorage.rp_notice_<id>_r<revision>`，
 *     重新載入也不會再彈；管理員按「重新推送」令 revision + 1 才會再見一次。
 *     key 帶 revision 而不是單純 id —— 改字重推之後，舊記號不會錯誤地把它擋住。
 *  2. 最多顯示 3 條（後端亦已 LIMIT 3），新到舊。
 *  3. 任何失敗（API 掛掉、localStorage 被封、頁面冇 <main>）都靜靜收工；
 *     通告只是附加資訊，絕不可以影響店舖做正事。
 *  4. 文字一律用 textContent 寫入，管理員打錯 HTML 也不會變成標籤。
 */
(() => {
  'use strict';

  const STORAGE_PREFIX = 'rp_notice_';
  const MAX_RENDER = 3;
  const TONES = new Set(['info', 'warning', 'success']);

  const ICONS = {
    info: '<path d="M18 8a3 3 0 0 1 0 6"></path><path d="M10 8v11a1 1 0 0 1 -1 1h-1a1 1 0 0 1 -1 -1v-9"></path><path d="M3 10h11l5 -3v12l-5 -3h-11z"></path>',
    warning: '<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.24 3.957l-8.422 14.06a1.989 1.989 0 0 0 1.7 2.983h16.964a1.989 1.989 0 0 0 1.7 -2.983l-8.422 -14.06a1.989 1.989 0 0 0 -3.4 0z"></path>',
    success: '<path d="M5 12l5 5l10 -10"></path>',
  };

  function storageKey(notice) {
    return `${STORAGE_PREFIX}${notice.id}_r${notice.revision}`;
  }

  function isDismissed(notice) {
    try {
      return localStorage.getItem(storageKey(notice)) === '1';
    } catch {
      return false;
    }
  }

  function rememberDismissed(notice) {
    try {
      localStorage.setItem(storageKey(notice), '1');
    } catch {
      /* 記不到就算了，畫面已即時移除 */
    }
  }

  /** 連結只接受 http(s) 或站內路徑；後端有同樣驗證，這裡再擋一次。 */
  function safeHref(url) {
    return typeof url === 'string' && /^(https?:\/\/|\/)/i.test(url.trim()) ? url.trim() : null;
  }

  function buildNotice(notice) {
    const tone = TONES.has(notice.tone) ? notice.tone : 'info';

    const el = document.createElement('section');
    el.className = `portal-notice portal-notice--${tone}`;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', '平台通告');

    const icon = document.createElement('span');
    icon.className = 'portal-notice-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[tone]}</svg>`;

    const body = document.createElement('div');
    body.className = 'portal-notice-body';

    const title = document.createElement('p');
    title.className = 'portal-notice-title';
    title.textContent = notice.title || '';
    body.appendChild(title);

    if (notice.body) {
      const desc = document.createElement('p');
      desc.className = 'portal-notice-desc';
      desc.textContent = notice.body;
      body.appendChild(desc);
    }

    el.appendChild(icon);
    el.appendChild(body);

    const href = safeHref(notice.link_url);
    if (href) {
      const link = document.createElement('a');
      link.className = 'portal-notice-cta';
      link.href = href;
      link.textContent = notice.link_text || '查看詳情';
      el.appendChild(link);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'portal-notice-close';
    close.setAttribute('aria-label', '關閉通告');
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6l-12 12"></path><path d="M6 6l12 12"></path></svg>';
    close.addEventListener('click', () => {
      rememberDismissed(notice);
      el.remove();
    });
    el.appendChild(close);

    return el;
  }

  async function mount() {
    const main = document.querySelector('main');
    // 同一頁重複載入腳本時不要疊兩次
    if (!main || main.querySelector('.portal-notice')) return;

    let payload = null;
    try {
      const res = await fetch('/api/public/notice', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      payload = await res.json();
    } catch {
      return;
    }

    const notices = Array.isArray(payload?.notices) ? payload.notices : [];
    const visible = notices
      .filter((notice) => notice && notice.id && notice.title && !isDismissed(notice))
      .slice(0, MAX_RENDER);
    if (!visible.length) return;

    const fragment = document.createDocumentFragment();
    visible.forEach((notice) => fragment.appendChild(buildNotice(notice)));
    main.prepend(fragment);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
