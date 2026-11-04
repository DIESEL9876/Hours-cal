/**
 * 1.1.11 — clauses transcribed by a payroll professional from the OFFICIAL text of an instrument (hours, overtime and
 * rest/holiday rates, night premium, sector minimum wage): gate, favourability, conflicts, effective dates, engine
 * effect on the pay estimate only (recorded minutes never change). All values below are synthetic test data — no real
 * instrument's values are encoded in the catalog.
 */
import { describe, expect, it } from 'vitest';
import { BUCKET_PERCENT, bucketPercents, calculateEmployeePeriod, defaultEmployeeSettings, type AgreementSelection, type ClauseVerification, type ShiftInput } from '../index';
import { agreementHoursFor, agreementPayFor, resolveAgreements, TRANSCRIBED_VERSION, transcribedProblems, UNLISTED_ID } from '../../agreements';
import { day, H, sh, versions } from './helpers';

const conf = { by: 'מנהלת השכר', at: '2026-11-01', industry: 'הסעדה', occupation: 'טבח', employmentStart: null, employeeClass: 'other' as const, fullTextReviewed: true, amendmentsChecked: true, exclusionsChecked: true };
const clause = (c: Partial<ClauseVerification>): ClauseVerification => ({ profileVersion: TRANSCRIBED_VERSION, clause: 'overtime_rates', clauseRef: 'סעיף 7(א)', effectiveFrom: '2026-01-01', by: 'רו"ח לוי', at: '2026-11-01T10:00:00Z', values: { overtimeRates: { tier1Percent: 150, tier2Percent: 200 } }, ...c });
const sel = (cs: ClauseVerification[], over: Partial<AgreementSelection> = {}): AgreementSelection => ({ catalogId: 'coll-006', confirmation: conf, clauseVerifications: cs, ...over });

function calc(shifts: ShiftInput[], agreementPay = agreementPayFor([], '2026-11-01', '2026-11-30').rules) {
  return calculateEmployeePeriod({
    employeeId: 'e',
    settingsVersions: versions(defaultEmployeeSettings({ breakMethod: 'manual', hourlyRateAgorot: 5000 })),
    shifts,
    dayStatuses: [],
    customHolidays: [],
    from: '2026-11-01',
    to: '2026-11-30',
    agreementPay,
  });
}

describe('transcribed clauses: gate and validation', () => {
  it('a transcription is executable only with a complete applicability confirmation', () => {
    expect(agreementPayFor([sel([clause({})], { confirmation: null })], '2026-11-01', '2026-11-30').rules).toEqual([]);
    expect(agreementPayFor([sel([clause({})], { confirmation: { ...conf, fullTextReviewed: false } })], '2026-11-01', '2026-11-30').rules).toEqual([]);
    const ok = agreementPayFor([sel([clause({})])], '2026-11-01', '2026-11-30').rules;
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ overtimeRates: { tier1Percent: 150, tier2Percent: 200 }, from: '2026-01-01', to: null });
    expect(ok[0].source).toContain('סעיף 7(א)');
    expect(resolveAgreements([sel([clause({})])], '2026-11-15').instruments[0]).toMatchObject({ executable: true, clauses: ['overtime_rates'] });
  });

  it('values below the statute are rejected and flagged, never applied', () => {
    expect(transcribedProblems('overtime_rates', { overtimeRates: { tier1Percent: 120, tier2Percent: 150 } }).length).toBeGreaterThan(0);
    expect(transcribedProblems('rest_holiday_rates', { restHolidayRates: { restPercent: 140, holidayPercent: 150 } }).length).toBeGreaterThan(0);
    expect(transcribedProblems('hours', { hours: { dailyThresholdMinutes: [540, 540, 540, 540, 540, 0, 0], weeklyThresholdMinutes: H(42), firstTierMinutes: 120 } })).toContain('יום ארוך מ-8:36 — פחות מיטיב מהחוק');
    expect(transcribedProblems('overtime_rates', { overtimeRates: { tier1Percent: 137.5, tier2Percent: 150 } })).toEqual(['שיעורים חסרים או לא שלמים']);
    const bad = sel([clause({ values: { overtimeRates: { tier1Percent: 120, tier2Percent: 150 } } })]);
    expect(agreementPayFor([bad], '2026-11-01', '2026-11-30').rules).toEqual([]);
    expect(resolveAgreements([bad], '2026-11-15').reviews.join()).toContain('לא הוחל');
  });

  it('effective dates: before effectiveFrom and after effectiveTo the clause does not apply', () => {
    expect(agreementPayFor([sel([clause({ effectiveFrom: '2026-12-01' })])], '2026-11-01', '2026-11-30').rules).toEqual([]);
    expect(agreementPayFor([sel([clause({ effectiveTo: '2026-10-31' })])], '2026-11-01', '2026-11-30').rules).toEqual([]);
    const mid = agreementPayFor([sel([clause({ effectiveFrom: '2026-11-15' })])], '2026-11-01', '2026-11-30').rules;
    const r = calc([sh('2026-11-10', '08:00', '19:00', { breakMinutes: 0 }), sh('2026-11-17', '08:00', '19:00', { breakMinutes: 0 })], mid);
    const plain = calc([sh('2026-11-10', '08:00', '19:00', { breakMinutes: 0 }), sh('2026-11-17', '08:00', '19:00', { breakMinutes: 0 })]);
    expect(day(r, '2026-11-10').payAgorot).toBe(day(plain, '2026-11-10').payAgorot);
    expect(day(r, '2026-11-17').payAgorot).toBeGreaterThan(day(plain, '2026-11-17').payAgorot!);
  });

  it('two instruments for the same domain and period block each other; disjoint periods both apply', () => {
    const a = sel([clause({})]);
    const b = sel([clause({ values: { overtimeRates: { tier1Percent: 175, tier2Percent: 200 } } })], { catalogId: 'coll-008' });
    const res = agreementPayFor([a, b], '2026-11-01', '2026-11-30');
    expect(res.rules).toEqual([]);
    expect(res.reviews.join()).toContain('לא הוחל אף אחד');
    const a2 = sel([clause({ effectiveTo: '2026-11-14' })]);
    const b2 = sel([clause({ effectiveFrom: '2026-11-15', values: { overtimeRates: { tier1Percent: 175, tier2Percent: 200 } } })], { catalogId: 'coll-008' });
    expect(agreementPayFor([a2, b2], '2026-11-01', '2026-11-30').rules).toHaveLength(2);
  });

  it('an unlisted registered agreement is cited by its recorded title and registration number', () => {
    const u = sel([clause({})], { catalogId: UNLISTED_ID, title: 'הסכם קיבוצי מיוחד — חברת דוגמה', registrationNumber: '7029/2024' });
    const [rule] = agreementPayFor([u], '2026-11-01', '2026-11-30').rules;
    expect(rule.source).toContain('הסכם קיבוצי מיוחד — חברת דוגמה (מס׳ רישום 7029/2024)');
  });
});

