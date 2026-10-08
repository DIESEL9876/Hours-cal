/**
 * The 15 mandatory calculation scenarios from the specification.
 * Reference week: Sunday 2026-10-11 … Saturday 2026-10-17 (no holidays, standard time = IDT).
 */
import { describe, expect, it } from 'vitest';
import {
  defaultEmployeeSettings,
  sumBuckets,
  sunsetMs,
  localToUtc,
  MINUTE_MS,
  calculateDeductibleBreakMinutes,
  companyPolicyBreak,
} from '../index';
import { H, day, run, sh, versions } from './helpers';

const SUN = '2026-10-11';
const MON = '2026-10-12';
const TUE = '2026-10-13';
const WED = '2026-10-14';
const THU = '2026-10-15';
const FRI = '2026-10-16';
const SAT = '2026-10-17';

describe('Test 1 — five-day ordinary day', () => {
  const r = run({ workweek: 'five' }, [sh(SUN, '08:00', '18:00', { breakMinutes: 30 })], SUN, SAT);
  const d = day(r, SUN);
  it('net, threshold, regular and overtime', () => {
    expect(d.grossMinutes).toBe(H(10));
    expect(d.breakMinutes).toBe(30);
    expect(d.netMinutes).toBe(H(9, 30));
    expect(d.dailyThresholdMinutes).toBe(H(8, 36));
    expect(d.buckets.regular).toBe(H(8, 36));
    expect(d.buckets.ot125).toBe(54);
    expect(d.buckets.ot150).toBe(0);
  });
  it('produces the Hebrew audit explanation', () => {
    expect(d.explanation.join(' ')).toContain(
      'לאחר ניכוי הפסקה של 30 דקות, העובד עבד 9 שעות ו-30 דקות נטו. תקן היום הוא 8 שעות ו-36 דקות, ולכן חושבו 54 דקות נוספות בתעריף 125%.',
    );
    expect(d.explanation).toContain('תקן היום הוא 8 שעות ו-36 דקות, ולכן חושבו 54 דקות נוספות בתעריף 125%.');
  });
});

describe('Test 2 — five-day shortened day', () => {
  it('uses 7:36 on the configured short day', () => {
    const r = run({ workweek: 'five', shortDay: 4 }, [sh(THU, '08:00', '17:00', { breakMinutes: 30 })], SUN, SAT);
    const d = day(r, THU);
    expect(d.netMinutes).toBe(H(8, 30));
    expect(d.dailyThresholdMinutes).toBe(H(7, 36));
    expect(d.shortDay).toBe(true);
    expect(d.buckets.regular).toBe(H(7, 36));
    expect(d.buckets.ot125).toBe(54);
  });
  it('the short day is configurable (Sunday)', () => {
    const r = run({ workweek: 'five', shortDay: 0 }, [sh(SUN, '08:00', '17:00', { breakMinutes: 30 }), sh(THU, '08:00', '17:00', { breakMinutes: 30 })], SUN, SAT);
    expect(day(r, SUN).dailyThresholdMinutes).toBe(H(7, 36));
    expect(day(r, THU).dailyThresholdMinutes).toBe(H(8, 36));
  });
  it('never uses 8:24 (8.4 decimal) as a daily threshold', () => {
    const r = run({ workweek: 'five' }, [MON, TUE, WED, THU].map((d) => sh(d, '08:00', '17:00', { breakMinutes: 30 })), SUN, SAT);
    for (const d of r.days) expect(d.dailyThresholdMinutes).not.toBe(H(8, 24));
  });
});

describe('Test 3 — more than two overtime hours', () => {
  it('splits 125% / 150%', () => {
    const r = run({ workweek: 'five' }, [sh(MON, '07:00', '19:30', { breakMinutes: 30 })], SUN, SAT);
    const d = day(r, MON);
    expect(d.netMinutes).toBe(H(12));
    expect(d.buckets.regular).toBe(H(8, 36));
    expect(d.buckets.ot125).toBe(H(2));
    expect(d.buckets.ot150).toBe(H(1, 24));
  });
});

