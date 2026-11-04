/**
 * 1.1.9 through the real database and service layer: additive migration v3, birth date, monthly payroll components
 * (month isolation, idempotent save, audit, closed months), travel, financial totals, agreements catalog and rules.
 */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver, type SqlJsPersistence } from '../sqljsDriver';
import { Repository, RepoError } from '../repo';
import { MIGRATIONS, SCHEMA_VERSION } from '../schema';
import { closingRules, computeBusinessFinancials, computeBusinessMonth, computeEmployeeMonth, sha256Hex, snapshotOf } from '../service';
import { defaultEmployeeSettings, type ShiftInput } from '../../engine';
import { buildTimestamps } from '../../ui/timeEntry';
import { CATALOG, recuperationDays, resolveAgreements, searchCatalog, catalogEntry, UNLISTED_ID, NOT_VERIFIED_TEXT } from '../../agreements';
import type { BackupInfo } from '../driver';

const SQL = await initSqlJs();

function memory() {
  let main: Uint8Array | null = null;
  const backups = new Map<string, Uint8Array>();
  const p: SqlJsPersistence = {
    location: 'memory',
    load: async () => main,
    save: async (b) => void (main = b),
    saveBackup: async (n, b) => void backups.set(n, b),
    loadBackup: async (n) => backups.get(n) ?? null,
    listBackups: async (): Promise<BackupInfo[]> => [...backups].map(([name, b]) => ({ name, createdAt: '', sizeBytes: b.length })),
  };
  return p;
}
async function open(p: SqlJsPersistence | null = null) {
  const r = new Repository(await SqlJsDriver.open(SQL, p));
  await r.migrate();
  return r;
}
const shift = (date: string, a: string, b: string, brk = 0): ShiftInput => {
  const ts = buildTimestamps(date, a, b);
  return { id: crypto.randomUUID(), workDate: date, startAt: ts.startAt, endAt: ts.endAt, breakMinutes: brk, breakStart: null, breakConfirmed: true, breakPaid: false, reviewed: false };
};
async function setup(repo: Repository, over: Parameters<typeof defaultEmployeeSettings>[0] = {}) {
  const b = await repo.createBusiness({ name: `עסק ${Math.random()}`, defaults: defaultEmployeeSettings({ breakMethod: 'manual', ...over }) });
  const { fridayOvertimeHistory: _f, weeklyCreditHistory: _w, ...copy } = b.defaults;
  const e = await repo.createEmployee(b.id, { fullName: 'דנה לוי', settings: { ...copy, fridayOvertime: 'inherit', travel: { mode: 'inherit' } } });
  return { b, e };
}
const adj = (b: string, e: string, ym: string, over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  businessId: b,
  employeeId: e,
  yearMonth: ym,
  category: 'bonus' as const,
  amountAgorot: 50000,
  date: null,
  description: null,
  details: {},
  ...over,
});

