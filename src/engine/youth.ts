/**
 * Youth Employment Law (חוק עבודת הנוער, התשי"ג-1953) checks.
 *
 * Applied per ATTENDANCE DATE from the employee's date of birth (an employee who turns 18 mid-month is a minor only
 * before the birthday). These are COMPLIANCE checks: recorded minutes are never removed or reduced and pay is never
 * zeroed. Pay classification keeps the general Hours of Work and Rest Law calculation; where youth limits were
 * exceeded the remuneration is flagged "דורש בדיקה" (prohibited work that was performed is still paid).
 *
 * Two rule sets, kept side by side so a month closed under one set is never rewritten by the other:
 *   Y1 — version 1.1.9 (frozen: checkYouthDayV1 / checkYouthWeekV1). Used for months finalised under 1.1.9.
 *   Y2 — version 1.1.10, aligned with the research pack of 2026-11-04 (rule ids in legalRules.ts): eve limit only
 *        before a holiday the minor does not work, breaks from ACTUAL confirmed breaks with a 30-minute continuous
 *        segment and the eve rule, night windows by schooling status (no age-only permission), the 2024 school-vacation
 *        exception until 01:00 as a conditions review, recorded night permits, minimum age 14 on school vacations,
 *        documented apprentices, youth vacation review and a prohibited-minutes summary (daily excess, then weekly
 *        excess without double counting).
 *
 * Sources: see legalRules.ts — Kol Zchut rights summaries and a Knesset press release, as provided in the research
 * pack; none of them could be opened from the build environment. Nothing here is presented as a verified payroll result.
 */
