import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Compares the shared public recovery code without leaking its length or
 * contents through a normal string comparison.
 */
export function isValidPublicRecoveryCode(value: string | null | undefined): boolean {
  if (!config.publicRecoveryCode || typeof value !== 'string') return false;
  const expected = Buffer.from(config.publicRecoveryCode, 'utf8');
  const actual = Buffer.from(value.trim(), 'utf8');
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
}
