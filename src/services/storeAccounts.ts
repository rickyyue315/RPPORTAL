import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { generateInitialPassword, hashPassword, normalizePortalUsername, setUserPassword } from './portalAuth.js';

export interface StoreAccountSyncResult {
  created: Array<{ site_code: string; username: string }>;
  reactivated: string[];
  deactivated: string[];
  unchanged: number;
}

/**
 * Synchronises Store portal accounts with the store master:
 *   - creates accounts for Site Codes that do not exist yet (passwordless:
 *     Site Code only, no usable password is stored),
 *   - re-activates accounts that were previously deactivated,
 *   - deactivates accounts whose Site Code is no longer in the master.
 * Store logins never check passwords; existing sessions are never reset.
 */
export async function syncStorePortalAccounts(adminUsername: string): Promise<StoreAccountSyncResult> {
  return withTransaction(async (client) => {
    const sitesResult = await client.query<{ site_code: string; shop: string }>(
      'SELECT site_code, shop FROM stores ORDER BY site_code',
    );
    const masterSites = sitesResult.rows;

    const accountsResult = await client.query<{
      id: string;
      username: string;
      site_code: string | null;
      active: boolean;
    }>(
      `SELECT id, username, site_code, active FROM portal_users
        WHERE role = 'store' ORDER BY site_code`,
    );
    const accountsBySite = new Map<string, { id: string; username: string; active: boolean }>();
    for (const account of accountsResult.rows) {
      if (account.site_code) accountsBySite.set(account.site_code, account);
    }

    const result: StoreAccountSyncResult = {
      created: [],
      reactivated: [],
      deactivated: [],
      unchanged: 0,
    };

    const inMaster = new Set<string>();
    for (const site of masterSites) {
      inMaster.add(site.site_code);
      const existing = accountsBySite.get(site.site_code);
      if (!existing) {
        const username = normalizePortalUsername(site.site_code);
        // Passwordless store account: store a deliberately unusable hash
        // (verifyPassword only accepts `scrypt$...` format) so no password
        // can ever match. Login uses the Site Code only.
        const unusableHash = `unusable$${randomBytes(16).toString('hex')}`;
        await client.query(
          `INSERT INTO portal_users
             (username, display_name, role, site_code, password_hash, initial_password, must_change_password, active, created_by)
           VALUES ($1, $2, 'store', $3, $4, NULL, false, true, $5)`,
          [username, site.shop || site.site_code, site.site_code, unusableHash, adminUsername],
        );
        result.created.push({ site_code: site.site_code, username });
      } else if (!existing.active) {
        await client.query(
          'UPDATE portal_users SET active = true, must_change_password = false, initial_password = NULL, updated_at = now() WHERE id = $1',
          [existing.id],
        );
        result.reactivated.push(site.site_code);
      } else {
        result.unchanged++;
      }
    }

    for (const [siteCode, account] of accountsBySite) {
      if (!inMaster.has(siteCode) && account.active) {
        await client.query('UPDATE portal_users SET active = false, updated_at = now() WHERE id = $1', [account.id]);
        await client.query('DELETE FROM portal_sessions WHERE user_id = $1', [account.id]);
        result.deactivated.push(siteCode);
      }
    }

    return result;
  });
}

export async function createBuyerOrSctAccount(input: {
  username: string;
  displayName: string;
  role: 'buyer' | 'sct';
  adminUsername: string;
}): Promise<{ username: string; initial_password: string }> {
  const username = normalizePortalUsername(input.username);
  const password = generateInitialPassword();
  const passwordHash = await hashPassword(password);
  await query(
    `INSERT INTO portal_users (username, display_name, role, password_hash, initial_password, must_change_password, active, created_by)
     VALUES ($1, $2, $3, $4, $5, true, true, $6)`,
    [username, input.displayName || username, input.role, passwordHash, password, input.adminUsername],
  );
  return { username, initial_password: password };
}

export async function resetPortalUserPassword(userId: string): Promise<string> {
  const password = generateInitialPassword();
  // Store the plaintext so admins can view it again later without resetting.
  await setUserPassword(userId, password, true, password);
  return password;
}
