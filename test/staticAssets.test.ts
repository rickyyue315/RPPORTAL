import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const app = createApp();

const HTML_PAGES = ['/', '/portal/', '/portal/om.html', '/portal/zero-sales.html', '/portal/store.html', '/portal/designated-sku.html'];
const VERSIONED_ASSETS = [
  '/portal/js/om.js',
  '/portal/js/om-designated-sku.js',
  '/portal/js/zero-sales.js',
  '/portal/js/designated-sku.js',
  '/portal/js/portal.js',
  '/portal/js/portal-tabs.js',
  '/portal/js/nav-badges.js',
  '/portal/js/dashboard.js',
  '/js/admin-designated-sku.js',
  '/js/chart-lite.js',
  '/js/chart-export.js',
  '/js/chart-zoom.js',
  '/css/chart-export.css',
  '/portal/css/portal.css',
  '/css/style.css',
  '/js/api.js',
  '/js/version.js',
];

describe('static asset freshness', () => {
  it.each(HTML_PAGES)('never lets browsers store HTML: %s', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it.each(VERSIONED_ASSETS)('revalidates JS/CSS instead of always re-downloading it: %s', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['cache-control']).not.toContain('no-store');
    expect(res.headers.etag).toBeTruthy();

    const revalidated = await request(app).get(url).set('If-None-Match', res.headers.etag);
    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBe('');
  });

  it('stamps every local JS/CSS reference with the release version', async () => {
    const res = await request(app).get('/portal/zero-sales.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`/portal/css/portal.css?v=${version}`);
    expect(res.text).toContain(`/portal/js/zero-sales.js?v=${version}`);
    expect(res.text).toContain(`/js/version.js?v=${version}`);
    expect(res.text).not.toMatch(/(?:src|href)="\/[^"?]+\.(?:css|js)(?!\?v=)/);
  });

  it('keeps the store dashboard on the same page as zero-sales replies', async () => {
    const res = await request(app).get('/portal/zero-sales.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="panel_zs"');
    expect(res.text).toContain('id="panel_stock"');
    expect(res.text).toContain('/portal/js/portal-tabs.js?v=');
    expect(res.text).toContain('/portal/js/dashboard.js?v=');
    // 舊的獨立頁不應再出現在導覽，也不應再存在（單頁入口開放後從未對外通知）
    expect(res.text).not.toContain('href="/portal/dashboard.html"');
    const gone = await request(app).get('/portal/dashboard.html');
    expect(gone.status).toBe(404);
  });

  it('stamps the root page as well', async () => {    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`/css/style.css?v=${version}`);
    expect(res.text).toContain(`/js/version.js?v=${version}`);
  });

  it('stamps a directory index page', async () => {
    const res = await request(app).get('/portal/');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`/portal/js/portal.js?v=${version}`);
  });

  it('keeps the RF SKU dashboard wired into the admin stock page', () => {
    const html = readFileSync(path.join(root, 'public', 'admin', 'index.html'), 'utf8');
    const script = readFileSync(path.join(root, 'public', 'js', 'admin-stock.js'), 'utf8');
    expect(html).toContain('id="panel-stock"');
    expect(html).toContain('No. of RF SKU Dashboard');
    expect(html).toContain('id="stk_rf_kpi"');
    expect(html).toContain('id="stk_rf_chart"');
    expect(html).toContain('id="stk_rf_top15"');
    expect(html).toContain('>RF SKU</th>');
    expect(script).toContain('renderRfDashboard');
    expect(script).toContain('total_rf_sku');
    expect(script).toContain('rf_sku_delta');
  });

  it('wires the latest-month MTD shop ranking in place of the grouped trend', () => {
    const html = readFileSync(path.join(root, 'public', 'admin', 'index.html'), 'utf8');
    const script = readFileSync(path.join(root, 'public', 'js', 'admin-stock.js'), 'utf8');
    expect(html).toContain('id="stk_group_dashboard"');
    expect(html).toContain('id="stk_mtd_section"');
    expect(html).toContain('data-stk-group-metric="sku"');
    // 口徑與視圖切換共用同一套 pill 樣式，避免兩個控件一高一低
    expect(html).toContain('class="seg-switch stk-mtd-metric"');
    expect(script).toContain("b.classList.toggle('is-active', active)");
    // 舊分組小圖已移除，MTD 排名直接成為卡面內容
    expect(html).not.toContain('id="stk_group_chart"');
    expect(html).not.toContain('data-stk-group-dim');
    expect(script).not.toContain('renderGroupChart');
    expect(script).not.toContain('group_trend');
    expect(script).toContain('ovs_carry_ratio');
    // MTD 每店排名：要有獨立容器、店名欄及載入函式
    expect(html).toContain('id="stk_mtd_rank"');
    expect(html).toContain('id="stk_mtd_title"');
    // 佔比趨勢可自選店舖（全公司 / 單店）
    expect(html).toContain('id="stk_chart_store"');
    expect(script).toContain('loadChartStoreView');
    expect(script).toContain('/api/admin/stock/stores/');
    expect(script).toContain('renderMtdRanking');
    expect(script).toContain('loadMtdWeek');
    expect(script).toContain('店舖名稱');
    // MTD「店舖佔比」視圖：按 Shop Nature 分組的柱狀排名，與排行榜共用同一期快照
    expect(html).toContain('id="stk_mtd_share"');
    expect(html).toContain('id="stk_mtd_switch"');
    expect(html).toContain('data-stk-mtd-view="rank"');
    expect(html).toContain('data-stk-mtd-view="share"');
    expect(script).toContain('renderMtdShare');
    expect(script).toContain('stk-share-col');
    expect(script).toContain('natureGroupKey');
    // OM 綜合排名：第三個 MTD 視圖，按 OM 加總轄下店舖分子／分母後排名
    expect(html).toContain('data-stk-mtd-view="om"');
    expect(html).toContain('id="stk_mtd_om"');
    expect(html).toContain('id="stk_om_body"');
    expect(html).toContain('id="stk_om_scope"');
    expect(script).toContain('renderMtdOm');
    expect(script).toContain('data-stk-om-share');
    expect(script).toContain('Σ轄下所有店舖分子');
    // 分區篩選：全部／民生區／混合區／遊客區，預設全部
    expect(html).toContain('id="stk_share_nature"');
    expect(html).toContain('id="stk_share_body"');
    expect(html).toContain('data-stk-share-nature="all"');
    expect(html).toContain('data-stk-share-nature="local"');
    expect(html).toContain('data-stk-share-nature="mix"');
    expect(html).toContain('data-stk-share-nature="tourist"');
    expect(script).toContain('applyShareNature');
    // 店舖佔比 OM 篩選：與排行榜的 OM 下拉獨立，選項由該期資料自動產生
    expect(html).toContain('id="stk_share_om"');
    expect(html).toContain('全部 OM');
    expect(script).toContain('syncShareOmOptions');
    expect(script).toContain('filterRankRows');
    expect(script).toContain('shareOm');
    // OM 式整合：三組 Nature 並排在同一張圖，外層橫向滑動（不再分開三張卡）
    expect(script).toContain('class="stk-share" role="region"');
    expect(script).toContain('橫向滑動睇全部店舖');
    expect(script).toContain('stk-share-summary');
    expect(script).toContain('Σ分子 ÷ Σ分母，不是各店平均');
    const adminCss = readFileSync(path.join(root, 'public', 'css', 'admin.css'), 'utf8');
    expect(adminCss).toContain('.stk-share-summary');
    expect(adminCss).toContain('flex-wrap: nowrap');
    expect(adminCss).toContain('scrollbar-width: thin');
    expect(adminCss).toContain('.stk-om-table');
    expect(adminCss).toContain('.stk-om-metric.is-current');
    // 排行榜篩選：OM／Shop Nature（預設全部）；表格本體要獨立容器，否則重畫會洗掉篩選列
    expect(html).toContain('id="stk_mtd_rank_body"');
    expect(html).toContain('id="stk_rank_om"');
    expect(html).toContain('id="stk_rank_nature"');
    expect(html).toContain('id="stk_rank_scope"');
    expect(script).toContain('filterRankRows');
    expect(script).toContain('syncRankOmOptions');
  });

  it('wires chart export on every dashboard chart card', () => {
    const adminHtml = readFileSync(path.join(root, 'public', 'admin', 'index.html'), 'utf8');
    const adminScript = readFileSync(path.join(root, 'public', 'js', 'admin-stock.js'), 'utf8');
    const omHtml = readFileSync(path.join(root, 'public', 'portal', 'om.html'), 'utf8');
    const omScript = readFileSync(path.join(root, 'public', 'portal', 'js', 'om.js'), 'utf8');
    const storeHtml = readFileSync(path.join(root, 'public', 'portal', 'zero-sales.html'), 'utf8');
    const storeScript = readFileSync(path.join(root, 'public', 'portal', 'js', 'dashboard.js'), 'utf8');

    // 後台：店舖佔比棒圖、佔比趨勢線圖、RF SKU 走勢線圖
    expect(adminHtml).toContain('/js/chart-export.js');
    expect(adminHtml).toContain('/js/chart-zoom.js');
    expect(adminHtml).toContain('/css/chart-export.css');
    expect(adminHtml).toContain('id="stk_share_export"');
    expect(adminHtml).toContain('id="stk_trend_export"');
    expect(adminHtml).toContain('id="stk_rf_chart_export"');
    expect(adminScript).toContain("cx.mount('stk_share_export'");
    expect(adminScript).toContain("cx.mount('stk_trend_export'");
    expect(adminScript).toContain("cx.mount('stk_rf_chart_export'");
    expect(adminScript).toContain('dataTable: true');
    expect(adminScript).toContain("cz.mount('stk_share_export'");
    expect(adminScript).toContain("cz.mount('stk_trend_export'");
    expect(adminScript).toContain("cz.mount('stk_rf_chart_export'");

    // OM：存貨走勢 + 管轄店舖排名
    expect(omHtml).toContain('/js/chart-export.js');
    expect(omHtml).toContain('/js/chart-zoom.js');
    expect(omHtml).toContain('id="om_stock_export"');
    expect(omHtml).toContain('id="om_share_export"');
    expect(omScript).toContain("cx.mount('om_stock_export'");
    expect(omScript).toContain("cx.mount('om_share_export'");
    expect(omScript).toContain('dataTable: true');
    expect(omScript).toContain("cz.mount('om_stock_export'");
    expect(omScript).toContain("cz.mount('om_share_export'");

    // 店舖端：每週存貨走勢
    expect(storeHtml).toContain('/js/chart-export.js');
    expect(storeHtml).toContain('/js/chart-zoom.js');
    expect(storeHtml).toContain('id="dash_chart_export"');
    expect(storeScript).toContain("ChartExport.mount('dash_chart_export'");
    expect(storeScript).toContain("ChartZoom.mount('dash_chart_export'");
    expect(storeScript).toContain('dataTable: true');

    // 線圖匯出／畫面數據表：逐期日期 + 每條線數值
    const exportScript = readFileSync(path.join(root, 'public', 'js', 'chart-export.js'), 'utf8');
    expect(exportScript).toContain('lineTableModel');
    expect(exportScript).toContain('buildTableSvg');
    expect(exportScript).toContain('數據明細');
    expect(exportScript).toContain('cx-data-details');
  });

  it('wires the designated SKU reply page, admin tab and direct link', () => {
    const page = readFileSync(path.join(root, 'public', 'portal', 'designated-sku.html'), 'utf8');
    const storeScript = readFileSync(path.join(root, 'public', 'portal', 'js', 'designated-sku.js'), 'utf8');
    const adminHtml = readFileSync(path.join(root, 'public', 'admin', 'index.html'), 'utf8');
    const adminScript = readFileSync(path.join(root, 'public', 'js', 'admin-designated-sku.js'), 'utf8');

    // 店舖端：一個事項多個 SKU + 直 link
    expect(page).toContain('id="ds_reply_dialog"');
    expect(page).toContain('id="ds_sku_sections"');
    expect(page).toContain('/portal/js/designated-sku.js');
    expect(storeScript).toContain("get('matter')");
    expect(storeScript).toContain('/api/portal/designated-sku/matters/');
    expect(storeScript).toContain('no_transfer');

    // 後台：新分頁 + 上載欄位（預留欄位可空白）
    expect(adminHtml).toContain('data-tab="designated-sku"');
    expect(adminHtml).toContain('id="panel-designated-sku"');
    expect(adminHtml).toContain('id="dsku_subject"');
    expect(adminHtml).toContain('id="dsku_due_at"');
    expect(adminHtml).toContain('id="dsku_manual_body"');
    expect(adminScript).toContain('__dskuRefresh');
    expect(adminScript).toContain('matters/');
    expect(adminScript).toContain('?matter=');
    expect(adminScript).toContain('designated-sku/export');
    // 管理員代店舖回覆：明細行有「代回覆 / 編輯回覆」，彈窗可改年期
    expect(adminScript).toContain('dsku_edit_reply_overlay');
    expect(adminScript).toContain('代回覆');

    // 回覆自定欄位（每批次不同，上限 10）：批次定義 → 店舖端動態表單 → 後台欄位編輯
    const portalCss = readFileSync(path.join(root, 'public', 'portal', 'css', 'portal.css'), 'utf8');
    expect(storeScript).toContain('ds-cf-input');
    expect(storeScript).toContain('reply_fields');
    expect(storeScript).toContain('reply_scope');
    expect(portalCss).toContain('.ds-cf-grid');
    expect(adminHtml).toContain('id="dsku_fields_overlay"');
    expect(adminHtml).toContain('id="dsku_reply_mode"');
    expect(adminScript).toContain('/reply-fields');
    expect(adminScript).toContain('dsku-cf-input');
    const omScript = readFileSync(path.join(root, 'public', 'portal', 'js', 'om-designated-sku.js'), 'utf8');
    expect(omScript).toContain('ds-cf-input');

    // CSRF：aFetch 一定要真正送出 x-csrf-token header（曾漏傳 headers，整個分頁寫入 403）
    expect(adminScript).toContain("'x-csrf-token': token");
    expect(adminScript).toMatch(/fetch\(url, \{ \.\.\.opts, headers, credentials/);
    // 事項類型可自由輸入（曾只有一個選項）
    expect(adminHtml).toContain('list="dsku_matter_type_options"');
    expect(adminScript).toContain('matterTypeValue()');
  });

  it('keeps the admin tabs consolidated (匯出批次 → 匯出, 帳戶／審批 → 系統)', () => {
    const html = readFileSync(path.join(root, 'public', 'admin', 'index.html'), 'utf8');
    const ui = readFileSync(path.join(root, 'public', 'js', 'admin-ui.js'), 'utf8');
    const script = readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');

    const nav = html.slice(html.indexOf('id="admin_nav_links"'), html.indexOf('id="nav_refresh_note"'));
    const tabs = [...nav.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(['overview', 'list', 'export', 'zero-sales', 'stock', 'designated-sku', 'system']);

    // 舊的分頁殼不應再存在，但舊連結要靠 alias 仍然可用
    expect(html).not.toContain('id="panel-batches"');
    expect(html).not.toContain('id="panel-accounts"');
    expect(html).not.toContain('id="panel-review"');

    // 合併後的內容仍在，並有頁內分組導覽
    for (const anchor of ['sec-batches', 'sec-accounts', 'sec-review', 'sec-notice', 'sec-tools']) {
      expect(html).toContain(`id="${anchor}"`);
      expect(html).toContain(`data-subnav-target="${anchor}"`);
    }

    // 每個分頁只保留一個 panel，且與導航一一對應
    const panels = [...html.matchAll(/data-tab-panel="([^"]+)"/g)].map((m) => m[1]);
    expect(panels.sort()).toEqual([...tabs].sort());

    expect(ui).toContain('TAB_ALIAS');
    expect(ui).toContain("batches: { tab: 'export', anchor: 'sec-batches' }");
    expect(ui).toContain("accounts: { tab: 'system', anchor: 'sec-accounts' }");
    expect(ui).toContain("review: { tab: 'system', anchor: 'sec-review' }");

    // 系統分頁的懶載入區塊照舊逐個載入（切分頁不會一次過打 6 個 API）
    expect(html).toContain('data-lazy-section="portal-users"');
    expect(html).toContain('data-lazy-section="sku-master"');
    expect(html).toContain('data-lazy-section="stores"');
    expect(script).toContain("tab === 'export'");
    expect(script).not.toContain("tab === 'batches'");
  });

  it('wires the database backup panel to backup_runs and the bucket download', () => {
    const html = readFileSync(path.join(root, 'public', 'admin', 'index.html'), 'utf8');
    const script = readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');
    const adminCss = readFileSync(path.join(root, 'public', 'css', 'admin.css'), 'utf8');

    expect(html).toContain('data-lazy-section="backup"');
    expect(html).toContain('id="btn_backup_download"');
    expect(html).toContain('id="backup_runs_body"');
    expect(script).toContain('backup: loadBackupStatus');
    expect(script).toContain("'/api/admin/backup/status'");
    expect(script).toContain("'/api/admin/backup/latest'");
    // 「延遲」需要自己的黃色 badge，否則 .status-badge 只有藍／紅兩種
    expect(adminCss).toContain('.status-badge.warn');
  });

  it('ships the backup cron service definition', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile.backup'), 'utf8');
    const backupScript = readFileSync(path.join(root, 'scripts', 'backup.sh'), 'utf8');

    // pg_dump 版本必須 >= 伺服器（18），所以基底一定要 postgres:18-*
    expect(dockerfile).toContain('FROM postgres:18-alpine');
    expect(dockerfile).toContain('ENTRYPOINT []');
    expect(backupScript).toContain('pg_dump --format=custom');
    expect(backupScript).toContain("status = 'success'");
    expect(backupScript).toContain('--min-age');
  });

  it('wires the OM portal login, reply and stock views', () => {
    const page = readFileSync(path.join(root, 'public', 'portal', 'om.html'), 'utf8');
    const script = readFileSync(path.join(root, 'public', 'portal', 'js', 'om.js'), 'utf8');
    const dskuScript = readFileSync(path.join(root, 'public', 'portal', 'js', 'om-designated-sku.js'), 'utf8');
    const portalCss = readFileSync(path.join(root, 'public', 'portal', 'css', 'portal.css'), 'utf8');
    expect(page).toContain('id="om_login_form"');
    expect(page).toContain('id="panel_om_overview"');
    expect(page).toContain('id="panel_om_zero"');
    expect(page).toContain('id="panel_om_dsku"');
    expect(page).toContain('id="panel_om_stock"');
    // 兩個走勢圖已合併成一張卡，用按鈕切換口徑（不再是 om_sku_chart 獨立卡）
    expect(page).toContain('id="om_stock_metric"');
    expect(page).toContain('data-om-stock-metric="value"');
    expect(page).toContain('data-om-stock-metric="sku"');
    expect(page).not.toContain('id="om_sku_chart"');
    // 管轄店舖不良佔比排名（只列自己 OM 的店）
    expect(page).toContain('id="om_share_chart"');
    expect(script).toContain('renderOmShare');
    expect(script).toContain('data-om-stock-metric');
    expect(script).toContain('setStockMetric');
    // 手機／平板（CSS ≤900px）不出直排柱底店名，改為「一行一店」清單：
    // 直排店名只有 22px 闊，中文會疊字，睇唔到係邊間店
    expect(script).toContain('om-share-rows');
    expect(script).toContain('om-share-row-shop');
    expect(portalCss).toContain('.om-share-rows { display: none; }');
    expect(portalCss).toContain('.om-share-bars { display: none; }');
    expect(portalCss).toContain('.om-share-rows { display: block; }');
    // 同一月份有月結時，週更點只留 tooltip、不畫數值標籤；月結後未有新月結的週更照標
    expect(script).toContain('weeklyLabelVisibility');
    expect(script).toContain('showLabel');
    // 選店舖時三線：所選店舖（綠）、OM 合計（藍）、全公司（虛線）；legend 加權 tooltip
    expect(page).toContain('id="om_stock_legend_store"');
    expect(page).toContain('Σ分子 ÷ Σ分母，不是各店平均');
    expect(script).toContain('omSeries');
    expect(script).toContain('labelSeries: isStore ? [0, 1] : undefined');
    expect(page).toContain('不良 SKU / Carry SKU');
    expect(page).toContain('/portal/js/om.js');
    expect(page).toContain('/portal/js/om-designated-sku.js');
    expect(script).toContain('/api/portal/om/zero-sales/items/');
    expect(script).toContain('/api/portal/om/stock');
    expect(dskuScript).toContain('/api/portal/om/designated-sku/matters/');
    expect(dskuScript).toContain('OM 代覆');
  });

  it('keeps the store navigation identical on every store page', () => {
    const pages = [
      'portal/zero-sales.html',
      'portal/designated-sku.html',
      'portal/store.html',
      'urgent.html',
      'sales.html',
      'return.html',
      'lookup.html',
      'help.html',
    ];
    const navOf = (page: string): string[] => {
      const html = readFileSync(path.join(root, 'public', page), 'utf8');
      const block = /<nav aria-label="主要導覽">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
      return [...block.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
        .map(([, href, inner]) => `${href} :: ${inner.replace(/<[^>]+>/g, '').trim()}`);
    };
    const base = navOf('portal/zero-sales.html');
    expect(base).toContain('/portal/designated-sku.html :: 指定SKU回覆');
    for (const page of pages.slice(1)) {
      // 站內所有店舖頁共用同一組導覽，只換 active；新增功能時要一次過改齊
      expect(navOf(page), page).toEqual(base);
    }
  });

  // 徽章只屬提示：每個店舖頁面（包括公開頁）都要有，否則店舖轉頁就漏做
  it('shows the same pending-count badges on every store page', () => {
    const pages = [
      'portal/zero-sales.html',
      'portal/designated-sku.html',
      'portal/store.html',
      'urgent.html',
      'sales.html',
      'return.html',
      'lookup.html',
      'help.html',
    ];
    for (const page of pages) {
      const html = readFileSync(path.join(root, 'public', page), 'utf8');
      expect(html, page).toContain('/portal/js/nav-badges.js');
    }

    const script = readFileSync(path.join(root, 'public/portal/js/nav-badges.js'), 'utf8');
    // 一次過取兩個數字；0 不出現；9 以上收斂成 9+
    expect(script).toContain('/api/portal/nav-badges');
    expect(script).toContain("n > 9 ? '9+' : String(n)");
    // 目前所在頁面不顯示（列表就在下面）
    expect(script).toContain("link.getAttribute('aria-current') === 'page'");
    // 未登入（公開頁面的訪客）不可被彈去登入頁
    expect(script).not.toMatch(/window\.location\.(href|replace)/);
    // 結果要廣播，讓頁面自己的橫幅重用同一份數字（避免重複打 API）
    expect(script).toContain("'portal:nav-badges'");

    // 公開頁面只載入 style.css，徽章樣式必須放在那裡才會生效
    const style = readFileSync(path.join(root, 'public/css/style.css'), 'utf8');
    expect(style).toMatch(/\.nav-badge\s*\{/);
    const portalCss = readFileSync(path.join(root, 'public/portal/css/portal.css'), 'utf8');
    expect(portalCss).not.toMatch(/\.nav-badge\s*\{/);
  });

  // 全站 CSRF 是雙重提交：POST 一定要帶 x-csrf-token。共用登入閘曾經完全
  // 冇帶，店舖在零銷售／退貨等頁面登入時永遠 403「CSRF token 無效」。
  it('sends the CSRF token from the shared login gate', () => {
    const gate = readFileSync(path.join(root, 'public/js/site-gate.js'), 'utf8');
    expect(gate).toContain('x-csrf-token');
    expect(gate).toContain('postWithCsrf');
    // 不許再有裸 fetch 直接打需要 CSRF 的端點
    expect(gate).not.toMatch(/fetch\(\s*'\/api\/portal\/auth\/(login|logout)'/);

    const help = readFileSync(path.join(root, 'public/help.html'), 'utf8');
    const logoutAt = help.indexOf("fetch('/api/portal/auth/logout'");
    expect(logoutAt).toBeGreaterThan(-1);
    expect(help.slice(logoutAt, logoutAt + 400)).toContain('x-csrf-token');
  });

  it('keeps 行貨退貨 paused together with the rest of the platform', () => {
    const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
    const returnPage = read('public/return.html');
    const lookupPage = read('public/lookup.html');
    const indexPage = read('public/index.html');
    const publicRoutes = read('src/routes/public.ts');

    // 退貨頁由平台暫停腳本接管，導覽與首頁卡片都要顯示暫停
    expect(returnPage).toContain('/js/service-suspension.js');
    expect(returnPage).toContain(
      '<a href="/return.html" class="active nav-paused" aria-current="page" title="暫停收單，仍可進入查看">行貨退貨 · 暫停</a>',
    );
    expect(indexPage).toContain('行貨退貨報數<span class="badge-paused">暫停收單</span>');

    // 其他服務同樣被前端暫停腳本鎖住
    expect(read('public/urgent.html')).toContain('/js/service-suspension.js');
    expect(read('public/sales.html')).toContain('/js/service-suspension.js');

    // 後端：退貨提交／匯入與修改全部落在平台暫停守衛之內，沒有逐類型豁免
    const between = (from: string, to: string) => publicRoutes.slice(
      publicRoutes.indexOf(from),
      publicRoutes.indexOf(to),
    );
    const returnSubmit = between("'/return/submit'", "'/return/template'");
    expect(returnSubmit).toContain('requirePublicWritesOpen');
    expect(returnSubmit).not.toContain('requireReturnWritesOpen');
    const returnImport = between("'/return/import'", "'/return/import/record'");
    expect(returnImport).toContain('requirePublicWritesOpen');
    expect(returnImport).not.toContain('requireReturnWritesOpen');

    // 查詢／修改頁整體封鎖，lookup.js 不再逐單判斷
    expect(lookupPage).toContain('/js/service-suspension.js');
    expect(read('public/js/lookup.js')).not.toContain('suspendedFor');

    // 教學頁要跟得上：第 9 節標明暫停
    expect(read('public/help.html')).toContain('9. 行貨退貨報數（暫停收單，仍可進入查看）');
  });

  it('shop-facing password boxes do not invite browser autofill, and trim before sending', () => {
    const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
    // 一台電腦會輪流登入多間店（RP Team）或多個 OM。Chrome 會把上一個帳戶的
    // 密碼自動填進同一個框，畫面上同樣是一排圓點，看起來像已打對，實際送出
    // 舊密碼換來「密碼不正確」。所以店舖／OM 的密碼框一律關閉自動填入。
    for (const file of ['public/js/site-gate.js', 'public/portal/js/portal.js', 'public/portal/om.html']) {
      expect(read(file), file).not.toContain('autocomplete="current-password"');
      expect(read(file), file).toContain('autocomplete="off"');
    }
    // 由 WhatsApp／電郵複製密碼常夾帶尾隨空白或換行，送出前必須 trim。
    expect(read('public/js/site-gate.js')).toContain("const pass = (passInput.value || '').trim();");
    expect(read('public/portal/js/portal.js')).toContain("const pass = (passInput.value || '').trim();");
    expect(read('public/portal/js/om.js')).toContain("const pass = ($('om_login_pass')?.value || '').trim();");
  });
});

describe('門店主檔同步入口', () => {
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

  it('keeps the bundled-template sync button wired to its endpoint', () => {
    // 主檔改動只 commit 到 repo、唔上載 CSV 時，DB 會停留在舊版（HBB2 就係咁
    // 消失了 34 日）。除了啟動同步，後台亦要有手動入口；HTML 與 JS 要同步。
    // id 必須同「按門店主檔同步 Store 帳戶」(btn_store_sync) 分開：
    // $() 只會取第一個同名元素，重複 id 會令其中一粒按鈕永遠無反應。
    const html = read('public/admin/index.html');
    expect(html.match(/id="btn_store_master_sync"/g) ?? []).toHaveLength(1);
    expect(read('public/js/admin.js')).toContain("$('btn_store_master_sync').addEventListener");
    expect(read('public/js/admin.js')).toContain("'/api/admin/stores/sync-master'");
  });

  it('syncs the bundled store master on boot instead of only seeding an empty table', () => {
    const entry = read('src/index.ts');
    expect(entry).toContain('syncStoreMasterOnBoot');
    expect(entry).toContain('storesMasterSyncOnBoot');
    expect(entry).not.toContain('stores master empty');
    expect(read('src/config.ts')).toContain("bool('STORES_MASTER_SYNC_ON_BOOT', true)");
  });
});

describe('RP Connect 品牌鎖定', () => {
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

  it('uses the full brand name in the password notification copy (WhatsApp / email)', () => {
    // 派密碼係店舖第一次、亦係最多次接觸平台名稱的地方。公司另有系統叫「Portal」，
    // 只寫「RP 連繫網」或舊寫法「RP 連繫網（RP Connect）」都容易被混淆，所以
    // WhatsApp 內文、郵件內文、郵件主旨一律用全名。
    const script = read('public/js/admin.js');
    expect(script).toContain('RP Connect — RP 連繫網申報平台已為貴店設定專屬登入密碼');
    expect(script).toContain('RP Connect — RP 連繫網申報平台已為您設定專屬登入帳號');
    expect(script).toContain("encodeURIComponent('RP Connect — RP 連繫網申報平台 專屬登入密碼')");
    // 舊寫法不可回頭
    expect(script).not.toContain('RP 連繫網（RP Connect）');
  });

  it('shows database-driven notices once on every shop and OM page', () => {
    // 公司另有系統叫 Portal，改名通告要顯示一次；但通告內容改由後台維護，
    // 前端不可再寫死任何文案，否則下次改字又要改程式碼。
    const pages = [
      'public/portal/zero-sales.html',
      'public/portal/store.html',
      'public/portal/designated-sku.html',
      'public/portal/om.html',
      'public/urgent.html',
      'public/sales.html',
      'public/return.html',
      'public/lookup.html',
      'public/help.html',
    ];
    for (const page of pages) {
      expect(read(page), page).toContain('/js/portal-notice.js');
    }

    const script = read('public/js/portal-notice.js');
    expect(script).toContain("fetch('/api/public/notice'");
    // 記號要帶版本，否則「重新推送」會被舊記號擋住
    expect(script).toContain('rp_notice_');
    expect(script).toContain('_r${notice.revision}');
    // 關閉記號存 localStorage（不是 sessionStorage：關掉瀏覽器再開不應重提）
    expect(script).not.toContain('sessionStorage.setItem');
    // 樣式放在 style.css，公開頁（無載入 portal.css）才吃得到
    expect(read('public/css/style.css')).toContain('.portal-notice {');

    // 改名通告本身由 migration 寫入，之後可以在後台改字／停用
    const migration = read('src/db/migrations/037_portal_notices.sql');
    expect(migration).toContain('RP Portal 已改名為');
    expect(migration).toContain('SASA Portal');

    // 後台入口
    const adminHtml = read('public/admin/index.html');
    expect(adminHtml).toContain('id="sec-notice"');
    expect(adminHtml).toContain('data-subnav-target="sec-notice"');
    expect(adminHtml).toContain('/js/admin-notices.js');
  });
});
