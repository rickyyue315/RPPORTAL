import { query, withTransaction } from '../db/pool.js';
import { isValidSku } from '../lib/validation.js';
import { normalizeText } from '../lib/fields.js';
import { WorkflowConfigurationError } from './ndrfWorkflow.js';

export interface SkuMasterRow {
  sku: string;
  buyer_user_id: string;
  buyer_username: string;
  buyer_display_name: string;
  buyer_active: boolean;
  updated_by: string;
  updated_at: string;
}

export interface SkuMasterBatchRow {
  id: string;
  row_count: number;
  data: Array<{ sku: string; buyer_username: string }>;
  created_by: string;
  created_at: string;
}

export async function listSkuMaster(): Promise<SkuMasterRow[]> {
  const result = await query<SkuMasterRow>(
    `SELECT m.sku, m.buyer_user_id, u.username AS buyer_username,
            u.display_name AS buyer_display_name, u.active AS buyer_active,
            m.updated_by, m.updated_at
       FROM sku_master m
       JOIN portal_users u ON u.id = m.buyer_user_id
      ORDER BY m.sku`,
  );
  return result.rows;
}

export async function listSkuMasterBatches(limit = 20): Promise<SkuMasterBatchRow[]> {
  const result = await query<SkuMasterBatchRow>(
    'SELECT id, row_count, data, created_by, created_at FROM sku_master_batches ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  return result.rows;
}

export interface SkuMasterUploadRow {
  sku: string;
  buyerUsername: string;
}

/**
 * Replaces the SKU Master in one transaction. Fail-closed: if the new file
 * would leave any existing Pending ND submission without an active Buyer,
 * the whole batch is rejected and the problems are reported.
 */
export async function replaceSkuMaster(
  input: { rows: SkuMasterUploadRow[]; adminUsername: string },
): Promise<{ count: number }> {
  const errors: string[] = [];
  const seen = new Set<string>();
  const cleaned: Array<{ sku: string; buyerUsername: string }> = [];

  for (const row of input.rows) {
    const sku = normalizeText(row.sku);
    const buyer = normalizeText(row.buyerUsername);
    if (!isValidSku(sku)) {
      errors.push(`SKU「${sku}」格式無效`);
      continue;
    }
    if (!buyer) {
      errors.push(`SKU「${sku}」缺少 Buyer 使用者名稱`);
      continue;
    }
    if (seen.has(sku)) {
      errors.push(`SKU「${sku}」在檔案內重複`);
      continue;
    }
    seen.add(sku);
    cleaned.push({ sku, buyerUsername: buyer });
  }
  if (cleaned.length === 0 && errors.length > 0) {
    throw new WorkflowConfigurationError(`SKU Master 無效: ${errors.join('；')}`);
  }

  return withTransaction(async (client) => {
    const buyers = await client.query<{ id: string; username: string; active: boolean }>(
      `SELECT id, username, active FROM portal_users
        WHERE role = 'buyer' AND username = ANY($1::text[])`,
      [cleaned.map((row) => normalizeText(row.buyerUsername))],
    );
    const buyersByUsername = new Map(buyers.rows.map((row) => [row.username, row]));

    const newMap = new Map<string, string>();
    for (const row of cleaned) {
      const buyer = buyersByUsername.get(normalizeText(row.buyerUsername));
      if (!buyer) {
        errors.push(`SKU「${row.sku}」的 Buyer「${row.buyerUsername}」不存在`);
        continue;
      }
      if (!buyer.active) {
        errors.push(`SKU「${row.sku}」的 Buyer「${row.buyerUsername}」已停用`);
        continue;
      }
      newMap.set(row.sku, buyer.id);
    }
    if (errors.length > 0) {
      throw new WorkflowConfigurationError(`SKU Master 無效: ${errors.join('；')}`);
    }

    // Fail closed: pending ND submissions must keep an active Buyer in the new file.
    const pending = await client.query<{ sku: string }>(
      `SELECT sku FROM submissions
        WHERE submission_type = 'normal' AND ndrf_route = 'buyer' AND workflow_status = 'pending'`,
    );
    const pendingSkus = new Set(pending.rows.map((row) => row.sku));
    const missing: string[] = [];
    for (const sku of pendingSkus) {
      if (!newMap.has(sku)) missing.push(sku);
    }
    if (missing.length > 0) {
      throw new WorkflowConfigurationError(
        `新 SKU Master 會令以下待審 ND 沒有負責 Buyer，整批拒絕: ${missing.join(', ')}`,
      );
    }

    const before = await client.query<SkuMasterRow>(
      'SELECT sku, buyer_user_id FROM sku_master ORDER BY sku',
    );
    const batch = await client.query<{ id: string }>(
      `INSERT INTO sku_master_batches (row_count, data, created_by)
       VALUES ($1, $2::jsonb, $3) RETURNING id`,
      [
        newMap.size,
        JSON.stringify(cleaned),
        input.adminUsername,
      ],
    );
    void before;
    void batch;

    await client.query('DELETE FROM sku_master');
    for (const [sku, buyerUserId] of newMap) {
      await client.query(
        `INSERT INTO sku_master (sku, buyer_user_id, updated_by, updated_at)
         VALUES ($1, $2, $3, now())`,
        [sku, buyerUserId, input.adminUsername],
      );
    }
    return { count: newMap.size };
  });
}

/** Blocks deactivating a Buyer that still owns SKUs in the master. */
export async function assertBuyerHasNoSkus(userId: string): Promise<void> {
  const result = await query<{ cnt: string }>(
    'SELECT count(*)::text AS cnt FROM sku_master WHERE buyer_user_id = $1',
    [userId],
  );
  if (Number(result.rows[0]?.cnt ?? 0) > 0) {
    throw new WorkflowConfigurationError('此 Buyer 仍有已分配的 SKU，請先改派後再停用');
  }
}

/** Blocks deactivating the SCT while designated-shop pending submissions exist. */
export async function assertSctHasNoPending(_userId: string): Promise<void> {
  const result = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM submissions
      WHERE submission_type = 'normal' AND ndrf_route = 'sct' AND workflow_status = 'pending'`,
  );
  if (Number(result.rows[0]?.cnt ?? 0) > 0) {
    throw new WorkflowConfigurationError('仍有指定店 RF 待 SCT 審批，請先完成審批或改由 Admin override 後再停用');
  }
}
