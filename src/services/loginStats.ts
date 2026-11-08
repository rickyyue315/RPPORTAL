import { config } from '../config.js';
import { query } from '../db/pool.js';
import { hkTodayForDateColumn, shiftDateOnly } from '../lib/time.js';

export type PortalLoginStatsRole = 'store' | 'om' | 'all';

export interface PortalLoginStatsInput {
  /** Inclusive start date in the configured timezone (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date in the configured timezone (YYYY-MM-DD). */
  to: string;
  role: PortalLoginStatsRole;
}

export interface PortalLoginStatsDailyPoint {
  date: string;
  logins: number;
  accounts: number;
}

export interface PortalLoginStatsAccount {
  username: string;
  site_code: string | null;
  display_name: string;
  shop: string | null;
  role: 'store' | 'om';
  active: boolean;
  logins: number;
  last_login_at: string | null;
  failed_attempts: number;
  /** Active account with no successful login in the selected range. */
  never_logged_in: boolean;
}

export interface PortalLoginStats {
  range: { from: string; to: string };
  role: PortalLoginStatsRole;
  /** Failed attempts are only retained for LOGIN_ATTEMPT_RETENTION_DAYS. */
  failed_from: string;
  failed_retention_days: number;
  audit_retention_days: number;
  summary: {
    logins: number;
    active_accounts: number;
    logged_in_accounts: number;
    never_logged_in_accounts: number;
    failed_attempts: number;
  };
  daily: PortalLoginStatsDailyPoint[];
  accounts: PortalLoginStatsAccount[];
}

interface SuccessRow {
  account_key: string | null;
  username: string;
  role: 'store' | 'om';
  shop: string | null;
  logins: number;
  last_login_at: string | null;
}

interface DailyRow {
  date: string;
  logins: number;
  accounts: number;
}

interface ActiveAccountRow {
  username: string;
  display_name: string;
  role: 'store' | 'om';
  site_code: string | null;
  shop: string | null;
}

interface FailedRow {
  role: 'store' | 'om' | null;
  account_key: string | null;
  failed_attempts: number;
}

function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = from;
  // The route caps the range at 730 days; the guard only protects against a
  // malformed helper result turning into an infinite loop.
  for (let guard = 0; guard < 800 && cursor && cursor <= to; guard += 1) {
    dates.push(cursor);
    cursor = shiftDateOnly(cursor, 1);
  }
  return dates;
}

function accountKey(role: 'store' | 'om', username: string, siteCode: string | null): string {
  return role === 'store' ? siteCode || username : username;
}

/**
 * Aggregates Portal login activity for the admin backend.
 *
 * Successful logins come from `audit_events` (`portal_login`), which is kept
 * for AUDIT_RETENTION_DAYS (default 730). Failed attempts come from
 * `portal_login_attempts`, which is only kept for
 * LOGIN_ATTEMPT_RETENTION_DAYS (default 90); `failed_from` tells the UI the
 * earliest date that can still be reported.
 */
