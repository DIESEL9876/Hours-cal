import {
  addDays,
  calculateEmployeePeriod,
  defaultEmployeeSettings,
  type EmployeePeriodInput,
  type EmployeeSettings,
  type LocalDate,
  type ShiftInput,
  type DayStatus,
  type CustomHoliday,
  type SettingsVersion,
  BEGINNING_OF_TIME,
} from '../index';

let seq = 0;

export interface ShiftOpts {
  breakMinutes?: number | null;
  breakStart?: string | null;
  breakConfirmed?: boolean;
  breakPaid?: boolean;
  id?: string;
}

/** Build a shift from row date + HH:mm entry/exit. Exit <= entry means the next day (overnight). */
export function sh(date: LocalDate, start: string | null, end: string | null, opts: ShiftOpts = {}): ShiftInput {
  let endAt: string | null = null;
  if (end !== null && start !== null) endAt = end <= start ? `${addDays(date, 1)}T${end}` : `${date}T${end}`;
  else if (end !== null) endAt = `${date}T${end}`;
  return {
    id: opts.id ?? `s${++seq}`,
    workDate: date,
    startAt: start === null ? null : `${date}T${start}`,
    endAt,
    breakMinutes: opts.breakMinutes === undefined ? null : opts.breakMinutes,
    breakStart: opts.breakStart ?? null,
    breakConfirmed: opts.breakConfirmed ?? false,
    breakPaid: opts.breakPaid ?? false,
    reviewed: false,
  };
}

export function versions(settings: EmployeeSettings, more: { from: LocalDate; settings: EmployeeSettings }[] = []): SettingsVersion[] {
  return [
    { id: 'v0', effectiveFrom: BEGINNING_OF_TIME, settings },
    ...more.map((m, i) => ({ id: `v${i + 1}`, effectiveFrom: m.from, settings: m.settings })),
  ];
}

export function run(
  settings: Partial<EmployeeSettings> | EmployeeSettings,
  shifts: ShiftInput[],
  from: LocalDate,
  to: LocalDate,
  extra: { dayStatuses?: DayStatus[]; customHolidays?: CustomHoliday[]; versions?: SettingsVersion[] } = {},
) {
  const s = 'workDays' in settings && 'companyBreakPolicy' in settings ? (settings as EmployeeSettings) : defaultEmployeeSettings(settings);
  const input: EmployeePeriodInput = {
    employeeId: 'e1',
    settingsVersions: extra.versions ?? versions(s),
    shifts,
    dayStatuses: extra.dayStatuses ?? [],
    customHolidays: extra.customHolidays ?? [],
    from,
    to,
  };
  return calculateEmployeePeriod(input);
}

export function day(result: ReturnType<typeof run>, date: LocalDate) {
  const d = result.days.find((x) => x.date === date);
  if (!d) throw new Error(`no day ${date}`);
  return d;
}

export const H = (h: number, m = 0) => h * 60 + m;

/** Deterministic PRNG (mulberry32) for property tests. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
