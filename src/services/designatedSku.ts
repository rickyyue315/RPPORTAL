import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import { toHKDateString, toHKString } from '../lib/time.js';
import { normalizeYearCode } from '../lib/designatedSku.js';

/**
 * 指定 SKU 回覆 — 資料存取
 *
 * 一個「事項」= 一批次內同一店舖（designated_sku_matters），內含多個 SKU
 * （designated_sku_items）。店舖一次過為事項內每個 SKU 填寫年期及可調撥件數，
 * 全部 SKU 已回覆（或標示「無可調撥」）才算事項完成。
 *
 * 權限：店舖一律以 site_code 在 SQL 層隔離；管理員操作不受店舖限制。
 */

export const DESIGNATED_SKU_MAX_LINES = 20;
export const DESIGNATED_SKU_MAX_QTY = 9999;
export const DESIGNATED_SKU_NOTE_MAX = 2000;

export interface DesignatedSkuReplyLine {
  year_code: string;
  qty: number;
}

export interface DesignatedSkuMatterItem {
  id: string;
  matter_id: string;
  site_code: string;
  sku: string;
  product_hierarchy: string;
  description: string;
  stock_qty: number | null;
  payload: Record<string, string>;
  status: 'pending' | 'replied';
  /** 店舖明確表示此 SKU 沒有可調撥件數（與未回覆區分） */
  no_transfer: boolean;
  reply_note: string;
  reply_total: number | null;
  reply_line_count: number;
  replied_at: string | null;
  replied_by: string | null;
  reply_count: number;
  admin_edited_at: string | null;
  admin_edited_by: string;
  created_at: string;
  updated_at: string;
  lines: DesignatedSkuReplyLine[];
}

export interface DesignatedSkuMatter {
  id: string;
  batch_id: string;
  matter_code: string;
  site_code: string;
  shop: string;
  batch_code: string;
  subject: string;
  matter_type: string;
  instructions: string;
  due_date: string | null;
  reference: string;
  batch_note: string;
  settings: Record<string, unknown>;
  batch_created_at: string;
  batch_closed_at: string | null;
  is_open: boolean;
  /** 全部 SKU 已回覆（或標示無可調撥）才算是 replied */
  status: 'pending' | 'replied';
  item_count: number;
  replied_item_count: number;
  reply_total: number;
  replied_at: string | null;
  replied_by: string;
  items: DesignatedSkuMatterItem[];
}

