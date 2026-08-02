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

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // skip
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parses a stores CSV. Expects header: Site,Shop,Regional,Class 1,Class 2,Size,OM,Type.
 * Returns { ok, stores?, errors? }. Validates Site Code uniqueness.
 */
export function parseStoresCsv(content: string): {
  ok: boolean;
  stores?: Store[];
  errors?: string[];
} {
  const rows = parseCsv(content).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) return { ok: false, errors: ['CSV 沒有資料列'] };

  const header = rows[0]!.map((h) => h.trim());
  const expected = ['Site', 'Shop', 'Regional', 'Class 1', 'Class 2', 'Size', 'OM', 'Type'];
  const missing = expected.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    return { ok: false, errors: [`CSV 欄名缺少: ${missing.join(', ')}`] };
  }

  const idx = (name: string) => header.indexOf(name);
  const stores: Store[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const site = normalizeSiteCode(cells[idx('Site')]);
    if (!site) {
      errors.push(`列 ${r + 1}: Site Code 為空`);
      continue;
    }
    if (seen.has(site)) {
      errors.push(`列 ${r + 1}: Site Code ${site} 重複`);
      continue;
    }
    seen.add(site);
    stores.push({
      site_code: site,
      shop: (cells[idx('Shop')] ?? '').trim(),
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
