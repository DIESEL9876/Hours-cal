/**
 * Fast keyboard time entry: '8' → 08:00, '830' → 08:30, '0830' → 08:30, '8:5' → 08:05, '17.30' → 17:30.
 * '17.5' is rejected as ambiguous.
 * Returns null for invalid input and '' for empty input.
 */
import { addDays, parseTime, type LocalDate, type LocalDateTime } from '../engine';

export function normalizeTimeInput(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return '';
  let h: number;
  let m: number;
  const sep = /^(\d{1,2})[:.,;](\d{1,2})$/.exec(s);
  if (sep) {
    h = +sep[1];
    // ':' keeps minutes literal ('8:5' = 08:05). '17.5' is ambiguous (17:30 decimal? 17:50?) → rejected.
    if (!s.includes(':') && sep[2].length === 1) return null;
    m = +sep[2];
  } else if (/^\d{1,4}$/.test(s)) {
    if (s.length <= 2) {
      h = +s;
      m = 0;
    } else if (s.length === 3) {
      h = +s.slice(0, 1);
      m = +s.slice(1);
    } else {
      h = +s.slice(0, 2);
      m = +s.slice(2);
    }
  } else return null;
  if (h === 24 && m === 0) h = 0;
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Builds full timestamps from a row date + entry/exit times. Exit <= entry ⇒ next day (overnight). */
export function buildTimestamps(
  date: LocalDate,
  start: string,
  end: string,
): { startAt: LocalDateTime | null; endAt: LocalDateTime | null; overnight: boolean; error: string | null } {
  const startAt = start ? `${date}T${start}` : null;
  if (!end) return { startAt, endAt: null, overnight: false, error: null };
  if (!start) return { startAt: null, endAt: `${date}T${end}`, overnight: false, error: null };
  if (start === end) return { startAt, endAt: null, overnight: false, error: 'שעת היציאה זהה לשעת הכניסה' };
  const overnight = parseTime(end)! < parseTime(start)!;
  return { startAt, endAt: `${overnight ? addDays(date, 1) : date}T${end}`, overnight, error: null };
}

/** Parse a break entry in minutes ('30', '0:45', '1:00'). '' → null (use policy). */
export function parseBreakInput(raw: string): number | null | 'invalid' {
  const s = raw.trim();
  if (s === '') return null;
  if (/^\d{1,3}$/.test(s)) return +s;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m && +m[2] < 60) return +m[1] * 60 + +m[2];
  return 'invalid';
}
