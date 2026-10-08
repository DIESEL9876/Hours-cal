import { describe, expect, it } from 'vitest';
import {
  addDays,
  calculateBusinessMonthlySummary,
  classifyDailyOvertime,
  daysInMonth,
  defaultEmployeeSettings,
  eachDate,
  formatDecimalHours,
  formatDurationHe,
  formatHM,
  isLeapYear,
  localToUtc,
  monthRange,
  roundPayUnits,
  statutoryHolidaysForYear,
  sumBuckets,
  utcToLocalDateTime,
  weekdayOf,
  weekStartOf,
  validateSettings,
  type EmployeeSettings,
  type ShiftInput,
} from '../index';
import { H, day, rng, run, sh, versions } from './helpers';

const SUN = '2026-10-11';
const MON = '2026-10-12';
const TUE = '2026-10-13';
const WED = '2026-10-14';
const THU = '2026-10-15';
const FRI = '2026-10-16';
const SAT = '2026-10-17';

describe('calendar arithmetic', () => {
  it('leap years', () => {
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(monthRange(2028, 2)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
  it('month lengths', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2026, m))).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });
  it('a monthly report has one row per calendar day', () => {
    const r = run({}, [], '2028-02-01', '2028-02-29');
    expect(r.days).toHaveLength(29);
    expect(r.days[28].date).toBe('2028-02-29');
  });
  it('weekday and week start', () => {
    expect(weekdayOf('2026-10-11')).toBe(0);
    expect(weekdayOf('2026-10-17')).toBe(6);
    expect(weekStartOf('2026-10-01')).toBe('2026-09-27');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('leap-day shift is calculated', () => {
    const r = run({ breakMethod: 'none' }, [sh('2028-02-29', '08:00', '18:00')], '2028-02-01', '2028-02-29');
    expect(day(r, '2028-02-29').netMinutes).toBe(H(10));
    expect(day(r, '2028-02-29').buckets.ot125).toBe(H(10) - H(8, 36));
  });
});

describe('formatting', () => {
  it('HH:MM and decimals', () => {
    expect(formatHM(516)).toBe('8:36');
    expect(formatHM(0)).toBe('0:00');
    expect(formatDecimalHours(516)).toBe('8.60');
    expect(formatDecimalHours(456)).toBe('7.60');
    expect(formatDecimalHours(504)).toBe('8.40');
    expect(formatDecimalHours(1)).toBe('0.02');
  });
  it('Hebrew durations', () => {
    expect(formatDurationHe(570)).toBe('9 שעות ו-30 דקות');
    expect(formatDurationHe(120)).toBe('שעתיים');
    expect(formatDurationHe(60)).toBe('שעה');
    expect(formatDurationHe(84)).toBe('שעה ו-24 דקות');
    expect(formatDurationHe(1)).toBe('דקה אחת');
  });
});

describe('time zone / DST', () => {
  it('overnight shift across the October DST end is 9 hours', () => {
    // Israel returns to standard time on Sunday 2026-10-25 at 02:00 → 01:00.
    const r = run({ breakMethod: 'none' }, [sh('2026-10-24', '22:00', '06:00')], '2026-10-01', '2026-10-31');
    expect(day(r, '2026-10-24').grossMinutes).toBe(H(9));
  });
  it('overnight shift across the March DST start is 7 hours', () => {
    // DST starts Friday 2026-03-27 at 02:00 → 03:00.
    const r = run({ breakMethod: 'none' }, [sh('2026-03-26', '22:00', '06:00')], '2026-03-01', '2026-03-31');
    expect(day(r, '2026-03-26').grossMinutes).toBe(H(7));
  });
  it('a non-existent wall time is rejected', () => {
    expect(localToUtc('2026-03-27T02:30').nonexistent).toBe(true);
    const r = run({}, [sh('2026-03-27', '02:30', '08:00')], '2026-03-01', '2026-03-31');
    expect(day(r, '2026-03-27').warnings.some((w) => w.code === 'NONEXISTENT_TIME')).toBe(true);
    expect(day(r, '2026-03-27').netMinutes).toBe(0);
  });
  it('an ambiguous wall time is flagged', () => {
    expect(localToUtc('2026-10-25T01:30').ambiguous).toBe(true);
    const r = run({}, [sh('2026-10-25', '01:30', '05:00')], '2026-10-01', '2026-10-31');
    expect(day(r, '2026-10-25').warnings.some((w) => w.code === 'AMBIGUOUS_TIME')).toBe(true);
  });
  it('round trip', () => {
    expect(utcToLocalDateTime(localToUtc('2026-07-01T08:15').utcMs!)).toBe('2026-07-01T08:15');
    expect(utcToLocalDateTime(localToUtc('2026-01-01T23:59').utcMs!)).toBe('2026-01-01T23:59');
  });
});

describe('minute-accurate boundaries', () => {
  it('pure daily classification', () => {
    expect(classifyDailyOvertime(516, 516)).toEqual({ regular: 516, ot125: 0, ot150: 0 });
    expect(classifyDailyOvertime(517, 516)).toEqual({ regular: 516, ot125: 1, ot150: 0 });
    expect(classifyDailyOvertime(636, 516)).toEqual({ regular: 516, ot125: 120, ot150: 0 });
    expect(classifyDailyOvertime(637, 516)).toEqual({ regular: 516, ot125: 120, ot150: 1 });
    expect(classifyDailyOvertime(0, 516)).toEqual({ regular: 0, ot125: 0, ot150: 0 });
  });
  it('engine at exactly the threshold and one minute over', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '08:00', '16:36'), sh(TUE, '08:00', '16:37')], SUN, SAT);
    expect(day(r, MON).dailyOvertimeMinutes).toBe(0);
    expect(day(r, TUE).buckets.ot125).toBe(1);
  });
  it('weekly 42:00 exactly → no weekly overtime; 42:01 → 1 minute', () => {
    const base = [SUN, MON, TUE, WED].map((d) => sh(d, '08:00', '16:36'));
    const exact = run({ breakMethod: 'none' }, [...base, sh(THU, '08:00', '15:36')], SUN, SAT);
    expect(exact.totals.netMinutes).toBe(H(42));
    expect(exact.totals.weeklyOvertimeMinutes).toBe(0);
    const over = run({ breakMethod: 'none' }, [...base, sh(THU, '08:00', '15:36'), sh(FRI, '08:00', '08:01')], SUN, SAT);
    expect(over.totals.weeklyOvertimeMinutes).toBe(1);
  });
});

