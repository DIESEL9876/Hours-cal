/**
 * Attendance calculation engine — pure, deterministic, integer minutes.
 *
 * Order of operations per shift (never changed):
 *   1. validate entry/exit           2. gross minutes            3. break rule
 *   4. deductible break              5. validate break           6. net minutes
 *   7. daily threshold classification                           8. weekly classification (no double counting)
 *   9. explanation + warnings
 *
 * Every net worked minute is materialised once in a chronological timeline and assigned to exactly ONE
 * bucket (regular / 125 / 150, optionally with a weekly-rest or holiday premium). Summing the buckets
 * therefore always equals net minutes.
 */
import type {
  DayResult,
  DayStatus,
  EmployeePeriodInput,
  EmployeePeriodResult,
  EmployeeSettings,
  LocalDate,
  MinuteBuckets,
  PeriodTotals,
  PaidDayInfo,
  AgreementHoursRule,
  AgreementPayRule,
  Premium,
  SettingsVersion,
  ShiftInput,
  ShiftResult,
  Tier,
  WeekResult,
  Warning,
  Weekday,
} from './types';
import { CalendarContext, type Interval } from './calendar';
import { calculateDeductibleBreakMinutes, calculateNetWorkedMinutes } from './breaks';
import { fridayPolicyOn, LAW, OFFICE_POLICY, resolveAbsenceSettings, resolveSettings } from './settings';
import { absenceHistoryFrom, computeDayAttendance, emptyDayAttendance, sumAttendance, type AbsenceContext, type DayAverage } from './absence';
import { birthdayOn, checkYouthDayV1, checkYouthDayV2, checkYouthWeekV1, checkYouthWeekV2, inSchoolVacation, PROHIBITED_WORK_TEXT, youthStatusOn, type YouthDayOutcome } from './youth';
import {
  addDays,
  eachDate,
  formatDurationHe,
  formatHM,
  HEBREW_WEEKDAYS,
  localToUtc,
  MINUTE_MS,
  parseDateTime,
  utcToLocal,
  weekdayOf,
  weekStartOf,
} from './time';

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export function emptyBuckets(): MinuteBuckets {
  return {
    regular: 0,
    ot125: 0,
    ot150: 0,
    rest150: 0,
    rest175: 0,
    rest200: 0,
    holiday150: 0,
    holiday175: 0,
    holiday200: 0,
    unclassified: 0,
  };
}

export function bucketKey(tier: Tier, premium: Premium): keyof MinuteBuckets {
  if (premium === 'none') return tier;
  const suffix = tier === 'regular' ? '150' : tier === 'ot125' ? '175' : '200';
  return `${premium}${suffix}` as keyof MinuteBuckets;
}

/** Pay percentage of each bucket. */
export const BUCKET_PERCENT: Record<keyof MinuteBuckets, number> = {
  regular: 100,
  ot125: 125,
  ot150: 150,
  rest150: 150,
  rest175: 175,
  rest200: 200,
  holiday150: 150,
  holiday175: 175,
  holiday200: 200,
  unclassified: 100,
};

export function sumBuckets(b: MinuteBuckets): number {
  let s = 0;
  for (const k of Object.keys(b) as (keyof MinuteBuckets)[]) s += b[k];
  return s;
}

