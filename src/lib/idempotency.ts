import { createHash } from 'node:crypto';
import type { Request } from 'express';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function getIdempotencyKey(req: Request): string | undefined {
  const raw = req.get('Idempotency-Key')?.trim();
  if (!raw) return undefined;
  return IDEMPOTENCY_KEY_PATTERN.test(raw) ? raw : undefined;
}

export function hasInvalidIdempotencyKey(req: Request): boolean {
  const raw = req.get('Idempotency-Key')?.trim();
  return Boolean(raw && !IDEMPOTENCY_KEY_PATTERN.test(raw));
}

export function fingerprintPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}