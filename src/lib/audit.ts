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
  | 'excel_import_duplicate_rejected'
  | 'export_created'
  | 'export_download'
  | 'export_preview'
  | 'export_error'
  | 'export_locked'
  | 'store_master_updated'
  | 'recovery_code_set'
  | 'recovery_code_deleted'
  | 'ip_cleanup'
  | 'portal_login'
  | 'portal_logout'
  | 'portal_password_changed'
  | 'portal_submission_created'
  | 'portal_review_remark'
  | 'portal_review_decision'
  | 'portal_user_created'
  | 'portal_user_updated'
  | 'portal_user_deleted'
  | 'portal_password_reset'
  | 'store_accounts_synced'
  | 'sku_master_updated'
  | 'store_routes_updated'
  | 'rejection_reason_updated'
  | 'workflow_override'
  | 'buyer_auto_approved'
  | 'zero_sales_import_error'
  | 'zero_sales_batch_created'
  | 'zero_sales_batch_closed'
  | 'zero_sales_batch_reopened'
  | 'zero_sales_auto_filled'
  | 'zero_sales_reason_updated'
  | 'zero_sales_export'
  | 'zero_sales_store_export'
  | 'zero_sales_repeat_sku_export'
  | 'zero_sales_repeat_detail_export'
  | 'zero_sales_buyer_followup_export'
  | 'zero_sales_replied'
  | 'zero_sales_reply_edited'
  | 'zero_sales_reply_entered'
  | 'zero_sales_deleted'
  | 'shop_stock_batch_created'
  | 'shop_stock_batch_updated'
  | 'shop_stock_batch_deleted'
  | 'shop_stock_trend_export'
  | 'shop_stock_import_error';

interface AuditInput {
  eventType: AuditEventType;
  actorRole?: 'applicant' | 'admin' | 'store' | 'buyer' | 'sct';
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
