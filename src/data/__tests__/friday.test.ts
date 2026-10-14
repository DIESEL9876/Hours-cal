/** Friday overtime policy through the real database, service layer, exports and the import path. */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver, type SqlJsPersistence } from '../sqljsDriver';
import { Repository } from '../repo';
import { computeBusinessMonth, computeEmployeeMonth, snapshotOf, sha256Hex } from '../service';
import { defaultEmployeeSettings, formatDecimalHours, formatHM, type EmployeeSettings, type ShiftInput } from '../../engine';
import { businessMonthTable, employeeMonthTable } from '../../export/tables';
import { tableToCsv } from '../../export/exporters';
import { buildImportChanges, buildPreview, detectTable, readRecords } from '../../import';
import { readCsv } from '../../import/spreadsheet';
import { buildTimestamps } from '../../ui/timeEntry';

const SQL = await initSqlJs();
const FRI = '2026-10-16';

function memoryPersistence(): SqlJsPersistence {
  let main: Uint8Array | null = null;
  return {
    location: 'memory',
    load: async () => main,
    save: async (b) => void (main = b),
    saveBackup: async () => undefined,
    loadBackup: async () => null,
    listBackups: async () => [],
  };
}

async function open(p: SqlJsPersistence | null = null) {
  const repo = new Repository(await SqlJsDriver.open(SQL, p));
  await repo.migrate();
  return repo;
}

/** As the screens do it: business defaults from the editor, new employees inherit the Friday setting. */
async function setup(repo: Repository, businessFriday: 'all_overtime' | 'none' | undefined, employee: Partial<EmployeeSettings> = {}) {
  const defaults = defaultEmployeeSettings({ breakMethod: 'manual', ...(businessFriday ? { fridayOvertime: businessFriday } : {}) });
  const b = await repo.createBusiness({ name: `עסק ${Math.random()}`, defaults });
  const { fridayOvertimeHistory: _h, ...copy } = b.defaults;
  const e = await repo.createEmployee(b.id, { fullName: 'דנה לוי', settings: { ...copy, fridayOvertime: 'inherit', ...employee } });
  return { b, e };
}

const shift = (date: string, start: string, end: string, breakMinutes = 0): ShiftInput => {
  const ts = buildTimestamps(date, start, end);
  return { id: crypto.randomUUID(), workDate: date, startAt: ts.startAt, endAt: ts.endAt, breakMinutes, breakStart: null, breakConfirmed: true, breakPaid: false, reviewed: false };
};

const friday = async (repo: Repository, b: string, e: string, y = 2026, m = 10, date = FRI) => (await computeEmployeeMonth(repo, b, e, y, m)).days.find((d) => d.date === date)!.buckets;

describe('business default → employee inheritance / override', () => {
  it('employee inherits "all Friday hours as overtime" from the business', async () => {
    const repo = await open();
    const { b, e } = await setup(repo, 'all_overtime');
    await repo.upsertShift(b.id, e.id, shift(FRI, '08:00', '14:00'));
    expect(await friday(repo, b.id, e.id)).toMatchObject({ regular: 0, ot125: 120, ot150: 240 });
    expect((await repo.getSettingsVersions(e.id))[0].settings.fridayOvertime).toBe('inherit');
  });

  it('employee override wins over the business setting, from its effective date', async () => {
    const repo = await open();
    const { b, e } = await setup(repo, 'all_overtime');
    await repo.upsertShift(b.id, e.id, shift(FRI, '08:00', '14:00'));
    await repo.upsertShift(b.id, e.id, shift('2026-10-23', '08:00', '14:00'));
    const v = (await repo.getSettingsVersions(e.id))[0].settings;
    await repo.saveSettingsVersion(b.id, e.id, '2026-10-20', { ...v, fridayOvertime: 'none' });
    expect((await friday(repo, b.id, e.id)).ot125).toBe(120);
    expect(await friday(repo, b.id, e.id, 2026, 10, '2026-10-23')).toMatchObject({ regular: 360, ot125: 0 });
  });

  it('existing businesses and employees (no setting stored) keep the earlier behaviour', async () => {
    const repo = await open();
    const b = await repo.createBusiness({ name: 'ישן', defaults: defaultEmployeeSettings({ breakMethod: 'manual' }) });
    const e = await repo.createEmployee(b.id, { fullName: 'ותיק', settings: defaultEmployeeSettings({ breakMethod: 'manual' }) });
    await repo.upsertShift(b.id, e.id, shift(FRI, '08:00', '14:00'));
    expect(await friday(repo, b.id, e.id)).toMatchObject({ regular: 360, ot125: 0, ot150: 0 });
    // Saving the business without touching the Friday setting does not add anything to its record.
    const after = await repo.updateBusiness(b.id, { name: 'ישן מעודכן', defaults: b.defaults });
    expect(after.defaults.fridayOvertime).toBeUndefined();
    expect(after.defaults.fridayOvertimeHistory).toBeUndefined();
  });
});

