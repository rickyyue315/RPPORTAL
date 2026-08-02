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
  let sql = await readFile(path.join(__dirname, '..', 'src', 'db', 'migrations', '001_init.sql'), 'utf8');
  // PGlite bundles gen_random_uuid; the pgcrypto extension may not be available in WASM builds.
  sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
  await db.exec(sql);
});

const baseFields = {
  brand: 'NEG - NEOGENCE',
  sku: '110079623001',
  rp_type: 'ND',
  supply_source: '1 - Vendor (由供應商送貨到舖)',
  safety_stock: '5',
  nd_code: 'ND01-Under ND Classification',
  rp_parameters_change_request: '',
  rp_type_completed_at: '',
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
      fields: baseFields,
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
      fields: baseFields,
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
      fields: baseFields,
      ip: '203.0.113.5',
      changeSource: 'web_submit',
    });
    const updated = await adminUpdateSubmission(row.id, { ...baseFields, brand: 'NEG - NEW' }, '203.0.113.6', 'admin');
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
});