describe('Test 4 — six-day weekly overtime', () => {
  it('45 hours: 42 regular, 2h at 125%, 1h at 150%', () => {
    const shifts = [SUN, MON, TUE, WED, THU].map((d) => sh(d, '08:00', '16:30', { breakMinutes: 30 }));
    shifts.push(sh(FRI, '08:00', '13:00', { breakMinutes: 0 }));
    const r = run({ workweek: 'six', breakMethod: 'manual' }, shifts, SUN, SAT);
    expect(r.totals.netMinutes).toBe(H(45));
    expect(r.totals.buckets.regular).toBe(H(42));
    expect(r.totals.buckets.ot125).toBe(H(2));
    expect(r.totals.buckets.ot150).toBe(H(1));
    expect(r.totals.weeklyOvertimeMinutes).toBe(H(3));
    expect(r.totals.dailyOvertimeMinutes).toBe(0);
    // 8 × 6 is NOT 48 regular hours
    const fri = day(r, FRI);
    expect(fri.dailyThresholdMinutes).toBe(H(7));
    expect(fri.buckets.regular).toBe(H(2));
    expect(fri.weeklyOvertimeMinutes).toBe(H(3));
  });
});

describe('Test 5 — a short day does not cancel overtime', () => {
  it('keeps the overtime earned on the long day', () => {
    const r = run({ workweek: 'five', breakMethod: 'manual' }, [sh(MON, '08:00', '18:00'), sh(TUE, '08:00', '14:00')], SUN, SAT);
    expect(day(r, MON).buckets.ot125).toBe(H(10) - H(8, 36));
    expect(r.totals.buckets.ot125).toBe(84);
    expect(r.totals.netMinutes).toBe(H(16));
    expect(r.totals.buckets.regular).toBe(H(16) - 84);
  });
});

describe('Test 6 — company break boundary', () => {
  const s = defaultEmployeeSettings({ breakMethod: 'company_auto' });
  it('exactly 10:00 gross → 30 minutes, 10:01 → 45 minutes', () => {
    expect(companyPolicyBreak(600, s)).toBe(30);
    expect(companyPolicyBreak(601, s)).toBe(45);
  });
  it('the resulting net time is discontinuous at the boundary', () => {
    const r = run(s, [sh(MON, '08:00', '18:00'), sh(TUE, '08:00', '18:01')], SUN, SAT);
    expect(day(r, MON).netMinutes).toBe(570);
    expect(day(r, TUE).netMinutes).toBe(556); // longer gross, shorter net
  });
  it('the suggestion is an unconfirmed estimate until confirmed', () => {
    const r = run(s, [sh(MON, '08:00', '18:00'), sh(TUE, '08:00', '18:00', { breakConfirmed: true })], SUN, SAT);
    expect(day(r, MON).shifts[0].break.unconfirmed).toBe(true);
    expect(day(r, MON).warnings.some((w) => w.code === 'BREAK_UNCONFIRMED')).toBe(true);
    expect(day(r, TUE).shifts[0].break.unconfirmed).toBe(false);
    expect(r.totals.unconfirmedBreaks).toBe(1);
  });
  it('is labelled as office policy, not statutory', () => {
    const { result } = calculateDeductibleBreakMinutes(600, { id: 'x', workDate: MON, breakMinutes: null, breakPaid: false, breakConfirmed: false, breakStart: null }, s, { isEve: false });
    expect(result.rule).toContain('לא חובה חוקית');
  });
  it('does not deduct from very short shifts (below the configured minimum)', () => {
    const r = run(s, [sh(MON, '08:00', '11:00')], SUN, SAT);
    expect(day(r, MON).breakMinutes).toBe(0);
    expect(day(r, MON).shifts[0].break.kind).toBe('below_minimum_shift');
  });
});

describe('Test 7 — missing attendance', () => {
  it('blank day: zero minutes, not a worked day', () => {
    const r = run({}, [], SUN, SAT);
    const d = day(r, MON);
    expect(d.netMinutes).toBe(0);
    expect(d.dailyOvertimeMinutes + d.weeklyOvertimeMinutes).toBe(0);
    expect(d.worked).toBe(false);
    expect(r.totals.daysWorked).toBe(0);
    expect(d.warnings).toHaveLength(0);
  });
});

describe('Test 8 — incomplete attendance', () => {
  it('entry without exit is flagged and produces no hours', () => {
    const r = run({}, [sh(MON, '08:00', null)], SUN, SAT);
    const d = day(r, MON);
    expect(d.shifts[0].incomplete).toBe(true);
    expect(d.netMinutes).toBe(0);
    expect(d.worked).toBe(false);
    expect(d.warnings.some((w) => w.code === 'INCOMPLETE' && w.severity === 'error')).toBe(true);
    expect(r.totals.incompleteEntries).toBe(1);
  });
  it('exit without entry is flagged too', () => {
    const r = run({}, [sh(MON, null, '17:00')], SUN, SAT);
    expect(day(r, MON).shifts[0].incomplete).toBe(true);
  });
});

