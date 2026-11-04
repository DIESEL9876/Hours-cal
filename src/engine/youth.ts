/**
 * Youth Employment Law (חוק עבודת הנוער, התשי"ג-1953) checks — version 1.1.9.
 *
 * Applied per ATTENDANCE DATE from the employee's date of birth (an employee who turns 18 mid-month is a minor only
 * before the birthday). These are COMPLIANCE checks: recorded minutes are never removed or reduced. Pay
 * classification keeps the general Hours of Work and Rest Law calculation; where youth limits were exceeded the
 * remuneration is flagged "דורש בדיקה" (a minor who worked overtime is still owed full pay for it).
 *
 * Verification status: the Knesset / gov.il primary texts were not reachable from the build environment; each rule
 * below was cross-checked against several secondary sources (Kol-Zchut, Ministry of Education guidance, payroll
 * publishers) — see docs/LEGAL_RULES.md §11. Nothing here is presented as a verified payroll result.
 */
import type { LocalDate, Warning } from './types';
import { formatHM } from './time';

export const YOUTH = {
  /** §20: 8 hours a day, 40 a week. */
  DAILY_MINUTES: 8 * 60,
  WEEKLY_MINUTES: 40 * 60,
  /** 16 and over in a five-day week: up to 9 hours a day (the 40-hour week still applies). */
  DAILY_16_FIVE_DAY_MINUTES: 9 * 60,
  /** Day before the weekly rest / a holiday: 7 hours. */
  EVE_MINUTES: 7 * 60,
  /** §22: 6 hours of work or more → a 45-minute break, of which at least 30 minutes continuous. */
  BREAK_AFTER_MINUTES: 6 * 60,
  BREAK_MINUTES: 45,
  /** §24–25: night = 20:00–08:00 under 16 (or under compulsory education); 22:00–06:00 from 16 (permit exceptions). */
  NIGHT_UNDER_16: [20 * 60, 8 * 60] as const,
  NIGHT_16_PLUS: [22 * 60, 6 * 60] as const,
  /** §2: no employment before 15 (exceptions from 14 during school holidays, artistic work by permit). */
  MIN_AGE: 15,
};

/**
 * Minimum hourly wage for minors (Minimum Wage Law + regulations): adult monthly minimum × 70% / 75% / 83% ÷ 173 hours.
 * Only periods confirmed by several sources are listed; outside them no automatic check is made (review instead).
 */
export const YOUTH_MINIMUM_WAGE: { from: LocalDate; to: LocalDate | null; under16: number; age16: number; age17: number; source: string }[] = [
  { from: '2026-04-01', to: null, under16: 2607, age16: 2794, age17: 3092, source: 'שכר מינימום מ-1.4.2026: 6,443.85 ₪ למבוגר; נוער 70%/75%/83% ÷ 173 שעות' },
];

export function ageOn(birth: LocalDate, date: LocalDate): number {
  let age = +date.slice(0, 4) - +birth.slice(0, 4);
  if (date.slice(5) < birth.slice(5)) age--;
  return age;
}

/** null when no date of birth is stored (age classification unverified — adult rules provisionally). */
export function youthStatusOn(birth: LocalDate | null | undefined, date: LocalDate): { age: number; minor: boolean } | null {
  if (!birth) return null;
  const age = ageOn(birth, date);
  return { age, minor: age < 18 };
}

export function youthMinimumHourly(date: LocalDate, age: number): { agorot: number; source: string } | null {
  const row = YOUTH_MINIMUM_WAGE.find((r) => date >= r.from && (r.to === null || date <= r.to));
  if (!row) return null;
  return { agorot: age < 16 ? row.under16 : age < 17 ? row.age16 : row.age17, source: row.source };
}

const w = (code: string, severity: Warning['severity'], message: string, date: LocalDate): Warning => ({ code, severity, message, date });

export interface YouthDayInput {
  date: LocalDate;
  age: number;
  netMinutes: number;
  grossMinutes: number;
  /** Deducted + paid break minutes of the day. */
  breakMinutes: number;
  /** Local minute-of-day of every worked minute, and its premium. */
  minutes: { minuteOfDay: number; premium: 'none' | 'rest' | 'holiday' }[];
  /** The day before the weekly rest or a holiday. */
  eve: boolean;
  fiveDayWeek: boolean;
  hourlyRateAgorot: number | null;
}

