/**
 * 1.1.9 — value of a paid absence day (manual / month average / previous-3-months average, overrides, office
 * estimate in agorot) and Youth Employment Law checks per attendance date.
 */
import { describe, expect, it } from 'vitest';
import { ageOn, calculateEmployeePeriod, defaultEmployeeSettings, youthMinimumHourly, type AbsenceSettings, type DayStatus, type EmployeeSettings, type ShiftInput } from '../index';
import { day, H, sh, versions } from './helpers';

const emp = (absence: AbsenceSettings = {}, over: Partial<EmployeeSettings> = {}) =>
  defaultEmployeeSettings({ breakMethod: 'manual', absence: { salaryType: 'hourly', ...absence }, hourlyRateAgorot: 5000, ...over });
const vac = (date: string): DayStatus => ({ date, status: 'vacation' });
function calc(s: EmployeeSettings, shifts: ShiftInput[], statuses: DayStatus[], from = '2026-11-01', to = '2026-11-30', extra: Partial<Parameters<typeof calculateEmployeePeriod>[0]> = {}) {
  return calculateEmployeePeriod({ employeeId: 'e', settingsVersions: versions(s), shifts, dayStatuses: statuses, customHolidays: [], from, to, historyFrom: '2026-07-01', ...extra });
}
const att = (r: ReturnType<typeof calc>, d: string) => day(r, d).attendance;

describe('value of a paid absence day', () => {
  it('manual daily hours (8.40 decimal = 8:24) × base hourly rate × payment fraction', () => {
    const r = calc(emp({ paidDayReference: 'fixed', paidDayMinutes: H(8, 24) }), [], [vac('2026-11-02'), { date: '2026-11-04', status: 'sick' }, { date: '2026-11-05', status: 'sick' }]);
    expect(att(r, '2026-11-02')).toMatchObject({ paidAbsenceNominalMinutes: H(8, 24), paidAbsenceEquivalentMinutes: H(8, 24), estimatedValueAgorot: 42000, valueBasis: 'office' }); // 50 ₪ × 8.4
    expect(att(r, '2026-11-04')).toMatchObject({ payPercent: 0, estimatedValueAgorot: 0 }); // sick day 1
    expect(att(r, '2026-11-05')).toMatchObject({ payPercent: 50, paidAbsenceEquivalentMinutes: H(4, 12), estimatedValueAgorot: 21000 }); // sick day 2
    expect(r.attendance.estimatedAbsenceValueAgorot).toBe(63000);
    expect(r.paidDay).toMatchObject({ method: 'fixed', dayMinutes: H(8, 24) });
  });

  it('average of the selected month: actual net minutes / distinct worked days (two shifts = one day; absences excluded)', () => {
    const shifts = [
      sh('2026-11-01', '08:00', '14:00', { breakMinutes: 0 }), // 6:00
      sh('2026-11-02', '08:00', '12:00', { breakMinutes: 0 }), // 4:00 …
      sh('2026-11-02', '16:00', '20:00', { breakMinutes: 0 }), // … + 4:00 = 8:00 on ONE day
      sh('2026-11-03', '09:00', '17:00', { breakMinutes: 60 }), // 7:00 after the unpaid break
    ];
    const r = calc(emp({ paidDayReference: 'average_month' }), shifts, [vac('2026-11-10')]);
    expect(r.paidDay).toMatchObject({ method: 'average_month', workedDays: 3, workedMinutes: H(21), dayMinutes: H(7), insufficient: false });
    expect(att(r, '2026-11-10')).toMatchObject({ paidAbsenceNominalMinutes: H(7), estimatedValueAgorot: 35000 });
    // No circularity: the vacation's 7:00 does not enter the average (still 3 days / 21 h).
    expect(r.attendance.actualWorkedMinutes).toBe(H(21));
  });

  it('previous three COMPLETE months (Aug–Oct for a November absence), distinct worked days, not calendar days', () => {
    const shifts = [sh('2026-08-03', '08:00', '18:00', { breakMinutes: 0 }), sh('2026-10-29', '08:00', '14:00', { breakMinutes: 0 }), sh('2026-11-02', '08:00', '20:00', { breakMinutes: 0 })];
    const r = calc(emp({ paidDayReference: 'average_3m' }), shifts, [vac('2026-11-10')]);
    expect(r.paidDay).toMatchObject({ method: 'average_3m', from: '2026-08-01', to: '2026-10-31', workedDays: 2, workedMinutes: H(16), dayMinutes: H(8) });
    expect(att(r, '2026-11-10').paidAbsenceNominalMinutes).toBe(H(8));
    // Month boundary: a single worked day is enough; November's own work is not part of it.
    const one = calc(emp({ paidDayReference: 'average_3m' }), [sh('2026-09-15', '10:00', '15:30', { breakMinutes: 0 })], [vac('2026-11-10')]);
    expect(one.paidDay?.dayMinutes).toBe(H(5, 30));
  });

  it('no worked days: never a silent 8.4 hours — "אין מספיק נתונים לחישוב ממוצע", no division by zero', () => {
    const r = calc(emp({ paidDayReference: 'average_3m' }), [], [vac('2026-11-10')]);
    expect(r.paidDay).toMatchObject({ insufficient: true, dayMinutes: null, workedDays: 0 });
    const a = att(r, '2026-11-10');
    expect(a.paidAbsenceNominalMinutes).toBe(0);
    expect(a.basis).toBe('review');
    expect(a.reviewReasons.join()).toContain('אין מספיק נתונים לחישוב ממוצע');
    const m = calc(emp({ paidDayReference: 'average_month' }), [], [vac('2026-11-10')]);
    expect(att(m, '2026-11-10').paidAbsenceNominalMinutes).toBe(0);
  });

  it('a monthly override replaces the calculated value and keeps the original and the reason', () => {
    const r = calc(emp({ paidDayReference: 'average_month' }), [sh('2026-11-01', '08:00', '14:00', { breakMinutes: 0 })], [vac('2026-11-10')], '2026-11-01', '2026-11-30', {
      paidDayOverrides: [{ ym: '2026-11', minutes: H(8), reason: 'הסכם אישי' }],
    });
    expect(r.paidDay).toMatchObject({ method: 'override', dayMinutes: H(8), calculatedMinutes: H(6), overrideReason: 'הסכם אישי' });
    expect(att(r, '2026-11-10').paidAbsenceNominalMinutes).toBe(H(8));
    // October is not affected by a November override.
    const oct = calc(emp({ paidDayReference: 'average_month' }), [sh('2026-10-05', '08:00', '14:00', { breakMinutes: 0 })], [vac('2026-10-12')], '2026-10-01', '2026-10-31', {
      paidDayOverrides: [{ ym: '2026-11', minutes: H(8), reason: 'x' }],
    });
    expect(att(oct, '2026-10-12').paidAbsenceNominalMinutes).toBe(H(6));
  });

  it('monthly salaried employee: paid within the salary — no extra payment (no double pay)', () => {
    const r = calc(emp({ salaryType: 'monthly', paidDayReference: 'fixed', paidDayMinutes: H(8, 24) }), [], [vac('2026-11-02')]);
    expect(att(r, '2026-11-02')).toMatchObject({ valueBasis: 'in_salary', estimatedValueAgorot: 0, paidAbsenceEquivalentMinutes: H(8, 24) });
  });

  it('reserve duty is never valued as hourly absence pay', () => {
    const r = calc(emp({ paidDayReference: 'fixed', paidDayMinutes: H(8) }), [], [{ date: '2026-11-02', status: 'reserve' }]);
    expect(att(r, '2026-11-02')).toMatchObject({ valueBasis: 'statutory_formula', estimatedValueAgorot: 0, paidAbsenceEquivalentMinutes: 0 });
    expect(r.attendance.reserveDayHundredths).toBe(100);
  });

  it('decimal precision: agorot are rounded once per day, totals are sums of days', () => {
    const r = calc(emp({ paidDayReference: 'fixed', paidDayMinutes: H(7, 13) }, { hourlyRateAgorot: 3533 }), [], [vac('2026-11-02'), vac('2026-11-03')]);
    const one = Math.floor((3533 * H(7, 13)) / 60 + 0.5);
    expect(att(r, '2026-11-02').estimatedValueAgorot).toBe(one);
    expect(r.attendance.estimatedAbsenceValueAgorot).toBe(2 * one);
  });
});

