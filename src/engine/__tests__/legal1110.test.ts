/**
 * 1.1.10 — youth employment rules aligned with the research pack of 2026-11-04 (test matrix §6), the legal rule
 * registry and the agreement catalog / clause gate. Rule ids refer to src/engine/legalRules.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  ageOn,
  birthdayOn,
  calculateEmployeePeriod,
  defaultEmployeeSettings,
  DEFAULT_COMPANY_BREAK_POLICY,
  LEGAL_RULES,
  rulesInForce,
  type DayStatus,
  type EmployeeSettings,
  type ShiftInput,
  type YouthProfile,
  type YouthRuleSet,
} from '../index';
import { agreementHoursFor, CATALOG, catalogEntry, confirmationProblems, resolveAgreements, searchCatalog, FAMILY_OF } from '../../agreements';
import { day, H, sh, versions } from './helpers';

const emp = (over: Partial<EmployeeSettings> = {}) => defaultEmployeeSettings({ breakMethod: 'manual', hourlyRateAgorot: 4000, ...over });
const PROFILE = (p: Partial<YouthProfile> = {}): YouthProfile => ({ schooling: 'unknown', schoolVacations: [], nightPermits: [], apprentice: null, ...p });
function calc(
  shifts: ShiftInput[],
  o: { birthDate?: string | null; s?: EmployeeSettings; youth?: YouthProfile | null; statuses?: DayStatus[]; from?: string; to?: string; ruleSet?: YouthRuleSet } = {},
) {
  return calculateEmployeePeriod({
    employeeId: 'e',
    settingsVersions: versions(o.s ?? emp()),
    shifts,
    dayStatuses: o.statuses ?? [],
    customHolidays: [],
    from: o.from ?? '2026-11-01',
    to: o.to ?? '2026-11-30',
    birthDate: o.birthDate === undefined ? '2010-01-15' : o.birthDate, // 16 in November 2026
    youth: o.youth ?? null,
    youthRuleSet: o.ruleSet,
  });
}
const codes = (r: ReturnType<typeof calc>, d: string) => day(r, d).warnings.map((w) => w.code);
const warning = (r: ReturnType<typeof calc>, d: string, code: string) => day(r, d).warnings.find((w) => w.code === code);
const UNDER16 = '2011-03-01'; // 15 in November 2026

describe('daily and weekly limits (Y-001 … Y-005, Y-008)', () => {
  it('1. under 16: 8:00 allowed; 8:01 flagged — hours retained, pay not reduced, payment flagged for review', () => {
    const ok = calc([sh('2026-11-02', '08:00', '16:00', { breakMinutes: 0 })], { birthDate: UNDER16 });
    expect(codes(ok, '2026-11-02')).not.toContain('YOUTH_DAILY_LIMIT');
    const over = calc([sh('2026-11-02', '08:00', '16:01', { breakMinutes: 0 })], { birthDate: UNDER16 });
    expect(codes(over, '2026-11-02')).toEqual(expect.arrayContaining(['YOUTH_DAILY_LIMIT', 'YOUTH_PAY_REVIEW']));
    expect(warning(over, '2026-11-02', 'YOUTH_DAILY_LIMIT')!.message).toContain('השכר לא נמחק');
    const adult = calc([sh('2026-11-02', '08:00', '16:01', { breakMinutes: 0 })], { birthDate: null });
    expect(over.totals.netMinutes).toBe(H(8) + 1);
    expect(over.totals.payAgorot).toBe(adult.totals.payAgorot); // never zero, never reduced
    expect(over.youth).toMatchObject({ recordedMinutes: H(8) + 1, dailyExcessMinutes: 1, prohibitedOvertimeMinutes: 1 });
  });

  it('2. ages 16–17: 9:00 allowed in a five-day week, 9:01 flagged; six-day week 8:01 flagged', () => {
    expect(codes(calc([sh('2026-11-02', '08:00', '17:00', { breakMinutes: 0 })]), '2026-11-02')).not.toContain('YOUTH_DAILY_LIMIT');
    expect(codes(calc([sh('2026-11-02', '08:00', '17:01', { breakMinutes: 0 })]), '2026-11-02')).toContain('YOUTH_DAILY_LIMIT');
    const six = emp({ workweek: 'six', workDays: [0, 1, 2, 3, 4, 5], shortDay: null });
    const r = calc([sh('2026-11-02', '08:00', '16:01', { breakMinutes: 0 })], { s: six });
    expect(warning(r, '2026-11-02', 'YOUTH_DAILY_LIMIT')).toMatchObject({ ruleId: 'Y-004' });
  });

  it('3. 40 hours a week even within the daily caps; daily excess first, weekly excess without double counting', () => {
    const shifts = ['02', '03', '04', '05'].map((d) => sh(`2026-11-${d}`, '08:00', '17:00', { breakMinutes: 0 })); // 4 × 9:00 = 36:00
    shifts.push(sh('2026-11-01', '08:00', '14:00', { breakMinutes: 0 })); // + 6:00 = 42:00
    const r = calc(shifts);
    expect(r.days.flatMap((d) => d.warnings).some((w) => w.code === 'YOUTH_WEEKLY_LIMIT')).toBe(true);
    expect(r.youth).toMatchObject({ dailyExcessMinutes: 0, weeklyExcessMinutes: H(2), prohibitedOvertimeMinutes: H(2) });
    // 4 × 9:30 (2:00 daily excess) + 6:00 = 44:00 → weekly excess = 44 − 2 − 40 = 2:00 (not 4:00).
    const r2 = calc([...['02', '03', '04', '05'].map((d) => sh(`2026-11-${d}`, '08:00', '17:30', { breakMinutes: 0 })), sh('2026-11-01', '08:00', '14:00', { breakMinutes: 0 })]);
    expect(r2.youth).toMatchObject({ dailyExcessMinutes: H(2), weeklyExcessMinutes: H(2), prohibitedOvertimeMinutes: H(4) });
    // Never the adult 42-hour week: 41:00 within daily caps is already flagged.
    const r3 = calc([...['02', '03', '04', '05'].map((d) => sh(`2026-11-${d}`, '08:00', '17:00', { breakMinutes: 0 })), sh('2026-11-01', '08:00', '13:00', { breakMinutes: 0 })]);
    expect(r3.youth?.weeklyExcessMinutes).toBe(H(1));
  });

  it('4. eve of the weekly rest: 7:01 flagged; before a holiday only if the minor does not work on the holiday', () => {
    const fri = calc([sh('2026-11-06', '07:00', '14:01', { breakMinutes: 0 })]);
    expect(warning(fri, '2026-11-06', 'YOUTH_DAILY_LIMIT')).toMatchObject({ ruleId: 'Y-005' });
    // Yom Kippur 2026 is Monday 21.9; Sunday 20.9 is its eve.
    const eve = calc([sh('2026-09-20', '08:00', '16:00', { breakMinutes: 0 })], { from: '2026-09-01', to: '2026-09-30' });
    expect(warning(eve, '2026-09-20', 'YOUTH_DAILY_LIMIT')).toMatchObject({ ruleId: 'Y-005' });
    const worksHoliday = calc([sh('2026-09-20', '08:00', '16:00', { breakMinutes: 0 }), sh('2026-09-21', '08:00', '10:00', { breakMinutes: 0 })], { from: '2026-09-01', to: '2026-09-30' });
    expect(codes(worksHoliday, '2026-09-20')).not.toContain('YOUTH_DAILY_LIMIT');
  });
});

describe('weekly rest and breaks (Y-006, Y-007)', () => {
  it('5. work on the chosen rest day is prohibited (no permit can allow it); a rest under 36 hours is flagged; pay kept', () => {
    const sat = calc([sh('2026-11-07', '10:00', '14:00', { breakMinutes: 0 })], { youth: PROFILE({ nightPermits: [{ reference: 'X', validFrom: '2026-01-01', validTo: '2026-12-31', until: '23:00' }] }) });
    const w = warning(sat, '2026-11-07', 'YOUTH_REST_DAY')!;
    expect(w.message).toContain('ואין היתר המתיר אותה');
    expect(codes(sat, '2026-11-07')).toContain('YOUTH_PAY_REVIEW');
    expect(sat.youth?.restDayMinutes).toBe(H(4));
    expect(sat.totals.netMinutes).toBe(H(4));
    // A rest day the employee chose (Sunday, fixed) — never inferred.
    const sunRest = emp({ weeklyRest: { kind: 'fixed_day', fixedDay: 0, startOffsetMinutes: 0, endOffsetMinutes: 0 } });
    expect(codes(calc([sh('2026-11-08', '10:00', '14:00', { breakMinutes: 0 })], { s: sunRest }), '2026-11-08')).toContain('YOUTH_REST_DAY');
    // Friday until late and Sunday early: less than 36 consecutive hours around the Shabbat window.
    const short = calc([sh('2026-11-06', '08:00', '15:00', { breakMinutes: 0 }), sh('2026-11-08', '01:00', '05:00', { breakMinutes: 0 })]); // Fri 15:00 → Sun 01:00 = 34h
    expect(short.days.flatMap((d) => d.warnings).some((x) => x.code === 'YOUTH_WEEKLY_REST_SHORT' && x.ruleId === 'Y-006')).toBe(true);
  });

  it('6. 6+ hours with an inadequate actual break is flagged; an unconfirmed automatic break is never treated as taken', () => {
    const r = calc([sh('2026-11-02', '08:00', '14:30', { breakMinutes: 30 })]); // 6:00 net, 30 < 45
    expect(warning(r, '2026-11-02', 'YOUTH_BREAK')).toMatchObject({ severity: 'compliance', ruleId: 'Y-007' });
    // Two 20-minute breaks via split shifts: total 45 but no 30-minute continuous segment.
    const split = calc([sh('2026-11-03', '08:00', '11:00', { breakMinutes: 0 }), sh('2026-11-03', '11:25', '15:25', { breakMinutes: 20 })]); // 6:40 net; 25 + 20 = 45, longest 25
    expect(codes(split, '2026-11-03')).toContain('YOUTH_BREAK');
    // 45 minutes in one recorded break is enough.
    expect(codes(calc([sh('2026-11-04', '08:00', '14:45', { breakMinutes: 45 })]), '2026-11-04')).not.toContain('YOUTH_BREAK');
    // Company auto-deducted break, not confirmed: review, never "break taken"; net minutes not invented.
    const auto = calc([sh('2026-11-05', '08:00', '15:00')], { s: emp({ breakMethod: 'company_auto', companyBreakPolicy: { ...DEFAULT_COMPANY_BREAK_POLICY, shortBreakMinutes: 45 } }) });
    const c = codes(auto, '2026-11-05');
    expect(c).not.toContain('YOUTH_BREAK');
    expect(c).toContain('YOUTH_BREAK_UNVERIFIED');
    // Eve of the weekly rest: 30 minutes suffice.
    expect(codes(calc([sh('2026-11-06', '07:00', '13:30', { breakMinutes: 30 })]), '2026-11-06')).not.toContain('YOUTH_BREAK');
  });
});

describe('age transitions and minimum wage (Y-009 … Y-012)', () => {
  it('7. turning 17 mid-month: the hourly minimum changes on the birthday; earlier days keep the earlier bracket', () => {
    const r = calc([sh('2026-11-09', '09:00', '13:00', { breakMinutes: 0 }), sh('2026-11-11', '09:00', '13:00', { breakMinutes: 0 })], { birthDate: '2009-11-10', s: emp({ hourlyRateAgorot: 2800 }) });
    expect(codes(r, '2026-11-09')).not.toContain('YOUTH_MIN_WAGE'); // 16: 27.94 ≤ 28.00
    expect(warning(r, '2026-11-11', 'YOUTH_MIN_WAGE')).toMatchObject({ ruleId: 'Y-011' }); // 17: 30.92 > 28.00
  });

  it('8. turning 18 mid-month: adult rules from the birthday, no retroactive change', () => {
    const r = calc([sh('2026-11-12', '08:00', '18:00', { breakMinutes: 30 }), sh('2026-11-16', '08:00', '18:00', { breakMinutes: 30 })], { birthDate: '2008-11-15' });
    expect(codes(r, '2026-11-12')).toContain('YOUTH_DAILY_LIMIT');
    expect(codes(r, '2026-11-16').some((c) => c.startsWith('YOUTH'))).toBe(false);
    expect(r.age?.turns18).toBe('2026-11-15');
    expect(birthdayOn('2008-02-29', 18)).toBe('2026-03-01'); // 29 February in a common year
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
    expect(ageOn('2008-02-29', '2026-03-01')).toBe(18);
  });

  it('12. the apprentice rate applies only with a recorded document; rates are not retroactive', () => {
    const s = emp({ hourlyRateAgorot: 2300 });
    const plain = calc([sh('2026-11-02', '09:00', '13:00', { breakMinutes: 0 })], { s, birthDate: UNDER16 });
    expect(warning(plain, '2026-11-02', 'YOUTH_MIN_WAGE')).toMatchObject({ ruleId: 'Y-009' });
    const app = calc([sh('2026-11-02', '09:00', '13:00', { breakMinutes: 0 })], { s, birthDate: UNDER16, youth: PROFILE({ apprentice: { reference: 'אישור חניכות 123' } }) });
    expect(codes(app, '2026-11-02')).not.toContain('YOUTH_MIN_WAGE'); // 23.00 ≥ 22.35
    expect(codes(app, '2026-11-02')).toContain('YOUTH_APPRENTICE_REVIEW');
    const march = calc([sh('2026-03-02', '09:00', '13:00', { breakMinutes: 0 })], { s, birthDate: UNDER16, from: '2026-03-01', to: '2026-03-31' });
    expect(codes(march, '2026-03-02')).not.toContain('YOUTH_MIN_WAGE');
    expect(march.warnings.some((w) => w.code === 'YOUTH_MIN_WAGE_TABLE')).toBe(true);
  });
});

describe('night work, school vacations, permits and minimum age (Y-013 … Y-016)', () => {
  it('ages 16–17: 20:00–22:00 depends on schooling — review when unknown, prohibited when compulsory, allowed when not', () => {
    const shift = [sh('2026-11-03', '14:00', '21:00', { breakMinutes: 45 })];
    expect(codes(calc(shift), '2026-11-03')).toContain('YOUTH_NIGHT_REVIEW');
    expect(codes(calc(shift), '2026-11-03')).not.toContain('YOUTH_NIGHT');
    expect(codes(calc(shift, { youth: PROFILE({ schooling: 'compulsory' }) }), '2026-11-03')).toContain('YOUTH_NIGHT');
    const free = codes(calc(shift, { youth: PROFILE({ schooling: 'not_compulsory' }) }), '2026-11-03');
    expect(free.some((c) => c.startsWith('YOUTH_NIGHT'))).toBe(false);
  });

  it('9. official school vacation, shift ending 00:45: assessed under the 2024 amendment (review + transport); the same shift on a school day is prohibited', () => {
    const shift = [sh('2026-07-14', '17:00', '00:45', { breakMinutes: 45 })];
    const vacation = calc(shift, { from: '2026-07-01', to: '2026-07-31', youth: PROFILE({ schooling: 'compulsory', schoolVacations: [{ from: '2026-07-01', to: '2026-08-31' }] }) });
    const w = warning(vacation, '2026-07-14', 'YOUTH_NIGHT_VACATION_REVIEW')!;
    expect(w).toMatchObject({ severity: 'review', ruleId: 'Y-013' });
    expect(w.message).toContain('עד 01:00');
    expect(w.message).toContain('הסעה');
    expect(codes(vacation, '2026-07-14')).not.toContain('YOUTH_NIGHT');
    const school = calc([sh('2026-11-03', '17:00', '00:45', { breakMinutes: 45 })], { youth: PROFILE({ schooling: 'compulsory' }) });
    expect(codes(school, '2026-11-03')).toContain('YOUTH_NIGHT');
    // Beyond 01:00 even on vacation: prohibited.
    const late = calc([sh('2026-07-15', '18:00', '01:30', { breakMinutes: 45 })], { from: '2026-07-01', to: '2026-07-31', youth: PROFILE({ schoolVacations: [{ from: '2026-07-01', to: '2026-08-31' }] }) });
    expect(codes(late, '2026-07-15')).toContain('YOUTH_NIGHT');
    // Under 16: the 16–17 vacation exception does not apply.
    expect(codes(calc([sh('2026-07-14', '17:00', '21:00', { breakMinutes: 0 })], { birthDate: UNDER16, from: '2026-07-01', to: '2026-07-31', youth: PROFILE({ schoolVacations: [{ from: '2026-07-01', to: '2026-08-31' }] }) }), '2026-07-14')).toContain('YOUTH_NIGHT');
  });

  it('10. a night permit is used only within its validity and hour — an expired permit leaves the prohibition', () => {
    const permit = { reference: 'היתר 77', validFrom: '2026-11-01', validTo: '2026-11-30', until: '23:00' };
    const valid = calc([sh('2026-11-03', '15:00', '22:45', { breakMinutes: 45 })], { youth: PROFILE({ schooling: 'not_compulsory', nightPermits: [permit] }) });
    expect(codes(valid, '2026-11-03')).toContain('YOUTH_NIGHT_PERMIT_REVIEW');
    expect(codes(valid, '2026-11-03')).not.toContain('YOUTH_NIGHT');
    const expired = calc([sh('2026-11-03', '15:00', '22:45', { breakMinutes: 45 })], { youth: PROFILE({ schooling: 'not_compulsory', nightPermits: [{ ...permit, validTo: '2026-10-31' }] }) });
    expect(warning(expired, '2026-11-03', 'YOUTH_NIGHT')!.message).toContain('אינו בתוקף');
    const pastHour = calc([sh('2026-11-04', '16:00', '23:30', { breakMinutes: 45 })], { youth: PROFILE({ schooling: 'not_compulsory', nightPermits: [permit] }) });
    expect(codes(pastHour, '2026-11-04')).toContain('YOUTH_NIGHT');
  });

  it('11. a 14-year-old: prohibited on a school day; on an official school vacation a conditions review', () => {
    const fourteen = '2012-05-01';
    expect(warning(calc([sh('2026-11-03', '09:00', '12:00', { breakMinutes: 0 })], { birthDate: fourteen }), '2026-11-03', 'YOUTH_MIN_AGE')).toMatchObject({ severity: 'compliance' });
    const v = calc([sh('2026-07-14', '09:00', '12:00', { breakMinutes: 0 })], { birthDate: fourteen, from: '2026-07-01', to: '2026-07-31', youth: PROFILE({ schoolVacations: [{ from: '2026-07-01', to: '2026-08-31' }] }) });
    expect(codes(v, '2026-07-14')).toContain('YOUTH_MIN_AGE_REVIEW');
    expect(codes(v, '2026-07-14')).not.toContain('YOUTH_MIN_AGE');
  });

  it('schooling cannot be inferred from age: a period review when work falls outside recorded school vacations', () => {
    const r = calc([sh('2026-11-03', '09:00', '12:00', { breakMinutes: 0 })]);
    expect(r.warnings.find((w) => w.code === 'YOUTH_SCHOOL_REVIEW')).toMatchObject({ ruleId: 'Y-016' });
    expect(calc([sh('2026-11-03', '09:00', '12:00', { breakMinutes: 0 })], { youth: PROFILE({ schooling: 'not_compulsory' }) }).warnings.some((w) => w.code === 'YOUTH_SCHOOL_REVIEW')).toBe(false);
  });
});

describe('youth vacation and rule-set versioning (Y-017, test 17)', () => {
  it('13. a minor’s vacation day is flagged — no youth vacation pay is calculated or duplicated', () => {
    const r = calc([], { statuses: [{ date: '2026-11-04', status: 'vacation' }] });
    expect(warning(r, '2026-11-04', 'YOUTH_VACATION_REVIEW')).toMatchObject({ ruleId: 'Y-017' });
  });

  it('17. rule set Y1 (1.1.9) is preserved verbatim for months closed under it; Y2 is the default', () => {
    const shift = [sh('2026-11-03', '14:00', '21:00', { breakMinutes: 45 })]; // 16-year-old, 20:00–21:00
    const y1 = calc(shift, { ruleSet: 'Y1' });
    const y2 = calc(shift);
    expect(codes(y1, '2026-11-03').some((c) => c.startsWith('YOUTH_NIGHT'))).toBe(false); // 1.1.9 behaviour
    expect(codes(y2, '2026-11-03')).toContain('YOUTH_NIGHT_REVIEW');
    expect(y1.youth).toBeUndefined();
    expect(y2.youth?.ruleSet).toBe('Y2');
    expect(y1.totals.netMinutes).toBe(y2.totals.netMinutes);
  });
});

describe('legal rule registry', () => {
  it('every rule has an id, source, source class, inputs, codes and tests; money checks have a verified start date', () => {
    const ids = new Set<string>();
    for (const r of LEGAL_RULES) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
      expect(r.sourceUrl).toMatch(/^https:\/\/(www\.kolzchut\.org\.il|main\.knesset\.gov\.il|www\.btl\.gov\.il|www\.gov\.il)\//);
      expect(r.codes.length).toBeGreaterThan(0);
      expect(r.inputs.length).toBeGreaterThan(0);
      expect(r.tests.length).toBeGreaterThan(0);
      if (r.mode === 'wage_check') expect(r.effectiveFrom).toBe('2026-04-01');
    }
    expect(LEGAL_RULES.find((r) => r.id === 'Y-013')).toMatchObject({ mode: 'exception', effectiveFrom: null, sourceClass: 'official_announcement' });
    expect(rulesInForce('2026-03-31').some((r) => r.id === 'Y-009')).toBe(false);
    expect(rulesInForce('2026-04-01').some((r) => r.id === 'Y-009')).toBe(true);
  });

  it('no youth message relies on the outdated 24:00 limit', () => {
    const r = calc([sh('2026-07-14', '17:00', '00:45', { breakMinutes: 45 })], { from: '2026-07-01', to: '2026-07-31', youth: PROFILE({ schoolVacations: [{ from: '2026-07-01', to: '2026-08-31' }] }) });
    const text = [...r.days.flatMap((d) => d.warnings), ...r.warnings].map((w) => w.message).join(' ');
    expect(text).not.toMatch(/24:00|חצות/);
    expect(JSON.stringify(LEGAL_RULES)).not.toMatch(/24:00/);
  });
});

describe('agreements: catalog and clause gate (tests 14–16)', () => {
  const full = { by: 'א', at: 't', industry: 'בנייה', occupation: 'מזכירה', employmentStart: null, fullTextReviewed: true, amendmentsChecked: true, exclusionsChecked: true };

  it('catalog: research-pack entries, families kept apart, amendment relations, no fabricated amounts', () => {
    const keys = CATALOG.map((e) => e.researchId).filter(Boolean);
    for (let i = 1; i <= 18; i++) expect(keys).toContain(`COLL-${String(i).padStart(3, '0')}`);
    expect(searchCatalog('', 'collective_agreement')).toEqual([]); // no collective agreement is catalogued
    expect(searchCatalog('', 'wage_notice').map((e) => e.id).sort()).toEqual(['coll-016', 'coll-017']);
    expect(searchCatalog('2010').map((e) => e.id)).toContain('coll-009'); // by year
    expect(searchCatalog('COLL-012').map((e) => e.id)).toEqual(['coll-012']); // by key
    expect(catalogEntry('eo-construction')!.relations).toContainEqual({ kind: 'amended_by', id: 'coll-018' });
    for (const e of CATALOG) {
      expect(['extension_order', 'wage_notice']).toContain(FAMILY_OF[e.type]);
      if (e.researchId) expect(e.profiles.every((p) => !p.hours && !p.recuperation)).toBe(true);
    }
  });

  it('14. any metadata-only instrument, even fully confirmed, never changes a calculation', () => {
    const sel = [{ catalogId: 'coll-009', confirmation: { ...full, employeeClass: 'other' as const } }];
    const r = resolveAgreements(sel, '2026-11-01');
    expect(r.instruments[0]).toMatchObject({ confirmed: true, executable: false });
    expect(r.instruments[0].status).toContain('המקור אותר; הוראות החישוב לא אומתו');
    expect(agreementHoursFor(sel, '2026-11-01', '2026-11-30')).toEqual([]);
  });

  it('15. construction order + office employee: the applicability check fails', () => {
    const e = catalogEntry('eo-construction')!;
    expect(confirmationProblems({ catalogId: e.id, confirmation: { ...full, employeeClass: 'office_staff' } }, e)).toContain('סיווג העובד אינו בתחולת המכשיר לפי הגדרותיו');
    expect(confirmationProblems({ catalogId: e.id, confirmation: { ...full, employeeClass: 'site_worker' } }, e)).toEqual([]);
    // A client company's employee is not covered by the cleaning order.
    const c = catalogEntry('eo-cleaning')!;
    expect(confirmationProblems({ catalogId: c.id, confirmation: { ...full, employeeClass: 'client_employee' } }, c).length).toBeGreaterThan(0);
  });

  it('16. 2026 cleaning and guarding wage notices: no amounts encoded, never executable; old rates are not used', () => {
    for (const id of ['coll-016', 'coll-017']) {
      const e = catalogEntry(id)!;
      expect(e.profiles).toEqual([]);
      expect(e.evidence).toBe('directory_only');
    }
    expect(catalogEntry('eo-security')!.profiles).toEqual([]);
    expect(catalogEntry('eo-cleaning')!.profiles).toEqual([]);
  });

  it('two verified instruments for the same domain: nothing is cherry-picked, the conflict is flagged', () => {
    const extra = { ...catalogEntry('eo-recuperation')!, id: 'tmp-recup', name: 'בדיקה', type: 'industry_extension_order' as const };
    CATALOG.push(extra);
    try {
      const conf = { ...full, employeeClass: 'other' as const };
      const cv = (v: string) => [{ profileVersion: v, clause: 'recuperation' as const, clauseRef: '2', effectiveFrom: '2025-07-01', by: 'x', at: 't' }];
      const r = resolveAgreements(
        [
          { catalogId: 'eo-recuperation', confirmation: conf, clauseVerifications: cv('2026') },
          { catalogId: 'tmp-recup', confirmation: conf, clauseVerifications: cv('2026') },
        ],
        '2026-01-15',
      );
      expect(r.recuperation).toBeNull();
      expect(r.reviews.join()).toContain('לא הוחל אף אחד');
    } finally {
      CATALOG.pop();
    }
  });
});
