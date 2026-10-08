/**
 * Exact, integer-minute date/time utilities for Asia/Jerusalem.
 *
 * Wall-clock times are converted to UTC instants so that shift durations are correct across
 * daylight-saving transitions (e.g. an overnight shift on the night clocks go back is 1 hour longer).
 */
import type { LocalDate, LocalDateTime, LocalTime, Weekday } from './types';

export const TZ = 'Asia/Jerusalem';
export const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface DateParts {
  y: number;
  m: number; // 1-12
  d: number;
}

export function parseDate(s: LocalDate): DateParts {
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`Invalid date: ${s}`);
  const p = { y: +m[1], m: +m[2], d: +m[3] };
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > daysInMonth(p.y, p.m)) throw new Error(`Invalid date: ${s}`);
  return p;
}

export function isValidDate(s: string): boolean {
  try {
    parseDate(s);
    return true;
  } catch {
    return false;
  }
}

/** Parse 'HH:mm' to minutes since midnight. Returns null if invalid. Accepts 00:00–23:59. */
export function parseTime(s: LocalTime): number | null {
  const m = TIME_RE.exec(s);
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function parseDateTime(s: LocalDateTime): { date: LocalDate; minutes: number } {
  const m = DATETIME_RE.exec(s);
  if (!m) throw new Error(`Invalid date-time: ${s}`);
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  parseDate(date);
  const minutes = parseTime(`${m[4]}:${m[5]}`);
  if (minutes === null) throw new Error(`Invalid date-time: ${s}`);
  return { date, minutes };
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatDate(p: DateParts): LocalDate {
  return `${String(p.y).padStart(4, '0')}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** Day number since epoch for pure calendar arithmetic (no time zone involved). */
function dayNumber(s: LocalDate): number {
  const p = parseDate(s);
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000);
}

function fromDayNumber(n: number): LocalDate {
  const dt = new Date(n * 86_400_000);
  return formatDate({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}

export function addDays(s: LocalDate, days: number): LocalDate {
  return fromDayNumber(dayNumber(s) + days);
}

export function diffDays(a: LocalDate, b: LocalDate): number {
  return dayNumber(a) - dayNumber(b);
}

export function weekdayOf(s: LocalDate): Weekday {
  const p = parseDate(s);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() as Weekday;
}

/** Sunday of the Israeli workweek containing the date. */
export function weekStartOf(s: LocalDate): LocalDate {
  return addDays(s, -weekdayOf(s));
}

export function eachDate(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthRange(year: number, month: number): { from: LocalDate; to: LocalDate } {
  return {
    from: formatDate({ y: year, m: month, d: 1 }),
    to: formatDate({ y: year, m: month, d: daysInMonth(year, month) }),
  };
}

export function toDateTime(date: LocalDate, minutes: number): LocalDateTime {
  return `${date}T${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

// ---------------------------------------------------------------------------
// Time-zone conversion
// ---------------------------------------------------------------------------

let dtf: Intl.DateTimeFormat | null = null;
function formatter(): Intl.DateTimeFormat {
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  return dtf;
}

const offsetCache = new Map<number, number>();

/**
 * UTC offset (ms) of Asia/Jerusalem at the given instant.
 * Israeli transitions happen on whole UTC hours, so caching per UTC hour is exact.
 */
export function offsetAt(utcMs: number): number {
  const hourKey = Math.floor(utcMs / HOUR_MS);
  const cached = offsetCache.get(hourKey);
  if (cached !== undefined) return cached;
  const probe = hourKey * HOUR_MS;
  const parts = formatter().formatToParts(new Date(probe));
  const get = (t: string) => +(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const off = asUtc - probe;
  offsetCache.set(hourKey, off);
  return off;
}

export interface ZonedResult {
  /** UTC milliseconds; null when the wall-clock time does not exist (spring-forward gap). */
  utcMs: number | null;
  /** True when the wall-clock time occurs twice (fall-back overlap). The EARLIER instant is returned. */
  ambiguous: boolean;
  nonexistent: boolean;
}

export function localToUtc(dateTime: LocalDateTime): ZonedResult {
  const { date, minutes } = parseDateTime(dateTime);
  const p = parseDate(date);
  const naive = Date.UTC(p.y, p.m - 1, p.d, Math.floor(minutes / 60), minutes % 60);
  const candidates = new Set([offsetAt(naive - 12 * HOUR_MS), offsetAt(naive + 12 * HOUR_MS), offsetAt(naive)]);
  const valid: number[] = [];
  for (const off of candidates) {
    const t = naive - off;
    if (offsetAt(t) === off) valid.push(t);
  }
  valid.sort((a, b) => a - b);
  if (valid.length === 0) return { utcMs: null, ambiguous: false, nonexistent: true };
  return { utcMs: valid[0], ambiguous: valid.length > 1, nonexistent: false };
}

export interface LocalParts {
  date: LocalDate;
  /** Minutes since local midnight. */
  minuteOfDay: number;
  weekday: Weekday;
}

export function utcToLocal(utcMs: number): LocalParts {
  const local = new Date(utcMs + offsetAt(utcMs));
  const date = formatDate({ y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() });
  return {
    date,
    minuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
    weekday: local.getUTCDay() as Weekday,
  };
}

export function utcToLocalDateTime(utcMs: number): LocalDateTime {
  const l = utcToLocal(utcMs);
  return toDateTime(l.date, l.minuteOfDay);
}

/** Start of the local civil day (00:00) as UTC ms. Midnight always exists in Israel (transitions are at 02:00). */
export function localMidnightUtc(date: LocalDate): number {
  const r = localToUtc(`${date}T00:00`);
  if (r.utcMs === null) throw new Error(`Midnight does not exist on ${date}`);
  return r.utcMs;
}

export const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
export const ceilToMinute = (ms: number) => Math.ceil(ms / MINUTE_MS) * MINUTE_MS;

// ---------------------------------------------------------------------------
// Formatting (presentation helpers, never used for calculation)
// ---------------------------------------------------------------------------

/** 570 → '9:30'; negative values are never expected. */
export function formatHM(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}:${pad2(abs % 60)}`;
}

/** Decimal hours with 2 decimals for export only. Computed from integer minutes at the last step. */
export function formatDecimalHours(minutes: number): string {
  // Round half away from zero to 2 decimals using integer arithmetic.
  const hundredths = Math.round((minutes * 100) / 60);
  const sign = hundredths < 0 ? '-' : '';
  const abs = Math.abs(hundredths);
  return `${sign}${Math.floor(abs / 100)}.${pad2(abs % 100)}`;
}

function hoursHe(h: number): string {
  if (h === 1) return 'שעה';
  if (h === 2) return 'שעתיים';
  return `${h} שעות`;
}

function minutesHe(m: number): string {
  if (m === 1) return 'דקה אחת';
  return `${m} דקות`;
}

/** Hebrew prose duration: 570 → '9 שעות ו-30 דקות', 120 → 'שעתיים', 54 → '54 דקות'. */
export function formatDurationHe(total: number): string {
  if (total === 0) return '0 דקות';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return minutesHe(m);
  if (m === 0) return hoursHe(h);
  return `${hoursHe(h)} ו-${minutesHe(m)}`;
}

export const HEBREW_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] as const;
export const HEBREW_WEEKDAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'] as const;
export const HEBREW_MONTHS = [
  'ינואר',
  'פברואר',
  'מרץ',
  'אפריל',
  'מאי',
  'יוני',
  'יולי',
  'אוגוסט',
  'ספטמבר',
  'אוקטובר',
  'נובמבר',
  'דצמבר',
] as const;
