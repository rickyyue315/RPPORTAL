import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import { toHKDateString, toHKString } from '../lib/time.js';
import { normalizeYearCode } from '../lib/designatedSku.js';

/**
 * 指定 SKU 回覆 — 資料存取
 *
 * 一個「任務」= designated_sku_items 一行（批次 + 店舖 + SKU），
 * 店舖就每個貨品年期回覆可調撥件數，存於 designated_sku_reply_lines。
 * 店舖隔離一律由 site_code 條件在 SQL 層強制，不靠前端。
 */

export const DESIGNATED_SKU_MAX_LINES = 20;
export const DESIGNATED_SKU_MAX_QTY = 9999;
export const DESIGNATED_SKU_NOTE_MAX = 2000;

export interface DesignatedSkuReplyLine {
  year_code: string;
  qty: number;
}

export interface DesignatedSkuItemRow {
  id: string;
  batch_id: string;
  task_code: string;
  site_code: string;
  sku: string;
  product_hierarchy: string;
  description: string;
  stock_qty: number | null;
  payload: Record<string, string>;
  status: 'pending' | 'replied';
  reply_note: string;
  reply_total: number | null;
  reply_line_count: number;
  replied_at: string | null;
  replied_by: string | null;
  reply_count: number;
  /** 最近一次由管理員代填／修改（NULL = 從未由管理員改過） */
  admin_edited_at: string | null;
  admin_edited_by: string;
  created_at: string;
  updated_at: string;
  /** 批次欄位（JOIN 而来） */
  batch_code: string;
  subject: string;
  task_type: string;
  instructions: string;
  due_date: string | null;
  reference: string;
  batch_note: string;
  settings: Record<string, unknown>;
  batch_created_at: string;
  batch_closed_at: string | null;
  is_open: boolean;
  shop?: string;
  lines: DesignatedSkuReplyLine[];
}

export interface DesignatedSkuBatchRow {
  id: string;
  batch_code: string;
  subject: string;
  task_type: string;
  instructions: string;
  due_date: string | null;
  reference: string;
  note: string;
  settings: Record<string, unknown>;
  source_filename: string;
  row_count: number;
  store_count: number;
  skipped_rows: number;
  warn_count: number;
  created_by: string;
  created_at: string;
  closed_at: string | null;
  closed_by: string;
  close_reason: string;
  is_open: boolean;
  replied_count: number;
  pending_count: number;
}

export class DesignatedSkuError extends Error {}
export class DesignatedSkuNotFoundError extends DesignatedSkuError {}
export class DesignatedSkuForbiddenError extends DesignatedSkuError {}
export class DesignatedSkuClosedError extends DesignatedSkuError {}

function dateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return toHKDateString(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}

function asStringRecord(value: unknown): Record<string, string> {
  const raw = asRecord(value);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v === null || v === undefined ? '' : String(v);
  return out;
}

const ITEM_SELECT = `
  SELECT i.*, b.batch_code, b.subject, b.task_type, b.instructions, b.due_date, b.reference,
         b.note AS batch_note, b.settings, b.created_at AS batch_created_at,
         b.closed_at AS batch_closed_at, s.shop
    FROM designated_sku_items i
    JOIN designated_sku_batches b ON b.id = i.batch_id
    LEFT JOIN stores s ON s.site_code = i.site_code
`;

function mapItem(row: Record<string, unknown>): DesignatedSkuItemRow {
  const item = row as unknown as DesignatedSkuItemRow;
  return {
    ...item,
    stock_qty: item.stock_qty === null || item.stock_qty === undefined ? null : Number(item.stock_qty),
    reply_total: item.reply_total === null || item.reply_total === undefined ? null : Number(item.reply_total),
    reply_line_count: Number(item.reply_line_count ?? 0),
    reply_count: Number(item.reply_count ?? 0),
    payload: asStringRecord(item.payload),
    settings: asRecord(item.settings),
    due_date: dateOnly(item.due_date as unknown as string | Date | null),
    replied_at: item.replied_at ? toHKString(item.replied_at as unknown as string) : null,
    admin_edited_at: item.admin_edited_at ? toHKString(item.admin_edited_at as unknown as string) : null,
    admin_edited_by: item.admin_edited_by ?? '',
    created_at: toHKString(item.created_at as unknown as string),
    updated_at: toHKString(item.updated_at as unknown as string),
    batch_created_at: toHKString(item.batch_created_at as unknown as string),
    batch_closed_at: item.batch_closed_at ? toHKString(item.batch_closed_at as unknown as string) : null,
    is_open: !item.batch_closed_at,
    shop: item.shop ?? '',
    lines: [],
  };
}

