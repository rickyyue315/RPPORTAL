/**
 * End-to-end smoke test: boots the compiled server with PGlite as the
 * database (via DATABASE_URL override is not possible, so we run in-process),
 * exercises the full public + admin flows over HTTP.
 *
 * Run with: npx tsx test/smoke.ts
 *
 * Note: config is read at import time, so app modules are imported
 * dynamically AFTER the test credentials are set in process.env.
 */
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'smoke-password';
// Config requires DATABASE_URL at import time even though the smoke test runs
// against an in-memory PGlite; provide a harmless default for local runs.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://smoke:smoke@localhost:5432/smoke';

const { PGlite } = await import('@electric-sql/pglite');
const { readFile } = await import('node:fs/promises');
const { default: path } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { default: ExcelJS } = await import('exceljs');
const { TEMPLATE_COLUMNS, RP_TEAM_SHEET, RETURN_COLUMNS, RETURN_SHEET } = await import('../src/lib/fields.js');
const { setPoolForTesting } = await import('../src/db/pool.js');
const { seedStoresFromFile } = await import('../src/services/stores.js');
const { createApp } = await import('../src/app.js');

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

console.log('[smoke] PGlite ready');

// Apply migrations manually without the pgcrypto extension line.
for (const file of ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql', '010_query_optimization.sql', '011_cleanup_legacy_schema.sql', '012_om_recovery_codes.sql', '013_recovery_code_plaintext.sql', '014_ndrf_workflow_portal.sql']) {
  const sql = (await readFile(path.join(root, 'src', 'db', 'migrations', file), 'utf8')).replace(
    /CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g,
    '',
  );
  await db.exec(sql);
}
console.log('[smoke] migrations applied');

// Seed a master recovery code (works for every store) plus an Ivy group code.
const { createHash } = await import('node:crypto');
await db.query(
  `INSERT INTO om_recovery_codes (om, code, code_hash, updated_by, updated_at) VALUES ($1, $2, $3, 'smoke', now())`,
  ['__MASTER__', 'smoke-recovery-code', createHash('sha256').update('smoke-recovery-code').digest('hex')],
);
await db.query(
  `INSERT INTO om_recovery_codes (om, code, code_hash, updated_by, updated_at) VALUES ($1, $2, $3, 'smoke', now())`,
  ['Ivy', 'smoke-ivy-code', createHash('sha256').update('smoke-ivy-code').digest('hex')],
);

// Seed stores from the CSV.
const csvPath = path.join(root, 'stores-template.csv');
await seedStoresFromFile(csvPath);
console.log('[smoke] stores seeded');

