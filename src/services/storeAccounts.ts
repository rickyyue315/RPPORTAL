import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { normalizePortalUsername } from './portalAuth.js';
import { getEffectiveOmBySite } from './effectiveOm.js';

export interface StoreAccountSyncResult {
  created: Array<{ site_code: string; username: string }>;
  reactivated: string[];
  deactivated: string[];
  unchanged: number;
}

/**
 * Synchronises Store portal accounts with the store master:
 *   - creates accounts for Site Codes that do not exist yet (login is the
 *     Site Code plus the shared portal password, so no per-account password
 *     is stored),
 *   - re-activates accounts that were previously deactivated,
 *   - deactivates accounts whose Site Code is no longer in the master.
 * Store logins only check the shared portal password; existing sessions are
 * never reset.
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
        // Store a deliberately unusable hash (verifyPassword only accepts
        // `scrypt$...` format) so no per-account password can ever match;
        // login checks the shared portal password instead.
        const unusableHash = `unusable$${randomBytes(16).toString('hex')}`;
        await client.query(
          `INSERT INTO portal_users
             (username, display_name, role, site_code, password_hash, initial_password, must_change_password, active, created_by)
           VALUES ($1, $2, 'store', $3, $4, NULL, false, true, $5)`,
          [username, site.shop || site.site_code, site.site_code, unusableHash, adminUsername],
        );
        result.created.push({ site_code: site.site_code, username });
      } else if (!existing.active) {
        // 只重新啟用，不動密碼：已發放的帳戶若被清空 initial_password 就會
        // 退回共用密碼；一旦共用密碼已關閉，該店即刻鎖死。
        await client.query(
          'UPDATE portal_users SET active = true, updated_at = now() WHERE id = $1',
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

export interface OmAccountSyncResult {
  created: string[];
  reactivated: string[];
  unchanged: number;
  skipped: string[];
}

/**
 * Creates one OM account per distinct OM value from the store master and the
 * latest uploaded stock report (the report is the authority after a transfer).
 * Login password is PORTAL_OM_PASSWORD (default SASAOM178); the account hash
 * is deliberately unusable. Existing OM accounts are left untouched (including
 * deactivated ones, so an admin's revocation is respected). Removed OMs are
 * NOT auto-deactivated so an admin can decide whether to revoke access; their
 * account simply manages no stores.
 */
