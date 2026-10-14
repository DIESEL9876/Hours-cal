/**
 * Table detection and row reading. Works on the format-independent Grid, so Excel, CSV and PDF
 * (text or OCR) reports go through exactly the same logic.
 */
import type { LocalDate } from '../engine';
import type { Cell, ColumnMapping, Detection, Grid, GridSheet, PairMapping, ReadResult, Role, SourceRecord, SourceSegment } from './types';
import {
  cleanText,
  findPeriod,
  headerKey,
  inferDateOrder,
  isSummaryText,
  matchHeader,
  parseBreakCell,
  parseDateCell,
  parseTimeCell,
  parseTotalCell,
  type DateOrder,
  type HeaderMatch,
} from './values';

const HEADER_SCAN_ROWS = 40;
const EMPTY: Cell = { text: '' };

const cellAt = (sheet: GridSheet, r: number, c: number | null): Cell => (c === null || c < 0 ? EMPTY : sheet.rows[r]?.[c] ?? EMPTY);
const width = (sheet: GridSheet) => sheet.rows.reduce((m, r) => Math.max(m, r.length), 0);

interface ColumnRole extends HeaderMatch {
  col: number;
  label: string;
}

/** Roles of one candidate header row (optionally combined with the row above for two-level headers). */
function rolesForRow(sheet: GridSheet, r: number): ColumnRole[] {
  const out: ColumnRole[] = [];
  const w = width(sheet);
  for (let c = 0; c < w; c++) {
    const own = cleanText(cellAt(sheet, r, c).text);
    const above = r > 0 ? cleanText(cellAt(sheet, r - 1, c).text) : '';
    const options = [own, above && own ? `${above} ${own}` : '', above && own ? `${own} ${above}` : ''].filter(Boolean);
    let best: ColumnRole | null = null;
    for (const label of options) {
      const m = matchHeader(label);
      if (m && (!best || m.score > best.score)) best = { ...m, col: c, label: own || label };
    }
    if (best) out.push(best);
  }
  return out;
}

function scoreRoles(roles: ColumnRole[]): number {
  const has = (r: Role) => roles.some((x) => x.role === r);
  if (!has('date')) return 0;
  const timeCols = roles.filter((x) => x.role === 'in' || x.role === 'out' || x.role === 'breakIn' || x.role === 'breakOut').length;
  if (!timeCols && !has('total')) return 0;
  return 5 + timeCols * 3 + (has('total') ? 1 : 0) + (has('break') ? 1 : 0) + (has('weekday') ? 1 : 0) + roles.reduce((s, x) => s + x.score, 0) / 10;
}

/** Pairs entrance/exit columns. Numbered headers ("1 כניסה") pair by number, otherwise by reading order. */
export function buildPairs(roles: ColumnRole[]): { pairs: PairMapping[]; ambiguous: boolean } {
  const ev = roles
    .filter((x) => ['in', 'out', 'breakIn', 'breakOut'].includes(x.role))
    .map((x) => ({ col: x.col, kind: x.role === 'in' || x.role === 'breakIn' ? ('in' as const) : ('out' as const), index: x.index, role: x.role }))
    .sort((a, b) => a.col - b.col);
  const ins = ev.filter((e) => e.kind === 'in');
  const outs = ev.filter((e) => e.kind === 'out');
  if (!ev.length) return { pairs: [], ambiguous: false };
  // Exactly one of each: they form the pair whatever their order.
  if (ins.length === 1 && outs.length === 1) return { pairs: [{ in: ins[0].col, out: outs[0].col }], ambiguous: false };
  // Break-out / break-in columns: [in → breakOut], [breakIn → out].
  const bo = ev.find((e) => e.role === 'breakOut');
  const bi = ev.find((e) => e.role === 'breakIn');
  const plainIn = ev.filter((e) => e.role === 'in');
  const plainOut = ev.filter((e) => e.role === 'out');
  if (bo && bi && plainIn.length === 1 && plainOut.length === 1) {
    return { pairs: [{ in: plainIn[0].col, out: bo.col }, { in: bi.col, out: plainOut[0].col }], ambiguous: false };
  }
  // Numbered headers.
  if (ev.every((e) => e.index !== null)) {
    const byIndex = new Map<number, PairMapping>();
    for (const e of ev) {
      const p = byIndex.get(e.index!) ?? { in: null, out: null };
      if (p[e.kind] !== null) return { pairs: greedy(ev), ambiguous: true };
      p[e.kind] = e.col;
      byIndex.set(e.index!, p);
    }
    const pairs = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    return { pairs, ambiguous: pairs.some((p) => p.in === null || p.out === null) };
  }
  const pairs = greedy(ev);
  return { pairs, ambiguous: pairs.some((p) => p.in === null || p.out === null) };
}

