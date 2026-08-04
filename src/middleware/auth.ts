import type { NextFunction, Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { writeAuditEvent } from '../lib/audit.js';

export const SESSION_COOKIE = 'admin_session';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison against the plain ADMIN_PASSWORD env value. */
function passwordMatches(given: string): boolean {
  const expected = Buffer.from(config.adminPassword, 'utf8');
  const actual = Buffer.from(given ?? '', 'utf8');
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function createSession(username: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  await query('DELETE FROM admin_sessions WHERE expires_at < now()');
  await query('INSERT INTO admin_sessions (token_hash, username, created_at, expires_at) VALUES ($1, $2, now(), $3)', [
    tokenHash,
    username,
    expiresAt.toISOString(),
  ]);
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function validateSession(token: string): Promise<string | null> {
  const result = await query<{ username: string }>(
    `UPDATE admin_sessions
     SET last_seen_at = now()
     WHERE token_hash = $1 AND expires_at > now()
     RETURNING username`,
    [hashToken(token)],
  );
  return result.rows[0]?.username ?? null;
}

export async function login(username: string, password: string, ip: string): Promise<{ ok: boolean; reason?: string; token?: string }> {
  if (!config.adminPassword) {
    await writeAuditEvent({ eventType: 'login_failure', actorRole: 'admin', actor: username, ip, metadata: { reason: 'not_configured' } });
    return { ok: false, reason: '系統未設定管理員密碼' };
  }

  // Lockout: if there were >= threshold recent failures from this IP, reject.
  const recent = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM admin_login_attempts
     WHERE ip = $1 AND success = false AND attempted_at > now() - (interval '1 minute' * $2::int)`,
    [ip, config.loginLockMinutes],
  );
  const recentFailures = Number(recent.rows[0]?.cnt ?? 0);
  if (recentFailures >= config.loginLockThreshold) {
    await writeAuditEvent({ eventType: 'login_locked', actorRole: 'admin', actor: username, ip });
    return { ok: false, reason: '登入失敗次數過多，帳號已暫時鎖定' };
  }

  const usernameMatches = username.trim() === config.adminUsername;
  const passwordMatchesOk = usernameMatches && passwordMatches(password);

  if (!passwordMatchesOk) {
    await query('INSERT INTO admin_login_attempts (ip, attempted_at, success) VALUES ($1, now(), false)', [ip]);
    await writeAuditEvent({ eventType: 'login_failure', actorRole: 'admin', actor: username, ip });
    return { ok: false, reason: '使用者名稱或密碼不正確' };
  }

  await query('INSERT INTO admin_login_attempts (ip, attempted_at, success) VALUES ($1, now(), true)', [ip]);
  const session = await createSession(config.adminUsername);
  await writeAuditEvent({ eventType: 'login_success', actorRole: 'admin', actor: config.adminUsername, ip });
  return { ok: true, token: session.token };
}

declare global {
  namespace Express {
    interface Request {
      adminUsername?: string;
      adminToken?: string;
    }
  }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) {
      res.status(401).json({ error: '未登入' });
      return;
    }
    const username = await validateSession(token);
    if (!username) {
      res.clearCookie(SESSION_COOKIE);
      res.status(401).json({ error: '登入已過期' });
      return;
    }
    req.adminUsername = username;
    req.adminToken = token;
    next();
  } catch (err) {
    next(err);
  }
}
