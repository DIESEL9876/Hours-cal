/**
 * Version 1.1.6 — Friday overtime policy for five-day-week employees.
 * 'all_overtime': every net Friday minute is overtime (first 2h 125%, then 150%), whatever the weekly total.
 * 'none' / absent: exactly the behaviour of earlier versions.
 */
import { describe, expect, it } from 'vitest';
import { calculateEmployeePeriod, defaultEmployeeSettings, type EmployeeSettings, type FridayPolicyChange, type ShiftInput } from '../index';
import { day, H, sh, versions } from './helpers';

const FRI = '2026-10-16'; // Friday, no holiday; sunset ≈ 18:05 (Tel Aviv, DST)
const WEEK = ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']; // Sun–Thu

const five = (over: Partial<EmployeeSettings> = {}) => defaultEmployeeSettings({ breakMethod: 'manual', ...over });

function calc(settings: EmployeeSettings, shifts: ShiftInput[], businessFriday?: FridayPolicyChange[], extra: Partial<Parameters<typeof calculateEmployeePeriod>[0]> = {}) {
  return calculateEmployeePeriod({
    employeeId: 'e',
    settingsVersions: versions(settings),
    shifts,
    dayStatuses: [],
    customHolidays: [],
    from: '2026-10-01',
    to: '2026-10-31',
    businessFriday,
    ...extra,
  });
}

const B = (value: 'all_overtime' | 'none'): FridayPolicyChange[] => [{ from: '1900-01-01', value }];

