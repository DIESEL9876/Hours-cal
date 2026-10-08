import { beforeEach, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver, type SqlJsPersistence } from '../sqljsDriver';
import { Repository, RepoError } from '../repo';
import { computeBusinessMonth, computeEmployeeMonth, sha256Hex, snapshotOf } from '../service';
import { defaultEmployeeSettings } from '../../engine';
import type { BackupInfo } from '../driver';

function memoryPersistence() {
  let main: Uint8Array | null = null;
  const backups = new Map<string, { bytes: Uint8Array; createdAt: string }>();
  const p: SqlJsPersistence & { saves: number } = {
    saves: 0,
    location: 'memory',
    load: async () => main,
    save: async (b) => {
      main = b;
      p.saves++;
    },
    saveBackup: async (n, bytes) => void backups.set(n, { bytes, createdAt: new Date().toISOString() }),
    loadBackup: async (n) => backups.get(n)?.bytes ?? null,
    listBackups: async (): Promise<BackupInfo[]> => [...backups].map(([name, v]) => ({ name, createdAt: v.createdAt, sizeBytes: v.bytes.length })),
  };
  return p;
}

const SQL = await initSqlJs();

async function fresh(persistence: SqlJsPersistence | null = null) {
  const repo = new Repository(await SqlJsDriver.open(SQL, persistence));
  await repo.migrate();
  return repo;
}

const shift = (id: string, date: string, start: string, end: string, extra: Partial<{ breakMinutes: number | null }> = {}) => ({
  id,
  workDate: date,
  startAt: `${date}T${start}`,
  endAt: end <= start ? `${addDay(date)}T${end}` : `${date}T${end}`,
  breakMinutes: extra.breakMinutes ?? 30,
  breakStart: null,
  breakConfirmed: true,
  breakPaid: false,
  reviewed: false,
});
function addDay(d: string) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

describe('migrations', () => {
  it('are idempotent', async () => {
    const repo = await fresh();
    expect(await repo.migrate()).toBe(1);
    expect(await repo.migrate()).toBe(1);
  });
});

describe('businesses', () => {
  let repo: Repository;
  beforeEach(async () => {
    repo = await fresh();
  });
  it('create / list / update / archive with name confirmation', async () => {
    const b = await repo.createBusiness({ name: 'משרד א', identifier: '512345678', defaults: defaultEmployeeSettings() });
    expect((await repo.listBusinesses()).map((x) => x.name)).toEqual(['משרד א']);
    await repo.updateBusiness(b.id, { name: 'משרד א בע"מ' });
    await expect(repo.archiveBusiness(b.id, 'שם שגוי')).rejects.toBeInstanceOf(RepoError);
    expect(await repo.listBusinesses()).toHaveLength(1);
    await repo.archiveBusiness(b.id, 'משרד א בע"מ');
    expect(await repo.listBusinesses()).toHaveLength(0);
    expect(await repo.listBusinesses(true)).toHaveLength(1);
    await repo.restoreBusiness(b.id);
    expect(await repo.listBusinesses()).toHaveLength(1);
  });
  it('rejects empty and duplicate names', async () => {
    await expect(repo.createBusiness({ name: '  ', defaults: defaultEmployeeSettings() })).rejects.toThrow();
    await repo.createBusiness({ name: 'X', defaults: defaultEmployeeSettings() });
    await expect(repo.createBusiness({ name: 'X', defaults: defaultEmployeeSettings() })).rejects.toThrow();
  });
});