export function addBuckets(into: MinuteBuckets, b: MinuteBuckets): void {
  for (const k of Object.keys(b) as (keyof MinuteBuckets)[]) into[k] += b[k];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function calculateGrossMinutes(startUtcMs: number, endUtcMs: number): number {
  const diff = endUtcMs - startUtcMs;
  if (diff % MINUTE_MS !== 0) throw new Error('timestamps must be minute aligned');
  return diff / MINUTE_MS;
}

/** Night work: at least 120 worked minutes between 22:00 and 06:00 (local). */
export function detectNightShift(nightMinutes: number): boolean {
  return nightMinutes >= LAW.NIGHT_QUALIFY_MINUTES;
}

export function isNightMinute(minuteOfDay: number): boolean {
  return minuteOfDay >= LAW.NIGHT_START || minuteOfDay < LAW.NIGHT_END;
}

/**
 * Split a day's net minutes against the daily threshold (no weekly context).
 * Returns regular minutes, 125% and 150% overtime.
 */
export function classifyDailyOvertime(
  netMinutes: number,
  thresholdMinutes: number,
  firstTierMinutes: number = LAW.FIRST_TIER_MINUTES,
): { regular: number; ot125: number; ot150: number } {
  const regular = Math.min(netMinutes, thresholdMinutes);
  const ot = netMinutes - regular;
  const ot125 = Math.min(ot, firstTierMinutes);
  return { regular, ot125, ot150: ot - ot125 };
}

export interface ThresholdInfo {
  minutes: number | null;
  weeklyMinutes: number | null;
  firstTierMinutes: number;
  reasons: string[];
  scheduled: boolean;
  shortDay: boolean;
  restEve: boolean;
  holidayEve: boolean;
  /** The 7-hour reduction for eve/holiday-eve changed the threshold (uncertain for some arrangements). */
  eveReductionApplied: boolean;
}

export function getApplicableDailyThreshold(
  date: LocalDate,
  settings: EmployeeSettings,
  cal: CalendarContext,
  isNight: boolean,
  agreement?: AgreementHoursRule | null,
): ThresholdInfo {
  const wd = weekdayOf(date);
  const scheduled = settings.workDays.includes(wd);
  const restEve = cal.isRestEve(date, settings);
  const holidayEve = cal.isHolidayEve(date, settings);
  const reasons: string[] = [];
  const info: ThresholdInfo = {
    minutes: null,
    weeklyMinutes: null,
    firstTierMinutes: LAW.FIRST_TIER_MINUTES,
    reasons,
    scheduled,
    shortDay: false,
    restEve,
    holidayEve,
    eveReductionApplied: false,
  };
  if (settings.legalProfile === 'exempt' || settings.legalProfile === 'minor') return info;

  let base: number;
  let applyReductions = true;
  if (agreement) {
    // Verified agreement rule profile (1.1.9) — applied like a contractual profile, with its citation.
    base = agreement.dailyThresholdMinutes[wd];
    info.weeklyMinutes = agreement.weeklyThresholdMinutes;
    info.firstTierMinutes = agreement.firstTierMinutes;
    reasons.push(`תקן לפי ${agreement.source}: ${formatDurationHe(base)}`);
  } else if (settings.legalProfile === 'custom_contract' && settings.customProfile) {
    const cp = settings.customProfile;
    base = cp.dailyThresholdMinutes[wd];
    info.weeklyMinutes = cp.weeklyThresholdMinutes;
    info.firstTierMinutes = cp.firstTierMinutes;
    applyReductions = cp.applyStatutoryReductions;
    reasons.push(`תקן הסכמי (${cp.label}): ${formatDurationHe(base)}`);
  } else if (settings.workweek === 'five') {
    info.weeklyMinutes = LAW.WEEKLY_REGULAR_MINUTES;
    // Office policy 8:24, but never less favourable than the statute (8:36 normal day / 7:36 shortened day).
    const office = OFFICE_POLICY.FIVE_DAY_DAILY_MINUTES;
    const isShort = scheduled && settings.shortDay === wd;
    const statutory = isShort ? LAW.FIVE_DAY_SHORT_MINUTES : LAW.FIVE_DAY_NORMAL_MINUTES;
    base = Math.min(office, statutory);
    info.shortDay = isShort;
    const officeHe = formatDurationHe(office);
    const statHe = formatDurationHe(statutory);
    if (isShort)
      reasons.push(
        base === statutory
          ? `שבוע עבודה בן 5 ימים – היום המקוצר: ${statHe} (התקן החוקי, מיטיב ממדיניות המשרד של ${officeHe})`
          : `שבוע עבודה בן 5 ימים – היום המקוצר: ${officeHe} (מדיניות המשרד, מיטיבה מהתקן החוקי של ${statHe})`,
      );
    else if (scheduled)
      reasons.push(
        base === office
          ? `שבוע עבודה בן 5 ימים – תקן יומי לפי מדיניות המשרד: ${officeHe} (מיטיב מהתקן החוקי של ${statHe})`
          : `שבוע עבודה בן 5 ימים – יום רגיל: ${statHe} (התקן החוקי)`,
      );
    else reasons.push(`יום שאינו יום עבודה רגיל בשבוע בן 5 ימים – נבדק לפי תקן של ${formatDurationHe(base)} ובכפוף לתקן השבועי`);
  } else {
    info.weeklyMinutes = LAW.WEEKLY_REGULAR_MINUTES;
    base = LAW.SIX_DAY_NORMAL_MINUTES;
    reasons.push(scheduled ? 'שבוע עבודה בן 6 ימים – 8 שעות ביום' : 'יום שאינו יום עבודה רגיל – נבדק לפי 8 שעות ובכפוף לתקן השבועי');
  }

  let minutes = base;
  if (applyReductions) {
    const seven = LAW.SEVEN_HOUR_DAY_MINUTES;
    if (restEve && minutes > seven) {
      minutes = seven;
      info.eveReductionApplied = true;
      reasons.push('יום שלפני המנוחה השבועית – תקן של 7 שעות');
    }
    if (holidayEve && minutes > seven) {
      minutes = seven;
      info.eveReductionApplied = true;
      reasons.push('ערב חג – תקן של 7 שעות');
    }
    if (isNight && settings.nightRulesEnabled && minutes > seven) {
      minutes = seven;
      reasons.push('משמרת לילה (שעתיים לפחות בין 22:00 ל-06:00) – תקן של 7 שעות');
    }
  }
  info.minutes = minutes;
  return info;
}

// ---------------------------------------------------------------------------
// Shift processing
// ---------------------------------------------------------------------------

interface WorkedMinute {
  ms: number;
  premium: Premium;
}

interface ProcessedShift {
  result: ShiftResult;
  startMs: number | null;
  endMs: number | null;
  minutes: WorkedMinute[];
}

function warn(list: Warning[], code: string, severity: Warning['severity'], message: string, date?: LocalDate, shiftId?: string) {
  list.push({ code, severity, message, date, shiftId });
}

function emptyBreak(): ShiftResult['break'] {
  return { kind: 'none', suggestedMinutes: 0, deductedMinutes: 0, paidMinutes: 0, unconfirmed: false, positioned: false, rule: '' };
}

export function validateAttendanceRecord(shift: ShiftInput): Warning[] {
  const out: Warning[] = [];
  const hasStart = !!shift.startAt;
  const hasEnd = !!shift.endAt;
  if (!hasStart && !hasEnd) return out;
  if (hasStart !== hasEnd) {
    warn(out, 'INCOMPLETE', 'error', hasStart ? 'נרשמה כניסה ללא יציאה – רישום חסר' : 'נרשמה יציאה ללא כניסה – רישום חסר', shift.workDate, shift.id);
    return out;
  }
  let s: { date: string; minutes: number };
  let e: { date: string; minutes: number };
  try {
    s = parseDateTime(shift.startAt!);
    e = parseDateTime(shift.endAt!);
  } catch {
    warn(out, 'INVALID_TIME', 'error', 'שעת כניסה או יציאה לא תקינה', shift.workDate, shift.id);
    return out;
  }
  if (s.date !== shift.workDate) warn(out, 'START_DATE_MISMATCH', 'error', 'תאריך תחילת המשמרת אינו תואם לשורת היום', shift.workDate, shift.id);
  if (shift.endAt! <= shift.startAt!) warn(out, 'NEGATIVE_DURATION', 'error', 'שעת היציאה אינה מאוחרת משעת הכניסה', shift.workDate, shift.id);
  if (e.date > addDays(s.date, 1)) warn(out, 'SHIFT_TOO_LONG', 'error', 'משמרת אינה יכולה להימשך יותר מיממה', shift.workDate, shift.id);
  if (shift.breakMinutes !== null && (!Number.isInteger(shift.breakMinutes) || shift.breakMinutes < 0))
    warn(out, 'BREAK_INVALID', 'error', 'משך הפסקה לא תקין', shift.workDate, shift.id);
  return out;
}

function processShift(
  shift: ShiftInput,
  settings: EmployeeSettings,
  cal: CalendarContext,
): ProcessedShift {
  const warnings = validateAttendanceRecord(shift);
  const result: ShiftResult = {
    shiftId: shift.id,
    workDate: shift.workDate,
    startAt: shift.startAt,
    endAt: shift.endAt,
    valid: false,
    incomplete: false,
    grossMinutes: 0,
    break: emptyBreak(),
    netMinutes: 0,
    nightMinutes: 0,
    isNightShift: false,
    restMinutes: 0,
    holidayMinutes: 0,
    warnings,
  };
  const out: ProcessedShift = { result, startMs: null, endMs: null, minutes: [] };
  if (!shift.startAt && !shift.endAt) return out;
  if (warnings.some((w) => w.code === 'INCOMPLETE')) {
    result.incomplete = true;
    return out;
  }
  if (warnings.some((w) => w.severity === 'error')) return out;

  // 1-2. timestamps → gross
  const s = localToUtc(shift.startAt!);
  const e = localToUtc(shift.endAt!);
  if (s.nonexistent || e.nonexistent) {
    warn(warnings, 'NONEXISTENT_TIME', 'error', 'השעה שהוזנה אינה קיימת (מעבר לשעון קיץ)', shift.workDate, shift.id);
    return out;
  }
  if (s.ambiguous || e.ambiguous)
    warn(warnings, 'AMBIGUOUS_TIME', 'review', 'השעה שהוזנה מופיעה פעמיים (מעבר לשעון חורף) – חושב לפי ההופעה הראשונה', shift.workDate, shift.id);
  const startMs = s.utcMs!;
  const endMs = e.utcMs!;
  if (endMs <= startMs) {
    warn(warnings, 'NEGATIVE_DURATION', 'error', 'משך משמרת שלילי או אפס', shift.workDate, shift.id);
    return out;
  }
  out.startMs = startMs;
  out.endMs = endMs;
  const gross = calculateGrossMinutes(startMs, endMs);
  result.grossMinutes = gross;
  if (gross > LAW.MAX_SHIFT_MINUTES)
    warn(warnings, 'LONG_SHIFT', 'review', `משמרת ארוכה במיוחד (${formatHM(gross)}) – יש לוודא שהרישום נכון`, shift.workDate, shift.id);

  // 3-5. break
  const isEve = cal.isRestEve(shift.workDate, settings) || cal.isHolidayEve(shift.workDate, settings);
  const br = calculateDeductibleBreakMinutes(gross, shift, settings, { isEve });
  result.break = br.result;
  warnings.push(...br.warnings);
  if (br.warnings.some((w) => w.severity === 'error')) return out;

  let breakStartMs: number | null = null;
  const deducted = br.result.deductedMinutes;
  if (deducted > 0) {
    if (shift.breakStart) {
      const b = localToUtc(shift.breakStart);
      if (b.utcMs === null || b.utcMs < startMs || b.utcMs + deducted * MINUTE_MS > endMs) {
        warn(warnings, 'BREAK_OUTSIDE_SHIFT', 'error', 'שעת ההפסקה אינה בתוך המשמרת', shift.workDate, shift.id);
        return out;
      }
      breakStartMs = b.utcMs;
    } else {
      // Deterministic assumption: break centred in the shift.
      breakStartMs = startMs + Math.floor((gross - deducted) / 2) * MINUTE_MS;
    }
  }

  // 6. net minutes timeline
  const restWindows: Interval[] = [];
  const holidayWindows: { iv: Interval; name: string }[] = [];
  for (let d = addDays(shift.workDate, -1); d <= addDays(shift.workDate, 2); d = addDays(d, 1)) {
    if (cal.isRestDay(d, settings)) restWindows.push(cal.restWindow(d, settings));
    const h = cal.holidayOn(d, settings);
    if (h) holidayWindows.push({ iv: cal.holidayWindow(h, settings), name: h.name });
  }
  const inAny = (ms: number, ivs: Interval[]) => ivs.some((iv) => ms >= iv.startMs && ms < iv.endMs);
  const breakEnd = breakStartMs === null ? null : breakStartMs + deducted * MINUTE_MS;
  let grossNight = 0;
  const premiumsSeen = new Set<Premium>();
  let holidayName: string | null = null;
  for (let t = startMs; t < endMs; t += MINUTE_MS) {
    const nightMin = isNightMinute(utcToLocal(t).minuteOfDay);
    if (nightMin) grossNight++;
    let premium: Premium = 'none';
    if (inAny(t, restWindows)) premium = 'rest';
    else {
      const h = holidayWindows.find((x) => t >= x.iv.startMs && t < x.iv.endMs);
      if (h) {
        premium = 'holiday';
        holidayName = h.name;
      }
    }
    premiumsSeen.add(premium);
    if (breakStartMs !== null && t >= breakStartMs && t < breakEnd!) continue;
    if (nightMin) result.nightMinutes++;
    if (premium === 'rest') result.restMinutes++;
    if (premium === 'holiday') result.holidayMinutes++;
    out.minutes.push({ ms: t, premium });
  }
  result.netMinutes = calculateNetWorkedMinutes(gross, deducted);
  if (out.minutes.length !== result.netMinutes) throw new Error('internal: net minute mismatch');
  result.isNightShift = detectNightShift(result.nightMinutes);
  result.valid = true;

  if (deducted > 0 && !shift.breakStart) {
    if (premiumsSeen.size > 1)
      warn(warnings, 'BREAK_POSITION_ASSUMED', 'review', 'שעת ההפסקה לא הוזנה והמשמרת חוצה את גבול המנוחה/החג – ההפסקה הונחה באמצע המשמרת', shift.workDate, shift.id);
    if (detectNightShift(grossNight) !== result.isNightShift)
      warn(warnings, 'NIGHT_BREAK_DEPENDENT', 'review', 'סיווג משמרת לילה תלוי במיקום ההפסקה, שלא הוזן – יש לבדוק', shift.workDate, shift.id);
  }
  if (result.restMinutes > 0) {
    warn(
      warnings,
      'WORK_ON_WEEKLY_REST',
      'compliance',
      `עבודה במנוחה השבועית (${formatDurationHe(result.restMinutes)}) – מחייבת היתר; גמול של 150% לפחות. יש לבדוק מנוחה חלופית`,
      shift.workDate,
      shift.id,
    );
    if (settings.weeklyRest.kind === 'fixed_day')
      warn(warnings, 'REST_WINDOW_REVIEW', 'review', 'חלון המנוחה השבועית הוגדר כיממה קלנדרית – יש לאשר את התחום בפועל', shift.workDate, shift.id);
  }
  if (result.holidayMinutes > 0)
    warn(
      warnings,
      'HOLIDAY_WORK',
      'review',
      `עבודה בחג${holidayName ? ` (${holidayName})` : ''} – ${formatDurationHe(result.holidayMinutes)}. שיעור הגמול (ברירת מחדל 150%) תלוי בהסדר החל – יש לאשר`,
      shift.workDate,
      shift.id,
    );
  return out;
}

// ---------------------------------------------------------------------------
// Period calculation
// ---------------------------------------------------------------------------

/** Data range the caller must load so that weekly calculations around [from, to] are complete. */
export function requiredDataRange(from: LocalDate, to: LocalDate): { from: LocalDate; to: LocalDate } {
  return { from: addDays(weekStartOf(from), -2), to: addDays(weekStartOf(to), 6 + 2) };
}

interface DayWork {
  date: LocalDate;
  version: SettingsVersion | null;
  shifts: ProcessedShift[];
  status: DayStatus | null;
  result: DayResult;
  minutes: WorkedMinute[];
  threshold: ThresholdInfo | null;
  od: { daily125: number; daily150: number; weekly125: number; weekly150: number; friday125: number; friday150: number };
  payUnits: number | null;
  /** Five-day week, Friday, office policy "all Friday hours are overtime". */
  fridayAll: boolean;
  /** Paid-absence minutes credited to the weekly allowance earlier in the same week. */
  weekCreditBefore?: number;
}

export function calculateEmployeePeriod(input: EmployeePeriodInput, opts: { skipAbsence?: boolean } = {}): EmployeePeriodResult {
  // With a date of birth, age rules take precedence (1.1.9): the legacy "minor" profile (unclassified hours) is replaced by the
  // general classification plus per-date youth checks.
  const minorProfileSet = input.settingsVersions.some((v) => v.settings.legalProfile === 'minor');
  if (input.birthDate && minorProfileSet)
    input = { ...input, settingsVersions: input.settingsVersions.map((v) => (v.settings.legalProfile === 'minor' ? { ...v, settings: { ...v.settings, legalProfile: 'general_private' } } : v)) };
  const youthOn = (date: LocalDate) => youthStatusOn(input.birthDate, date)?.minor === true;
  const youthRuleSet = input.youthRuleSet ?? 'Y2';
  const { from, to } = input;
  if (from > to) throw new Error('from > to');
  const calcFrom = weekStartOf(from);
  const calcTo = addDays(weekStartOf(to), 6);
  const cal = new CalendarContext(addDays(calcFrom, -3), addDays(calcTo, 3), input.customHolidays);
  const periodWarnings: Warning[] = [];

  const statusByDate = new Map(input.dayStatuses.map((s) => [s.date, s]));
  const shiftsByDate = new Map<LocalDate, ShiftInput[]>();
  for (const s of input.shifts) {
    const list = shiftsByDate.get(s.workDate) ?? [];
    list.push(s);
    shiftsByDate.set(s.workDate, list);
  }

  // Process every shift in the extended data range (needed for rest-between-shifts and weekly-rest checks).
  const allProcessed: ProcessedShift[] = [];
  const dayWork = new Map<LocalDate, DayWork>();
  const ext = requiredDataRange(from, to);
  for (const date of eachDate(ext.from, ext.to)) {
    const version = resolveSettings(input.settingsVersions, date);
    const raw = (shiftsByDate.get(date) ?? []).slice().sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
    const processed = version ? raw.map((s) => processShift(s, version.settings, cal)) : [];
    allProcessed.push(...processed);
    if (date < calcFrom || date > calcTo) continue;
    const wd = weekdayOf(date) as Weekday;
    const holiday = version ? cal.holidayOn(date, version.settings) : null;
    const dr: DayResult = {
      date,
      weekday: wd,
      settingsVersionId: version?.id ?? null,
      legalProfile: version?.settings.legalProfile ?? null,
      scheduled: false,
      shortDay: false,
      restEve: false,
      holidayEve: false,
      holidayName: holiday?.name ?? null,
      isRestDay: version ? cal.isRestDay(date, version.settings) : wd === 6,
      status: statusByDate.get(date)?.status ?? null,
      shifts: processed.map((p) => p.result),
      worked: false,
      grossMinutes: 0,
      breakMinutes: 0,
      paidBreakMinutes: 0,
      netMinutes: 0,
      dailyThresholdMinutes: null,
      thresholdReasons: [],
      isNight: false,
      dailyOvertimeMinutes: 0,
      weeklyOvertimeMinutes: 0,
      contractExcessMinutes: 0,
      buckets: emptyBuckets(),
      warnings: [],
      explanation: [],
      payAgorot: null,
      attendance: emptyDayAttendance(0, statusByDate.get(date)?.status ?? null),
    };
    if (!version && raw.length > 0) warn(dr.warnings, 'NO_SETTINGS', 'error', 'אין הגדרות עובד בתוקף לתאריך זה', date);
    dayWork.set(date, {
      date,
      version,
      shifts: processed,
      status: statusByDate.get(date) ?? null,
      result: dr,
      minutes: [],
      threshold: null,
      od: { daily125: 0, daily150: 0, weekly125: 0, weekly150: 0, friday125: 0, friday150: 0 },
      payUnits: null,
      fridayAll: false,
    });
  }

  // Overlap / duplicate detection across all valid shifts.
  const timed = allProcessed.filter((p) => p.result.valid).sort((a, b) => a.startMs! - b.startMs!);
  const invalidated = new Set<ShiftResult>();
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].startMs! < timed[i].endMs!; j++) {
      const a = timed[i].result;
      const b = timed[j].result;
      const dup = timed[i].startMs === timed[j].startMs && timed[i].endMs === timed[j].endMs;
      for (const r of [a, b]) {
        warn(r.warnings, dup ? 'DUPLICATE_SHIFT' : 'OVERLAPPING_SHIFT', 'error', dup ? 'משמרת כפולה – אותן שעות נרשמו פעמיים' : 'משמרות חופפות בזמן', r.workDate, r.shiftId);
        invalidated.add(r);
      }
    }
  }
  for (const p of allProcessed) {
    if (invalidated.has(p.result)) {
      p.result.valid = false;
      p.minutes = [];
    }
  }

  // Per-day aggregation of shift data.
  for (const dw of dayWork.values()) {
    const dr = dw.result;
    for (const p of dw.shifts) {
      dr.warnings.push(...p.result.warnings);
      if (!p.result.valid) continue;
      dr.grossMinutes += p.result.grossMinutes;
      dr.breakMinutes += p.result.break.deductedMinutes;
      dr.paidBreakMinutes += p.result.break.paidMinutes;
      dr.netMinutes += p.result.netMinutes;
      dw.minutes.push(...p.minutes);
      if (p.result.isNightShift) dr.isNight = true;
    }
    dw.minutes.sort((a, b) => a.ms - b.ms);
    dr.worked = dr.netMinutes > 0;
    if (dw.status) {
      if (dw.status.status === 'missing_record')
        warn(dr.warnings, 'MISSING_RECORD', 'error', 'היום סומן כ"רישום חסר" – יש להשלים את הנתונים', dr.date);
      // "עבודה רגילה" and a partial-day absence (1.1.7) are not a conflict with recorded work.
      else if (dr.worked && dw.status.status !== 'work' && !dw.status.absence?.minutes)
        warn(dr.warnings, 'STATUS_CONFLICT', 'review', 'ליום שסומן כהיעדרות נרשמו גם שעות עבודה', dr.date);
    }
    if (dw.version) {
      const s = dw.version.settings;
      const agreementRule = input.agreementHours?.find((r) => dr.date >= r.from && (r.to === null || dr.date <= r.to)) ?? null;
      const t = getApplicableDailyThreshold(dr.date, s, cal, dr.isNight, agreementRule);
      dw.threshold = t;
      dr.scheduled = t.scheduled;
      dr.shortDay = t.shortDay;
      dr.restEve = t.restEve;
      dr.holidayEve = t.holidayEve;
      dr.dailyThresholdMinutes = t.minutes;
      dr.thresholdReasons = t.reasons;
      dw.fridayAll = s.workweek === 'five' && dr.weekday === 5 && t.minutes !== null && fridayPolicyOn(s, dr.date, input.businessFriday) === 'all_overtime';
      if (dr.worked) {
        if (dw.fridayAll) dr.fridayOvertimeApplied = true;
        else if (!t.scheduled && s.legalProfile !== 'exempt' && s.legalProfile !== 'minor')
          warn(
            dr.warnings,
            'UNSCHEDULED_DAY_WORK',
            'review',
            `עבודה ביום ${HEBREW_WEEKDAYS[dr.weekday]} שאינו יום עבודה רגיל – השעות סווגו לפי התקן היומי והשבועי ולא אוטומטית כשעות נוספות. יש לבדוק את ההסכם`,
            dr.date,
          );
        if (t.eveReductionApplied && t.minutes !== null && dr.netMinutes > t.minutes)
          warn(dr.warnings, 'EVE_THRESHOLD_REVIEW', 'review', 'הופעל תקן מקוצר של 7 שעות (ערב מנוחה/ערב חג) – יש לוודא שהוא חל על הסדר העבודה', dr.date);
        if (dr.netMinutes > LAW.MAX_DAILY_MINUTES && !youthOn(dr.date))
          warn(dr.warnings, 'DAILY_LIMIT', 'compliance', `יום עבודה של ${formatHM(dr.netMinutes)} שעות – חורג מהמגבלה של 12 שעות ביום כולל שעות נוספות`, dr.date);
      }
    }
  }

  // Actual vs. paid attendance (user-classified absences only). Computed before the weekly classification
  // because qualifying paid absences may credit the weekly allowance for later work in the same week.
  const credits = new Map<LocalDate, number>();
  let paidDayInfo: PaidDayInfo | null = null;
  if (!opts.skipAbsence) {
    const historyFrom = input.historyFrom && input.historyFrom < ext.from ? input.historyFrom : ext.from;
    let history: Map<LocalDate, number> | null = null;
    const historyNet = () => {
      if (!history) {
        history = new Map();
        if (historyFrom < ext.from) {
          const h = calculateEmployeePeriod({ ...input, from: historyFrom, to: addDays(ext.from, -1) }, { skipAbsence: true });
          for (const d of h.days) history.set(d.date, d.netMinutes);
        }
      }
      return history;
    };
    const netByDate = (date: LocalDate) => dayWork.get(date)?.result.netMinutes ?? historyNet().get(date) ?? 0;
    const wideCal = new CalendarContext(addDays(historyFrom, -3), addDays(calcTo, 14), input.customHolidays);
    const avgCache = new Map<string, DayAverage | null>();
    const average = (from: LocalDate, to: LocalDate): DayAverage | null => {
      if (from < historyFrom) return null;
      let workedMinutes = 0;
      let days = 0;
      for (const d of eachDate(from, to)) {
        const n = netByDate(d);
        if (n > 0) {
          workedMinutes += n;
          days++;
        }
      }
      return { from, to, days, workedMinutes, minutes: days ? Math.floor(workedMinutes / days + 0.5) : 0 };
    };
    const ctx: AbsenceContext = {
      statusByDate,
      netByDate,
      versionOn: (date) => resolveSettings(input.settingsVersions, date),
      scheduledMinutes: (date, st) => scheduledDayMinutes(date, st, wideCal),
      averageDaily: (date) => {
        const key = `3m:${date.slice(0, 7)}`;
        if (!avgCache.has(key)) {
          const w = absenceAverageWindow(date);
          avgCache.set(key, average(w.from, w.to));
        }
        return avgCache.get(key)!;
      },
      averageMonth: (date) => {
        const key = `m:${date.slice(0, 7)}`;
        if (!avgCache.has(key)) {
          const first = `${date.slice(0, 7)}-01`;
          avgCache.set(key, average(first, addDays(addMonthsFirst(first, 1), -1)) ?? { from: first, to: first, days: 0, workedMinutes: 0, minutes: 0 });
        }
        return avgCache.get(key)!;
      },
      paidDayOverride: (date) => input.paidDayOverrides?.find((o) => o.ym === date.slice(0, 7)) ?? null,
      business: input.businessAbsence,
      cal: wideCal,
      historyFrom,
    };
    paidDayInfo = describePaidDay(from, input, ctx, scheduledDayMinutes, wideCal);
    for (const dw of dayWork.values()) {
      dw.result.attendance = computeDayAttendance(dw.date, dw.status, ctx);
      if (dw.result.attendance.weeklyCreditMinutes) credits.set(dw.date, dw.result.attendance.weeklyCreditMinutes);
    }
  }

  // Weekly classification — chronological, Sunday→Saturday, across month boundaries.
  const weeks: WeekResult[] = [];
  for (let ws = calcFrom; ws <= calcTo; ws = addDays(ws, 7)) {
    const we = addDays(ws, 6);
    const week: WeekResult = {
      weekStart: ws,
      weekEnd: we,
      netMinutes: 0,
      regularCountedMinutes: 0,
      weeklyThresholdMinutes: null,
      dailyOvertimeMinutes: 0,
      weeklyOvertimeMinutes: 0,
      warnings: [],
    };
    let weeklyRegular = 0;
    let weeklyOtCount = 0;
    let weekCredit = 0;
    for (const date of eachDate(ws, we)) {
      const dw = dayWork.get(date)!;
      const dr = dw.result;
      week.netMinutes += dr.netMinutes;
      // A paid absence of this day counts toward the weekly allowance only for work AFTER it (added at the end).
      const credit = credits.get(date) ?? 0;
      dw.weekCreditBefore = weekCredit;
      const addCredit = () => {
        if (credit) {
          weeklyRegular += credit;
          weekCredit += credit;
        }
      };
      if (!dw.version || dw.minutes.length === 0) {
        addCredit();
        continue;
      }
      const s = dw.version.settings;
      const t = dw.threshold!;
      if (t.minutes === null || t.weeklyMinutes === null) {
        dr.buckets.unclassified += dw.minutes.length;
        addCredit();
        continue;
      }
      week.weeklyThresholdMinutes = t.weeklyMinutes;
      let dayOtCount = 0;
      let dailyOtCount = 0;
      const contract = s.contractDailyMinutes;
      dw.minutes.forEach((m, i) => {
        const countsWeekly = s.restMinutesCountTowardWeekly || m.premium === 'none';
        let tier: Tier;
        if (dw.fridayAll) {
          // Office policy: every net Friday minute is overtime — first 2 hours 125%, then 150% — whatever
          // the weekly total. Never counted as regular, so weekly overtime cannot count it again. The
          // minute keeps its weekly-rest / holiday premium (bucketKey below), which only raises the rate.
          tier = dayOtCount < t.firstTierMinutes ? 'ot125' : 'ot150';
          dayOtCount++;
          dailyOtCount++;
          dr.dailyOvertimeMinutes++;
          if (tier === 'ot125') dw.od.friday125++;
          else dw.od.friday150++;
        } else if (i >= t.minutes!) {
          // daily overtime
          const idx = s.weeklyOvertimeTiering === 'per_week' ? dailyOtCount : dayOtCount;
          tier = idx < t.firstTierMinutes ? 'ot125' : 'ot150';
          dailyOtCount++;
          dayOtCount++;
          dr.dailyOvertimeMinutes++;
          if (tier === 'ot125') dw.od.daily125++;
          else dw.od.daily150++;
        } else if (countsWeekly && weeklyRegular >= t.weeklyMinutes!) {
          // weekly overtime: weekly allowance exhausted
          const idx = s.weeklyOvertimeTiering === 'per_week' ? weeklyOtCount : dayOtCount;
          tier = idx < t.firstTierMinutes ? 'ot125' : 'ot150';
          weeklyOtCount++;
          dayOtCount++;
          dr.weeklyOvertimeMinutes++;
          if (tier === 'ot125') dw.od.weekly125++;
          else dw.od.weekly150++;
        } else {
          tier = 'regular';
          if (countsWeekly) weeklyRegular++;
          if (contract !== null && i >= contract) dr.contractExcessMinutes++;
        }
        dr.buckets[bucketKey(tier, m.premium)]++;
      });
      week.dailyOvertimeMinutes += dr.dailyOvertimeMinutes;
      week.weeklyOvertimeMinutes += dr.weeklyOvertimeMinutes;
      addCredit();
    }
    week.regularCountedMinutes = weeklyRegular;
    if (weekCredit) week.absenceCreditMinutes = weekCredit;

    // Weekly compliance checks (attached to the last worked day of the week inside the period).
    const weekOt = week.dailyOvertimeMinutes + week.weeklyOvertimeMinutes;
    // Minors: the adult overtime-permit limits do not apply — the youth limits below do (overtime is prohibited).
    const youthDates = eachDate(ws, we).filter((d) => youthOn(d) && (dayWork.get(d)?.result.netMinutes ?? 0) > 0);
    // Rule set Y1 (1.1.9) checks the week here; Y2 after the daily youth pass (daily excess first, then weekly).
    if (youthDates.length && youthRuleSet === 'Y1') week.warnings.push(...checkYouthWeekV1(youthDates[youthDates.length - 1], youthDates.reduce((a, d) => a + dayWork.get(d)!.result.netMinutes, 0)));
    if (youthDates.length) {
      // adult weekly limits skipped for weeks with youth work
    } else if (weekOt > LAW.MAX_WEEKLY_OVERTIME_MINUTES)
      warn(week.warnings, 'WEEKLY_OT_LIMIT', 'compliance', `בשבוע זה ${formatHM(weekOt)} שעות נוספות – מעל המכסה הכללית של 16 שעות שבועיות`, we);
    if (week.netMinutes > LAW.MAX_WEEKLY_TOTAL_MINUTES && !youthDates.length)
      warn(week.warnings, 'WEEKLY_TOTAL_LIMIT', 'compliance', `סך שעות העבודה בשבוע (${formatHM(week.netMinutes)}) עולה על 58 שעות`, we);
    checkWeeklyRest(ws, we, dayWork, timed, cal, week.warnings, youthRuleSet === 'Y2' ? youthOn : undefined);
    weeks.push(week);
  }

  // (1.1.12, req 11) The optional office "rest between shifts" warning was removed. It was a configurable,
  // non-statutory office threshold, not a verified legal check; the setting and its warning no longer exist.

  // Youth Employment Law checks per attendance date. Warnings only — worked minutes and pay are never changed.
  const youthOutcomes = new Map<LocalDate, YouthDayOutcome>();
  const youthWeekly = new Map<LocalDate, number>();
  if (input.birthDate) {
    for (const dw of dayWork.values()) {
      const y = youthStatusOn(input.birthDate, dw.date);
      if (!y || !dw.version) continue;
      if (!y.minor) {
        if (minorProfileSet && dw.result.worked && dw.version.settings.legalProfile === 'general_private' && input.settingsVersions.length && dw.date >= from && dw.date <= to)
          warn(dw.result.warnings, 'MINOR_PROFILE_ADULT', 'review', 'העובד הוגדר כנער, אך לפי תאריך הלידה הוא בגיר ביום זה — יש לעדכן את פרופיל העובד', dw.date);
        continue;
      }
      const s = dw.version.settings;
      if (youthRuleSet === 'Y1') {
        dw.result.warnings.push(
          ...checkYouthDayV1({
            date: dw.date,
            age: y.age,
            netMinutes: dw.result.netMinutes,
            grossMinutes: dw.result.grossMinutes,
            breakMinutes: dw.result.breakMinutes + dw.result.paidBreakMinutes,
            minutes: dw.minutes.map((m) => ({ minuteOfDay: utcToLocal(m.ms).minuteOfDay, premium: m.premium })),
            eve: dw.result.restEve || dw.result.holidayEve,
            fiveDayWeek: s.workweek === 'five',
            hourlyRateAgorot: s.hourlyRateAgorot,
          }),
        );
        continue;
      }
      // Rule set Y2.
      if (dw.status?.status === 'vacation' && dw.date >= from && dw.date <= to)
        dw.result.warnings.push({
          code: 'YOUTH_VACATION_REVIEW',
          severity: 'review',
          message: 'יום חופשה של נער: זכאות החופשה לנוער שונה (18 ימים קלנדריים, חישוב יחסי, 4% לשעתי/יומי שהועסק פחות מ-75 ימים רצופים) ודמי החופשה לפי השכר בתקופה הקובעת — אינם מחושבים במערכת. יש לבדוק',
          date: dw.date,
          ruleId: 'Y-017',
        });
      const valid = dw.shifts.filter((p) => p.result.valid && p.startMs !== null && p.endMs !== null).sort((a, b) => a.startMs! - b.startMs!);
      const breaks: Parameters<typeof checkYouthDayV2>[0]['breaks'] = [];
      for (const p of valid) {
        const b = p.result.break;
        if (b.deductedMinutes > 0) breaks.push({ minutes: b.deductedMinutes, kind: b.unconfirmed ? 'unpaid_unconfirmed' : 'unpaid_confirmed' });
        if (b.paidMinutes > 0) breaks.push({ minutes: b.paidMinutes, kind: 'paid' });
      }
      for (let i = 1; i < valid.length; i++) {
        const gap = (valid[i].startMs! - valid[i - 1].endMs!) / MINUTE_MS;
        if (gap > 0) breaks.push({ minutes: gap, kind: 'gap' });
      }
      const outcome = checkYouthDayV2({
        date: dw.date,
        age: y.age,
        netMinutes: dw.result.netMinutes,
        breaks,
        minutes: dw.minutes.map((m) => ({ minuteOfDay: utcToLocal(m.ms).minuteOfDay, premium: m.premium })),
        restEve: dw.result.restEve,
        holidayEve: dw.result.holidayEve,
        worksNextDay: (dayWork.get(addDays(dw.date, 1))?.result.netMinutes ?? 0) > 0,
        fiveDayWeek: s.workweek === 'five',
        hourlyRateAgorot: s.hourlyRateAgorot,
        profile: input.youth ?? null,
      });
      youthOutcomes.set(dw.date, outcome);
      dw.result.warnings.push(...outcome.warnings);
    }
    if (youthRuleSet === 'Y2') {
      // 40-hour week: the daily excess first, then the weekly excess beyond it (no double counting).
      for (const week of weeks) {
        const dates = eachDate(week.weekStart, week.weekEnd).filter((d) => youthOn(d) && (dayWork.get(d)?.result.netMinutes ?? 0) > 0);
        if (!dates.length) continue;
        const net = dates.reduce((a, d) => a + dayWork.get(d)!.result.netMinutes, 0);
        const dailyExcess = dates.reduce((a, d) => a + (youthOutcomes.get(d)?.dailyExcessMinutes ?? 0), 0);
        const wk = checkYouthWeekV2(dates[dates.length - 1], net, dailyExcess);
        week.warnings.push(...wk.warnings);
        youthWeekly.set(dates[dates.length - 1], wk.weeklyExcessMinutes);
      }
      const inRange = [...youthOutcomes.entries()].filter(([d]) => d >= from && d <= to);
      if (inRange.some(([, o]) => o.noWageTable))
        periodWarnings.push({
          code: 'YOUTH_MIN_WAGE_TABLE',
          severity: 'review',
          message: 'אין במערכת טבלת שכר מינימום לנוער לחלק מהתקופה (השיעורים המפורסמים חלים מ-1.4.2026 ואינם רטרואקטיביים) — יש לבדוק את השכר ידנית',
          date: from,
          ruleId: 'Y-009',
        });
      const schooling = input.youth?.schooling ?? 'unknown';
      if (schooling !== 'not_compulsory' && inRange.some(([d]) => (dayWork.get(d)?.result.netMinutes ?? 0) > 0 && !inSchoolVacation(input.youth, d)))
        periodWarnings.push({
          code: 'YOUTH_SCHOOL_REVIEW',
          severity: 'review',
          message: `חובת לימוד: ${schooling === 'compulsory' ? 'חלה' : 'לא הוזנה'}. יש לוודא שעבודת הנער בימי לימודים אינה בשעות הלימודים ואינה פוגעת בחובת הלימוד — לא ניתן להסיק זאת מהגיל`,
          date: from,
          ruleId: 'Y-016',
        });
    }
  }

  // Attach week warnings to the week's days, build explanations and pay.
  for (const week of weeks) {
    if (week.warnings.length) {
      const lastDay = dayWork.get(week.weekEnd)!;
      lastDay.result.warnings.push(...week.warnings);
    }
  }
  // Review flags acknowledged by marking shifts as reviewed (break confirmation is never implied).
  const reviewedShift = new Map(input.shifts.map((s) => [s.id, s.reviewed]));
  for (const dw of dayWork.values()) {
    const dayShiftIds = dw.shifts.map((p) => p.result.shiftId);
    const allReviewed = dayShiftIds.length > 0 && dayShiftIds.every((id) => reviewedShift.get(id));
    dw.result.warnings = dw.result.warnings.map((w) =>
      w.severity === 'review' && w.code !== 'BREAK_UNCONFIRMED' && (w.shiftId ? reviewedShift.get(w.shiftId) : allReviewed) ? { ...w, acknowledged: true } : w,
    );
    for (const sr of dw.result.shifts)
      sr.warnings = sr.warnings.map((w) => (w.severity === 'review' && w.code !== 'BREAK_UNCONFIRMED' && reviewedShift.get(sr.shiftId) ? { ...w, acknowledged: true } : w));
  }
  for (const dw of dayWork.values()) {
    buildExplanation(dw);
    // 1.1.11: verified pay clauses of an applicable instrument (rates, night premium, sector minimum wage).
    const payRule = payRuleOn(input.agreementPay, dw.date);
    if (payRule && dw.result.worked) {
      if (payRule.overtimeRates || payRule.restHolidayRates || payRule.nightPremium)
        dw.result.explanation.push(`הערכת העלות לפי סעיפים מאומתים: ${payRule.source}.`);
      const rate = dw.version?.settings.hourlyRateAgorot ?? null;
      if (payRule.minimumHourlyAgorot && rate !== null && rate < payRule.minimumHourlyAgorot)
        warn(dw.result.warnings, 'AGREEMENT_MIN_WAGE', 'compliance', `השכר השעתי (₪${(rate / 100).toFixed(2)}) נמוך משכר המינימום הענפי (₪${(payRule.minimumHourlyAgorot / 100).toFixed(2)}) — ${payRule.source}`, dw.date);
    }
    dw.payUnits = payUnitsFor(dw, payRule);
    dw.result.payAgorot = dw.payUnits === null ? null : roundPayUnits(dw.payUnits);
    if (sumBuckets(dw.result.buckets) !== dw.result.netMinutes) throw new Error(`internal: reconciliation failed on ${dw.date}`);
  }

  // Profile-level warnings.
  const versionsInRange = new Set<string>();
  for (const date of eachDate(from, to)) {
    const v = dayWork.get(date)!.version;
    if (v && !versionsInRange.has(v.id)) {
      versionsInRange.add(v.id);
      const s = v.settings;
      if (s.legalProfile === 'exempt')
        warn(periodWarnings, 'EXEMPT_PROFILE', 'review', 'העובד מוגדר כמי שחוק שעות עבודה ומנוחה אינו חל עליו – לא חושבו שעות נוספות. יש לוודא את הסיווג', from);
      if (s.legalProfile === 'minor')
        warn(periodWarnings, 'MINOR_UNSUPPORTED', 'error', 'עובד מתחת לגיל 18 – חוק עבודת הנוער חל ואינו נתמך בחישוב האוטומטי', from);
      if (s.legalProfile === 'custom_contract')
        warn(periodWarnings, 'CUSTOM_PROFILE', 'review', 'החישוב מבוסס על תקנים הסכמיים שהוזנו ידנית – יש לוודא שהם תואמים את ההסכם', from);
      if (s.workweek === 'five' && s.shortDay === null && s.legalProfile === 'general_private')
        // Info only (1.1.12): no shortened day is a valid deliberate default; without one a five-day week is 43h and
        // the extra hour is counted as weekly overtime. Not a blocking review.
        warn(periodWarnings, 'NO_SHORT_DAY', 'info', 'לא הוגדר יום מקוצר (שבוע של 5 ימים). ללא יום מקוצר השבוע הוא 43 שעות והשעה העודפת נספרת כשעה נוספת שבועית. לקביעת יום מקוצר: הגדרות חישוב ← מתכונת עבודה', from);
    }
  }

  const days = eachDate(from, to).map((d) => dayWork.get(d)!.result);
  const relevantWeeks = weeks.filter((w) => w.weekEnd >= from && w.weekStart <= to);
  const totals = calculatePeriodTotals(
    eachDate(from, to).map((d) => dayWork.get(d)!),
    periodWarnings,
  );
  const result: EmployeePeriodResult = { employeeId: input.employeeId, from, to, days, weeks: relevantWeeks, totals, warnings: periodWarnings, attendance: sumAttendance(days.map((d) => d.attendance)) };
  if (paidDayInfo) result.paidDay = paidDayInfo;
  const youthDays = days.filter((d) => d.worked && youthOn(d.date)).length;
  let turns18: LocalDate | null = null;
  if (input.birthDate) {
    const b18 = birthdayOn(input.birthDate, 18);
    if (b18 >= from && b18 <= to) turns18 = b18;
  }
  result.age = { birthDate: input.birthDate ?? null, youthDays, turns18 };
  if (youthRuleSet === 'Y2' && input.birthDate && eachDate(from, to).some((d) => youthOn(d))) {
    const inRange = [...youthOutcomes.entries()].filter(([d]) => d >= from && d <= to);
    const dailyExcess = inRange.reduce((a, [, o]) => a + o.dailyExcessMinutes, 0);
    const weeklyExcess = [...youthWeekly.entries()].filter(([d]) => d >= from && d <= to).reduce((a, [, m]) => a + m, 0);
    result.youth = {
      ruleSet: 'Y2',
      youthDays,
      recordedMinutes: days.filter((d) => youthOn(d.date)).reduce((a, d) => a + d.netMinutes, 0),
      dailyExcessMinutes: dailyExcess,
      weeklyExcessMinutes: weeklyExcess,
      prohibitedOvertimeMinutes: dailyExcess + weeklyExcess,
      nightProhibitedMinutes: inRange.reduce((a, [, o]) => a + o.nightProhibitedMinutes, 0),
      nightReviewMinutes: inRange.reduce((a, [, o]) => a + o.nightReviewMinutes, 0),
      restDayMinutes: inRange.reduce((a, [, o]) => a + o.restDayMinutes, 0),
    };
  }
  return result;
}

