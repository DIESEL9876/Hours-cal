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
  /**
   * Friday overtime policy (five-day week only). Employees: 'inherit' (or absent) = the business setting.
   * Absent everywhere = 'none', i.e. unchanged behaviour for data created before version 1.1.6.
   */
  fridayOvertime?: FridayOvertimePolicy | 'inherit';
  /** Business defaults only: when the business Friday policy changed (see repo.updateBusiness). */
  fridayOvertimeHistory?: FridayPolicyChange[];
  /** Paid-absence settings (1.1.7). */
  absence?: AbsenceSettings;
  /** Business defaults only: when the weekly-credit policy changed (never reaches into finalised months). */
  weeklyCreditHistory?: WeeklyCreditChange[];
  /** Travel-expense reimbursement (1.1.9). Employees: mode 'inherit' (or absent) = the business setting. */
  travel?: TravelSettings;
  /** Collective agreements / extension orders selected for this employee (1.1.9) — see src/agreements. */
  agreements?: AgreementSelection[];
}

export type TravelMode = 'none' | 'monthly' | 'daily';
export interface TravelSettings {
  mode: TravelMode | 'inherit';
  /** NIS amount in agorot: per month ('monthly') or per eligible travel day ('daily'). */
  amountAgorot?: number | null;
}

/** An agreement chosen for an employee. Rules are used only after the applicability confirmation. */
export interface AgreementSelection {
  catalogId: string;
  /** Applicability confirmation (who / when / on what basis). Absent = reference only, no rules applied. */
  confirmation?: {
    by: string;
    at: string;
    industry: string;
    occupation: string;
    employmentStart: string | null;
    note?: string;
    /** 1.1.10 scope checks — all required for a complete confirmation. */
    employeeClass?: EmployeeClass;
    /** Employer, enterprise or employer association through which the instrument applies. */
    employerUnit?: string;
    workSite?: string;
    fullTextReviewed?: boolean;
    amendmentsChecked?: boolean;
    exclusionsChecked?: boolean;
  } | null;
  /**
   * 1.1.9: a professional verified a whole profile version. Since 1.1.10 this is NOT sufficient for execution
   * (kept for history): every executable clause needs its own verification below.
   */
  professionalVerification?: { by: string; at: string; version: string } | null;
  /** 1.1.10: per-clause verification against the full official text (clause reference and effective date). */
  clauseVerifications?: ClauseVerification[];
}

export type EmployeeClass = 'site_worker' | 'office_staff' | 'contractor_worker' | 'client_employee' | 'other';
export type AgreementClause = 'hours' | 'recuperation' | 'travel';
export interface ClauseVerification {
  profileVersion: string;
  clause: AgreementClause;
  /** Paragraph / clause reference in the official text. */
  clauseRef: string;
  /** Date from which the clause applies, per the official text. */
  effectiveFrom: LocalDate;
  by: string;
  at: string;
}

/** Thresholds taken from a VERIFIED agreement rule profile (applied by the engine like a contractual profile). */
export interface AgreementHoursRule {
  from: LocalDate;
  to: LocalDate | null;
  dailyThresholdMinutes: number[];
  weeklyThresholdMinutes: number;
  firstTierMinutes: number;
  /** Hebrew citation shown in explanations. */
  source: string;
}

/**
 * Office policy for Friday in a FIVE-day week (version 1.1.6):
 * 'all_overtime' — every net minute worked on Friday is overtime (first 2 hours 125%, then 150%),
 *                  whatever the weekly total; weekly-rest / holiday premiums are kept on top.
 * 'none'         — no automatic Friday overtime (the behaviour of every earlier version).
 */
export type FridayOvertimePolicy = 'all_overtime' | 'none';

/** Business-level Friday policy over time (changes never reach back into finalised months). */
export interface FridayPolicyChange {
  from: LocalDate;
  value: FridayOvertimePolicy;
}

// ---------------------------------------------------------------------------
// Paid absences (1.1.7)
// ---------------------------------------------------------------------------