describe('employees and business isolation', () => {
  it('keeps businesses fully separated', async () => {
    const repo = await fresh();
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings() });
    const b = await repo.createBusiness({ name: 'B', defaults: defaultEmployeeSettings({ workweek: 'six' }) });
    const ea = await repo.createEmployee(a.id, { fullName: 'ישראל ישראלי', employeeNumber: '1', settings: a.defaults });
    const eb = await repo.createEmployee(b.id, { fullName: 'משה כהן', employeeNumber: '1', settings: b.defaults }); // same number, other business: allowed
    expect((await repo.listEmployees(a.id)).map((e) => e.id)).toEqual([ea.id]);
    expect((await repo.listEmployees(b.id)).map((e) => e.id)).toEqual([eb.id]);
    await expect(repo.getEmployee(b.id, ea.id)).rejects.toThrow();
    await repo.upsertShift(a.id, ea.id, shift('s1', '2026-10-11', '08:00', '18:00'));
    await expect(repo.upsertShift(b.id, ea.id, shift('s2', '2026-10-11', '08:00', '18:00'))).rejects.toThrow();
    expect(await repo.getShifts(b.id, ea.id, '2026-10-01', '2026-10-31')).toHaveLength(0);
    expect(await repo.getShifts(a.id, ea.id, '2026-10-01', '2026-10-31')).toHaveLength(1);
  });
  it('unique employee number inside a business', async () => {
    const repo = await fresh();
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings() });
    await repo.createEmployee(a.id, { fullName: 'א', employeeNumber: '7', settings: a.defaults });
    await expect(repo.createEmployee(a.id, { fullName: 'ב', employeeNumber: '7', settings: a.defaults })).rejects.toThrow('מספר עובד');
  });
  it('employee settings are copied, not linked to business defaults', async () => {
    const repo = await fresh();
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings({ workweek: 'five' }) });
    const e = await repo.createEmployee(a.id, { fullName: 'א', settings: a.defaults });
    await repo.updateBusiness(a.id, { defaults: defaultEmployeeSettings({ workweek: 'six' }) });
    const v = await repo.getSettingsVersions(e.id);
    expect(v[0].settings.workweek).toBe('five');
  });
});

describe('settings history', () => {
  it('new effective date leaves earlier months unchanged; editing an existing version needs authorization', async () => {
    const repo = await fresh();
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings({ breakMethod: 'manual' }) });
    const e = await repo.createEmployee(a.id, { fullName: 'א', settings: a.defaults });
    for (const d of ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'])
      await repo.upsertShift(a.id, e.id, shift(`s${d}`, d, '08:00', '17:00', { breakMinutes: 0 }));
    const octBefore = await computeEmployeeMonth(repo, a.id, e.id, 2026, 10);
    await repo.saveSettingsVersion(a.id, e.id, '2026-11-01', defaultEmployeeSettings({ workweek: 'six', breakMethod: 'manual' }));
    const octAfter = await computeEmployeeMonth(repo, a.id, e.id, 2026, 10);
    expect(octAfter.totals).toEqual(octBefore.totals);
    const v = await repo.getSettingsVersions(e.id);
    await expect(repo.saveSettingsVersion(a.id, e.id, v[0].effectiveFrom, defaultEmployeeSettings({ workweek: 'six' }))).rejects.toThrow('אישור');
    await expect(repo.saveSettingsVersion(a.id, e.id, '2026-09-01', defaultEmployeeSettings())).rejects.toThrow('אישור');
    await repo.saveSettingsVersion(a.id, e.id, v[0].effectiveFrom, defaultEmployeeSettings({ workweek: 'six', breakMethod: 'manual' }), { authorizeRetroactive: true });
    const octRetro = await computeEmployeeMonth(repo, a.id, e.id, 2026, 10);
    expect(octRetro.totals).not.toEqual(octBefore.totals);
    const auditRows = await repo.listAudit(a.id, e.id);
    expect(auditRows.some((r) => r.action === 'update_retroactive')).toBe(true);
  });
});

