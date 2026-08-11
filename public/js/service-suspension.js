(() => {
  const cfg = {
    // 日後如需重新開通申報，請將 enabled 改為 false（或把 suspendAt 改為較後時間）。
    enabled: true,
    suspendAt: '2026-08-11T23:59:59+08:00',
  };

  if (!cfg.enabled) return;
  const suspendAt = new Date(cfg.suspendAt).getTime();
  if (!isFinite(suspendAt) || Date.now() < suspendAt) return;

  const MESSAGE = '此平台申報服務已暫停（2026年8月11日23:59:59 起），提交／修改／預覽／批量上載功能已停用，謝謝。';
  const BTN_SELECTOR = '#btn_submit, #btn_preview, #btn_confirm, #btn_save, #btn_import';

  function suspend() {
    document.querySelectorAll(BTN_SELECTOR).forEach((btn) => {
      btn.disabled = true;
    });

    document.querySelectorAll('input[type="file"]').forEach((input) => {
      input.disabled = true;
    });
    document.querySelectorAll('.file-drop').forEach((drop) => {
      drop.style.pointerEvents = 'none';
      drop.style.opacity = '0.6';
    });

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', suspend);
  } else {
    suspend();
  }
})();
