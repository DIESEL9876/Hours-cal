/** Preview statuses, conflict protection and the shifts that an approved import produces. */
import { describe, expect, it } from 'vitest';
import type { ShiftInput } from '../../engine';
import { buildImportChanges, buildPreview, countPreview, detectTable, evaluateRow, monthsInRecords, readRecords, type PlanContext, type PreviewRow } from '..';
import { readCsv } from '../spreadsheet';

const csv = (text: string) => {
  const grid = readCsv(new TextEncoder().encode(text));
  const det = detectTable(grid);
  if (!det.mapping) throw new Error(det.reasons.join(' '));
  return readRecords(grid, det.mapping, { fallbackYear: 2026 });
};

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ year: 2026, month: 9, existingShifts: [], existingDayStatus: new Map(), gapIsBreak: true, ...over });

const preview = (text: string, c: PlanContext = ctx()) => buildPreview(csv(text).records, c);
const row = (rows: PreviewRow[], date: string) => rows.find((r) => r.date === date)!;

const existing = (date: string, start: string, end: string, breakMinutes: number | null = null): ShiftInput => ({
  id: `ex-${date}-${start}`,
  workDate: date,
  startAt: `${date}T${start}`,
  endAt: `${date}T${end}`,
  breakMinutes,
  breakStart: null,
  breakConfirmed: breakMinutes !== null,
  breakPaid: false,
  reviewed: false,
});

describe('statuses', () => {
  it('valid, missing entrance, missing exit; empty days are not in the preview', () => {
    const rows = preview('תאריך,כניסה,יציאה\n01/09/2026,08:00,17:00\n02/09/2026,,17:00\n03/09/2026,08:00,\n04/09/2026,,\n');
    expect(rows.map((r) => [r.date, r.status, r.include])).toEqual([
      ['2026-09-01', 'ok', true],
      ['2026-09-02', 'missing_in', false],
      ['2026-09-03', 'missing_out', false],
    ]);
  });

  it('duplicate rows are imported once', () => {
    const rows = preview('תאריך,כניסה,יציאה\n01/09/2026,08:00,17:00\n01/09/2026,08:00,17:00\n');
    expect(row(rows, '2026-09-01')).toMatchObject({ status: 'duplicate', include: true });
    expect(buildImportChanges(rows, ctx()).add).toHaveLength(1);
  });

  it('overlapping punches are invalid, never merged', () => {
    const rows = preview('תאריך,כניסה 1,יציאה 1,כניסה 2,יציאה 2\n07/09/2026,08:00,12:00,11:30,16:00\n');
    expect(row(rows, '2026-09-07')).toMatchObject({ status: 'invalid', include: false });
  });

  it('total hours without times are never turned into timestamps', () => {
    const rows = preview('תאריך,כניסה,יציאה,סה"כ שעות\n01/09/2026,,,8:30\n');
    expect(row(rows, '2026-09-01')).toMatchObject({ status: 'total_only', include: false });
    expect(buildImportChanges(rows, ctx()).add).toHaveLength(0);
  });

  it('weekday that contradicts the date is flagged (protects against a wrong date format)', () => {
    const rows = preview('תאריך,יום,כניסה,יציאה\n01/09/2026,א,08:00,17:00\n');
    expect(row(rows, '2026-09-01').status).toBe('review');
  });

  it('low OCR confidence is flagged for manual review', () => {
    const recs = csv('תאריך,כניסה,יציאה\n01/09/2026,08:00,17:00\n').records.map((r) => ({ ...r, conf: 55 }));
    const [r] = buildPreview(recs, ctx());
    expect(r).toMatchObject({ status: 'review', include: false });
    expect(r.notes.join(' ')).toContain('OCR');
  });
});

describe('month handling', () => {
  it('dates outside the selected month are shown but never imported', () => {
    const rows = preview('תאריך,כניסה,יציאה\n31/08/2026,08:00,17:00\n01/09/2026,08:00,17:00\n');
    expect(row(rows, '2026-08-31')).toMatchObject({ status: 'out_of_month', include: false });
    expect(buildImportChanges(rows, ctx()).days).toEqual(['2026-09-01']);
  });

  it('a file of another month is recognised (the dialog offers a controlled switch)', () => {
    const recs = csv('תאריך,כניסה,יציאה\n01/10/2026,08:00,17:00\n02/10/2026,08:00,17:00\n').records;
    expect(monthsInRecords(recs)).toEqual([{ ym: '2026-10', days: 2 }]);
    expect(countPreview(buildPreview(recs, ctx())).willImport).toBe(0);
    expect(countPreview(buildPreview(recs, ctx({ month: 10 }))).willImport).toBe(2);
  });
});

describe('overnight shifts', () => {
  it('exit before entrance ends the next day — full timestamps, attributed to the start date', () => {
    const rows = preview('תאריך,כניסה,יציאה\n07/09/2026,22:00,06:00\n');
    const [s] = buildImportChanges(rows, ctx()).add;
    expect(s).toMatchObject({ workDate: '2026-09-07', startAt: '2026-09-07T22:00', endAt: '2026-09-08T06:00' });
  });

  it('a shift split at midnight over two rows becomes one shift with real timestamps', () => {
    const rows = preview('תאריך,כניסה,יציאה\n15/09/2026,22:00,23:59\n16/09/2026,00:00,06:00\n17/09/2026,08:00,16:00\n');
    expect(rows.map((r) => r.date)).toEqual(['2026-09-15', '2026-09-17']);
    const add = buildImportChanges(rows, ctx()).add;
    expect(add[0]).toMatchObject({ workDate: '2026-09-15', startAt: '2026-09-15T22:00', endAt: '2026-09-16T06:00' });
  });
});

