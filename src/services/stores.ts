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

/**
 * Parses a stores CSV. Expects header: Site,Shop,Regional,Class 1,Class 2,Size,OM,Type.
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

  const expected = ['Site', 'Shop', 'Regional', 'Class 1', 'Class 2', 'Size', 'OM', 'Type'];
  const header = rows[0]!.map((h, index) => (index === 0 ? h.replace(/^\uFEFF/, '') : h).trim());
  const missing = expected.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    return { ok: false, errors: [`CSV 欄名缺少: ${missing.join(', ')}`] };
  }
  const duplicateHeaders = header.filter((h, index) => header.indexOf(h) !== index);
  const extraHeaders = header.filter((h) => !expected.includes(h));
  if (header.length !== expected.length || duplicateHeaders.length > 0 || extraHeaders.length > 0) {
    return { ok: false, errors: ['CSV 欄名有重複或額外欄位，必須與模板完全一致'] };
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
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  if (stores.length === 0) return { ok: false, errors: ['CSV 沒有有效門店'] };
  return { ok: true, stores };
}
export async function replaceStores(stores: Store[]): Promise<number> {
  return withTransaction(async (client) => {
    await client.query('DELETE FROM stores');
    let count = 0;
    for (const s of stores) {
      await client.query(
        `INSERT INTO stores (site_code, shop, regional, class1, class2, size, om, type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.site_code, s.shop, s.regional, s.class1, s.class2, s.size, s.om, s.type],
      );
      count++;
    }
    return count;
  });
}

export async function seedStoresFromFile(filePath: string): Promise<number> {
  const content = await readFile(filePath, 'utf8');
  const parsed = parseStoresCsv(content);
  if (!parsed.ok || !parsed.stores) {
    throw new Error(`門店主檔載入失敗: ${parsed.errors?.join('; ') ?? 'unknown'}`);
  }
  return replaceStores(parsed.stores);
}