describe('Test 9 — overnight shift', () => {
  it('22:00–06:00: 8 hours gross, night work, 7-hour threshold', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '22:00', '06:00')], SUN, SAT);
    const d = day(r, MON);
    expect(d.shifts[0].endAt).toBe(`${TUE}T06:00`);
    expect(d.grossMinutes).toBe(H(8));
    expect(d.shifts[0].nightMinutes).toBe(H(8));
    expect(d.isNight).toBe(true);
    expect(d.dailyThresholdMinutes).toBe(H(7));
    expect(d.buckets.regular).toBe(H(7));
    expect(d.buckets.ot125).toBe(H(1));
    // attributed to the start date only
    expect(day(r, TUE).netMinutes).toBe(0);
  });
});

describe('Test 10 — cross-month workweek', () => {
  // Week Sunday 2026-11-29 … Saturday 2026-12-05 spans November/December.
  const shifts = ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03'].map((d) => sh(d, '08:00', '16:30', { breakMinutes: 30 }));
  shifts.push(sh('2026-12-04', '08:00', '13:00', { breakMinutes: 0 }));
  const s = { workweek: 'six' as const, breakMethod: 'manual' as const };
  const nov = run(s, shifts, '2026-11-01', '2026-11-30');
  const dec = run(s, shifts, '2026-12-01', '2026-12-31');
  const decFirst = run(s, shifts, '2026-12-01', '2026-12-31');
  it('does not reset the weekly accumulator on the 1st of the month', () => {
    const fri = day(dec, '2026-12-04');
    expect(fri.buckets.regular).toBe(H(2));
    expect(fri.weeklyOvertimeMinutes).toBe(H(3));
  });
  it('is independent of which month is opened first', () => {
    expect(JSON.stringify(day(decFirst, '2026-12-04'))).toBe(JSON.stringify(day(dec, '2026-12-04')));
    const week = nov.weeks.find((w) => w.weekStart === '2026-11-29')!;
    const week2 = dec.weeks.find((w) => w.weekStart === '2026-11-29')!;
    expect(week).toEqual(week2);
  });
  it('allocates minutes to the month of the workday', () => {
    expect(nov.totals.netMinutes).toBe(H(16));
    expect(dec.totals.netMinutes).toBe(H(29));
    expect(nov.totals.netMinutes + dec.totals.netMinutes).toBe(H(45));
  });
});

describe('Test 11 — no double counting', () => {
  it('every worked minute is in exactly one primary bucket', () => {
    const shifts = [SUN, MON, TUE, WED, THU].map((d) => sh(d, '07:00', '19:00', { breakMinutes: 30 }));
    shifts.push(sh(FRI, '07:00', '20:00', { breakMinutes: 30 }), sh(SAT, '09:00', '21:00', { breakMinutes: 0 }));
    const r = run({ workweek: 'six', breakMethod: 'manual' }, shifts, SUN, SAT);
    for (const d of r.days) {
      expect(sumBuckets(d.buckets)).toBe(d.netMinutes);
      const ot = d.buckets.ot125 + d.buckets.ot150 + d.buckets.rest175 + d.buckets.rest200 + d.buckets.holiday175 + d.buckets.holiday200;
      expect(ot).toBe(d.dailyOvertimeMinutes + d.weeklyOvertimeMinutes);
    }
    expect(sumBuckets(r.totals.buckets)).toBe(r.totals.netMinutes);
  });
});

describe('Test 12 — paid versus unpaid break', () => {
  it('identical gross shifts produce different net totals', () => {
    const unpaid = run({}, [sh(MON, '08:00', '17:00', { breakMinutes: 30 })], SUN, SAT);
    const paid = run({}, [sh(MON, '08:00', '17:00', { breakMinutes: 30, breakPaid: true })], SUN, SAT);
    expect(day(unpaid, MON).netMinutes).toBe(H(8, 30));
    expect(day(paid, MON).netMinutes).toBe(H(9));
    expect(day(paid, MON).paidBreakMinutes).toBe(30);
    expect(day(paid, MON).buckets.ot125).toBe(24);
    expect(day(unpaid, MON).buckets.ot125).toBe(0);
  });
  it("employee method 'paid' never deducts", () => {
    const r = run({ breakMethod: 'paid' }, [sh(MON, '08:00', '17:00')], SUN, SAT);
    expect(day(r, MON).netMinutes).toBe(H(9));
  });
});