describe('persistence', () => {
  it('business and employee choices survive closing and reopening the database', async () => {
    const p = memoryPersistence();
    const repo = await open(p);
    const { b, e } = await setup(repo, 'all_overtime');
    const e2 = await repo.createEmployee(b.id, { fullName: 'אבי', settings: { ...defaultEmployeeSettings({ breakMethod: 'manual' }), fridayOvertime: 'none' } });
    await repo.upsertShift(b.id, e.id, shift(FRI, '08:00', '14:00'));
    await repo.upsertShift(b.id, e2.id, shift(FRI, '08:00', '14:00'));
    const reopened = await open(p);
    expect((await reopened.getBusiness(b.id)).defaults.fridayOvertime).toBe('all_overtime');
    expect((await reopened.getSettingsVersions(e2.id))[0].settings.fridayOvertime).toBe('none');
    expect((await friday(reopened, b.id, e.id)).ot150).toBe(240);
    expect((await friday(reopened, b.id, e2.id)).regular).toBe(360);
  });
});

describe('finalised months are not recalculated', () => {
  it('changing the business default applies after the last finalised month only', async () => {
    const repo = await open();
    const { b, e } = await setup(repo, 'none');
    await repo.upsertShift(b.id, e.id, shift(FRI, '08:00', '14:00'));
    await repo.upsertShift(b.id, e.id, shift('2026-11-06', '08:00', '14:00'));
    const oct = await computeBusinessMonth(repo, b.id, 2026, 10);
    const json = snapshotOf(oct);
    await repo.setMonthReview(b.id, '2026-10', 'final', { json, hash: await sha256Hex(json) });

    const updated = await repo.updateBusiness(b.id, { defaults: { ...(await repo.getBusiness(b.id)).defaults, fridayOvertime: 'all_overtime' } });
    expect(updated.defaults.fridayOvertimeHistory).toEqual([{ from: '2026-11-01', value: 'all_overtime' }]);
    expect(snapshotOf(await computeBusinessMonth(repo, b.id, 2026, 10))).toBe(json); // October unchanged
    expect(await friday(repo, b.id, e.id, 2026, 11, '2026-11-06')).toMatchObject({ regular: 0, ot125: 120, ot150: 240 });
  });
});

describe('summaries and exports follow the policy', () => {
  it('employee + business monthly totals, decimal hours, CSV/Excel tables', async () => {
    const repo = await open();
    const { b, e } = await setup(repo, 'all_overtime');
    await repo.upsertShift(b.id, e.id, shift(FRI, '08:00', '14:30', 30));
    const emp = await computeEmployeeMonth(repo, b.id, e.id, 2026, 10);
    expect(emp.totals.buckets).toMatchObject({ regular: 0, ot125: 120, ot150: 240 });
    const biz = await computeBusinessMonth(repo, b.id, 2026, 10);
    expect(biz.grandTotal.buckets).toMatchObject({ regular: 0, ot125: 120, ot150: 240 });
    const csvEmp = tableToCsv(employeeMonthTable('דוח', emp));
    const csvBiz = tableToCsv(businessMonthTable('סיכום', biz, false));
    for (const csv of [csvEmp, csvBiz]) {
      expect(csv).toContain(formatHM(120));
      expect(csv).toContain(formatHM(240));
      expect(csv).toContain(formatDecimalHours(240)); // "4.00"
    }
  });
});

describe('imported attendance = manual attendance under the Friday policy', () => {
  it('an imported Friday row produces exactly the same calculation as the typed one', async () => {
    const imp = await open();
    const a = await setup(imp, 'all_overtime');
    const grid = readCsv(new TextEncoder().encode(`תאריך,כניסה,יציאה,הפסקה\n15/10/2026,08:00,17:00,30\n16/10/2026,08:00,14:30,30\n`));
    const read = readRecords(grid, detectTable(grid).mapping!, { fallbackYear: 2026 });
    const ctx = { year: 2026, month: 10, existingShifts: [], existingDayStatus: new Map(), gapIsBreak: true };
    await imp.applyAttendanceImport(a.b.id, a.e.id, buildImportChanges(buildPreview(read.records, ctx), ctx), { fileName: 'x.csv' });

    const man = await open();
    const m = await setup(man, 'all_overtime');
    await man.upsertShift(m.b.id, m.e.id, shift('2026-10-15', '08:00', '17:00', 30));
    await man.upsertShift(m.b.id, m.e.id, shift(FRI, '08:00', '14:30', 30));

    const strip = (r: unknown) => JSON.parse(JSON.stringify(r, (k, v) => (['shiftId', 'id', 'settingsVersionId', 'employeeId'].includes(k) ? '' : v)));
    const ri = await computeEmployeeMonth(imp, a.b.id, a.e.id, 2026, 10);
    const rm = await computeEmployeeMonth(man, m.b.id, m.e.id, 2026, 10);
    expect(strip(ri)).toEqual(strip(rm));
    expect(ri.days.find((d) => d.date === FRI)!.buckets).toMatchObject({ regular: 0, ot125: 120, ot150: 240 });
  });
});
