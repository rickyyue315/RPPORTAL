import { createApp } from './app.js';
import { existsSync } from 'node:fs';
import { config, isWeakPortalSecret } from './config.js';
import { migrate } from './db/migrate.js';
import { pool, query, waitForDatabase, withAdvisoryLock } from './db/pool.js';
import { writeAuditEvent } from './lib/audit.js';
import { syncStoresFromFile } from './services/stores.js';
import { syncOmPortalAccounts } from './services/storeAccounts.js';
import { cleanupExpiredExportFiles } from './services/exportFiles.js';
import { cleanupRetentionData } from './services/retention.js';
import { runBuyerAutoApproveJob } from './services/ndrfWorkflow.js';

async function runMaintenanceCleanup(): Promise<void> {
  try {
    const result = await withAdvisoryLock('ndrf:maintenance', async (client) => {
      const retention = await cleanupRetentionData(client);
      const exportFiles = await cleanupExpiredExportFiles(client);
      return { retention, exportFiles };
    });
    if (!result) {
      console.log('[cleanup] skipped because another instance owns the maintenance lock');
      return;
    }
    const ipTotal = result.retention.submissionIpsCleared
      + result.retention.versionIpsCleared
      + result.retention.auditIpsCleared;
    if (ipTotal > 0) {
      await writeAuditEvent({
        eventType: 'ip_cleanup',
        metadata: { cleared: ipTotal },
      });
      console.log(`[cleanup] cleared IPs for ${ipTotal} records`);
    }
    const deleted = result.retention.loginAttemptsDeleted
      + result.retention.auditEventsDeleted
      + result.retention.sessionsDeleted
      + result.retention.importBatchesDeleted
      + result.retention.exportBatchesDeleted
      + result.retention.rateLimitCountersDeleted;
    if (deleted > 0 || result.exportFiles > 0) {
      console.log(`[cleanup] deleted ${deleted} retained records and expired ${result.exportFiles} export files`);
    }
  } catch (err) {
    console.error('[cleanup] maintenance cleanup failed', err);
  }
}

/**
 * 內建的 stores-template.csv 就是門店主檔的真相來源。
 * 舊版只在「stores 表為空」時才 seed，所以主檔改動永遠到不了正式資料庫
 * （新店如 HBB2 一直唔出現，除非有人手動上載 CSV）。現在每次啟動都 upsert
 * 一次：只新增／更新，不會刪除任何店舖，部署就等於發佈主檔。
 */
async function syncStoreMasterOnBoot(): Promise<void> {
  if (!config.storesMasterSyncOnBoot) {
    console.log('[boot] store master sync disabled (STORES_MASTER_SYNC_ON_BOOT=false)');
    return;
  }
  const csvPath = config.storesCsvPath;
  if (!existsSync(csvPath)) {
    console.warn(`[boot] 找不到門店主檔 ${csvPath} — 沿用資料庫現有主檔`);
    return;
  }
  try {
    const result = await syncStoresFromFile(csvPath);
    let line = `[boot] store master synced: ${result.count} stores`;
    if (result.added.length) line += `, new ${result.added.length} (${result.added.join(', ')})`;
    if (result.removed.length) line += `, not in file ${result.removed.length} (${result.removed.join(', ')})`;
    console.log(line);
  } catch (err) {
    console.error('[boot] store master sync failed — 沿用資料庫現有主檔', err);
  }
}

/**
 * Fail-closed visibility check. The app intentionally does not fall back to a
 * shared password, so an active Store/OM account without an individual
 * password simply cannot log in. Surface that at boot instead of leaving the
 * shop locked out silently.
 */