// Seed a Store portal account and a small SKU Master so the portal flow works.
const { hashPassword } = await import('../src/services/portalAuth.js');
const smokePwHash = await hashPassword('SmokeTest1!AAAA');
await db.query(
  `INSERT INTO portal_users (username, display_name, role, site_code, password_hash, must_change_password, active, created_by)
   VALUES ('HA02', '駱克', 'store', 'HA02', $1, false, true, 'smoke')
   ON CONFLICT (username) DO NOTHING`,
  [smokePwHash],
);
const smokeBuyer = await db.query<{ id: string }>(
  `INSERT INTO portal_users (username, display_name, role, password_hash, must_change_password, active, created_by)
   VALUES ('BUYER1', 'Smoke Buyer', 'buyer', $1, false, true, 'smoke')
   ON CONFLICT (username) DO UPDATE SET active = true
   RETURNING id`,
  [smokePwHash],
);
await db.query(
  `INSERT INTO portal_users (username, display_name, role, password_hash, must_change_password, active, created_by)
   VALUES ('SCT1', 'Smoke SCT', 'sct', $1, false, true, 'smoke')
   ON CONFLICT (username) DO NOTHING`,
  [smokePwHash],
);
for (const sku of ['1005020', '1005051', '1002001']) {
  await db.query(
    `INSERT INTO sku_master (sku, buyer_user_id, updated_by) VALUES ($1, $2, 'smoke')
     ON CONFLICT (sku) DO NOTHING`,
    [sku, smokeBuyer.rows[0]!.id],
  );
}
console.log('[smoke] portal users + sku master seeded');

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

    const urgentWindow = await fetch(`${base}/api/public/urgent/window`);
    const urgentWindowJson = await urgentWindow.json();
    check('urgent window', urgentWindow.status === 200 && typeof urgentWindowJson.open === 'boolean');
    const urgentOpen = urgentWindowJson.open === true;

    const store = await fetch(`${base}/api/public/stores/HA02`);
    const storeJson = await store.json();
    check('store lookup HA02', storeJson.store?.shop === '駱克');

    // Portal login + normal NDRF submission (RF -> ready_for_rp).
    const portalCsrf = await fetch(`${base}/api/csrf`);
    const portalCsrfJson = await portalCsrf.json();
    collectCookie(portalCsrf);
    const portalLoginRes = await fetch(`${base}/api/portal/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieJar,
        'x-csrf-token': portalCsrfJson.token,
      },
      body: JSON.stringify({ username: 'HA02', password: 'SmokeTest1!AAAA' }),
    });
    collectCookie(portalLoginRes);
    check('portal login', portalLoginRes.status === 200);

    const submit = await fetch(`${base}/api/portal/store/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieJar,
        'x-csrf-token': portalCsrfJson.token,
      },
      body: JSON.stringify({ brand: 'Test', sku: '1005020', rp_type: 'RF', safety_stock: '5' }),
    });
    const submitJson = await submit.json();
    check('portal web submit', submit.status === 201 && /^NDRF-/.test(submitJson.submission.application_no));

    const appNo = submitJson.submission.application_no;
    const storeList = await fetch(`${base}/api/portal/store/submissions`, { headers: { cookie: cookieJar } });
    const storeListJson = await storeList.json();
    check('store dashboard list', storeList.status === 200 && storeListJson.submissions.some((s: { application_no: string }) => s.application_no === appNo));

    const blockedPublicQuery = await fetch(`${base}/api/public/query?application_no=${appNo}&site_code=HA02`);
    check('normal query blocked on public API', blockedPublicQuery.status === 403);

    const urgent = await fetch(`${base}/api/public/urgent/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_code: 'HA06', sku: '1005022', qty: 8, urgent_reason: '1' }),
    });
    const urgentJson = await urgent.json();
    check(
      'urgent web submit',
      urgentOpen
        ? urgent.status === 201 && /^URGENT-/.test(urgentJson.submission.application_no) && urgentJson.submission.qty === 8 && urgentJson.submission.urgent_reason === '1'
        : urgent.status === 400 && String(urgentJson.error ?? '').includes('14:30'),
    );

    const urgentBatch = await fetch(`${base}/api/public/urgent/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_code: 'HA02',
        items: [
          { sku: '1005031', qty: 2, urgent_reason: '1' },
          { sku: '1005032', qty: 3, urgent_reason: '9', urgent_reason_other: 'smoke 加單' },
          { sku: '1005033', qty: 4, urgent_reason: '2' },
        ],
      }),
    });
    const urgentBatchJson = await urgentBatch.json();
    check(
      'urgent 3-SKU web batch',
      urgentOpen
        ? urgentBatch.status === 201
          && urgentBatchJson.submissions.length === 3
          && new Set(urgentBatchJson.submissions.map((s: { application_no: string }) => s.application_no)).size === 3
          && urgentBatchJson.submissions[1].urgent_reason_other === 'smoke 加單'
        : urgentBatch.status === 400 && String(urgentBatchJson.error ?? '').includes('14:30'),
    );

    const sales = await fetch(`${base}/api/public/sales/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_code: 'HA06', sku: '1005021' }),
    });
    const salesJson = await sales.json();
    check('sales web submit', sales.status === 201 && /^SALES-/.test(salesJson.submission.application_no));

    const recovery = await fetch(`${base}/api/public/my-applications?site_code=HA02`, {
      headers: { 'x-recovery-code': 'smoke-recovery-code' },
    });
    const recoveryJson = await recovery.json();
    check('public recovery with code', recovery.status === 200 && recoveryJson.store?.shop === '駱克');

    const returnWb = new ExcelJS.Workbook();
    const returnWs = returnWb.addWorksheet(RETURN_SHEET);
    returnWs.addRow([...RETURN_COLUMNS]);
    returnWs.addRow(['HA02', '1005041', 5, '1', 'smoke 確認人', '12345678']);
    const returnBuffer = Buffer.from(await returnWb.xlsx.writeBuffer());
    const returnImport = await fetch(`${base}/api/public/return/import`, {
      method: 'POST',
      body: (() => {
        const fd = new FormData();
        fd.append('file', new Blob([returnBuffer]), 'smoke-return.xlsx');
        return fd;
      })(),
    });
    const returnImportJson = await returnImport.json();
    check('public return import', returnImport.status === 201 && returnImportJson.successCount === 1);

    const csrf = await fetch(`${base}/api/csrf`);
    const csrfJson = await csrf.json();
    collectCookie(csrf);

    const meAnon = await fetch(`${base}/api/admin/me`);
    check('admin requires login', meAnon.status === 401);

    const badLogin = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieJar,
        'x-csrf-token': csrfJson.token,
      },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });
    check('admin login rejects wrong password', badLogin.status === 401);

    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieJar,
        'x-csrf-token': csrfJson.token,
      },
      body: JSON.stringify({ username: 'admin', password: 'smoke-password' }),
    });
    collectCookie(login);
    check('admin login', login.status === 200);

    const me = await fetch(`${base}/api/admin/me`, { headers: { cookie: cookieJar } });
    const meJson = await me.json();
    check('admin me after login', me.status === 200 && meJson.username === 'admin');

    const adminImportWb = new ExcelJS.Workbook();
    const adminImportWs = adminImportWb.addWorksheet(RP_TEAM_SHEET);
    adminImportWs.addRow([...TEMPLATE_COLUMNS]);
    adminImportWs.addRow(['HA02', '1005051', 'ND', '', 'ND20-SO-Not displayed in small stores', '']);
    const adminImportFd = new FormData();
    adminImportFd.append('file', new Blob([Buffer.from(await adminImportWb.xlsx.writeBuffer())]), 'smoke-admin-import.xlsx');
    const adminImport = await fetch(`${base}/api/admin/import`, {
      method: 'POST',
      headers: { cookie: cookieJar, 'x-csrf-token': csrfJson.token },
      body: adminImportFd,
    });
    const adminImportJson = await adminImport.json();
    check('admin import', adminImport.status === 201 && adminImportJson.successCount === 1);

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
    check('admin urgent export + lock', urgentOpen
      ? urgentExportRes.status === 200 && Number(urgentExportRes.headers.get('content-length')) > 1000
      : urgentExportRes.status === 400);

    const salesExportRes = await fetch(`${base}/api/admin/sales/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieJar,
        'x-csrf-token': csrfJson.token,
      },
      body: JSON.stringify({ include_exported: false }),
    });
    check('admin sales export + lock', salesExportRes.status === 200 && Number(salesExportRes.headers.get('content-length')) > 1000);

    const locked = await fetch(`${base}/api/admin/submissions?application_no=${appNo}&page=1`, {
      headers: { cookie: cookieJar },
    });
    const lockedJson = await locked.json();
    const lockedRow = lockedJson.submissions?.[0];
    const lockedEdit = lockedRow
      ? await fetch(`${base}/api/admin/submissions/${lockedRow.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            cookie: cookieJar,
            'x-csrf-token': csrfJson.token,
          },
          body: JSON.stringify({ sku: '1005020', rp_type: 'RF', safety_stock: '9' }),
        })
      : null;
    check('locked submission rejects admin edit', lockedEdit?.status === 409);

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
