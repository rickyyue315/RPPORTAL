import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { withAdvisoryLock } from './db/pool.js';
import { writeAuditEvent } from './lib/audit.js';
import { seedStoresFromFile, countStores } from './services/stores.js';
import { cleanupExpiredExportFiles } from './services/exportFiles.js';
import { cleanupRetentionData } from './services/retention.js';

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
  if (!config.publicRecoveryCode) {
    console.warn('[boot] PUBLIC_RECOVERY_CODE 未設定 — 公開申請編號恢復功能已停用');
  }

  await migrate();

  const storeCount = await countStores();
  if (storeCount === 0) {
    const csvPath = config.storesCsvPath;
    console.log(`[boot] stores master empty, seeding from ${csvPath}`);
    const seeded = await seedStoresFromFile(csvPath);
    console.log(`[boot] seeded ${seeded} stores`);
  }

  // Scheduled IP retention cleanup (daily).
  setInterval(() => {
    void runMaintenanceCleanup();
  }, 24 * 3600 * 1000);
  void runMaintenanceCleanup();

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[boot] listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