describe('breaks — never deducted twice', () => {
  it('explicit break on a single shift is stored as an entered (confirmed) break', () => {
    const [s] = buildImportChanges(preview('תאריך,כניסה,יציאה,הפסקה\n01/09/2026,08:00,17:00,0:45\n'), ctx()).add;
    expect(s).toMatchObject({ breakMinutes: 45, breakConfirmed: true });
  });

  it('no break in the report → employee break policy applies and still needs confirmation', () => {
    const [s] = buildImportChanges(preview('תאריך,כניסה,יציאה\n01/09/2026,08:00,17:00\n'), ctx()).add;
    expect(s).toMatchObject({ breakMinutes: null, breakConfirmed: false });
  });

  it('several punches: the gap is the break, no extra deduction per segment', () => {
    const rows = preview('תאריך,כניסה 1,יציאה 1,כניסה 2,יציאה 2\n01/09/2026,08:00,12:00,12:30,17:00\n');
    expect(row(rows, '2026-09-01').status).toBe('ok');
    const add = buildImportChanges(rows, ctx()).add;
    expect(add.map((s) => [s.startAt, s.endAt, s.breakMinutes])).toEqual([
      ['2026-09-01T08:00', '2026-09-01T12:00', 0],
      ['2026-09-01T12:30', '2026-09-01T17:00', 0],
    ]);
  });

  it('several punches + a reported break equal to the gap → consistent, still no double deduction', () => {
    const rows = preview('תאריך,כניסה 1,יציאה 1,כניסה 2,יציאה 2,הפסקה\n01/09/2026,08:00,12:00,12:30,17:00,30\n');
    expect(row(rows, '2026-09-01').status).toBe('ok');
    expect(buildImportChanges(rows, ctx()).add.every((s) => s.breakMinutes === 0)).toBe(true);
  });

  it('several punches + a different reported break → review', () => {
    const rows = preview('תאריך,כניסה 1,יציאה 1,כניסה 2,יציאה 2,הפסקה\n01/09/2026,08:00,12:00,12:30,17:00,60\n');
    expect(row(rows, '2026-09-01').status).toBe('review');
  });

  it('when the office does not treat the gap as the break, the day is flagged and policy decides', () => {
    const c = ctx({ gapIsBreak: false });
    const rows = preview('תאריך,כניסה 1,יציאה 1,כניסה 2,יציאה 2\n01/09/2026,08:00,12:00,12:30,17:00\n', c);
    expect(row(rows, '2026-09-01').status).toBe('review');
    const r = { ...row(rows, '2026-09-01'), include: true };
    expect(buildImportChanges([r], c).add.every((s) => s.breakMinutes === null && !s.breakConfirmed)).toBe(true);
  });

  it('a break longer than the shift is invalid', () => {
    expect(row(preview('תאריך,כניסה,יציאה,הפסקה\n01/09/2026,08:00,09:00,90\n'), '2026-09-01').status).toBe('invalid');
  });
});

describe('existing data is protected', () => {
  const text = 'תאריך,כניסה,יציאה\n01/09/2026,08:00,17:00\n02/09/2026,09:00,18:00\n03/09/2026,,\n';
  const c = ctx({ existingShifts: [existing('2026-09-01', '08:00', '17:00'), existing('2026-09-02', '07:00', '15:00', 30), existing('2026-09-03', '08:00', '16:00')] });

  it('identical data is skipped, a different value is a conflict that keeps the existing record by default', () => {
    const rows = preview(text, c);
    expect(row(rows, '2026-09-01').status).toBe('identical');
    expect(row(rows, '2026-09-02')).toMatchObject({ status: 'conflict', conflictChoice: 'keep' });
    expect(row(rows, '2026-09-02').existing[0]).toMatchObject({ start: '07:00', end: '15:00' });
    expect(rows.find((r) => r.date === '2026-09-03')).toBeUndefined(); // blank row in the file: existing data untouched
    const ch = buildImportChanges(rows, c);
    expect(ch).toEqual({ add: [], remove: [], days: [] });
  });

  it('explicit replace removes exactly that day’s existing shifts and adds the imported one', () => {
    const rows = preview(text, c).map((r) => (r.date === '2026-09-02' ? { ...r, conflictChoice: 'replace' as const } : r));
    const ch = buildImportChanges(rows, c);
    expect(ch.remove.map((s) => s.id)).toEqual(['ex-2026-09-02-07:00']);
    expect(ch.add.map((s) => [s.startAt, s.endAt])).toEqual([['2026-09-02T09:00', '2026-09-02T18:00']]);
  });
});

describe('editing in the preview', () => {
  it('fixing a missing exit makes the row valid; a bad value makes it invalid', () => {
    const c = ctx();
    const r = row(preview('תאריך,כניסה,יציאה\n03/09/2026,08:00,\n', c), '2026-09-03');
    expect(r.status).toBe('missing_out');
    const fixed = evaluateRow({ ...r, segments: [{ start: '08:00', end: '1630' }], edited: true, include: true }, c);
    expect(fixed).toMatchObject({ status: 'ok', include: true });
    expect(buildImportChanges([fixed], c).add[0]).toMatchObject({ startAt: '2026-09-03T08:00', endAt: '2026-09-03T16:30' });
    expect(evaluateRow({ ...r, segments: [{ start: '08:00', end: '99:00' }], edited: true }, c).status).toBe('invalid');
  });
});
