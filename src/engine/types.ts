/**
 * Core types for the attendance & overtime calculation engine.
 *
 * Conventions:
 *  - All durations are INTEGER MINUTES. No floating point hours anywhere in the engine.
 *  - LocalDate  = 'YYYY-MM-DD' (Israeli civil date).
 *  - LocalTime  = 'HH:mm'.
 *  - LocalDateTime = 'YYYY-MM-DDTHH:mm' wall-clock time in Asia/Jerusalem.
 *  - Weekday: 0 = Sunday ... 6 = Saturday (JavaScript convention).
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type LocalDate = string;
export type LocalTime = string;
export type LocalDateTime = string;

/** Which body of rules governs the employee. */
export type LegalProfile =
  /** General Israeli private-sector framework for adult employees (Hours of Work and Rest Law + 2018 extension order). */
  | 'general_private'
  /** Collective agreement / public sector / contract: thresholds entered manually by the office. */
  | 'custom_contract'
  /** Employee excluded from the Hours of Work and Rest Law (e.g. management / personal trust position, s.30). No overtime classification. */
  | 'exempt'
  /** Employee under 18 — Youth Labour Law applies. Not supported automatically. */
  | 'minor';

export type WorkType = 'manual' | 'non_manual';

export type BreakMethod =
  /** Office policy: <=10h gross → 30 min, >10h → 45 min (configurable). An ESTIMATE until confirmed. */
  | 'company_auto'
  /** Breaks are typed in explicitly per shift. Empty = no break. */
  | 'manual'
  /** No unpaid break is deducted. */
  | 'none'
  /** Break exists but is paid / counted as working time. */
  | 'paid'
  /** Suggest the statutory minimum break for the employee's legal profile (estimate, must be confirmed). */
  | 'legal_profile';

export interface CompanyBreakPolicy {
  /** Gross duration (minutes) up to and INCLUDING which the short break applies. Default 600 (10:00). */
  thresholdMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  /** Shifts with gross duration below this get no automatic deduction. Default 360 (6:00). */
  minShiftMinutes: number;
}

export interface WeeklyRestSettings {
  /**
   * 'shabbat'   — Jewish employee: Friday sunset → Saturday nightfall (tzeit), computed for `location`.
   * 'fixed_day' — the chosen civil day 00:00–24:00 (non-Jewish employee may choose Fri/Sat/Sun). Flagged for review.
   */
  kind: 'shabbat' | 'fixed_day';
  fixedDay: Weekday | null;
  /** Extend the window this many minutes BEFORE the computed start. */
  startOffsetMinutes: number;
  /** Extend the window this many minutes AFTER the computed end. */
  endOffsetMinutes: number;
}

export interface CustomProfile {
  label: string;
  /** Regular daily threshold per weekday (index 0=Sunday). */
  dailyThresholdMinutes: [number, number, number, number, number, number, number];
  weeklyThresholdMinutes: number;
  /** Number of overtime minutes per day paid at the first tier (default 120). */
  firstTierMinutes: number;
  /** Apply the statutory 7-hour reductions (night / eve of rest / eve of holiday) on top of the custom thresholds. */
  applyStatutoryReductions: boolean;
}

export interface EmployeeSettings {
  workweek: 'five' | 'six';
  /** Normally scheduled days. Five-day default: Sun–Thu. Six-day default: Sun–Fri. */
  workDays: Weekday[];
  /** Five-day week: the one fixed shortened (7:36) day. null = none configured (flagged). */
  shortDay: Weekday | null;
  workType: WorkType;
  legalProfile: LegalProfile;
  customProfile: CustomProfile | null;
  weeklyRest: WeeklyRestSettings;
  /** 'jewish_israel' = statutory Jewish holidays per Israeli calendar; 'none' = only business custom holidays. */
  holidayCalendar: 'jewish_israel' | 'none';
  /** Apply the 7-hour night-work daily threshold when a shift qualifies as night work. */
  nightRulesEnabled: boolean;
  breakMethod: BreakMethod;
  companyBreakPolicy: CompanyBreakPolicy;
  /** Optional hourly wage in agorot (integer). Used only for an indicative estimate. */
  hourlyRateAgorot: number | null;
  /** Optional contractual daily hours (part-time). Regular minutes beyond it are reported as "excess hours 100%". */
  contractDailyMinutes: number | null;
  /**
   * How the 125%/150% tiers are applied to WEEKLY overtime minutes.
   * 'per_day'  — all overtime minutes of a workday (daily + weekly) share the day's first 2 hours at 125%. (default)
   * 'per_week' — weekly overtime minutes are tiered by their running count within the week.
   */
  weeklyOvertimeTiering: 'per_day' | 'per_week';
  /** Whether minutes worked during weekly rest / holiday consume the 42-hour weekly regular allowance. Default true. */
  restMinutesCountTowardWeekly: boolean;
  /** Warn when rest between two consecutive shifts is shorter than this. Office-configurable (not a verified statutory rule). */
  restBetweenShiftsWarnMinutes: number;
  /** Hebcal city name used for sunset / nightfall (e.g. 'Tel Aviv', 'Jerusalem'). */
  location: string;
}

export interface SettingsVersion {
  id: string;
  /** First date (inclusive) this version applies to. */
  effectiveFrom: LocalDate;
  settings: EmployeeSettings;
}