/** Youth checks of one attendance date. Returns warnings only — never changes worked minutes. */
export function checkYouthDay(d: YouthDayInput): Warning[] {
  const out: Warning[] = [];
  if (d.netMinutes <= 0) return out;
  if (d.age < YOUTH.MIN_AGE)
    out.push(w('YOUTH_MIN_AGE', 'compliance', `העסקת ילד בן ${d.age} — חוק עבודת הנוער אוסר העסקה לפני גיל 15 (למעט חריגים בחופשות מגיל 14 ובהיתר). יש לבדוק`, d.date));
  const limit = d.eve ? YOUTH.EVE_MINUTES : d.age >= 16 && d.fiveDayWeek ? YOUTH.DAILY_16_FIVE_DAY_MINUTES : YOUTH.DAILY_MINUTES;
  if (d.netMinutes > limit) {
    out.push(
      w(
        'YOUTH_DAILY_LIMIT',
        'compliance',
        `נער בן ${d.age} עבד ${formatHM(d.netMinutes)} שעות — מעל המותר (${formatHM(limit)}${d.eve ? ', ערב מנוחה/חג' : ''}). העסקת נער בשעות נוספות אסורה`,
        d.date,
      ),
    );
    out.push(w('YOUTH_PAY_REVIEW', 'review', 'הנער זכאי לתמורה מלאה על כל השעות שעבד בפועל, גם בהעסקה אסורה; סיווג התשלום (גמול שעות נוספות) דורש בדיקה', d.date));
  }
  const [ns, ne] = d.age < 16 ? YOUTH.NIGHT_UNDER_16 : YOUTH.NIGHT_16_PLUS;
  const night = d.minutes.filter((m) => m.minuteOfDay >= ns || m.minuteOfDay < ne).length;
  if (night > 0)
    out.push(
      w(
        'YOUTH_NIGHT',
        'compliance',
        `${formatHM(night)} שעות עבודה של נער בן ${d.age} בשעות הלילה (${formatHM(ns)}–${formatHM(ne)}) — אסור ללא היתר/חריג (משמרות עד 23:00, חופשת לימודים). יש לבדוק`,
        d.date,
      ),
    );
  if (d.minutes.some((m) => m.premium === 'rest')) out.push(w('YOUTH_REST_DAY', 'compliance', 'עבודת נער במנוחה השבועית — אסורה ללא היתר', d.date));
  if (d.minutes.some((m) => m.premium === 'holiday')) out.push(w('YOUTH_HOLIDAY', 'compliance', 'עבודת נער בחג — יש לבדוק היתר', d.date));
  if (d.grossMinutes >= YOUTH.BREAK_AFTER_MINUTES && d.breakMinutes < YOUTH.BREAK_MINUTES)
    out.push(w('YOUTH_BREAK', 'compliance', `נער שעבד 6 שעות או יותר זכאי להפסקה של 45 דקות לפחות (מתוכן 30 רצופות); נרשמו ${d.breakMinutes} דקות`, d.date));
  if (d.hourlyRateAgorot !== null && d.hourlyRateAgorot > 0) {
    const min = youthMinimumHourly(d.date, d.age);
    if (min && d.hourlyRateAgorot < min.agorot)
      out.push(
        w(
          'YOUTH_MIN_WAGE',
          'compliance',
          `השכר השעתי (₪${(d.hourlyRateAgorot / 100).toFixed(2)}) נמוך משכר המינימום לנוער בגיל ${d.age} (₪${(min.agorot / 100).toFixed(2)}; ${min.source})`,
          d.date,
        ),
      );
  }
  return out;
}

/** 40-hour weekly limit over the youth days of one Sunday–Saturday week. */
export function checkYouthWeek(lastYouthDate: LocalDate, youthNetMinutes: number): Warning[] {
  if (youthNetMinutes <= YOUTH.WEEKLY_MINUTES) return [];
  return [
    w('YOUTH_WEEKLY_LIMIT', 'compliance', `שבוע עבודה של ${formatHM(youthNetMinutes)} שעות לנער — מעל 40 השעות המותרות. העסקת נער בשעות נוספות אסורה`, lastYouthDate),
    w('YOUTH_PAY_REVIEW', 'review', 'הנער זכאי לתמורה מלאה על כל השעות שעבד בפועל, גם בהעסקה אסורה; סיווג התשלום (גמול שעות נוספות) דורש בדיקה', lastYouthDate),
  ];
}