describe('Test 13 — exceptional Friday for a five-day employee', () => {
  const regular = [SUN, MON, WED].map((d) => sh(d, '08:00', '17:06', { breakMinutes: 30 })); // 8:36 net
  regular.push(sh(THU, '08:00', '16:06', { breakMinutes: 30 })); // 7:36 net
  it('6 hours on Friday after missing Tuesday: no overtime, flagged for review', () => {
    const r = run({ workweek: 'five', breakMethod: 'manual' }, [...regular, sh(FRI, '08:00', '14:00')], SUN, SAT);
    const fri = day(r, FRI);
    expect(fri.scheduled).toBe(false);
    expect(fri.dailyOvertimeMinutes + fri.weeklyOvertimeMinutes).toBe(0);
    expect(fri.buckets.regular).toBe(H(6));
    expect(fri.warnings.some((w) => w.code === 'UNSCHEDULED_DAY_WORK' && w.severity === 'review')).toBe(true);
  });
  it('beyond the statutory 7-hour eve-of-rest day the excess is overtime, flagged', () => {
    const r = run({ workweek: 'five', breakMethod: 'manual' }, [...regular, sh(FRI, '07:00', '15:00')], SUN, SAT);
    const fri = day(r, FRI);
    expect(fri.dailyThresholdMinutes).toBe(H(7));
    expect(fri.buckets.ot125).toBe(H(1));
    expect(fri.warnings.some((w) => w.code === 'EVE_THRESHOLD_REVIEW')).toBe(true);
  });
});

describe('Test 14 — weekly rest', () => {
  it('splits a Friday shift at Shabbat start (sunset)', () => {
    const r = run({ workweek: 'five', breakMethod: 'none' }, [sh(FRI, '13:00', '20:00')], SUN, SAT);
    const fri = day(r, FRI);
    const sunset = sunsetMs('Tel Aviv', FRI);
    const end = localToUtc(`${FRI}T20:00`).utcMs!;
    const restMin = (end - sunset) / MINUTE_MS;
    expect(restMin).toBeGreaterThan(90);
    expect(restMin).toBeLessThan(150);
    expect(fri.shifts[0].restMinutes).toBe(restMin);
    expect(fri.buckets.rest150).toBe(restMin);
    expect(fri.buckets.regular).toBe(H(7) - restMin);
    expect(fri.warnings.some((w) => w.code === 'WORK_ON_WEEKLY_REST' && w.severity === 'compliance')).toBe(true);
  });
  it('after 42 regular hours, Saturday hours are 175% then 200%', () => {
    const shifts = [SUN, MON, TUE, WED, THU].map((d) => sh(d, '08:00', '16:30', { breakMinutes: 30 }));
    shifts.push(sh(FRI, '08:00', '10:00', { breakMinutes: 0 }), sh(SAT, '10:00', '14:00', { breakMinutes: 0 }));
    const r = run({ workweek: 'six', breakMethod: 'manual' }, shifts, SUN, SAT);
    const sat = day(r, SAT);
    expect(sat.buckets.rest175).toBe(H(2));
    expect(sat.buckets.rest200).toBe(H(2));
    expect(sat.buckets.regular + sat.buckets.ot125 + sat.buckets.ot150).toBe(0);
  });
  it('Saturday work within the weekly allowance is 150%', () => {
    const r = run({ workweek: 'five', breakMethod: 'none' }, [sh(SAT, '10:00', '14:00')], SUN, SAT);
    expect(day(r, SAT).buckets.rest150).toBe(H(4));
  });
});

describe('Test 15 — configuration history', () => {
  it('a schedule change effective November does not alter October', () => {
    const five = defaultEmployeeSettings({ workweek: 'five', breakMethod: 'manual' });
    const six = defaultEmployeeSettings({ workweek: 'six', breakMethod: 'manual' });
    const shifts = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((d) => sh(d, '08:00', '17:00', { breakMinutes: 0 }));
    const before = run(five, shifts, '2026-10-01', '2026-10-31', { versions: versions(five) });
    const after = run(five, shifts, '2026-10-01', '2026-10-31', { versions: versions(five, [{ from: '2026-11-01', settings: six }]) });
    expect(JSON.stringify(after.days)).toBe(JSON.stringify(before.days));
    expect(after.totals).toEqual(before.totals);
    const nov = run(five, [sh('2026-11-01', '08:00', '17:00', { breakMinutes: 0 })], '2026-11-01', '2026-11-30', {
      versions: versions(five, [{ from: '2026-11-01', settings: six }]),
    });
    expect(day(nov, '2026-11-01').dailyThresholdMinutes).toBe(H(8));
    expect(day(nov, '2026-11-01').settingsVersionId).toBe('v1');
  });
});
