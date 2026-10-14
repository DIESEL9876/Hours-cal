/**
 * Database side of the import: atomic writes with audit, cancellation, undo, and — most important —
 * imported attendance must give EXACTLY the same calculation as the same times entered by hand.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver } from '../../data/sqljsDriver';
import { Repository, RepoError } from '../../data/repo';
import { computeEmployeeMonth } from '../../data/service';
import { defaultEmployeeSettings, type ShiftInput } from '../../engine';
import { buildTimestamps } from '../../ui/timeEntry';
import { buildImportChanges, buildPreview, detectTable, readRecords, type PlanContext } from '..';
import { readCsv } from '../spreadsheet';
import { DATA, fixture, readAll, setupNodeEnvironment } from './helpers';

const SQL = await initSqlJs();
beforeAll(setupNodeEnvironment);

async function setup(settings = defaultEmployeeSettings()) {
  const repo = new Repository(await SqlJsDriver.open(SQL, null));
  await repo.migrate();
  const b = await repo.createBusiness({ name: 'משרד בדיקות', defaults: settings });
  const e = await repo.createEmployee(b.id, { fullName: 'דנה לוי', employeeNumber: '1024', settings });
  return { repo, b, e };
}

async function ctxFor(repo: Repository, businessId: string, employeeId: string, gapIsBreak = true): Promise<PlanContext> {
  const existingShifts = await repo.getShifts(businessId, employeeId, '2026-09-01', '2026-09-30');
  return { year: 2026, month: 9, existingShifts, existingDayStatus: new Map(), gapIsBreak };
}

const snapshot = async (repo: Repository, b: string, e: string) => JSON.stringify(await repo.getShifts(b, e, '2000-01-01', '2100-01-01'));

describe('imported data = manually entered data', () => {
  it('the standard Excel report gives exactly the same attendance and overtime as typing the same times', async () => {
    // 1. Import the real fixture.
    const imp = await setup();
    const { read } = await readAll(fixture('he-standard.xlsx'));
    const c = await ctxFor(imp.repo, imp.b.id, imp.e.id);
    const rows = buildPreview(read.records, c).map((r) => ({ ...r, include: r.status === 'ok' || r.status === 'duplicate' || r.status === 'missing_in' || r.status === 'missing_out' ? true : r.include }));
    const changes = buildImportChanges(rows, c);
    await imp.repo.applyAttendanceImport(imp.b.id, imp.e.id, changes, { fileName: 'he-standard.xlsx', month: '2026-09' });

    // 2. Type the same rows by hand (the attendance screen's own path: buildTimestamps + upsertShift).
    const man = await setup();
    for (const [date, start, end, brk] of DATA.heStandard.rows as string[][]) {
      if (!start && !end) continue;
      const ts = buildTimestamps(date, start, end);
      const minutes = brk ? Number(brk.split(':')[0]) * 60 + Number(brk.split(':')[1]) : null;
      const shift: ShiftInput = { id: crypto.randomUUID(), workDate: date, startAt: ts.startAt, endAt: ts.endAt, breakMinutes: minutes, breakStart: null, breakConfirmed: minutes !== null, breakPaid: false, reviewed: false };
      await man.repo.upsertShift(man.b.id, man.e.id, shift);
    }

    const a = await computeEmployeeMonth(imp.repo, imp.b.id, imp.e.id, 2026, 9);
    const m = await computeEmployeeMonth(man.repo, man.b.id, man.e.id, 2026, 9);
    // Everything except the random shift ids must be identical (days, buckets, weeks, totals, warnings).
    const strip = (r: typeof a) => JSON.parse(JSON.stringify(r, (k, v) => (['shiftId', 'id', 'settingsVersionId', 'employeeId'].includes(k) ? '' : v)));
    expect(strip(a)).toEqual(strip(m));
    expect(a.totals.netMinutes).toBeGreaterThan(0);
  });
});

describe('atomic writes and audit', () => {
  it('one batch: shifts + one audit row per shift + an import summary row', async () => {
    const { repo, b, e } = await setup();
    const grid = readCsv(new TextEncoder().encode('תאריך,כניסה,יציאה\n01/09/2026,08:00,17:00\n02/09/2026,08:00,16:00\n'));
    const read = readRecords(grid, detectTable(grid).mapping!, { fallbackYear: 2026 });
    const c = await ctxFor(repo, b.id, e.id);
    const ch = buildImportChanges(buildPreview(read.records, c), c);
    await repo.applyAttendanceImport(b.id, e.id, ch, { fileName: 'x.csv', month: '2026-09', days: 2 });
    expect(await repo.getShifts(b.id, e.id, '2026-09-01', '2026-09-30')).toHaveLength(2);
    const audit = await repo.listAudit(b.id, e.id);
    expect(audit.filter((x) => x.entity === 'shift' && x.action === 'create')).toHaveLength(2);
    const summary = audit.find((x) => x.entity === 'attendance_import')!;
    expect(summary.action).toBe('import');
    expect(summary.after).toMatchObject({ fileName: 'x.csv', month: '2026-09', shiftsAdded: 2, shiftsRemoved: 0 });
  });

  it('if any shift is invalid nothing at all is written', async () => {
    const { repo, b, e } = await setup();
    const before = await snapshot(repo, b.id, e.id);
    const auditBefore = (await repo.listAudit(b.id, e.id)).length;
    const good: ShiftInput = { id: 'g', workDate: '2026-09-01', startAt: '2026-09-01T08:00', endAt: '2026-09-01T17:00', breakMinutes: null, breakStart: null, breakConfirmed: false, breakPaid: false, reviewed: false };
    const bad: ShiftInput = { ...good, id: 'b', workDate: '2026-09-02', startAt: '2026-09-02T17:00', endAt: '2026-09-02T08:00' };
    await expect(repo.applyAttendanceImport(b.id, e.id, { add: [good, bad], remove: [] }, { fileName: 'x' })).rejects.toThrow(RepoError);
    expect(await snapshot(repo, b.id, e.id)).toBe(before);
    expect((await repo.listAudit(b.id, e.id)).length).toBe(auditBefore);
  });

  it('a replaced day removes only the chosen existing shifts; undo restores them exactly', async () => {
    const { repo, b, e } = await setup();
    const old: ShiftInput = { id: 'old', workDate: '2026-09-02', startAt: '2026-09-02T07:00', endAt: '2026-09-02T15:00', breakMinutes: 30, breakStart: null, breakConfirmed: true, breakPaid: false, reviewed: true };
    const keep: ShiftInput = { ...old, id: 'keep', workDate: '2026-09-03', startAt: '2026-09-03T07:00', endAt: '2026-09-03T15:00' };
    await repo.upsertShift(b.id, e.id, old);
    await repo.upsertShift(b.id, e.id, keep);
    const before = await snapshot(repo, b.id, e.id);
    const grid = readCsv(new TextEncoder().encode('תאריך,כניסה,יציאה\n02/09/2026,09:00,18:00\n03/09/2026,10:00,19:00\n'));
    const read = readRecords(grid, detectTable(grid).mapping!, { fallbackYear: 2026 });
    const c = await ctxFor(repo, b.id, e.id);
    const rows = buildPreview(read.records, c).map((r) => (r.date === '2026-09-02' ? { ...r, conflictChoice: 'replace' as const } : r));
    const ch = buildImportChanges(rows, c);
    await repo.applyAttendanceImport(b.id, e.id, ch, { fileName: 'x.csv' });
    const after = await repo.getShifts(b.id, e.id, '2026-09-01', '2026-09-30');
    expect(after.map((s) => `${s.id === 'keep' ? 'keep' : 'new'} ${s.startAt}`).sort()).toEqual(['keep 2026-09-03T07:00', 'new 2026-09-02T09:00']);
    // Undo (as the attendance screen does): remove what was added, put back what was removed.
    await repo.applyAttendanceImport(b.id, e.id, { add: ch.remove, remove: ch.add }, { undo: true });
    const restored = JSON.parse(await snapshot(repo, b.id, e.id)) as { id: string; startAt: string; breakMinutes: number; reviewed: boolean }[];
    expect(restored.map((s) => [s.id, s.startAt, s.breakMinutes, s.reviewed])).toEqual((JSON.parse(before) as typeof restored).map((s) => [s.id, s.startAt, s.breakMinutes, s.reviewed]));
    expect((await repo.listAudit(b.id, e.id)).some((x) => x.entity === 'attendance_import' && x.action === 'import_undo')).toBe(true);
  });
});

describe('cancellation', () => {
  it('reading a file and building the preview never touches the database', async () => {
    const { repo, b, e } = await setup();
    await repo.upsertShift(b.id, e.id, { id: 's', workDate: '2026-09-02', startAt: '2026-09-02T07:00', endAt: '2026-09-02T15:00', breakMinutes: null, breakStart: null, breakConfirmed: false, breakPaid: false, reviewed: false });
    const before = await snapshot(repo, b.id, e.id);
    const audit = (await repo.listAudit(b.id, null)).length;
    for (const f of ['he-standard.xlsx', 'en-two-employees.xlsx', 'multi-punch-1255.csv', 'report-text.pdf']) {
      const { read } = await readAll(fixture(f));
      buildPreview(read.records, await ctxFor(repo, b.id, e.id)); // user then presses "ביטול"
    }
    expect(await snapshot(repo, b.id, e.id)).toBe(before);
    expect((await repo.listAudit(b.id, null)).length).toBe(audit);
  });
});
