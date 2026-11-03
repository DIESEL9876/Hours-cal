/**
 * Version 1.1.8 — image import. Pure parsing rules (RTL ranges, decimal hours, 0:00 breaks, totals) and OCR of
 * SYNTHETIC receipt photos (scripts/import-fixtures/make-images.mjs). The safety rule under test: every imported row is
 * either exactly what the paper says, or it is flagged for review — never a silently wrong time.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildImportChanges, buildPreview, detectTable, readImportFile, readRecords, type Grid, type PlanContext, type SourceRecord } from '..';
import { imageKind } from '../image';
import { findPaper, jpegOrientation, orient, prepareForOcr, rotate, skewAngle, type Gray } from '../imageprep';
import { parseRangeCell, parseTotalCell } from '../values';
import { FIXTURES, fixture, setupNodeEnvironment } from './helpers';

beforeAll(setupNodeEnvironment);

const RECEIPT = JSON.parse(readFileSync(join(FIXTURES, 'receipt.json'), 'utf8')) as { rows: [string, string, string, string][] };
const truth = new Map(RECEIPT.rows.map(([d, , a, b]) => [`20${d.slice(6, 8)}-${d.slice(3, 5)}-${d.slice(0, 2)}`, `${a}-${b}`]));

/** OCR-like grid: RTL receipt columns תאריך | יום | טווח שעות | שעות | הפסקה. */
function ocrGrid(rows: [string, string, string, string][], conf = 95): Grid {
  return {
    format: 'image-ocr',
    notes: [],
    sheets: [
      {
        name: 'תמונה',
        rtl: true,
        rows: [
          [{ text: 'תאריך' }, { text: 'יום' }, { text: 'טווח שעות' }, { text: 'שעות' }, { text: 'POY' }],
          ...rows.map(([d, range, hours, brk]) => [{ text: d, conf }, { text: '' }, { text: range, parts: range.split(' '), conf }, { text: hours, conf }, { text: brk, conf }]),
        ],
        footerText: ['סה"כ שעות לעובד: 15.20'],
      },
    ],
  };
}

const read = (g: Grid) => {
  const det = detectTable(g);
  return readRecords(g, det.mapping!, { fallbackYear: 2026 });
};
const seg = (r: SourceRecord) => r.segments.map((s) => `${s.start}-${s.end}`).join(',');

describe('decimal hours and RTL time ranges', () => {
  it('9.85 is 9 hours 51 minutes — never 9:85', () => {
    expect(parseTotalCell({ text: '9.85' })).toBe(591);
    expect(parseTotalCell({ text: '10.08' })).toBe(605);
    expect(parseTotalCell({ text: '9:51' })).toBe(591);
    expect(parseTotalCell({ text: '6.8', serial: 6.8 })).toBe(408);
  });

  it('entrance/exit order comes from the hours value, not from the visual RTL order', () => {
    const r = read(ocrGrid([
      ['01/10/26', '16:52 07:01', '9.85', '0:00'], // displayed exit-first
      ['02/10/26', '07:05 15:20', '8.25', '0:00'], // displayed entrance-first
      ['15/10/26', '00:13 18:01', '6.20', '0:00'], // overnight 18:01 → 00:13
    ]));
    expect(r.records.map(seg)).toEqual(['07:01-16:52', '07:05-15:20', '18:01-00:13']);
    expect(r.records.every((x) => x.flags.length === 0)).toBe(true);
    expect(r.sourceTotalMinutes).toBe(912); // printed total — a reference only
  });

  it('times that disagree with the hours value are flagged, not corrected', () => {
    const r = read(ocrGrid([
      ['03/10/26', '08:10 23:42', '5.53', '0:00'], // OCR read 18:10 as 08:10
      ['04/10/26', '15:0 07:02', '7.98', '0:00'], // one time unreadable
      ['05/10/26', '14.12 06:58', '7.23', '0:00'], // dot instead of colon
    ]));
    expect(r.records[0].flags.join()).toContain('אינו תואם');
    expect(r.records[1].segments).toEqual([]);
    expect(r.records[1].flags.join()).toContain('לא נקרא במלואו');
    expect(r.records[1].notes.join()).toContain('07:02–15:01'); // a hint for the user, not an imported value
    expect(seg(r.records[2])).toBe('06:58-14:12');
    expect(r.records[2].flags.join()).toContain('נקודה במקום נקודתיים');
  });

  it('range parsing never invents a second time', () => {
    expect(parseRangeCell({ text: '16:52 - 07:01' })).toEqual({ a: '16:52', b: '07:01', flags: [] });
    expect(parseRangeCell({ text: '8.25 07:05 15:20' })).toEqual({ a: '07:05', b: '15:20', flags: [], hours: 495 });
    expect(parseRangeCell({ text: '23:509- 16:30' })).toHaveProperty('error');
  });

  it('low OCR confidence makes the row "review" (not imported by default)', () => {
    const r = read(ocrGrid([['01/10/26', '16:52 07:01', '9.85', '0:00']], 60));
    const ctx: PlanContext = { year: 2026, month: 10, existingShifts: [], existingDayStatus: new Map(), gapIsBreak: true };
    const [row] = buildPreview(r.records, ctx);
    expect(row.status).toBe('review');
    expect(row.include).toBe(false);
  });
});

