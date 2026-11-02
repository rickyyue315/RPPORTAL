import { describe, expect, it } from 'vitest';
import { isPublicWriteSuspended } from '../src/middleware/publicWriteSuspension.js';

const settings = {
  enabled: true,
  suspendAt: '2026-08-11T23:59:59+08:00',
} as const;

describe('public write suspension', () => {
  it('stays open immediately before the independent cutoff', () => {
    expect(isPublicWriteSuspended(new Date('2026-08-11T23:59:58+08:00'), settings)).toBe(false);
  });

  it('blocks exactly at the independent cutoff', () => {
    expect(isPublicWriteSuspended(new Date('2026-08-11T23:59:59+08:00'), settings)).toBe(true);
  });

  it('continues blocking after the cutoff', () => {
    expect(isPublicWriteSuspended(new Date('2026-08-12T00:00:01+08:00'), settings)).toBe(true);
  });

  it('can be reopened without changing the cutoff', () => {
    expect(isPublicWriteSuspended(new Date('2026-08-12T00:00:01+08:00'), { ...settings, enabled: false })).toBe(false);
  });
});