describe('very short, long, zero and invalid shifts', () => {
  it('very short shift', () => {
    const r = run({}, [sh(MON, '08:00', '08:05')], SUN, SAT);
    expect(day(r, MON).netMinutes).toBe(5);
    expect(day(r, MON).breakMinutes).toBe(0);
    expect(day(r, MON).worked).toBe(true);
  });
  it('zero-length shift is rejected (exit equal to entry)', () => {
    const s: ShiftInput = { ...sh(MON, '08:00', '17:00'), endAt: `${MON}T08:00` };
    const r = run({}, [s], SUN, SAT);
    expect(day(r, MON).warnings.some((w) => w.code === 'NEGATIVE_DURATION')).toBe(true);
    expect(day(r, MON).netMinutes).toBe(0);
  });
  it('negative duration is never saved silently', () => {
    const s: ShiftInput = { ...sh(MON, '08:00', '17:00'), endAt: `${MON}T07:00` };
    const r = run({}, [s], SUN, SAT);
    expect(day(r, MON).shifts[0].valid).toBe(false);
    expect(r.totals.errorCount).toBeGreaterThan(0);
  });
  it('break longer than the shift is an error, never a negative net', () => {
    const r = run({}, [sh(MON, '08:00', '08:20', { breakMinutes: 30 })], SUN, SAT);
    expect(day(r, MON).netMinutes).toBe(0);
    expect(day(r, MON).warnings.some((w) => w.code === 'BREAK_EXCEEDS_SHIFT')).toBe(true);
  });
  it('long shift: 12-hour daily limit compliance warning, hours not erased', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '06:00', '20:00')], SUN, SAT);
    const d = day(r, MON);
    expect(d.netMinutes).toBe(H(14));
    expect(d.warnings.some((w) => w.code === 'DAILY_LIMIT' && w.severity === 'compliance')).toBe(true);
  });
  it('shift over 16 hours is flagged for review', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '05:00', '22:00')], SUN, SAT);
    expect(day(r, MON).warnings.some((w) => w.code === 'LONG_SHIFT')).toBe(true);
  });
});

