/**
 * Version 1.1.8 — multi-sheet workbooks: one employee per worksheet, proposals, atomic bulk import, undo.
 * Uses the SYNTHETIC fixture bulk-workbook.xlsx (scripts/import-fixtures/make-workbook.mjs) — no real data.
 */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver } from '../../data/sqljsDriver';
import { Repository, RepoError, type BulkImportInput } from '../../data/repo';
import { computeBusinessMonth, computeEmployeeMonth } from '../../data/service';
import { defaultEmployeeSettings, type ShiftInput } from '../../engine';
import { buildTimestamps } from '../../ui/timeEntry';
import { analyzeWorkbook, blockingProblems, buildBulkChanges, labelledValues, nameFromTitle, parseMonthText, proposeEntries, readImportFile, summarize, type BulkContext } from '..';
import { fixture } from './helpers';

const SQL = await initSqlJs();

async function analysis() {
  const grid = await readImportFile(fixture('bulk-workbook.xlsx'));
  return analyzeWorkbook(grid, { fallbackYear: 2026 });
}

const ctxFor = (_repo?: Repository, existing: BulkContext['existing'] = [], shifts = new Map<string, ShiftInput[]>()): BulkContext => ({
  existing,
  shiftsOf: (id) => shifts.get(id) ?? [],
  gapIsBreak: true,
  zeroBreak: 'policy',
});

describe('labels, titles and months', () => {
  it('reads the labelled values printed above the table', () => {
    expect(labelledValues('שם עובד: דנה לוי חודש: אוקטובר 2026')).toEqual({ name: 'דנה לוי', month: 'אוקטובר 2026' });
    expect(labelledValues('ימי עבודה: 4 משמרות: 5')).toEqual({ days: '4', shifts: '5' });
    expect(labelledValues('מזהה שעון: 7')).toEqual({ clock: '7' });
    expect(nameFromTitle('דנה לוי אוקטובר 2026')).toBe('דנה לוי');
    expect(nameFromTitle('דוח נוכחות 10/2026')).toBeNull();
    expect(parseMonthText('אוקטובר 2026')).toEqual({ year: 2026, month: 10 });
    expect(parseMonthText('דוחות נוכחות 10.26')).toEqual({ year: 2026, month: 10 });
  });
});

describe('workbook analysis', () => {
  it('one employee per worksheet, names from the sheet content, clock ids, month, 16 and 20 columns', async () => {
    const a = await analysis();
    expect(a.sheetsAnalyzed).toBe(7);
    expect(a.skipped.map((s) => s.sheetName)).toEqual(['הוראות']);
    expect(a.employees.map((e) => [e.name, e.clockId, e.month, e.detected.days, e.detected.shifts])).toEqual([
      ['דנה לוי', '101', 10, 4, 4],
      ['יוסי כהן', '102', 10, 4, 6], // 20-column sheet: two pairs on two days
      ['מיכל אברהם', '103', 10, 2, 2],
      ['רון שמש', '104', 10, 1, 1],
      ['רון שמש', '104', 10, 1, 1],
      ['נועה ברק', '105', 10, 2, 2],
    ]);
  });

  it('two punch pairs stay two shifts; native datetimes keep the wall-clock time; overnight keeps its exit date', async () => {
    const a = await analysis();
    const yossi = a.employees[1].records.find((r) => r.date === '2026-10-04')!;
    expect(yossi.segments.map((s) => `${s.start}-${s.end}`)).toEqual(['08:48-10:00', '15:00-20:00']);
    const michal = a.employees[2].records.find((r) => r.date === '2026-10-05')!;
    expect(michal.segments[0]).toMatchObject({ start: '22:00', end: '06:00', endDate: '2026-10-06' });
  });

  it('summary rows and the repeated header are not workdays; source totals and counts are cross-checked', async () => {
    const a = await analysis();
    for (const e of a.employees) {
      expect(e.records.every((r) => /^2026-10-\d\d$/.test(r.date))).toBe(true);
      expect(e.read.summaryRows).toBeGreaterThanOrEqual(2);
    }
    expect(a.employees[0].notes).toContain('סה״כ השעות של הגיליון תואם לסכום השורות במקור');
    expect(a.employees[0].sourceTotalMinutes).toBe(a.employees[0].detected.grossMinutes);
    expect(a.employees[5].issues).toContain('במקור מצוינות 3 משמרות; זוהו 2');
    // A time range written in the remarks is flagged, never imported.
    const noa = a.employees[5].records.find((r) => r.date === '2026-10-08')!;
    expect(noa.segments).toHaveLength(1);
    expect(noa.flags.join()).toContain('13:00-16:00');
  });

  it('possible duplicate employees are reported, never merged silently', async () => {
    const a = await analysis();
    expect(a.possibleDuplicates).toEqual([['3', '4']]);
    expect(a.employees[3].issues.join()).toContain('ייתכן שזה אותו עובד');
  });
});