describe('additive migration v2 → v3', () => {
  it('existing employees, shifts and day entries survive; backup before migration; new columns empty', async () => {
    const p = memory();
    const v2 = new Repository(await SqlJsDriver.open(SQL, p));
    await v2.driver.batch([{ sql: `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT NOT NULL)` }]);
    for (const m of MIGRATIONS.filter((x) => x.version <= 2))
      await v2.driver.batch([...m.statements.map((sql) => ({ sql })), { sql: `INSERT INTO schema_migrations VALUES (?, ?, 't')`, params: [m.version, m.description] }]);
    await v2.driver.batch([
      { sql: `INSERT INTO businesses (id, name, identifier, defaults_json, created_at, updated_at) VALUES ('b1', 'ישן', NULL, ?, 't', 't')`, params: [JSON.stringify(defaultEmployeeSettings({ breakMethod: 'manual' }))] },
      { sql: `INSERT INTO employees (id, business_id, full_name, employee_number, notes, created_at, updated_at) VALUES ('e1', 'b1', 'עובד ותיק', '7', NULL, 't', 't')` },
      { sql: `INSERT INTO employee_settings (id, employee_id, effective_from, settings_json, created_at, updated_at) VALUES ('v1', 'e1', '1900-01-01', ?, 't', 't')`, params: [JSON.stringify(defaultEmployeeSettings({ breakMethod: 'manual' }))] },
      { sql: `INSERT INTO shifts (id, business_id, employee_id, work_date, start_at, end_at, break_minutes, break_confirmed, created_at, updated_at) VALUES ('s1', 'b1', 'e1', '2026-10-12', '2026-10-12T08:00', '2026-10-12T17:00', 30, 1, 't', 't')` },
      { sql: `INSERT INTO day_entries (employee_id, business_id, date, status, note, updated_at, absence_json) VALUES ('e1', 'b1', '2026-10-13', 'vacation', NULL, 't', NULL)` },
    ]);
    const before = snapshotOf(await computeBusinessMonth(v2Compat(v2), 'b1', 2026, 10));
    const r = new Repository(await SqlJsDriver.open(SQL, p));
    expect(await r.migrate()).toBe(SCHEMA_VERSION);
    expect((await r.driver.listBackups()).some((x) => x.name.includes('pre-migration'))).toBe(true);
    const [e] = await r.listEmployees('b1');
    expect(e).toMatchObject({ fullName: 'עובד ותיק', employeeNumber: '7', birthDate: null });
    expect(snapshotOf(await computeBusinessMonth(r, 'b1', 2026, 10))).toBe(before); // identical calculation
    expect(await r.listAdjustments('b1', '2026-10')).toEqual([]);
  });
});

/** Reads a v2 database with the current code paths that do not touch v3 tables. */
function v2Compat(r: Repository): Repository {
  return new Proxy(r, {
    get(t, k) {
      if (k === 'getEmployeeMonth') return async () => ({});
      if (k === 'getEmployee') return async (b: string, id: string) => ({ ...(await t.getEmployee(b, id)), birthDate: null });
      return Reflect.get(t, k);
    },
  }) as Repository;
}

describe('date of birth', () => {
  it('stored, validated and used per attendance date (youth checks)', async () => {
    const repo = await open();
    const { b, e } = await setup(repo);
    await expect(repo.updateEmployee(b.id, e.id, { birthDate: '2099-01-01' })).rejects.toThrow('עתידי');
    await repo.updateEmployee(b.id, e.id, { birthDate: '2009-06-01' });
    await repo.upsertShift(b.id, e.id, shift('2026-11-02', '08:00', '19:00', 30)); // 10:30 for a 17-year-old
    const r = await computeEmployeeMonth(repo, b.id, e.id, 2026, 11);
    expect(r.days.find((d) => d.date === '2026-11-02')!.warnings.map((w) => w.code)).toContain('YOUTH_DAILY_LIMIT');
    expect(r.totals.netMinutes).toBe(630);
  });
});