export interface DesignatedSkuBatchRow {
  id: string;
  batch_code: string;
  subject: string;
  matter_type: string;
  instructions: string;
  due_date: string | null;
  reference: string;
  note: string;
  settings: Record<string, unknown>;
  source_filename: string;
  row_count: number;
  store_count: number;
  matter_count: number;
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

const MATTER_SELECT = `
  SELECT m.*, b.batch_code, b.subject, b.matter_type, b.instructions, b.due_date, b.reference,
         b.note AS batch_note, b.settings, b.created_at AS batch_created_at,
         b.closed_at AS batch_closed_at, s.shop
    FROM designated_sku_matters m
    JOIN designated_sku_batches b ON b.id = m.batch_id
    LEFT JOIN stores s ON s.site_code = m.site_code
`;

interface MatterBase {
  id: string;
  batch_id: string;
  matter_code: string;
  site_code: string;
  shop: string;
  batch_code: string;
  subject: string;
  matter_type: string;
  instructions: string;
  due_date: string | null;
  reference: string;
  batch_note: string;
  settings: Record<string, unknown>;
  batch_created_at: string;
  batch_closed_at: string | null;
  is_open: boolean;
}

function mapMatterBase(row: Record<string, unknown>): MatterBase {
  const m = row as unknown as MatterBase;
  return {
    ...m,
    settings: asRecord(m.settings),
    due_date: dateOnly(m.due_date as unknown as string | Date | null),
    batch_created_at: toHKString(m.batch_created_at as unknown as string),
    batch_closed_at: m.batch_closed_at ? toHKString(m.batch_closed_at as unknown as string) : null,
    is_open: !m.batch_closed_at,
    shop: m.shop ?? '',
  };
}

function mapItem(row: Record<string, unknown>): DesignatedSkuMatterItem {
  const item = row as unknown as DesignatedSkuMatterItem;
  return {
    ...item,
    stock_qty: item.stock_qty === null || item.stock_qty === undefined ? null : Number(item.stock_qty),
    reply_total: item.reply_total === null || item.reply_total === undefined ? null : Number(item.reply_total),
    reply_line_count: Number(item.reply_line_count ?? 0),
    reply_count: Number(item.reply_count ?? 0),
    no_transfer: Boolean(item.no_transfer),
    payload: asStringRecord(item.payload),
    replied_at: item.replied_at ? toHKString(item.replied_at as unknown as string) : null,
    admin_edited_at: item.admin_edited_at ? toHKString(item.admin_edited_at as unknown as string) : null,
    admin_edited_by: item.admin_edited_by ?? '',
    created_at: toHKString(item.created_at as unknown as string),
    updated_at: toHKString(item.updated_at as unknown as string),
    lines: [],
  };
}

/** 把 SKU 明細及年期掛到事項，並推導事項狀態 */
async function attachItems(bases: MatterBase[]): Promise<DesignatedSkuMatter[]> {
  if (!bases.length) return [];
  const placeholders = bases.map((_, i) => `$${i + 1}`).join(', ');
  const ids = bases.map((b) => b.id);
  const itemRows = await query(
    `SELECT * FROM designated_sku_items WHERE matter_id IN (${placeholders}) ORDER BY matter_id, sku`,
    ids,
  );
  const items = itemRows.rows.map(mapItem);

  if (items.length) {
    const itemPlaceholders = items.map((_, i) => `$${i + 1}`).join(', ');
    const lineRows = await query<{ item_id: string; year_code: string; qty: number }>(
      `SELECT item_id, year_code, qty FROM designated_sku_reply_lines
        WHERE item_id IN (${itemPlaceholders}) ORDER BY year_code`,
      items.map((it) => it.id),
    );
    const byItem = new Map<string, DesignatedSkuReplyLine[]>();
    for (const line of lineRows.rows) {
      const list = byItem.get(line.item_id) ?? [];
      list.push({ year_code: line.year_code, qty: Number(line.qty) });
      byItem.set(line.item_id, list);
    }
    for (const item of items) item.lines = byItem.get(item.id) ?? [];
  }

  const byMatter = new Map<string, DesignatedSkuMatterItem[]>();
  for (const item of items) {
    const list = byMatter.get(item.matter_id) ?? [];
    list.push(item);
    byMatter.set(item.matter_id, list);
  }

  return bases.map((base) => {
    const matterItems = byMatter.get(base.id) ?? [];
    const repliedItems = matterItems.filter((it) => it.status === 'replied');
    const repliedAt = repliedItems
      .map((it) => it.replied_at)
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop() ?? null;
    const repliedBy = [...new Set(repliedItems.map((it) => it.replied_by ?? '').filter(Boolean))].join('、');
    return {
      ...base,
      status: matterItems.length > 0 && repliedItems.length === matterItems.length ? 'replied' : 'pending',
      item_count: matterItems.length,
      replied_item_count: repliedItems.length,
      reply_total: matterItems.reduce((sum, it) => sum + (it.reply_total ?? 0), 0),
      replied_at: repliedAt,
      replied_by: repliedBy,
      items: matterItems,
    };
  });
}

async function nextBatchCode(client: PoolClient): Promise<string> {
  const r = await client.query<{ seq: string }>("SELECT nextval('designated_sku_batch_seq')::text AS seq");
  const seq = Number(r.rows[0]?.seq ?? 0);
  const stamp = toHKDateString(new Date()).replace(/-/g, '').slice(2);
  return `DSKU-${stamp}-${String(seq).padStart(4, '0')}`;
}

export interface CreateDesignatedSkuBatchInput {
  subject: string;
  matterType?: string;
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
): Promise<{ batchId: string; batchCode: string; matterCodes: string[] }> {
  return withTransaction(async (client) => {
    const batchCode = await nextBatchCode(client);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO designated_sku_batches
         (batch_code, subject, matter_type, instructions, due_date, reference, note, settings,
          source_filename, row_count, store_count, skipped_rows, warn_count, content_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        batchCode,
        input.subject,
        input.matterType || 'stock_year_breakdown',
        input.instructions ?? '',
        input.dueDate || null,
        input.reference ?? '',
        input.note ?? '',
        JSON.stringify(input.settings ?? {}),
        input.sourceFilename,
        input.rows.length,
        0,
        input.skippedRows,
        input.warnCount,
        input.contentHash,
        input.createdBy,
      ],
    );
    const batchId = ins.rows[0]!.id;

    // 按店舖分組：同一店舖的多個 SKU 歸入同一個事項
    const siteOrder: string[] = [];
    const bySite = new Map<string, CreateDesignatedSkuBatchInput['rows']>();
    for (const row of input.rows) {
      if (!bySite.has(row.siteCode)) {
        siteOrder.push(row.siteCode);
        bySite.set(row.siteCode, []);
      }
      bySite.get(row.siteCode)!.push(row);
    }

    const matterCodes: string[] = [];
    for (let i = 0; i < siteOrder.length; i += 1) {
      const siteCode = siteOrder[i]!;
      const matterCode = `${batchCode}-${String(i + 1).padStart(2, '0')}`;
      matterCodes.push(matterCode);
      const matter = await client.query<{ id: string }>(
        `INSERT INTO designated_sku_matters (batch_id, matter_code, site_code)
         VALUES ($1, $2, $3) RETURNING id`,
        [batchId, matterCode, siteCode],
      );
      const matterId = matter.rows[0]!.id;
      for (const row of bySite.get(siteCode)!) {
        await client.query(
          `INSERT INTO designated_sku_items
             (batch_id, matter_id, site_code, sku, product_hierarchy, description, stock_qty, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (batch_id, site_code, sku) DO NOTHING`,
          [
            batchId,
            matterId,
            row.siteCode,
            row.sku,
            row.hierarchy,
            row.description,
            row.stockQty,
            JSON.stringify(row.data),
          ],
        );
      }
    }

    await client.query(
      `UPDATE designated_sku_batches SET store_count = $2 WHERE id = $1`,
      [batchId, siteOrder.length],
    );

    return { batchId, batchCode, matterCodes };
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
    matter_count: Number(b.matter_count ?? 0),
    row_count: Number(b.row_count ?? 0),
    store_count: Number(b.store_count ?? 0),
  };
}

const BATCH_COUNT_SELECT = `
            (SELECT count(*)::int FROM designated_sku_matters m WHERE m.batch_id = b.id) AS matter_count,
            (
              SELECT count(*)::int FROM designated_sku_matters m
               WHERE m.batch_id = b.id
                 AND EXISTS (
                   SELECT 1 FROM designated_sku_items i
                    WHERE i.matter_id = m.id AND i.status = 'pending'
                 )
            ) AS pending_count,
            (
              SELECT count(*)::int FROM designated_sku_matters m
               WHERE m.batch_id = b.id
                 AND NOT EXISTS (
                   SELECT 1 FROM designated_sku_items i
                    WHERE i.matter_id = m.id AND i.status = 'pending'
                 )
            ) AS replied_count
`;

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
    `SELECT b.*, ${BATCH_COUNT_SELECT}
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
    `SELECT b.*, ${BATCH_COUNT_SELECT} FROM designated_sku_batches b WHERE b.id = $1`,
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

export async function listBatchMatters(
  batchId: string,
  opts: { siteCode?: string; status?: string } = {},
): Promise<DesignatedSkuMatter[]> {
  const where = ['m.batch_id = $1'];
  const params: unknown[] = [batchId];
  if (opts.siteCode) {
    params.push(opts.siteCode);
    where.push(`m.site_code = $${params.length}`);
  }
  const r = await query(
    `${MATTER_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.matter_code LIMIT 2000`,
    params,
  );
  const matters = await attachItems(r.rows.map(mapMatterBase));
  if (opts.status === 'pending' || opts.status === 'replied') {
    return matters.filter((m) => m.status === opts.status);
  }
  return matters;
}

export async function getMatterById(batchId: string, matterId: string): Promise<DesignatedSkuMatter> {
  const r = await query(`${MATTER_SELECT} WHERE m.batch_id = $1 AND m.id = $2`, [batchId, matterId]);
  const row = r.rows[0];
  if (!row) throw new DesignatedSkuNotFoundError('找不到此事項，可能已被刪除');
  const [matter] = await attachItems([mapMatterBase(row)]);
  return matter!;
}

export interface DesignatedSkuExportFilter {
  batchId?: string;
  siteCode?: string;
  status?: 'pending' | 'replied';
}

export async function listMattersForExport(
  filter: DesignatedSkuExportFilter = {},
): Promise<DesignatedSkuMatter[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.batchId) {
    params.push(filter.batchId);
    where.push(`m.batch_id = $${params.length}`);
  }
  if (filter.siteCode) {
    params.push(filter.siteCode);
    where.push(`m.site_code = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await query(
    `${MATTER_SELECT} ${clause} ORDER BY b.created_at DESC, m.matter_code LIMIT 5000`,
    params,
  );
  const matters = await attachItems(r.rows.map(mapMatterBase));
  if (filter.status) return matters.filter((m) => m.status === filter.status);
  return matters;
}

export interface DesignatedSkuSummary {
  batch_count: number;
  open_batch_count: number;
  matter_count: number;
  item_count: number;
  replied_count: number;
  pending_count: number;
  store_count: number;
  pending_store_count: number;
}

export async function getSummary(): Promise<DesignatedSkuSummary> {
  const r = await query<Record<string, string>>(
    `WITH m AS (
       SELECT m.id, m.site_code,
              count(i.id)::int AS item_count,
              count(*) FILTER (WHERE i.status = 'pending')::int AS pending_items
         FROM designated_sku_matters m
         JOIN designated_sku_items i ON i.matter_id = m.id
        GROUP BY m.id
     )
     SELECT
       (SELECT count(*)::text FROM designated_sku_batches) AS batch_count,
       (SELECT count(*)::text FROM designated_sku_batches WHERE closed_at IS NULL) AS open_batch_count,
       count(*)::text AS matter_count,
       COALESCE(sum(item_count), 0)::text AS item_count,
       count(*) FILTER (WHERE pending_items = 0)::text AS replied_count,
       count(*) FILTER (WHERE pending_items > 0)::text AS pending_count,
       count(DISTINCT site_code)::text AS store_count,
       count(DISTINCT site_code) FILTER (WHERE pending_items > 0)::text AS pending_store_count
     FROM m`,
  );
  const row = r.rows[0] ?? {};
  return {
    batch_count: Number(row.batch_count ?? 0),
    open_batch_count: Number(row.open_batch_count ?? 0),
    matter_count: Number(row.matter_count ?? 0),
    item_count: Number(row.item_count ?? 0),
    replied_count: Number(row.replied_count ?? 0),
    pending_count: Number(row.pending_count ?? 0),
    store_count: Number(row.store_count ?? 0),
    pending_store_count: Number(row.pending_store_count ?? 0),
  };
}

/** 店舖端：只回傳屬於該 Site Code 的事項（含批次資料、SKU 明細及年期） */
export async function listMyMatters(
  siteCode: string,
  opts: { status?: 'pending' | 'replied' } = {},
): Promise<DesignatedSkuMatter[]> {
  const r = await query(
    `${MATTER_SELECT} WHERE m.site_code = $1
      ORDER BY (
        SELECT count(*) FROM designated_sku_items i
         WHERE i.matter_id = m.id AND i.status = 'pending'
      ) > 0 DESC, b.created_at DESC, m.matter_code
      LIMIT 500`,
    [siteCode],
  );
  const matters = await attachItems(r.rows.map(mapMatterBase));
  if (opts.status) return matters.filter((m) => m.status === opts.status);
  return matters;
}

export async function getMyMatter(siteCode: string, matterCode: string): Promise<DesignatedSkuMatter> {
  const r = await query(`${MATTER_SELECT} WHERE m.matter_code = $1`, [matterCode]);
  const row = r.rows[0];
  if (!row) throw new DesignatedSkuNotFoundError('找不到此事項，可能已被刪除');
  const base = mapMatterBase(row);
  // 店舖隔離：唔屬於你店舖嘅事項一律拒絕（不透露是否存在）
  if (base.site_code !== siteCode) {
    throw new DesignatedSkuForbiddenError('此事項不屬於你店舖，請以正確的 Site Code 登入');
  }
  const [matter] = await attachItems([base]);
  return matter!;
}

export interface MatterReplyItemInput {
  item_id: string;
  lines: Array<{ year_code?: unknown; qty?: unknown }>;
  note?: string;
  no_transfer?: boolean;
}

export interface SubmitMatterReplyInput {
  siteCode: string;
  matterCode: string;
  items: MatterReplyItemInput[];
  repliedBy: string;
  repliedByUserId: string;
}

function normalizeLines(raw: Array<{ year_code?: unknown; qty?: unknown }>): DesignatedSkuReplyLine[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new DesignatedSkuError('請為每個 SKU 填寫至少一個年期及可調撥件數，或勾選「無可調撥」');
  }
  if (raw.length > DESIGNATED_SKU_MAX_LINES) {
    throw new DesignatedSkuError(`每個 SKU 最多只可填寫 ${DESIGNATED_SKU_MAX_LINES} 個年期`);
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

interface NormalizedItemReply {
  itemId: string;
  lines: DesignatedSkuReplyLine[];
  total: number;
  note: string;
  noTransfer: boolean;
}

function validateItemReplies(
  dbItems: Array<{ id: string; sku: string; stock_qty: number | null }>,
  submitted: MatterReplyItemInput[],
): NormalizedItemReply[] {
  const byId = new Map(dbItems.map((it) => [it.id, it]));
  if (submitted.length !== byId.size) {
    throw new DesignatedSkuError('請為事項內每個 SKU 填寫回覆，或勾選「無可調撥」');
  }
  const seen = new Set<string>();
  const out: NormalizedItemReply[] = [];
  for (const input of submitted) {
    const item = byId.get(input.item_id);
    if (!item) throw new DesignatedSkuError('回覆資料與事項不符，請重新整理後再試');
    if (seen.has(input.item_id)) throw new DesignatedSkuError('同一個 SKU 只可回覆一次');
    seen.add(input.item_id);

    const noTransfer = input.no_transfer === true;
    const lines = noTransfer ? [] : normalizeLines(input.lines);
    const total = lines.reduce((sum, line) => sum + line.qty, 0);
    const stock = item.stock_qty === null || item.stock_qty === undefined ? null : Number(item.stock_qty);
    if (!noTransfer && stock !== null && total > stock) {
      throw new DesignatedSkuError(`SKU ${item.sku} 的可調撥件數合計 ${total} 件，不可多於存貨 ${stock} 件`);
    }
    const note = String(input.note ?? '').slice(0, DESIGNATED_SKU_NOTE_MAX);
    out.push({ itemId: input.item_id, lines, total, note, noTransfer });
  }
  return out;
}

async function replaceLines(client: PoolClient, itemId: string, lines: DesignatedSkuReplyLine[]): Promise<void> {
  await client.query('DELETE FROM designated_sku_reply_lines WHERE item_id = $1', [itemId]);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    await client.query(
      `INSERT INTO designated_sku_reply_lines (item_id, year_code, qty, sort_order)
       VALUES ($1, $2, $3, $4)`,
      [itemId, line.year_code, line.qty, i],
    );
  }
}

export async function submitMatterReply(input: SubmitMatterReplyInput): Promise<DesignatedSkuMatter> {
  await withTransaction(async (client) => {
    const r = await client.query<{ id: string; site_code: string; closed_at: string | null }>(
      `SELECT m.id, m.site_code, b.closed_at
         FROM designated_sku_matters m
         JOIN designated_sku_batches b ON b.id = m.batch_id
        WHERE m.matter_code = $1
        FOR UPDATE OF m, b`,
      [input.matterCode],
    );
    const matter = r.rows[0];
    if (!matter) throw new DesignatedSkuNotFoundError('找不到此事項，可能已被刪除');
    if (matter.site_code !== input.siteCode) {
      throw new DesignatedSkuForbiddenError('此事項不屬於你店舖，請以正確的 Site Code 登入');
    }
    if (matter.closed_at) {
      throw new DesignatedSkuClosedError('此事項已截止，只供查閱，不能再提交回覆');
    }

    const itemRows = await client.query<{ id: string; sku: string; stock_qty: number | null; status: string }>(
      `SELECT id, sku, stock_qty, status FROM designated_sku_items
        WHERE matter_id = $1 FOR UPDATE`,
      [matter.id],
    );
    const replies = validateItemReplies(itemRows.rows, input.items);

    for (const reply of replies) {
      await replaceLines(client, reply.itemId, reply.lines);
      await client.query(
        `UPDATE designated_sku_items
            SET status = 'replied',
                no_transfer = $2,
                reply_note = $3,
                reply_total = $4,
                reply_line_count = $5,
                replied_at = now(),
                replied_by = $6,
                replied_by_user_id = $7,
                reply_count = reply_count + 1,
                -- 店舖重新提交後，現行內容已非管理員版本
                admin_edited_at = NULL,
                admin_edited_by = '',
                updated_at = now()
          WHERE id = $1`,
        [
          reply.itemId,
          reply.noTransfer,
          reply.note,
          reply.total,
          reply.lines.length,
          input.repliedBy,
          input.repliedByUserId,
        ],
      );
    }
  });

  return getMyMatter(input.siteCode, input.matterCode);
}

export interface AdminMatterReplyInput {
  batchId: string;
  matterId: string;
  items: MatterReplyItemInput[];
  actor: string;
}

/**
 * 管理員代店舖輸入／修改事項回覆。
 *
 * - 未回覆的 SKU：代填後 replied_by 記為「管理員代填（帳號）」、reply_count = 1
 * - 已回覆的 SKU：保留店舖原本的 replied_by、replied_at 及 reply_count
 * - 批次已封存亦可修改；每次修改更新 admin_edited_at / admin_edited_by
 */
export async function adminSubmitMatterReply(
  input: AdminMatterReplyInput,
): Promise<{ matter: DesignatedSkuMatter; entered: boolean }> {
  const entered = await withTransaction(async (client) => {
    const m = await client.query<{ id: string }>(
      'SELECT id FROM designated_sku_matters WHERE id = $1 AND batch_id = $2 FOR UPDATE',
      [input.matterId, input.batchId],
    );
    if (!m.rows[0]) throw new DesignatedSkuNotFoundError('找不到此事項，可能已被刪除');

    const itemRows = await client.query<{ id: string; sku: string; stock_qty: number | null; status: string }>(
      `SELECT id, sku, stock_qty, status FROM designated_sku_items
        WHERE matter_id = $1 FOR UPDATE`,
      [input.matterId],
    );
    const replies = validateItemReplies(itemRows.rows, input.items);
    const statusById = new Map(itemRows.rows.map((row) => [row.id, row.status]));
    let anyPending = false;

    for (const reply of replies) {
      const wasPending = statusById.get(reply.itemId) !== 'replied';
      if (wasPending) anyPending = true;
      await replaceLines(client, reply.itemId, reply.lines);
      await client.query(
        `UPDATE designated_sku_items
            SET status = 'replied',
                no_transfer = $2,
                reply_note = $3,
                reply_total = $4,
                reply_line_count = $5,
                replied_at = CASE WHEN status = 'pending' THEN now() ELSE replied_at END,
                replied_by = CASE WHEN status = 'pending' THEN $6 ELSE replied_by END,
                reply_count = CASE WHEN status = 'pending' THEN 1 ELSE reply_count END,
                admin_edited_at = now(),
                admin_edited_by = $7,
                updated_at = now()
          WHERE id = $1`,
        [
          reply.itemId,
          reply.noTransfer,
          reply.note,
          reply.total,
          reply.lines.length,
          `管理員代填（${input.actor}）`,
          input.actor,
        ],
      );
    }
    return anyPending;
  });

  return { matter: await getMatterById(input.batchId, input.matterId), entered };
}

export async function deleteBatch(batchId: string): Promise<{ batchCode: string; matterCount: number } | null> {
  const info = await query<{ batch_code: string; matter_count: string }>(
    `SELECT b.batch_code,
            (SELECT count(*)::text FROM designated_sku_matters m WHERE m.batch_id = b.id) AS matter_count
       FROM designated_sku_batches b WHERE b.id = $1`,
    [batchId],
  );
  const row = info.rows[0];
  if (!row) return null;
  await query('DELETE FROM designated_sku_batches WHERE id = $1', [batchId]);
  return { batchCode: row.batch_code, matterCount: Number(row.matter_count ?? 0) };
}

export async function deleteMatter(
  batchId: string,
  matterId: string,
): Promise<{ matterCode: string; siteCode: string; itemCount: number } | null> {
  const info = await query<{ matter_code: string; site_code: string; item_count: string }>(
    `SELECT m.matter_code, m.site_code,
            (SELECT count(*)::text FROM designated_sku_items i WHERE i.matter_id = m.id) AS item_count
       FROM designated_sku_matters m
      WHERE m.id = $1 AND m.batch_id = $2`,
    [matterId, batchId],
  );
  const row = info.rows[0];
  if (!row) return null;
  await query('DELETE FROM designated_sku_matters WHERE id = $1 AND batch_id = $2', [matterId, batchId]);
  // 同步批次行數／店數，避免後台統計與實際不符
  await query(
    `UPDATE designated_sku_batches b
        SET row_count = (
              SELECT count(*) FROM designated_sku_items i
               JOIN designated_sku_matters m ON m.id = i.matter_id
              WHERE m.batch_id = b.id
            ),
            store_count = (SELECT count(*) FROM designated_sku_matters m WHERE m.batch_id = b.id)
      WHERE b.id = $1`,
    [batchId],
  );
  return { matterCode: row.matter_code, siteCode: row.site_code, itemCount: Number(row.item_count ?? 0) };
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

/** 店舖端首頁提示用：待回覆事項數（只要事項內仍有 SKU 未回覆即計） */
export async function countPendingMatters(siteCode: string): Promise<number> {
  const r = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
       SELECT m.id
         FROM designated_sku_matters m
         JOIN designated_sku_batches b ON b.id = m.batch_id
         JOIN designated_sku_items i ON i.matter_id = m.id
        WHERE m.site_code = $1 AND b.closed_at IS NULL
        GROUP BY m.id
       HAVING count(*) FILTER (WHERE i.status = 'pending') > 0
     ) x`,
    [siteCode],
  );
  return Number(r.rows[0]?.count ?? 0);
}
