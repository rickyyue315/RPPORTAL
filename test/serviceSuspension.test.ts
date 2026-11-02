import { describe, expect, it } from 'vitest';
import { isPublicWriteSuspended, isPublicWriteSuspendedFor } from '../src/middleware/publicWriteSuspension.js';

const settings = {
  enabled: true,
  suspendAt: '2026-08-11T23:59:59+08:00',
  returnReopened: false,
} as const;

/** 平台暫停生效之後、但仍在 2026-11 退行貨申請期內。 */
const afterCutoff = new Date('2026-11-02T10:00:00+08:00');

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

  it('keeps other public writes paused when only 行貨退貨 is reopened', () => {
    expect(isPublicWriteSuspendedFor('default', afterCutoff, { ...settings, returnReopened: true })).toBe(true);
  });

  it('lets 行貨退貨 through after the platform cutoff once reopened', () => {
    expect(isPublicWriteSuspendedFor('return', afterCutoff, { ...settings, returnReopened: true })).toBe(false);
  });

  it('still blocks 行貨退貨 when the reopening switch is off', () => {
    expect(isPublicWriteSuspendedFor('return', afterCutoff, settings)).toBe(true);
  });

  it('never blocks 行貨退貨 when the whole platform is open', () => {
    expect(isPublicWriteSuspendedFor('return', afterCutoff, { ...settings, enabled: false })).toBe(false);
  });
});
