/**
 * Version 1.1.7 — day categories written in an imported report are PROPOSALS: detected by the parser, applied only
 * when the user opts in, never replacing a category already stored, undone together with the import.
 */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver } from '../../data/sqljsDriver';
import { Repository } from '../../data/repo';
import { computeEmployeeMonth } from '../../data/service';
import { defaultEmployeeSettings } from '../../engine';
import { buildImportChanges, buildPreview, detectDayCategory, detectTable, readRecords, type PlanContext } from '..';
import { readCsv } from '../spreadsheet';

const SQL = await initSqlJs();

const CSV = `תאריך,כניסה,יציאה,הערות
11/10/2026,08:00,16:00,
12/10/2026,,,חופשה
13/10/2026,,,מחלה
14/10/2026,,,ערב חג
15/10/2026,08:00,12:00,חצי יום חופשה
`;

function read() {
  const grid = readCsv(new TextEncoder().encode(CSV));
  const det = detectTable(grid);
  return readRecords(grid, det.mapping!, { fallbackYear: 2026 });
}

describe('parser', () => {
  it('detects category words; "ערב חג" and ambiguous rows are not proposals', () => {
    expect(detectDayCategory('חופשה שנתית')).toBe('vacation');
    expect(detectDayCategory('מחלה')).toBe('sick');
    expect(detectDayCategory('חג')).toBe('holiday');
    expect(detectDayCategory('ערב חג')).toBeNull();
    expect(detectDayCategory('חגית כהן')).toBeNull();
    expect(detectDayCategory('יום בחירות')).toBe('election');
    expect(detectDayCategory('חל"ת')).toBe('unpaid');
    expect(detectDayCategory('חופשה / מחלה')).toBeNull();
    expect(detectDayCategory('08:00')).toBeNull();
  });

  it('reads proposals from the report without changing the shift records', () => {
    const r = read();
    expect(r.categoryHints.map((h) => [h.date, h.kind])).toEqual([
      ['2026-10-12', 'vacation'],
      ['2026-10-13', 'sick'],
      ['2026-10-15', 'vacation'],
    ]);
    expect(r.records.map((x) => x.date)).toEqual(['2026-10-11', '2026-10-15']); // same attendance rows as before
  });
});

describe('applying proposals', () => {
  async function setup() {
    const repo = new Repository(await SqlJsDriver.open(SQL, null));
    await repo.migrate();
    const b = await repo.createBusiness({ name: 'עסק', defaults: defaultEmployeeSettings({ breakMethod: 'manual' }) });
    const e = await repo.createEmployee(b.id, { fullName: 'דנה', settings: b.defaults });
    return { repo, b, e };
  }

  it('opt-in only, atomic with the shifts, never replaces an existing category, undo restores everything', async () => {
    const { repo, b, e } = await setup();
    await repo.setDayEntry(b.id, e.id, { date: '2026-10-13', status: 'unpaid', note: 'קיים' });
    const r = read();
    const ctx: PlanContext = { year: 2026, month: 10, existingShifts: [], existingDayStatus: new Map(), gapIsBreak: true };
    const changes = buildImportChanges(buildPreview(r.records, ctx), ctx);

    // Without opting in: shifts only.
    const plain = await setup();
    await plain.repo.applyAttendanceImport(plain.b.id, plain.e.id, changes, {});
    expect(await plain.repo.getDayEntries(plain.b.id, plain.e.id, '2026-10-01', '2026-10-31')).toEqual([]);

    // Opted in (the dialog passes only dates without a category; the repository re-checks inside the batch).
    const dayTypes = r.categoryHints.map((h) => ({ before: null, after: { date: h.date, status: h.kind, note: null } }));
    const written = await repo.applyAttendanceImport(b.id, e.id, { ...changes, dayTypes }, {});
    expect(written.map((w) => w.date)).toEqual(['2026-10-12', '2026-10-15']);
    const entries = await repo.getDayEntries(b.id, e.id, '2026-10-01', '2026-10-31');
    expect(entries.find((x) => x.date === '2026-10-13')).toMatchObject({ status: 'unpaid', note: 'קיים' }); // untouched
    expect(entries.find((x) => x.date === '2026-10-12')?.status).toBe('vacation');
    const month = await computeEmployeeMonth(repo, b.id, e.id, 2026, 10);
    expect(month.totals.netMinutes).toBe(480 + 240); // attendance identical to an import without categories
    expect(month.attendance.vacationDayHundredths).toBe(100); // 15/10: worked + full-day mark → not counted twice, flagged
    expect(month.days.find((d) => d.date === '2026-10-15')!.attendance.basis).toBe('review');

    // Undo the import: shifts and the applied categories go back exactly.
    await repo.applyAttendanceImport(
      b.id,
      e.id,
      { add: [], remove: changes.add, dayTypes: written.map((w) => ({ before: w.after, after: w.before ?? { date: w.date, status: null, note: null, absence: null } })) },
      { undo: true },
    );
    const after = await repo.getDayEntries(b.id, e.id, '2026-10-01', '2026-10-31');
    expect(after).toEqual([{ date: '2026-10-13', status: 'unpaid', note: 'קיים' }]);
    expect(await repo.getShifts(b.id, e.id, '2026-10-01', '2026-10-31')).toEqual([]);
  });
});