describe('five-day employee — "כל שעות יום שישי כשעות נוספות"', () => {
  it('the requested example: 06:00 net on Friday → 0 regular, 2:00 at 125%, 4:00 at 150% (even below 42 weekly hours)', () => {
    const r = calc(five({ fridayOvertime: 'all_overtime' }), [sh(FRI, '08:00', '14:00', { breakMinutes: 0 })]);
    const d = day(r, FRI);
    expect(d.netMinutes).toBe(H(6));
    expect(d.buckets).toMatchObject({ regular: 0, ot125: H(2), ot150: H(4) });
    expect(d.fridayOvertimeApplied).toBe(true);
    expect(d.warnings.some((w) => w.code === 'UNSCHEDULED_DAY_WORK')).toBe(false);
    expect(d.explanation.join(' ')).toContain('כל שעות העבודה נטו ביום שישי סווגו כשעות נוספות');
    expect(r.totals.buckets).toMatchObject({ regular: 0, ot125: H(2), ot150: H(4) });
  });

  it('a short Friday stays entirely in the 125% tier', () => {
    const d = day(calc(five({ fridayOvertime: 'all_overtime' }), [sh(FRI, '09:00', '10:30', { breakMinutes: 0 })]), FRI);
    expect(d.buckets).toMatchObject({ regular: 0, ot125: H(1, 30), ot150: 0 });
  });

  it('unpaid breaks are deducted before classification', () => {
    const d = day(calc(five({ fridayOvertime: 'all_overtime' }), [sh(FRI, '08:00', '14:30', { breakMinutes: 30, breakConfirmed: true })]), FRI);
    expect(d.breakMinutes).toBe(30);
    expect(d.buckets).toMatchObject({ regular: 0, ot125: H(2), ot150: H(4) });
    // Company-policy (estimated) break: also deducted first, and still requires confirmation as before.
    const est = day(calc(five({ fridayOvertime: 'all_overtime', breakMethod: 'company_auto' }), [sh(FRI, '08:00', '15:00')]), FRI);
    expect(est.breakMinutes).toBe(30);
    expect(est.buckets).toMatchObject({ regular: 0, ot125: H(2), ot150: H(4, 30) });
    expect(est.warnings.some((w) => w.code === 'BREAK_UNCONFIRMED')).toBe(true);
  });

  it('weekly overtime is not double-counted: Sunday–Thursday are classified exactly as before, Friday only once', () => {
    const week = WEEK.map((d) => sh(d, '08:00', '17:00', { breakMinutes: 0 })); // 5 × 9:00 = 45:00 net
    const fri = sh(FRI, '08:00', '11:00', { breakMinutes: 0 });
    const without = calc(five({ fridayOvertime: 'all_overtime' }), week);
    const withFri = calc(five({ fridayOvertime: 'all_overtime' }), [...week, fri]);
    for (const d of WEEK) expect(day(withFri, d).buckets).toEqual(day(without, d).buckets);
    expect(day(withFri, FRI).buckets).toMatchObject({ regular: 0, ot125: H(2), ot150: H(1) });
    expect(day(withFri, FRI).weeklyOvertimeMinutes).toBe(0);
    const w = withFri.weeks.find((x) => x.weekStart === '2026-10-11')!;
    expect(w.netMinutes).toBe(H(48));
    expect(w.regularCountedMinutes).toBe(without.weeks.find((x) => x.weekStart === '2026-10-11')!.regularCountedMinutes);
    // Every minute appears in exactly one bucket.
    const b = withFri.totals.buckets;
    expect(b.regular + b.ot125 + b.ot150).toBe(withFri.totals.netMinutes);
  });

  it('weekly-rest premium is kept: minutes after Friday sunset become overtime-with-rest-premium (never lower)', () => {
    const shift = [sh(FRI, '13:00', '21:00', { breakMinutes: 0 })];
    const rate = { hourlyRateAgorot: 5000 };
    const all = day(calc(five({ fridayOvertime: 'all_overtime', ...rate }), shift), FRI);
    const none = day(calc(five({ fridayOvertime: 'none', ...rate }), shift), FRI);
    const restAll = all.buckets.rest150 + all.buckets.rest175 + all.buckets.rest200;
    const restNone = none.buckets.rest150 + none.buckets.rest175 + none.buckets.rest200;
    expect(restAll).toBeGreaterThan(0);
    expect(restAll).toBe(restNone); // the same minutes fall in the rest window
    expect(all.buckets.rest150).toBe(0); // …but none of them at the plain rest rate any more
    expect(all.buckets.regular).toBe(0);
    expect(all.buckets.ot125 + all.buckets.rest175).toBe(H(2));
    expect(all.payAgorot!).toBeGreaterThanOrEqual(none.payAgorot!);
  });

  it('holiday premium is kept on a Friday holiday', () => {
    const extra = { customHolidays: [{ date: FRI, name: 'חג בדיקה' }] };
    const shift = [sh(FRI, '08:00', '12:00', { breakMinutes: 0 })];
    const all = day(calc(five({ fridayOvertime: 'all_overtime', hourlyRateAgorot: 5000 }), shift, undefined, extra), FRI);
    const none = day(calc(five({ fridayOvertime: 'none', hourlyRateAgorot: 5000 }), shift, undefined, extra), FRI);
    expect(none.buckets.holiday150).toBe(H(4));
    expect(all.buckets).toMatchObject({ holiday150: 0, holiday175: H(2), holiday200: H(2) });
    expect(all.payAgorot!).toBeGreaterThan(none.payAgorot!);
  });
});

describe('"ללא תוספת אוטומטית" and the default keep the exact earlier behaviour', () => {
  const shifts = [...WEEK.map((d) => sh(d, '07:30', '18:10', { breakMinutes: 30 })), sh(FRI, '08:00', '14:00', { breakMinutes: 0 }), sh('2026-10-23', '13:00', '20:30'), sh('2026-10-30', '07:00', '16:00')];

  it('explicit "none", absent setting, and inherit-from-a-"none"-business are identical to version 1.1.5', () => {
    const legacy = calc(defaultEmployeeSettings({ breakMethod: 'company_auto' }), shifts);
    for (const [s, b] of [
      [defaultEmployeeSettings({ breakMethod: 'company_auto', fridayOvertime: 'none' }), undefined],
      [defaultEmployeeSettings({ breakMethod: 'company_auto', fridayOvertime: 'inherit' }), undefined],
      [defaultEmployeeSettings({ breakMethod: 'company_auto', fridayOvertime: 'inherit' }), B('none')],
      [defaultEmployeeSettings({ breakMethod: 'company_auto', fridayOvertime: 'none' }), B('all_overtime')],
    ] as const) {
      expect(JSON.stringify(calc(s, shifts, b as FridayPolicyChange[] | undefined))).toBe(JSON.stringify(legacy));
    }
    // Earlier behaviour: that week already exceeds 42 hours, so Friday is statutory WEEKLY overtime
    // (still applied with "none" — the option never waives legal overtime).
    const d = day(legacy, FRI);
    expect(d.weeklyOvertimeMinutes).toBeGreaterThan(0);
    expect(d.buckets.regular + d.weeklyOvertimeMinutes).toBe(d.netMinutes);
    expect(d.fridayOvertimeApplied).toBeUndefined();
  });

  it('legal overtime still applies with "none": a long Friday is classified by the daily threshold', () => {
    const d = day(calc(five({ fridayOvertime: 'none' }), [sh(FRI, '06:00', '17:00', { breakMinutes: 0 })]), FRI);
    expect(d.buckets.ot125 + d.buckets.ot150).toBeGreaterThan(0);
  });
});