export type SalaryType = 'monthly' | 'hourly' | 'daily';
/** How the hours of a paid absence day are determined. 'auto' = schedule for monthly, 3-month average for hourly/daily. */
/** Hours of a full paid absence day: 'average_month' = actual worked average of the absence month; 'average_3m' = of the 3 complete months before it (1.1.9). */
export type PaidDayReference = 'auto' | 'schedule' | 'average_3m' | 'average_month' | 'fixed';
/** 'statutory' = Annual Leave Law (full pay); 'manual' = no automatic payment (enter it per day). */
export type VacationProfile = 'statutory' | 'manual';
/** 'statutory' = Sick Pay Law s.2 (0% / 50% / 50% / 100%); others are more favourable arrangements. */
export type SickProfile = 'statutory' | 'full_from_day2' | 'full_from_day1';
/** 'statutory' = by salary type (monthly: included; hourly/daily: extension-order conditions). */
export type HolidayFramework = 'statutory' | 'all_paid' | 'manual';
export type ElectionHandling = 'statutory' | 'manual';
/** Whether paid absence hours count toward the weekly regular allowance (42 h) for later work that week. */
export type WeeklyCreditPolicy = 'paid_absence' | 'none';

/** Absence settings. On employees every field may be 'inherit' (or absent) = the business setting. */
export interface AbsenceSettings {
  salaryType?: SalaryType | 'inherit';
  paidDayReference?: PaidDayReference | 'inherit';
  /** Minutes of a paid day when paidDayReference = 'fixed'. */
  paidDayMinutes?: number | null;
  vacation?: VacationProfile | 'inherit';
  sick?: SickProfile | 'inherit';
  holiday?: HolidayFramework | 'inherit';
  election?: ElectionHandling | 'inherit';
  weeklyCredit?: WeeklyCreditPolicy | 'inherit';
  /** Employees only: employment start date (seniority conditions for holidays / election day). */
  employmentStart?: LocalDate | null;
}

export interface ResolvedAbsenceSettings {
  salaryType: SalaryType;
  /** False when nobody chose a salary type (defaults to monthly and is flagged for review). */
  salaryTypeExplicit: boolean;
  paidDayReference: Exclude<PaidDayReference, 'auto'>;
  paidDayMinutes: number | null;
  vacation: VacationProfile;
  sick: SickProfile;
  holiday: HolidayFramework;
  election: ElectionHandling;
  weeklyCredit: WeeklyCreditPolicy;
  employmentStart: LocalDate | null;
}

export interface WeeklyCreditChange {
  from: LocalDate;
  value: WeeklyCreditPolicy;
}

/** Business absence defaults passed to the engine. */
export interface BusinessAbsenceDefaults {
  settings: AbsenceSettings;
  weeklyCreditHistory: WeeklyCreditChange[];
}

/**
 * Per-day accounting of actual vs. paid attendance. All minutes are integers (equivalents are rounded
 * half-up per day); day values are in hundredths of a day. Totals are sums of these daily values.
 */
