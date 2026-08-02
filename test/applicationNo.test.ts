import { describe, expect, it } from 'vitest';
import { generateApplicationNo } from '../src/lib/applicationNo.js';

describe('generateApplicationNo', () => {
  it('generates NDRF- prefixed application numbers', () => {
    const no = generateApplicationNo();
    expect(no).toMatch(/^NDRF-[A-Z2-9]{8}-[A-Z2-9]{8}$/);
  });

  it('generates unique numbers', () => {
    const set = new Set(Array.from({ length: 1000 }, () => generateApplicationNo()));
    expect(set.size).toBe(1000);
  });
});
