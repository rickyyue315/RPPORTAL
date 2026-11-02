import { readFile } from 'node:fs/promises';
import { query, withTransaction } from '../db/pool.js';

export interface Store {
  site_code: string;
  shop: string;
  regional: string;
  class1: string;
  class2: string;
  size: string;
  om: string;
  type: string;
  /** 「需特別關注」標記；空白代表未標記。來自 CSV 第 9 欄（可選）。 */
  attention: string;
}

export function normalizeSiteCode(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase();
}

export async function getStore(siteCode: string): Promise<Store | null> {
  const result = await query<Store>('SELECT * FROM stores WHERE site_code = $1', [normalizeSiteCode(siteCode)]);
  return result.rows[0] ?? null;
}

export async function listStores(search = ''): Promise<Store[]> {
  const term = `%${search.trim().toUpperCase()}%`;
  const result = await query<Store>(
    `SELECT * FROM stores
     WHERE site_code ILIKE $1 OR shop ILIKE $1
     ORDER BY site_code
     LIMIT 200`,
    [term],
  );
  return result.rows;
}

export async function countStores(): Promise<number> {
  const result = await query<{ count: string }>('SELECT count(*)::text AS count FROM stores');
  return Number(result.rows[0]?.count ?? 0);
}

interface ParsedCsv {
  rows?: string[][];
  error?: string;
}

function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldClosed = false;

  const finishRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    fieldClosed = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          fieldClosed = true;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      if (field !== '') return { error: 'CSV 格式錯誤: 引號只能包住完整欄位' };
      inQuotes = true;
    } else if (fieldClosed) {
      if (ch === ',') {
        row.push(field);
        field = '';
        fieldClosed = false;
      } else if (ch === '\n') {
        finishRow();
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        finishRow();
      } else {
        return { error: 'CSV 格式錯誤: 關閉引號後出現額外內容' };
      }
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      finishRow();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      finishRow();
    } else {
      field += ch;
    }
  }

  if (inQuotes) return { error: 'CSV 格式錯誤: 引號未關閉' };
  if (field !== '' || row.length > 0 || fieldClosed) {
    row.push(field);
    rows.push(row);
  }
  return { rows };
}

/** 門店主檔模板的固定 8 欄；第 9 欄「需特別關注」為選填（2026-11-02 起）。 */
const STORE_HEADERS = ['Site', 'Shop', 'Regional', 'Class 1', 'Class 2', 'Size', 'OM', 'Type'] as const;
export const ATTENTION_HEADER = '需特別關注';

/**
 * Parses a stores CSV. Expects header: Site,Shop,Regional,Class 1,Class 2,Size,OM,Type
 * plus the optional 9th column 需特別關注 (blank = not flagged).
 * Returns { ok, stores?, errors? }. Validates Site Code uniqueness.
 */