describe('duplicates and overlaps', () => {
  it('duplicate shift is detected and excluded', () => {
    const r = run({}, [sh(MON, '08:00', '17:00'), sh(MON, '08:00', '17:00')], SUN, SAT);
    expect(day(r, MON).warnings.filter((w) => w.code === 'DUPLICATE_SHIFT')).toHaveLength(2);
    expect(day(r, MON).netMinutes).toBe(0);
  });
  it('overlapping shifts across midnight are detected', () => {
    const r = run({}, [sh(MON, '20:00', '04:00'), sh(TUE, '03:00', '09:00')], SUN, SAT);
    expect(day(r, TUE).warnings.some((w) => w.code === 'OVERLAPPING_SHIFT')).toBe(true);
  });
  it('split shift on the same day is combined for the daily threshold', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '07:00', '12:00'), sh(MON, '15:00', '20:00')], SUN, SAT);
    const d = day(r, MON);
    expect(d.netMinutes).toBe(H(10));
    expect(d.buckets.ot125).toBe(H(10) - H(8, 36));
  });
});

describe('night work', () => {
  it('exactly two hours in the night window qualifies', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '16:00', '00:00')], SUN, SAT);
    expect(day(r, MON).isNight).toBe(true);
    expect(day(r, MON).dailyThresholdMinutes).toBe(H(7));
    expect(day(r, MON).buckets.ot125).toBe(H(1));
  });
  it('1:59 in the night window does not qualify', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '16:01', '23:59')], SUN, SAT);
    expect(day(r, MON).isNight).toBe(false);
    expect(day(r, MON).dailyThresholdMinutes).toBe(H(8, 36));
  });
  it('early-morning shift qualifies (04:00–12:00)', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '04:00', '12:00')], SUN, SAT);
    expect(day(r, MON).isNight).toBe(true);
  });
  it('night status does not raise the hourly percentage by itself', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '22:00', '05:00')], SUN, SAT);
    const d = day(r, MON);
    expect(d.buckets.regular).toBe(H(7));
    expect(d.buckets.ot125 + d.buckets.ot150).toBe(0);
  });
  it('night rules can be disabled per employee', () => {
    const r = run({ breakMethod: 'none', nightRulesEnabled: false }, [sh(MON, '22:00', '06:00')], SUN, SAT);
    expect(day(r, MON).dailyThresholdMinutes).toBe(H(8, 36));
  });
  it('flags night classification that depends on an unpositioned break', () => {
    const r = run({ breakMethod: 'manual' }, [sh(MON, '15:00', '00:10', { breakMinutes: 30 })], SUN, SAT);
    // gross night minutes = 130 (22:00–00:10); the centred break (19:20–19:50) does not touch night → still night
    expect(day(r, MON).isNight).toBe(true);
  });
});

