/**
 * Value parsing for imported attendance reports: dates, clock times, durations, weekday names and
 * header (column-name) recognition. Pure functions — nothing here guesses a missing value.
 */
import { isValidDate, type LocalDate } from '../engine';
import type { Cell, Role } from './types';

// ---------------------------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------------------------

/** Bidi/formatting marks that PDF extractors and spreadsheets sometimes embed. */
const BIDI = /[‎‏‪-‮⁦-⁩﻿]/g;

export function cleanText(s: string): string {
  return s.replace(BIDI, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Header key: lower-case, no whitespace, no quotes/punctuation (keeps letters and digits). */
export function headerKey(s: string): string {
  return cleanText(s)
    .toLowerCase()
    .replace(/[\s"'`׳״.,:;\-_/\\()[\]{}|*#+]/g, '');
}

// ---------------------------------------------------------------------------------------------
// Header recognition
// ---------------------------------------------------------------------------------------------

const EXACT: Record<Role, string[]> = {
  date: ['תאריך', 'תאריךעבודה', 'תאריךיום', 'תאריךכניסה', 'date', 'workdate', 'daydate', 'datum'],
  exitDate: ['תאריךיציאה', 'enddate', 'outdate', 'dateout', 'clockoutdate', 'exitdate'],
  weekday: ['יום', 'יוםבשבוע', 'day', 'weekday', 'dayofweek', 'dow'],
  in: ['כניסה', 'שעתכניסה', 'התחלה', 'שעתהתחלה', 'כניסהלעבודה', 'clockin', 'in', 'start', 'starttime', 'timein', 'checkin', 'punchin', 'entry', 'entrance', 'begin'],
  out: ['יציאה', 'שעתיציאה', 'סיום', 'שעתסיום', 'יציאהמהעבודה', 'clockout', 'out', 'end', 'endtime', 'timeout', 'checkout', 'punchout', 'exit', 'finish'],
  breakOut: ['יציאהלהפסקה', 'תחילתהפסקה', 'התחלתהפסקה', 'breakstart', 'breakout', 'startbreak'],
  breakIn: ['חזרהמהפסקה', 'סיוםהפסקה', 'כניסהמהפסקה', 'breakend', 'breakin', 'endbreak'],
  break: ['הפסקה', 'הפסקות', 'משךהפסקה', 'סהכהפסקה', 'סהכהפסקות', 'הפסקהמדווחת', 'סהכהפסקהמדווחת', 'הפסקהבדקות', 'break', 'breaks', 'breakduration', 'breakminutes', 'breaktime', 'unpaidbreak', 'lunch', 'lunchbreak'],
  total: ['סהכ', 'סהכשעות', 'שעותבפועל', 'שעותעבודה', 'שעות', 'סהכשעותעבודה', 'שעותנטו', 'total', 'totalhours', 'hours', 'workedhours', 'hoursworked', 'nethours', 'totaltime', 'worktime'],
  employee: ['שםעובד', 'שםהעובד', 'עובד', 'שם', 'employee', 'employeename', 'name', 'worker', 'fullname'],
  employeeNo: ['מספרעובד', 'מסעובד', 'מסהעובד', 'מספרהעובד', 'employeeid', 'employeenumber', 'empid', 'empno', 'employeeno', 'badge'],
};

/** "Contains" rules, most specific first. English ones need whole multi-letter phrases. */
const CONTAINS: [Role, string[]][] = [
  ['breakOut', ['יציאהלהפסקה', 'תחילתהפסקה', 'breakstart', 'breakout']],
  ['breakIn', ['חזרהמהפסקה', 'סיוםהפסקה', 'breakend', 'breakin']],
  ['break', ['הפסקה', 'הפסקות', 'break']],
  ['exitDate', ['תאריךיציאה', 'dateout', 'outdate', 'enddate']],
  ['employeeNo', ['מספרעובד', 'מסעובד', 'employeeid', 'employeenumber']],
  ['employee', ['שםעובד', 'שםהעובד', 'employeename']],
  ['in', ['כניסה', 'שעתהתחלה', 'clockin', 'timein', 'checkin', 'punchin', 'starttime']],
  ['out', ['יציאה', 'שעתסיום', 'clockout', 'timeout', 'checkout', 'punchout', 'endtime']],
  ['date', ['תאריך', 'date']],
];

/** Header words that look like a role but are not (e.g. standard/target hours, cumulative). */
const NOT_A_ROLE = ['מצטבר', 'תקן', 'בחוסר', 'עודפות', 'חריגים', 'הדפסה', 'cumulative', 'standard', 'expected', 'balance', 'overtime', 'נוספות'];

export interface HeaderMatch {
  role: Role;
  /** 3 = exact synonym, 1 = contains a synonym. */
  score: number;
  /** Sequence number in headers like "1 כניסה" / "Clock In 2". */
  index: number | null;
}

/** Recognise one column header. Tries the text as given and reversed (visual-order PDFs). */
export function matchHeader(raw: string): HeaderMatch | null {
  const k = headerKey(raw);
  if (!k) return null;
  const candidates = [k, [...k].reverse().join('')];
  let best: HeaderMatch | null = null;
  for (const c of candidates) {
    const digits = c.match(/\d+/);
    const index = digits ? Number(digits[0]) : null;
    const base = c.replace(/\d+/g, '');
    if (!base) continue;
    if (NOT_A_ROLE.some((w) => base.includes(w))) continue;
    for (const role of Object.keys(EXACT) as Role[]) {
      if (EXACT[role].includes(base)) {
        const m = { role, score: 3, index };
        if (!best || m.score > best.score) best = m;
      }
    }
    if (best?.score === 3) return best;
    for (const [role, words] of CONTAINS) {
      if (words.some((w) => base.includes(w))) {
        // "תאריך כניסה" is the work date; "שעת כניסה ... תאריך" is unusual — keep date only when the base starts with it.
        if (role === 'in' && base.startsWith('תאריך')) continue;
        if (role === 'date' && (base.includes('יציאה') || base.includes('הפקה'))) continue;
        const m = { role, score: 1, index };
        if (!best) best = m;
        break;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

export function ymd(y: number, m: number, d: number): LocalDate | null {
  const s = `${y}-${pad(m)}-${pad(d)}`;
  return isValidDate(s) ? s : null;
}

/** Excel serial (1900 system) → date + minutes. */
export function serialToParts(serial: number): { date: LocalDate; minutes: number } | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null;
  let days = Math.floor(serial);
  let minutes = Math.round((serial - days) * 1440);
  if (minutes === 1440) {
    days += 1;
    minutes = 0;
  }
  const ms = Date.UTC(1899, 11, 30) + days * 86400000;
  const d = new Date(ms);
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, minutes };
}

export type DateOrder = 'dmy' | 'mdy';

const DATE_NUMERIC = /^(\d{1,4})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?$/;

/** Splits a date-like string into its numeric parts (or null). Ignores a trailing time part. */
function dateParts(s: string): [number, number, number | null] | null {
  const t = cleanText(s).replace(/^\*+|\*+$/g, '').split(/[ T]/)[0];
  const m = DATE_NUMERIC.exec(t);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])];
}

/** Decides day/month order for a column from all its values (any value >12 settles it). */
export function inferDateOrder(values: string[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const p = dateParts(v);
    if (!p || p[0] > 31) continue; // ISO yyyy-mm-dd is unambiguous
    if (p[0] > 12 && p[1] <= 12) dmy++;
    else if (p[1] > 12 && p[0] <= 12) mdy++;
  }
  return mdy > dmy ? 'mdy' : 'dmy';
}

/**
 * Parses a date cell. Israeli default is day-first. Two-digit years → 20xx.
 * `fallbackYear` is used only for day/month values printed without a year.
 */
export function parseDateCell(cell: Cell, order: DateOrder = 'dmy', fallbackYear: number | null = null): LocalDate | null {
  if (cell.serial !== undefined && cell.isDateLike && cell.serial >= 1) return serialToParts(cell.serial)?.date ?? null;
  const t = cleanText(cell.text);
  if (!t) return null;
  const p = dateParts(t);
  if (!p) return null;
  let [a, b, c] = p;
  if (a > 31) return c === null ? null : ymd(a, b, c); // yyyy-mm-dd
  let year = c;
  if (year === null) {
    if (fallbackYear === null) return null;
    year = fallbackYear;
  } else if (year < 100) year += 2000;
  if (order === 'mdy') [a, b] = [b, a];
  return ymd(year, b, a);
}

// ---------------------------------------------------------------------------------------------
// Clock times
// ---------------------------------------------------------------------------------------------

export interface TimeValue {
  /** 'HH:MM' */
  time: string;
  /** Date carried by the same cell (full date+time cells). */
  date: LocalDate | null;
  /** Reasons this value needs a human look (Hebrew). */
  flags: string[];
  /** A marker such as '*' printed next to the time in the source. */
  marked: boolean;
}

const hm = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/**
 * Parses an entrance/exit cell. Accepts HH:MM, H:MM, HH:MM:SS, AM/PM, full date+time and Excel time fractions.
 * Returns null for empty / placeholder cells ('-', '--', '—').
 * Returns { error } for text that is present but is not a reliable time (never guessed).
 */
export function parseTimeCell(cell: Cell, order: DateOrder = 'dmy'): TimeValue | { error: string } | null {
  if (cell.unresolvedFormula) return { error: 'נוסחה ללא ערך מחושב בקובץ' };
  if (cell.serial !== undefined && (cell.isDateLike || (cell.serial > 0 && cell.serial < 1))) {
    const parts = serialToParts(cell.serial);
    if (!parts) return { error: 'ערך שעה לא תקין' };
    const hasDate = cell.serial >= 1;
    return { time: hm(parts.minutes), date: hasDate ? parts.date : null, flags: [], marked: false };
  }
  // PDF/OCR cells may also hold wrapped text from a neighbouring multi-line cell (e.g. an address):
  // use the single piece that contains digits; several candidate values are ambiguous.
  if (cell.parts && cell.parts.length > 1) {
    const numeric = cell.parts.filter((p) => /\d/.test(p));
    if (numeric.length === 1) return parseTimeCell({ text: numeric[0] }, order);
    if (numeric.length > 1) return { error: `בתא נמצאו כמה ערכים (${numeric.join(' / ')})` };
  }
  let t = cleanText(cell.text);
  if (!t || /^[-–—.]+$/.test(t)) return null;
  const marked = /[*!#]/.test(t);
  t = t.replace(/[*!#]/g, '').trim();
  const flags: string[] = [];

  // Full date + time
  let date: LocalDate | null = null;
  const dt = /^(\S+)[ T]+(\d{1,2}[:.]\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?)$/i.exec(t);
  if (dt) {
    date = parseDateCell({ text: dt[1] }, order);
    if (!date) return { error: `לא ניתן לקרוא את הערך "${t}"` };
    t = dt[2];
  }

  const ampm = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(t);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2]);
    if (h < 1 || h > 12 || m > 59) return { error: `שעה לא תקינה "${t}"` };
    if (ampm[4].toLowerCase() === 'p' && h !== 12) h += 12;
    if (ampm[4].toLowerCase() === 'a' && h === 12) h = 0;
    return { time: hm(h * 60 + m), date, flags, marked };
  }

  const colon = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (colon) {
    let h = Number(colon[1]);
    const m = Number(colon[2]);
    if (h === 24 && m === 0) h = 0;
    if (h > 23 || m > 59) return { error: `שעה לא תקינה "${t}"` };
    return { time: hm(h * 60 + m), date, flags, marked };
  }

  const dot = /^(\d{1,2})\.(\d{2})$/.exec(t);
  if (dot) {
    const h = Number(dot[1]);
    const m = Number(dot[2]);
    if (h > 23 || m > 59) return { error: `שעה לא תקינה "${t}"` };
    flags.push(`השעה נכתבה עם נקודה ("${t}") — יש לוודא שזו שעה ולא שעות עשרוניות`);
    return { time: hm(h * 60 + m), date, flags, marked };
  }
  return { error: `לא ניתן לזהות שעה בערך "${t}"` };
}

// ---------------------------------------------------------------------------------------------
// Durations (breaks, totals)
// ---------------------------------------------------------------------------------------------

/**
 * Break duration in minutes. "0:30" / "00:30:00" / Excel time → minutes; a plain integer is minutes
 * (up to 240). Decimal values ("0.5") are ambiguous (hours? minutes?) → error, never guessed.
 */
export function parseBreakCell(cell: Cell): number | { error: string } | null {
  if (cell.unresolvedFormula) return { error: 'נוסחת הפסקה ללא ערך מחושב' };
  if (cell.serial !== undefined && cell.isDateLike) {
    const p = serialToParts(cell.serial);
    return p && cell.serial < 1 ? p.minutes : { error: 'ערך הפסקה לא תקין' };
  }
  const t = cleanText(cell.text);
  if (!t || /^[-–—.]+$/.test(t)) return null;
  const c = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (c) return Number(c[1]) * 60 + Number(c[2]);
  if (/^\d{1,3}$/.test(t)) {
    const n = Number(t);
    return n <= 240 ? n : { error: `משך הפסקה חריג (${t})` };
  }
  if (cell.serial !== undefined && cell.serial >= 0 && cell.serial < 1 && !Number.isInteger(cell.serial)) {
    return { error: `משך הפסקה "${t}" אינו חד-משמעי (שעות? דקות?)` };
  }
  return { error: `משך הפסקה "${t}" אינו חד-משמעי` };
}

/** Worked-total cell → minutes (HH:MM or decimal hours). Used only for detection/notes. */
export function parseTotalCell(cell: Cell): number | null {
  if (cell.serial !== undefined && cell.isDateLike && cell.serial < 2) {
    const p = serialToParts(cell.serial);
    return p ? Math.round(cell.serial * 1440) : null;
  }
  const t = cleanText(cell.text).replace(/[*]/g, '');
  if (!t || /^[-–—.]+$/.test(t)) return null;
  const c = /^(\d{1,3}):(\d{2})$/.exec(t);
  if (c) return Number(c[1]) * 60 + Number(c[2]);
  const d = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(t);
  if (d) return Math.round(Number(t) * 60);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Weekdays and summary rows
// ---------------------------------------------------------------------------------------------

const HE_DAY_LETTERS: Record<string, number> = { א: 0, ב: 1, ג: 2, ד: 3, ה: 4, ו: 5, ש: 6 };
const HE_DAY_NAMES: Record<string, number> = { ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6 };
const EN_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Weekday (0=Sunday) from Hebrew/English text, or null when not recognisable. */
export function parseWeekday(text: string): number | null {
  const t = cleanText(text).replace(/[׳'"`.]/g, '').replace(/^יום\s*/, '').trim();
  if (!t) return null;
  if (t in HE_DAY_NAMES) return HE_DAY_NAMES[t];
  if (t.length === 1 && t in HE_DAY_LETTERS) return HE_DAY_LETTERS[t];
  const en = EN_DAYS.indexOf(t.toLowerCase().slice(0, 3));
  return en >= 0 && /^[a-z]+$/i.test(t) ? en : null;
}

const SUMMARY_WORDS = ['סהכ', 'סיכום', 'total', 'totals', 'summary', 'subtotal', 'grandtotal', 'סכום'];

export function isSummaryText(text: string): boolean {
  const k = headerKey(text);
  return !!k && SUMMARY_WORDS.some((w) => k.startsWith(w) || k === w);
}

/** Finds a "dd/mm/yyyy - dd/mm/yyyy" (or "מ- … עד …") period in free text. */
export function findPeriod(lines: string[]): { from: LocalDate; to: LocalDate } | null {
  const all = lines.map(cleanText).join(' \n ');
  const range = /(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\s*[-–—]\s*(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/.exec(all);
  const dates = range ? [range[1], range[2]] : null;
  if (dates) {
    const from = parseDateCell({ text: dates[0] });
    const to = parseDateCell({ text: dates[1] });
    if (from && to && from <= to) return { from, to };
  }
  return null;
}

/** Normalised comparison key for person names ("נגר עילי" ≡ "עילי נגר"). */
export function nameKey(name: string): string {
  return cleanText(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function sameEmployee(a: { name: string | null; number: string | null }, b: { fullName: string; employeeNumber: string | null }): boolean {
  if (a.number && b.employeeNumber && a.number.trim() === b.employeeNumber.trim()) return true;
  if (!a.name) return false;
  const src = new Set(nameKey(a.name).split(' ').filter(Boolean));
  const emp = nameKey(b.fullName).split(' ').filter(Boolean);
  if (!src.size || !emp.length) return false;
  if (nameKey(a.name) === nameKey(b.fullName)) return true;
  // Every word of the employee's name appears in the detected name (extra words from titles/OCR noise allowed),
  // and the detected name has at most one extra word.
  return emp.length >= 2 && emp.every((w) => src.has(w)) && src.size <= emp.length + 1;
}