describe('monthly payroll components', () => {
  it('belong to one employee and one month; persist across restart; saving twice never duplicates', async () => {
    const p = memory();
    const repo = await open(p);
    const { b, e } = await setup(repo);
    const a = adj(b.id, e.id, '2026-10');
    await repo.saveAdjustment(a);
    await repo.saveAdjustment(a); // double click
    await repo.saveAdjustment(adj(b.id, e.id, '2026-10', { amountAgorot: 20000 })); // second bonus same month
    expect(await repo.listAdjustments(b.id, '2026-10', e.id)).toHaveLength(2);
    expect(await repo.listAdjustments(b.id, '2026-11', e.id)).toEqual([]); // October does not reappear in November
    const reopened = new Repository(await SqlJsDriver.open(SQL, p));
    await reopened.migrate();
    expect((await reopened.listAdjustments(b.id, '2026-10')).map((x) => x.amountAgorot).sort()).toEqual([20000, 50000]);
  });

  it('edit and delete are audited; deleted entries stop counting', async () => {
    const repo = await open();
    const { b, e } = await setup(repo);
    const a = await repo.saveAdjustment(adj(b.id, e.id, '2026-10'));
    await repo.saveAdjustment({ ...a, amountAgorot: 60000, description: 'תיקון' });
    await repo.deleteAdjustment(b.id, a.id);
    expect(await repo.listAdjustments(b.id, '2026-10')).toEqual([]);
    const audit = await repo.driver.select<{ action: string }>(`SELECT action FROM audit_log WHERE entity = 'monthly_adjustment' ORDER BY id`);
    expect(audit.map((x) => x.action)).toEqual(['create', 'update', 'delete']);
  });

  it('advances: advanced / proposed / authorised kept apart; deduction needs a recorded basis', async () => {
    const repo = await open();
    const { b, e } = await setup(repo);
    await expect(
      repo.saveAdjustment(adj(b.id, e.id, '2026-10', { category: 'advance', amountAgorot: 100000, details: { advance: { proposedRecoveryAgorot: 50000, authorizedDeductionAgorot: 50000, authorization: '' } } })),
    ).rejects.toThrow('בסיס לאישור');
    await repo.saveAdjustment(adj(b.id, e.id, '2026-10', { category: 'advance', amountAgorot: 100000, details: { advance: { proposedRecoveryAgorot: 50000, authorizedDeductionAgorot: 30000, authorization: 'הסכמה בכתב 1.10' } } }));
    await repo.saveAdjustment(adj(b.id, e.id, '2026-10', { category: 'reserve', amountAgorot: 120000, details: { reserve: { kind: 'wage_during_service' } } }));
    await repo.saveAdjustment(adj(b.id, e.id, '2026-10', { category: 'reserve', amountAgorot: 120000, details: { reserve: { kind: 'nii_reimbursement' } } }));
    await repo.saveAdjustment(adj(b.id, e.id, '2026-10', { category: 'recuperation', amountAgorot: 225750 }));
    const s = await computeBusinessMonth(repo, b.id, 2026, 10);
    const { byEmployee, totals } = await computeBusinessFinancials(repo, b.id, 2026, 10, s);
    const f = byEmployee.get(e.id)!;
    expect(f.advance).toEqual({ advancedAgorot: 100000, proposedRecoveryAgorot: 50000, authorizedDeductionAgorot: 30000 });
    expect(f.reserve).toMatchObject({ wageDuringServiceAgorot: 120000, niiReimbursementAgorot: 120000 });
    // Reserve: the employer's wage payment is a gross item; the NII reimbursement goes to the EMPLOYER (never twice).
    expect(f.totals).toMatchObject({ grossAdditionsAgorot: 120000 + 225750, employerReimbursementsAgorot: 120000, advancesPaidAgorot: 100000, authorizedDeductionsAgorot: 30000 });
    expect(totals.grossAdditionsAgorot).toBe(f.totals.grossAdditionsAgorot);
    // Money never becomes attendance.
    expect(s.grandTotal.netMinutes).toBe(0);
    expect(s.attendanceTotal.actualWorkedDays).toBe(0);
  });

  it('a closed month is read-only until reopened', async () => {
    const repo = await open();
    const { b, e } = await setup(repo);
    const s = await computeBusinessMonth(repo, b.id, 2026, 10);
    const json = snapshotOf(s);
    await repo.setMonthReview(b.id, '2026-10', 'final', { json, hash: await sha256Hex(json) }, null, await closingRules(repo, b.id, 2026, 10));
    await expect(repo.saveAdjustment(adj(b.id, e.id, '2026-10'))).rejects.toBeInstanceOf(RepoError);
    await expect(repo.setEmployeeMonth(b.id, e.id, '2026-10', { travel: { eligibleDays: 3, reason: 'x', autoDays: 0 } })).rejects.toThrow('נסגר');
    expect(JSON.parse((await repo.getMonthReview(b.id, '2026-10')).rulesJson!)).toMatchObject({ catalogVersion: expect.any(String) });
    await repo.setMonthReview(b.id, '2026-10', 'open', null);
    await repo.saveAdjustment(adj(b.id, e.id, '2026-10'));
  });
});