function checkWeeklyRest(
  ws: LocalDate,
  we: LocalDate,
  dayWork: Map<LocalDate, DayWork>,
  timed: ProcessedShift[],
  cal: CalendarContext,
  out: Warning[],
  youthOn?: (date: LocalDate) => boolean,
) {
  for (const date of eachDate(ws, we)) {
    const v = dayWork.get(date)?.version;
    if (!v || !cal.isRestDay(date, v.settings)) continue;
    if (v.settings.legalProfile === 'exempt' || v.settings.legalProfile === 'minor') continue;
    const win = cal.restWindow(date, v.settings);
    const valid = timed.filter((p) => p.result.valid);
    if (valid.some((p) => p.startMs! < win.endMs && p.endMs! > win.startMs)) continue; // flagged per shift
    const before = valid.filter((p) => p.endMs! <= win.startMs).map((p) => p.endMs!);
    const after = valid.filter((p) => p.startMs! >= win.endMs).map((p) => p.startMs!);
    if (!before.length || !after.length) continue;
    const gap = (Math.min(...after) - Math.max(...before)) / MINUTE_MS;
    if (gap < LAW.WEEKLY_REST_MINUTES) {
      if (youthOn?.(date))
        out.push({
          code: 'YOUTH_WEEKLY_REST_SHORT',
          severity: 'compliance',
          message: `המנוחה השבועית הרצופה של הנער הייתה ${formatHM(gap)} שעות – פחות מ-36 שעות (כולל יום המנוחה). אין היתר המתיר זאת. ${PROHIBITED_WORK_TEXT}`,
          date,
          ruleId: 'Y-006',
        });
      else warn(out, 'WEEKLY_REST_SHORT', 'compliance', `המנוחה השבועית הרצופה הייתה ${formatHM(gap)} שעות – פחות מ-36 שעות`, date);
    }
  }
}

