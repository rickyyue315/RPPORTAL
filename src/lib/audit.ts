import { query } from '../db/pool.js';

export type AuditEventType =
  | 'login_success'
  | 'login_failure'
  | 'login_locked'
  | 'logout'
  | 'submission_created'
  | 'submission_queried'
  | 'submission_modified'
  | 'application_no_recovered'
  | 'admin_modified'
  | 'excel_import'
  | 'excel_import_error'
  | 'export_created'
  | 'export_download'
  | 'export_preview'
  | 'export_error'
  | 'export_locked'
  | 'store_master_updated'
  | 'ip_cleanup';

interface AuditInput {
  eventType: AuditEventType;
  actorRole?: 'applicant' | 'admin';
  actor?: string;
  submissionId?: string;
  applicationNo?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

export async function writeAuditEvent(input: AuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_events (event_type, actor_role, actor, submission_id, application_no, ip, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.eventType,
        input.actorRole ?? null,
        input.actor ?? null,
        input.submissionId ?? null,
        input.applicationNo ?? null,
        input.ip ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
  } catch (err) {
    // Audit must never break the main flow.
    console.error('[audit] failed to write event', err);
  }
}