describe('holidays and holiday eves (2026)', () => {
  it('statutory holidays are listed', () => {
    const hs = statutoryHolidaysForYear(2026).map((h) => h.date);
    expect(hs).toContain('2026-09-12'); // Rosh Hashana I
    expect(hs).toContain('2026-09-13'); // Rosh Hashana II
    expect(hs).toContain('2026-09-21'); // Yom Kippur
    expect(hs).toContain('2026-09-26'); // Sukkot I
    expect(hs).toContain('2026-10-03'); // Shmini Atzeret
    expect(hs).not.toContain('2026-09-28'); // Chol HaMoed is not a rest day
  });
  it('holiday eve (Erev Yom Kippur, Sunday 2026-09-20) has a 7-hour threshold', () => {
    const r = run({ breakMethod: 'none' }, [sh('2026-09-20', '07:00', '15:00')], '2026-09-01', '2026-09-30');
    const d = day(r, '2026-09-20');
    expect(d.holidayEve).toBe(true);
    expect(d.dailyThresholdMinutes).toBe(H(7));
    expect(d.buckets.ot125).toBe(H(1));
    expect(d.warnings.some((w) => w.code === 'EVE_THRESHOLD_REVIEW')).toBe(true);
  });
  it('work on Yom Kippur gets a holiday premium and is flagged', () => {
    const r = run({ breakMethod: 'none' }, [sh('2026-09-21', '09:00', '13:00')], '2026-09-01', '2026-09-30');
    const d = day(r, '2026-09-21');
    expect(d.holidayName).toContain('כפור');
    expect(d.buckets.holiday150).toBe(H(4));
    expect(d.warnings.some((w) => w.code === 'HOLIDAY_WORK' && w.severity === 'review')).toBe(true);
  });
  it('employees without the Jewish holiday calendar get no automatic holiday premium', () => {
    const r = run({ breakMethod: 'none', holidayCalendar: 'none' }, [sh('2026-09-21', '09:00', '13:00')], '2026-09-01', '2026-09-30');
    expect(day(r, '2026-09-21').buckets.regular).toBe(H(4));
  });
  it('custom business holiday applies on the civil day', () => {
    const r = run({ breakMethod: 'none', holidayCalendar: 'none' }, [sh(TUE, '09:00', '13:00')], SUN, SAT, {
      customHolidays: [{ date: TUE, name: 'חג מקומי' }],
    });
    expect(day(r, TUE).buckets.holiday150).toBe(H(4));
  });
  it('holiday on Shabbat is classified once (as weekly rest)', () => {
    // 2026-10-03 Shmini Atzeret is a Saturday.
    const r = run({ breakMethod: 'none' }, [sh('2026-10-03', '10:00', '12:00')], '2026-10-01', '2026-10-31');
    const d = day(r, '2026-10-03');
    expect(d.buckets.rest150).toBe(H(2));
    expect(d.buckets.holiday150).toBe(0);
    expect(sumBuckets(d.buckets)).toBe(d.netMinutes);
  });
});

describe('weekly rest configuration', () => {
  it('non-Jewish employee with Sunday rest: Saturday is ordinary, Sunday is rest', () => {
    const s = defaultEmployeeSettings({
      breakMethod: 'none',
      workDays: [1, 2, 3, 4, 5],
      shortDay: 5,
      holidayCalendar: 'none',
      weeklyRest: { kind: 'fixed_day', fixedDay: 0, startOffsetMinutes: 0, endOffsetMinutes: 0 },
    });
    const r = run(s, [sh(SAT, '10:00', '14:00'), sh(SUN, '10:00', '14:00')], SUN, SAT);
    expect(day(r, SAT).buckets.regular).toBe(H(4));
    expect(day(r, SUN).buckets.rest150).toBe(H(4));
    expect(day(r, SUN).warnings.some((w) => w.code === 'REST_WINDOW_REVIEW')).toBe(true);
    // Saturday is the eve of the Sunday rest → 7h threshold
    expect(day(r, SAT).dailyThresholdMinutes).toBe(H(7));
  });
  it('weekly rest shorter than 36 hours is a compliance warning', () => {
    // Work Friday until 14:00 and Saturday night from 22:00 → rest ~32h
    const r = run({ breakMethod: 'none', workweek: 'six' }, [sh(FRI, '08:00', '14:00'), sh(SAT, '22:00', '23:30')], SUN, SAT);
    expect(r.days.flatMap((d) => d.warnings).some((w) => w.code === 'WEEKLY_REST_SHORT')).toBe(true);
  });
  it('rest offsets extend the window', () => {
    const base = run({ breakMethod: 'none' }, [sh(FRI, '13:00', '20:00')], SUN, SAT);
    const ext = run(
      { breakMethod: 'none', weeklyRest: { kind: 'shabbat', fixedDay: null, startOffsetMinutes: 30, endOffsetMinutes: 0 } },
      [sh(FRI, '13:00', '20:00')],
      SUN,
      SAT,
    );
    expect(day(ext, FRI).shifts[0].restMinutes - day(base, FRI).shifts[0].restMinutes).toBe(30);
  });
  it('unpositioned break across the Shabbat boundary is flagged', () => {
    const r = run({ breakMethod: 'manual' }, [sh(FRI, '14:00', '22:00', { breakMinutes: 30 })], SUN, SAT);
    expect(day(r, FRI).warnings.some((w) => w.code === 'BREAK_POSITION_ASSUMED')).toBe(true);
  });
  it('positioned break is deducted at its real time', () => {
    const r = run({ breakMethod: 'manual' }, [sh(FRI, '14:00', '22:00', { breakMinutes: 30, breakStart: `${FRI}T21:00` })], SUN, SAT);
    const d = day(r, FRI);
    expect(d.netMinutes).toBe(H(7, 30));
    expect(d.warnings.some((w) => w.code === 'BREAK_POSITION_ASSUMED')).toBe(false);
  });
  it('break position outside the shift is rejected', () => {
    const r = run({ breakMethod: 'manual' }, [sh(MON, '08:00', '17:00', { breakMinutes: 30, breakStart: `${MON}T16:50` })], SUN, SAT);
    expect(day(r, MON).warnings.some((w) => w.code === 'BREAK_OUTSIDE_SHIFT')).toBe(true);
  });
});