async function attachLines(items: DesignatedSkuItemRow[]): Promise<DesignatedSkuItemRow[]> {
  if (!items.length) return items;
  const placeholders = items.map((_, i) => `$${i + 1}`).join(', ');
  const r = await query<{ item_id: string; year_code: string; qty: number }>(
    `SELECT item_id, year_code, qty
       FROM designated_sku_reply_lines
      WHERE item_id IN (${placeholders})
      ORDER BY year_code`,
    items.map((it) => it.id),
  );
  const byItem = new Map<string, DesignatedSkuReplyLine[]>();
  for (const line of r.rows) {
    const list = byItem.get(line.item_id) ?? [];
    list.push({ year_code: line.year_code, qty: Number(line.qty) });
    byItem.set(line.item_id, list);
  }
  return items.map((it) => ({ ...it, lines: byItem.get(it.id) ?? [] }));
}

async function nextBatchCode(client: PoolClient): Promise<string> {
  const r = await client.query<{ seq: string }>("SELECT nextval('designated_sku_batch_seq')::text AS seq");
  const seq = Number(r.rows[0]?.seq ?? 0);
  const stamp = toHKDateString(new Date()).replace(/-/g, '').slice(2);
  return `DSKU-${stamp}-${String(seq).padStart(4, '0')}`;
}

export interface CreateDesignatedSkuBatchInput {
  subject: string;
  taskType?: string;
  instructions?: string;
  dueDate?: string | null;
  reference?: string;
  note?: string;
  settings?: Record<string, unknown>;
  sourceFilename: string;
  rows: Array<{
    siteCode: string;
    sku: string;
    hierarchy: string;
    description: string;
    stockQty: number | null;
    data: Record<string, string>;
  }>;
  skippedRows: number;
  warnCount: number;
  contentHash: string;
  createdBy: string;
}

export async function createBatch(
  input: CreateDesignatedSkuBatchInput,
): Promise<{ batchId: string; batchCode: string; taskCodes: string[] }> {
  return withTransaction(async (client) => {
    const batchCode = await nextBatchCode(client);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO designated_sku_batches
         (batch_code, subject, task_type, instructions, due_date, reference, note, settings,
          source_filename, row_count, store_count, skipped_rows, warn_count, content_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        batchCode,
        input.subject,
        input.taskType || 'stock_year_breakdown',
        input.instructions ?? '',
        input.dueDate || null,
        input.reference ?? '',
        input.note ?? '',
        JSON.stringify(input.settings ?? {}),
        input.sourceFilename,
        input.rows.length,
        new Set(input.rows.map((r) => r.siteCode)).size,
        input.skippedRows,
        input.warnCount,
        input.contentHash,
        input.createdBy,
      ],
    );
    const batchId = ins.rows[0]!.id;
    const taskCodes: string[] = [];
    let index = 0;
    for (const row of input.rows) {
      index += 1;
      const taskCode = `${batchCode}-${String(index).padStart(2, '0')}`;
      taskCodes.push(taskCode);
      await client.query(
        `INSERT INTO designated_sku_items
           (batch_id, task_code, site_code, sku, product_hierarchy, description, stock_qty, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (batch_id, site_code, sku) DO NOTHING`,
        [
          batchId,
          taskCode,
          row.siteCode,
          row.sku,
          row.hierarchy,
          row.description,
          row.stockQty,
          JSON.stringify(row.data),
        ],
      );
    }
    return { batchId, batchCode, taskCodes };
  });
}

export async function findBatchByContentHash(
  contentHash: string,
): Promise<{ id: string; batch_code: string; created_at: string } | null> {
  if (!contentHash) return null;
  const r = await query<{ id: string; batch_code: string; created_at: string }>(
    `SELECT id, batch_code, created_at FROM designated_sku_batches
      WHERE content_hash = $1 ORDER BY created_at DESC LIMIT 1`,
    [contentHash],
  );
  const row = r.rows[0];
  return row ? { ...row, created_at: toHKString(row.created_at) } : null;
}

