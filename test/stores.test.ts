import { describe, expect, it } from 'vitest';
import { parseStoresCsv, normalizeSiteCode, decodeStoresCsvBuffer } from '../src/services/stores.js';

describe('parseStoresCsv', () => {
  const valid = [
    'Site,Shop,Regional,Class 1,Class 2,Size,OM,Type',
    'HA02,駱克,HK,B,B2,S,Ivy,T',
    'ha06,北角,HK,B,B2,M,Ivy,M',
  ].join('\n');

  it('parses valid CSV and normalizes site codes', () => {
    const result = parseStoresCsv(valid);
    expect(result.ok).toBe(true);
    expect(result.stores).toHaveLength(2);
    expect(result.stores![0].site_code).toBe('HA02');
    expect(result.stores![1].site_code).toBe('HA06');
  });

  it('rejects missing headers', () => {
    const result = parseStoresCsv('Site,Shop\nHA02,駱克');
    expect(result.ok).toBe(false);
    expect(result.errors?.join()).toContain('欄名缺少');
  });

  it('rejects duplicate site codes', () => {
    const dup = valid.replace('ha06', 'HA02');
    const result = parseStoresCsv(dup);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain('重複');
  });

  it('rejects empty site code', () => {
    const bad = 'Site,Shop,Regional,Class 1,Class 2,Size,OM,Type\n,駱克,HK,B,B2,S,Ivy,T';
    const result = parseStoresCsv(bad);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain('Site Code 為空');
  });

  it('rejects empty shop', () => {
    const bad = 'Site,Shop,Regional,Class 1,Class 2,Size,OM,Type\nHA02,,HK,B,B2,S,Ivy,T';
    const result = parseStoresCsv(bad);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((error) => error.includes('Shop 為空'))).toBe(true);
  });

  it('rejects extra or duplicate headers and wrong data column counts', () => {
    const extraHeader = parseStoresCsv('Site,Shop,Regional,Class 1,Class 2,Size,OM,Type,Extra\nHA02,駱克,HK,B,B2,S,Ivy,T,ignored');
    expect(extraHeader.ok).toBe(false);
    expect(extraHeader.errors?.[0]).toContain('額外');

    const duplicateHeader = parseStoresCsv('Site,Shop,Regional,Class 1,Class 2,Size,OM,Type,OM\nHA02,駱克,HK,B,B2,S,Ivy,T,extra');
    expect(duplicateHeader.ok).toBe(false);
    expect(duplicateHeader.errors?.[0]).toContain('重複');

    const wrongRow = parseStoresCsv('Site,Shop,Regional,Class 1,Class 2,Size,OM,Type\nHA02,駱克,HK,B,B2,S,Ivy');
    expect(wrongRow.ok).toBe(false);
    expect(wrongRow.errors?.[0]).toContain('欄數');
  });

  it('rejects malformed and unclosed quoted fields', () => {
    const unclosed = parseStoresCsv('Site,Shop,Regional,Class 1,Class 2,Size,OM,Type\n"HA02,駱克,HK,B,B2,S,Ivy,T');
    expect(unclosed.ok).toBe(false);
    expect(unclosed.errors?.[0]).toContain('引號未關閉');

    const malformed = parseStoresCsv('Site,Shop,Regional,Class 1,Class 2,Size,OM,Type\n"HA02"extra,駱克,HK,B,B2,S,Ivy,T');
    expect(malformed.ok).toBe(false);
    expect(malformed.errors?.[0]).toContain('額外內容');
  });
});

describe('decodeStoresCsvBuffer', () => {
  it('decodes UTF-16 CSV exported by Excel', () => {
    const source = 'Site,Shop,Regional,Class 1,Class 2,Size,OM,Type\nHA02,駱克,HK,B,B2,S,Ivy,T';
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]);
    expect(parseStoresCsv(decodeStoresCsvBuffer(buffer)).ok).toBe(true);
  });
});
describe('normalizeSiteCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeSiteCode('  ha02 ')).toBe('HA02');
    expect(normalizeSiteCode('')).toBe('');
  });
});
