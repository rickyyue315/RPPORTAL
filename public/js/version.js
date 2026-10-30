// System version - single source of truth for the version shown in the page footer.
// Bump this (and the "version" field in package.json) on every release: Ver x.y.z
window.NDRF_APP_VERSION = '2.4.0';

(function () {
  function renderVersion() {
    var label = 'Ver ' + window.NDRF_APP_VERSION;
    document.querySelectorAll('[data-app-version]').forEach(function (el) {
      el.textContent = label;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderVersion);
  } else {
    renderVersion();
  }
})();