describe('break eligibility and legal checks', () => {
  it('manual worker with less than 45 minutes on a 6+ hour day gets a compliance warning', () => {
    const r = run({ workType: 'manual', breakMethod: 'manual' }, [sh(MON, '08:00', '16:00', { breakMinutes: 20 })], SUN, SAT);
    expect(day(r, MON).warnings.some((w) => w.code === 'BREAK_BELOW_MINIMUM')).toBe(true);
  });
  it('manual worker 45 minutes: no warning; eve of rest day: 30 is enough', () => {
    const r = run({ workType: 'manual', breakMethod: 'manual' }, [sh(MON, '08:00', '16:00', { breakMinutes: 45 }), sh(FRI, '07:00', '14:00', { breakMinutes: 30 })], SUN, SAT);
    expect(day(r, MON).warnings.some((w) => w.code === 'BREAK_BELOW_MINIMUM')).toBe(false);
    expect(day(r, FRI).warnings.some((w) => w.code === 'BREAK_BELOW_MINIMUM')).toBe(false);
  });
  it('non-manual worker: no minimum-break warning', () => {
    const r = run({ workType: 'non_manual', breakMethod: 'manual' }, [sh(MON, '08:00', '16:00', { breakMinutes: 0 })], SUN, SAT);
    expect(day(r, MON).warnings.some((w) => w.code === 'BREAK_BELOW_MINIMUM')).toBe(false);
  });
  it('legal-profile estimate for manual labour', () => {
    const r = run({ workType: 'manual', breakMethod: 'legal_profile' }, [sh(MON, '08:00', '17:00'), sh(TUE, '08:00', '13:00')], SUN, SAT);
    expect(day(r, MON).breakMinutes).toBe(45);
    expect(day(r, MON).shifts[0].break.unconfirmed).toBe(true);
    expect(day(r, TUE).breakMinutes).toBe(0);
  });
  it('break over 3 hours is flagged', () => {
    const r = run({}, [sh(MON, '06:00', '20:00', { breakMinutes: 200 })], SUN, SAT);
    expect(day(r, MON).warnings.some((w) => w.code === 'BREAK_TOO_LONG')).toBe(true);
  });
  it('weekly overtime above 16 hours and 58 total hours are compliance warnings', () => {
    const shifts = [SUN, MON, TUE, WED, THU].map((d) => sh(d, '06:00', '18:00'));
    const r = run({ breakMethod: 'none' }, shifts, SUN, SAT);
    const codes = r.days.flatMap((d) => d.warnings).map((w) => w.code);
    expect(r.totals.netMinutes).toBe(H(60));
    expect(codes).toContain('WEEKLY_OT_LIMIT');
    expect(codes).toContain('WEEKLY_TOTAL_LIMIT');
  });
  it('short rest between shifts is warned (office threshold)', () => {
    const r = run({ breakMethod: 'none' }, [sh(MON, '14:00', '23:00'), sh(TUE, '05:00', '12:00')], SUN, SAT);
    expect(day(r, TUE).warnings.some((w) => w.code === 'SHORT_REST_BETWEEN_SHIFTS')).toBe(true);
  });
});