export async function getPortalLoginStats(input: PortalLoginStatsInput): Promise<PortalLoginStats> {
  const { from, to, role } = input;
  const tz = config.timezone;

  const retentionDays = Math.max(1, config.loginAttemptRetentionDays);
  const retentionStart = shiftDateOnly(hkTodayForDateColumn(), -(retentionDays - 1));
  const failedFrom = retentionStart && retentionStart > from ? retentionStart : from;

  const successResult = await query<SuccessRow>(
    `SELECT
       COALESCE(e.metadata->>'site_code', e.actor) AS account_key,
       e.actor AS username,
       e.actor_role AS role,
       st.shop AS shop,
       count(*)::int AS logins,
       to_char(max(e.created_at) AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS last_login_at
      FROM audit_events e
      LEFT JOIN stores st
        ON e.actor_role = 'store'
       AND st.site_code = COALESCE(e.metadata->>'site_code', e.actor)
     WHERE e.event_type = 'portal_login'
       AND e.actor_role IN ('store', 'om')
       AND ($1::text = 'all' OR e.actor_role = $1::text)
       AND e.created_at >= ($2::date::timestamp AT TIME ZONE $4)
       AND e.created_at <  (($3::date + 1)::timestamp AT TIME ZONE $4)
     GROUP BY 1, 2, 3, 4`,
    [role, from, to, tz],
  );

  const dailyResult = await query<DailyRow>(
    `SELECT
       to_char(e.created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
       count(*)::int AS logins,
       count(DISTINCT COALESCE(e.metadata->>'site_code', e.actor))::int AS accounts
      FROM audit_events e
     WHERE e.event_type = 'portal_login'
       AND e.actor_role IN ('store', 'om')
       AND ($1::text = 'all' OR e.actor_role = $1::text)
       AND e.created_at >= ($2::date::timestamp AT TIME ZONE $4)
       AND e.created_at <  (($3::date + 1)::timestamp AT TIME ZONE $4)
     GROUP BY 1
     ORDER BY 1`,
    [role, from, to, tz],
  );

  const activeResult = await query<ActiveAccountRow>(
    `SELECT u.username, u.display_name, u.role, u.site_code,
            COALESCE(st.shop, u.display_name, u.username) AS shop
       FROM portal_users u
       LEFT JOIN stores st ON st.site_code = u.site_code
      WHERE u.active = true
        AND u.role IN ('store', 'om')
        AND ($1::text = 'all' OR u.role = $1::text)
      ORDER BY u.role, u.site_code NULLS LAST, u.username`,
    [role],
  );

  const failedResult = await query<FailedRow>(
    `SELECT
       COALESCE(u.role, CASE WHEN s.site_code IS NOT NULL THEN 'store' END) AS role,
       COALESCE(u.site_code, s.site_code, a.username) AS account_key,
       count(*)::int AS failed_attempts
      FROM portal_login_attempts a
      LEFT JOIN portal_users u ON u.username = a.username
      LEFT JOIN stores s ON s.site_code = a.username
     WHERE a.success = false
       AND a.attempted_at >= ($1::date::timestamp AT TIME ZONE $4)
       AND a.attempted_at <  (($2::date + 1)::timestamp AT TIME ZONE $4)
       AND COALESCE(u.role, CASE WHEN s.site_code IS NOT NULL THEN 'store' END) IN ('store', 'om')
       AND ($3::text = 'all' OR COALESCE(u.role, CASE WHEN s.site_code IS NOT NULL THEN 'store' END) = $3::text)
     GROUP BY 1, 2`,
    [failedFrom, to, role, tz],
  );

  // Keys are prefixed with the role so a deleted Store account and a later OM
  // account that happens to reuse the same username can never be merged.
  const activeByKey = new Map<string, ActiveAccountRow>();
  for (const row of activeResult.rows) {
    activeByKey.set(`${row.role}:${accountKey(row.role, row.username, row.site_code)}`, row);
  }

  const failedByKey = new Map<string, number>();
  let failedAttempts = 0;
  for (const row of failedResult.rows) {
    if (!row.role || !row.account_key) continue;
    const key = `${row.role}:${row.account_key}`;
    const count = Number(row.failed_attempts) || 0;
    failedByKey.set(key, (failedByKey.get(key) ?? 0) + count);
    failedAttempts += count;
  }

  const accounts = new Map<string, PortalLoginStatsAccount>();
  const loggedInKeys = new Set<string>();
  let logins = 0;
  for (const row of successResult.rows) {
    const rawKey = row.account_key || accountKey(row.role, row.username, null);
    const key = `${row.role}:${rawKey}`;
    const active = activeByKey.get(key);
    logins += Number(row.logins) || 0;
    loggedInKeys.add(key);
    accounts.set(key, {
      username: row.username,
      site_code: row.role === 'store' ? rawKey : null,
      display_name: active?.display_name || row.username,
      shop: active?.shop ?? row.shop ?? null,
      role: row.role,
      active: Boolean(active),
      logins: Number(row.logins) || 0,
      last_login_at: row.last_login_at ?? null,
      failed_attempts: failedByKey.get(key) ?? 0,
      never_logged_in: false,
    });
  }

  for (const [key, active] of activeByKey) {
    if (accounts.has(key)) continue;
    const rawKey = accountKey(active.role, active.username, active.site_code);
    accounts.set(key, {
      username: active.username,
      site_code: active.role === 'store' ? active.site_code || rawKey : null,
      display_name: active.display_name || active.username,
      shop: active.shop ?? null,
      role: active.role,
      active: true,
      logins: 0,
      last_login_at: null,
      failed_attempts: failedByKey.get(key) ?? 0,
      never_logged_in: true,
    });
  }

  const roleOrder: Record<'store' | 'om', number> = { store: 0, om: 1 };
  const sortedAccounts = [...accounts.values()].sort((a, b) => {
    if (a.never_logged_in !== b.never_logged_in) return a.never_logged_in ? 1 : -1;
    if (b.logins !== a.logins) return b.logins - a.logins;
    if (roleOrder[a.role] !== roleOrder[b.role]) return roleOrder[a.role] - roleOrder[b.role];
    return (a.site_code || a.username).localeCompare(b.site_code || b.username);
  });

  const dailyByDate = new Map(dailyResult.rows.map((row) => [row.date, row]));
  const daily = eachDate(from, to).map((date) => {
    const row = dailyByDate.get(date);
    return {
      date,
      logins: row ? Number(row.logins) || 0 : 0,
      accounts: row ? Number(row.accounts) || 0 : 0,
    };
  });

  return {
    range: { from, to },
    role,
    failed_from: failedFrom,
    failed_retention_days: retentionDays,
    audit_retention_days: Math.max(1, config.auditRetentionDays),
    summary: {
      logins,
      active_accounts: activeResult.rows.length,
      logged_in_accounts: loggedInKeys.size,
      never_logged_in_accounts: sortedAccounts.filter((account) => account.never_logged_in).length,
      failed_attempts: failedAttempts,
    },
    daily,
    accounts: sortedAccounts,
  };
}
