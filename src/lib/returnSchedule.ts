export interface ReturnWindow {
  key: string;
  applicationStart: string;
  applicationEnd: string;
  buyerStart: string;
  buyerEnd: string;
  returnNoDate: string;
}

/** Full 2026 schedule shown on the public page. */
export const RETURN_SCHEDULE: readonly ReturnWindow[] = [
  {
    key: '2026-01',
    applicationStart: '2026-01-05',
    applicationEnd: '2026-01-13',
    buyerStart: '2026-01-14',
    buyerEnd: '2026-01-19',
    returnNoDate: '2026-01-20',
  },
  {
    key: '2026-02',
    applicationStart: '2026-02-02',
    applicationEnd: '2026-02-10',
    buyerStart: '2026-02-11',
    buyerEnd: '2026-02-16',
    returnNoDate: '2026-02-17',
  },
  {
    key: '2026-03',
    applicationStart: '2026-03-02',
    applicationEnd: '2026-03-10',
    buyerStart: '2026-03-11',
    buyerEnd: '2026-03-16',
    returnNoDate: '2026-03-17',
  },
  {
    key: '2026-04',
    applicationStart: '2026-04-06',
    applicationEnd: '2026-04-14',
    buyerStart: '2026-04-15',
    buyerEnd: '2026-04-20',
    returnNoDate: '2026-04-21',
  },
  {
    key: '2026-05',
    applicationStart: '2026-05-04',
    applicationEnd: '2026-05-12',
    buyerStart: '2026-05-13',
    buyerEnd: '2026-05-18',
    returnNoDate: '2026-05-19',
  },
  {
    key: '2026-06',
    applicationStart: '2026-06-08',
    applicationEnd: '2026-06-16',
    buyerStart: '2026-06-17',
    buyerEnd: '2026-06-22',
    returnNoDate: '2026-06-23',
  },
  {
    key: '2026-07',
    applicationStart: '2026-07-06',
    applicationEnd: '2026-07-14',
    buyerStart: '2026-07-15',
    buyerEnd: '2026-07-20',
    returnNoDate: '2026-07-21',
  },
  {
    key: '2026-08',
    applicationStart: '2026-08-03',
    applicationEnd: '2026-08-11',
    buyerStart: '2026-08-12',
    buyerEnd: '2026-08-17',
    returnNoDate: '2026-08-18',
  },
  {
    key: '2026-09',
    applicationStart: '2026-09-07',
    applicationEnd: '2026-09-15',
    buyerStart: '2026-09-16',
    buyerEnd: '2026-09-21',
    returnNoDate: '2026-09-22',
  },
  {
    key: '2026-10',
    applicationStart: '2026-10-05',
    applicationEnd: '2026-10-13',
    buyerStart: '2026-10-14',
    buyerEnd: '2026-10-19',
    returnNoDate: '2026-10-20',
  },
  {
    key: '2026-11',
    applicationStart: '2026-11-02',
    applicationEnd: '2026-11-10',
    buyerStart: '2026-11-11',
    buyerEnd: '2026-11-16',
    returnNoDate: '2026-11-17',
  },
  {
    key: '2026-12',
    applicationStart: '2026-12-07',
    applicationEnd: '2026-12-15',
    buyerStart: '2026-12-16',
    buyerEnd: '2026-12-21',
    returnNoDate: '2026-12-22',
  },
] as const;

/** Application windows still enforceable from August 2026 onward. */
export const RETURN_WINDOWS: readonly ReturnWindow[] = RETURN_SCHEDULE.slice(7);

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
