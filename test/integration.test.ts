import { describe, expect, it, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPoolForTesting } from '../src/db/pool.js';
import { replaceStores, getStore, parseStoresCsv } from '../src/services/stores.js';
import {
  createSubmission,
  getSubmissionByApplicationNo,
  modifySubmission,
  adminUpdateSubmission,
  LockedError,
} from '../src/services/submissions.js';
import { writeAuditEvent } from '../src/lib/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makePglitePool(db: PGlite): never {
  const clientLike = {
    async query(text: string, params?: unknown[]) {
      return db.query(text, params ?? []);
    },
    release: () => {},
  };
  return {
    query: async (text: string, params?: unknown[]) => db.query(text, params ?? []),
    connect: async (): Promise<PoolClient> => clientLike as PoolClient,
  } as never;
}

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  setPoolForTesting(makePglitePool(db));
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql'];
  for (const file of migrationFiles) {
    let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
    // PGlite bundles gen_random_uuid; the pgcrypto extension may not be available in WASM builds.
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
    await db.exec(sql);
  }
});

const baseFields = {
  brand: 'NEG - NEOGENCE',
  sku: '110079623001',
  rp_type: 'ND',
  safety_stock: '5',
  nd_code: 'ND20-SO-Not displayed in small stores',
  remark: '',
};

describe('stores master (integration)', () => {
  it('replaces and reads store master', async () => {
    const parsed = parseStoresCsv('Site,Shop,Regional,Class 1,Class 2,Size,OM,Type\nHA02,駱克,HK,B,B2,S,Ivy,T');
    expect(parsed.ok).toBe(true);
    await replaceStores(parsed.stores!);
    const store = await getStore('HA02');
    expect(store?.shop).toBe('駱克');
    expect(store?.regional).toBe('HK');
    expect(await getStore('ha02')).not.toBeNull();
  });
});