import type { LocalDate, Warning, YouthProfile, YouthRuleSet } from './types';
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
export const YOUTH_MINIMUM_WAGE: { from: LocalDate; to: LocalDate | null; under16: number; age16: number; age17: number; apprentice: number; source: string }[] = [
  // Research pack Y-009 … Y-012 (Kol Zchut "תשלום שכר לבני נוער"): published hourly rates, not recomputed — not retroactive.
  { from: '2026-04-01', to: null, under16: 2607, age16: 2794, age17: 3092, apprentice: 2235, source: 'שכר מינימום לנוער מ-1.4.2026 (כל זכות): 6,443.85 ₪ למבוגר; 70%/75%/83% (חניך מוכר 60%) ÷ 173 שעות' },
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

export function youthMinimumHourly(date: LocalDate, age: number, apprentice = false): { agorot: number; source: string; ruleId: string } | null {
  const row = YOUTH_MINIMUM_WAGE.find((r) => date >= r.from && (r.to === null || date <= r.to));
  if (!row) return null;
  if (apprentice) return { agorot: row.apprentice, source: row.source, ruleId: 'Y-012' };
  return age < 16 ? { agorot: row.under16, source: row.source, ruleId: 'Y-009' } : age < 17 ? { agorot: row.age16, source: row.source, ruleId: 'Y-010' } : { agorot: row.age17, source: row.source, ruleId: 'Y-011' };
}

/**
 * The date on which the employee reaches `years` (birthday inclusive). A 29 February birthday falls on 1 March in a
 * common year — the same convention as ageOn (string comparison of MM-DD).
 */
export function birthdayOn(birth: LocalDate, years: number): LocalDate {
  const y = +birth.slice(0, 4) + years;
  const md = birth.slice(5);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return md === '02-29' && !leap ? `${y}-03-01` : `${y}-${md}`;
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
/** Rule set Y1 (1.1.9) — frozen. */
export function checkYouthDayV1(d: YouthDayInput): Warning[] {
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

/** Rule set Y1 (1.1.9) — frozen. 40-hour weekly limit over the youth days of one Sunday–Saturday week. */
export function checkYouthWeekV1(lastYouthDate: LocalDate, youthNetMinutes: number): Warning[] {
  if (youthNetMinutes <= YOUTH.WEEKLY_MINUTES) return [];
  return [
    w('YOUTH_WEEKLY_LIMIT', 'compliance', `שבוע עבודה של ${formatHM(youthNetMinutes)} שעות לנער — מעל 40 השעות המותרות. העסקת נער בשעות נוספות אסורה`, lastYouthDate),
    w('YOUTH_PAY_REVIEW', 'review', 'הנער זכאי לתמורה מלאה על כל השעות שעבד בפועל, גם בהעסקה אסורה; סיווג התשלום (גמול שעות נוספות) דורש בדיקה', lastYouthDate),
  ];
}

// ---------------------------------------------------------------------------
// Rule set Y2 (1.1.10)
// ---------------------------------------------------------------------------

export const CURRENT_YOUTH_RULE_SET: YouthRuleSet = 'Y2';

/** Inline wording required by the research pack for prohibited work that was performed. */
export const PROHIBITED_WORK_TEXT = 'העבודה בוצעה, אך העסקתה עשויה להיות אסורה; השכר לא נמחק';

const PAY_REVIEW_TEXT = `${PROHIBITED_WORK_TEXT}. סיווג התשלום (גמול שעות נוספות/מנוחה) דורש בדיקת חשב/ת שכר`;

const wr = (code: string, severity: Warning['severity'], message: string, date: LocalDate, ruleId: string): Warning => ({ code, severity, message, date, ruleId });

export function inSchoolVacation(profile: YouthProfile | null | undefined, date: LocalDate): boolean {
  return !!profile?.schoolVacations?.some((v) => date >= v.from && date <= v.to);
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return (h * 60 + min) % 1440;
}

/** Minutes since 12:00 — orders evening and early-morning minutes of one night. */
const sinceNoon = (minuteOfDay: number) => (minuteOfDay - 720 + 1440) % 1440;

export interface YouthDayInputV2 {
  date: LocalDate;
  age: number;
  netMinutes: number;
  /** Break segments of the day: each shift's recorded break, and gaps between shifts of the same date. */
  breaks: { minutes: number; kind: 'unpaid_confirmed' | 'unpaid_unconfirmed' | 'paid' | 'gap' }[];
  minutes: { minuteOfDay: number; premium: 'none' | 'rest' | 'holiday' }[];
  restEve: boolean;
  holidayEve: boolean;
  /** The minor works on the holiday that follows (the 7-hour eve limit applies only before a holiday NOT worked). */
  worksNextDay: boolean;
  fiveDayWeek: boolean;
  hourlyRateAgorot: number | null;
  profile: YouthProfile | null;
}

export interface YouthDayOutcome {
  warnings: Warning[];
  dailyLimitMinutes: number;
  dailyExcessMinutes: number;
  nightProhibitedMinutes: number;
  nightReviewMinutes: number;
  restDayMinutes: number;
  /** No published youth minimum-wage table for this date (checked manually). */
  noWageTable: boolean;
}

/** Rule set Y2: youth checks of one attendance date with work. Warnings only — never changes worked minutes or pay. */
export function checkYouthDayV2(d: YouthDayInputV2): YouthDayOutcome {
  const out: Warning[] = [];
  const res: YouthDayOutcome = { warnings: out, dailyLimitMinutes: 0, dailyExcessMinutes: 0, nightProhibitedMinutes: 0, nightReviewMinutes: 0, restDayMinutes: 0, noWageTable: false };
  if (d.netMinutes <= 0) return res;
  const vacation = inSchoolVacation(d.profile, d.date);
  const schooling = d.profile?.schooling ?? 'unknown';

  // Y-015 — minimum age.
  if (d.age < 14)
    out.push(wr('YOUTH_MIN_AGE', 'compliance', `העסקת ילד בן ${d.age} — אסורה (גיל ההעסקה: 15, ו-14 בחופשת לימודים רשמית), למעט חריגים בהיתר כגון הופעות. ${PROHIBITED_WORK_TEXT}`, d.date, 'Y-015'));
  else if (d.age === 14) {
    if (vacation) out.push(wr('YOUTH_MIN_AGE_REVIEW', 'review', 'נער בן 14 בחופשת לימודים רשמית — העסקה מותרת רק בתנאים (עבודה קלה ומתאימה). יש לבדוק שהתנאים התקיימו', d.date, 'Y-015'));
    else out.push(wr('YOUTH_MIN_AGE', 'compliance', `נער בן 14 שלא בחופשת לימודים רשמית — העסקה אסורה (גיל ההעסקה בשנת הלימודים: 15). ${PROHIBITED_WORK_TEXT}`, d.date, 'Y-015'));
  }

  // Y-002 … Y-005 — daily limit.
  const eve = d.restEve || (d.holidayEve && !d.worksNextDay);
  const limit = eve ? YOUTH.EVE_MINUTES : d.age >= 16 && d.fiveDayWeek ? YOUTH.DAILY_16_FIVE_DAY_MINUTES : YOUTH.DAILY_MINUTES;
  const limitRule = eve ? 'Y-005' : d.age < 16 ? 'Y-002' : d.fiveDayWeek ? 'Y-003' : 'Y-004';
  res.dailyLimitMinutes = limit;
  if (d.netMinutes > limit) {
    res.dailyExcessMinutes = d.netMinutes - limit;
    out.push(
      wr(
        'YOUTH_DAILY_LIMIT',
        'compliance',
        `נער בן ${d.age} עבד ${formatHM(d.netMinutes)} שעות — ${formatHM(res.dailyExcessMinutes)} מעל המותר (${formatHM(limit)}${eve ? ', ערב מנוחה/חג' : ''}). העסקת נער בשעות נוספות אסורה. ${PROHIBITED_WORK_TEXT}`,
        d.date,
        limitRule,
      ),
    );
    out.push(wr('YOUTH_PAY_REVIEW', 'review', PAY_REVIEW_TEXT, d.date, 'Y-008'));
  }

  // Y-014 / Y-013 — night work by schooling status, school-vacation exception and recorded permits.
  const strict = d.age < 16 || schooling === 'compulsory'; // 20:00–08:00
  const permit = d.profile?.nightPermits?.find((p) => d.date >= p.validFrom && d.date <= p.validTo && parseHHMM(p.until) !== null) ?? null;
  const expiredPermit = !permit && !!d.profile?.nightPermits?.length;
  let schoolingReview = 0;
  let vacationReview = 0;
  let permitReview = 0;
  let after23 = false;
  for (const m of d.minutes) {
    const t = m.minuteOfDay;
    const inWide = t >= 20 * 60 || t < 8 * 60;
    if (!inWide) continue;
    const inCore = t >= 22 * 60 || t < 6 * 60;
    const level: 'prohibited' | 'schooling' | null = strict || inCore ? 'prohibited' : schooling === 'unknown' ? 'schooling' : null;
    if (!level) continue;
    if (d.age >= 16 && vacation && (t >= 20 * 60 || t < 60)) {
      vacationReview++;
      if (t >= 23 * 60 || t < 60) after23 = true;
      continue;
    }
    if (permit && sinceNoon(t) < sinceNoon(parseHHMM(permit.until)!)) {
      permitReview++;
      continue;
    }
    if (level === 'schooling') schoolingReview++;
    else res.nightProhibitedMinutes++;
  }
  res.nightReviewMinutes = schoolingReview + vacationReview + permitReview;
  const window = strict ? '20:00–08:00' : '22:00–06:00';
  if (res.nightProhibitedMinutes > 0) {
    out.push(
      wr(
        'YOUTH_NIGHT',
        'compliance',
        `${formatHM(res.nightProhibitedMinutes)} שעות עבודה של נער בן ${d.age} בשעות הלילה האסורות (${window}${strict && d.age >= 16 ? ', חובת לימוד חלה' : ''})${expiredPermit ? '; היתר הלילה שנרשם אינו בתוקף בתאריך זה' : ''}. ${PROHIBITED_WORK_TEXT}`,
        d.date,
        'Y-014',
      ),
    );
    out.push(wr('YOUTH_PAY_REVIEW', 'review', PAY_REVIEW_TEXT, d.date, 'Y-008'));
  }
  if (schoolingReview > 0)
    out.push(
      wr(
        'YOUTH_NIGHT_REVIEW',
        'review',
        `${formatHM(schoolingReview)} שעות עבודה בין 20:00 ל-22:00 של נער בן ${d.age} — מותר רק אם חובת הלימוד אינה חלה עליו (יש עמימות בין לשון החוק לפרשנות האכיפה). חובת הלימוד לא הוזנה — יש לבדוק`,
        d.date,
        'Y-014',
      ),
    );
  if (vacationReview > 0)
    out.push(
      wr(
        'YOUTH_NIGHT_VACATION_REVIEW',
        'review',
        `חופשת לימודים רשמית: לפי תיקון 22 לחוק עבודת הנוער (2024) מותרת העסקת בני 16–17 עד 01:00, בתנאים — יש לוודא שהתנאים התקיימו${after23 ? '. העבודה נמשכה אחרי 23:00 — על המעסיק לדאוג להסעה הביתה (לא בתחבורה ציבורית)' : ''}`,
        d.date,
        'Y-013',
      ),
    );
  if (permitReview > 0)
    out.push(
      wr(
        'YOUTH_NIGHT_PERMIT_REVIEW',
        'review',
        `עבודת לילה לפי היתר שנרשם (${permit!.reference || 'ללא מספר'}, בתוקף ${permit!.validFrom}–${permit!.validTo}, עד ${permit!.until}) — יש לוודא את זהות ההיתר, היקפו ותנאיו`,
        d.date,
        'Y-014',
      ),
    );

  // Y-006 — weekly rest day (the rest day chosen for the employee) and holidays.
  res.restDayMinutes = d.minutes.filter((m) => m.premium === 'rest').length;
  if (res.restDayMinutes > 0) {
    out.push(wr('YOUTH_REST_DAY', 'compliance', `עבודת נער ביום המנוחה השבועית שנקבע לו (${formatHM(res.restDayMinutes)} שעות) — אסורה, ואין היתר המתיר אותה. ${PROHIBITED_WORK_TEXT}`, d.date, 'Y-006'));
    out.push(wr('YOUTH_PAY_REVIEW', 'review', PAY_REVIEW_TEXT, d.date, 'Y-008'));
  }
  if (d.minutes.some((m) => m.premium === 'holiday')) out.push(wr('YOUTH_HOLIDAY', 'review', `עבודת נער ביום חג — יש לבדוק את חוקיות ההעסקה. ${PROHIBITED_WORK_TEXT}`, d.date, 'Y-006'));

  // Y-007 — breaks: only breaks that actually occurred count; a 30-minute continuous segment is required.
  if (d.netMinutes >= YOUTH.BREAK_AFTER_MINUTES) {
    const required = eve ? 30 : YOUTH.BREAK_MINUTES;
    const sure = d.breaks.filter((b) => b.kind === 'unpaid_confirmed' || b.kind === 'gap').map((b) => b.minutes);
    const all = d.breaks.filter((b) => b.minutes > 0).map((b) => b.minutes);
    const ok = (xs: number[]) => xs.reduce((a, b) => a + b, 0) >= required && Math.max(0, ...xs) >= 30;
    if (!ok(sure)) {
      if (ok(all))
        out.push(
          wr(
            'YOUTH_BREAK_UNVERIFIED',
            'review',
            `הפסקת הנער מבוססת על הפסקה שלא אושרה שהתקיימה או על הפסקה בתשלום (אם הנער נדרש להישאר זמין — אין זו הפסקה). נדרשות ${required} דקות, מתוכן 30 רצופות — יש לאשר`,
            d.date,
            'Y-007',
          ),
        );
      else
        out.push(
          wr(
            'YOUTH_BREAK',
            'compliance',
            `נער שעבד ${formatHM(d.netMinutes)} שעות זכאי להפסקה של ${required} דקות לפחות${eve ? ' (ערב מנוחה/חג)' : ''}, מתוכן 30 רצופות; נרשמו ${all.reduce((a, b) => a + b, 0)} דקות (הארוכה: ${Math.max(0, ...all)})`,
            d.date,
            'Y-007',
          ),
        );
    }
  }

  // Y-009 … Y-012 — minimum wage (only inside the published period; apprentices only with a recorded document).
  if (d.hourlyRateAgorot !== null && d.hourlyRateAgorot > 0) {
    const apprentice = !!d.profile?.apprentice?.reference?.trim();
    const min = youthMinimumHourly(d.date, d.age, apprentice);
    if (!min) res.noWageTable = true;
    else {
      if (apprentice)
        out.push(wr('YOUTH_APPRENTICE_REVIEW', 'review', `הוחל שיעור שכר מינימום של חניך מוכר (מסמך: ${d.profile!.apprentice!.reference}) — יש לוודא שההכרה לפי חוק החניכות בתוקף`, d.date, 'Y-012'));
      if (d.hourlyRateAgorot < min.agorot)
        out.push(
          wr(
            'YOUTH_MIN_WAGE',
            'compliance',
            `השכר השעתי (₪${(d.hourlyRateAgorot / 100).toFixed(2)}) נמוך משכר המינימום ${apprentice ? 'לחניך מוכר' : `לנוער בגיל ${d.age}`} (₪${(min.agorot / 100).toFixed(2)}; ${min.source})`,
            d.date,
            min.ruleId,
          ),
        );
    }
  }
  return res;
}

/**
 * Rule set Y2: the 40-hour week. Daily excess is counted first; the weekly excess is what remains above 40 hours after
 * removing the daily excess (no double counting).
 */
export function checkYouthWeekV2(lastYouthDate: LocalDate, youthNetMinutes: number, dailyExcessMinutes: number): { warnings: Warning[]; weeklyExcessMinutes: number } {
  const weeklyExcessMinutes = Math.max(0, youthNetMinutes - dailyExcessMinutes - YOUTH.WEEKLY_MINUTES);
  if (youthNetMinutes <= YOUTH.WEEKLY_MINUTES) return { warnings: [], weeklyExcessMinutes };
  return {
    weeklyExcessMinutes,
    warnings: [
      wr(
        'YOUTH_WEEKLY_LIMIT',
        'compliance',
        `שבוע עבודה של ${formatHM(youthNetMinutes)} שעות לנער — מעל 40 השעות המותרות (עודף שבועי מעבר לעודף היומי: ${formatHM(weeklyExcessMinutes)}). העסקת נער בשעות נוספות אסורה. ${PROHIBITED_WORK_TEXT}`,
        lastYouthDate,
        'Y-001',
      ),
      wr('YOUTH_PAY_REVIEW', 'review', PAY_REVIEW_TEXT, lastYouthDate, 'Y-008'),
    ],
  };
}