export async function syncOmPortalAccounts(createdBy: string): Promise<OmAccountSyncResult> {
  return withTransaction(async (client) => {
    const omRows = await client.query<{ om: string }>(
      `SELECT DISTINCT BTRIM(om) AS om
         FROM stores
        WHERE BTRIM(COALESCE(om, '')) <> ''
        ORDER BY 1`,
    );
    // 最新上載的存貨報表可能已把店舖轉給新 OM；一併建立這些 OM 帳戶。
    const effectiveOm = await getEffectiveOmBySite();
    const omNames = new Set(omRows.rows.map((row) => row.om).filter(Boolean));
    for (const info of effectiveOm.values()) {
      if (info.om) omNames.add(info.om);
    }
    const allOmNames = [...omNames].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const existing = await client.query<{ id: string; username: string; role: string; active: boolean }>(
      "SELECT id, username, role, active FROM portal_users WHERE username = ANY($1::text[])",
      [allOmNames.map((om) => normalizePortalUsername(om))],
    );
    const byUsername = new Map(existing.rows.map((row) => [row.username, row]));
    const result: OmAccountSyncResult = { created: [], reactivated: [], unchanged: 0, skipped: [] };

    for (const om of allOmNames) {
      const username = normalizePortalUsername(om);
      if (!username) continue;
      const found = byUsername.get(username);
      if (found) {
        if (found.role !== 'om') {
          result.skipped.push(username);
          continue;
        }
        // 不自動重新啟用：管理員刻意停用的 OM 帳戶應保持停用，
        // 要恢復請由管理員在帳戶管理頁手動啟用。
        result.unchanged++;
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO portal_users
           (username, display_name, role, site_code, password_hash, initial_password,
            must_change_password, active, created_by)
         VALUES ($1, $2, 'om', NULL, 'unusable$om-portal', NULL, false, true, $3)
         ON CONFLICT (username) DO NOTHING
         RETURNING username`,
        [username, om, createdBy],
      );
      if (inserted.rows[0]) result.created.push(username);
      else result.skipped.push(username);
    }
    return result;
  });
}

/** Creates a Buyer or SCT account; login is the username plus the shared portal password. */export async function createBuyerOrSctAccount(input: {
  username: string;
  displayName: string;
  role: 'buyer' | 'sct';
  adminUsername: string;
}): Promise<{ username: string }> {
  const username = normalizePortalUsername(input.username);
  // Deliberately unusable hash (verifyPassword only accepts `scrypt$...`
  // format) so no per-account password can ever match; login checks the
  // shared portal password instead.
  const unusableHash = `unusable$${randomBytes(16).toString('hex')}`;
  await query(
    `INSERT INTO portal_users (username, display_name, role, password_hash, initial_password, must_change_password, active, created_by)
     VALUES ($1, $2, $3, $4, NULL, false, true, $5)`,
    [username, input.displayName || username, input.role, unusableHash, input.adminUsername],
  );
  return { username };
}

export class StoreAccountError extends Error {}

/** Site Code 只由英文字母、數字及連字號組成（現有店舖全部為 4 位，例如 HA02）。 */
const SITE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

/** 門店主檔 CSV 除 Site／Shop 以外的欄位（Regional、Class 1、Class 2、Size、OM、Type、需特別關注）。 */
export interface StoreMasterFields {
  regional?: string;
  class1?: string;
  class2?: string;
  size?: string;
  om?: string;
  type?: string;
  attention?: string;
}

/** Creates (or re-activates) a single Store account from the store master.
 *  Login is Site Code + shared portal password; no password is stored or returned.
 *  A Site Code that is not in the master is added to it first (with the given
 *  shop name and master columns), otherwise the next 「按門店主檔同步」 would
 *  silently deactivate the brand-new account. Blank columns are written as ''
 *  so a hand-made row is indistinguishable from a CSV row with empty cells. */
export async function createSingleStoreAccount(input: {
  siteCode: string;
  shopName?: string;
  fields?: StoreMasterFields;
  adminUsername: string;
}): Promise<{ username: string; site_code: string; shop: string; reactivated: boolean; added_to_master: boolean }> {
  const siteCode = (input.siteCode ?? '').trim().toUpperCase();
  if (!siteCode) throw new StoreAccountError('請選擇店舖');
  if (!SITE_CODE_PATTERN.test(siteCode)) {
    throw new StoreAccountError('Site Code 只可包含英文字母、數字或連字號（2–20 個字元）');
  }
  return withTransaction(async (client) => {
    const store = await client.query<{ site_code: string; shop: string }>(
      'SELECT site_code, shop FROM stores WHERE site_code = $1',
      [siteCode],
    );
    let row = store.rows[0];
    let addedToMaster = false;
    if (!row) {
      const shopName = (input.shopName ?? '').trim().slice(0, 200);
      const text = (value?: string) => (value ?? '').trim();
      const fields = input.fields ?? {};
      const inserted = await client.query<{ site_code: string; shop: string }>(
        `INSERT INTO stores (site_code, shop, regional, class1, class2, size, om, type, attention)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (site_code) DO NOTHING
         RETURNING site_code, shop`,
        [
          siteCode,
          shopName || siteCode,
          text(fields.regional),
          text(fields.class1),
          text(fields.class2),
          text(fields.size),
          text(fields.om),
          text(fields.type),
          text(fields.attention),
        ],
      );
      row = inserted.rows[0];
      addedToMaster = Boolean(row);
      if (!row) {
        // 同一時間有另一個請求建立了此店舖，改用該筆資料。
        const again = await client.query<{ site_code: string; shop: string }>(
          'SELECT site_code, shop FROM stores WHERE site_code = $1',
          [siteCode],
        );
        row = again.rows[0];
      }
      if (!row) throw new StoreAccountError('門店主檔沒有此 Site Code');
    }
    const existing = await client.query<{ id: string; active: boolean }>(
      `SELECT id, active FROM portal_users WHERE role = 'store' AND site_code = $1`,
      [siteCode],
    );
    const found = existing.rows[0];
    const username = normalizePortalUsername(siteCode);
    if (found) {
      if (found.active) throw new StoreAccountError('此店舖帳戶已存在');
      // 同樣只重新啟用，不清除已發放的密碼。
      await client.query(
        'UPDATE portal_users SET active = true, updated_at = now() WHERE id = $1',
        [found.id],
      );
      return { username, site_code: siteCode, shop: row.shop || siteCode, reactivated: true, added_to_master: addedToMaster };
    }
    const unusableHash = `unusable$${randomBytes(16).toString('hex')}`;
    await client.query(
      `INSERT INTO portal_users
         (username, display_name, role, site_code, password_hash, initial_password, must_change_password, active, created_by)
       VALUES ($1, $2, 'store', $3, $4, NULL, false, true, $5)`,
      [username, row.shop || siteCode, siteCode, unusableHash, input.adminUsername],
    );
    return { username, site_code: siteCode, shop: row.shop || siteCode, reactivated: false, added_to_master: addedToMaster };
  });
}