describe('submissions (integration)', () => {
  it('creates a web submission with application number + version', async () => {
    const row = await createSubmission({
      siteCode: 'HA02',
      source: 'web',
      fields: baseFields,
      ip: '203.0.113.1',
      changeSource: 'web_submit',
    });
    expect(row.application_no).toMatch(/^NDRF-/);
    expect(row.requested_by_email).toBe('ha02@sasa.com');
    expect(row.site_code).toBe('HA02');

    const found = await getSubmissionByApplicationNo(row.application_no, 'HA02');
    expect(found?.sku).toBe('110079623001');
    expect(found?.created_ip).toBe('203.0.113.1');
  });

  it('allows applicant to modify before export and adds a version', async () => {
    const row = await createSubmission({
      siteCode: 'HA02',
      source: 'web',
      fields: { ...baseFields, sku: '110079623002' },
      ip: '203.0.113.2',
      changeSource: 'web_submit',
    });
    const updated = await modifySubmission({
      applicationNo: row.application_no,
      siteCode: 'HA02',
      fields: { ...baseFields, sku: '999999999999', remark: 'changed' },
      ip: '203.0.113.2',
      actorRole: 'applicant',
      changeSource: 'web_modify',
    });
    expect(updated.sku).toBe('999999999999');
    const versions = await db.query(
      'SELECT count(*)::int AS cnt FROM submission_versions WHERE submission_id = $1',
      [row.id],
    );
    expect(versions.rows[0]?.cnt).toBe(2);
  });

  it('locks the submission after export and rejects modification', async () => {
    const row = await createSubmission({
      siteCode: 'HA02',
      source: 'excel',
      fields: { ...baseFields, sku: '110079623003' },
      ip: '203.0.113.3',
      changeSource: 'excel_import',
    });
    await db.query(
      'UPDATE submissions SET exported_at = now(), locked_at = now(), export_batch_id = gen_random_uuid() WHERE application_no = $1',
      [row.application_no],
    );

    await expect(
      modifySubmission({
        applicationNo: row.application_no,
        siteCode: 'HA02',
        fields: baseFields,
        ip: '203.0.113.4',
        actorRole: 'applicant',
        changeSource: 'web_modify',
      }),
    ).rejects.toThrowError(LockedError);
  });

  it('admin can update all business fields and record admin version', async () => {
    const row = await createSubmission({
      siteCode: 'HA02',
      source: 'web',
      fields: { ...baseFields, sku: '110079623004' },
      ip: '203.0.113.5',
      changeSource: 'web_submit',
    });
    const updated = await adminUpdateSubmission(row.id, { ...baseFields, sku: '110079623004', brand: 'NEG - NEW' }, '203.0.113.6', 'admin');
    expect(updated.brand).toBe('NEG - NEW');
  });

  it('writes audit events', async () => {
    await writeAuditEvent({
      eventType: 'submission_created',
      actorRole: 'applicant',
      ip: '203.0.113.7',
      metadata: { source: 'web' },
    });
    const result = await db.query('SELECT count(*)::int AS cnt FROM audit_events WHERE event_type = $1', ['submission_created']);
    expect(result.rows[0]?.cnt).toBeGreaterThanOrEqual(1);
  });

  it('creates an urgent submission with URGENT prefix, qty and reason', async () => {
    const row = await createSubmission({
      siteCode: 'HA02',
      source: 'web',
      submissionType: 'urgent',
      fields: { brand: '', sku: '1006013', rp_type: '', safety_stock: '', nd_code: '', remark: '' },
      qty: 42,
      urgentReason: '9',
      urgentReasonOther: '臨時原因',
      ip: '203.0.113.8',
      changeSource: 'web_submit',
    });
    expect(row.application_no).toMatch(/^URGENT-/);
    expect(row.submission_type).toBe('urgent');
    expect(row.qty).toBe(42);
    expect(row.urgent_reason).toBe('9');
    expect(row.urgent_reason_other).toBe('臨時原因');

    const version = await db.query('SELECT data_after FROM submission_versions WHERE submission_id = $1', [row.id]);
    const snapshot = version.rows[0]?.data_after as {
      site_code: string;
      sku: string;
      qty: number;
      urgent_reason: string | null;
      urgent_reason_other: string | null;
    };
    expect(snapshot.site_code).toBe('HA02');
    expect(snapshot.sku).toBe('1006013');
    expect(snapshot.qty).toBe(42);
    expect(snapshot.urgent_reason).toBe('9');
    expect(snapshot.urgent_reason_other).toBe('臨時原因');
  });

  it('rejects an urgent submission without a reason', async () => {
    await expect(
      createSubmission({
        siteCode: 'HA02',
        source: 'web',
        submissionType: 'urgent',
        fields: { brand: '', sku: '1006014', rp_type: '', safety_stock: '', nd_code: '', remark: '' },
        qty: 42,
        ip: '203.0.113.9',
        changeSource: 'web_submit',
      }),
    ).rejects.toThrowError('Urgent Reason 為必填');
  });

  it('creates a sales submission with SALES prefix and sku-only snapshot', async () => {
    const row = await createSubmission({
      siteCode: 'HA02',
      source: 'web',
      submissionType: 'sales',
      fields: { brand: '', sku: '1005014', rp_type: '', safety_stock: '', nd_code: '', remark: '' },
      ip: '203.0.113.10',
      changeSource: 'web_submit',
    });
    expect(row.application_no).toMatch(/^SALES-/);
    expect(row.submission_type).toBe('sales');
    expect(row.qty).toBeNull();
    expect(row.urgent_reason).toBeNull();

    const version = await db.query('SELECT data_after FROM submission_versions WHERE submission_id = $1', [row.id]);
    const snapshot = version.rows[0]?.data_after as { site_code: string; sku: string };
    expect(snapshot.site_code).toBe('HA02');
    expect(snapshot.sku).toBe('1005014');
  });
});
