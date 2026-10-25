import request, { type Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();

const CSRF_COOKIE = 'csrf_token';

/** 由 Set-Cookie 取出 csrf_token 的值（沒有就回 null）。 */
function csrfCookieValue(res: Response): string | null {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const line of list) {
    const match = new RegExp(`^${CSRF_COOKIE}=([^;]+)`).exec(line);
    if (match) return match[1];
  }
  return null;
}

const withCookie = (cookie: string | null) => ({ Cookie: `${CSRF_COOKIE}=${cookie}` });

describe('CSRF cookie minting', () => {
  it('does not mint a token for static assets', async () => {
    // 靜態資源也曾鑄 token；冷啟動時多個並行回應各自 Set-Cookie，
    // 瀏覽器只保留最後一個，頁面手上的 token 便可能與 cookie 不同。
    for (const url of ['/css/style.css', '/js/api.js', '/portal/js/zero-sales.js']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(csrfCookieValue(res)).toBeNull();
    }
  });

  it('mints exactly one token when a document is loaded without a cookie', async () => {
    const res = await request(app).get('/portal/zero-sales.html');
    expect(res.status).toBe(200);
    const raw = res.headers['set-cookie'] as unknown as string[];
    const minted = raw.filter((line) => line.startsWith(`${CSRF_COOKIE}=`));
    expect(minted).toHaveLength(1);
    expect(csrfCookieValue(res)).toBeTruthy();
  });

  it('mints a token for /api/csrf when there is no cookie yet', async () => {
    const res = await request(app).get('/api/csrf');
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(csrfCookieValue(res)).toBe(res.body.token);
  });

  it('reuses the cookie value once it exists, without re-sending it', async () => {
    const page = await request(app).get('/admin/');
    const cookie = csrfCookieValue(page);
    expect(cookie).toBeTruthy();

    const token = await request(app).get('/api/csrf').set(withCookie(cookie));
    expect(token.status).toBe(200);
    expect(token.body.token).toBe(cookie);
    // 已有 cookie 時不再發新的 Set-Cookie，避免無謂覆寫
    expect(csrfCookieValue(token)).toBeNull();
  });

  it('lets a write through when header and cookie match', async () => {
    const page = await request(app).get('/admin/');
    const cookie = csrfCookieValue(page);
    const token = (await request(app).get('/api/csrf').set(withCookie(cookie))).body.token as string;

    // 未登入（401）代表已通過 CSRF 檢查；若 token 不符會是 403
    const res = await request(app)
      .post('/api/admin/stock/batches')
      .set(withCookie(cookie))
      .set('x-csrf-token', token)
      .field('report_date', '2026-05-31')
      .field('report_kind', 'month_end');
    expect(res.status).toBe(401);
  });

  it('rejects a stale token, which is what a long-lived tab used to hit', async () => {
    const page = await request(app).get('/admin/');
    const cookie = csrfCookieValue(page);

    const res = await request(app)
      .post('/api/admin/stock/batches')
      .set(withCookie(cookie))
      .set('x-csrf-token', 'a'.repeat(64))
      .field('report_date', '2026-05-31')
      .field('report_kind', 'month_end');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('CSRF');
  });
});