describe('business default and employee override', () => {
  const fri = [sh(FRI, '08:00', '14:00', { breakMinutes: 0 })];
  const ot = (r: ReturnType<typeof calc>) => day(r, FRI).buckets.ot125 + day(r, FRI).buckets.ot150;

  it('inherit follows the business setting; an explicit employee choice overrides it', () => {
    expect(ot(calc(five({ fridayOvertime: 'inherit' }), fri, B('all_overtime')))).toBe(H(6));
    expect(ot(calc(five({}), fri, B('all_overtime')))).toBe(H(6)); // absent = inherit
    expect(ot(calc(five({ fridayOvertime: 'inherit' }), fri, B('none')))).toBe(0);
    expect(ot(calc(five({ fridayOvertime: 'none' }), fri, B('all_overtime')))).toBe(0);
    expect(ot(calc(five({ fridayOvertime: 'all_overtime' }), fri, B('none')))).toBe(H(6));
  });

  it('business history is applied by date (a change does not reach back before its start)', () => {
    const history: FridayPolicyChange[] = [{ from: '2026-10-20', value: 'all_overtime' }];
    const r = calc(five({ fridayOvertime: 'inherit' }), [sh(FRI, '08:00', '14:00', { breakMinutes: 0 }), sh('2026-10-23', '08:00', '14:00', { breakMinutes: 0 })], history);
    expect(day(r, FRI).buckets.regular).toBe(H(6));
    expect(day(r, '2026-10-23').buckets).toMatchObject({ regular: 0, ot125: H(2), ot150: H(4) });
  });

  it('employee effective-date versions switch the policy on their date', () => {
    const r = calculateEmployeePeriod({
      employeeId: 'e',
      settingsVersions: versions(five({ fridayOvertime: 'none' }), [{ from: '2026-10-20', settings: five({ fridayOvertime: 'all_overtime' }) }]),
      shifts: [sh(FRI, '08:00', '14:00', { breakMinutes: 0 }), sh('2026-10-23', '08:00', '14:00', { breakMinutes: 0 })],
      dayStatuses: [],
      customHolidays: [],
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(day(r, FRI).buckets.ot125).toBe(0);
    expect(day(r, '2026-10-23').buckets.ot125).toBe(H(2));
  });
});

describe('not applied where it does not belong', () => {
  it('six-day employees: unchanged', () => {
    const shifts = [sh(FRI, '07:00', '15:00', { breakMinutes: 0 })];
    const six = (f?: 'all_overtime') => defaultEmployeeSettings({ workweek: 'six', breakMethod: 'manual', fridayOvertime: f });
    expect(JSON.stringify(calc(six('all_overtime'), shifts, B('all_overtime')))).toBe(JSON.stringify(calc(six(), shifts)));
  });

  it('exempt employees: no overtime classification at all', () => {
    const d = day(calc(five({ legalProfile: 'exempt', fridayOvertime: 'all_overtime' }), [sh(FRI, '08:00', '14:00', { breakMinutes: 0 })]), FRI);
    expect(d.buckets.unclassified).toBe(H(6));
  });

  it('other weekdays are untouched', () => {
    const shifts = WEEK.map((d) => sh(d, '08:00', '17:00', { breakMinutes: 30 }));
    expect(JSON.stringify(calc(five({ fridayOvertime: 'all_overtime' }), shifts))).toBe(JSON.stringify(calc(five(), shifts)));
  });
});
