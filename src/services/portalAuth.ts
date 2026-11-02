import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';

export type PortalUserRole = 'store' | 'buyer' | 'sct' | 'om';

export interface PortalUserRow {
  id: string;
  username: string;
  display_name: string;
  role: PortalUserRole;
  site_code: string | null;
  password_hash: string;
  must_change_password: boolean;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

function scryptHash(password: string, salt: Buffer, keylen: number, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, params as never, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

/** Hashes a plaintext password with scrypt and a per-user random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptHash(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const derived = await scryptHash(password, salt, 64, SCRYPT_PARAMS);
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

export function generateInitialPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `Sasa1!${out}`;
}

export function normalizePortalUsername(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Constant-time comparison against the shared portal password (default SASA1234). */
export function verifySharedPassword(given: string): boolean {
  const expected = Buffer.from(config.portalSharedPassword, 'utf8');
  const actual = Buffer.from(given ?? '', 'utf8');
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Constant-time comparison against the OM-only password (default SASAOM178). */
export function verifyOmPassword(given: string): boolean {
  const expected = Buffer.from(config.portalOmPassword, 'utf8');
  const actual = Buffer.from(given ?? '', 'utf8');
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Minimal account projection needed to authenticate a login. */
export interface PortalLoginUser {
  id: string;
  username: string;
  display_name: string;
  role: PortalUserRole;
  site_code: string | null;
  password_hash: string;
  initial_password: string | null;
  active: boolean;
}

export type PortalAuthMode = 'reject' | 'shared' | 'per_user';

/**
 * How this account must prove its identity.
 *
 * `per_user` requires BOTH an admin-viewable plaintext (`initial_password`) and
 * a real scrypt hash. If only one of the two is present the account is
 * half-migrated; falling back to the shared password keeps the store trading
 * instead of locking it out.
 *
 * Buyer / SCT never participate in per-account passwords.
 */
export function resolveAuthMode(user: PortalLoginUser | null | undefined): PortalAuthMode {
  if (!user || !user.active) return 'reject';
  if (user.role !== 'store' && user.role !== 'om') return 'shared';
  if (user.initial_password !== null && user.password_hash.startsWith('scrypt$')) return 'per_user';
  return 'shared';
}

/** Whether the shared password is still accepted for this role. */
export function sharedPasswordEnabledFor(role: PortalUserRole): boolean {
  if (role === 'om') return config.portalOmSharedPasswordEnabled;
  if (role === 'store') return config.portalStoreSharedPasswordEnabled;
  return true; // buyer / sct are out of scope and always keep the shared password
}

export async function findPortalUserForLogin(username: string): Promise<PortalLoginUser | null> {
  const result = await query<PortalLoginUser>(
    `SELECT id, username, display_name, role, site_code, password_hash, initial_password, active
       FROM portal_users
      WHERE username = $1`,
    [username],
  );
  return result.rows[0] ?? null;
}

export interface PortalLoginLock {
  locked: boolean;
  retryAfterMinutes: number;
}

/**
 * Two-layer brute-force gate, counted only AFTER the last successful login so a
 * legitimate user is never permanently locked out:
 *   L1  (username, ip)   — protects one office IP without touching other stores
 *   L2  (username)       — stops an attacker who keeps rotating IPs
 */
export async function getPortalLoginLock(username: string, ip: string): Promise<PortalLoginLock> {
  const windowMinutes = config.portalLoginFailWindowMinutes;
  const result = await query<{ total: string; same_ip: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE ip = $2)::text AS same_ip
       FROM portal_login_attempts
      WHERE username = $1
        AND success = false
        AND attempted_at > now() - make_interval(mins => $3::int)
        AND attempted_at > COALESCE(
              (SELECT max(attempted_at) FROM portal_login_attempts
                WHERE username = $1 AND success = true),
              '-infinity'::timestamptz)`,
    [username, ip, windowMinutes],
  );
  const total = Number(result.rows[0]?.total ?? 0);
  const sameIp = Number(result.rows[0]?.same_ip ?? 0);
  if (sameIp >= config.portalLoginFailPerUserIp) return { locked: true, retryAfterMinutes: windowMinutes };
  if (total >= config.loginUsernameLockThreshold) return { locked: true, retryAfterMinutes: windowMinutes };
  return { locked: false, retryAfterMinutes: 0 };
}

export async function recordLoginAttempt(username: string, ip: string, success: boolean): Promise<void> {
  await query('INSERT INTO portal_login_attempts (ip, username, success) VALUES ($1, $2, $3)', [
    ip,
    username,
    success,
  ]);
}

/**
 * Creates a session only if the hash that was just verified is still the
 * account's hash, and the account is still in the same auth mode.
 *
 * This closes the race where an admin resets a password between verification
 * and session creation: the INSERT ... SELECT matches zero rows and the caller
 * returns 409 instead of letting a revoked password sign in.
 */
export async function createPortalSessionGuarded(
  userId: string,
  expectedPasswordHash: string,
  mode: 'per_user' | 'shared',
): Promise<{ token: string; expiresAt: Date } | null> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  const inserted = await query(
    `INSERT INTO portal_sessions (token_hash, user_id, created_at, expires_at)
     SELECT $1, u.id, now(), $2
       FROM portal_users u
      WHERE u.id = $3
        AND u.active = true
        AND u.password_hash = $4
        AND (
             ($5::text = 'per_user' AND u.initial_password IS NOT NULL)
          OR ($5::text = 'shared'   AND u.initial_password IS NULL)
        )
     RETURNING user_id`,
    [tokenHash, expiresAt.toISOString(), userId, expectedPasswordHash, mode],
  );
  // Check rows rather than rowCount: the PGlite test adapter reports
  // affectedRows instead of the pg-standard rowCount.
  if (inserted.rows.length === 0) return null;
  await query('DELETE FROM portal_sessions WHERE expires_at < now()');
  return { token, expiresAt };
}

/**
 * Issues a fresh per-account password: stores its scrypt hash and the
 * admin-viewable plaintext, resets the "notified" marker, and revokes every
 * existing session so the old password stops working immediately.
 */
export async function issuePassword(userId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await query(
    `UPDATE portal_users
        SET password_hash = $1,
            initial_password = $2,
            must_change_password = false,
            password_issued_at = now(),
            password_notified_at = NULL,
            updated_at = now()
      WHERE id = $3`,
    [passwordHash, password, userId],
  );
  await query('DELETE FROM portal_sessions WHERE user_id = $1', [userId]);
}

/** Marks an issued password as delivered to its owner (WhatsApp / email / verbal). */
export async function markPasswordNotified(userId: string): Promise<void> {
  await query(
    'UPDATE portal_users SET password_notified_at = now(), updated_at = now() WHERE id = $1',
    [userId],
  );
}

export interface PasswordIssueEntry {
  userId: string;
  password: string;
  passwordHash: string;
}

/**
 * Writes pre-computed hashes in a single transaction.
 *
 * `onlyMissing` adds the `initial_password IS NULL` guard so a password issued
 * concurrently by another admin is never overwritten; that row is reported as
 * skipped instead. Hashing is deliberately kept outside this function: 97
 * sequential scrypt calls would blow the request timeout, so the caller
 * computes hashes with bounded concurrency first.
 */
export async function issuePasswordsBulk(
  entries: PasswordIssueEntry[],
  onlyMissing: boolean,
): Promise<{ issued: string[]; skipped: string[] }> {
  const issued: string[] = [];
  const skipped: string[] = [];
  if (entries.length === 0) return { issued, skipped };
  await withTransaction(async (client) => {
    for (const entry of entries) {
      const result = await client.query(
        `UPDATE portal_users
            SET password_hash = $1,
                initial_password = $2,
                must_change_password = false,
                password_issued_at = now(),
                password_notified_at = NULL,
                updated_at = now()
          WHERE id = $3
            ${onlyMissing ? 'AND initial_password IS NULL' : ''}
          RETURNING id`,
        [entry.passwordHash, entry.password, entry.userId],
      );
      if (result.rows.length > 0) issued.push(entry.userId);
      else skipped.push(entry.userId);
    }
    if (issued.length > 0) {
      await client.query('DELETE FROM portal_sessions WHERE user_id = ANY($1::uuid[])', [issued]);
    }
  });
  return { issued, skipped };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Sets a new password: stores its hash, optionally stores/clears the admin-viewable initial password, and revokes sessions. */
export async function setUserPassword(
  userId: string,
  password: string,
  mustChange: boolean,
  initialPassword: string | null | undefined = undefined,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  if (initialPassword === undefined) {
    await query(
      `UPDATE portal_users
          SET password_hash = $1, must_change_password = $2, updated_at = now()
        WHERE id = $3`,
      [passwordHash, mustChange, userId],
    );
  } else {
    await query(
      `UPDATE portal_users
          SET password_hash = $1, must_change_password = $2, initial_password = $3, updated_at = now()
        WHERE id = $4`,
      [passwordHash, mustChange, initialPassword, userId],
    );
  }
  await query('DELETE FROM portal_sessions WHERE user_id = $1', [userId]);
}

export async function createPortalSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  await query('DELETE FROM portal_sessions WHERE expires_at < now()');
  await query(
    'INSERT INTO portal_sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, now(), $3)',
    [tokenHash, userId, expiresAt.toISOString()],
  );
  return { token, expiresAt };
}

export async function destroyPortalSession(token: string): Promise<void> {
  if (!token) return;
  await query('DELETE FROM portal_sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await query('DELETE FROM portal_sessions WHERE user_id = $1', [userId]);
}

export async function validatePortalSession(token: string): Promise<PortalUserRow | null> {
  if (!token) return null;
  const result = await query<PortalUserRow>(
    `UPDATE portal_sessions ps
        SET last_seen_at = CASE
              WHEN ps.last_seen_at IS NULL OR ps.last_seen_at < now() - interval '5 minutes'
              THEN now() ELSE ps.last_seen_at END
       FROM portal_users u
      WHERE ps.token_hash = $1
        AND ps.expires_at > now()
        AND u.id = ps.user_id
        AND u.active = true
      RETURNING u.id, u.username, u.display_name, u.role, u.site_code,
                u.password_hash, u.must_change_password, u.active,
                u.created_by, u.created_at, u.updated_at`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}