describe('transcribed clauses: effect on the calculation', () => {
  it('without a rule the bucket table is the statute; with one, tiers and rest/holiday rates come from the clause', () => {
    expect(bucketPercents(null)).toBe(BUCKET_PERCENT);
    expect(bucketPercents({ overtimeRates: { tier1Percent: 150, tier2Percent: 200 }, restHolidayRates: { restPercent: 200, holidayPercent: 250 } })).toEqual({
      regular: 100,
      ot125: 150,
      ot150: 200,
      rest150: 200,
      rest175: 250,
      rest200: 300,
      holiday150: 250,
      holiday175: 300,
      holiday200: 350,
      unclassified: 100,
    });
  });

  it('overtime rates change the pay estimate only — recorded minutes and classification are unchanged', () => {
    const shifts = [sh('2026-11-02', '08:00', '19:00', { breakMinutes: 0 })]; // 11:00 → 8:36 + 2:00 @T1 + 0:24 @T2
    const plain = calc(shifts);
    const rule = agreementPayFor([sel([clause({})])], '2026-11-01', '2026-11-30').rules;
    const r = calc(shifts, rule);
    expect(r.totals.netMinutes).toBe(plain.totals.netMinutes);
    expect(r.totals.buckets).toEqual(plain.totals.buckets);
    const b = plain.totals.buckets;
    // Extra over the statute: (150−125)% on tier-1 minutes + (200−150)% on tier-2 minutes, at 50 ₪/h.
    const extra = Math.round((b.ot125 * 25 + b.ot150 * 50) * 5000 / 100 / 60);
    expect(r.totals.payAgorot! - plain.totals.payAgorot!).toBe(extra);
    expect(day(r, '2026-11-02').explanation.join(' ')).toContain('סעיפים מאומתים');
  });

  it('a night premium adds its percentage for minutes inside the window', () => {
    const night = clause({ clause: 'night_premium', values: { nightPremium: { startMinute: 22 * 60, endMinute: 6 * 60, percent: 20 } } });
    const shifts = [sh('2026-11-03', '18:00', '23:00', { breakMinutes: 0 })]; // one hour inside 22:00–06:00
    const plain = calc(shifts);
    const r = calc(shifts, agreementPayFor([sel([night])], '2026-11-01', '2026-11-30').rules);
    expect(r.totals.payAgorot! - plain.totals.payAgorot!).toBe(Math.round((60 * 20 * 5000) / 100 / 60)); // 20% × 1 h × 50 ₪ = 10 ₪
    expect(r.totals.netMinutes).toBe(plain.totals.netMinutes);
  });

  it('a sector minimum wage is a compliance check, never a changed rate', () => {
    const min = clause({ clause: 'minimum_wage', values: { minimumHourlyAgorot: 5500 } });
    const r = calc([sh('2026-11-04', '08:00', '12:00', { breakMinutes: 0 })], agreementPayFor([sel([min])], '2026-11-01', '2026-11-30').rules);
    expect(day(r, '2026-11-04').warnings.map((w) => w.code)).toContain('AGREEMENT_MIN_WAGE');
    expect(r.totals.payAgorot).toBe(calc([sh('2026-11-04', '08:00', '12:00', { breakMinutes: 0 })]).totals.payAgorot);
  });

  it('a transcribed hours clause changes the thresholds through the existing agreement-hours path', () => {
    const hours = clause({ clause: 'hours', values: { hours: { dailyThresholdMinutes: [480, 480, 480, 480, 480, 0, 0], weeklyThresholdMinutes: H(40), firstTierMinutes: 120 } } });
    const rules = agreementHoursFor([sel([hours])], '2026-11-01', '2026-11-30');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ weeklyThresholdMinutes: H(40), from: '2026-01-01' });
    // A catalog profile and a transcription for the same domain are never combined automatically.
    expect(agreementHoursFor([sel([hours]), { catalogId: 'eo-recuperation' }], '2026-11-01', '2026-11-30')).toHaveLength(1);
  });
});
