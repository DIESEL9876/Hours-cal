/**
 * Optional checks against REAL customer samples, which are never stored in the repository.
 * Run locally:  HC_REAL_SAMPLES=/path/to/folder npx vitest run src/import/__tests__/real-samples.test.ts
 * The folder must contain `book.xlsx` (multi-sheet workbook) and/or `photo.png|jpg` (photographed report).
 * Only counts and totals are asserted — no personal data appears in this file.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeWorkbook, buildPreview, detectTable, readImportFile, readRecords, proposeEntries } from '..';
import { setupNodeEnvironment } from './helpers';

const DIR = process.env.HC_REAL_SAMPLES ?? '';
const has = (f: string) => !!DIR && existsSync(join(DIR, f));
const photo = ['photo.png', 'photo.jpg', 'photo.jpeg'].find(has);

beforeAll(setupNodeEnvironment);

describe.skipIf(!has('book.xlsx'))('real multi-sheet workbook', () => {
  it('every worksheet → one employee; declared counts and printed totals match', async () => {
    const grid = await readImportFile({ name: 'book.xlsx', bytes: new Uint8Array(readFileSync(join(DIR, 'book.xlsx'))) });
    const a = analyzeWorkbook(grid, { fallbackYear: 2026 });
    const days = a.employees.reduce((s, e) => s + e.detected.days, 0);
    const shifts = a.employees.reduce((s, e) => s + e.detected.shifts, 0);
    console.log(`sheets ${a.sheetsAnalyzed}, employees ${a.employees.length}, days ${days}, shifts ${shifts}, skipped ${a.skipped.length}, possible duplicates ${a.possibleDuplicates.length}`);
    expect(a.employees.length).toBe(a.sheetsAnalyzed - a.skipped.length);
    for (const e of a.employees) {
      expect(e.name).toBeTruthy();
      expect(e.clockId).toBeTruthy();
      if (e.declared.days !== null) expect(e.detected.days).toBe(e.declared.days);
      if (e.declared.shifts !== null) expect(e.detected.shifts).toBe(e.declared.shifts);
      if (e.sourceTotalMinutes !== null) expect(Math.abs(e.sourceTotalMinutes - e.detected.grossMinutes)).toBeLessThanOrEqual(e.records.length);
    }
    const entries = proposeEntries(a, { existing: [], shiftsOf: () => [], gapIsBreak: true, zeroBreak: 'policy' });
    const unresolved = entries.filter((e) => e.action === null).length;
    const reviewRows = entries.reduce((s, e) => s + e.rows.filter((r) => r.status !== 'ok' && r.status !== 'duplicate').length, 0);
    console.log(`proposed new ${entries.filter((e) => e.action?.kind === 'create').length}, needing a decision ${unresolved}, rows needing review ${reviewRows}`);
  });
});

describe.skipIf(!photo)('real photographed report', () => {
  it('rows recognised, ordered by the hours value, cross-checked with the printed total', async () => {
    const grid = await readImportFile({ name: photo!, bytes: new Uint8Array(readFileSync(join(DIR, photo!))) });
    const det = detectTable(grid);
    const r = readRecords(grid, det.mapping!, { fallbackYear: 2026 });
    const rows = buildPreview(r.records, { year: 2026, month: 10, existingShifts: [], existingDayStatus: new Map(), gapIsBreak: true, zeroBreak: 'policy' });
    const ok = rows.filter((x) => x.status === 'ok').length;
    const review = rows.filter((x) => x.status === 'review').length;
    const unreadable = rows.filter((x) => x.status === 'invalid').length;
    const rowSum = r.records.reduce((s, x) => s + (x.totalMinutes ?? 0), 0);
    console.log(`${grid.notes[1]}\nrows ${rows.length}: ok ${ok}, review ${review}, unreadable ${unreadable}; printed total ${r.sourceTotalMinutes} min, sum of row hours ${rowSum} min`);
    expect(rows.length).toBeGreaterThan(0);
    if (r.sourceTotalMinutes !== null) expect(Math.abs(rowSum - r.sourceTotalMinutes)).toBeLessThanOrEqual(r.records.length);
  }, 300_000);
});
