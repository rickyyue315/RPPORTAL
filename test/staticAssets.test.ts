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
  '/portal/js/dashboard.js',
  '/js/admin-designated-sku.js',
  '/js/chart-lite.js',
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

  it('wires the grouped SKU ratio trend into the admin stock page', () => {
    const html = readFileSync(path.join(root, 'public', 'admin', 'index.html'), 'utf8');
    const script = readFileSync(path.join(root, 'public', 'js', 'admin-stock.js'), 'utf8');
    const chart = readFileSync(path.join(root, 'public', 'js', 'chart-lite.js'), 'utf8');
    expect(html).toContain('id="stk_group_dashboard"');
    expect(html).toContain('id="stk_group_chart"');
    expect(html).toContain('data-stk-group-metric="sku"');
    expect(html).toContain('data-stk-group-dim="nature"');
    expect(script).toContain('renderGroupChart');
    expect(script).toContain('group_trend');
    expect(script).toContain('ovs_carry_ratio');
    expect(chart).toContain('renderBarGrid');
    // MTD 每店排名：要有獨立容器、店名欄及載入函式
    expect(html).toContain('id="stk_mtd_rank"');
    expect(html).toContain('id="stk_mtd_title"');
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
    // 分區篩選：全部／民生區／混合區／遊客區，預設全部
    expect(html).toContain('id="stk_share_nature"');
    expect(html).toContain('id="stk_share_body"');
    expect(html).toContain('data-stk-share-nature="all"');
    expect(html).toContain('data-stk-share-nature="local"');
    expect(html).toContain('data-stk-share-nature="mix"');
    expect(html).toContain('data-stk-share-nature="tourist"');
    expect(script).toContain('applyShareNature');
    // 排行榜篩選：OM／Shop Nature（預設全部）；表格本體要獨立容器，否則重畫會洗掉篩選列
    expect(html).toContain('id="stk_mtd_rank_body"');
    expect(html).toContain('id="stk_rank_om"');
    expect(html).toContain('id="stk_rank_nature"');
    expect(html).toContain('id="stk_rank_scope"');
    expect(script).toContain('filterRankRows');
    expect(script).toContain('syncRankOmOptions');
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
    for (const anchor of ['sec-batches', 'sec-accounts', 'sec-review', 'sec-tools']) {
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
    expect(html).toContain('data-lazy-section="recovery-codes"');
    expect(script).toContain("tab === 'export'");
    expect(script).not.toContain("tab === 'batches'");
  });

  it('wires the OM portal login, reply and stock views', () => {
    const page = readFileSync(path.join(root, 'public', 'portal', 'om.html'), 'utf8');
    const script = readFileSync(path.join(root, 'public', 'portal', 'js', 'om.js'), 'utf8');
    const dskuScript = readFileSync(path.join(root, 'public', 'portal', 'js', 'om-designated-sku.js'), 'utf8');
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
});
