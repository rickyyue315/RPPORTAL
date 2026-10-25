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

/**
 * date-only（YYYY-MM-DD）減 n 個月，回傳 date-only。
 * 日超出目標月天數時夾到月末（2026-03-31 減 1 個月 → 2026-02-28），
 * 與前端 admin-stock.js 的 monthsBefore 行為一致；格式不合法回空字串。
 */
export function monthsBeforeDateOnly(dateOnly: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOnly ?? '').trim());
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]) - 1 - months;
  const day = Number(m[3]);
  const target = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(target.getUTCDate()).padStart(2, '0');
  return `${target.getUTCFullYear()}-${mm}-${dd}`;
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
