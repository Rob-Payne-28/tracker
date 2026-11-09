/** Date helpers working on 'YYYY-MM-DD' strings (calendar dates, no time zone). */

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const DAY = 86_400_000;

export function parseDate(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: string, days: number): string {
  return formatDate(parseDate(d) + days * DAY);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(a) - parseDate(b)) / DAY);
}

export function weekday(d: string): number {
  return new Date(parseDate(d)).getUTCDay();
}

/** Move a date back to the most recent given weekday (or keep it if it already is). */
export function alignToWeekday(d: string, day: Weekday): string {
  const target = WEEKDAYS.indexOf(day);
  const delta = (weekday(d) - target + 7) % 7;
  return addDays(d, -delta);
}

/** Calendar date of an instant in the given IANA time zone. */
export function localDate(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidDate(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && formatDate(parseDate(d)) === d;
}
