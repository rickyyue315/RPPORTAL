import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';

export type PortalUserRole = 'store' | 'buyer' | 'sct';

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