describe('travel', () => {
  it('daily: eligible days = distinct worked dates (two shifts = one day; vacation excluded); manual correction with reason', async () => {
    const repo = await open();
    const { b, e } = await setup(repo, { travel: { mode: 'daily', amountAgorot: 1500 } });
    await repo.upsertShift(b.id, e.id, shift('2026-10-11', '08:00', '12:00'));
    await repo.upsertShift(b.id, e.id, shift('2026-10-11', '16:00', '20:00'));
    await repo.upsertShift(b.id, e.id, shift('2026-10-12', '08:00', '16:00'));
    await repo.setDayEntry(b.id, e.id, { date: '2026-10-13', status: 'vacation', note: null });
    const fin = async () => (await computeBusinessFinancials(repo, b.id, 2026, 10, await computeBusinessMonth(repo, b.id, 2026, 10))).byEmployee.get(e.id)!.travel;
    expect(await fin()).toMatchObject({ mode: 'daily', inherited: true, autoDays: 2, eligibleDays: 2, totalAgorot: 3000 });
    await repo.setEmployeeMonth(b.id, e.id, '2026-10', { travel: { eligibleDays: 1, reason: 'יום עבודה מהבית', autoDays: 2 } });
    expect(await fin()).toMatchObject({ eligibleDays: 1, overrideDays: 1, overrideReason: 'יום עבודה מהבית', totalAgorot: 1500 });
  });

  it('monthly fixed amount; employee override of the business setting', async () => {
    const repo = await open();
    const { b, e } = await setup(repo, { travel: { mode: 'daily', amountAgorot: 1500 } });
    const [v] = await repo.getSettingsVersions(e.id);
    await repo.saveSettingsVersion(b.id, e.id, v.effectiveFrom, { ...v.settings, travel: { mode: 'monthly', amountAgorot: 30000 } }, { authorizeRetroactive: true });
    await repo.upsertShift(b.id, e.id, shift('2026-10-11', '08:00', '12:00'));
    const f = (await computeBusinessFinancials(repo, b.id, 2026, 10, await computeBusinessMonth(repo, b.id, 2026, 10))).byEmployee.get(e.id)!;
    expect(f.travel).toMatchObject({ mode: 'monthly', inherited: false, totalAgorot: 30000 });
    expect(f.totals.grossAdditionsAgorot).toBe(30000);
  });
});

describe('paid-day override for a month', () => {
  it('keeps the calculated value and the reason; affects only that month', async () => {
    const repo = await open();
    const { b, e } = await setup(repo, { absence: { salaryType: 'hourly', paidDayReference: 'average_month' }, hourlyRateAgorot: 4000 });
    await repo.upsertShift(b.id, e.id, shift('2026-10-11', '08:00', '14:00'));
    await repo.setDayEntry(b.id, e.id, { date: '2026-10-12', status: 'vacation', note: null });
    let r = await computeEmployeeMonth(repo, b.id, e.id, 2026, 10);
    expect(r.paidDay).toMatchObject({ method: 'average_month', dayMinutes: 360 });
    await repo.setEmployeeMonth(b.id, e.id, '2026-10', { paidDayOverride: { minutes: 480, reason: 'לפי הסכם אישי', calculatedMinutes: 360 } });
    r = await computeEmployeeMonth(repo, b.id, e.id, 2026, 10);
    expect(r.paidDay).toMatchObject({ method: 'override', dayMinutes: 480, calculatedMinutes: 360, overrideReason: 'לפי הסכם אישי' });
    expect(r.attendance.estimatedAbsenceValueAgorot).toBe(32000);
    expect((await computeEmployeeMonth(repo, b.id, e.id, 2026, 11)).paidDay?.method).toBe('average_month');
  });
});