describe('proposals', () => {
  it('new business: create for clear sheets, a decision for duplicates; nothing is chosen for ambiguous cases', async () => {
    const a = await analysis();
    const entries = proposeEntries(a, ctxFor());
    expect(entries.map((e) => e.action?.kind ?? null)).toEqual(['create', 'create', 'create', 'create', null, 'create']);
    expect(blockingProblems(entries, [])).toEqual(['רון שמש: יש לבחור פעולה']);
    const s = summarize(a, entries);
    expect(s).toMatchObject({ sheets: 7, employees: 6, proposedNew: 5, existingMatches: 0 });
  });

  it('existing business: id + name → matched; name only → requires a decision; duplicate numbers are blocked', async () => {
    const a = await analysis();
    const existing = [
      { id: 'e1', fullName: 'דנה לוי', employeeNumber: '101' },
      { id: 'e2', fullName: 'יוסי כהן', employeeNumber: null },
      { id: 'e3', fullName: 'אדם אחר', employeeNumber: '103' },
    ];
    const entries = proposeEntries(a, ctxFor(undefined, existing));
    expect(entries[0].action).toEqual({ kind: 'existing', employeeId: 'e1' });
    expect(entries[1].action).toBeNull();
    expect(entries[1].suggestion).toEqual({ employeeId: 'e2', reason: 'name_only' });
    expect(entries[2].action).toBeNull(); // number 103 belongs to someone else
    expect(entries[2].employeeNumber).toBe(''); // never re-used for a new employee
    entries[2].action = { kind: 'create' };
    entries[2].employeeNumber = '103';
    expect(blockingProblems(entries, existing).join()).toContain('מספר העובד 103 כבר קיים');
  });
});

// ---------------------------------------------------------------------------------------------
// Database: atomic bulk import
// ---------------------------------------------------------------------------------------------

async function repo() {
  const r = new Repository(await SqlJsDriver.open(SQL, null));
  await r.migrate();
  return r;
}

const defaults = () => defaultEmployeeSettings({ breakMethod: 'manual', fridayOvertime: 'all_overtime' });

async function approvedPlan() {
  const a = await analysis();
  const entries = proposeEntries(a, ctxFor());
  entries[4].action = { kind: 'merge', into: entries[3].key };
  const { fridayOvertimeHistory: _f, ...copy } = defaults();
  const settings = { ...copy, fridayOvertime: 'inherit' as const, absence: {} };
  return { entries, changes: buildBulkChanges(entries, ctxFor(), settings) };
}