async function warnAboutPortalCredentialReadiness(): Promise<void> {
  try {
    const { rows } = await query<{ role: string; count: string }>(
      `SELECT role, count(*)::text AS count
         FROM portal_users
        WHERE active = true
          AND (
            (role IN ('store', 'om')
              AND (initial_password IS NULL OR password_hash NOT LIKE 'scrypt$%'))
            OR role IN ('buyer', 'sct')
          )
        GROUP BY role`,
    );
    const counts = new Map(rows.map((row) => [row.role, Number(row.count)]));

    for (const role of ['store', 'om'] as const) {
      const missing = counts.get(role) ?? 0;
      const sharedEnabled = role === 'store'
        ? config.portalStoreSharedPasswordEnabled
        : config.portalOmSharedPasswordEnabled;
      if (missing > 0 && !sharedEnabled) {
        console.error(
          `[security] ${missing} active ${role} account(s) have no individual password and shared login is disabled; they cannot log in until an admin issues one.`,
        );
      }
    }

    const buyerSct = (counts.get('buyer') ?? 0) + (counts.get('sct') ?? 0);
    if (buyerSct > 0 && isWeakPortalSecret(config.portalSharedPassword)) {
      console.error(
        `[security] ${buyerSct} active Buyer/SCT account(s) exist but PORTAL_SHARED_PASSWORD is missing/weak; their login will be refused.`,
      );
    }
  } catch (err) {
    console.error('[security] portal credential readiness check failed', err);
  }
}

async function main(): Promise<void> {
  console.log(`[boot] NDRF Portal (${config.env})`);

  if (!config.adminPassword) {
    console.warn('[boot] ADMIN_PASSWORD 未設定 — 管理員登入已停用，後台將拒絕存取');
  }

  await waitForDatabase();
  await migrate();

  await syncStoreMasterOnBoot();

  // Ensure one OM account per stores.om value (migration seeds existing data;
  // this covers a fresh database and any OM added while the app was running).
  try {
    const omSync = await syncOmPortalAccounts('system');
    if (omSync.created.length || omSync.reactivated.length) {
      console.log(`[boot] OM accounts created ${omSync.created.length}, reactivated ${omSync.reactivated.length}`);
    }
  } catch (err) {
    console.error('[boot] OM account sync failed', err);
  }

  await warnAboutPortalCredentialReadiness();

/**
 * Company SLA: Buyer must review ND within the configured days; otherwise the
 * system auto-approves (default agreement) and flags the row for Admin.
 */
async function runBuyerAutoApproveScheduler(): Promise<void> {
  if (!config.ndrfAutoApproveEnabled) return;
  try {
    const result = await withAdvisoryLock('ndrf:buyer-auto-approve', async () => {
      return await runBuyerAutoApproveJob();
    });
    if (!result) {
      console.log('[auto-approve] skipped because another instance owns the lock');
      return;
    }
    if (result.approved > 0) {
      await writeAuditEvent({
        eventType: 'buyer_auto_approved',
        actor: 'auto-approve',
        metadata: { approved: result.approved, skipped: result.skipped },
      });
      console.log(`[auto-approve] auto-approved ${result.approved} submissions (${result.skipped} skipped)`);
    }
  } catch (err) {
    console.error('[auto-approve] failed', err);
  }
}
  // Scheduled maintenance: IP retention cleanup daily, Buyer SLA auto-approve
  // hourly. Auto-approve is idempotent per row (SKIP LOCKED + unique decision
  // index), so a short interval is safe and avoids a restart pushing the SLA
  // check out by up to 24 hours.
  setInterval(() => {
    void runMaintenanceCleanup();
  }, 24 * 3600 * 1000);
  setInterval(() => {
    void runBuyerAutoApproveScheduler();
  }, 3600 * 1000);
  void runMaintenanceCleanup();
  void runBuyerAutoApproveScheduler();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[boot] listening on port ${config.port}`);
  });

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[boot] received ${signal}, shutting down`);
      server.close(() => {
        pool
          .end()
          .catch((err) => console.error('[boot] error closing database pool', err))
          .finally(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), config.shutdownTimeoutMs).unref();
    });
  }
}

main().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