function mapBatch(row: Record<string, unknown>): DesignatedSkuBatchRow {
  const b = row as unknown as DesignatedSkuBatchRow;
  return {
    ...b,
    due_date: dateOnly(b.due_date as unknown as string | Date | null),
    settings: asRecord(b.settings),
    created_at: toHKString(b.created_at as unknown as string),
    closed_at: b.closed_at ? toHKString(b.closed_at as unknown as string) : null,
    is_open: !b.closed_at,
    replied_count: Number(b.replied_count ?? 0),
    pending_count: Number(b.pending_count ?? 0),
  };
}

export interface DesignatedSkuBatchPage {
  batches: DesignatedSkuBatchRow[];
  total: number;
  page: number;
  totalPages: number;
}

export async function listBatchesPage(opts: { page?: number; pageSize?: number } = {}): Promise<DesignatedSkuBatchPage> {
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(opts.pageSize ?? 20) || 20));
  const offset = (page - 1) * pageSize;
  const count = await query<{ total: string }>('SELECT count(*)::text AS total FROM designated_sku_batches');
  const total = Number(count.rows[0]?.total ?? 0);
  const rows = await query(
    `SELECT b.*,
            (SELECT count(*)::int FROM designated_sku_items i WHERE i.batch_id = b.id AND i.status = 'replied') AS replied_count,
            (SELECT count(*)::int FROM designated_sku_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending_count
       FROM designated_sku_batches b
      ORDER BY b.created_at DESC, b.batch_code DESC
      LIMIT $1 OFFSET $2`,
    [pageSize, offset],
  );
  return {
    batches: rows.rows.map(mapBatch),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getBatch(batchId: string): Promise<DesignatedSkuBatchRow | null> {
  const r = await query(
    `SELECT b.*,
            (SELECT count(*)::int FROM designated_sku_items i WHERE i.batch_id = b.id AND i.status = 'replied') AS replied_count,
            (SELECT count(*)::int FROM designated_sku_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending_count
       FROM designated_sku_batches b WHERE b.id = $1`,
    [batchId],
  );
  return r.rows[0] ? mapBatch(r.rows[0]) : null;
}

export async function listBatchesForSelect(): Promise<Array<{ id: string; batch_code: string; subject: string }>> {
  const r = await query<{ id: string; batch_code: string; subject: string }>(
    `SELECT id, batch_code, subject FROM designated_sku_batches
      ORDER BY created_at DESC, batch_code DESC LIMIT 200`,
  );
  return r.rows;
}

export async function listBatchItems(
  batchId: string,
  opts: { siteCode?: string; status?: string } = {},
): Promise<DesignatedSkuItemRow[]> {
  const where = ['i.batch_id = $1'];
  const params: unknown[] = [batchId];
  if (opts.siteCode) {
    params.push(opts.siteCode);
    where.push(`i.site_code = $${params.length}`);
  }
  if (opts.status === 'pending' || opts.status === 'replied') {
    params.push(opts.status);
    where.push(`i.status = $${params.length}`);
  }
  const r = await query(
    `${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.task_code LIMIT 2000`,
    params,
  );
  return attachLines(r.rows.map(mapItem));
}

export interface DesignatedSkuExportFilter {
  batchId?: string;
  siteCode?: string;
  status?: 'pending' | 'replied';
}

export async function listItemsForExport(filter: DesignatedSkuExportFilter = {}): Promise<DesignatedSkuItemRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.batchId) {
    params.push(filter.batchId);
    where.push(`i.batch_id = $${params.length}`);
  }
  if (filter.siteCode) {
    params.push(filter.siteCode);
    where.push(`i.site_code = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`i.status = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await query(
    `${ITEM_SELECT} ${clause} ORDER BY b.created_at DESC, i.task_code LIMIT 5000`,
    params,
  );
  return attachLines(r.rows.map(mapItem));
}

export interface DesignatedSkuSummary {
  batch_count: number;
  open_batch_count: number;
  task_count: number;
  replied_count: number;
  pending_count: number;
  store_count: number;
  pending_store_count: number;
}

export async function getSummary(): Promise<DesignatedSkuSummary> {
  const r = await query<Record<string, string>>(
    `SELECT
       (SELECT count(*)::text FROM designated_sku_batches) AS batch_count,
       (SELECT count(*)::text FROM designated_sku_batches WHERE closed_at IS NULL) AS open_batch_count,
       count(*)::text AS task_count,
       count(*) FILTER (WHERE status = 'replied')::text AS replied_count,
       count(*) FILTER (WHERE status = 'pending')::text AS pending_count,
       count(DISTINCT site_code)::text AS store_count,
       count(DISTINCT site_code) FILTER (WHERE status = 'pending')::text AS pending_store_count
     FROM designated_sku_items`,
  );
  const row = r.rows[0] ?? {};
  return {
    batch_count: Number(row.batch_count ?? 0),
    open_batch_count: Number(row.open_batch_count ?? 0),
    task_count: Number(row.task_count ?? 0),
    replied_count: Number(row.replied_count ?? 0),
    pending_count: Number(row.pending_count ?? 0),
    store_count: Number(row.store_count ?? 0),
    pending_store_count: Number(row.pending_store_count ?? 0),
  };
}

/** 店舖端：只回傳屬於該 Site Code 的任務（含批次資料及年期明細） */
export async function listMyTasks(
  siteCode: string,
  opts: { status?: 'pending' | 'replied' } = {},
): Promise<DesignatedSkuItemRow[]> {
  const params: unknown[] = [siteCode];
  let statusClause = '';
  if (opts.status) {
    params.push(opts.status);
    statusClause = ` AND i.status = $${params.length}`;
  }
  const r = await query(
    `${ITEM_SELECT} WHERE i.site_code = $1${statusClause}
      ORDER BY (i.status = 'pending') DESC, b.created_at DESC, i.task_code
      LIMIT 500`,
    params,
  );
  return attachLines(r.rows.map(mapItem));
}

export async function getMyTask(siteCode: string, taskCode: string): Promise<DesignatedSkuItemRow> {
  const r = await query(`${ITEM_SELECT} WHERE i.task_code = $1`, [taskCode]);
  const row = r.rows[0];
  if (!row) throw new DesignatedSkuNotFoundError('找不到此任務，可能已被刪除');
  const item = mapItem(row);
  // 店舖隔離：唔屬於你店舖嘅任務一律拒絕（不透露是否存在）
  if (item.site_code !== siteCode) {
    throw new DesignatedSkuForbiddenError('此任務不屬於你店舖，請以正確的 Site Code 登入');
  }
  const [withLines] = await attachLines([item]);
  return withLines!;
}

export interface SubmitReplyInput {
  siteCode: string;
  taskCode: string;
  lines: Array<{ year_code?: unknown; qty?: unknown }>;
  note?: string;
  repliedBy: string;
  repliedByUserId: string;
}

function normalizeLines(raw: SubmitReplyInput['lines']): DesignatedSkuReplyLine[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new DesignatedSkuError('請至少填寫一個貨品年期及可調撥件數');
  }
  if (raw.length > DESIGNATED_SKU_MAX_LINES) {
    throw new DesignatedSkuError(`最多只可填寫 ${DESIGNATED_SKU_MAX_LINES} 個年期`);
  }
  const out: DesignatedSkuReplyLine[] = [];
  const seen = new Set<string>();
  for (const line of raw) {
    const year = normalizeYearCode(typeof line.year_code === 'string' ? line.year_code : String(line.year_code ?? ''));
    if (!year) {
      throw new DesignatedSkuError('貨品年期格式不正確，請填 4 位數字 MMYY（例：0827 = 2027 年 8 月）');
    }
    if (seen.has(year)) {
      throw new DesignatedSkuError(`貨品年期 ${year} 重複，請合併為一行`);
    }
    seen.add(year);
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1) {
      throw new DesignatedSkuError(`年期 ${year} 的可調撥件數必須為 1 或以上的整數`);
    }
    if (qty > DESIGNATED_SKU_MAX_QTY) {
      throw new DesignatedSkuError(`年期 ${year} 的可調撥件數不可超過 ${DESIGNATED_SKU_MAX_QTY} 件`);
    }
    out.push({ year_code: year, qty });
  }
  out.sort((a, b) => a.year_code.localeCompare(b.year_code));
  return out;
}

