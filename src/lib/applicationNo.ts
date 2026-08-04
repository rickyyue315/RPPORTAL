import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Encodes `bytes` into base32 (5 bits per char) with the given output length.
 */
function encode(bytes: Buffer): string {
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  let encoded = '';
  const radix = BigInt(ALPHABET.length);
  while (value > 0n) {
    encoded = ALPHABET[Number(value % radix)] + encoded;
    value = value / radix;
  }
  // 5 bytes -> 40 bits -> exactly 8 base32 chars.
  return encoded.padStart(8, ALPHABET[0]);
}

/**
 * Generates an unguessable application number.
 * Format: <PREFIX>-XXXXXXXX-XXXXXXXX (8+8 base32 chars from 10 random bytes -> 80 bits).
 * Default prefix is NDRF (Page 1); Urgent orders use URGENT and sales reports use SALES.
 */
export function generateApplicationNo(prefix = 'NDRF'): string {
  const bytes = randomBytes(10);
  const first = encode(bytes.subarray(0, 5));
  const second = encode(bytes.subarray(5, 10));
  return `${prefix}-${first}-${second}`;
}