// ---------------------------------------------------------------------------
// Explanation (audit trail in Hebrew)
// ---------------------------------------------------------------------------

function buildExplanation(dw: DayWork) {
  const dr = dw.result;
  const lines = dr.explanation;
  for (const s of dr.shifts) {
    if (!s.valid) continue;
    const st = s.startAt!.slice(11);
    const en = s.endAt!.slice(11);
    const overnight = s.endAt!.slice(0, 10) !== s.startAt!.slice(0, 10) ? ' (למחרת)' : '';
    lines.push(`משמרת ${st}–${en}${overnight}: משך ברוטו ${formatDurationHe(s.grossMinutes)}. ${s.break.rule}.`);
    if (s.isNightShift) lines.push(`במשמרת ${formatDurationHe(s.nightMinutes)} עבודה בין 22:00 ל-06:00 – משמרת לילה.`);
  }
  if (!dr.worked) return;
  if (!dw.version) return;
  const t = dw.threshold!;
  if (dr.breakMinutes > 0) lines.push(`לאחר ניכוי הפסקה של ${formatDurationHe(dr.breakMinutes)}, העובד עבד ${formatDurationHe(dr.netMinutes)} נטו.`);
  else lines.push(`העובד עבד ${formatDurationHe(dr.netMinutes)} נטו (ללא ניכוי הפסקה).`);
  if (t.minutes === null) {
    lines.push('לא בוצע סיווג לשעות נוספות לפי הפרופיל החוקי של העובד.');
    return;
  }
  if (dw.fridayAll) {
    const fp: string[] = [];
    if (dw.od.friday125) fp.push(`${formatDurationHe(dw.od.friday125)} בתעריף 125%`);
    if (dw.od.friday150) fp.push(`${formatDurationHe(dw.od.friday150)} בתעריף 150%`);
    lines.push(
      `לפי הגדרת "כל שעות יום שישי כשעות נוספות" (שבוע עבודה בן 5 ימים) כל שעות העבודה נטו ביום שישי סווגו כשעות נוספות: ${fp.join(' ו-')}. ` +
        'הסיווג אינו תלוי במכסה השבועית, ודקות אלה לא נספרו פעמיים כשעות נוספות שבועיות.',
    );
  } else {
    const { daily125, daily150 } = dw.od;
    const parts: string[] = [];
    if (daily125) parts.push(`${formatDurationHe(daily125)} נוספות בתעריף 125%`);
    if (daily150) parts.push(`${formatDurationHe(daily150)} נוספות בתעריף 150%`);
    lines.push(
      `תקן היום הוא ${formatDurationHe(t.minutes)}` +
        (parts.length ? `, ולכן חושבו ${parts.join(' ו-')}.` : dr.netMinutes > t.minutes ? '.' : ', ולא חושבו שעות נוספות יומיות.'),
    );
    if (t.reasons.length) lines.push(`בסיס התקן: ${t.reasons.join('; ')}.`);
  }
  const { weekly125, weekly150 } = dw.od;
  if (weekly125 || weekly150) {
    const wp: string[] = [];
    if (weekly125) wp.push(`${formatDurationHe(weekly125)} בתעריף 125%`);
    if (weekly150) wp.push(`${formatDurationHe(weekly150)} בתעריף 150%`);
    lines.push(`מכסת השעות הרגילות השבועית (${formatDurationHe(t.weeklyMinutes!)}) נוצלה, ולכן סווגו כשעות נוספות שבועיות: ${wp.join(' ו-')}. אותן דקות לא נספרו פעמיים.`);
    if (dw.weekCreditBefore) lines.push(`המכסה כוללת זיכוי של ${formatDurationHe(dw.weekCreditBefore)} בגין היעדרות בתשלום מוקדם יותר בשבוע (שעות ההיעדרות עצמן אינן שעות נוספות).`);
  }
  const b = dr.buckets;
  const rest = b.rest150 + b.rest175 + b.rest200;
  const hol = b.holiday150 + b.holiday175 + b.holiday200;
  if (rest) lines.push(`${formatDurationHe(rest)} חלו במנוחה השבועית: 150% – ${formatHM(b.rest150)}, 175% – ${formatHM(b.rest175)}, 200% – ${formatHM(b.rest200)}.`);
  if (hol) lines.push(`${formatDurationHe(hol)} חלו בחג: 150% – ${formatHM(b.holiday150)}, 175% – ${formatHM(b.holiday175)}, 200% – ${formatHM(b.holiday200)}.`);
  if (dr.contractExcessMinutes) lines.push(`${formatDurationHe(dr.contractExcessMinutes)} מעבר להיקף המשרה החוזי ועד התקן החוקי – שעות עודפות בתעריף 100%.`);
}

