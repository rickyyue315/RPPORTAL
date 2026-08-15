import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool, withAdvisoryLock } from './db/pool.js';
import { writeAuditEvent } from './lib/audit.js';
import { countRecoveryCodes } from './lib/recovery.js';
import { seedStoresFromFile, countStores } from './services/stores.js';
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

async function main(): Promise<void> {
  console.log(`[boot] NDRF Portal (${config.env})`);

  if (!config.adminPassword) {
    console.warn('[boot] ADMIN_PASSWORD 未設定 — 管理員登入已停用，後台將拒絕存取');
  }

  await migrate();

  const recoveryCodeCount = await countRecoveryCodes();
  if (recoveryCodeCount === 0) {
    console.warn('[boot] 未設定任何 Recovery Code（om_recovery_codes 表為空）— 公開申請編號恢復功能將回 503');
  }

  const storeCount = await countStores();
  if (storeCount === 0) {
    const csvPath = config.storesCsvPath;
    console.log(`[boot] stores master empty, seeding from ${csvPath}`);
    const seeded = await seedStoresFromFile(csvPath);
    console.log(`[boot] seeded ${seeded} stores`);
  }


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
  // Scheduled maintenance (daily): IP retention cleanup + Buyer SLA auto-approve.
  setInterval(() => {
    void runMaintenanceCleanup();
    void runBuyerAutoApproveScheduler();
  }, 24 * 3600 * 1000);
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
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}

main().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
