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
  createUrgentBatch,
  deriveUrgentBatchIdempotencyKeys,
  UrgentBatchDuplicateError,
  getSubmissionByApplicationNo,
  modifySubmission,
  adminUpdateSubmission,
  LockedError,
} from '../src/services/submissions.js';
import { writeAuditEvent } from '../src/lib/audit.js';
import { PostgresRateLimitStore } from '../src/middleware/postgresRateLimitStore.js';

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
  const migrationFiles = ['001_init.sql', '002_drop_rp_type_completed_at.sql', '003_add_submission_type_qty.sql', '004_add_urgent_reason.sql', '005_add_sales_submission_type.sql', '006_add_return_submission_type.sql', '007_add_idempotency_and_import_recovery.sql', '008_add_export_file_archive.sql', '009_architecture_hardening.sql'];
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

describe('shared rate-limit store (integration)', () => {
  it('increments the same counter across store instances', async () => {
    const first = new PostgresRateLimitStore(60_000);
    const second = new PostgresRateLimitStore(60_000);
    expect((await first.increment('integration-key')).totalHits).toBe(1);
    expect((await second.increment('integration-key')).totalHits).toBe(2);
    await first.resetKey('integration-key');
    expect(await second.get('integration-key')).toBeUndefined();
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

  it('resolves a full Urgent Reason label to its DB code on create', async () => {
    const row = await createSubmission({
      siteCode: 'HA02',
      source: 'web',
      submissionType: 'urgent',
      fields: { brand: '', sku: '1009116', rp_type: '', safety_stock: '', nd_code: '', remark: '' },
      qty: 8,
      urgentReason: '2. ROADSHOW',
      urgentReasonOther: null,
      ip: '203.0.113.11',
      changeSource: 'web_submit',
    });
    expect(row.urgent_reason).toBe('2');
    const stored = await db.query<{ urgent_reason: string }>('SELECT urgent_reason FROM submissions WHERE id = $1', [row.id]);
    expect(stored.rows[0]!.urgent_reason).toBe('2');
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

describe('urgent web batch (integration)', () => {
  const batch = (skus: string[], ip = '203.0.113.20', key?: string, fingerprint?: string) =>
    createUrgentBatch({
      siteCode: 'HA02',
      items: skus.map((sku, i) => ({
        sku,
        qty: i + 1,
        urgentReason: '1',
        urgentReasonOther: '',
      })),
      ip,
      changeSource: 'web_submit',
      idempotencyKey: key,
      idempotencyFingerprint: fingerprint,
    });

  it('creates independent submissions with version snapshots in input order', async () => {
    const result = await batch(['1006301', '1006302', '1006303']);
    expect(result.replayed).toBe(false);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.item).toBe(1);
    expect(result.rows[2]!.item).toBe(3);
    const nos = result.rows.map((r) => r.row.application_no);
    expect(new Set(nos).size).toBe(3);
    expect(nos.every((no) => no.startsWith('URGENT-'))).toBe(true);
    expect(result.rows[0]!.row.sku).toBe('1006301');
    expect(result.rows[1]!.row.qty).toBe(2);

    const versions = await db.query(
      'SELECT count(*)::int AS cnt FROM submission_versions WHERE submission_id = ANY($1::uuid[])',
      [result.rows.map((r) => r.row.id)],
    );
    expect(versions.rows[0]?.cnt).toBe(3);
    const snapshot = await db.query<{ data_after: { sku: string; qty: number } }>(
      'SELECT data_after FROM submission_versions WHERE submission_id = $1',
      [result.rows[0]!.row.id],
    );
    expect(snapshot.rows[0]!.data_after.sku).toBe('1006301');
    expect(snapshot.rows[0]!.data_after.qty).toBe(1);
  });

  it('rejects a batch with a duplicate SKU inside it and writes nothing', async () => {
    const before = await db.query('SELECT count(*)::int AS cnt FROM submissions');
    await expect(batch(['1006304', '1006304'])).rejects.toBeInstanceOf(UrgentBatchDuplicateError);
    const after = await db.query('SELECT count(*)::int AS cnt FROM submissions');
    expect(after.rows[0]?.cnt).toBe(before.rows[0]?.cnt);
  });

  it('rejects a batch when an SKU already exists for the same day and writes nothing', async () => {
    await batch(['1006305']);
    const before = await db.query('SELECT count(*)::int AS cnt FROM submissions');
    await expect(batch(['1006306', '1006305'])).rejects.toBeInstanceOf(UrgentBatchDuplicateError);
    const after = await db.query('SELECT count(*)::int AS cnt FROM submissions');
    expect(after.rows[0]?.cnt).toBe(before.rows[0]?.cnt);
  });

  it('replays an idempotent batch with the same key and fingerprint', async () => {
    const key = 'batch-ip-key';
    const fingerprint = 'fp-batch-a';
    const first = await batch(['1006307', '1006308', '1006309'], '203.0.113.21', key, fingerprint);
    expect(first.replayed).toBe(false);
    const firstNos = first.rows.map((r) => r.row.application_no);

    const replay = await batch(['1006307', '1006308', '1006309'], '203.0.113.21', key, fingerprint);
    expect(replay.replayed).toBe(true);
    expect(replay.rows.map((r) => r.row.application_no)).toEqual(firstNos);

    const stored = await db.query(
      'SELECT count(*)::int AS cnt FROM submissions WHERE idempotency_key = ANY($1::text[])',
      [deriveUrgentBatchIdempotencyKeys(key, 3)],
    );
    expect(stored.rows[0]?.cnt).toBe(3);
    const versions = await db.query(
      'SELECT count(*)::int AS cnt FROM submission_versions WHERE submission_id = ANY($1::uuid[])',
      [first.rows.map((r) => r.row.id)],
    );
    expect(versions.rows[0]?.cnt).toBe(3);
  });

  it('conflicts when the same batch key is used with a different fingerprint', async () => {
    const key = 'batch-ip-conflict';
    await batch(['1006311'], '203.0.113.22', key, 'fp-a');
    await expect(batch(['1006311'], '203.0.113.22', key, 'fp-b')).rejects.toThrowError('重試鍵');
  });
});
