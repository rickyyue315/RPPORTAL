import { config } from '../config.js';

export function ipExpiryIso(): string {
  return new Date(Date.now() + config.ipRetentionDays * 24 * 3600 * 1000).toISOString();
}