describe('statuses', () => {
  it('absence statuses never generate worked hours', () => {
    const r = run({}, [], SUN, SAT, {
      dayStatuses: [
        { date: MON, status: 'vacation' },
        { date: TUE, status: 'sick' },
        { date: WED, status: 'reserve' },
      ],
    });
    expect(r.totals.netMinutes).toBe(0);
    expect(r.totals.daysWorked).toBe(0);
    expect(day(r, MON).status).toBe('vacation');
  });
  it('missing-record status is an incomplete entry', () => {
    const r = run({}, [], SUN, SAT, { dayStatuses: [{ date: MON, status: 'missing_record' }] });
    expect(r.totals.incompleteEntries).toBe(1);
    expect(r.totals.errorCount).toBe(1);
  });
  it('absence status together with work is flagged', () => {
    const r = run({}, [sh(MON, '08:00', '12:00')], SUN, SAT, { dayStatuses: [{ date: MON, status: 'sick' }] });
    expect(day(r, MON).warnings.some((w) => w.code === 'STATUS_CONFLICT')).toBe(true);
  });
});

describe('partial weeks', () => {
  it('a report starting mid-week still accounts for earlier days in that week', () => {
    const shifts = [SUN, MON, TUE, WED, THU].map((d) => sh(d, '08:00', '16:30', { breakMinutes: 30 }));
    shifts.push(sh(FRI, '08:00', '13:00', { breakMinutes: 0 }));
    const r = run({ workweek: 'six', breakMethod: 'manual' }, shifts, FRI, SAT);
    expect(r.days).toHaveLength(2);
    expect(day(r, FRI).weeklyOvertimeMinutes).toBe(H(3));
    expect(r.totals.netMinutes).toBe(H(5));
  });
});

describe('profiles', () => {
  it('exempt employee: net hours only, flagged', () => {
    const r = run({ legalProfile: 'exempt', breakMethod: 'none' }, [sh(MON, '08:00', '20:00')], SUN, SAT);
    expect(day(r, MON).buckets.unclassified).toBe(H(12));
    expect(r.warnings.some((w) => w.code === 'EXEMPT_PROFILE')).toBe(true);
  });
  it('minor is not processed under adult rules', () => {
    const r = run({ legalProfile: 'minor', breakMethod: 'none' }, [sh(MON, '08:00', '17:00')], SUN, SAT);
    expect(day(r, MON).buckets.unclassified).toBe(H(9));
    expect(r.warnings.some((w) => w.code === 'MINOR_UNSUPPORTED' && w.severity === 'error')).toBe(true);
  });
  it('custom contractual profile (public sector 40h, 8h days)', () => {
    const s = defaultEmployeeSettings({
      legalProfile: 'custom_contract',
      breakMethod: 'none',
      customProfile: {
        label: 'מגזר ציבורי',
        dailyThresholdMinutes: [480, 480, 480, 480, 480, 0, 0],
        weeklyThresholdMinutes: 2400,
        firstTierMinutes: 120,
        applyStatutoryReductions: false,
      },
    });
    const r = run(s, [SUN, MON, TUE, WED, THU].map((d) => sh(d, '08:00', '16:30')), SUN, SAT);
    expect(r.totals.buckets.regular).toBe(H(40));
    expect(r.totals.buckets.ot125).toBe(H(2, 30));
    expect(r.warnings.some((w) => w.code === 'CUSTOM_PROFILE')).toBe(true);
  });
  it('part-time contract: excess hours at 100% reported separately', () => {
    const r = run({ breakMethod: 'none', contractDailyMinutes: 360 }, [sh(MON, '08:00', '16:00')], SUN, SAT);
    const d = day(r, MON);
    expect(d.buckets.regular).toBe(H(8));
    expect(d.contractExcessMinutes).toBe(H(2));
    expect(d.dailyOvertimeMinutes).toBe(0);
  });
  it('five-day without a short day is flagged', () => {
    const r = run({ shortDay: null }, [], SUN, SAT);
    expect(r.warnings.some((w) => w.code === 'NO_SHORT_DAY')).toBe(true);
  });
  it('settings validation', () => {
    expect(validateSettings(defaultEmployeeSettings())).toEqual([]);
    expect(validateSettings(defaultEmployeeSettings({ shortDay: 5 }))).not.toEqual([]);
    expect(validateSettings(defaultEmployeeSettings({ workDays: [] }))).not.toEqual([]);
  });
});

