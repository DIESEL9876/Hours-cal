/**
 * Actual vs. paid attendance (1.1.7).
 *
 * The overtime engine classifies ONLY physically worked minutes. This module adds, per date, a separate
 * accounting of absences the USER classified (never automatically): vacation, sickness, holiday, election
 * day, unpaid absence. It never adds absence time to worked time and never puts it into overtime buckets.
 * Its only interaction with the overtime engine is the optional weekly credit (see weeklyCreditMinutes).
 *
 * Rules (see docs/LEGAL_RULES.md §10 for sources and verification status):
 *  - Vacation (Annual Leave Law 1951 s.10): full pay — monthly = regular salary; hourly/daily = average daily
 *    wage (hours are an estimate: payroll computes the money).
 *  - Sickness (Sick Pay Law 1976 s.2 + s.5 after Amendment 4/2011): day 1 = 0%, days 2–3 = 50%, day 4+ = 100%,
 *    counted over the continuous sickness period (calendar days, across month boundaries). Monthly employees:
 *    rest days inside the period are part of it; hourly/daily: only scheduled workdays are paid. The accrued
 *    balance (1.5 days per month, max 90) is not managed here → always flagged for review.
 *  - Holidays: monthly — included in salary; hourly/daily (holiday-pay extension order) — 3 months' seniority,
 *    not on Friday/Saturday (five-day week) / Saturday (six-day week), no unauthorised absence on the
 *    workday before/after the holiday.
 *  - Election day (Knesset Elections Law; Local Authorities (Elections) Law s.97B): paid rest day for an
 *    employee with 14 consecutive days of employment who was scheduled to work; local elections also require
 *    voter registration / workplace in that authority (user confirmation). Work on election day: no
 *    statutory rate — never a universal 200%; flagged for review.
 * Missing information never becomes a guess: the rate is left undetermined and the day is marked "דורש בדיקה".
 */
import { addDays, diffDays, formatDurationHe, formatHM, weekdayOf } from './time';
import { CalendarContext } from './calendar';
import type {
  AttendanceTotals,
  BusinessAbsenceDefaults,
  DayAttendance,
  DayStatus,
  DayStatusKind,
  EmployeeSettings,
  LocalDate,
  ResolvedAbsenceSettings,
  SettingsVersion,
} from './types';
import { resolveAbsenceSettings } from './settings';

export const ABSENCE_LABELS: Record<DayStatusKind, string> = {
  work: 'עבודה רגילה',
  vacation: 'חופשה',
  sick: 'מחלה',
  holiday: 'חג',
  election: 'בחירות',
  unpaid: 'היעדרות ללא תשלום',
  not_worked: 'יום ללא עבודה',
  reserve: 'מילואים',
  missing_record: 'רישום חסר',
};

const PAID_CATEGORIES: DayStatusKind[] = ['vacation', 'sick', 'holiday', 'election'];
const ABSENT_CATEGORIES: DayStatusKind[] = ['vacation', 'sick', 'holiday', 'election', 'unpaid', 'reserve', 'not_worked'];

export function emptyDayAttendance(netMinutes: number, category: DayStatusKind | null): DayAttendance {
  const worked = netMinutes > 0;
  return {
    category,
    actualWorkedMinutes: netMinutes,
    actualWorked: worked,
    absenceDayHundredths: 0,
    paidAbsenceNominalMinutes: 0,
    payPercent: null,
    paidAbsenceEquivalentMinutes: 0,
    weeklyCreditMinutes: 0,
    payableEquivalentMinutes: netMinutes,
    paidDayHundredths: worked ? 100 : 0,
    paidAbsenceDayHundredths: 0,
    estimatedValueAgorot: 0,
    valueBasis: 'none',
    sickDayIndex: null,
    sickBalanceDeductionHundredths: 0,
    basis: 'none',
    reviewReasons: [],
    explanation: [],
  };
}