describe('bulk import into a new business', () => {
  it('creates the business, the employees and their shifts in one batch; employees inherit the business defaults', async () => {
    const r = await repo();
    const { changes } = await approvedPlan();
    expect(changes).toHaveLength(5); // merged sheet goes to the first "רון שמש"
    const res = await r.bulkImport({ business: { create: { name: 'עסק מיובא', defaults: defaults() } }, employees: changes, meta: { file: 'bulk-workbook.xlsx' } });
    expect(res.businessCreated).toBe(true);
    const emps = await r.listEmployees(res.businessId);
    expect(emps.map((e) => [e.fullName, e.employeeNumber]).sort()).toEqual([
      ['דנה לוי', '101'],
      ['יוסי כהן', '102'],
      ['מיכל אברהם', '103'],
      ['נועה ברק', '105'],
      ['רון שמש', '104'],
    ]);
    const ron = emps.find((e) => e.fullName === 'רון שמש')!;
    const ronShifts = await r.getShifts(res.businessId, ron.id, '2026-10-01', '2026-10-31');
    expect(ronShifts.map((s) => s.workDate)).toEqual(['2026-10-11', '2026-10-12']); // both sheets, one employee
    const v = await r.getSettingsVersions(emps.find((e) => e.fullName === 'דנה לוי')!.id);
    expect(v[0].settings.fridayOvertime).toBe('inherit');
    // The business-wide summary includes every imported employee immediately.
    const s = await computeBusinessMonth(r, res.businessId, 2026, 10);
    expect(s.rows).toHaveLength(5);
    expect(s.attendanceTotal.actualWorkedMinutes).toBe(s.grandTotal.netMinutes);
  });

  it('imported shifts calculate exactly like the same times typed by hand', async () => {
    const r = await repo();
    const { changes } = await approvedPlan();
    const res = await r.bulkImport({ business: { create: { name: 'עסק א', defaults: defaults() } }, employees: changes, meta: {} });
    const yossiId = res.employees.find((e) => e.fullName === 'יוסי כהן')!.employeeId;
    const imported = await computeEmployeeMonth(r, res.businessId, yossiId, 2026, 10);

    const m = await repo();
    const b = await m.createBusiness({ name: 'ידני', defaults: defaults() });
    const { fridayOvertimeHistory: _f, ...copy } = b.defaults;
    const e = await m.createEmployee(b.id, { fullName: 'יוסי כהן', settings: { ...copy, fridayOvertime: 'inherit', absence: {} } });
    for (const [d, a, z, brk] of [
      ['2026-10-02', '08:06', '17:05', null],
      ['2026-10-04', '08:48', '10:00', 0],
      ['2026-10-04', '15:00', '20:00', 0],
      ['2026-10-16', '11:59', '18:27', null],
      ['2026-10-18', '08:00', '10:00', 0],
      ['2026-10-18', '15:00', '20:00', 0],
    ] as [string, string, string, number | null][]) {
      const ts = buildTimestamps(d, a, z);
      await m.upsertShift(b.id, e.id, { id: crypto.randomUUID(), workDate: d, startAt: ts.startAt, endAt: ts.endAt, breakMinutes: brk, breakStart: null, breakConfirmed: brk !== null, breakPaid: false, reviewed: false });
    }
    const manual = await computeEmployeeMonth(m, b.id, e.id, 2026, 10);
    expect(imported.totals.buckets).toEqual(manual.totals.buckets);
    expect(imported.totals.netMinutes).toBe(manual.totals.netMinutes);
    expect(imported.attendance).toEqual(manual.attendance);
  });

  it('a failing item rolls back everything (no business, no employees, no shifts)', async () => {
    const r = await repo();
    const { changes } = await approvedPlan();
    const bad: BulkImportInput['employees'] = [...changes, { ref: 'x', target: { create: { fullName: 'שגוי', employeeNumber: '101', settings: defaults() } }, add: [], remove: [] }];
    await expect(r.bulkImport({ business: { create: { name: 'עסק נכשל', defaults: defaults() } }, employees: bad, meta: {} })).rejects.toBeInstanceOf(RepoError);
    expect(await r.listBusinesses()).toHaveLength(0);
    // SQL-level failure inside the batch is rolled back too.
    const broken = [...changes];
    broken[0] = { ...broken[0], add: [...broken[0].add, { ...broken[0].add[0] }] }; // duplicate shift id
    await expect(r.bulkImport({ business: { create: { name: 'עסק נכשל 2', defaults: defaults() } }, employees: broken, meta: {} })).rejects.toThrow();
    expect(await r.listBusinesses()).toHaveLength(0);
    expect(await r.driver.select(`SELECT * FROM employees`)).toHaveLength(0);
    expect(await r.driver.select(`SELECT * FROM shifts`)).toHaveLength(0);
  });

  it('cancelling (no approval) writes nothing', async () => {
    const r = await repo();
    await approvedPlan(); // analysis + proposals only
    expect(await r.driver.select(`SELECT * FROM audit_log`)).toHaveLength(0);
    expect(await r.listBusinesses()).toHaveLength(0);
  });

  it('undo removes the created employees and their shifts atomically', async () => {
    const r = await repo();
    const { changes } = await approvedPlan();
    const res = await r.bulkImport({ business: { create: { name: 'עסק ב', defaults: defaults() } }, employees: changes, meta: {} });
    await r.undoBulkImport(res);
    expect(await r.listEmployees(res.businessId)).toHaveLength(0);
    expect(await r.driver.select(`SELECT * FROM shifts`)).toHaveLength(0);
  });
});

describe('bulk import into an existing business', () => {
  it('existing employee: settings untouched, existing dates kept unless replaced, new dates added', async () => {
    const r = await repo();
    const b = await r.createBusiness({ name: 'קיים', defaults: defaults() });
    const dana = await r.createEmployee(b.id, { fullName: 'דנה לוי', employeeNumber: '101', settings: { ...defaultEmployeeSettings({ breakMethod: 'company_auto' }) } });
    const ts = buildTimestamps('2026-10-02', '09:00', '12:00');
    await r.upsertShift(b.id, dana.id, { id: 'keep', workDate: '2026-10-02', startAt: ts.startAt, endAt: ts.endAt, breakMinutes: null, breakStart: null, breakConfirmed: false, breakPaid: false, reviewed: false });
    const settingsBefore = JSON.stringify(await r.getSettingsVersions(dana.id));

    const a = await analysis();
    const existing = [{ id: dana.id, fullName: 'דנה לוי', employeeNumber: '101' }];
    const shifts = new Map([[dana.id, await r.getShifts(b.id, dana.id, '2026-10-01', '2026-10-31')]]);
    const ctx = ctxFor(r, existing, shifts);
    const entries = proposeEntries(a, ctx);
    expect(entries[0].action).toEqual({ kind: 'existing', employeeId: dana.id });
    expect(entries[0].rows.find((x) => x.date === '2026-10-02')!.status).toBe('conflict');
    for (const e of entries.slice(1)) e.include = false;
    const changes = buildBulkChanges(entries, ctx, defaults());
    await r.bulkImport({ business: { id: b.id }, employees: changes, meta: {} });
    const after = await r.getShifts(b.id, dana.id, '2026-10-01', '2026-10-31');
    expect(after.find((s) => s.workDate === '2026-10-02')!.id).toBe('keep'); // not overwritten
    expect(after.map((s) => s.workDate)).toEqual(['2026-10-02', '2026-10-04', '2026-10-21', '2026-10-27']);
    expect(JSON.stringify(await r.getSettingsVersions(dana.id))).toBe(settingsBefore);
    expect(await r.listEmployees(b.id)).toHaveLength(1); // no duplicate employee created
  });
});