describe('review acknowledgement', () => {
  it('marking a shift as reviewed acknowledges its review flags but not unconfirmed breaks', () => {
    const open = run({ workweek: 'five', breakMethod: 'company_auto' }, [sh(FRI, '08:00', '15:00')], SUN, SAT);
    expect(open.totals.reviewCount).toBe(2); // unscheduled day + unconfirmed break
    const s = { ...sh(FRI, '08:00', '15:00'), reviewed: true };
    const rev = run({ workweek: 'five', breakMethod: 'company_auto' }, [s], SUN, SAT);
    expect(rev.totals.reviewCount).toBe(1);
    expect(day(rev, FRI).warnings.find((w) => w.code === 'UNSCHEDULED_DAY_WORK')!.acknowledged).toBe(true);
    expect(day(rev, FRI).warnings.find((w) => w.code === 'BREAK_UNCONFIRMED')!.acknowledged).toBeUndefined();
  });
});

describe('weekly tiering modes', () => {
  // Six-day: Sun–Wed 8h, Thu 10h net (2h daily OT), Fri 5h → weekly OT on Friday.
  const shifts = [SUN, MON, TUE, WED].map((d) => sh(d, '08:00', '16:00'));
  shifts.push(sh(THU, '08:00', '18:00'), sh(FRI, '08:00', '13:00'));
  it('per_day (default): weekly OT tiers restart each day', () => {
    const r = run({ workweek: 'six', breakMethod: 'none' }, shifts, SUN, SAT);
    // regular: 32 + 8 + 2 = 42; Friday 3h weekly OT → 2h@125 + 1h@150
    expect(day(r, FRI).buckets.ot125).toBe(H(2));
    expect(day(r, FRI).buckets.ot150).toBe(H(1));
    expect(day(r, THU).buckets.ot125).toBe(H(2));
  });
  it('per_week: weekly OT tiers count across the week', () => {
    const r = run({ workweek: 'six', breakMethod: 'none', weeklyOvertimeTiering: 'per_week' }, shifts, SUN, SAT);
    expect(day(r, FRI).buckets.ot125).toBe(H(2));
    expect(day(r, FRI).buckets.ot150).toBe(H(1));
    expect(sumBuckets(r.totals.buckets)).toBe(r.totals.netMinutes);
  });
});

describe('indicative pay', () => {
  it('exact integer arithmetic, rounded once', () => {
    const r = run({ hourlyRateAgorot: 5000 }, [sh(SUN, '08:00', '18:00', { breakMinutes: 30 })], SUN, SAT);
    // 8.6h × 50 = 430 + 0.9h × 62.5 = 56.25 → 486.25 ₪
    expect(r.totals.payAgorot).toBe(48625);
  });
  it('rounding half up', () => {
    expect(roundPayUnits(2999)).toBe(0);
    expect(roundPayUnits(3000)).toBe(1);
    expect(roundPayUnits(6000)).toBe(1);
  });
  it('no rate → no pay', () => {
    const r = run({}, [sh(SUN, '08:00', '18:00')], SUN, SAT);
    expect(r.totals.payAgorot).toBeNull();
  });
});

describe('report consistency and multiple employees', () => {
  it('monthly totals equal the sum of days; business total equals sum of employees', () => {
    const s1 = defaultEmployeeSettings({ breakMethod: 'company_auto' });
    const s2 = defaultEmployeeSettings({ workweek: 'six', breakMethod: 'manual' });
    const mk = (seed: number) => {
      const rand = rng(seed);
      const out: ShiftInput[] = [];
      for (const d of eachDate('2026-09-27', '2026-11-07')) {
        if (rand() < 0.25) continue;
        const startH = 5 + Math.floor(rand() * 12);
        const len = 60 + Math.floor(rand() * 720);
        const startM = Math.floor(rand() * 60);
        const st = startH * 60 + startM;
        const en = (st + len) % 1440;
        const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        out.push(sh(d, f(st), f(en), rand() < 0.5 ? { breakMinutes: Math.floor(rand() * 40) } : {}));
      }
      return out;
    };
    const summary = calculateBusinessMonthlySummary([
      { employeeId: 'a', name: 'א', employeeNumber: null, input: { employeeId: 'a', settingsVersions: versions(s1), shifts: mk(1), dayStatuses: [], customHolidays: [], from: '2026-10-01', to: '2026-10-31' } },
      { employeeId: 'b', name: 'ב', employeeNumber: null, input: { employeeId: 'b', settingsVersions: versions(s2), shifts: mk(2), dayStatuses: [], customHolidays: [], from: '2026-10-01', to: '2026-10-31' } },
    ]);
    for (const row of summary.rows) {
      const daysNet = row.result.days.reduce((a, d) => a + d.netMinutes, 0);
      expect(row.totals.netMinutes).toBe(daysNet);
      expect(sumBuckets(row.totals.buckets)).toBe(row.totals.netMinutes);
    }
    expect(summary.grandTotal.netMinutes).toBe(summary.rows[0].totals.netMinutes + summary.rows[1].totals.netMinutes);
    expect(sumBuckets(summary.grandTotal.buckets)).toBe(summary.grandTotal.netMinutes);
  });
});