export async function submitReply(input: SubmitReplyInput): Promise<DesignatedSkuItemRow> {
  const lines = normalizeLines(input.lines);
  const note = String(input.note ?? '').slice(0, DESIGNATED_SKU_NOTE_MAX);
  const total = lines.reduce((sum, line) => sum + line.qty, 0);

  await withTransaction(async (client) => {
    const r = await client.query<{
      id: string;
      site_code: string;
      stock_qty: number | null;
      closed_at: string | null;
      batch_code: string;
    }>(
      `SELECT i.id, i.site_code, i.stock_qty, b.closed_at, b.batch_code
         FROM designated_sku_items i
         JOIN designated_sku_batches b ON b.id = i.batch_id
        WHERE i.task_code = $1
        FOR UPDATE OF i, b`,
      [input.taskCode],
    );
    const item = r.rows[0];
    if (!item) throw new DesignatedSkuNotFoundError('找不到此任務，可能已被刪除');
    if (item.site_code !== input.siteCode) {
      throw new DesignatedSkuForbiddenError('此任務不屬於你店舖，請以正確的 Site Code 登入');
    }
    if (item.closed_at) {
      throw new DesignatedSkuClosedError('此任務已截止，只供查閱，不能再提交回覆');
    }
    const stock = item.stock_qty === null || item.stock_qty === undefined ? null : Number(item.stock_qty);
    if (stock !== null && total > stock) {
      throw new DesignatedSkuError(`可調撥件數合計 ${total} 件，不可多於存貨 ${stock} 件`);
    }

    await client.query('DELETE FROM designated_sku_reply_lines WHERE item_id = $1', [item.id]);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      await client.query(
        `INSERT INTO designated_sku_reply_lines (item_id, year_code, qty, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [item.id, line.year_code, line.qty, i],
      );
    }
    await client.query(
      `UPDATE designated_sku_items
          SET status = 'replied',
              reply_note = $2,
              reply_total = $3,
              reply_line_count = $4,
              replied_at = now(),
              replied_by = $5,
              replied_by_user_id = $6,
              reply_count = reply_count + 1,
              -- 店舖重新提交後，現行內容已非管理員版本：清空「管理員修改」標記
              -- （管理員曾修改的事實仍保留在 audit_events）
              admin_edited_at = NULL,
              admin_edited_by = '',
              updated_at = now()
        WHERE id = $1`,
      [item.id, note, total, lines.length, input.repliedBy, input.repliedByUserId],
    );
  });

  return getMyTask(input.siteCode, input.taskCode);
}

/** 後台：按批次 + 任務 id 取單一任務（admin 不受店舖隔離限制） */
export async function getItemById(batchId: string, itemId: string): Promise<DesignatedSkuItemRow> {
  const r = await query(`${ITEM_SELECT} WHERE i.batch_id = $1 AND i.id = $2`, [batchId, itemId]);
  const row = r.rows[0];
  if (!row) throw new DesignatedSkuNotFoundError('找不到此任務，可能已被刪除');
  const [item] = await attachLines([mapItem(row)]);
  return item!;
}

export interface AdminReplyInput {
  batchId: string;
  itemId: string;
  lines: Array<{ year_code?: unknown; qty?: unknown }>;
  note?: string;
  actor: string;
}

/**
 * 管理員代店舖輸入／修改回覆。
 *
 * - 未回覆的任務：代填後狀態轉為 replied，回覆人記為「管理員代填（帳號）」、reply_count = 1
 * - 已回覆的任務：只更換明細／備註，保留店舖原本的 replied_by、replied_at 及 reply_count
 *   （管理員修改不佔用店舖的修改次數）
 * - 批次已封存亦可修改（店舖截單後 email 要求更正）
 * - 每次修改都更新 admin_edited_at / admin_edited_by，並由 route 寫入審計日誌
 */
export async function adminSubmitReply(
  input: AdminReplyInput,
): Promise<{ item: DesignatedSkuItemRow; entered: boolean }> {
  const lines = normalizeLines(input.lines);
  const note = String(input.note ?? '').slice(0, DESIGNATED_SKU_NOTE_MAX);
  const total = lines.reduce((sum, line) => sum + line.qty, 0);

  const entered = await withTransaction(async (client) => {
    const r = await client.query<{ status: string; stock_qty: number | null }>(
      `SELECT status, stock_qty FROM designated_sku_items
        WHERE id = $1 AND batch_id = $2
        FOR UPDATE`,
      [input.itemId, input.batchId],
    );
    const item = r.rows[0];
    if (!item) throw new DesignatedSkuNotFoundError('找不到此任務，可能已被刪除');
    const stock = item.stock_qty === null || item.stock_qty === undefined ? null : Number(item.stock_qty);
    if (stock !== null && total > stock) {
      throw new DesignatedSkuError(`可調撥件數合計 ${total} 件，不可多於存貨 ${stock} 件`);
    }
    const wasPending = item.status !== 'replied';

    await client.query('DELETE FROM designated_sku_reply_lines WHERE item_id = $1', [input.itemId]);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      await client.query(
        `INSERT INTO designated_sku_reply_lines (item_id, year_code, qty, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [input.itemId, line.year_code, line.qty, i],
      );
    }
    await client.query(
      `UPDATE designated_sku_items
          SET status = 'replied',
              reply_note = $3,
              reply_total = $4,
              reply_line_count = $5,
              replied_at = CASE WHEN status = 'pending' THEN now() ELSE replied_at END,
              replied_by = CASE WHEN status = 'pending' THEN $6 ELSE replied_by END,
              reply_count = CASE WHEN status = 'pending' THEN 1 ELSE reply_count END,
              admin_edited_at = now(),
              admin_edited_by = $7,
              updated_at = now()
        WHERE id = $1 AND batch_id = $2`,
      [
        input.itemId,
        input.batchId,
        note,
        total,
        lines.length,
        `管理員代填（${input.actor}）`,
        input.actor,
      ],
    );
    return wasPending;
  });

  return { item: await getItemById(input.batchId, input.itemId), entered };
}

