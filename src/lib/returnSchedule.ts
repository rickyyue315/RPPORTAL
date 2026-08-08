import { readFileSync } from 'node:fs';
import { config } from '../config.js';

export interface ReturnWindow {
  key: string;
  applicationStart: string;
  applicationEnd: string;
  buyerStart: string;
  buyerEnd: string;
  returnNoDate: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value;
}

function loadSchedule(): readonly ReturnWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(config.returnSchedulePath, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`Return schedule cannot be loaded from ${config.returnSchedulePath}: ${String(err)}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Return schedule must contain at least one window');
  }

  const keys = new Set<string>();
  const schedule: ReturnWindow[] = [];
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== 'object') {
      throw new Error(`Return schedule row ${index + 1} is invalid`);
    }
    const candidate = item as Partial<ReturnWindow>;
    const values = [
      candidate.key,
      candidate.applicationStart,
      candidate.applicationEnd,
      candidate.buyerStart,
      candidate.buyerEnd,
      candidate.returnNoDate,
    ];
    if (values.some((value) => typeof value !== 'string' || !value)) {
      throw new Error(`Return schedule row ${index + 1} has missing fields`);
    }
    const window = candidate as ReturnWindow;
    if (keys.has(window.key)) throw new Error(`Return schedule key is duplicated: ${window.key}`);
    keys.add(window.key);
    if (![window.applicationStart, window.applicationEnd, window.buyerStart, window.buyerEnd, window.returnNoDate].every(isRealIsoDate)) {
      throw new Error(`Return schedule row ${index + 1} contains an invalid date`);
    }
    if (!(window.applicationStart <= window.applicationEnd
      && window.applicationEnd < window.buyerStart
      && window.buyerStart <= window.buyerEnd
      && window.buyerEnd < window.returnNoDate)) {
      throw new Error(`Return schedule row ${index + 1} has dates in the wrong order`);
    }
    schedule.push(window);
  }
  return schedule;
}

/** Full configured schedule shown on the public page. */
export const RETURN_SCHEDULE = loadSchedule();

if (!isRealIsoDate(config.returnEnforcementStart)) {
  throw new Error(`RETURN_ENFORCEMENT_START is not a valid date: ${config.returnEnforcementStart}`);
}

/** Windows currently enforceable by the application. */
export const RETURN_WINDOWS: readonly ReturnWindow[] = RETURN_SCHEDULE.filter(
  (window) => window.applicationEnd >= config.returnEnforcementStart,
);

const currentYear = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
}).format(new Date());
if (!RETURN_SCHEDULE.some((window) => window.key.startsWith(`${currentYear}-`))) {
  throw new Error(`Return schedule has no configured window for current year ${currentYear}`);
}

export function getReturnWindowByKey(key: string | null | undefined): ReturnWindow | null {
  return RETURN_WINDOWS.find((window) => window.key === key) ?? null;
}

export function getActiveReturnWindow(date: string): ReturnWindow | null {
  return RETURN_WINDOWS.find(
    (window) => date >= window.applicationStart && date <= window.applicationEnd,
  ) ?? null;
}

export function isReturnModificationOpen(windowKey: string | null | undefined, date: string): boolean {
  const window = getReturnWindowByKey(windowKey);
  return Boolean(window && date >= window.applicationStart && date <= window.applicationEnd);
}

export function formatReturnScheduleDate(value: string): string {
  const [, month, day] = value.split('-');
  return `${Number(month)}月${Number(day)}日`;
}