function greedy(ev: { col: number; kind: 'in' | 'out' }[]): PairMapping[] {
  const pairs: PairMapping[] = [];
  let open: number | null = null;
  for (const e of ev) {
    if (e.kind === 'in') {
      if (open !== null) pairs.push({ in: open, out: null });
      open = e.col;
    } else {
      pairs.push({ in: open, out: e.col });
      open = null;
    }
  }
  if (open !== null) pairs.push({ in: open, out: null });
  return pairs;
}

function columnSamples(sheet: GridSheet, fromRow: number, w: number): string[][] {
  const samples: string[][] = Array.from({ length: w }, () => []);
  for (let r = Math.max(0, fromRow); r < sheet.rows.length; r++) {
    for (let c = 0; c < w; c++) {
      const t = cleanText(cellAt(sheet, r, c).text);
      if (t && samples[c].length < 4) samples[c].push(t);
    }
  }
  return samples;
}

function labelsOf(sheet: GridSheet, headerRow: number, w: number): string[] {
  return Array.from({ length: w }, (_, c) => {
    if (headerRow < 0) return `עמודה ${c + 1}`;
    const own = cleanText(cellAt(sheet, headerRow, c).text);
    const above = headerRow > 0 ? cleanText(cellAt(sheet, headerRow - 1, c).text) : '';
    return own || above || `עמודה ${c + 1}`;
  });
}

const dateish = (c: Cell) => !!parseDateCell(c, 'dmy', 2000);
const timeish = (c: Cell) => {
  const v = parseTimeCell(c);
  return !!v && !('error' in v);
};

/** Fallback when no header row is recognised: find the date column and time columns from the data itself. */
function detectFromData(sheet: GridSheet, sheetIndex: number): { mapping: ColumnMapping; ambiguous: boolean } | null {
  const w = width(sheet);
  let dateCol = -1;
  let dateHits = 0;
  for (let c = 0; c < w; c++) {
    let hits = 0;
    let filled = 0;
    for (const row of sheet.rows) {
      const cell = row[c] ?? EMPTY;
      if (!cleanText(cell.text) && cell.serial === undefined) continue;
      filled++;
      if (dateish(cell)) hits++;
    }
    if (hits >= 3 && hits >= filled * 0.5 && hits > dateHits) {
      dateCol = c;
      dateHits = hits;
    }
  }
  if (dateCol < 0) return null;
  const timeCols: number[] = [];
  for (let c = 0; c < w; c++) {
    if (c === dateCol) continue;
    let hits = 0;
    let filled = 0;
    for (const row of sheet.rows) {
      if (!dateish(row[dateCol] ?? EMPTY)) continue;
      const cell = row[c] ?? EMPTY;
      if (!cleanText(cell.text) && cell.serial === undefined) continue;
      filled++;
      if (timeish(cell)) hits++;
    }
    if (hits >= 2 && hits >= filled * 0.6) timeCols.push(c);
  }
  const pairs: PairMapping[] = [];
  for (let i = 0; i + 1 < timeCols.length; i += 2) pairs.push({ in: timeCols[i], out: timeCols[i + 1] });
  const firstDataRow = sheet.rows.findIndex((r) => dateish(r[dateCol] ?? EMPTY));
  return {
    mapping: { sheet: sheetIndex, headerRow: firstDataRow - 1, date: dateCol, exitDate: null, weekday: null, break: null, total: null, employee: null, employeeNo: null, pairs },
    ambiguous: true,
  };
}

