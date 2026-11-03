/**
 * Table detection and row reading. Works on the format-independent Grid, so Excel, CSV and PDF
 * (text or OCR) reports go through exactly the same logic.
 */
import type { LocalDate } from '../engine';
import type { CategoryHint, Cell, ColumnMapping, Detection, Grid, GridSheet, PairMapping, ReadResult, Role, SourceRecord, SourceSegment } from './types';
import {
  cleanText,
  findPeriod,
  headerKey,
  inferDateOrder,
  isSummaryText,
  matchHeader,
  parseBreakCell,
  parseDateCell,
  parseRangeCell,
  parseTimeCell,
  parseTotalCell,
  clockSpan,
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
      range: pick('range'),
      remarks: b.roles.filter((x) => x.role === 'remarks').map((x) => x.col),
    };
    if (grid.format === 'image-ocr' || grid.format === 'pdf-ocr') augmentFromContent(sheet, mapping);
    const reasons: string[] = [];
    if (pairAmbiguous) reasons.push('לא ניתן היה לשייך בוודאות את עמודות הכניסה והיציאה זו לזו.');
    if (!pairs.length && mapping.range == null) reasons.push('לא נמצאו עמודות כניסה/יציאה.');
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

/**
 * OCR tables: column titles are often misread ("הפסקה" → "POY"). Unmapped columns are typed by their CONTENT on dated
 * rows: two clock times per cell → time range; decimal hours → hours; short durations (0:00–4:00) → break.
 */
