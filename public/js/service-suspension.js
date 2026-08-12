(() => {
  const cfg = globalThis.NDRF_OPTIONS?.publicWriteSuspension ?? {
    // 後端設定未能載入時，仍以目前的停用時間作安全 fallback。
    enabled: true,
    suspendAt: '2026-08-11T23:59:59+08:00',
  };

  const suspendAt = new Date(cfg.suspendAt).getTime();
  function isSuspended() {
    return Boolean(cfg.enabled) && Number.isFinite(suspendAt) && Date.now() >= suspendAt;
  }

  const MESSAGE = '此平台申報服務已暫停，提交／修改／預覽／批量上載功能已停用，謝謝。';
  const BTN_SELECTOR = '#btn_submit, #btn_preview, #btn_confirm, #btn_save, #btn_import';

  let blockInstalled = false;
  function suspend() {
    // 直接隱藏按鈕，比只 disable 更徹底，頁面 scripts 之後無法再重新啟用／點擊。
    document.querySelectorAll(BTN_SELECTOR).forEach((btn) => {
      btn.disabled = true;
      btn.style.display = 'none';
    });

    document.querySelectorAll('input[type="file"]').forEach((input) => {
      input.disabled = true;
    });
    document.querySelectorAll('.file-drop').forEach((drop) => {
      drop.style.pointerEvents = 'none';
      drop.style.opacity = '0.6';
    });

    if (!blockInstalled) {
      blockInstalled = true;
      const block = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };

      document.getElementById('apply_form')?.addEventListener('submit', block, true);
      document.querySelectorAll('#btn_save, #btn_import').forEach((el) => {
        el.addEventListener('click', block, true);
      });

      const banner = document.createElement('div');
      banner.className = 'suspend-banner';
      banner.setAttribute('role', 'alert');
      banner.textContent = MESSAGE;
      document.querySelector('header.topbar')?.after(banner);
    }
  }

  // 頁面 scripts（urgent.js／return.js／lookup.js）會在 DOMContentLoaded 之後的非同步
  // 回應中重新啟用按鈕（例如 Urgent 每日窗口仍開時），所以停用狀態必須持續重新套用。
  let reapplyTimer = null;
  function start() {
    suspend();
    if (reapplyTimer === null) {
      reapplyTimer = setInterval(() => {
        if (!isSuspended()) return;
        suspend();
      }, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
