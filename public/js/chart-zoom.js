/*!
 * chart-zoom.js — Dashboard 圖表放大（全螢幕 overlay）
 *
 * 設計原則：
 *  1. 直接搬移原本的卡片 / 圖表 DOM，不 clone、不重畫 → tooltip、點按、橫向滑動全部照用。
 *  2. ChartLite 的 ResizeObserver 會因放大后的尺寸自動重畫線圖；CSS 會把圖表調高。
 *  3. 關閉後把卡片放回原位（用 comment placeholder 記住位置），並還原按鈕文字與焦點。
 *  4. 零依賴；支援 Esc、點擊背景、右上角「關閉」按鈕。
 *
 * 對外 API：
 *   globalThis.ChartZoom = { mount(host, opts), close }
 *
 * mount(host, opts) 的 opts：
 *   target: () => Element    要放大的卡片或圖表容器（必填；每次開啟時才解析）
 *   label: String            按鈕文字（預設「放大」）
 *   zoomedLabel: String      放大後按鈕文字（預設「縮小」）
 *   dialogLabel: String      overlay 的 aria-label（預設「放大圖表」）
 */
(() => {
  'use strict';

  let overlay = null;
  let session = null;

  function $(ref) {
    if (!ref) return null;
    if (typeof ref === 'function') return $(ref());
    if (typeof ref === 'string') {
      const value = ref.trim();
      if (value.startsWith('#') || value.startsWith('.') || value.startsWith('[')) {
        return document.querySelector(value);
      }
      return document.getElementById(value);
    }
    return ref instanceof Element ? ref : null;
  }

  function onKey(e) {
    if (!overlay) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.getClientRects().length > 0);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /** 尺寸改變後主動重畫 ChartLite 線圖（唔等 ResizeObserver，避免背景分頁延遲） */
  function redrawCharts(root) {
    const api = globalThis.ChartLite;
    if (!api || !root) return;
    root.querySelectorAll('.stk-chart, .dash-chart').forEach((el) => {
      if (!el.__ctOpts) return;
      if (typeof api.redraw === 'function') api.redraw(el);
      else if (typeof api.renderLine === 'function') api.renderLine(el, el.__ctOpts);
    });
  }

  function open(trigger, opts) {
    if (overlay) close();
    const target = $(opts.target);
    if (!target || !target.parentNode) return;

    const parent = target.parentNode;
    const placeholder = document.createComment('chart-zoom-placeholder');
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    overlay = document.createElement('div');
    overlay.className = 'cx-zoom-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', opts.dialogLabel || '放大圖表');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const shell = document.createElement('div');
    shell.className = 'cx-zoom-shell';

    const bar = document.createElement('div');
    bar.className = 'cx-zoom-bar';
    const title = document.createElement('span');
    title.className = 'cx-zoom-title';
    title.textContent = opts.dialogLabel || '放大圖表';
    const hint = document.createElement('span');
    hint.className = 'cx-zoom-hint';
    hint.textContent = '按 Esc 或關閉';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cx-zoom-close';
    closeBtn.setAttribute('aria-label', '關閉放大圖表');
    closeBtn.textContent = '關閉 ×';
    closeBtn.addEventListener('click', close);
    bar.append(title, hint, closeBtn);

    const stage = document.createElement('div');
    stage.className = 'cx-zoom-stage';

    parent.insertBefore(placeholder, target);
    target.classList.add('cx-zoomed');
    stage.appendChild(target);
    shell.append(bar, stage);
    overlay.appendChild(shell);
    document.body.appendChild(overlay);
    document.body.classList.add('cx-zoom-lock');

    session = { target, parent, placeholder, trigger, scrollX, scrollY };
    const defaultLabel = trigger ? (trigger.dataset.czDefaultLabel || trigger.textContent) : '';
    if (trigger) {
      trigger.dataset.czDefaultLabel = defaultLabel;
      trigger.textContent = opts.zoomedLabel || '縮小';
      trigger.setAttribute('aria-pressed', 'true');
    }
    closeBtn.focus();
    // 背景分頁的 rAF 可能被暫停；先同步重畫一次，rAF 再補一次
    redrawCharts(target);
    requestAnimationFrame(() => {
      redrawCharts(target);
      window.dispatchEvent(new Event('resize'));
    });
  }

  function close() {
    if (!overlay || !session) return;
    const { target, parent, placeholder, trigger, scrollX, scrollY } = session;
    target.classList.remove('cx-zoomed');
    if (placeholder.parentNode) {
      placeholder.parentNode.replaceChild(target, placeholder);
    } else if (parent && parent.isConnected) {
      parent.appendChild(target);
    }
    overlay.remove();
    overlay = null;
    session = null;
    document.body.classList.remove('cx-zoom-lock');
    if (trigger) {
      trigger.textContent = trigger.dataset.czDefaultLabel || '放大';
      trigger.setAttribute('aria-pressed', 'false');
      try { trigger.focus({ preventScroll: true }); } catch { trigger.focus(); }
    }
    if (Number.isFinite(scrollX) && Number.isFinite(scrollY)) {
      window.scrollTo(scrollX, scrollY);
    }
    redrawCharts(target);
    requestAnimationFrame(() => {
      redrawCharts(target);
      window.dispatchEvent(new Event('resize'));
    });
  }

  function mount(hostRef, options) {
    const host = $(hostRef);
    if (!host || !options || !options.target) return null;
    if (host.dataset.czMounted === '1') return null;
    host.dataset.czMounted = '1';
    host.classList.add('chart-zoom-host');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cx-zoom-btn';
    btn.textContent = options.label || '放大';
    btn.title = '放大圖表（Esc 關閉）';
    btn.setAttribute('aria-label', '放大圖表');
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      if (session && session.trigger === btn) close();
      else open(btn, options);
    });

    host.appendChild(btn);
    return btn;
  }

  document.addEventListener('keydown', onKey);

  globalThis.ChartZoom = {
    mount,
    close,
    version: '1.0.0',
  };
})();
