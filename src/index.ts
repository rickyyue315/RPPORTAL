import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { query } from './db/pool.js';
import { writeAuditEvent } from './lib/audit.js';
import { seedStoresFromFile, countStores } from './services/stores.js';

async function runIpCleanup(): Promise<void> {
  try {
    const result = await query(
      `UPDATE submissions
       SET created_ip = NULL, created_ip_expires_at = NULL
       WHERE created_ip IS NOT NULL
         AND created_ip_expires_at IS NOT NULL
         AND created_ip_expires_at <= now()`,
    );
    // Version-history IPs are anonymous after the same retention window.
    const versionResult = await query(
      `UPDATE submission_versions
       SET ip = NULL
       WHERE ip IS NOT NULL
         AND changed_at <= now() - ($1::int * interval '1 day')`,
      [config.ipRetentionDays],
    );
    const total = (result.rowCount ?? 0) + (versionResult.rowCount ?? 0);
    if (total > 0) {
      await writeAuditEvent({
        eventType: 'ip_cleanup',
        metadata: { cleared: total },
      });
      console.log(`[cleanup] cleared IPs for ${total} records`);
    }
  } catch (err) {
    console.error('[cleanup] IP cleanup failed', err);
  }
}

async function main(): Promise<void> {
  console.log(`[boot] NDRF Portal (${config.env})`);

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
    void runIpCleanup();
  }, 24 * 3600 * 1000);
  void runIpCleanup();

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[boot] listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
