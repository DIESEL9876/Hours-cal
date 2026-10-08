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
import { LAW, resolveSettings } from './settings';
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
  if (settings.legalProfile === 'custom_contract' && settings.customProfile) {
    const cp = settings.customProfile;
    base = cp.dailyThresholdMinutes[wd];
    info.weeklyMinutes = cp.weeklyThresholdMinutes;
    info.firstTierMinutes = cp.firstTierMinutes;
    applyReductions = cp.applyStatutoryReductions;
    reasons.push(`תקן הסכמי (${cp.label}): ${formatDurationHe(base)}`);
  } else if (settings.workweek === 'five') {
    info.weeklyMinutes = LAW.WEEKLY_REGULAR_MINUTES;
    if (scheduled && settings.shortDay === wd) {
      base = LAW.FIVE_DAY_SHORT_MINUTES;
      info.shortDay = true;
      reasons.push('שבוע עבודה בן 5 ימים – היום המקוצר: 7 שעות ו-36 דקות');
    } else {
      base = LAW.FIVE_DAY_NORMAL_MINUTES;
      reasons.push(
        scheduled
          ? 'שבוע עבודה בן 5 ימים – יום רגיל: 8 שעות ו-36 דקות'
          : 'יום שאינו יום עבודה רגיל בשבוע בן 5 ימים – נבדק לפי תקן יום רגיל ובכפוף לתקן השבועי',
      );
    }
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
  od: { daily125: number; daily150: number; weekly125: number; weekly150: number };
  payUnits: number | null;
}