// ---------------------------------------------------------------------------
// Optional indicative pay (exact integer arithmetic, rounded once)
// ---------------------------------------------------------------------------

/** units = minutes × percent × rateAgorot; agorot = units / 6000. */
/**
 * Percent per bucket. Without a verified agreement rule this is exactly BUCKET_PERCENT. With one (1.1.11), the
 * overtime tiers and the rest/holiday base rate come from the verified clause and the combined buckets keep the
 * statute's structure (rest + first tier = rest% + (tier1% − 100), …).
 */
export function bucketPercents(rule: Pick<AgreementPayRule, 'overtimeRates' | 'restHolidayRates'> | null): Record<keyof MinuteBuckets, number> {
  if (!rule?.overtimeRates && !rule?.restHolidayRates) return BUCKET_PERCENT;
  const t1 = rule.overtimeRates?.tier1Percent ?? 125;
  const t2 = rule.overtimeRates?.tier2Percent ?? 150;
  const r = rule.restHolidayRates?.restPercent ?? 150;
  const h = rule.restHolidayRates?.holidayPercent ?? 150;
  return { regular: 100, ot125: t1, ot150: t2, rest150: r, rest175: r + t1 - 100, rest200: r + t2 - 100, holiday150: h, holiday175: h + t1 - 100, holiday200: h + t2 - 100, unclassified: 100 };
}

