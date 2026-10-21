/* 共用分頁列：產生「‹ 1 2 3 … N ›」頁碼，供後台各清單使用 */
(() => {
  function pageItems(page, totalPages) {
    const wanted = new Set([1, totalPages, page - 2, page - 1, page, page + 1, page + 2]);
    const nums = [...wanted]
      .filter((n) => n >= 1 && n <= totalPages)
      .sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    nums.forEach((n) => {
      if (prev && n - prev > 1) out.push('…');
      out.push(n);
      prev = n;
    });
    return out;
  }

  function render({ nav, range, page, total, pageSize, onPage, unit = '筆' }) {
    if (!nav) return;
    const size = Math.max(1, Number(pageSize) || 20);
    const count = Math.max(0, Number(total) || 0);
    const totalPages = count ? Math.ceil(count / size) : 0;
    const current = totalPages ? Math.min(Math.max(1, Number(page) || 1), totalPages) : 1;
    const from = count ? (current - 1) * size + 1 : 0;
    const to = count ? Math.min(current * size, count) : 0;

    if (range) range.textContent = count ? `顯示 ${from}–${to}，共 ${count} ${unit}` : `0 ${unit}`;
    nav.innerHTML = '';
    if (totalPages <= 1) return;

    const addButton = (label, target, opts = {}) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (opts.current) btn.setAttribute('aria-current', 'page');
      if (opts.disabled) btn.disabled = true;
      if (opts.label) btn.setAttribute('aria-label', opts.label);
      if (!opts.disabled && !opts.current) {
        btn.addEventListener('click', () => onPage?.(target));
      }
      nav.appendChild(btn);
    };

    addButton('‹', current - 1, { disabled: current <= 1, label: '上一頁' });
    pageItems(current, totalPages).forEach((item) => {
      if (item === '…') {
        const span = document.createElement('span');
        span.className = 'page-ellipsis';
        span.textContent = '…';
        nav.appendChild(span);
        return;
      }
      addButton(String(item), item, { current: item === current, label: `第 ${item} 頁` });
    });
    addButton('›', current + 1, { disabled: current >= totalPages, label: '下一頁' });
  }

  /** 記住每個清單的每頁筆數，並在切換時呼叫 onChange。 */
  function bindSize(select, storageKey, onChange) {
    if (!select) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && [...select.options].some((option) => option.value === saved)) {
        select.value = saved;
      }
    } catch {}
    select.addEventListener('change', () => {
      try { localStorage.setItem(storageKey, select.value); } catch {}
      onChange?.();
    });
  }

  globalThis.AdminPager = { render, pageItems, bindSize };
})();
