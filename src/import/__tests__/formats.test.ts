/**
 * Real files through the real extractors: Excel (xlsx), legacy Excel (xls grid), CSV (Windows-1255),
 * text PDF and scanned PDF (offline OCR). Fixtures are synthetic (scripts/import-fixtures).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readImportFile, ImportError } from '..';
import { gridFromXls } from '../spreadsheet';
import { detectTable, readRecords } from '../analyze';
import { DATA, fixture, readAll, segs, setupNodeEnvironment } from './helpers';

beforeAll(setupNodeEnvironment);

const hm = (s: string) => s; // readability

describe('Standard Israeli Excel report (Hebrew headings, native date/time cells)', () => {
  it('finds the table under title rows, reads every working day, skips empty days and the totals row', async () => {
    const { read, ambiguous } = await readAll(fixture('he-standard.xlsx'));
    expect(ambiguous).toBe(false);
    const expected = (DATA.heStandard.rows as string[][]).filter((r) => r[1] || r[2]);
    expect(read.records.map((r) => r.date)).toEqual(expected.map((r) => r[0]));
    for (const [date, start, end, brk] of expected) {
      const rec = read.records.find((r) => r.date === date)!;
      expect(segs(rec), date).toBe(`${start || '—'}-${end || '—'}`);
      expect(rec.breakMinutes, date).toBe(brk ? Number(brk.split(':')[0]) * 60 + Number(brk.split(':')[1]) : null);
    }
    expect(read.summaryRows).toBe(1);
    expect(read.emptyDays).toBe(30 - expected.length);
    expect(read.records.find((r) => r.date === '2026-09-07')!.segments[0]).toMatchObject({ start: hm('22:00'), end: hm('06:00') });
  });
});

describe('English headings in a different column order, second sheet, two employees', () => {
  it('maps columns by name regardless of order and keeps employees apart', async () => {
    const { read, ambiguous } = await readAll(fixture('en-two-employees.xlsx'));
    expect(ambiguous).toBe(false);
    expect(read.employees.map((e) => e.name).sort()).toEqual(['Avi Cohen', 'Dana Levi']);
    const dana = read.records.filter((r) => r.employee === 'Dana Levi');
    expect(dana.map((r) => `${r.date} ${segs(r)}`)).toEqual([
      '2026-09-01 08:02-17:01',
      '2026-09-02 08:00-17:30', // "5:30 PM"
      '2026-09-03 07:58-16:00',
      '2026-09-03 07:58-16:00', // duplicate row (handled by the planner)
      '2026-09-06 08:00-17:00',
    ]);
    const avi = read.records.filter((r) => r.employee === 'Avi Cohen');
    expect(avi.find((r) => r.date === '2026-09-02')!.segments[0]).toMatchObject({ start: '21:00', end: '05:00' });
    expect(avi.every((r) => r.breakMinutes !== null)).toBe(true);
  });
});

describe('CSV in Windows-1255 with several punches per day', () => {
  it('decodes Hebrew, pairs "כניסה 1/יציאה 1/כניסה 2/יציאה 2", attaches continuation rows', async () => {
    const { read } = await readAll(fixture('multi-punch-1255.csv'));
    const by = (d: string) => read.records.filter((r) => r.date === d).map(segs);
    expect(by('2026-09-01')).toEqual(['08:00-12:00 12:30-17:00']);
    expect(by('2026-09-02')).toEqual(['07:45-16:15']);
    expect(by('2026-09-03')).toEqual(['08:00-11:00 11:45-16:30']);
    expect(by('2026-09-06')).toEqual(['08:00-17:00', '08:00-17:00']);
    expect(by('2026-10-01')).toEqual(['00:00-06:00']);
    expect(read.summaryRows).toBe(1);
  });
});

describe('Legacy Excel (.xls) grid from the desktop reader', () => {
  it('uses native date/time serials and reports a formula without a stored value', async () => {
    // Shape produced by src-tauri/src/import_xls.rs (verified against legacy.xls by the Rust tests).
    const day = (iso: string) => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8)) - Date.UTC(1899, 11, 30)) / 86400000;
    const tm = (h: number, m: number) => (h * 60 + m) / 1440;
    const grid = gridFromXls([
      {
        name: 'נוכחות',
        rows: [
          [{ t: 'דוח שעות' }],
          [{ t: 'שם העובד: שרה גולן' }],
          [],
          [{ t: 'תאריך עבודה' }, { t: 'התחלה' }, { t: 'סיום' }, { t: 'הפסקה (דקות)' }],
          [{ n: day('2026-09-01'), d: true }, { n: tm(8, 0), d: true }, { n: tm(16, 0), d: true }, { n: 30, t: '30' }],
          [{ n: day('2026-09-03'), d: true }, { n: tm(9, 0), d: true }, { f: true }, { n: 30, t: '30' }],
        ],
      },
    ]);
    const det = detectTable(grid);
    const read = readRecords(grid, det.mapping!, { fallbackYear: 2026 });
    expect(read.records.map((r) => `${r.date} ${segs(r)} ${r.breakMinutes}`)).toEqual(['2026-09-01 08:00-16:00 30', '2026-09-03 09:00-— 30']);
    expect(read.records[1].flags.join(' ')).toContain('נוסחה');
    expect(grid.notes.join(' ')).toContain('נוסחה');
  });
  it('without the desktop backend, .xls gives a clear Hebrew message', async () => {
    await expect(readImportFile(fixture('legacy.xls'))).rejects.toThrow(ImportError);
  });
});

describe('Text-based PDF (RTL table, two employees on separate pages)', () => {
  it('rebuilds the table from text positions and detects the employee of each page', async () => {
    const { grid, read, ambiguous } = await readAll(fixture('report-text.pdf'));
    expect(grid.format).toBe('pdf');
    expect(ambiguous).toBe(false);
    expect(read.employees.map((e) => `${e.name}|${e.number}`).sort()).toEqual(['יוסי כהן|2044', 'מיכל אברהם|2051']);
    const yossi = read.records.filter((r) => r.employeeNo === '2044');
    const expected = (DATA.textPdf.pages[0].rows as string[][]).filter((r) => r[1] || r[2]);
    expect(yossi.map((r) => `${r.date} ${segs(r)} ${r.breakMinutes}`)).toEqual(
      expected.map(([d, s, e, b]) => `${d} ${s || '—'}-${e || '—'} ${b ? Number(b.slice(3)) + 60 * Number(b.slice(0, 2)) : null}`),
    );
    // Totals lines are not dated rows: they never become records and do not leak into the last day.
    expect(yossi.find((r) => r.date === '2026-09-10')!.totalMinutes).toBeNull();
    expect(read.period).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
});

describe('Scanned PDF — offline Hebrew OCR', () => {
  it('reads every date and time of an image-only report', async () => {
    const { grid, read } = await readAll(fixture('report-scanned.pdf'));
    expect(grid.format).toBe('pdf-ocr');
    expect(grid.notes.join(' ')).toContain('OCR');
    const expected = DATA.scannedPdf.rows as string[][];
    const got = new Map(read.records.map((r) => [r.date, segs(r)]));
    for (const [d, s, e] of expected) expect(got.get(d), d).toBe(`${s}-${e}`);
    expect(read.records.length).toBe(expected.length);
    expect(read.records.every((r) => typeof r.conf === 'number')).toBe(true);
    expect(read.employees[0]).toMatchObject({ name: 'רונית שמש', number: '3307' });
  }, 180_000);
});

describe('Robustness', () => {
  it('rejects empty, oversized and unsupported files with Hebrew messages', async () => {
    await expect(readImportFile({ name: 'a.xlsx', bytes: new Uint8Array() })).rejects.toThrow('ריק');
    await expect(readImportFile({ name: 'a.docx', bytes: new TextEncoder().encode('hello') })).rejects.toThrow('אינו נתמך');
    await expect(readImportFile({ name: 'a.pdf', bytes: new Uint8Array(21 * 1024 * 1024) })).rejects.toThrow('גדול');
    await expect(readImportFile({ name: 'a.pdf', bytes: new TextEncoder().encode('%PDF-1.7 garbage') })).rejects.toThrow(ImportError);
    await expect(readImportFile({ name: 'a.xlsx', bytes: new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]) })).rejects.toThrow(ImportError);
  });
});
