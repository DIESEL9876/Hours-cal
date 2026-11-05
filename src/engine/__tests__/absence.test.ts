/**
 * 1.1.7 — actual vs. paid attendance, vacation, sickness, holidays, election days, weekly credit.
 * Absences exist only where the USER classified a date (dayStatuses); nothing is classified automatically.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateEmployeePeriod,
  defaultEmployeeSettings,
  formatDays,
  formatDecimalHours,
  type AbsenceDetails,
  type AbsenceSettings,
  type DayStatus,
  type DayStatusKind,
  type EmployeeSettings,
  type ShiftInput,
} from '../index';
import { day, H, sh, versions } from './helpers';

const st = (date: string, status: DayStatusKind, absence: AbsenceDetails = {}): DayStatus => ({ date, status, absence });
const emp = (absence: AbsenceSettings = {}, over: Partial<EmployeeSettings> = {}) =>
  defaultEmployeeSettings({ breakMethod: 'manual', absence: { salaryType: 'monthly', ...absence }, ...over });

function calc(s: EmployeeSettings, shifts: ShiftInput[], statuses: DayStatus[], from = '2026-11-01', to = '2026-11-30', extra: Partial<Parameters<typeof calculateEmployeePeriod>[0]> = {}) {
  return calculateEmployeePeriod({ employeeId: 'e', settingsVersions: versions(s), shifts, dayStatuses: statuses, customHolidays: [], from, to, historyFrom: '2026-07-01', ...extra });
}
const att = (r: ReturnType<typeof calc>, date: string) => day(r, date).attendance;

// November 2026: Sun 1, … Thu 5 is the shortened day (7:36), Sun–Wed 8:24.
describe('actual vs. paid days and hours', () => {
  it('worked days, paid days, actual hours and paid hours are separate; totals = sum of days', () => {
    const shifts = ['2026-11-01', '2026-11-02', '2026-11-03'].map((d) => sh(d, '08:00', '17:00', { breakMinutes: 30 })); // 8:30 net each
    const r = calc(emp(), shifts, [st('2026-11-04', 'vacation'), st('2026-11-05', 'sick')]);
    const a = r.attendance;
    expect(a.actualWorkedDays).toBe(3);
    expect(a.actualWorkedMinutes).toBe(3 * H(8, 30));
    expect(a.vacationDayHundredths).toBe(100);
    expect(a.sickDayHundredths).toBe(100);
    // Vacation Wed: 8:24 at 100%; sick Thu (day 1): 0%.
    expect(att(r, '2026-11-04')).toMatchObject({ paidAbsenceNominalMinutes: H(8, 24), payPercent: 100, paidAbsenceEquivalentMinutes: H(8, 24), paidDayHundredths: 100 });
    expect(att(r, '2026-11-05')).toMatchObject({ sickDayIndex: 1, payPercent: 0, paidAbsenceEquivalentMinutes: 0, paidDayHundredths: 0 });
    expect(a.paidDayHundredths).toBe(400);
    expect(a.payableEquivalentMinutes).toBe(3 * H(8, 30) + H(8, 24));
    // Paid hours never include overtime premiums and never change the worked buckets.
    expect(r.totals.netMinutes).toBe(3 * H(8, 30));
    // Reconciliation.
    const sum = (k: keyof (typeof r.days)[number]['attendance']) => r.days.reduce((n, d) => n + (d.attendance[k] as number), 0);
    expect(sum('payableEquivalentMinutes')).toBe(a.payableEquivalentMinutes);
    expect(sum('paidDayHundredths')).toBe(a.paidDayHundredths);
  });

  it('decimal display: hundredths of a day and decimal hours', () => {
    expect(formatDays(50)).toBe('0.50');
    expect(formatDays(1225)).toBe('12.25');
    expect(formatDecimalHours(H(4, 12))).toBe('4.20');
  });

  it('blank dates stay blank: no category, nothing paid', () => {
    const r = calc(emp(), [], []);
    expect(r.attendance).toMatchObject({ actualWorkedDays: 0, paidDayHundredths: 0, vacationDayHundredths: 0, sickDayHundredths: 0 });
    expect(r.days.every((d) => d.attendance.category === null && d.attendance.basis === 'none')).toBe(true);
  });
});

describe('vacation', () => {
  it('full day uses the employee schedule (shortened day 7:36, six-day 8:00, part-time contract)', () => {
    expect(att(calc(emp({}, { shortDay: 4 }), [], [st('2026-11-05', 'vacation')]), '2026-11-05').paidAbsenceNominalMinutes).toBe(H(7, 36));
    expect(att(calc(emp({}, { workweek: 'six', workDays: [0, 1, 2, 3, 4, 5], shortDay: null }), [], [st('2026-11-02', 'vacation')]), '2026-11-02').paidAbsenceNominalMinutes).toBe(H(8));
    expect(att(calc(emp({}, { contractDailyMinutes: H(5) }), [], [st('2026-11-02', 'vacation')]), '2026-11-02').paidAbsenceNominalMinutes).toBe(H(5));
  });

  it('partial vacation + actual work on the same date: day counted once', () => {
    const r = calc(emp(), [sh('2026-11-02', '08:00', '12:12', { breakMinutes: 0 })], [st('2026-11-02', 'vacation', { minutes: H(4, 12) })]);
    const a = att(r, '2026-11-02');
    expect(a).toMatchObject({ actualWorkedMinutes: H(4, 12), paidAbsenceEquivalentMinutes: H(4, 12), absenceDayHundredths: 50, paidDayHundredths: 100, payableEquivalentMinutes: H(8, 24) });
    expect(r.attendance.actualWorkedDays).toBe(1);
    expect(r.attendance.vacationDayHundredths).toBe(50);
  });

  it('no double counting: a full-day vacation mark on a worked day adds no absence and is flagged', () => {
    const a = att(calc(emp(), [sh('2026-11-02', '08:00', '16:24', { breakMinutes: 0 })], [st('2026-11-02', 'vacation')]), '2026-11-02');
    expect(a).toMatchObject({ paidAbsenceEquivalentMinutes: 0, absenceDayHundredths: 0, paidDayHundredths: 100, basis: 'review' });
  });

  it('vacation on a non-working day is not used up; manual override needs a reason', () => {
    expect(att(calc(emp(), [], [st('2026-11-06', 'vacation')]), '2026-11-06')).toMatchObject({ absenceDayHundredths: 0, paidAbsenceNominalMinutes: 0 });
    const o = att(calc(emp(), [], [st('2026-11-02', 'vacation', { payPercentOverride: 50 })]), '2026-11-02');
    expect(o).toMatchObject({ payPercent: 50, basis: 'review' });
  });

  it('hourly employee: 3-month average daily hours, marked as an estimate', () => {
    const hist = ['2026-08-03', '2026-08-04', '2026-09-01', '2026-09-02', '2026-10-05', '2026-10-06'].map((d) => sh(d, '09:00', '15:00', { breakMinutes: 0 }));
    const a = att(calc(emp({ salaryType: 'hourly' }), hist, [st('2026-11-02', 'vacation')]), '2026-11-02');
    expect(a.paidAbsenceNominalMinutes).toBe(H(6));
    expect(a.basis).toBe('estimate');
  });
});

describe('sickness', () => {
  const four = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map((d) => st(d, 'sick'));
  it('days 1–4: 0%, 50%, 50%, 100% — e.g. day 2 with 8:24 = 4:12 paid equivalent, still a full sick day', () => {
    const r = calc(emp(), [], four);
    expect(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map((d) => [att(r, d).sickDayIndex, att(r, d).payPercent])).toEqual([
      [1, 0],
      [2, 50],
      [3, 50],
      [4, 100],
    ]);
    expect(att(r, '2026-11-03')).toMatchObject({ paidAbsenceNominalMinutes: H(8, 24), paidAbsenceEquivalentMinutes: H(4, 12), absenceDayHundredths: 100, paidDayHundredths: 50 });
    expect(r.attendance.sickDayHundredths).toBe(400);
    expect(r.attendance.sickPaidDayHundredths).toBe(0 + 50 + 50 + 100);
    expect(att(r, '2026-11-03').reviewReasons.join(' ')).toContain('יתרה');
  });

  it('a sickness period continues across the month boundary', () => {
    const statuses = [st('2026-10-29', 'sick'), st('2026-11-01', 'sick'), st('2026-11-02', 'sick')]; // Thu, (Fri, Sat), Sun, Mon
    const r = calc(emp(), [], statuses);
    expect(att(r, '2026-11-01').sickDayIndex).toBe(4);
    expect(att(r, '2026-11-01').payPercent).toBe(100);
    expect(att(r, '2026-11-02').sickDayIndex).toBe(5);
  });

  it('monthly vs hourly: rest days inside the period count for monthly; hourly is paid only for workdays', () => {
    const statuses = [st('2026-11-05', 'sick'), st('2026-11-08', 'sick')]; // Thu, Sun
    const monthly = calc(emp(), [], statuses);
    const hourly = calc(emp({ salaryType: 'hourly', paidDayReference: 'schedule' }), [], statuses);
    expect(att(monthly, '2026-11-08')).toMatchObject({ sickDayIndex: 4, payPercent: 100 });
    expect(att(hourly, '2026-11-08')).toMatchObject({ sickDayIndex: 4, payPercent: 100 });
    // Sick-balance deduction estimate: a marked Friday counts for a monthly employee, not for an hourly one.
    const fri = [st('2026-11-05', 'sick'), st('2026-11-06', 'sick')];
    expect(att(calc(emp(), [], fri), '2026-11-06').sickBalanceDeductionHundredths).toBe(100);
    expect(att(calc(emp({ salaryType: 'hourly', paidDayReference: 'schedule' }), [], fri), '2026-11-06').sickBalanceDeductionHundredths).toBe(0);
  });

  it('a workday without a sick mark ends the period', () => {
    const r = calc(emp(), [], [st('2026-11-02', 'sick'), st('2026-11-04', 'sick')]);
    expect(att(r, '2026-11-04').sickDayIndex).toBe(1);
  });

  it('more favourable arrangements; a manual rate below the statute is not applied', () => {
    expect(att(calc(emp({ sick: 'full_from_day1' }), [], four), '2026-11-02').payPercent).toBe(100);
    expect(att(calc(emp({ sick: 'full_from_day2' }), [], four), '2026-11-03').payPercent).toBe(100);
    const r = calc(emp(), [], [...four.slice(0, 3), st('2026-11-05', 'sick', { payPercentOverride: 50, overrideReason: 'בדיקה' })]);
    expect(att(r, '2026-11-05').payPercent).toBe(100);
  });

  it('partial sick day', () => {
    const a = att(calc(emp(), [sh('2026-11-02', '08:00', '12:00', { breakMinutes: 0 })], [st('2026-11-01', 'sick'), st('2026-11-02', 'sick', { minutes: H(4, 24) })]), '2026-11-02');
    expect(a).toMatchObject({ sickDayIndex: 2, payPercent: 50, paidAbsenceNominalMinutes: H(4, 24), paidAbsenceEquivalentMinutes: H(2, 12), actualWorkedMinutes: H(4) });
  });
});

describe('holidays (Yom Kippur, Monday 21/09/2026)', () => {
  const YK = '2026-09-21';
  const sep = (s: EmployeeSettings, shifts: ShiftInput[], statuses: DayStatus[]) => calc(s, shifts, statuses, '2026-09-01', '2026-09-30', { historyFrom: '2026-06-01' });
  const around = [sh('2026-09-20', '08:00', '15:00', { breakMinutes: 0 }), sh('2026-09-22', '08:00', '16:24', { breakMinutes: 0 })];

  it('monthly employee: included in the salary — paid, counted as a holiday, not as vacation', () => {
    const r = sep(emp(), around, [st(YK, 'holiday')]);
    expect(att(r, YK)).toMatchObject({ payPercent: 100, paidAbsenceNominalMinutes: H(8, 24), basis: 'rule' });
    expect(r.attendance).toMatchObject({ holidayDayHundredths: 100, vacationDayHundredths: 0 });
  });

  it('hourly employee: eligible with seniority and work around the holiday', () => {
    const a = att(sep(emp({ salaryType: 'hourly', paidDayReference: 'schedule', employmentStart: '2025-01-01' }), around, [st(YK, 'holiday')]), YK);
    expect(a.payPercent).toBe(100);
  });

  it('hourly employee: not eligible with < 3 months seniority; unknown seniority → review', () => {
    expect(att(sep(emp({ salaryType: 'hourly', employmentStart: '2026-08-01' }), around, [st(YK, 'holiday')]), YK).payPercent).toBe(0);
    const u = att(sep(emp({ salaryType: 'hourly' }), around, [st(YK, 'holiday')]), YK);
    expect(u).toMatchObject({ payPercent: null, basis: 'review' });
  });

  it('hourly employee: absence without consent on the day before → review until consent is confirmed', () => {
    const s = emp({ salaryType: 'hourly', paidDayReference: 'schedule', employmentStart: '2025-01-01' });
    const noBefore = [sh('2026-09-22', '08:00', '16:24', { breakMinutes: 0 })];
    expect(att(sep(s, noBefore, [st(YK, 'holiday')]), YK).payPercent).toBeNull();
    expect(att(sep(s, noBefore, [st(YK, 'holiday', { eligibility: 'confirmed' })]), YK).payPercent).toBe(100);
  });

  it('hourly employee, five-day week: a holiday on Friday/Saturday is not paid', () => {
    const r = calc(emp({ salaryType: 'hourly', employmentStart: '2020-01-01' }), [], [st('2026-11-06', 'holiday', { holidayName: 'חג בדיקה' })], '2026-11-01', '2026-11-30', { customHolidays: [{ date: '2026-11-06', name: 'חג בדיקה' }] });
    expect(att(r, '2026-11-06').payPercent).toBe(0);
  });

  it('working on a holiday stays work with the existing holiday premium — not a paid absence', () => {
    const r = sep(emp(), [sh('2026-09-13', '09:00', '13:00', { breakMinutes: 0 })], [st('2026-09-13', 'holiday')]);
    const d = day(r, '2026-09-13');
    expect(d.attendance).toMatchObject({ absenceDayHundredths: 0, paidAbsenceEquivalentMinutes: 0, actualWorkedMinutes: H(4) });
    expect(d.buckets.holiday150 + d.buckets.holiday175 + d.buckets.holiday200).toBe(H(4));
  });
});

describe('election days', () => {
  const E = '2026-11-03'; // Tuesday
  it('Knesset election with 14+ days of employment and a scheduled workday: paid, not vacation', () => {
    const r = calc(emp({ employmentStart: '2026-01-01' }), [], [st(E, 'election', { electionType: 'knesset' })]);
    expect(att(r, E)).toMatchObject({ payPercent: 100, paidAbsenceNominalMinutes: H(8, 24) });
    expect(r.attendance).toMatchObject({ electionDayHundredths: 100, vacationDayHundredths: 0 });
  });
  it('fewer than 14 days → not paid; missing type / start date / local registration → review', () => {
    expect(att(calc(emp({ employmentStart: '2026-10-25' }), [], [st(E, 'election', { electionType: 'knesset' })]), E).payPercent).toBe(0);
    expect(att(calc(emp({ employmentStart: '2026-01-01' }), [], [st(E, 'election')]), E)).toMatchObject({ payPercent: null, basis: 'review' });
    expect(att(calc(emp(), [], [st(E, 'election', { electionType: 'knesset' })]), E).payPercent).toBeNull();
    expect(att(calc(emp({ employmentStart: '2026-01-01' }), [], [st(E, 'election', { electionType: 'local' })]), E).payPercent).toBeNull();
    expect(att(calc(emp({ employmentStart: '2026-01-01' }), [], [st(E, 'election', { electionType: 'local', eligibility: 'confirmed' })]), E).payPercent).toBe(100);
    expect(att(calc(emp({ employmentStart: '2026-01-01' }), [], [st(E, 'election', { electionType: 'other' })]), E).basis).toBe('review');
  });
  it('working on election day: actual hours kept, no automatic 200%, flagged', () => {
    const r = calc(emp({ employmentStart: '2026-01-01' }), [sh(E, '08:00', '16:00', { breakMinutes: 0 })], [st(E, 'election', { electionType: 'knesset' })]);
    expect(day(r, E).buckets).toMatchObject({ regular: H(8), ot125: 0, ot150: 0 });
    expect(att(r, E)).toMatchObject({ paidAbsenceEquivalentMinutes: 0, basis: 'review' });
  });
});

describe('weekly overtime credit for paid absence', () => {
  // Week Sun 1/11 – Sat 7/11. Vacation Sunday (8:24), then Mon–Thu 9:00 net = 36:00 worked, then Friday 6:00.
  const work = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map((d) => sh(d, '08:00', '17:00', { breakMinutes: 0 }));
  const fri = sh('2026-11-06', '08:00', '14:00', { breakMinutes: 0 });
  const vac = [st('2026-11-01', 'vacation')];

  it('with the credit, Friday work after a paid-absence week becomes weekly overtime (absence minutes themselves never become overtime)', () => {
    const without = calc(emp({ weeklyCredit: 'none' }), [...work, fri], vac);
    const withCredit = calc(emp({ weeklyCredit: 'paid_absence' }), [...work, fri], vac);
    // Mon–Thu identical (credit only affects work AFTER the absence is counted and the allowance is reached).
    expect(day(withCredit, '2026-11-06').weeklyOvertimeMinutes).toBeGreaterThan(day(without, '2026-11-06').weeklyOvertimeMinutes);
    // Total classified minutes = actual worked minutes only.
    const b = withCredit.totals.buckets;
    expect(b.regular + b.ot125 + b.ot150).toBe(withCredit.totals.netMinutes);
    expect(withCredit.totals.netMinutes).toBe(4 * H(9) + H(6));
    expect(withCredit.weeks.find((w) => w.weekStart === '2026-11-01')!.absenceCreditMinutes).toBe(H(8, 24));
    expect(day(withCredit, '2026-11-06').explanation.join(' ')).toContain('זיכוי');
  });

  it('the Friday "all hours as overtime" policy is unchanged by the credit', () => {
    const a = calc(emp({ weeklyCredit: 'paid_absence' }, { fridayOvertime: 'all_overtime' }), [...work, fri], vac);
    expect(day(a, '2026-11-06').buckets).toMatchObject({ regular: 0, ot125: H(2), ot150: H(4) });
  });

  it('unpaid absence and sick day 1 give no credit', () => {
    const r = calc(emp({ weeklyCredit: 'paid_absence' }), work, [st('2026-11-01', 'unpaid')]);
    expect(r.weeks.find((w) => w.weekStart === '2026-11-01')!.absenceCreditMinutes).toBeUndefined();
    expect(att(calc(emp({ weeklyCredit: 'paid_absence' }), [], [st('2026-11-01', 'sick')]), '2026-11-01').weeklyCreditMinutes).toBe(0);
  });

  it('default (no setting) = no credit = identical overtime to earlier versions', () => {
    const legacy = calc(defaultEmployeeSettings({ breakMethod: 'manual' }), [...work, fri], vac);
    const none = calc(emp({ weeklyCredit: 'none' }), [...work, fri], vac);
    expect(JSON.stringify(legacy.days.map((d) => d.buckets))).toBe(JSON.stringify(none.days.map((d) => d.buckets)));
  });
});