/** The verified pay clauses in force on a date (the resolver guarantees one instrument per domain). */
function payRuleOn(rules: AgreementPayRule[] | undefined, date: LocalDate): AgreementPayRule | null {
  const on = (rules ?? []).filter((r) => date >= r.from && (r.to === null || date <= r.to));
  if (!on.length) return null;
  return on.reduce<AgreementPayRule>((acc, r) => ({ ...acc, ...r, source: acc.source ? `${acc.source}; ${r.source}` : r.source }), { from: date, to: date, source: '' });
}

const inWindow = (t: number, start: number, end: number) => (start < end ? t >= start && t < end : t >= start || t < end);

function payUnitsFor(dw: DayWork, rule: AgreementPayRule | null = null): number | null {
  const rate = dw.version?.settings.hourlyRateAgorot ?? null;
  if (rate === null) return null;
  const pct = bucketPercents(rule);
  let units = 0;
  for (const k of Object.keys(dw.result.buckets) as (keyof MinuteBuckets)[]) units += dw.result.buckets[k] * pct[k] * rate;
  if (rule?.nightPremium) {
    const n = rule.nightPremium;
    units += dw.minutes.filter((m) => inWindow(utcToLocal(m.ms).minuteOfDay, n.startMinute, n.endMinute)).length * n.percent * rate;
  }
  if (!Number.isSafeInteger(units)) throw new Error('pay overflow');
  return units;
}

