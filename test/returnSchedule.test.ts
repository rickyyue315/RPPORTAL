import { describe, expect, it } from 'vitest';
import { getActiveReturnWindow, isReturnModificationOpen, RETURN_SCHEDULE, RETURN_WINDOWS } from '../src/lib/returnSchedule.js';

describe('return-goods schedule', () => {
  it('shows the full 2026 table but only enforces August to December windows', () => {
    expect(RETURN_SCHEDULE).toHaveLength(12);
    expect(RETURN_WINDOWS).toHaveLength(5);
    expect(getActiveReturnWindow('2026-07-10')).toBeNull();
    expect(getActiveReturnWindow('2026-08-03')?.key).toBe('2026-08');
    expect(getActiveReturnWindow('2026-08-11')?.key).toBe('2026-08');
    expect(getActiveReturnWindow('2026-08-12')).toBeNull();
  });

  it('uses the original application window for modification checks', () => {
    expect(isReturnModificationOpen('2026-08', '2026-08-03')).toBe(true);
    expect(isReturnModificationOpen('2026-08', '2026-08-11')).toBe(true);
    expect(isReturnModificationOpen('2026-08', '2026-08-12')).toBe(false);
    expect(isReturnModificationOpen('2026-07', '2026-07-10')).toBe(false);
  });
});