describe('youth employment (age per attendance date)', () => {
  const youthShifts = (dates: string[], s = '08:00', e = '17:30', brk = 30) => dates.map((d) => sh(d, s, e, { breakMinutes: brk }));
  const codes = (r: ReturnType<typeof calc>, d: string) => day(r, d).warnings.map((w) => w.code);

  it('age on the date; turning 18 during the month', () => {
    expect(ageOn('2008-11-15', '2026-11-14')).toBe(17);
    expect(ageOn('2008-11-15', '2026-11-15')).toBe(18);
    const r = calc(emp(), youthShifts(['2026-11-12', '2026-11-16'], '08:00', '18:00', 30), [], '2026-11-01', '2026-11-30', { birthDate: '2008-11-15' });
    expect(codes(r, '2026-11-12')).toContain('YOUTH_DAILY_LIMIT'); // 9:30 at 17
    expect(codes(r, '2026-11-16')).not.toContain('YOUTH_DAILY_LIMIT'); // adult from the birthday
    expect(r.age).toMatchObject({ youthDays: 1, turns18: '2026-11-15' });
  });

  it('missing birth date: adult rules provisionally, no youth warnings, classification unverified', () => {
    const r = calc(emp(), youthShifts(['2026-11-02'], '08:00', '18:00'), []);
    expect(r.age).toMatchObject({ birthDate: null, youthDays: 0 });
    expect(codes(r, '2026-11-02').some((c) => c.startsWith('YOUTH'))).toBe(false);
  });

  it('16–17 in a five-day week: 9 hours allowed, 40-hour week, overtime flagged — worked minutes preserved', () => {
    const shifts = youthShifts(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'], '08:00', '17:30', 30); // 9:00 net
    shifts.push(sh('2026-11-05', '08:00', '16:30', { breakMinutes: 30 })); // 8:00 → week 44:00
    const r = calc(emp(), shifts, [], '2026-11-01', '2026-11-30', { birthDate: '2009-06-01' });
    expect(codes(r, '2026-11-01')).not.toContain('YOUTH_DAILY_LIMIT');
    expect(r.days.flatMap((d) => d.warnings).some((w) => w.code === 'YOUTH_WEEKLY_LIMIT')).toBe(true);
    expect(r.days.flatMap((d) => d.warnings).some((w) => w.code === 'YOUTH_PAY_REVIEW')).toBe(true);
    expect(r.totals.netMinutes).toBe(H(44)); // nothing erased
    // Adult overtime-permit limits are not applied to the minor's week.
    expect(r.days.flatMap((d) => d.warnings).some((w) => w.code === 'WEEKLY_OT_LIMIT')).toBe(false);
  });

  it('under 16: 8-hour day, night from 20:00, under 15 flagged; break of 45 minutes after 6 hours', () => {
    const r = calc(emp(), [sh('2026-11-02', '12:00', '21:00', { breakMinutes: 30 })], [], '2026-11-01', '2026-11-30', { birthDate: '2011-03-01' }); // 15 years old
    const c = codes(r, '2026-11-02');
    expect(c).toContain('YOUTH_DAILY_LIMIT'); // 8:30 > 8:00
    expect(c).toContain('YOUTH_NIGHT'); // 20:00–21:00
    expect(c).toContain('YOUTH_BREAK'); // 30 < 45
    expect(c).not.toContain('YOUTH_MIN_AGE');
    const child = calc(emp(), [sh('2026-11-02', '09:00', '12:00', { breakMinutes: 0 })], [], '2026-11-01', '2026-11-30', { birthDate: '2012-12-01' });
    expect(codes(child, '2026-11-02')).toContain('YOUTH_MIN_AGE');
  });

  it('16–17: night from 22:00; work on the weekly rest flagged', () => {
    const r = calc(emp(), [sh('2026-11-03', '15:00', '22:30', { breakMinutes: 0 })], [], '2026-11-01', '2026-11-30', { birthDate: '2009-06-01' });
    expect(codes(r, '2026-11-03')).toContain('YOUTH_NIGHT');
    const sat = calc(emp(), [sh('2026-11-07', '10:00', '14:00', { breakMinutes: 0 })], [], '2026-11-01', '2026-11-30', { birthDate: '2009-06-01' });
    expect(codes(sat, '2026-11-07')).toContain('YOUTH_REST_DAY');
  });

  it('youth minimum wage (from 1.4.2026) — compliance warning, never a changed rate', () => {
    expect(youthMinimumHourly('2026-11-02', 15)?.agorot).toBe(2607);
    expect(youthMinimumHourly('2026-11-02', 16)?.agorot).toBe(2794);
    expect(youthMinimumHourly('2026-11-02', 17)?.agorot).toBe(3092);
    expect(youthMinimumHourly('2025-11-02', 17)).toBeNull(); // no verified table → no automatic check
    const r = calc(emp({}, { hourlyRateAgorot: 2700 }), [sh('2026-11-02', '09:00', '13:00', { breakMinutes: 0 })], [], '2026-11-01', '2026-11-30', { birthDate: '2009-06-01' }); // 17
    expect(codes(r, '2026-11-02')).toContain('YOUTH_MIN_WAGE');
  });

  it('legacy "minor" profile with a birth date: hours are classified (no longer "unsupported")', () => {
    const s = emp({}, { legalProfile: 'minor' });
    const before = calc(s, [sh('2026-11-02', '09:00', '13:00', { breakMinutes: 0 })], []);
    expect(before.totals.buckets.unclassified).toBe(H(4));
    const after = calc(s, [sh('2026-11-02', '09:00', '13:00', { breakMinutes: 0 })], [], '2026-11-01', '2026-11-30', { birthDate: '2009-06-01' });
    expect(after.totals.buckets.regular).toBe(H(4));
    expect(after.warnings.some((w) => w.code === 'MINOR_UNSUPPORTED')).toBe(false);
  });
});

describe('verified agreement hours thresholds', () => {
  it('a verified rule profile changes the daily/weekly thresholds and cites its source', () => {
    const rule = { from: '2026-01-01', to: null, dailyThresholdMinutes: [H(8), H(8), H(8), H(8), H(8), H(8), H(8)], weeklyThresholdMinutes: H(40), firstTierMinutes: 120, source: 'פרופיל בדיקה (מאומת)' };
    const shifts = [sh('2026-11-02', '08:00', '17:00', { breakMinutes: 30 })]; // 8:30
    const general = calc(emp(), shifts, []);
    const agreed = calc(emp(), shifts, [], '2026-11-01', '2026-11-30', { agreementHours: [rule] });
    expect(day(general, '2026-11-02').buckets.ot125).toBe(6); // above 8:24
    expect(day(agreed, '2026-11-02').buckets.ot125).toBe(30); // above 8:00
    expect(day(agreed, '2026-11-02').thresholdReasons.join()).toContain('פרופיל בדיקה (מאומת)');
  });
});
