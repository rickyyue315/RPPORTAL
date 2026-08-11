import { createHash, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';

/**
 * Reserved scope that holds the platform-wide master recovery code. A master
 * code works for any store; per-OM codes only work for stores in that OM group.
 */
export const MASTER_RECOVERY_OM = '__MASTER__';

export type RecoveryCheckResult = 'disabled' | 'ok' | 'om-not-configured' | 'invalid';

export interface RecoveryCodeRow {
  om: string;
  code_hash: string;
  updated_by: string;
  updated_at: string;
}

/** Hashes a plaintext recovery code into the stored SHA-256 hex form. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Loads every configured recovery code (master + per-OM) from the database.
 * Returns a map of scope -> SHA-256 hex hash.
 */
export async function listRecoveryCodeHashes(): Promise<Map<string, string>> {
  const result = await query<RecoveryCodeRow>('SELECT om, code_hash FROM om_recovery_codes');
  return new Map(result.rows.map((row) => [row.om, row.code_hash]));
}

function hashMatches(storedHash: string | undefined, actual: Buffer): boolean {
  if (!storedHash) return false;
  const expected = Buffer.from(storedHash, 'utf8');
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Pure check of a provided recovery code against the configured hashes for a
 * store's OM group.
 * - 'disabled'          : no recovery codes configured at all (feature not set up)
 * - 'ok'                : matches the master code or the store's OM code
 * - 'om-not-configured' : neither a master code nor this OM's code is configured
 * - 'invalid'           : something is configured (master or this OM) but none match
 */
export function checkRecoveryCodeHashes(
  hashes: Map<string, string>,
  om: string,
  value: string | null | undefined,
): RecoveryCheckResult {
  return evaluateRecoveryCode(hashes, om, value).status;
}

/** Which configured scope matched ('master' | 'om'), or null when the code did not pass. */
export function recoveryCodeVia(
  hashes: Map<string, string>,
  om: string,
  value: string | null | undefined,
): 'master' | 'om' | null {
  return evaluateRecoveryCode(hashes, om, value).via;
}

function evaluateRecoveryCode(
  hashes: Map<string, string>,
  om: string,
  value: string | null | undefined,
): { status: RecoveryCheckResult; via: 'master' | 'om' | null } {
  if (hashes.size === 0) return { status: 'disabled', via: null };
  const actual = Buffer.from(hashRecoveryCode((value ?? '').trim()), 'utf8');

  const masterHash = hashes.get(MASTER_RECOVERY_OM);
  if (hashMatches(masterHash, actual)) return { status: 'ok', via: 'master' };

  const omHash = om ? hashes.get(om) : undefined;
  if (hashMatches(omHash, actual)) return { status: 'ok', via: 'om' };

  if (!masterHash && !omHash) return { status: 'om-not-configured', via: null };
  return { status: 'invalid', via: null };
}

export async function countRecoveryCodes(): Promise<number> {
  const result = await query<{ count: string }>('SELECT count(*)::text AS count FROM om_recovery_codes');
  return Number(result.rows[0]?.count ?? 0);
}

/** Upserts the hashed recovery code for a scope (an OM value or MASTER_RECOVERY_OM). */
export async function setRecoveryCode(scope: string, code: string, adminUsername: string): Promise<void> {
  const codeHash = hashRecoveryCode(code);
  await query(
    `INSERT INTO om_recovery_codes (om, code_hash, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (om) DO UPDATE SET code_hash = EXCLUDED.code_hash, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [scope, codeHash, adminUsername],
  );
}

export async function deleteRecoveryCode(scope: string): Promise<boolean> {
  const result = await query('DELETE FROM om_recovery_codes WHERE om = $1 RETURNING om', [scope]);
  return result.rows.length > 0;
}

/**
 * The browser encodes the recovery code before placing it in a header, so the
 * server must accept both raw and percent-encoded values.
 */
export function parseRecoveryCodeHeader(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
