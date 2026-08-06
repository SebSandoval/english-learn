/**
 * Everything here works in the USER's local timezone, never the server's.
 *
 * The server runs in UTC and the cron fires on its own schedule; "did they
 * practice today?" and "are we inside their window?" only make sense in their
 * own clock. Getting this wrong would break a streak at 7pm for someone in
 * Mexico City just because UTC already rolled over.
 */

/** Local calendar date as YYYY-MM-DD. */
export function localDate(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Local wall-clock time as HH:MM, 24h. */
export function localTime(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

/** ISO-8601 weekday: 1 = Monday … 7 = Sunday. */
export function localWeekday(timeZone: string, at: Date = new Date()): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
  const index = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name);
  return index === -1 ? 1 : index + 1;
}

/** Whole days between two YYYY-MM-DD dates. Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Whether `time` falls inside [start, end], tolerating windows that wrap past
 * midnight (23:00 → 01:00).
 *
 * Times arrive from Postgres as HH:MM:SS; string comparison is safe because the
 * format is zero-padded and fixed-width.
 */
export function withinWindow(time: string, start: string, end: string): boolean {
  const t = time.slice(0, 5);
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  return s <= e ? t >= s && t <= e : t >= s || t <= e;
}

/** Validates a timezone before we store it, so a typo can't silently break scheduling. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