export async function deleteBatch(batchId: string): Promise<{ batchCode: string; rowCount: number } | null> {
  const r = await query<{ batch_code: string; row_count: number }>(
    'DELETE FROM designated_sku_batches WHERE id = $1 RETURNING batch_code, row_count',
    [batchId],
  );
  const row = r.rows[0];
  return row ? { batchCode: row.batch_code, rowCount: Number(row.row_count) } : null;
}

export async function deleteItem(
  batchId: string,
  itemId: string,
): Promise<{ taskCode: string; siteCode: string } | null> {
  const r = await query<{ task_code: string; site_code: string }>(
    'DELETE FROM designated_sku_items WHERE batch_id = $1 AND id = $2 RETURNING task_code, site_code',
    [batchId, itemId],
  );
  const row = r.rows[0];
  if (!row) return null;
  // 同步批次行數／店數，避免後台統計與實際不符
  await query(
    `UPDATE designated_sku_batches b
        SET row_count = (SELECT count(*) FROM designated_sku_items i WHERE i.batch_id = b.id),
            store_count = (SELECT count(DISTINCT site_code) FROM designated_sku_items i WHERE i.batch_id = b.id)
      WHERE b.id = $1`,
    [batchId],
  );
  return { taskCode: row.task_code, siteCode: row.site_code };
}