export interface DayAttendance {
  category: DayStatusKind | null;
  /** Net minutes physically worked (the engine's net, no absence time ever added). */
  actualWorkedMinutes: number;
  actualWorked: boolean;
  /** Absent portion of the scheduled day, hundredths (0–100). */
  absenceDayHundredths: number;
  /** Scheduled hours of the absent portion (before the payment rate). */
  paidAbsenceNominalMinutes: number;
  /** Payment rate applied to the absence, %. null = cannot be determined (review). */
  payPercent: number | null;
  /** Nominal × rate — compensated hour-equivalents (no overtime premiums). */
  paidAbsenceEquivalentMinutes: number;
  /** Paid-absence minutes credited toward the weekly regular allowance. */
  weeklyCreditMinutes: number;
  /** actualWorkedMinutes + paidAbsenceEquivalentMinutes. */
  payableEquivalentMinutes: number;
  /** Payable day-equivalent of the date, hundredths (0–100). */
  paidDayHundredths: number;
  /**
   * Office estimate of the absence's monetary value (agorot): base hourly rate × equivalent hours (1.1.9).
   * "שיטת חישוב לפי הגדרת העסק" — not the statutory amount. 0 when not applicable (see valueBasis).
   */
  estimatedValueAgorot: number;
  /** 'office' = estimate computed; 'in_salary' = monthly employee (paid within the salary, no extra payment);
   *  'statutory_formula' = reserve duty (National Insurance formula, never hourly); 'no_rate' = no hourly rate; 'none'. */
  valueBasis: 'office' | 'in_salary' | 'statutory_formula' | 'no_rate' | 'none';
  /** The paid-absence part of paidDayHundredths (absent portion × rate), hundredths. */
  paidAbsenceDayHundredths: number;
  /** Day number within a continuous sickness period (calendar days). */
  sickDayIndex: number | null;
  /** Estimated sick-balance deduction for this date, hundredths of a day (balance itself is not managed). */
  sickBalanceDeductionHundredths: number;
  /** 'rule' = statutory/contract rule fully applied; 'estimate' = depends on payroll data; 'review' = missing info. */
  basis: 'none' | 'rule' | 'estimate' | 'review';
  reviewReasons: string[];
  explanation: string[];
}