/** Finds the attendance table and its columns. */
export function detectTable(grid: Grid): Detection {
  let best: { sheet: number; row: number; roles: ColumnRole[]; score: number } | null = null;
  grid.sheets.forEach((sheet, s) => {
    const limit = Math.min(sheet.rows.length, HEADER_SCAN_ROWS);
    for (let r = 0; r < limit; r++) {
      const roles = rolesForRow(sheet, r);
      const score = scoreRoles(roles);
      if (!score) continue;
      // The table must actually contain dated rows below the header.
      const dated = sheet.rows.slice(r + 1).filter((row) => dateish(row[roles.find((x) => x.role === 'date')!.col] ?? EMPTY)).length;
      if (!dated) continue;
      const total = score + Math.min(dated, 31) / 100;
      if (!best || total > best.score) best = { sheet: s, row: r, roles, score: total };
    }
  });

  if (best) {
    const b = best as { sheet: number; row: number; roles: ColumnRole[]; score: number };
    const sheet = grid.sheets[b.sheet];
    const w = width(sheet);
    const pick = (role: Role) => {
      const cands = b.roles.filter((x) => x.role === role).sort((x, y) => y.score - x.score || x.col - y.col);
      return cands.length ? cands[0].col : null;
    };
    // Choose the date column with the most parseable values when several match.
    const dateCands = b.roles.filter((x) => x.role === 'date');
    const dateCol = dateCands
      .map((x) => ({ col: x.col, n: sheet.rows.slice(b.row + 1).filter((row) => dateish(row[x.col] ?? EMPTY)).length, score: x.score }))
      .sort((x, y) => y.n - x.n || y.score - x.score)[0].col;
    const { pairs, ambiguous: pairAmbiguous } = buildPairs(b.roles);
    const mapping: ColumnMapping = {
      sheet: b.sheet,
      headerRow: b.row,
      date: dateCol,
      exitDate: pick('exitDate'),
      weekday: pick('weekday'),
      break: pick('break'),
      total: pick('total'),
      employee: pick('employee'),
      employeeNo: pick('employeeNo'),
      pairs,
    };
    const reasons: string[] = [];
    if (pairAmbiguous) reasons.push('לא ניתן היה לשייך בוודאות את עמודות הכניסה והיציאה זו לזו.');
    if (!pairs.length) reasons.push('לא נמצאו עמודות כניסה/יציאה.');
    if (b.roles.filter((x) => x.role === 'break').length > 1) reasons.push('נמצאה יותר מעמודת הפסקה אחת.');
    const labels = labelsOf(sheet, b.row, w);
    return {
      mapping,
      columnLabels: labels,
      columnSamples: columnSamples(sheet, b.row + 1, w),
      ambiguous: reasons.length > 0,
      reasons,
      signature: labels.map(headerKey).join('|').slice(0, 600),
    };
  }

  for (let s = 0; s < grid.sheets.length; s++) {
    const found = detectFromData(grid.sheets[s], s);
    if (found) {
      const sheet = grid.sheets[s];
      const w = width(sheet);
      return {
        mapping: found.mapping,
        columnLabels: labelsOf(sheet, -1, w),
        columnSamples: columnSamples(sheet, found.mapping.headerRow + 1, w),
        ambiguous: true,
        reasons: ['לא נמצאה שורת כותרות מוכרת. יש לאשר אילו עמודות מייצגות תאריך, כניסה ויציאה.'],
        signature: null,
      };
    }
  }
  const first = grid.sheets[0];
  const w = first ? width(first) : 0;
  return {
    mapping: null,
    columnLabels: first ? labelsOf(first, -1, w) : [],
    columnSamples: first ? columnSamples(first, 0, w) : [],
    ambiguous: true,
    reasons: ['לא נמצאה בקובץ טבלת נוכחות עם תאריכים.'],
    signature: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading rows
// ---------------------------------------------------------------------------------------------

function minConf(cells: Cell[]): number | undefined {
  const c = cells.map((x) => x.conf).filter((x): x is number => typeof x === 'number');
  return c.length ? Math.min(...c) : undefined;
}

export const MARKED_NOTE = 'שעה מסומנת בכוכבית במקור (ייתכן שתוקנה ידנית במערכת הנוכחות)';

function readSegment(inCell: Cell, outCell: Cell, order: DateOrder, flags: string[], notes: string[]): SourceSegment | null {
  const a = parseTimeCell(inCell, order);
  const b = parseTimeCell(outCell, order);
  if (a && 'error' in a) flags.push(`כניסה: ${a.error}`);
  if (b && 'error' in b) flags.push(`יציאה: ${b.error}`);
  const start = a && !('error' in a) ? a : null;
  const end = b && !('error' in b) ? b : null;
  for (const v of [start, end]) {
    if (!v) continue;
    flags.push(...v.flags);
    if (v.marked && !notes.includes(MARKED_NOTE)) notes.push(MARKED_NOTE);
  }
  const hadText = (a && 'error' in a) || (b && 'error' in b);
  if (!start && !end) return hadText ? { start: null, end: null } : null;
  return { start: start?.time ?? null, end: end?.time ?? null, startDate: start?.date ?? null, endDate: end?.date ?? null };
}

const CONTINUATION_NOTE = 'רישומי כניסה/יציאה נוספים משורות ללא תאריך צורפו לאותו יום';

export interface ReadOptions {
  /** Year to use for dates printed without a year. */
  fallbackYear: number | null;
}

export function readRecords(grid: Grid, mapping: ColumnMapping, opts: ReadOptions): ReadResult {
  const sheet = grid.sheets[mapping.sheet];
  const first = mapping.headerRow + 1;
  const dateValues = sheet.rows.slice(first).map((r) => cleanText((r[mapping.date] ?? EMPTY).text));
  const order = inferDateOrder(dateValues);
  const period = findPeriod(sheet.headerText ?? []);
  const fallbackYear = period ? Number(period.from.slice(0, 4)) : opts.fallbackYear;

  const records: SourceRecord[] = [];
  const newRecord = (date: LocalDate, segments: SourceSegment[], flags: string[]): SourceRecord => ({
    sheet: mapping.sheet,
    row: -1,
    date,
    weekdayText: null,
    employee: null,
    employeeNo: null,
    segments,
    breakMinutes: null,
    totalMinutes: null,
    flags,
    notes: [],
  });
  let summaryRows = 0;
  let emptyDays = 0;
  let unreadableRows = 0;
  /** Last row that carried a date, and the record created for it (if any). */
  let lastDated: { date: LocalDate; record: SourceRecord | null } | null = null;

  for (let r = first; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    const meta = sheet.rowMeta?.[r];
    const dateCell = cellAt(sheet, r, mapping.date);
    const dateText = cleanText(dateCell.text);
    const date = parseDateCell(dateCell, order, fallbackYear);
    const nonEmpty = row.filter((c) => cleanText(c.text) || c.serial !== undefined);

    const flags: string[] = [];
    const notes: string[] = [];
    const segments: SourceSegment[] = [];
    for (const p of mapping.pairs) {
      const seg = readSegment(cellAt(sheet, r, p.in), cellAt(sheet, r, p.out), order, flags, notes);
      if (seg) segments.push(seg);
    }

    if (!date) {
      if (!nonEmpty.length) continue;
      if (row.slice(0, 6).some((c) => isSummaryText(c.text)) || isSummaryText(dateText)) {
        summaryRows++;
        continue;
      }
      // Header repeated on a new page.
      if (matchHeader(dateText)?.role === 'date') continue;
      // Additional punches printed on their own row(s) under the same date.
      const real = segments.filter((s) => s.start || s.end);
      if (!dateText && real.length && lastDated) {
        if (lastDated.record) {
          lastDated.record.segments.push(...real);
          lastDated.record.flags.push(...flags);
          for (const n of notes) if (!lastDated.record.notes.includes(n)) lastDated.record.notes.push(n);
          if (!lastDated.record.notes.includes(CONTINUATION_NOTE)) lastDated.record.notes.push(CONTINUATION_NOTE);
        } else {
          const rec = newRecord(lastDated.date, real, flags);
          rec.notes.push(CONTINUATION_NOTE);
          emptyDays--; // the dated row was counted as empty before its punches appeared below it
          records.push(rec);
          lastDated.record = rec;
        }
        continue;
      }
      if (dateText) unreadableRows++;
      lastDated = null;
      continue;
    }

    let breakMinutes: number | null = null;
    if (mapping.break !== null) {
      const b = parseBreakCell(cellAt(sheet, r, mapping.break));
      if (typeof b === 'number') breakMinutes = b;
      else if (b && 'error' in b) flags.push(b.error);
    }
    const totalMinutes = mapping.total !== null ? parseTotalCell(cellAt(sheet, r, mapping.total)) : null;

    // Explicit exit date column (rare): attach to the last segment's exit.
    if (mapping.exitDate !== null && segments.length) {
      const ed = parseDateCell(cellAt(sheet, r, mapping.exitDate), order, fallbackYear);
      if (ed) segments[segments.length - 1].endDate = ed;
    }

    const realSegments = segments.filter((s) => s.start || s.end);
    if (!realSegments.length && breakMinutes === null && totalMinutes === null && !flags.length) {
      emptyDays++;
      lastDated = { date, record: null };
      continue;
    }

    const usedCells = [dateCell, ...mapping.pairs.flatMap((p) => [cellAt(sheet, r, p.in), cellAt(sheet, r, p.out)])];
    const employee = mapping.employee !== null ? cleanText(cellAt(sheet, r, mapping.employee).text) || null : meta?.employee ?? null;
    const employeeNo = mapping.employeeNo !== null ? cleanText(cellAt(sheet, r, mapping.employeeNo).text) || null : meta?.employeeNo ?? null;
    const rec: SourceRecord = {
      sheet: mapping.sheet,
      row: r,
      page: meta?.page,
      date: date as LocalDate,
      weekdayText: mapping.weekday !== null ? cleanText(cellAt(sheet, r, mapping.weekday).text) || null : null,
      employee,
      employeeNo,
      segments: realSegments,
      breakMinutes,
      totalMinutes,
      flags,
      notes,
      conf: minConf(usedCells),
    };
    records.push(rec);
    lastDated = { date, record: rec };
  }

  const empMap = new Map<string, { name: string | null; number: string | null; rows: number }>();
  for (const rec of records) {
    const key = `${rec.employee ?? ''}|${rec.employeeNo ?? ''}`;
    const e = empMap.get(key) ?? { name: rec.employee, number: rec.employeeNo, rows: 0 };
    e.rows++;
    empMap.set(key, e);
  }
  return { records, summaryRows, emptyDays, unreadableRows, period, employees: [...empMap.values()] };
}

/** Builds a mapping from a manual role→column selection made in the mapping UI. */
export function mappingFromSelection(
  base: ColumnMapping | null,
  sheet: number,
  headerRow: number,
  sel: { date: number | null; in: number | null; out: number | null; in2?: number | null; out2?: number | null; break: number | null; employee?: number | null },
): ColumnMapping | null {
  if (sel.date === null || (sel.in === null && sel.out === null)) return null;
  const pairs: PairMapping[] = [{ in: sel.in, out: sel.out }];
  if (sel.in2 != null || sel.out2 != null) pairs.push({ in: sel.in2 ?? null, out: sel.out2 ?? null });
  return {
    sheet,
    headerRow,
    date: sel.date,
    exitDate: base?.exitDate ?? null,
    weekday: base?.weekday ?? null,
    break: sel.break,
    total: base?.total ?? null,
    employee: sel.employee !== undefined ? sel.employee : base?.employee ?? null,
    employeeNo: base?.employeeNo ?? null,
    pairs,
  };
}
