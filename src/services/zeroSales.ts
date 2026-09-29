import { query, withTransaction } from '../db/pool.js';
import { toHKDateString, toHKString } from '../lib/time.js';

export interface ZeroSalesBatchRow {
  id: string;
  week_label: string;
  note: string;
  row_count: number;
  store_count: number;
  content_hash: string;
  created_by: string;
  created_at: string;
  replied_count?: number;
  pending_count?: number;
}

export interface ZeroSalesItemRow {
  id: string;
  batch_id: string;
  site_code: string;
  sku: string;
  payload: Record<string, string>;
  status: 'pending' | 'replied';
  reason_code: string | null;
  reason_label: string | null;
  reason_note: string;
  replied_at: string | null;
  replied_by: string | null;
  week_label?: string;
  batch_created_at?: string;
  /** SKU 上載日期 (日 only，YYYY-MM-DD) */
  batch_date?: string;
  /** 已回覆次數：0=未回覆，1=已回覆未改過，2=已用完修改機會 */
  reply_count: number;
}

export interface ZeroSalesReasonRow {
  code: string;
  label: string;
  sort_order: number;
  active: boolean;
  require_note: boolean;
}

export async function listReasons(activeOnly = true): Promise<ZeroSalesReasonRow[]> {
  const sql = activeOnly
    ? 'SELECT code, label, sort_order, active, require_note FROM zero_sales_reasons WHERE active = true ORDER BY sort_order, code'
    : 'SELECT code, label, sort_order, active, require_note FROM zero_sales_reasons ORDER BY sort_order, code';
  const r = await query<ZeroSalesReasonRow>(sql);
  return r.rows;
}

export async function listBatches(): Promise<ZeroSalesBatchRow[]> {
  const r = await query<ZeroSalesBatchRow>(
    `SELECT b.*,
      (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'replied') AS replied_count,
      (SELECT count(*)::int FROM zero_sales_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending_count
     FROM zero_sales_batches b ORDER BY b.created_at DESC LIMIT 100`,
  );
  return r.rows.map((b) => ({ ...b, created_at: toHKString(b.created_at) }));
}

export async function createBatch(input: {
  weekLabel: string;
  note: string;
  rows: Array<{ siteCode: string; sku: string; data: Record<string, string> }>;
  contentHash: string;
  createdBy: string;
}): Promise<{ batchId: string }> {
  return withTransaction(async (client) => {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO zero_sales_batches (week_label, note, row_count, store_count, content_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        input.weekLabel,
        input.note ?? '',
        input.rows.length,
        new Set(input.rows.map((r) => r.siteCode)).size,
        input.contentHash,
        input.createdBy,
      ],
    );
    const batchId = ins.rows[0]!.id;
    for (const r of input.rows) {
      await client.query(
        `INSERT INTO zero_sales_items (batch_id, site_code, sku, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (batch_id, site_code, sku) DO UPDATE SET payload = EXCLUDED.payload`,
        [batchId, r.siteCode, r.sku, JSON.stringify(r.data)],
      );
    }
    return { batchId };
  });
}

export async function listBatchItems(batchId: string, opts: { siteCode?: string; status?: string }): Promise<ZeroSalesItemRow[]> {
  const where = ['i.batch_id = $1'];
  const params: unknown[] = [batchId];
  if (opts.siteCode) { params.push(opts.siteCode); where.push(`i.site_code = $${params.length}`); }
  if (opts.status === 'pending' || opts.status === 'replied') { params.push(opts.status); where.push(`i.status = $${params.length}`); }
  const r = await query<ZeroSalesItemRow>(
    `SELECT i.*, b.week_label, b.created_at AS batch_created_at FROM zero_sales_items i
     JOIN zero_sales_batches b ON b.id = i.batch_id
     WHERE ${where.join(' AND ')} ORDER BY i.site_code, i.sku LIMIT 2000`,
    params,
  );
  return r.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    batch_created_at: row.batch_created_at ? toHKString(row.batch_created_at as unknown as string) : undefined,
    batch_date: row.batch_created_at ? toHKDateString(row.batch_created_at as unknown as string) : undefined,
  }));
}

export async function listMyItems(siteCode: string, opts: { status?: string; batchId?: string }): Promise<ZeroSalesItemRow[]> {
  const where = ['i.site_code = $1'];
  const params: unknown[] = [siteCode];
  if (opts.status === 'pending' || opts.status === 'replied') { params.push(opts.status); where.push(`i.status = $${params.length}`); }
  if (opts.batchId) { params.push(opts.batchId); where.push(`i.batch_id = $${params.length}`); }
  const r = await query<ZeroSalesItemRow>(
    `SELECT i.*, b.week_label, b.created_at AS batch_created_at FROM zero_sales_items i
     JOIN zero_sales_batches b ON b.id = i.batch_id
     WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC, i.sku LIMIT 1000`,
    params,
  );
  return r.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    batch_created_at: row.batch_created_at ? toHKString(row.batch_created_at as unknown as string) : undefined,
    batch_date: row.batch_created_at ? toHKDateString(row.batch_created_at as unknown as string) : undefined,
  }));
}

export class ZeroSalesReplyError extends Error {}

export async function replyItem(input: {
  itemId: string;
  siteCode: string;
  reasonCode: string;
  reasonNote: string;
  repliedBy: string;
  repliedByUserId: string;
}): Promise<ZeroSalesItemRow> {
  const reasons = await listReasons(true);
  const found = reasons.find((r) => r.code === input.reasonCode);
  if (!found) throw new ZeroSalesReplyError('回覆原因無效，請重新選擇');
  const note = (input.reasonNote ?? '').trim();
  if (found.require_note && !note) throw new ZeroSalesReplyError(`選擇「${found.label}」必須填寫補充說明`);
  if (note.length > 2000) throw new ZeroSalesReplyError('補充說明最多 2000 字');
  const current = await query<{ id: string; status: string; reply_count: number }>(
    'SELECT id, status, reply_count FROM zero_sales_items WHERE id = $1 AND site_code = $2',
    [input.itemId, input.siteCode],
  );
  const cur = current.rows[0];
  if (!cur) throw new ZeroSalesReplyError('找不到此 SKU 指派');
  if ((cur.reply_count ?? 0) >= 2) {
    throw new ZeroSalesReplyError('此 SKU 已用完修改機會（只可修改一次），如需再更改請聯絡 RP Team');
  }
  const r = await query<ZeroSalesItemRow>(
    `UPDATE zero_sales_items SET status = 'replied', reason_code = $1, reason_label = $2, reason_note = $3,
      replied_at = now(), replied_by = $4, replied_by_user_id = $5, updated_at = now(),
      reply_count = reply_count + 1
     WHERE id = $6 AND site_code = $7
     RETURNING *`,
    [found.code, found.label, note, input.repliedBy, input.repliedByUserId, input.itemId, input.siteCode],
  );
  const row = r.rows[0];
  if (!row) throw new ZeroSalesReplyError('找不到此 SKU 指派');
  return {
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload as unknown as string) : (row.payload ?? {}),
    replied_at: row.replied_at ? toHKString(row.replied_at) : null,
    batch_date: undefined,
  };
}
