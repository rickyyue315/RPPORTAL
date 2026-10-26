import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const app = createApp();

const HTML_PAGES = ['/', '/portal/', '/portal/zero-sales.html', '/portal/store.html', '/portal/designated-sku.html'];
const VERSIONED_ASSETS = [
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

  it('wires the designated SKU reply page, admin tab and direct link', () => {
    const page = readFileSync(path.join(root, 'public', 'portal', 'designated-sku.html'), 'utf8');
    const storeScript = readFileSync(path.join(root, 'public', 'portal', 'js', 'designated-sku.js'), 'utf8');
    const adminHtml = readFileSync(path.join(root, 'public', 'admin', 'index.html'), 'utf8');
    const adminScript = readFileSync(path.join(root, 'public', 'js', 'admin-designated-sku.js'), 'utf8');

    // 店舖端：多個年期編輯器 + 直 link
    expect(page).toContain('id="ds_reply_dialog"');
    expect(page).toContain('id="ds_lines"');
    expect(page).toContain('/portal/js/designated-sku.js');
    expect(storeScript).toContain("get('task')");
    expect(storeScript).toContain('/api/portal/designated-sku/tasks/');

    // 後台：新分頁 + 上載欄位（預留欄位可空白）
    expect(adminHtml).toContain('data-tab="designated-sku"');
    expect(adminHtml).toContain('id="panel-designated-sku"');
    expect(adminHtml).toContain('id="dsku_subject"');
    expect(adminHtml).toContain('id="dsku_due_date"');
    expect(adminScript).toContain('__dskuRefresh');
    expect(adminScript).toContain('designated-sku/export');
    // 管理員代店舖回覆：明細行有「代回覆 / 編輯回覆」，彈窗可改年期
    expect(adminScript).toContain('dsku_edit_reply_overlay');
    expect(adminScript).toContain('代回覆');
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
