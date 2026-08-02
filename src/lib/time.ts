import { config } from '../config.js';

export const HK_TIMEZONE = 'Asia/Hong_Kong';

function formatInTimeZone(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    ...options,
  }).format(date);
}

export function toHKString(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatInTimeZone(d, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/,/g, '');
}

export function toHKDateString(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatInTimeZone(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/,/g, '');
}

export function nowInHK(): Date {
  return new Date();
}

export function hkTodayForDateColumn(): string {
  return toHKDateString(new Date());
}
