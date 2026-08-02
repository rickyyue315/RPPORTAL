import { describe, expect, it } from 'vitest';
import { parseStoresCsv, normalizeSiteCode } from '../src/services/stores.js';

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
});

describe('normalizeSiteCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeSiteCode('  ha02 ')).toBe('HA02');
    expect(normalizeSiteCode('')).toBe('');
  });
});
