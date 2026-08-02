/**
 * End-to-end smoke test: boots the compiled server with PGlite as the
 * database (via DATABASE_URL override is not possible, so we run in-process),
 * exercises the full public + admin flows over HTTP.
 *
 * Run with: npx tsx test/smoke.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPoolForTesting } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seedStoresFromFile } from '../src/services/stores.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const db = new PGlite();
setPoolForTesting({
  query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
  connect: async () => ({
    query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
    release: () => {},
  }),
} as never);

// Override migrate to strip pgcrypto (not available in PGlite WASM build).
import { pool } from '../src/db/pool.js';
const originalMigrate = await import('../src/db/migrate.js');
console.log('[smoke] PGlite ready');

// Apply migrations manually without the pgcrypto extension line.
for (const file of ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql']) {
  const sql = (await readFile(path.join(root, 'src', 'db', 'migrations', file), 'utf8')).replace(
    /CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g,
    '',
  );
  await db.exec(sql);
}
console.log('[smoke] migrations applied');

// Seed stores from the CSV.
const csvPath = path.join(root, 'stores-template.csv');
await seedStoresFromFile(csvPath);
console.log('[smoke] stores seeded');

import { createApp } from '../src/app.js';
const app = createApp();
const server = app.listen(0, async () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const results: string[] = [];
  const check = (name: string, cond: boolean) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);

  try {
    let cookieJar = '';

    const collectCookie = (res: Response) => {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        setCookie.split(/,(?=[^;]+=)/).forEach((c) => {
          const name = c.split('=')[0]?.trim();
          if (name) {
            const value = c.split(';')[0]?.trim() ?? '';
            cookieJar = cookieJar
              .split(';')
              .filter((p) => !p.trim().startsWith(`${name}=`))
              .filter(Boolean)
              .concat(value)
              .join('; ');
          }
        });
      }
    };

    const health = await fetch(`${base}/health`);
    check('health endpoint', health.status === 200);

    const store = await fetch(`${base}/api/public/stores/HA02`);
    const storeJson = await store.json();
    check('store lookup HA02', storeJson.store?.shop === '駱克');

    const submit = await fetch(`${base}/api/public/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_code: 'HA02', sku: 'SMOKE-001', brand: 'Test' }),
    });
    const submitJson = await submit.json();
    check('web submit', submit.status === 201 && /^NDRF-/.test(submitJson.submission.application_no));

    const appNo = submitJson.submission.application_no;
    const query = await fetch(`${base}/api/public/query?application_no=${appNo}&site_code=HA02`);
    check('query by app no', query.status === 200);

    const urgent = await fetch(`${base}/api/public/urgent/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_code: 'HA06', sku: 'SMOKE-URGENT', qty: 8 }),
    });
    const urgentJson = await urgent.json();
    check('urgent web submit', urgent.status === 201 && /^URGENT-/.test(urgentJson.submission.application_no) && urgentJson.submission.qty === 8);

    const csrf = await fetch(`${base}/api/csrf`);
    const csrfJson = await csrf.json();
    collectCookie(csrf);

    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieJar,
        'x-csrf-token': csrfJson.token,
      },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const loginJson = await login.json();
    collectCookie(login);
    check('admin login', login.status === 200 && loginJson.ok === true);

    const list = await fetch(`${base}/api/admin/submissions?page=1&page_size=10`, {
      headers: { cookie: cookieJar },
    });
    const listJson = await list.json();
    check('admin list', list.status === 200 && listJson.total >= 1);

    const exportRes = await fetch(`${base}/api/admin/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieJar,
        'x-csrf-token': csrfJson.token,
      },
      body: JSON.stringify({ include_exported: false }),
    });
    check('admin SAP export + lock', exportRes.status === 200 && Number(exportRes.headers.get('content-length')) > 1000);

    const urgentExportRes = await fetch(`${base}/api/admin/urgent/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieJar,
        'x-csrf-token': csrfJson.token,
      },
      body: JSON.stringify({ include_exported: false }),
    });
    check('admin urgent export + lock', urgentExportRes.status === 200 && Number(urgentExportRes.headers.get('content-length')) > 1000);

    const locked = await fetch(`${base}/api/public/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_no: appNo, site_code: 'HA02', sku: 'CHANGED' }),
    });
    check('locked submission rejects modify', locked.status === 409);

    const audit = await fetch(`${base}/api/admin/audit`, { headers: { cookie: cookieJar } });
    check('audit export', audit.status === 200 && Number(audit.headers.get('content-length')) > 100);
  } catch (err) {
    results.push(`FAIL unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    console.log('[smoke]');
    results.forEach((r) => console.log(`  ${r}`));
    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    server.close();
    process.exit(failed > 0 ? 1 : 0);
  }
});
