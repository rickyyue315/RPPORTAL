import { config } from '../config.js';

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

export function hkTodayForDateColumn(): string {
  return toHKDateString(new Date());
}

function hkHourMinute(date: Date): { hour: number; minute: number } {
  const s = formatInTimeZone(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const [hour = 0, minute = 0] = s.split(':').map((v) => Number(v) || 0);
  return { hour, minute };
}

/** Minutes since midnight in the configured timezone (default Asia/Hong_Kong). */
export function hkMinutesNow(date: Date = new Date()): number {
  const { hour, minute } = hkHourMinute(date);
  return hour * 60 + minute;
}

/** "HH:MM" in the configured timezone (default Asia/Hong_Kong). */
export function hkHM(date: Date = new Date()): string {
  const { hour, minute } = hkHourMinute(date);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