export function emptyAttendanceTotals(): AttendanceTotals {
  return {
    actualWorkedDays: 0,
    actualWorkedMinutes: 0,
    paidDayHundredths: 0,
    payableEquivalentMinutes: 0,
    paidAbsenceNominalMinutes: 0,
    paidAbsenceEquivalentMinutes: 0,
    weeklyCreditMinutes: 0,
    vacationDayHundredths: 0,
    sickDayHundredths: 0,
    sickPaidDayHundredths: 0,
    sickBalanceDeductionHundredths: 0,
    holidayDayHundredths: 0,
    electionDayHundredths: 0,
    unpaidDayHundredths: 0,
    reviewDays: 0,
    estimatedAbsenceValueAgorot: 0,
    reserveDayHundredths: 0,
  };
}

export function addAttendance(into: AttendanceTotals, d: AttendanceTotals): void {
  for (const k of Object.keys(into) as (keyof AttendanceTotals)[]) into[k] += d[k];
}

/** Totals are plain sums of the per-day values (exact reconciliation with the daily records). */
export function sumAttendance(days: DayAttendance[]): AttendanceTotals {
  const t = emptyAttendanceTotals();
  for (const d of days) {
    if (d.actualWorked) t.actualWorkedDays++;
    t.actualWorkedMinutes += d.actualWorkedMinutes;
    t.paidDayHundredths += d.paidDayHundredths;
    t.payableEquivalentMinutes += d.payableEquivalentMinutes;
    t.paidAbsenceNominalMinutes += d.paidAbsenceNominalMinutes;
    t.paidAbsenceEquivalentMinutes += d.paidAbsenceEquivalentMinutes;
    t.weeklyCreditMinutes += d.weeklyCreditMinutes;
    t.sickBalanceDeductionHundredths += d.sickBalanceDeductionHundredths;
    if (d.category === 'vacation') t.vacationDayHundredths += d.absenceDayHundredths;
    if (d.category === 'sick') {
      t.sickDayHundredths += d.absenceDayHundredths;
      t.sickPaidDayHundredths += d.paidAbsenceDayHundredths;
    }
    if (d.category === 'holiday') t.holidayDayHundredths += d.absenceDayHundredths;
    if (d.category === 'election') t.electionDayHundredths += d.absenceDayHundredths;
    if (d.category === 'unpaid') t.unpaidDayHundredths += d.absenceDayHundredths;
    if (d.category === 'reserve') t.reserveDayHundredths += d.absenceDayHundredths;
    t.estimatedAbsenceValueAgorot += d.estimatedValueAgorot;
    if (d.basis === 'review') t.reviewDays++;
  }
  return t;
}

/** Per-category view of the engine's own daily absence figures (1.1.13, reporting only — no new calculation). */
export interface AbsenceCategoryTotals {
  dayHundredths: number;
  /** Scheduled (nominal) hours of the absent portions. */
  nominalMinutes: number;
  /** Paid hour-equivalents (nominal × rate) — the part included in payableEquivalentMinutes. */
  equivalentMinutes: number;
  /** Paid day-equivalents (absent portion × rate). */
  paidDayHundredths: number;
  /** Dates whose entitlement needs a human check. */
  reviewDays: number;
}

/**
 * Groups the per-day attendance by day category. Plain sums of the engine's per-day values, so the categories add
 * up exactly to the period's AttendanceTotals (e.g. Σ equivalentMinutes = paidAbsenceEquivalentMinutes).
 */
export function absenceByCategory(days: DayAttendance[]): Partial<Record<DayStatusKind | 'none', AbsenceCategoryTotals>> {
  const out: Partial<Record<DayStatusKind | 'none', AbsenceCategoryTotals>> = {};
  for (const d of days) {
    if (!d.absenceDayHundredths && !d.paidAbsenceNominalMinutes && !d.paidAbsenceEquivalentMinutes && d.basis !== 'review') continue;
    const k = d.category ?? 'none';
    const t = (out[k] ??= { dayHundredths: 0, nominalMinutes: 0, equivalentMinutes: 0, paidDayHundredths: 0, reviewDays: 0 });
    t.dayHundredths += d.absenceDayHundredths;
    t.nominalMinutes += d.paidAbsenceNominalMinutes;
    t.equivalentMinutes += d.paidAbsenceEquivalentMinutes;
    t.paidDayHundredths += d.paidAbsenceDayHundredths;
    if (d.basis === 'review') t.reviewDays++;
  }
  return out;
}

