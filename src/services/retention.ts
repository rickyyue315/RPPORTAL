import type pg from 'pg';
import { config } from '../config.js';

export interface RetentionCleanupResult {
  submissionIpsCleared: number;
  versionIpsCleared: number;
  auditIpsCleared: number;
  auditEventsDeleted: number;
  loginAttemptsDeleted: number;
  sessionsDeleted: number;
  importBatchesDeleted: number;
  exportBatchesDeleted: number;
  rateLimitCountersDeleted: number;
}

/** Applies the documented privacy and operational retention policy. */
export async function cleanupRetentionData(client: pg.PoolClient): Promise<RetentionCleanupResult> {
  const submissions = await client.query(
    `UPDATE submissions
        SET created_ip = NULL, created_ip_expires_at = NULL
      WHERE created_ip IS NOT NULL
        AND created_ip_expires_at IS NOT NULL
        AND created_ip_expires_at <= now()`,
  );
  const versions = await client.query(
    `UPDATE submission_versions
        SET ip = NULL
      WHERE ip IS NOT NULL
        AND changed_at <= now() - ($1::int * interval '1 day')`,
    [config.ipRetentionDays],
  );
  const audits = await client.query(
    `UPDATE audit_events
        SET ip = NULL
      WHERE ip IS NOT NULL
        AND created_at <= now() - ($1::int * interval '1 day')`,
    [config.ipRetentionDays],
  );
  const auditEvents = await client.query(
    `DELETE FROM audit_events
      WHERE created_at <= now() - ($1::int * interval '1 day')`,
    [config.auditRetentionDays],
  );
  const loginAttempts = await client.query(
    `DELETE FROM admin_login_attempts
      WHERE attempted_at <= now() - ($1::int * interval '1 day')`,
    [config.loginAttemptRetentionDays],
  );
  const sessions = await client.query(
    'DELETE FROM admin_sessions WHERE expires_at <= now()',
  );
  const imports = await client.query(
    `DELETE FROM import_batches
      WHERE created_at <= now() - ($1::int * interval '1 day')`,
    [config.importBatchRetentionDays],
  );
  const exports = await client.query(
    `DELETE FROM export_batches
      WHERE created_at <= now() - ($1::int * interval '1 day')`,
    [config.exportBatchRetentionDays],
  );
  const rateLimits = await client.query(
    `DELETE FROM rate_limit_counters
      WHERE reset_at <= now()`,
  );

  return {
    submissionIpsCleared: submissions.rowCount ?? 0,
    versionIpsCleared: versions.rowCount ?? 0,
    auditIpsCleared: audits.rowCount ?? 0,
    auditEventsDeleted: auditEvents.rowCount ?? 0,
    loginAttemptsDeleted: loginAttempts.rowCount ?? 0,
    sessionsDeleted: sessions.rowCount ?? 0,
    importBatchesDeleted: imports.rowCount ?? 0,
    exportBatchesDeleted: exports.rowCount ?? 0,
    rateLimitCountersDeleted: rateLimits.rowCount ?? 0,
  };
}