function augmentFromContent(sheet: GridSheet, mapping: ColumnMapping) {
  const used = new Set<number>([mapping.date, mapping.weekday, mapping.total, mapping.break, mapping.range ?? null, ...mapping.pairs.flatMap((p) => [p.in, p.out])].filter((x): x is number => x !== null));
  const rows = sheet.rows.slice(mapping.headerRow + 1).filter((row) => dateish(row[mapping.date] ?? EMPTY));
  if (!rows.length) return;
  const minFilled = Math.min(3, rows.length);
  const w = width(sheet);
  const kinds = (c: number) => {
    let range = 0;
    let decimal = 0;
    let short = 0;
    let filled = 0;
    for (const row of rows) {
      const t = cleanText(row[c]?.text ?? '');
      if (!t) continue;
      filled++;
      if ((t.match(/\d{1,2}[:.]\d{2}/g) ?? []).length === 2) range++;
      else if (/^\d{1,2}\.\d{2}$/.test(t) && Number(t) <= 24) decimal++;
      else if (/^[0-4]:[0-5]\d$/.test(t)) short++;
    }
    return { range, decimal, short, filled };
  };
  for (let c = 0; c < w; c++) {
    if (used.has(c)) continue;
    const k = kinds(c);
    if (k.filled < minFilled) continue;
    if (mapping.range == null && !mapping.pairs.length && k.range >= k.filled * 0.5) {
      mapping.range = c;
      used.add(c);
    } else if (mapping.total === null && k.decimal >= k.filled * 0.7) {
      mapping.total = c;
      used.add(c);
    } else if (mapping.break === null && k.short >= k.filled * 0.7) {
      mapping.break = c;
      used.add(c);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reading rows
// ---------------------------------------------------------------------------------------------

/** A month total ("178.11" decimal hours, "178:07", or a plain number of hours) → minutes; >24 h allowed. */
function parseMonthTotal(cell: Cell): number | null {
  if (cell.serial !== undefined && !cell.isDateLike) return cell.serial >= 0 && cell.serial < 2000 ? Math.round(cell.serial * 60) : null;
  if (cell.serial !== undefined && cell.isDateLike) return cell.serial < 100 ? Math.round(cell.serial * 1440) : null;
  const t = cleanText(cell.text);
  const hm = /^(\d{1,4}):(\d{2})$/.exec(t);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  if (/^\d{1,4}(\.\d{1,2})?$/.test(t)) return Math.round(Number(t) * 60);
  return null;
}

/** Row confidence: lowest cell confidence; a time range verified against the hours value counts as 80 at least. */
function rowConf(base: number | undefined, range: number | undefined, verified: boolean): number | undefined {
  if (range === undefined) return base;
  const r = verified ? Math.max(range, 80) : range;
  return base === undefined ? r : Math.min(base, r);
}

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

const HEB = '\u0590-\u05FF';
const word = (w: string) => new RegExp(`(^|[^${HEB}])${w}([^${HEB}]|$)`);
const CATEGORY_PATTERNS: [CategoryHint['kind'], RegExp][] = [
  ['unpaid', /חל"?ת|חל״ת|ללא תשלום/],
  ['vacation', /חופש/],
  ['sick', /מחלה/],
  ['election', /בחירות/],
  ['holiday', word('ה?חג')],
];

/**
 * Day category written in a report row ("חופשה", "מחלה", "חג", "בחירות", "חל״ת"). Returns null when none or when the
 * row mentions more than one category (ambiguous). "ערב חג" is not a holiday.
 */
export function detectDayCategory(text: string): CategoryHint['kind'] | null {
  const t = text.replace(/ערב\s+ה?חג/g, ' ');
  const found = CATEGORY_PATTERNS.filter(([, re]) => re.test(t)).map(([k]) => k);
  return found.length === 1 ? found[0] : null;
}

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
  const categoryHints: CategoryHint[] = [];
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
  let lastSummaryTotal: number | null = null;
  let generalTotal: number | null = null;
  let lastSummaryHours: number | null = null;
  let generalTotalHours: number | null = null;
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
    const rowText = row.map((c) => cleanText(c.text)).filter(Boolean).join(' ');
    for (const p of mapping.pairs) {
      const seg = readSegment(cellAt(sheet, r, p.in), cellAt(sheet, r, p.out), order, flags, notes);
      if (seg) segments.push(seg);
    }

    if (!date) {
      if (!nonEmpty.length) continue;
      if (row.slice(0, 6).some((c) => isSummaryText(c.text)) || isSummaryText(dateText)) {
        summaryRows++;
        if (mapping.total !== null) {
          const v = parseMonthTotal(cellAt(sheet, r, mapping.total));
          const label = row.slice(0, 6).map((c) => cleanText(c.text)).find((t) => isSummaryText(t)) ?? dateText;
          if (v !== null) {
            const tc = cellAt(sheet, r, mapping.total);
            const hrs = tc.serial !== undefined && !tc.isDateLike ? tc.serial : /^\d{1,4}\.\d{1,2}$/.test(cleanText(tc.text)) ? Number(cleanText(tc.text)) : null;
            lastSummaryTotal = v;
            lastSummaryHours = hrs;
            if (/כללי|total|grand/i.test(label)) {
              generalTotal = v;
              generalTotalHours = hrs;
            }
          }
        }
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
    let totalMinutes = mapping.total !== null ? parseTotalCell(cellAt(sheet, r, mapping.total)) : null;
    let totalHours: number | undefined;
    if (mapping.total !== null && totalMinutes !== null) {
      const tc = cellAt(sheet, r, mapping.total);
      const tt = cleanText(tc.text);
      if (tc.serial !== undefined && !tc.isDateLike) totalHours = tc.serial;
      else if (/^\d{1,2}\.\d{1,2}$/.test(tt)) totalHours = Number(tt);
    }

    // Explicit exit date column (rare): attach to the last segment's exit.
    if (mapping.exitDate !== null && segments.length) {
      const ed = parseDateCell(cellAt(sheet, r, mapping.exitDate), order, fallbackYear);
      if (ed) segments[segments.length - 1].endDate = ed;
    }

    const employeeCell = mapping.employee !== null ? cleanText(cellAt(sheet, r, mapping.employee).text) : '';
    const kind = detectDayCategory(employeeCell ? rowText.replace(employeeCell, ' ') : rowText);
    if (kind) {
      const hint: CategoryHint = {
        date: date as LocalDate,
        kind,
        text: rowText.slice(0, 80),
        employee: mapping.employee !== null ? employeeCell || null : meta?.employee ?? null,
        employeeNo: mapping.employeeNo !== null ? cleanText(cellAt(sheet, r, mapping.employeeNo).text) || null : meta?.employeeNo ?? null,
      };
      if (!categoryHints.some((h) => h.date === hint.date && h.employee === hint.employee && h.employeeNo === hint.employeeNo)) categoryHints.push(hint);
    }

    let rangeConf: number | undefined;
    let rangeVerified = false;
    // "Entrance - exit" in one column: which time is the entrance is decided by the row's hours value.
    // OCR may place one of the two times in a neighbouring unlabelled column — those cells are read together.
    if (mapping.range != null) {
      const used = new Set<number>([mapping.date, mapping.weekday, mapping.total, mapping.break, mapping.employee, mapping.employeeNo, mapping.exitDate, ...(mapping.remarks ?? [])].filter((x): x is number => x !== null && x !== undefined));
      for (const p of mapping.pairs) for (const c of [p.in, p.out]) if (c !== null) used.add(c);
      const extra = grid.format === 'image-ocr' || grid.format === 'pdf-ocr' ? row.map((_, c) => c).filter((c) => c !== mapping.range && !used.has(c) && /\d/.test(row[c]?.text ?? '')) : [];
      const cells = [mapping.range, ...extra].sort((x, y) => x - y).map((c) => cellAt(sheet, r, c));
      // Reading order of the cells (right-to-left sheets: higher column index first in the source = earlier).
      const parts = cells.flatMap((c) => (c.parts && c.parts.length ? c.parts : c.text ? [c.text] : []));
      const confs = cells.map((c) => c.conf).filter((x): x is number => typeof x === 'number');
      const rg = parseRangeCell({ text: parts.join(' '), parts, conf: confs.length ? Math.min(...confs) : undefined });
      if (rg && 'error' in rg) {
        flags.push(rg.error);
        const one = /(?<![\d.:])(\d{1,2}):(\d{2})(?!\d)/.exec(parts.join(' '));
        if (one && totalMinutes !== null && Number(one[1]) < 24 && Number(one[2]) < 60) {
          const t = Number(one[1]) * 60 + Number(one[2]);
          const f = (m: number) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, '0')}`;
          notes.push(`לפי סה״כ השעות בשורה (${fmtHours(totalMinutes)}) אפשרי ${one[0]}–${f(t + totalMinutes)} או ${f(t - totalMinutes)}–${one[0]} — יש להזין לפי המסמך המקורי`);
        }
      } else if (rg) {
        flags.push(...rg.flags);
        if (totalMinutes === null && rg.hours !== undefined) {
          totalMinutes = rg.hours;
          totalHours = rg.hours / 60;
          notes.push('ערך השעות של השורה נקרא צמוד לטווח השעות');
        }
        const { verified, ...seg } = orderedRange(rg.a, rg.b, totalMinutes, flags, notes);
        segments.push(seg);
        rangeConf = rg && 'a' in rg ? Math.min(...cells.map((c) => c.conf ?? 100)) : undefined;
        // Times and the hours value were read independently; their exact agreement validates the OCR reading.
        const totalConf = mapping.total !== null ? cellAt(sheet, r, mapping.total).conf : undefined;
        if (verified && (totalConf === undefined || totalConf >= 85)) {
          rangeVerified = true;
          if (rangeConf !== undefined && rangeConf < 80) notes.push('שעות שזוהו בביטחון נמוך אומתו מול סה״כ השעות בשורה');
        }
      }
    }
    if (mapping.unorderedPairs && totalMinutes !== null && segments.length === 1 && segments[0].start && segments[0].end) {
      const s0 = segments[0];
      const ordered = orderedRange(s0.start!, s0.end!, totalMinutes, flags, notes);
      segments[0] = { ...s0, start: ordered.start, end: ordered.end };
    }
    checkTotal(segments, breakMinutes, totalMinutes, flags, notes);
    for (const rc of mapping.remarks ?? []) {
      const remark = cleanText(cellAt(sheet, r, rc).text);
      if (!remark) continue;
      if (/\d{1,2}[:.]\d{2}/.test(remark)) flags.push(`בהערות במקור מופיעות שעות שלא נקלטו ("${remark.slice(0, 40)}") — יש לבדוק ולהזין ידנית אם צריך`);
      else notes.push(`הערה במקור: ${remark.slice(0, 60)}`);
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
      ...(totalHours !== undefined ? { totalHours } : {}),
      flags,
      notes,
      conf: rowConf(minConf(usedCells), rangeConf, rangeVerified),
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
  // "סה״כ" is often misread by OCR; a footer line about hours ("שעות", "לעובד") with one number also counts.
  const footerTexts = (sheet.footerText ?? []).filter((l) => /סה["״']?כ|total|שעות|לעובד/i.test(l)).map((l) => (/(\d{1,4}[.:]\d{2})(?!.*\d)/.exec(cleanText(l)) ?? [''])[0]).filter((t) => parseMonthTotal({ text: t }) !== null);
  const footer = footerTexts.length === 1 && empMap.size <= 1 ? footerTexts[0] : null;
  const sourceTotalMinutes = generalTotal ?? lastSummaryTotal ?? (footer ? parseMonthTotal({ text: footer }) : null);
  const sourceTotalHours = generalTotal !== null || lastSummaryTotal !== null ? (generalTotalHours ?? lastSummaryHours) : footer && footer.includes('.') ? Number(footer) : null;
  return { records, categoryHints, summaryRows, emptyDays, unreadableRows, period, employees: [...empMap.values()], sourceTotalMinutes, sourceTotalHours };
}

/**
 * Entrance/exit order of two clock times read from one row. The row's hours value decides: the order whose
 * duration equals it (±1 minute) is used. Without a matching value the reading order is kept and the row flagged.
 * Times are never swapped because of how an RTL page displays them.
 */
function orderedRange(a: string, b: string, total: number | null, flags: string[], notes: string[]): SourceSegment & { verified?: boolean } {
  if (total !== null) {
    const ab = Math.abs(clockSpan(a, b) - total) <= 1;
    const ba = Math.abs(clockSpan(b, a) - total) <= 1;
    if (ab && !ba) return { start: a, end: b, verified: true };
    if (ba && !ab) {
      notes.push(`סדר הכניסה והיציאה נקבע לפי סה״כ השעות בשורה (${b}–${a})`);
      return { start: b, end: a, verified: true };
    }
    if (ab && ba) flags.push('לא ניתן לקבוע מה שעת הכניסה ומה שעת היציאה — יש לבדוק');
    else flags.push(`סה״כ השעות בשורה (${fmtHours(total)}) אינו תואם לשעות ${a}–${b} — יש לבדוק`);
    return { start: a, end: b };
  }
  if (clockSpan(a, b) > 16 * 60) flags.push(`לא ניתן לאמת את סדר השעות ${a}–${b} (אין סה״כ שעות בשורה)`);
  return { start: a, end: b };
}

const fmtHours = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/** Source hours value vs. the recorded times (gross, or gross − explicit break). A mismatch is flagged; never "fixed". */
function checkTotal(segments: SourceSegment[], breakMinutes: number | null, total: number | null, flags: string[], notes: string[]) {
  if (total === null || !segments.length || segments.some((s) => !s.start || !s.end)) return;
  const gross = segments.reduce((sum, s) => {
    if (s.startDate && s.endDate) {
      const d = Math.round((Date.parse(`${s.endDate}T${s.end}:00Z`) - Date.parse(`${s.startDate}T${s.start}:00Z`)) / 60000);
      return sum + d;
    }
    return sum + clockSpan(s.start!, s.end!);
  }, 0);
  if (Math.abs(gross - total) <= 1) return;
  if (breakMinutes !== null && Math.abs(gross - breakMinutes - total) <= 1) return;
  if (flags.some((f) => f.startsWith('סה״כ השעות בשורה'))) return;
  const diff = gross - total;
  // Up to 90 minutes less than the recorded times: most likely a break the source system deducted (information).
  if (diff > 0 && diff <= 90) notes.push(`סה״כ השעות במקור (${fmtHours(total)}) נמוך ממשך הרישומים (${fmtHours(gross)}) — ייתכן שבמקור נוכתה הפסקה; החישוב ייעשה לפי הרישומים`);
  else flags.push(`סה״כ השעות במקור (${fmtHours(total)}) אינו תואם למשך הרישומים (${fmtHours(gross)}) — יש לבדוק`);
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