export async function closeBatch(
  batchId: string,
  actor: string,
): Promise<{ batchCode: string; wasOpen: boolean } | null> {
  const r = await query<{ batch_code: string; was_open: boolean }>(
    `UPDATE designated_sku_batches
        SET closed_at = now(), closed_by = $2, close_reason = 'manual'
      WHERE id = $1 AND closed_at IS NULL
      RETURNING batch_code, true AS was_open`,
    [batchId, actor],
  );
  const row = r.rows[0];
  if (row) return { batchCode: row.batch_code, wasOpen: true };
  const existing = await query<{ batch_code: string }>(
    'SELECT batch_code FROM designated_sku_batches WHERE id = $1',
    [batchId],
  );
  return existing.rows[0] ? { batchCode: existing.rows[0].batch_code, wasOpen: false } : null;
}

export async function reopenBatch(
  batchId: string,
  actor: string,
): Promise<{ batchCode: string; wasOpen: boolean } | null> {
  const r = await query<{ batch_code: string; was_open: boolean }>(
    `UPDATE designated_sku_batches
        SET closed_at = NULL, closed_by = $2, close_reason = ''
      WHERE id = $1 AND closed_at IS NOT NULL
      RETURNING batch_code, false AS was_open`,
    [batchId, actor],
  );
  const row = r.rows[0];
  if (row) return { batchCode: row.batch_code, wasOpen: false };
  const existing = await query<{ batch_code: string }>(
    'SELECT batch_code FROM designated_sku_batches WHERE id = $1',
    [batchId],
  );
  return existing.rows[0] ? { batchCode: existing.rows[0].batch_code, wasOpen: true } : null;
}

/** 店舖端首頁提示用：待回覆任務數 */
export async function countPendingTasks(siteCode: string): Promise<number> {
  const r = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM designated_sku_items i
       JOIN designated_sku_batches b ON b.id = i.batch_id
      WHERE i.site_code = $1 AND i.status = 'pending' AND b.closed_at IS NULL`,
    [siteCode],
  );
  return Number(r.rows[0]?.count ?? 0);
}