export const roundHalfUp = (x: number) => Math.floor(x + 0.5);

/** "1.25" style display of hundredths of a day. */
export function formatDays(hundredths: number): string {
  const sign = hundredths < 0 ? '-' : '';
  const a = Math.abs(hundredths);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** First day of the month `n` months before the month of `date`. */
export function monthsBefore(date: LocalDate, n: number): LocalDate {
  let y = +date.slice(0, 4);
  let m = +date.slice(5, 7) - n;
  while (m < 1) {
    m += 12;
    y--;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** Date of the same day `n` months later (clamped to month end) — seniority checks. */
export function addMonthsDate(date: LocalDate, n: number): LocalDate {
  let y = +date.slice(0, 4);
  let m = +date.slice(5, 7) + n;
  while (m > 12) {
    m -= 12;
    y++;
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(+date.slice(8), last)).padStart(2, '0')}`;
}

/** How far back the data must be loaded for sickness periods and 3-month averages. */
export function absenceHistoryFrom(from: LocalDate): LocalDate {
  const a = monthsBefore(from, 3);
  const b = addDays(from, -62);
  return a < b ? a : b;
}

/** Actual worked time over a reference period: net minutes (after deductible breaks) of distinct worked dates only. */
export interface DayAverage {
  from: LocalDate;
  to: LocalDate;
  /** Distinct dates with net worked time > 0 (two shifts on a date = one day; absence-only dates excluded). */
  days: number;
  /** Total actual net minutes (never absence equivalents — no circular averaging). */
  workedMinutes: number;
  /** workedMinutes / days, rounded half-up; 0 when days = 0. */
  minutes: number;
}

export const NO_AVERAGE_DATA = 'אין מספיק נתונים לחישוב ממוצע';

export interface AbsenceContext {
  /** All day statuses loaded (including the look-back period). */
  statusByDate: Map<LocalDate, DayStatus>;
  netByDate: (date: LocalDate) => number;
  versionOn: (date: LocalDate) => SettingsVersion | null;
  /** Scheduled (expected) minutes of a regular day under the employee's schedule; 0 = not a workday. */
  scheduledMinutes: (date: LocalDate, s: EmployeeSettings) => number;
  /** Average net minutes per worked day over the 3 complete calendar months before the date's month (null = not loaded). */
  averageDaily: (date: LocalDate) => DayAverage | null;
  /** Average net minutes per actually worked day in the date's own month (1.1.9). */
  averageMonth: (date: LocalDate) => DayAverage;
  /** Manual value of a paid absence day for the date's month (1.1.9). */
  paidDayOverride: (date: LocalDate) => { minutes: number; reason: string } | null;
  business: BusinessAbsenceDefaults | undefined;
  cal: CalendarContext;
  historyFrom: LocalDate;
}

function isWorkdayFor(date: LocalDate, s: EmployeeSettings, cal: CalendarContext): boolean {
  return s.workDays.includes(weekdayOf(date) as never) && !cal.holidayOn(date, s);
}

/** Day number of `date` inside its continuous sickness period, or null if the start lies before the loaded data. */
function sickIndex(date: LocalDate, ctx: AbsenceContext): { index: number; start: LocalDate; truncated: boolean } {
  let start = date;
  let cursor = addDays(date, -1);
  for (let guard = 0; guard < 400; guard++) {
    if (cursor < ctx.historyFrom) return { index: diffDays(date, start) + 1, start, truncated: true };
    const st = ctx.statusByDate.get(cursor);
    if (st?.status === 'sick') {
      start = cursor;
      cursor = addDays(cursor, -1);
      continue;
    }
    const v = ctx.versionOn(cursor);
    // Rest days / non-working days / holidays between sick days do not interrupt the sickness period.
    if (v && !isWorkdayFor(cursor, v.settings, ctx.cal) && ctx.netByDate(cursor) === 0 && !st) {
      cursor = addDays(cursor, -1);
      continue;
    }
    break;
  }
  return { index: diffDays(date, start) + 1, start, truncated: false };
}

function sickRate(profile: ResolvedAbsenceSettings['sick'], index: number): number {
  if (profile === 'full_from_day1') return 100;
  if (profile === 'full_from_day2') return index === 1 ? 0 : 100;
  return index === 1 ? 0 : index <= 3 ? 50 : 100;
}

/** Nearest scheduled workday before/after `date` (skipping rest days and other holidays). */
function neighbourWorkday(date: LocalDate, dir: -1 | 1, s: EmployeeSettings, cal: CalendarContext): LocalDate {
  let d = addDays(date, dir);
  for (let i = 0; i < 14 && !isWorkdayFor(d, s, cal); i++) d = addDays(d, dir);
  return d;
}

const authorised = (st: DayStatus | undefined, net: number) =>
  net > 0 || (!!st && ['work', 'vacation', 'sick', 'holiday', 'election', 'reserve'].includes(st.status));

/** Accounting of one date. `status` is the user's classification (null = none). */
export function computeDayAttendance(date: LocalDate, status: DayStatus | null, ctx: AbsenceContext): DayAttendance {
  const net = ctx.netByDate(date);
  const category = status?.status ?? null;
  const day = emptyDayAttendance(net, category);
  if (!category || !ABSENT_CATEGORIES.includes(category)) return day;
  const version = ctx.versionOn(date);
  if (!version) {
    day.basis = 'review';
    day.reviewReasons.push('אין הגדרות עובד בתוקף לתאריך זה');
    return day;
  }
  const s = version.settings;
  const a = resolveAbsenceSettings(s, date, ctx.business);
  const det = status?.absence ?? {};
  const label = ABSENCE_LABELS[category];
  const ex = day.explanation;
  const review = (r: string) => {
    day.reviewReasons.push(r);
    day.basis = 'review';
  };
  /** A rule basis never hides an open review item. */
  const setBasis = (b: 'rule' | 'estimate') => {
    if (day.basis !== 'review') day.basis = b;
  };
  const wd = weekdayOf(date);

  // 1. Hours of a paid day for this employee on this date.
  const scheduled = ctx.scheduledMinutes(date, s);
  let dayMinutes = scheduled;
  let refText = '';
  if (scheduled > 0) {
    const override = ctx.paidDayOverride(date);
    if (override && override.minutes > 0) {
      dayMinutes = override.minutes;
      refText = `${formatHM(dayMinutes)} שעות ליום — ערך ידני לחודש זה (${override.reason || 'ללא נימוק'})`;
      if (!override.reason?.trim()) review('ערך יום היעדרות ידני לחודש ללא נימוק');
    } else if (a.paidDayReference === 'fixed') {
      if (a.paidDayMinutes && a.paidDayMinutes > 0) {
        dayMinutes = a.paidDayMinutes;
        refText = `${formatHM(dayMinutes)} שעות ליום (הזנה ידנית — שיטת חישוב לפי הגדרת העסק)`;
      } else {
        refText = `${formatHM(scheduled)} שעות לפי מתכונת העבודה (לא הוגדר ערך קבוע)`;
        review('נבחרה הזנה ידנית של שעות ליום אך לא הוזן ערך — הוחלו שעות מתכונת העבודה');
      }
    } else if (a.paidDayReference === 'average_3m' || a.paidDayReference === 'average_month') {
      const avg = a.paidDayReference === 'average_month' ? ctx.averageMonth(date) : ctx.averageDaily(date);
      const period = a.paidDayReference === 'average_month' ? 'בחודש הנוכחי' : 'בשלושת החודשים הקודמים';
      if (avg && avg.days > 0) {
        dayMinutes = avg.minutes;
        refText = `${formatHM(dayMinutes)} שעות — ממוצע שעות עבודה ${period} (${formatDurationHe(avg.workedMinutes)} ב-${avg.days} ימי עבודה בפועל, ${fmt(avg.from)}–${fmt(avg.to)}; שיטת חישוב לפי הגדרת העסק)`;
      } else {
        // Never a silent standard day: without data the absence has no hours until a value is entered.
        dayMinutes = 0;
        refText = '';
        review(`${NO_AVERAGE_DATA} (${avg ? 'אין ימי עבודה בפועל' : 'נתוני התקופה לא נטענו'} ${period}) — יש להזין ערך ידני לחודש או לבחור תקופת ייחוס אחרת`);
      }
    } else refText = `${formatHM(scheduled)} שעות לפי מתכונת העבודה של העובד ביום זה`;
  }
  if (!a.salaryTypeExplicit && PAID_CATEGORIES.includes(category)) review('לא הוגדר סוג שכר (חודשי/שעתי/יומי) — הוחל עובד חודשי');

  // 2. Absent portion (never double count: a fully worked day is not also a full absence).
  let fraction = 1;
  let nominal = dayMinutes;
  const workedToo = net > 0;
  if (det.minutes != null && det.minutes > 0) {
    if (scheduled === 0) {
      fraction = 0;
      nominal = 0;
      review('הוזנה היעדרות חלקית ביום שאינו יום עבודה מתוכנן');
    } else {
      nominal = Math.min(det.minutes, dayMinutes || det.minutes);
      if (dayMinutes && det.minutes > dayMinutes) review(`ההיעדרות החלקית (${formatHM(det.minutes)}) ארוכה מיום עבודה (${formatHM(dayMinutes)}) — הוגבלה ליום אחד`);
      fraction = dayMinutes ? nominal / dayMinutes : 1;
      ex.push(`היעדרות חלקית: ${formatDurationHe(nominal)} מתוך ${formatDurationHe(dayMinutes)}.`);
    }
  } else if (workedToo) {
    if (category === 'holiday' || category === 'election') {
      fraction = 0;
      nominal = 0;
      ex.push(`נרשמה עבודה ביום ${label === 'חג' ? 'החג' : 'הבחירות'} — השעות נספרו כעבודה בפועל ולא כהיעדרות.`);
      if (category === 'holiday') {
        ex.push('גמול העבודה בחג מחושב בתוספות החג הקיימות.');
        if (a.salaryType !== 'monthly') review('עבודה בחג (עובד שעתי/יומי): ייתכן זכאות לדמי חג בנוסף לשכר העבודה — דורש בדיקה');
      } else review('עבודה ביום בחירות: אין שיעור קבוע בחוק (נוהג/פסיקה: 200% או 100% ויום חופש) — התמורה דורשת בדיקה; לא חושבה תוספת אוטומטית');
    } else if (category !== 'not_worked') {
      fraction = 0;
      nominal = 0;
      review(`היום סומן "${label}" אך נרשמו שעות עבודה — יש להזין את משך ההיעדרות החלקית (לא נספרה היעדרות כדי למנוע ספירה כפולה)`);
    }
  }
  if (category === 'not_worked') {
    day.absenceDayHundredths = 0;
    ex.push('יום ללא עבודה — אינו יום היעדרות בתשלום ואינו נספר בשום קטגוריה.');
    return day;
  }
  if (scheduled === 0 && fraction > 0) {
    nominal = 0;
    if (category === 'vacation') fraction = 0; // vacation is not used up on a non-working day
  }
  day.absenceDayHundredths = roundHalfUp(fraction * 100);
  day.paidAbsenceNominalMinutes = nominal;
  if (refText && nominal > 0) ex.push(`בסיס שעות היום המשולם: ${refText}.`);
  if (scheduled === 0) ex.push(`${HE_DAY(wd)} אינו יום עבודה מתוכנן לעובד — אין שעות היעדרות לתשלום.`);

  // 3. Payment rate.
  let rate: number | null = null;
  const seniority = (months: number, days: number): boolean | null => {
    if (!a.employmentStart) return null;
    const limit = months ? addMonthsDate(a.employmentStart, months) : addDays(a.employmentStart, days);
    return date >= limit;
  };
  switch (category) {
    case 'vacation': {
      if (a.vacation === 'manual') review('פרופיל חופשה "ידני": שיעור התשלום לא נקבע אוטומטית');
      else {
        rate = 100;
        if (a.salaryType === 'monthly') {
          setBasis('rule');
          ex.push('חופשה בתשלום מלא (חוק חופשה שנתית, ס׳ 10 — עובד חודשי: השכר הרגיל).');
        } else {
          setBasis('estimate');
          ex.push('חופשה בתשלום (חוק חופשה שנתית, ס׳ 10 — עובד שעתי/יומי: שכר יומי ממוצע). השעות הן שווי משוער; הסכום נקבע בשכר.');
        }
        ex.push('נספר כיום חופשה שנוצל. יתרת חופשה אינה מנוהלת במערכת.');
      }
      break;
    }
    case 'sick': {
      const si = sickIndex(date, ctx);
      day.sickDayIndex = si.index;
      rate = sickRate(a.sick, si.index);
      const profileHe = a.sick === 'statutory' ? 'חוק דמי מחלה: יום 1 — 0%, ימים 2–3 — 50%, מיום 4 — 100%' : a.sick === 'full_from_day2' ? 'הסדר מיטיב: 100% מהיום השני' : 'הסדר מיטיב: 100% מהיום הראשון';
      ex.push(`יום מחלה ${si.index} בתקופת המחלה הרציפה שהחלה ב-${fmt(si.start)} (${profileHe}) → ${rate}%.`);
      if (si.truncated) review('תחילת תקופת המחלה קודמת לנתונים שנטענו — יש לוודא את מספר יום המחלה');
      if (a.salaryType === 'monthly') {
        ex.push('עובד חודשי: ימי מנוחה וחג בתוך תקופת המחלה הם חלק ממנה ונמנים בה.');
        day.sickBalanceDeductionHundredths = day.absenceDayHundredths;
      } else {
        ex.push('עובד שעתי/יומי: דמי מחלה משולמים רק עבור ימי עבודה מתוכננים.');
        day.sickBalanceDeductionHundredths = scheduled > 0 ? day.absenceDayHundredths : 0;
      }
      review('הזכאות לדמי מחלה מותנית ביתרה צבורה (1.5 ימים לחודש, עד 90) ובאישור מחלה — היתרה אינה מנוהלת במערכת');
      break;
    }
    case 'holiday': {
      const h = ctx.cal.holidayOn(date, s);
      const name = det.holidayName || h?.name || null;
      if (!h && !det.holidayName) review('התאריך אינו חג בלוח השנה ולא נבחר שם חג — יש לאשר את החג');
      else if (name) ex.push(`החג: ${name}.`);
      if (det.eligibility === 'not_eligible') {
        rate = 0;
        ex.push('המשתמש קבע שהעובד אינו זכאי לדמי חג ליום זה.');
        break;
      }
      if (a.holiday === 'manual') {
        review('מסגרת חגים "ידנית": שיעור התשלום לא נקבע אוטומטית');
        break;
      }
      if (a.holiday === 'all_paid') {
        rate = 100;
        ex.push('מסגרת הסכמית: כל חג החל ביום עבודה מתוכנן משולם.');
        setBasis('rule');
        break;
      }
      if (a.salaryType === 'monthly') {
        rate = 100;
        setBasis('rule');
        ex.push('עובד חודשי: יום החג כלול בשכר החודשי (אינו מנוכה ואינו נספר כחופשה).');
        break;
      }
      // Hourly / daily: holiday-pay extension order conditions.
      const reasons: string[] = [];
      const five = s.workweek === 'five';
      if ((five && (wd === 5 || wd === 6)) || (!five && wd === 6)) {
        rate = 0;
        ex.push(`עובד שעתי/יומי: חג שחל ביום ${HE_DAY(wd)} אינו מזכה בדמי חג (צו ההרחבה).`);
        break;
      }
      const sen = seniority(3, 0);
      if (sen === false) {
        rate = 0;
        ex.push('עובד שעתי/יומי: פחות מ-3 חודשי עבודה — אין זכאות לדמי חג.');
        break;
      }
      if (sen === null) reasons.push('לא הוזן תאריך תחילת העסקה (נדרשים 3 חודשי ותק)');
      const before = neighbourWorkday(date, -1, s, ctx.cal);
      const after = neighbourWorkday(date, 1, s, ctx.cal);
      for (const [d, label2] of [
        [before, 'לפני'],
        [after, 'אחרי'],
      ] as const) {
        if (d < ctx.historyFrom) {
          reasons.push(`אין נתונים ליום העבודה ${label2} החג`);
          continue;
        }
        const ok = authorised(ctx.statusByDate.get(d), ctx.netByDate(d));
        if (!ok && det.eligibility !== 'confirmed') reasons.push(`אין עבודה או היעדרות מאושרת ביום העבודה ${label2} החג (${fmt(d)}) — אם ההיעדרות הייתה בהסכמת המעסיק יש לאשר זכאות`);
      }
      if (reasons.length) {
        for (const r of reasons) review(r);
        break;
      }
      rate = 100;
      setBasis('estimate');
      ex.push('עובד שעתי/יומי: מתקיימים תנאי צו ההרחבה (ותק, יום החג, עבודה סביב החג) — דמי חג לפי ממוצע שעות. התקרה השנתית (9 ימי חג) לא נבדקת.');
      break;
    }
    case 'election': {
      if (det.eligibility === 'not_eligible') {
        rate = 0;
        ex.push('המשתמש קבע שהעובד אינו זכאי לתשלום ליום הבחירות.');
        break;
      }
      if (a.election === 'manual') {
        review('טיפול בימי בחירות "ידני": שיעור התשלום לא נקבע אוטומטית');
        break;
      }
      const type = det.electionType ?? null;
      if (!type) {
        review('לא נבחר סוג הבחירות (לכנסת / לרשויות המקומיות / אחר)');
        break;
      }
      if (type === 'other') {
        review('יום בחירות אחר — הזכאות דורשת בדיקה ידנית');
        break;
      }
      ex.push(type === 'knesset' ? 'בחירות לכנסת: יום שבתון בתשלום (חוק הבחירות לכנסת).' : 'בחירות לרשויות המקומיות: יום שבתון בתשלום (חוק הרשויות המקומיות (בחירות), ס׳ 97ב).');
      if (scheduled === 0) {
        rate = 0;
        ex.push('העובד לא היה אמור לעבוד ביום זה — אין תשלום נפרד.');
        break;
      }
      const reasons: string[] = [];
      const sen = seniority(0, 14);
      if (sen === false) {
        rate = 0;
        ex.push('פחות מ-14 ימי עבודה רצופים אצל המעסיק — אין זכאות לתשלום (ההיעדרות מותרת).');
        break;
      }
      if (sen === null) reasons.push('לא הוזן תאריך תחילת העסקה (נדרשים 14 ימים רצופים אצל המעסיק)');
      if (type === 'local' && det.eligibility !== 'confirmed') reasons.push('בחירות מקומיות: יש לאשר שהעובד רשום בפנקס הבוחרים של הרשות או שמקום העבודה בתחומה');
      if (reasons.length) {
        for (const r of reasons) review(r);
        break;
      }
      rate = 100;
      setBasis('rule');
      ex.push('אינו מנוכה מיתרת החופשה.');
      break;
    }
    case 'unpaid':
      rate = 0;
      ex.push('היעדרות ללא תשלום — אינה נספרת בשעות או בימים המשולמים.');
      break;
    case 'reserve':
      ex.push('מילואים — התגמול משולם לפי נוסחת המוסד לביטוח לאומי (הכנסה ב-3 החודשים שקדמו לשירות ÷ 90, בין רצפה לתקרה) ואינו נכלל בשעות המשולמות כאן.');
      if (nominal > 0) ex.push(`שעות יום לדיווח בלבד: ${formatDurationHe(nominal)} — אינן שעות עבודה ואינן בסיס לתשלום שעתי.`);
      day.paidAbsenceNominalMinutes = 0;
      day.valueBasis = 'statutory_formula';
      return day;
  }

  // 4. Controlled manual override (never below a statutory sick-pay rate).
  if (det.payPercentOverride != null && category !== 'unpaid') {
    const o = Math.max(0, Math.min(100, Math.round(det.payPercentOverride)));
    let applied = o;
    if (category === 'sick' && rate !== null && o < rate) {
      applied = rate;
      ex.push(`ההגדרה הידנית (${o}%) נמוכה מהזכאות לפי החוק (${rate}%) — הוחלה הזכאות לפי החוק.`);
    } else ex.push(`שיעור תשלום ידני: ${applied}%${det.overrideReason ? ` — ${det.overrideReason}` : ''}.`);
    if (!det.overrideReason?.trim()) review('שיעור תשלום ידני ללא נימוק');
    if (category === 'vacation' && applied < 100) review('תשלום חופשה נמוך מ-100% — יש לוודא התאמה לחוק חופשה שנתית');
    rate = applied;
    setBasis('rule');
  }

  day.payPercent = rate;
  day.paidAbsenceEquivalentMinutes = rate === null ? 0 : roundHalfUp((nominal * rate) / 100);
  day.payableEquivalentMinutes = net + day.paidAbsenceEquivalentMinutes;
  const workedPortion = workedToo ? roundHalfUp((1 - fraction) * 100) : 0;
  day.paidAbsenceDayHundredths = scheduled > 0 && rate !== null ? roundHalfUp((day.absenceDayHundredths * rate) / 100) : 0;
  day.paidDayHundredths = Math.min(100, workedPortion + day.paidAbsenceDayHundredths);
  if (rate !== null && nominal > 0)
    ex.push(`שעות משולמות בגין ההיעדרות: ${formatDurationHe(nominal)} × ${rate}% = ${formatDurationHe(day.paidAbsenceEquivalentMinutes)} (שעות שווי, ללא תוספות שעות נוספות; אינן שעות עבודה בפועל).`);
  if (rate === null) ex.push('שיעור התשלום לא נקבע — לא נכללו שעות משולמות עד לבדיקה.');

  // 5. Office valuation (1.1.9): base hourly rate × equivalent hours. Never presented as the statutory amount.
  if (rate !== null && day.paidAbsenceEquivalentMinutes > 0 && PAID_CATEGORIES.includes(category)) {
    if (a.salaryType === 'monthly') {
      day.valueBasis = 'in_salary';
      ex.push('עובד חודשי: יום ההיעדרות משולם במסגרת המשכורת החודשית — לא חושב תשלום נוסף (למניעת תשלום כפול).');
    } else if (s.hourlyRateAgorot && s.hourlyRateAgorot > 0) {
      day.valueBasis = 'office';
      day.estimatedValueAgorot = roundHalfUp((s.hourlyRateAgorot * day.paidAbsenceEquivalentMinutes) / 60);
      ex.push(
        `הערכת ערך לפי הגדרת העסק: ₪${(day.estimatedValueAgorot / 100).toFixed(2)} = שכר שעתי ₪${(s.hourlyRateAgorot / 100).toFixed(2)} × ${formatHM(day.paidAbsenceEquivalentMinutes)} שעות (${formatHM(nominal)} × ${rate}%). זו שיטת חישוב לפי הגדרת העסק ואינה בהכרח הסכום לפי החוק.`,
      );
      if (category === 'vacation') {
        ex.push('לפי חוק חופשה שנתית (ס׳ 10), לעובד שעתי/יומי: שכר יומי ממוצע (שכר 3 החודשים שקדמו לחופשה ÷ 90) × ימי החופשה בלוח. אין להחליף זכאות חוקית גבוהה יותר בהערכה זו.');
        review('דמי החופשה לפי החוק מחושבים לפי השכר בפועל ב-3 החודשים הקודמים — יש להשוות בשכר להערכת המשרד');
      }
      if (category === 'holiday') review('דמי חגים לעובד שעתי/יומי לפי צו ההרחבה מחושבים לפי השכר הממוצע — יש להשוות בשכר להערכת המשרד');
    } else day.valueBasis = 'no_rate';
  }

  // 6. Weekly credit: paid absence hours count toward the weekly regular allowance for LATER work that week.
  if (a.weeklyCredit === 'paid_absence' && PAID_CATEGORIES.includes(category) && rate !== null && rate > 0 && nominal > 0) {
    day.weeklyCreditMinutes = nominal;
    ex.push(`${formatDurationHe(nominal)} נזקפו למכסת השעות השבועית (42) לצורך חישוב שעות נוספות על עבודה בהמשך השבוע. הן אינן שעות נוספות בעצמן.`);
  }
  return day;
}

const HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_DAY = (wd: number) => HE[wd];
const fmt = (d: LocalDate) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