/** Round half up to whole agorot. */
export function roundPayUnits(units: number): number {
  return Math.floor((units * 2 + 6000) / 12000);
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function calculatePeriodTotals(days: DayWork[], periodWarnings: Warning[]): PeriodTotals {
  const t: PeriodTotals = {
    daysWorked: 0,
    grossMinutes: 0,
    breakMinutes: 0,
    paidBreakMinutes: 0,
    netMinutes: 0,
    buckets: emptyBuckets(),
    dailyOvertimeMinutes: 0,
    weeklyOvertimeMinutes: 0,
    contractExcessMinutes: 0,
    unconfirmedBreaks: 0,
    incompleteEntries: 0,
    errorCount: 0,
    reviewCount: 0,
    complianceCount: 0,
    payAgorot: null,
  };
  let payUnits: number | null = null;
  const all: Warning[] = [...periodWarnings];
  for (const dw of days) {
    const d = dw.result;
    if (d.worked) t.daysWorked++;
    t.grossMinutes += d.grossMinutes;
    t.breakMinutes += d.breakMinutes;
    t.paidBreakMinutes += d.paidBreakMinutes;
    t.netMinutes += d.netMinutes;
    addBuckets(t.buckets, d.buckets);
    t.dailyOvertimeMinutes += d.dailyOvertimeMinutes;
    t.weeklyOvertimeMinutes += d.weeklyOvertimeMinutes;
    t.contractExcessMinutes += d.contractExcessMinutes;
    t.unconfirmedBreaks += d.shifts.filter((s) => s.valid && s.break.unconfirmed).length;
    t.incompleteEntries += d.shifts.filter((s) => s.incomplete).length + (d.status === 'missing_record' ? 1 : 0);
    all.push(...d.warnings);
    if (dw.payUnits !== null) payUnits = (payUnits ?? 0) + dw.payUnits;
  }
  const unique = dedupeWarnings(all);
  t.errorCount = unique.filter((w) => w.severity === 'error').length;
  t.reviewCount = unique.filter((w) => w.severity === 'review' && !w.acknowledged).length;
  t.complianceCount = unique.filter((w) => w.severity === 'compliance').length;
  t.payAgorot = payUnits === null ? null : roundPayUnits(payUnits);
  return t;
}

export function dedupeWarnings(ws: Warning[]): Warning[] {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const w of ws) {
    const k = `${w.code}|${w.date ?? ''}|${w.shiftId ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

export function calculateMonthlyTotals(result: EmployeePeriodResult): PeriodTotals {
  return result.totals;
}

// ---------------------------------------------------------------------------
// Paid-absence helpers (1.1.7)
// ---------------------------------------------------------------------------

/**
 * Scheduled minutes of a regular day for paid-absence purposes: 0 on a day that is not one of the employee's
 * working days; otherwise the part-time contract hours, or the employee's daily standard for that date
 * (five-day: 8:24 office policy / 7:36 shortened day; six-day: 8:00 / 7:00 before the rest day; custom contract).
 * Holidays are NOT removed here (a holiday absence needs the hours the day would have had).
 */
export function scheduledDayMinutes(date: LocalDate, s: EmployeeSettings, cal: CalendarContext): number {
  if (!s.workDays.includes(weekdayOf(date) as Weekday)) return 0;
  if (s.contractDailyMinutes !== null) return s.contractDailyMinutes;
  const general = s.legalProfile === 'exempt' || s.legalProfile === 'minor' ? { ...s, legalProfile: 'general_private' as const } : s;
  return getApplicableDailyThreshold(date, general, cal, false).minutes ?? 0;
}

/** How a full paid absence day is valued in the month of `date` (transparency panel, 1.1.9). */
function describePaidDay(
  date: LocalDate,
  input: EmployeePeriodInput,
  ctx: AbsenceContext,
  scheduled: (d: LocalDate, s: EmployeeSettings, cal: CalendarContext) => number,
  cal: CalendarContext,
): PaidDayInfo | null {
  const v = resolveSettings(input.settingsVersions, date) ?? resolveSettings(input.settingsVersions, input.to);
  if (!v) return null;
  const a = resolveAbsenceSettings(v.settings, date, input.businessAbsence);
  const method = a.paidDayReference;
  let info: PaidDayInfo;
  if (method === 'average_month' || method === 'average_3m') {
    const avg = method === 'average_month' ? ctx.averageMonth(date) : ctx.averageDaily(date);
    info = {
      method,
      from: avg?.from ?? null,
      to: avg?.to ?? null,
      workedDays: avg?.days ?? 0,
      workedMinutes: avg?.workedMinutes ?? 0,
      dayMinutes: avg && avg.days > 0 ? avg.minutes : null,
      insufficient: !avg || avg.days === 0,
    };
  } else if (method === 'fixed') {
    info = { method, from: null, to: null, workedDays: 0, workedMinutes: 0, dayMinutes: a.paidDayMinutes, insufficient: !a.paidDayMinutes };
  } else {
    // Schedule: the first scheduled day of the month shows the employee's regular day.
    let m: number | null = null;
    for (let d = `${date.slice(0, 7)}-01`; d.slice(0, 7) === date.slice(0, 7) && m === null; d = addDays(d, 1)) {
      const x = scheduled(d, v.settings, cal);
      if (x > 0) m = x;
    }
    info = { method: 'schedule', from: null, to: null, workedDays: 0, workedMinutes: 0, dayMinutes: m, insufficient: m === null };
  }
  const o = ctx.paidDayOverride(date);
  if (o && o.minutes > 0) info = { ...info, method: 'override', calculatedMinutes: info.dayMinutes, dayMinutes: o.minutes, insufficient: false, overrideReason: o.reason };
  return info;
}

/** First day of the month `n` months after the month of `first`. */
function addMonthsFirst(first: LocalDate, n: number): LocalDate {
  let y = +first.slice(0, 4);
  let m = +first.slice(5, 7) + n;
  while (m > 12) {
    m -= 12;
    y++;
  }
  while (m < 1) {
    m += 12;
    y--;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** The 3 complete calendar months before the month of `date` (e.g. Nov 2026 → Aug–Oct 2026). */
export function absenceAverageWindow(date: LocalDate): { from: LocalDate; to: LocalDate } {
  const y = +date.slice(0, 4);
  const m = +date.slice(5, 7);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  let fy = y;
  let fm = m - 3;
  if (fm < 1) {
    fm += 12;
    fy--;
  }
  return { from: `${fy}-${String(fm).padStart(2, '0')}-01`, to: addDays(first, -1) };
}

export { absenceHistoryFrom };