export function calculateEmployeePeriod(input: EmployeePeriodInput): EmployeePeriodResult {
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
      od: { daily125: 0, daily150: 0, weekly125: 0, weekly150: 0 },
      payUnits: null,
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
      else if (dr.worked) warn(dr.warnings, 'STATUS_CONFLICT', 'review', 'ליום שסומן כהיעדרות נרשמו גם שעות עבודה', dr.date);
    }
    if (dw.version) {
      const s = dw.version.settings;
      const t = getApplicableDailyThreshold(dr.date, s, cal, dr.isNight);
      dw.threshold = t;
      dr.scheduled = t.scheduled;
      dr.shortDay = t.shortDay;
      dr.restEve = t.restEve;
      dr.holidayEve = t.holidayEve;
      dr.dailyThresholdMinutes = t.minutes;
      dr.thresholdReasons = t.reasons;
      if (dr.worked) {
        if (!t.scheduled && s.legalProfile !== 'exempt' && s.legalProfile !== 'minor')
          warn(
            dr.warnings,
            'UNSCHEDULED_DAY_WORK',
            'review',
            `עבודה ביום ${HEBREW_WEEKDAYS[dr.weekday]} שאינו יום עבודה רגיל – השעות סווגו לפי התקן היומי והשבועי ולא אוטומטית כשעות נוספות. יש לבדוק את ההסכם`,
            dr.date,
          );
        if (t.eveReductionApplied && t.minutes !== null && dr.netMinutes > t.minutes)
          warn(dr.warnings, 'EVE_THRESHOLD_REVIEW', 'review', 'הופעל תקן מקוצר של 7 שעות (ערב מנוחה/ערב חג) – יש לוודא שהוא חל על הסדר העבודה', dr.date);
        if (dr.netMinutes > LAW.MAX_DAILY_MINUTES)
          warn(dr.warnings, 'DAILY_LIMIT', 'compliance', `יום עבודה של ${formatHM(dr.netMinutes)} שעות – חורג מהמגבלה של 12 שעות ביום כולל שעות נוספות`, dr.date);
      }
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
    for (const date of eachDate(ws, we)) {
      const dw = dayWork.get(date)!;
      const dr = dw.result;
      week.netMinutes += dr.netMinutes;
      if (!dw.version || dw.minutes.length === 0) continue;
      const s = dw.version.settings;
      const t = dw.threshold!;
      if (t.minutes === null || t.weeklyMinutes === null) {
        dr.buckets.unclassified += dw.minutes.length;
        continue;
      }
      week.weeklyThresholdMinutes = t.weeklyMinutes;
      let dayOtCount = 0;
      let dailyOtCount = 0;
      const contract = s.contractDailyMinutes;
      dw.minutes.forEach((m, i) => {
        const countsWeekly = s.restMinutesCountTowardWeekly || m.premium === 'none';
        let tier: Tier;
        if (i >= t.minutes!) {
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
    }
    week.regularCountedMinutes = weeklyRegular;

    // Weekly compliance checks (attached to the last worked day of the week inside the period).
    const weekOt = week.dailyOvertimeMinutes + week.weeklyOvertimeMinutes;
    if (weekOt > LAW.MAX_WEEKLY_OVERTIME_MINUTES)
      warn(week.warnings, 'WEEKLY_OT_LIMIT', 'compliance', `בשבוע זה ${formatHM(weekOt)} שעות נוספות – מעל המכסה הכללית של 16 שעות שבועיות`, we);
    if (week.netMinutes > LAW.MAX_WEEKLY_TOTAL_MINUTES)
      warn(week.warnings, 'WEEKLY_TOTAL_LIMIT', 'compliance', `סך שעות העבודה בשבוע (${formatHM(week.netMinutes)}) עולה על 58 שעות`, we);
    checkWeeklyRest(ws, we, dayWork, timed, cal, week.warnings);
    weeks.push(week);
  }

  // Rest between consecutive shifts on different workdays.
  for (let i = 1; i < timed.length; i++) {
    const prev = timed[i - 1];
    const cur = timed[i];
    if (!prev.result.valid || !cur.result.valid || prev.result.workDate === cur.result.workDate) continue;
    const dw = dayWork.get(cur.result.workDate);
    if (!dw?.version) continue;
    const gap = (cur.startMs! - prev.endMs!) / MINUTE_MS;
    const limit = dw.version.settings.restBetweenShiftsWarnMinutes;
    if (gap >= 0 && limit > 0 && gap < limit) {
      const w: Warning = {
        code: 'SHORT_REST_BETWEEN_SHIFTS',
        severity: 'compliance',
        message: `מנוחה של ${formatHM(gap)} בלבד מאז המשמרת הקודמת (סף אזהרה משרדי: ${formatHM(limit)})`,
        date: cur.result.workDate,
        shiftId: cur.result.shiftId,
      };
      cur.result.warnings.push(w);
      dw.result.warnings.push(w);
    }
  }

  // Attach week warnings to the week's days, build explanations and pay.
  for (const week of weeks) {
    if (week.warnings.length) {
      const lastDay = dayWork.get(week.weekEnd)!;
      lastDay.result.warnings.push(...week.warnings);
    }
  }
  for (const dw of dayWork.values()) {
    buildExplanation(dw);
    dw.payUnits = payUnitsFor(dw);
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
        warn(periodWarnings, 'NO_SHORT_DAY', 'review', 'לא הוגדר יום מקוצר לעובד בשבוע של 5 ימים – לפי צו ההרחבה יש לקבוע יום קבוע של 7.6 שעות', from);
    }
  }

  const days = eachDate(from, to).map((d) => dayWork.get(d)!.result);
  const relevantWeeks = weeks.filter((w) => w.weekEnd >= from && w.weekStart <= to);
  const totals = calculatePeriodTotals(
    eachDate(from, to).map((d) => dayWork.get(d)!),
    periodWarnings,
  );
  return { employeeId: input.employeeId, from, to, days, weeks: relevantWeeks, totals, warnings: periodWarnings };
}

function checkWeeklyRest(
  ws: LocalDate,
  we: LocalDate,
  dayWork: Map<LocalDate, DayWork>,
  timed: ProcessedShift[],
  cal: CalendarContext,
  out: Warning[],
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
    if (gap < LAW.WEEKLY_REST_MINUTES)
      warn(out, 'WEEKLY_REST_SHORT', 'compliance', `המנוחה השבועית הרצופה הייתה ${formatHM(gap)} שעות – פחות מ-36 שעות`, date);
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
  const { daily125, daily150, weekly125, weekly150 } = dw.od;
  const parts: string[] = [];
  if (daily125) parts.push(`${formatDurationHe(daily125)} נוספות בתעריף 125%`);
  if (daily150) parts.push(`${formatDurationHe(daily150)} נוספות בתעריף 150%`);
  lines.push(
    `תקן היום הוא ${formatDurationHe(t.minutes)}` +
      (parts.length ? `, ולכן חושבו ${parts.join(' ו-')}.` : dr.netMinutes > t.minutes ? '.' : ', ולא חושבו שעות נוספות יומיות.'),
  );
  if (t.reasons.length) lines.push(`בסיס התקן: ${t.reasons.join('; ')}.`);
  if (weekly125 || weekly150) {
    const wp: string[] = [];
    if (weekly125) wp.push(`${formatDurationHe(weekly125)} בתעריף 125%`);
    if (weekly150) wp.push(`${formatDurationHe(weekly150)} בתעריף 150%`);
    lines.push(`מכסת השעות הרגילות השבועית (${formatDurationHe(t.weeklyMinutes!)}) נוצלה, ולכן סווגו כשעות נוספות שבועיות: ${wp.join(' ו-')}. אותן דקות לא נספרו פעמיים.`);
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
function payUnitsFor(dw: DayWork): number | null {
  const rate = dw.version?.settings.hourlyRateAgorot ?? null;
  if (rate === null) return null;
  let units = 0;
  for (const k of Object.keys(dw.result.buckets) as (keyof MinuteBuckets)[]) units += dw.result.buckets[k] * BUCKET_PERCENT[k] * rate;
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
  t.reviewCount = unique.filter((w) => w.severity === 'review').length;
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