describe('0:00 breaks printed by the source', () => {
  const r = () => read(ocrGrid([['01/10/26', '16:52 07:01', '9.85', '0:00']]));
  it('default: the employee break policy applies (unconfirmed), as for a missing break', () => {
    const ctx: PlanContext = { year: 2026, month: 10, existingShifts: [], existingDayStatus: new Map(), gapIsBreak: true, zeroBreak: 'policy' };
    const rows = buildPreview(r().records, ctx);
    const ch = buildImportChanges(rows, ctx);
    expect(ch.add[0]).toMatchObject({ breakMinutes: null, breakConfirmed: false });
  });
  it('on request: no break, exactly as printed', () => {
    const ctx: PlanContext = { year: 2026, month: 10, existingShifts: [], existingDayStatus: new Map(), gapIsBreak: true, zeroBreak: 'source' };
    const ch = buildImportChanges(buildPreview(r().records, ctx), ctx);
    expect(ch.add[0]).toMatchObject({ breakMinutes: 0, breakConfirmed: true });
  });
});

describe('image preprocessing', () => {
  const page = (): Gray => {
    // White paper with dark horizontal text lines, on a dark background.
    const w = 400;
    const h = 600;
    const px = new Uint8Array(w * h).fill(40);
    for (let y = 50; y < 550; y++) for (let x = 80; x < 320; x++) px[y * w + x] = 235;
    for (let l = 0; l < 12; l++) for (let y = 80 + l * 38; y < 92 + l * 38; y++) for (let x = 100; x < 300; x++) if ((x >> 3) % 2) px[y * w + x] = 30;
    return { w, h, px };
  };
  it('finds the paper and measures / corrects the tilt', () => {
    const g = page();
    const box = findPaper(g)!.box;
    [80, 50, 320, 550].forEach((v, i) => expect(Math.abs(box[i] - v)).toBeLessThanOrEqual(2));
    const tilted = rotate(g, 4);
    const a = skewAngle(tilted);
    expect(Math.abs(Math.abs(a) - 4)).toBeLessThanOrEqual(0.8);
    expect(Math.abs(skewAngle(rotate(tilted, -a)))).toBeLessThanOrEqual(0.6);
  });
  it('EXIF orientation and quarter turns keep every pixel', () => {
    const g: Gray = { w: 3, h: 2, px: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    expect(orient(g, 6)).toEqual({ w: 2, h: 3, px: new Uint8Array([4, 1, 5, 2, 6, 3]) });
    expect(orient(orient(g, 3), 3)).toEqual(g);
    expect(jpegOrientation(new Uint8Array([0x89, 0x50]))).toBe(1);
  });
  it('rejects HEIC with a clear message and recognises image types by content', async () => {
    const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
    expect(imageKind(heic)).toBe('heic');
    await expect(readImportFile({ name: 'photo.heic', bytes: heic })).rejects.toThrow('HEIC');
    expect(imageKind(fixture('receipt-straight.png').bytes)).toBe('png');
    expect(imageKind(fixture('receipt-rotated.jpg').bytes)).toBe('jpeg');
  });
  it('a photographed page goes through crop/perspective, light and deskew steps', async () => {
    const { nodeImageBackend } = await import('./helpers');
    const d = await nodeImageBackend.decode(fixture('receipt-rotated.jpg').bytes);
    const { toGray } = await import('../imageprep');
    const p = prepareForOcr(toGray(d.rgba, d.w, d.h));
    expect(p.steps.join(' ')).toContain('איזון תאורה');
    expect(p.steps.some((s) => s.startsWith('יישור הטיה') || s.includes('פרספקטיבה'))).toBe(true);
  });
});

describe('OCR of synthetic receipt photos (offline Tesseract)', () => {
  async function ocr(name: string) {
    const grid = await readImportFile(fixture(name));
    expect(grid.format).toBe('image-ocr');
    return { grid, read: read(grid) };
  }
  /** Safety: an unflagged complete row must be exactly the printed one. */
  function checkSafety(records: SourceRecord[]) {
    let correct = 0;
    for (const r of records) {
      const got = seg(r);
      const ok = got === truth.get(r.date);
      if (ok) correct++;
      else expect(r.flags.length > 0 || r.segments.length === 0 || (r.conf ?? 100) < 75, `${r.date}: ${got} imported without a flag`).toBe(true);
    }
    return correct;
  }

  it('straight photo: dates, ordered entrance/exit, decimal hours, printed total', async () => {
    const { read: r } = await ocr('receipt-straight.png');
    expect(r.records).toHaveLength(10);
    expect(checkSafety(r.records)).toBeGreaterThanOrEqual(8);
    expect(r.sourceTotalMinutes).toBe(4443); // 74.05
  }, 180_000);

  it('tilted, perspective and shadowed photo: never a silently wrong row', async () => {
    const { grid, read: r } = await ocr('receipt-rotated.jpg');
    expect(grid.notes.join()).toContain('יישור הטיה');
    expect(r.records.length).toBeGreaterThanOrEqual(9);
    expect(checkSafety(r.records)).toBeGreaterThanOrEqual(4);
  }, 180_000);

  it('a smudged time is not guessed', async () => {
    const { read: r } = await ocr('receipt-smudged.png');
    const smudged = r.records.find((x) => x.date === '2026-11-04')!;
    expect(smudged.segments.length === 0 || smudged.flags.length > 0).toBe(true);
    checkSafety(r.records);
  }, 180_000);
});