describe('shifts, day entries and audit', () => {
  it('upsert/delete are audited with before/after and timestamps', async () => {
    const repo = await fresh();
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings() });
    const e = await repo.createEmployee(a.id, { fullName: 'א', settings: a.defaults });
    await repo.upsertShift(a.id, e.id, shift('s1', '2026-10-11', '08:00', '17:00'));
    await repo.upsertShift(a.id, e.id, { ...shift('s1', '2026-10-11', '08:00', '18:00') });
    await repo.deleteShift(a.id, e.id, 's1');
    const log = await repo.listAudit(a.id, e.id);
    const shiftLog = log.filter((l) => l.entity === 'shift').reverse();
    expect(shiftLog.map((l) => l.action)).toEqual(['create', 'update', 'delete']);
    expect((shiftLog[1].before as { endAt: string }).endAt).toBe('2026-10-11T17:00');
    expect((shiftLog[1].after as { endAt: string }).endAt).toBe('2026-10-11T18:00');
    expect(shiftLog.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l.at))).toBe(true);
  });
  it('rejects invalid durations instead of saving them', async () => {
    const repo = await fresh();
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings() });
    const e = await repo.createEmployee(a.id, { fullName: 'א', settings: a.defaults });
    await expect(repo.upsertShift(a.id, e.id, { ...shift('s1', '2026-10-11', '08:00', '17:00'), endAt: '2026-10-11T07:00' })).rejects.toThrow();
    await expect(repo.upsertShift(a.id, e.id, { ...shift('s1', '2026-10-11', '08:00', '17:00'), breakMinutes: -5 })).rejects.toThrow();
    // incomplete rows are allowed (flagged by the engine)
    await repo.upsertShift(a.id, e.id, { ...shift('s2', '2026-10-12', '08:00', '17:00'), endAt: null });
    const r = await computeEmployeeMonth(repo, a.id, e.id, 2026, 10);
    expect(r.totals.incompleteEntries).toBe(1);
  });
  it('day statuses and notes', async () => {
    const repo = await fresh();
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings() });
    const e = await repo.createEmployee(a.id, { fullName: 'א', settings: a.defaults });
    await repo.setDayEntry(a.id, e.id, { date: '2026-10-12', status: 'vacation', note: 'חופשה שנתית' });
    await repo.setDayEntry(a.id, e.id, { date: '2026-10-13', status: null, note: 'הערה בלבד' });
    expect(await repo.getDayEntries(a.id, e.id, '2026-10-01', '2026-10-31')).toHaveLength(2);
    await repo.setDayEntry(a.id, e.id, { date: '2026-10-13', status: null, note: '' });
    expect(await repo.getDayEntries(a.id, e.id, '2026-10-01', '2026-10-31')).toHaveLength(1);
    const r = await computeEmployeeMonth(repo, a.id, e.id, 2026, 10);
    expect(r.days.find((d) => d.date === '2026-10-12')!.status).toBe('vacation');
    expect(r.totals.netMinutes).toBe(0);
  });
});

describe('persistence across restarts and backups', () => {
  it('data and calculated results are stable after reopening', async () => {
    const p = memoryPersistence();
    const repo = await fresh(p);
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings() });
    const e = await repo.createEmployee(a.id, { fullName: 'א', settings: a.defaults });
    await repo.upsertShift(a.id, e.id, shift('s1', '2026-10-11', '08:00', '18:00'));
    const before = await computeBusinessMonth(repo, a.id, 2026, 10);
    const reopened = new Repository(await SqlJsDriver.open(SQL, p));
    await reopened.migrate();
    const after = await computeBusinessMonth(reopened, a.id, 2026, 10);
    expect(snapshotOf(after)).toBe(snapshotOf(before));
    expect(await sha256Hex(snapshotOf(after))).toBe(await sha256Hex(snapshotOf(before)));
  });
  it('backup and restore', async () => {
    const p = memoryPersistence();
    const repo = await fresh(p);
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings() });
    const bk = await repo.driver.createBackup('manual');
    await repo.archiveBusiness(a.id, 'A');
    expect(await repo.listBusinesses()).toHaveLength(0);
    await repo.driver.restoreBackup(bk.name);
    expect(await repo.listBusinesses()).toHaveLength(1);
    const names = (await repo.driver.listBackups()).map((x) => x.name);
    expect(names.some((n) => n.includes('before-restore'))).toBe(true);
  });
  it('a failing batch is rolled back entirely', async () => {
    const repo = await fresh();
    await expect(
      repo.driver.batch([
        { sql: `INSERT INTO app_meta (key, value) VALUES ('a', '1')` },
        { sql: `INSERT INTO no_such_table VALUES (1)` },
      ]),
    ).rejects.toThrow();
    expect(await repo.getMeta('a')).toBeNull();
  });
});

describe('month review', () => {
  it('finalisation snapshot detects later changes', async () => {
    const repo = await fresh();
    const a = await repo.createBusiness({ name: 'A', defaults: defaultEmployeeSettings() });
    const e = await repo.createEmployee(a.id, { fullName: 'א', settings: a.defaults });
    await repo.upsertShift(a.id, e.id, shift('s1', '2026-10-11', '08:00', '18:00'));
    const s1 = await computeBusinessMonth(repo, a.id, 2026, 10);
    const json = snapshotOf(s1);
    await repo.setMonthReview(a.id, '2026-10', 'final', { json, hash: await sha256Hex(json) });
    const rev = await repo.getMonthReview(a.id, '2026-10');
    expect(rev.status).toBe('final');
    expect(rev.finalizedAt).not.toBeNull();
    await repo.upsertShift(a.id, e.id, shift('s1', '2026-10-11', '08:00', '19:00'));
    const s2 = await computeBusinessMonth(repo, a.id, 2026, 10);
    expect(await sha256Hex(snapshotOf(s2))).not.toBe(rev.snapshotHash);
  });
});