describe('property: invariants over random data', () => {
  const variants: Partial<EmployeeSettings>[] = [
    { workweek: 'five' },
    { workweek: 'six' },
    { workweek: 'five', weeklyOvertimeTiering: 'per_week' },
    { workweek: 'six', restMinutesCountTowardWeekly: false },
    { workweek: 'five', workType: 'manual', breakMethod: 'legal_profile' },
  ];
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed * 7919);
      const settings = variants[seed % variants.length];
      const shifts: ShiftInput[] = [];
      let cursor = localToUtc('2026-08-30T00:00').utcMs!;
      const end = localToUtc('2026-11-07T00:00').utcMs!;
      while (cursor < end) {
        cursor += (6 + Math.floor(rand() * 30)) * 3_600_000 + Math.floor(rand() * 60) * 60_000;
        const len = 30 + Math.floor(rand() * 800);
        const st = utcToLocalDateTime(cursor);
        const en = utcToLocalDateTime(cursor + len * 60_000);
        const date = st.slice(0, 10);
        shifts.push({ id: `p${shifts.length}`, workDate: date, startAt: st, endAt: en, breakMinutes: rand() < 0.5 ? Math.floor(rand() * 50) : null, breakStart: null, breakConfirmed: rand() < 0.5, breakPaid: rand() < 0.1, reviewed: false });
        cursor += len * 60_000;
      }
      const r = run(settings, shifts, '2026-09-01', '2026-10-31');
      let sumNet = 0;
      for (const d of r.days) {
        expect(sumBuckets(d.buckets)).toBe(d.netMinutes);
        expect(d.netMinutes).toBeGreaterThanOrEqual(0);
        const ot = d.buckets.ot125 + d.buckets.ot150 + d.buckets.rest175 + d.buckets.rest200 + d.buckets.holiday175 + d.buckets.holiday200;
        expect(ot).toBe(d.dailyOvertimeMinutes + d.weeklyOvertimeMinutes);
        expect(d.netMinutes).toBe(d.shifts.filter((s) => s.valid).reduce((a, s) => a + s.grossMinutes - s.break.deductedMinutes, 0));
        sumNet += d.netMinutes;
        // regular minutes never exceed the daily threshold
        if (d.dailyThresholdMinutes !== null) expect(d.buckets.regular + d.buckets.rest150 + d.buckets.holiday150).toBeLessThanOrEqual(d.dailyThresholdMinutes);
      }
      expect(r.totals.netMinutes).toBe(sumNet);
      for (const w of r.weeks) {
        if (w.weeklyThresholdMinutes !== null) expect(w.regularCountedMinutes).toBeLessThanOrEqual(w.weeklyThresholdMinutes);
      }
      // determinism: the same input gives the same output
      expect(JSON.stringify(run(settings, shifts, '2026-09-01', '2026-10-31'))).toBe(JSON.stringify(r));
      // month split consistency
      const sep = run(settings, shifts, '2026-09-01', '2026-09-30');
      const oct = run(settings, shifts, '2026-10-01', '2026-10-31');
      expect(sep.totals.netMinutes + oct.totals.netMinutes).toBe(r.totals.netMinutes);
      for (const k of Object.keys(r.totals.buckets) as (keyof typeof r.totals.buckets)[])
        expect(sep.totals.buckets[k] + oct.totals.buckets[k]).toBe(r.totals.buckets[k]);
    });
  }
});
