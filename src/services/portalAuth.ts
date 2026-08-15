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

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Generates a one-time password, stores its hash and returns the plaintext once. */
export async function setUserPassword(
  userId: string,
  password: string,
  mustChange: boolean,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  await query(
    `UPDATE portal_users
        SET password_hash = $1, must_change_password = $2, updated_at = now()
      WHERE id = $3`,
    [passwordHash, mustChange, userId],
  );
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
        SET last_seen_at = now()
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

export async function portalLogin(
  username: string,
  password: string,
  ip: string,
): Promise<{ ok: boolean; reason?: string; user?: PortalUserRow; token?: string }> {
  const normalized = normalizePortalUsername(username);
  if (!normalized) return { ok: false, reason: '請輸入使用者名稱' };

  const recent = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM portal_login_attempts
      WHERE ip = $1 AND success = false
        AND attempted_at > now() - (interval '1 minute' * $2::int)`,
    [ip, config.loginLockMinutes],
  );
  if (Number(recent.rows[0]?.cnt ?? 0) >= config.loginLockThreshold) {
    return { ok: false, reason: '登入失敗次數過多，帳號已暫時鎖定' };
  }

  const result = await query<PortalUserRow>(
    'SELECT * FROM portal_users WHERE username = $1',
    [normalized],
  );
  const user = result.rows[0];
  const valid = Boolean(user) && (await verifyPassword(password, user!.password_hash));

  if (!user || !valid) {
    await query(
      'INSERT INTO portal_login_attempts (ip, username, attempted_at, success) VALUES ($1, $2, now(), false)',
      [ip, normalized],
    );
    return { ok: false, reason: '使用者名稱或密碼不正確' };
  }
  if (!user.active) {
    await query(
      'INSERT INTO portal_login_attempts (ip, username, attempted_at, success) VALUES ($1, $2, now(), false)',
      [ip, normalized],
    );
    return { ok: false, reason: '帳號已停用，請聯絡管理員' };
  }

  await query(
    'INSERT INTO portal_login_attempts (ip, username, attempted_at, success) VALUES ($1, $2, now(), true)',
    [ip, normalized],
  );
  const session = await createPortalSession(user.id);
  return { ok: true, user, token: session.token };
}

/** Changes the current user's password; requires the current password to match. */
export async function changePortalPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  _ip: string,
): Promise<{ ok: boolean; reason?: string }> {
  const result = await query<PortalUserRow>('SELECT * FROM portal_users WHERE id = $1', [userId]);
  const user = result.rows[0];
  if (!user) return { ok: false, reason: '找不到帳號' };
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    return { ok: false, reason: '現有密碼不正確' };
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return { ok: false, reason: '新密碼必須為 8 至 128 個字符' };
  }
  await setUserPassword(userId, newPassword, false);
  return { ok: true };
}
