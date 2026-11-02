import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles } from './migrateTest.js';
import { setPoolForTesting } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { replaceStores } from '../src/services/stores.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: Express;
let db: PGlite;

type Agent = ReturnType<typeof request.agent> & { _csrf?: string };

async function csrf(agent: Agent): Promise<string> {
  const res = await agent.get('/api/csrf');
  return res.body.token as string;
}

async function adminAgent(): Promise<Agent> {
  const agent = request.agent(app) as Agent;
  const token = await csrf(agent);
  const res = await agent
    .post('/api/admin/login')
    .set('x-csrf-token', token)
    .send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  agent._csrf = await csrf(agent);
  return agent;
}

/** 前台見到的通告（店舖與 OM 頁面開頁時打的那一支）。 */
async function publicNotices() {
  const res = await request(app).get('/api/public/notice');
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toContain('no-store');
  return res.body.notices as Array<{ id: string; title: string; revision: number }>;
}

function noticePayload(overrides: Record<string, unknown> = {}) {
  return {
    title: '測試通告',
    body: '測試內容',
    tone: 'info',
    isActive: true,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting({
    query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
    connect: async () => ({
      query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
      release: () => {},
    }),
  } as never);

  const migrationFiles = await listMigrationFiles();
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
  await replaceStores([
    { site_code: 'HA02', shop: '駱克', regional: 'HK', class1: 'B', class2: 'B2', size: 'S', om: 'Ivy', type: 'T' },
  ]);
  app = createApp();
});

describe('平台通告', () => {
  it('serves the seeded rename notice to the shop pages without login', async () => {
    // migration 037 要把改名通告種入 DB，否則切換之後店舖會靜靜收不到通知
    const notices = await publicNotices();
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]!.title).toContain('RP Portal 已改名為 RP Connect — RP 連繫網申報平台');
  });

  it('requires an admin session to read the admin list', async () => {
    const res = await request(app).get('/api/admin/notices');
    expect(res.status).toBe(401);
  });

  it('keeps a scheduled notice hidden until its start time', async () => {
    const admin = await adminAgent();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const created = await admin
      .post('/api/admin/notices')
      .set('x-csrf-token', admin._csrf!)
      .send(noticePayload({ title: '未開始通告', startsAt: future }));
    expect(created.status).toBe(201);

    const ids = (await publicNotices()).map((n) => n.id);
    expect(ids).not.toContain(created.body.notice.id);

    // 把開始時間清空 → 立即生效
    const updated = await admin
      .put(`/api/admin/notices/${created.body.notice.id}`)
      .set('x-csrf-token', admin._csrf!)
      .send(noticePayload({ title: '未開始通告', startsAt: null }));
    expect(updated.status).toBe(200);

    const after = await publicNotices();
    expect(after.map((n) => n.id)).toContain(created.body.notice.id);
  });

  it('bumps the revision on republish so shops see it again', async () => {
    const admin = await adminAgent();
    const created = await admin
      .post('/api/admin/notices')
      .set('x-csrf-token', admin._csrf!)
      .send(noticePayload({ title: '重推通告' }));
    expect(created.status).toBe(201);
    expect(created.body.notice.revision).toBe(1);

    const republished = await admin
      .post(`/api/admin/notices/${created.body.notice.id}/republish`)
      .set('x-csrf-token', admin._csrf!);
    expect(republished.status).toBe(200);
    expect(republished.body.notice.revision).toBe(2);

    // 重新推送亦會順手重新啟用（避免在停用狀態下按了卻沒效果）
    expect(republished.body.notice.is_active).toBe(true);
  });

  it('hides inactive notices from the shop pages but keeps them in the admin list', async () => {
    const admin = await adminAgent();
    const created = await admin
      .post('/api/admin/notices')
      .set('x-csrf-token', admin._csrf!)
      .send(noticePayload({ title: '停用通告', isActive: false }));
    expect(created.status).toBe(201);

    const ids = (await publicNotices()).map((n) => n.id);
    expect(ids).not.toContain(created.body.notice.id);

    const list = await admin.get('/api/admin/notices');
    expect(list.status).toBe(200);
    expect((list.body.notices as Array<{ id: string }>).map((n) => n.id)).toContain(created.body.notice.id);
  });

  it('removes the notice from the shop pages when deleted', async () => {
    const admin = await adminAgent();
    const created = await admin
      .post('/api/admin/notices')
      .set('x-csrf-token', admin._csrf!)
      .send(noticePayload({ title: '即將刪除' }));
    const id = created.body.notice.id as string;
    expect((await publicNotices()).map((n) => n.id)).toContain(id);

    const removed = await admin.delete(`/api/admin/notices/${id}`).set('x-csrf-token', admin._csrf!);
    expect(removed.status).toBe(200);
    expect((await publicNotices()).map((n) => n.id)).not.toContain(id);
  });

  it('rejects empty titles and unsafe links', async () => {
    const admin = await adminAgent();

    const noTitle = await admin
      .post('/api/admin/notices')
      .set('x-csrf-token', admin._csrf!)
      .send(noticePayload({ title: '   ' }));
    expect(noTitle.status).toBe(400);

    // javascript: 連結會被當成可執行 URL，前後端都要擋
    const badLink = await admin
      .post('/api/admin/notices')
      .set('x-csrf-token', admin._csrf!)
      .send(noticePayload({ title: '危險連結', linkUrl: 'javascript:alert(1)' }));
    expect(badLink.status).toBe(400);

    const linkWithoutUrl = await admin
      .post('/api/admin/notices')
      .set('x-csrf-token', admin._csrf!)
      .send(noticePayload({ title: '只有按鈕文字', linkText: '查看' }));
    expect(linkWithoutUrl.status).toBe(400);
  });
});