/** A recorded shift as entered by the user. */
export interface ShiftInput {
  id: string;
  /** The attendance-row date; the workday the shift is attributed to (= start date). */
  workDate: LocalDate;
  startAt: LocalDateTime | null;
  endAt: LocalDateTime | null;
  /** Break minutes typed by the user. null = derive from the employee's break method. */
  breakMinutes: number | null;
  /** Optional break start time (wall clock). If null the break is assumed centred in the shift. */
  breakStart: LocalDateTime | null;
  /** User confirmed the (estimated) break as actually taken. */
  breakConfirmed: boolean;
  /** Break during which the employee was paid / had to remain available → counts as working time. */
  breakPaid: boolean;
  /** Human reviewer acknowledged this shift's review flags. */
  reviewed: boolean;
  note?: string;
}

export type DayStatusKind = 'not_worked' | 'vacation' | 'sick' | 'holiday' | 'reserve' | 'missing_record';

export interface DayStatus {
  date: LocalDate;
  status: DayStatusKind;
  note?: string;
}

export interface CustomHoliday {
  date: LocalDate;
  name: string;
}

export type Severity = 'error' | 'review' | 'compliance' | 'info';

export interface Warning {
  code: string;
  severity: Severity;
  message: string;
  date?: LocalDate;
  shiftId?: string;
  /** Review flag acknowledged by a human (shift marked as reviewed). Not counted as open. */
  acknowledged?: boolean;
}

export type Tier = 'regular' | 'ot125' | 'ot150';
export type Premium = 'none' | 'rest' | 'holiday';

/**
 * Mutually exclusive minute buckets. Every net worked minute lands in EXACTLY one bucket.
 * Reconciliation:  sum of all buckets === net minutes.
 */
export interface MinuteBuckets {
  regular: number; // 100%
  ot125: number;
  ot150: number;
  rest150: number; // weekly-rest, within regular threshold
  rest175: number; // weekly-rest + first overtime tier
  rest200: number; // weekly-rest + second overtime tier
  holiday150: number;
  holiday175: number;
  holiday200: number;
  /** Minutes not classified because the profile is exempt / unsupported. */
  unclassified: number;
}

export type BreakKind = 'none' | 'manual' | 'company_estimate' | 'legal_estimate' | 'paid' | 'below_minimum_shift';

export interface BreakResult {
  kind: BreakKind;
  /** Break suggested by the selected policy (informational). */
  suggestedMinutes: number;
  /** Unpaid minutes actually deducted from gross time. */
  deductedMinutes: number;
  /** Break minutes counted as work (paid / available). */
  paidMinutes: number;
  /** True when the deduction is an estimate not yet confirmed by the user. */
  unconfirmed: boolean;
  positioned: boolean;
  /** Hebrew description of the rule used. */
  rule: string;
}

export interface ShiftResult {
  shiftId: string;
  workDate: LocalDate;
  startAt: LocalDateTime | null;
  endAt: LocalDateTime | null;
  valid: boolean;
  incomplete: boolean;
  grossMinutes: number;
  break: BreakResult;
  netMinutes: number;
  nightMinutes: number;
  isNightShift: boolean;
  restMinutes: number;
  holidayMinutes: number;
  warnings: Warning[];
}

export interface DayResult {
  date: LocalDate;
  weekday: Weekday;
  settingsVersionId: string | null;
  legalProfile: LegalProfile | null;
  scheduled: boolean;
  shortDay: boolean;
  restEve: boolean;
  holidayEve: boolean;
  holidayName: string | null;
  isRestDay: boolean;
  status: DayStatusKind | null;
  shifts: ShiftResult[];
  worked: boolean;
  grossMinutes: number;
  breakMinutes: number;
  paidBreakMinutes: number;
  netMinutes: number;
  dailyThresholdMinutes: number | null;
  thresholdReasons: string[];
  isNight: boolean;
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  /** Regular minutes beyond the contractual daily hours (subset of buckets.regular/rest150/holiday150). */
  contractExcessMinutes: number;
  buckets: MinuteBuckets;
  warnings: Warning[];
  explanation: string[];
  /** Indicative pay in agorot (null when no hourly rate). */
  payAgorot: number | null;
}

export interface WeekResult {
  weekStart: LocalDate;
  weekEnd: LocalDate;
  netMinutes: number;
  regularCountedMinutes: number;
  weeklyThresholdMinutes: number | null;
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  warnings: Warning[];
}

export interface PeriodTotals {
  daysWorked: number;
  grossMinutes: number;
  breakMinutes: number;
  paidBreakMinutes: number;
  netMinutes: number;
  buckets: MinuteBuckets;
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  contractExcessMinutes: number;
  unconfirmedBreaks: number;
  incompleteEntries: number;
  errorCount: number;
  reviewCount: number;
  complianceCount: number;
  payAgorot: number | null;
}

export interface EmployeePeriodInput {
  employeeId: string;
  settingsVersions: SettingsVersion[];
  shifts: ShiftInput[];
  dayStatuses: DayStatus[];
  customHolidays: CustomHoliday[];
  /** Reporting range (inclusive). The engine internally expands to whole Sunday–Saturday weeks. */
  from: LocalDate;
  to: LocalDate;
}

export interface EmployeePeriodResult {
  employeeId: string;
  from: LocalDate;
  to: LocalDate;
  /** Days inside [from, to]. */
  days: DayResult[];
  /** Every week touching [from, to] (complete weeks, may include days outside the range). */
  weeks: WeekResult[];
  totals: PeriodTotals;
  warnings: Warning[];
}