export interface AttendanceTotals {
  actualWorkedDays: number;
  actualWorkedMinutes: number;
  paidDayHundredths: number;
  payableEquivalentMinutes: number;
  paidAbsenceNominalMinutes: number;
  paidAbsenceEquivalentMinutes: number;
  weeklyCreditMinutes: number;
  vacationDayHundredths: number;
  sickDayHundredths: number;
  /** Sick days expressed as paid day-equivalents (e.g. a 50% day = 0.50). */
  sickPaidDayHundredths: number;
  sickBalanceDeductionHundredths: number;
  holidayDayHundredths: number;
  electionDayHundredths: number;
  unpaidDayHundredths: number;
  /** Absence days whose entitlement needs a human check. */
  reviewDays: number;
  /** Office estimate of paid absences (agorot), see DayAttendance.estimatedValueAgorot (1.1.9). */
  estimatedAbsenceValueAgorot: number;
  /** Reserve-duty absence days (nominal reporting only; compensation follows the National Insurance formula). */
  reserveDayHundredths: number;
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

/**
 * Day type ("סוג יום"). Always chosen or confirmed by the user — never assigned automatically.
 * 1.1.7 added 'work' (explicit regular workday), 'election' and 'unpaid'; earlier values keep their meaning.
 */
export type DayStatusKind = 'work' | 'not_worked' | 'vacation' | 'sick' | 'holiday' | 'election' | 'unpaid' | 'reserve' | 'missing_record';

/** Details of an absence the user entered for a date (all optional). */
export interface AbsenceDetails {
  /** Partial-day absence length in minutes. Absent/null = the whole scheduled day. */
  minutes?: number | null;
  /** Manual payment percentage (0–100) — a controlled override that requires a reason. */
  payPercentOverride?: number | null;
  overrideReason?: string | null;
  /** Election type for 'election' days. */
  electionType?: 'knesset' | 'local' | 'other' | null;
  /** Holiday the user selected / confirmed for 'holiday' days. */
  holidayName?: string | null;
  /**
   * The user's confirmation of conditions the system cannot know: employer consent to an absence around a
   * holiday, voter registration for local elections, etc. 'not_eligible' = the user determined no entitlement.
   */
  eligibility?: 'confirmed' | 'not_eligible' | null;
  /** A suggestion the user rejected (kept so it is not offered again). */
  rejectedSuggestion?: DayStatusKind | null;
}

export interface DayStatus {
  date: LocalDate;
  status: DayStatusKind;
  note?: string;
  absence?: AbsenceDetails | null;
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
  /** Legal rule id (legalRules.ts) that produced the warning, when one exists. */
  ruleId?: string;
}

/** Youth employment details entered for a minor (1.1.10). Nothing here is inferred from the date of birth. */
export type SchoolingStatus = 'compulsory' | 'not_compulsory' | 'unknown';
export interface YouthProfile {
  /** Whether the compulsory-education law applies to the minor. */
  schooling: SchoolingStatus;
  /** Official school vacation periods (entered by the user from the Ministry of Education calendar). */
  schoolVacations: { from: LocalDate; to: LocalDate }[];
  /** Night-work permits actually held: reference, validity and the latest permitted time (HH:MM). */
  nightPermits: { reference: string; validFrom: LocalDate; validTo: LocalDate; until: string }[];
  /** Recognised apprentice (Apprenticeship Law) — only with a document reference. */
  apprentice: { reference: string } | null;
}
export type YouthRuleSet = 'Y1' | 'Y2';

/** Youth figures of a period (rule set Y2) — kept apart from hours and pay; nothing is deducted. */
export interface YouthSummary {
  ruleSet: YouthRuleSet;
  youthDays: number;
  /** Net minutes recorded on youth dates (all of them payable). */
  recordedMinutes: number;
  /** Daily excess, then weekly excess beyond it (no double counting). */
  dailyExcessMinutes: number;
  weeklyExcessMinutes: number;
  prohibitedOvertimeMinutes: number;
  nightProhibitedMinutes: number;
  nightReviewMinutes: number;
  restDayMinutes: number;
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
  /** Set only when the Friday "all hours are overtime" policy classified this day. */
  fridayOvertimeApplied?: boolean;
  /** Actual vs. paid attendance of the date (1.1.7). */
  attendance: DayAttendance;
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
  /** Paid-absence minutes credited toward the weekly allowance (present only when > 0). */
  absenceCreditMinutes?: number;
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
  /** Business Friday policy history, used for employees whose setting is 'inherit'. Absent = 'none'. */
  businessFriday?: FridayPolicyChange[];
  /** Business absence defaults (1.1.7). Absent = statutory defaults, no weekly credit. */
  businessAbsence?: BusinessAbsenceDefaults;
  /**
   * Earliest date for which shifts and day statuses were loaded (continuous sickness periods and 3-month
   * averages look back this far). Default: the start of the weekly data range.
   */
  historyFrom?: LocalDate;
  /** Date of birth (1.1.9). Present → age-dependent (youth) rules are checked per attendance date. */
  birthDate?: LocalDate | null;
  /** Youth employment details (1.1.10). */
  youth?: YouthProfile | null;
  /** Youth rule set: 'Y2' (default) or 'Y1' for months finalised under 1.1.9. */
  youthRuleSet?: YouthRuleSet;
  /** Per-month manual value of a paid absence day (minutes), with the reason (1.1.9). */
  paidDayOverrides?: { ym: string; minutes: number; reason: string }[];
  /** Hours thresholds from verified agreement profiles (1.1.9). */
  agreementHours?: AgreementHoursRule[];
}

/** How a full paid absence day was valued in the reporting month (1.1.9). */
export interface PaidDayInfo {
  method: 'schedule' | 'fixed' | 'average_month' | 'average_3m' | 'override';
  /** Reference period of an average. */
  from: LocalDate | null;
  to: LocalDate | null;
  workedDays: number;
  workedMinutes: number;
  /** Minutes of a full paid absence day (null = cannot be determined). */
  dayMinutes: number | null;
  insufficient: boolean;
  /** The value calculated before a manual override. */
  calculatedMinutes?: number | null;
  overrideReason?: string;
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
  /** Actual vs. paid attendance totals of the period (1.1.7) — sums of days[].attendance. */
  attendance: AttendanceTotals;
  /** Valuation of a full paid absence day in the reporting month (1.1.9). */
  paidDay?: PaidDayInfo;
  /** Age-dependent classification (1.1.9): youth days found, or unverified when no birth date is stored. */
  age?: { birthDate: LocalDate | null; youthDays: number; turns18: LocalDate | null };
  /** Youth summary (rule set Y2, minors only). */
  youth?: YouthSummary;
}