describe('agreements catalog and rules', () => {
  const fullConfirmation = {
    by: 'מנהלת השכר',
    at: '2026-11-03',
    industry: 'מסחר',
    occupation: 'קופאי',
    employmentStart: '2024-01-01',
    employeeClass: 'other' as const,
    fullTextReviewed: true,
    amendmentsChecked: true,
    exclusionsChecked: true,
  };

  it('search by name, industry, keyword; metadata and sources present', () => {
    expect(searchCatalog('הבראה').map((e) => e.id)).toEqual(['eo-recuperation']);
    expect(searchCatalog('שמירה').map((e) => e.id)).toEqual(['eo-security', 'coll-017']);
    expect(searchCatalog('').length).toBe(CATALOG.length);
    for (const e of CATALOG) {
      expect(e.sourceUrl).toMatch(/^https:\/\/www\.gov\.il\//);
      expect(e.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.verification).not.toBe('primary'); // never claimed without primary access
    }
  });

  // 1.1.10: selection and a 1.1.9 whole-profile verification are no longer enough — each clause needs its own check.
  it('selection is reference only; only a complete confirmation + a verified clause activates it', () => {
    const none = resolveAgreements([{ catalogId: 'eo-recuperation' }], '2026-01-15');
    expect(none.instruments[0]).toMatchObject({ confirmed: false, executable: false });
    expect(none.instruments[0].status).toContain('תחולה בבדיקה');
    expect(none.recuperation?.executable).toBe(false);
    const legacy = { by: 'מנהלת השכר', at: '2026-11-03', industry: 'מסחר', occupation: 'קופאי', employmentStart: '2024-01-01' };
    const old = resolveAgreements([{ catalogId: 'eo-recuperation', confirmation: legacy, professionalVerification: { by: 'רו"ח כהן', at: '2026-11-03', version: '2026' } }], '2026-01-15');
    expect(old.recuperation?.executable).toBe(false);
    expect(old.instruments[0].status).toContain('תחולה בבדיקה');
    const confirmed = resolveAgreements([{ catalogId: 'eo-recuperation', confirmation: fullConfirmation }], '2026-01-15');
    expect(confirmed.instruments[0].status).toContain(NOT_VERIFIED_TEXT);
    expect(confirmed.reviews.join()).toContain('דורש בדיקה מקצועית');
    const clause = { profileVersion: '2026', clause: 'recuperation' as const, clauseRef: 'סעיף 2', effectiveFrom: '2025-07-01', by: 'רו"ח כהן', at: '2026-11-03' };
    const verified = resolveAgreements([{ catalogId: 'eo-recuperation', confirmation: fullConfirmation, clauseVerifications: [clause] }], '2026-01-15');
    expect(verified.recuperation).toMatchObject({ executable: true, rule: { dayValueAgorot: 45150 } });
    expect(verified.instruments[0].status).toContain('כללים מאומתים');
    // Before the clause's verified effective date it does not apply.
    expect(resolveAgreements([{ catalogId: 'eo-recuperation', confirmation: fullConfirmation, clauseVerifications: [{ ...clause, effectiveFrom: '2026-02-01' }] }], '2026-01-15').recuperation?.executable).toBe(false);
    expect(recuperationDays(verified.recuperation!.rule, 0)).toBeNull();
    expect(recuperationDays(verified.recuperation!.rule, 3)).toBe(6);
    expect(recuperationDays(verified.recuperation!.rule, 25)).toBe(10);
  });

  it('metadata-only and unlisted agreements never execute; dates out of force are reported', () => {
    const r = resolveAgreements([{ catalogId: 'eo-security', confirmation: { ...fullConfirmation, employeeClass: 'contractor_worker' } }, { catalogId: UNLISTED_ID }], '2026-11-01');
    expect(r.instruments.every((i) => !i.executable)).toBe(true);
    expect(r.hours).toBeNull();
    expect(catalogEntry('eo-short-week-2018')!.startDate).toBe('2018-04-01');
    expect(resolveAgreements([{ catalogId: 'eo-short-week-2018' }], '2017-06-01').instruments[0].status).toBe('אינו בתוקף בתאריך זה');
  });

  it('instruments are listed by precedence; values are informational until verified', () => {
    const r = resolveAgreements([{ catalogId: 'eo-travel' }, { catalogId: 'eo-recuperation' }, { catalogId: 'eo-short-week-2018' }], '2026-02-01');
    expect(r.instruments.map((i) => i.id)).toEqual(['eo-travel', 'eo-recuperation', 'eo-short-week-2018']);
    expect(r.travel).toMatchObject({ executable: false, rule: { dailyCapAgorot: 2260 } });
  });
});
