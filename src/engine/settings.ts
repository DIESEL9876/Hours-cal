import type { CompanyBreakPolicy, EmployeeSettings, LocalDate, SettingsVersion, Weekday } from './types';
import { DEFAULT_LOCATION } from './calendar';

/** Statutory / extension-order constants for the general private-sector profile (see docs/LEGAL_RULES.md). */
export const LAW = {
  /** 2018 extension order: 42-hour week. */
  WEEKLY_REGULAR_MINUTES: 42 * 60,
  /** Five-day week: four days of 8.6 decimal hours = 8:36. */
  FIVE_DAY_NORMAL_MINUTES: 8 * 60 + 36,
  /** Five-day week: one fixed shortened day of 7.6 decimal hours = 7:36. */
  FIVE_DAY_SHORT_MINUTES: 7 * 60 + 36,
  /** Six-day week: Sunday–Thursday 8:00. */
  SIX_DAY_NORMAL_MINUTES: 8 * 60,
  /** Night work / eve of weekly rest / eve of a holiday the employee does not work on: 7:00. */
  SEVEN_HOUR_DAY_MINUTES: 7 * 60,
  /** Overtime tiering (s.16): first two overtime hours of the day at 125%, then 150%. */
  FIRST_TIER_MINUTES: 120,
  /** Night work: at least two hours between 22:00 and 06:00. */
  NIGHT_QUALIFY_MINUTES: 120,
  NIGHT_START: 22 * 60,
  NIGHT_END: 6 * 60,
  /** Compliance limits (warnings only). */
  MAX_DAILY_MINUTES: 12 * 60,
  MAX_WEEKLY_OVERTIME_MINUTES: 16 * 60,
  MAX_WEEKLY_TOTAL_MINUTES: 58 * 60,
  WEEKLY_REST_MINUTES: 36 * 60,
  /** s.20: day of 6+ hours → 45-minute break incl. 30 consecutive; 30 minutes before rest day / holiday. */
  BREAK_QUALIFY_MINUTES: 6 * 60,
  BREAK_MIN_MINUTES: 45,
  BREAK_MIN_EVE_MINUTES: 30,
  BREAK_MAX_MINUTES: 3 * 60,
  /** Sanity limit for a single shift. */
  MAX_SHIFT_MINUTES: 16 * 60,
} as const;

export const DEFAULT_COMPANY_BREAK_POLICY: CompanyBreakPolicy = {
  thresholdMinutes: 600,
  shortBreakMinutes: 30,
  longBreakMinutes: 45,
  minShiftMinutes: 360,
};

export const FIVE_DAY_WORKDAYS: Weekday[] = [0, 1, 2, 3, 4];
export const SIX_DAY_WORKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5];

export function defaultEmployeeSettings(overrides: Partial<EmployeeSettings> = {}): EmployeeSettings {
  const workweek = overrides.workweek ?? 'five';
  return {
    workweek,
    workDays: workweek === 'five' ? [...FIVE_DAY_WORKDAYS] : [...SIX_DAY_WORKDAYS],
    shortDay: workweek === 'five' ? 4 : null,
    workType: 'non_manual',
    legalProfile: 'general_private',
    customProfile: null,
    weeklyRest: { kind: 'shabbat', fixedDay: null, startOffsetMinutes: 0, endOffsetMinutes: 0 },
    holidayCalendar: 'jewish_israel',
    nightRulesEnabled: true,
    breakMethod: 'company_auto',
    companyBreakPolicy: { ...DEFAULT_COMPANY_BREAK_POLICY },
    hourlyRateAgorot: null,
    contractDailyMinutes: null,
    weeklyOvertimeTiering: 'per_day',
    restMinutesCountTowardWeekly: true,
    restBetweenShiftsWarnMinutes: 8 * 60,
    location: DEFAULT_LOCATION,
    ...overrides,
  };
}

/** Earliest possible effective date, used for an employee's initial settings. */
export const BEGINNING_OF_TIME: LocalDate = '1900-01-01';

/** Version in force on a date: the one with the latest effectiveFrom <= date. */
export function resolveSettings(versions: SettingsVersion[], date: LocalDate): SettingsVersion | null {
  let best: SettingsVersion | null = null;
  for (const v of versions) {
    if (v.effectiveFrom <= date && (!best || v.effectiveFrom > best.effectiveFrom)) best = v;
  }
  return best;
}

export function validateSettings(s: EmployeeSettings): string[] {
  const errors: string[] = [];
  if (s.workDays.length === 0) errors.push('יש לבחור לפחות יום עבודה אחד');
  if (s.workweek === 'five' && s.shortDay !== null && !s.workDays.includes(s.shortDay))
    errors.push('היום המקוצר חייב להיות אחד מימי העבודה');
  const p = s.companyBreakPolicy;
  for (const [k, v] of Object.entries(p)) if (!Number.isInteger(v) || v < 0) errors.push(`ערך לא תקין במדיניות ההפסקות (${k})`);
  if (p.longBreakMinutes < p.shortBreakMinutes) errors.push('ההפסקה הארוכה קצרה מההפסקה הקצרה');
  if (s.hourlyRateAgorot !== null && (!Number.isInteger(s.hourlyRateAgorot) || s.hourlyRateAgorot < 0))
    errors.push('שכר שעתי לא תקין');
  if (s.contractDailyMinutes !== null && (!Number.isInteger(s.contractDailyMinutes) || s.contractDailyMinutes <= 0))
    errors.push('היקף משרה יומי לא תקין');
  if (s.legalProfile === 'custom_contract' && !s.customProfile) errors.push('יש להגדיר תקנים לפרופיל הסכמי');
  if (s.weeklyRest.kind === 'fixed_day' && s.weeklyRest.fixedDay === null) errors.push('יש לבחור יום מנוחה');
  return errors;
}
