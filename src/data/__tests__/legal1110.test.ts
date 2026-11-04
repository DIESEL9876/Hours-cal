/**
 * 1.1.10 through the database and service layer: additive migration v4 (youth details), validation, and the rule-set
 * versioning that keeps months closed under 1.1.9 unchanged (research pack test 17).
 */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver, type SqlJsPersistence } from '../sqljsDriver';
import { Repository, RepoError } from '../repo';
import { MIGRATIONS, SCHEMA_VERSION } from '../schema';
import { closingRules, computeBusinessMonth, extraEmployeeInput, snapshotOf } from '../service';
import { defaultEmployeeSettings, type ShiftInput } from '../../engine';
import { buildTimestamps } from '../../ui/timeEntry';
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
async function setup(repo: Repository, birthDate: string | null = '2010-01-15') {
  const b = await repo.createBusiness({ name: `עסק ${Math.random()}`, defaults: defaultEmployeeSettings({ breakMethod: 'manual' }) });
  const { fridayOvertimeHistory: _f, weeklyCreditHistory: _w, ...copy } = b.defaults;
  const e = await repo.createEmployee(b.id, { fullName: 'נועה', birthDate, settings: { ...copy, fridayOvertime: 'inherit', travel: { mode: 'inherit' } } });
  return { b, e };
}

describe('additive migration v3 → v4', () => {
  it('existing employees (with birth dates) survive; backup first; youth details empty', async () => {
    const p = memory();
    const v3 = new Repository(await SqlJsDriver.open(SQL, p));
    await v3.driver.batch([{ sql: `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT NOT NULL)` }]);
    for (const m of MIGRATIONS.filter((x) => x.version <= 3))
      await v3.driver.batch([...m.statements.map((sql) => ({ sql })), { sql: `INSERT INTO schema_migrations VALUES (?, ?, 't')`, params: [m.version, m.description] }]);
    await v3.driver.batch([
      { sql: `INSERT INTO businesses (id, name, identifier, defaults_json, created_at, updated_at) VALUES ('b1', 'ישן', NULL, ?, 't', 't')`, params: [JSON.stringify(defaultEmployeeSettings())] },
      { sql: `INSERT INTO employees (id, business_id, full_name, employee_number, notes, birth_date, created_at, updated_at) VALUES ('e1', 'b1', 'נער', '3', NULL, '2010-01-15', 't', 't')` },
    ]);
    const r = new Repository(await SqlJsDriver.open(SQL, p));
    expect(SCHEMA_VERSION).toBe(4);
    expect(await r.migrate()).toBe(4);
    expect((await r.driver.listBackups()).some((x) => x.name.includes('pre-migration'))).toBe(true);
    const [e] = await r.listEmployees('b1');
    expect(e).toMatchObject({ fullName: 'נער', employeeNumber: '3', birthDate: '2010-01-15', youth: null });
  });
});

describe('youth details', () => {
  it('stored per employee, audited with the employee, validated; nothing is inferred', async () => {
    const repo = await open();
    const { b, e } = await setup(repo);
    expect(e.youth).toBeNull();
    const youth = { schooling: 'compulsory' as const, schoolVacations: [{ from: '2026-07-01', to: '2026-08-31' }], nightPermits: [{ reference: 'ה-1', validFrom: '2026-07-01', validTo: '2026-08-31', until: '23:00' }], apprentice: null };
    await repo.updateEmployee(b.id, e.id, { youth });
    expect((await repo.getEmployee(b.id, e.id)).youth).toEqual(youth);
    await expect(repo.updateEmployee(b.id, e.id, { youth: { ...youth, nightPermits: [{ ...youth.nightPermits[0], until: '23' }] } })).rejects.toBeInstanceOf(RepoError);
    await expect(repo.updateEmployee(b.id, e.id, { youth: { ...youth, schoolVacations: [{ from: '2026-08-31', to: '2026-07-01' }] } })).rejects.toBeInstanceOf(RepoError);
    // An apprentice without a document reference is not an apprentice.
    await repo.updateEmployee(b.id, e.id, { youth: { ...youth, apprentice: { reference: '  ' } } });
    expect((await repo.getEmployee(b.id, e.id)).youth?.apprentice).toBeNull();
    // Empty details are stored as nothing.
    await repo.updateEmployee(b.id, e.id, { youth: { schooling: 'unknown', schoolVacations: [], nightPermits: [], apprentice: null } });
    expect((await repo.getEmployee(b.id, e.id)).youth).toBeNull();
  });
});

describe('closed months keep the rule set they were closed with', () => {
  it('a month closed under 1.1.9 is recalculated with Y1; months closed now record Y2', async () => {
    const repo = await open();
    const { b, e } = await setup(repo); // 16 in November 2026, schooling unknown
    await repo.upsertShift(b.id, e.id, shift('2026-11-03', '14:00', '21:00', 45));
    const versions = await repo.getSettingsVersions(e.id);
    const emp = await repo.getEmployee(b.id, e.id);

    const openMonth = await computeBusinessMonth(repo, b.id, 2026, 11);
    expect((await extraEmployeeInput(repo, b.id, emp, versions, '2026-11-01', '2026-11-30')).youthRuleSet).toBe('Y2');
    expect(openMonth.rows[0].result.days.find((d) => d.date === '2026-11-03')!.warnings.map((w) => w.code)).toContain('YOUTH_NIGHT_REVIEW');

    // Closed by 1.1.9: rules_json without a youth rule set.
    await repo.setMonthReview(b.id, '2026-11', 'final', { json: '{}', hash: 'h' }, null, { catalogVersion: '2026.11.03' });
    expect((await extraEmployeeInput(repo, b.id, emp, versions, '2026-11-01', '2026-11-30')).youthRuleSet).toBe('Y1');
    const asClosed = await computeBusinessMonth(repo, b.id, 2026, 11);
    expect(asClosed.rows[0].result.days.find((d) => d.date === '2026-11-03')!.warnings.map((w) => w.code)).not.toContain('YOUTH_NIGHT_REVIEW');
    expect(snapshotOf(asClosed)).not.toBe(snapshotOf(openMonth));

    // Closed by 1.1.10: the rule set and registry version are recorded and used.
    const rules = await closingRules(repo, b.id, 2026, 11);
    expect(rules).toMatchObject({ youthRuleSet: 'Y2', legalRegistryVersion: '2026.11.04', catalogVersion: '2026.11.04' });
    await repo.setMonthReview(b.id, '2026-11', 'final', { json: '{}', hash: 'h' }, null, rules);
    expect(snapshotOf(await computeBusinessMonth(repo, b.id, 2026, 11))).toBe(snapshotOf(openMonth));
  });
});