/** Decode CSV files exported by Excel (UTF-8, UTF-16 and Big5 when available). */
export function decodeStoresCsvBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('big5').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}
export function parseStoresCsv(content: string): {
  ok: boolean;
  stores?: Store[];
  errors?: string[];
} {
  const parsedCsv = parseCsv(content);
  if (parsedCsv.error) return { ok: false, errors: [parsedCsv.error] };
  const rows = (parsedCsv.rows ?? []).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) return { ok: false, errors: ['CSV 沒有資料列'] };

  const header = rows[0]!.map((h, index) => (index === 0 ? h.replace(/^\uFEFF/, '') : h).trim());
  const missing = STORE_HEADERS.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    return { ok: false, errors: [`CSV 欄名缺少: ${missing.join(', ')}`] };
  }
  const hasAttention = header.includes(ATTENTION_HEADER);
  const expected: string[] = hasAttention ? [...STORE_HEADERS, ATTENTION_HEADER] : [...STORE_HEADERS];
  const duplicateHeaders = header.filter((h, index) => header.indexOf(h) !== index);
  const extraHeaders = header.filter((h) => !expected.includes(h));
  if (header.length !== expected.length || duplicateHeaders.length > 0 || extraHeaders.length > 0) {
    return {
      ok: false,
      errors: [`CSV 欄名有重複或額外欄位，必須與模板一致（8 欄，或加第 9 欄「${ATTENTION_HEADER}」）`],
    };
  }

  const idx = (name: string) => header.indexOf(name);
  const stores: Store[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.length !== expected.length) {
      errors.push(`列 ${r + 1}: 欄數必須為 ${expected.length}`);
      continue;
    }
    const site = normalizeSiteCode(cells[idx('Site')]);
    const shop = (cells[idx('Shop')] ?? '').trim();
    let invalid = false;
    if (!site) {
      errors.push(`列 ${r + 1}: Site Code 為空`);
      invalid = true;
    }
    if (!shop) {
      errors.push(`列 ${r + 1}: Shop 為空`);
      invalid = true;
    }
    if (site && seen.has(site)) {
      errors.push(`列 ${r + 1}: Site Code ${site} 重複`);
      invalid = true;
    }
    if (invalid) continue;
    seen.add(site);
    stores.push({
      site_code: site,
      shop,
      regional: (cells[idx('Regional')] ?? '').trim(),
      class1: (cells[idx('Class 1')] ?? '').trim(),
      class2: (cells[idx('Class 2')] ?? '').trim(),
      size: (cells[idx('Size')] ?? '').trim(),
      om: (cells[idx('OM')] ?? '').trim(),
      type: (cells[idx('Type')] ?? '').trim(),
      attention: hasAttention ? (cells[idx(ATTENTION_HEADER)] ?? '').trim() : '',
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  if (stores.length === 0) return { ok: false, errors: ['CSV 沒有有效門店'] };
  return { ok: true, stores };
}
export interface StoreSyncResult {
  /** 今次寫入（upsert）的門店數。 */
  count: number;
  /** 資料庫本來沒有、今次新增的 Site Code。 */
  added: string[];
  /** 資料庫有、但今次檔案沒有的 Site Code（只提示，不會刪除）。 */
  removed: string[];
}

/**
 * Replaces the store master with upserts instead of delete/reinsert so that
 * submissions, portal accounts and routing settings that reference Site Codes
 * are never destroyed. Site Codes missing from the uploaded file are reported
 * back (they stay in the table, so history and logins keep working).
 */
export async function replaceStores(stores: Store[]): Promise<StoreSyncResult> {
  return withTransaction(async (client) => {
    const existing = await client.query<{ site_code: string }>('SELECT site_code FROM stores');
    const known = new Set(existing.rows.map((row) => row.site_code));
    const keep = new Set(stores.map((s) => s.site_code));
    const added = stores.map((s) => s.site_code).filter((code) => !known.has(code)).sort();
    const removed = [...known].filter((code) => !keep.has(code)).sort();
    let count = 0;
    for (const s of stores) {
      await client.query(
        `INSERT INTO stores (site_code, shop, regional, class1, class2, size, om, type, attention)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (site_code) DO UPDATE SET
           shop = EXCLUDED.shop,
           regional = EXCLUDED.regional,
           class1 = EXCLUDED.class1,
           class2 = EXCLUDED.class2,
           size = EXCLUDED.size,
           om = EXCLUDED.om,
           type = EXCLUDED.type,
           attention = EXCLUDED.attention,
           updated_at = now()`,
        [
          s.site_code,
          s.shop,
          s.regional,
          s.class1,
          s.class2,
          s.size,
          s.om,
          s.type,
          s.attention ?? '',
        ],
      );
      count++;
    }
    return { count, added, removed };
  });
}

/**
 * Reads a stores CSV and applies it to the stores table.
 * Used by the boot-time sync, the admin "重新同步內建主檔" action and the
 * `npm run seed:stores` script.
 */
export async function syncStoresFromFile(filePath: string): Promise<StoreSyncResult> {
  // 用 decodeStoresCsvBuffer 而唔係 readFile('utf8')：主檔有機會由 Excel 另存，
  // 變成 UTF-16 或 Big5，直接當 UTF-8 讀會靜靜亂碼（站名變問號）。
  const content = decodeStoresCsvBuffer(await readFile(filePath));
  const parsed = parseStoresCsv(content);
  if (!parsed.ok || !parsed.stores) {
    throw new Error(`門店主檔載入失敗: ${parsed.errors?.join('; ') ?? 'unknown'}`);
  }
  return replaceStores(parsed.stores);
}
