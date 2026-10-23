import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const app = createApp();

const HTML_PAGES = ['/', '/portal/', '/portal/zero-sales.html', '/portal/store.html'];
const VERSIONED_ASSETS = [
  '/portal/js/zero-sales.js',
  '/portal/js/portal.js',
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

  it('stamps the root page as well', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`/css/style.css?v=${version}`);
    expect(res.text).toContain(`/js/version.js?v=${version}`);
  });

  it('stamps a directory index page', async () => {
    const res = await request(app).get('/portal/');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`/portal/js/portal.js?v=${version}`);
  });
});
