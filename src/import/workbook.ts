/**
 * Multi-employee workbooks (version 1.1.8): one attendance report per worksheet (or an employee column).
 *
 * Every worksheet goes through the SAME table detection and row reading as a single-employee import; this module
 * only adds per-sheet identity (employee name, clock / employee number, reporting month) and source cross-checks
 * (declared day / shift counts, the sheet's printed total). Source-system overtime, cost and total columns are
 * reference data only — Hours-Cal recalculates everything from the entrance / exit times.
 */
import type { LocalDate } from '../engine';
import { detectTable, readRecords } from './analyze';
import { monthsInRecords } from './plan';
import type { ColumnMapping, Grid, GridSheet, ReadResult, SourceRecord } from './types';
import { cleanText, nameKey } from './values';

export const MAX_WORKBOOK_SHEETS = 100;

export const HEBREW_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const MONTH_ALIASES: Record<string, number> = { מרס: 3, 'מרץ': 3 };

/** One employee's report found in the workbook. */
export interface SheetEmployee {
  /** Stable key within the analysis ("<sheet>" or "<sheet>:<n>" when one sheet holds several employees). */
  key: string;
  sheetIndex: number;
  sheetName: string;
  /** Best name: the explicit "שם עובד" in the sheet, else the sheet title without the month. */
  name: string | null;
  nameSource: 'content' | 'title' | 'table' | null;
  /** Name taken from the sheet title (for cross-checking). */
  titleName: string | null;
  /** Clock / employee identifier printed in the sheet ("מזהה שעון", "מספר עובד"). */
  clockId: string | null;
  /** Reporting month (from the sheet header / title, else the month most dates fall in). */
  year: number | null;
  month: number | null;
  mapping: ColumnMapping;
  read: ReadResult;
  records: SourceRecord[];
  /** Counts printed by the source system ("ימי עבודה: 11", "משמרות: 12"). */
  declared: { days: number | null; shifts: number | null };
  /** The sheet's printed overall total (minutes) — validation reference only. */
  sourceTotalMinutes: number | null;
  /** Detected attendance: days with at least one complete or partial shift, and shifts. */
  detected: { days: number; shifts: number; grossMinutes: number; sumOfRowTotals: number | null };
  /** Problems that need a human decision (Hebrew). */
  issues: string[];
  /** Informational notes (Hebrew). */
  notes: string[];
}

export interface WorkbookAnalysis {
  sheetsAnalyzed: number;
  employees: SheetEmployee[];
  /** Sheets without an attendance table (name + reason). */
  skipped: { sheetName: string; reason: string }[];
  /** Groups of employees that may be the same person (same clock id or same name). */
  possibleDuplicates: string[][];
}

// ---------------------------------------------------------------------------------------------
// Labels printed above the table ("שם עובד: …  חודש: …  מזהה שעון: …")
// ---------------------------------------------------------------------------------------------

const LABELS: [string, RegExp][] = [
  ['name', /שם\s*ה?עובד(?:\/ת)?/],
  ['month', /חודש(?:\s*דיווח)?/],
  ['period', /תקופה|לתקופה/],
  ['clock', /מזהה\s*שעון|מס['׳]?\s*שעון|מספר\s*שעון|קוד\s*שעון/],
  ['number', /מספר\s*עובד|מס['׳]?\s*עובד|מספר\s*אישי/],
  ['days', /ימי\s*עבודה/],
  ['shifts', /משמרות/],
  ['idcard', /ת\.?\s*ז\.?|תעודת\s*זהות/],
  ['dept', /מחלקה|תפקיד|סניף/],
];

/** Splits "שם עובד: דנה לוי חודש: אוקטובר 2026" into labelled values. */
export function labelledValues(text: string): Record<string, string> {
  const t = cleanText(text);
  const hits: { key: string; start: number; end: number }[] = [];
  for (const [key, re] of LABELS) {
    const g = new RegExp(`(${re.source})\\s*:`, 'g');
    for (const m of t.matchAll(g)) hits.push({ key, start: m.index!, end: m.index! + m[0].length });
  }
  hits.sort((a, b) => a.start - b.start);
  const out: Record<string, string> = {};
  hits.forEach((h, i) => {
    const v = cleanText(t.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : t.length));
    if (v && !(h.key in out)) out[h.key] = v;
  });
  return out;
}

/** "אוקטובר 2026" / "10/2026" / "10.26" → { year, month }. */
export function parseMonthText(text: string): { year: number; month: number } | null {
  const t = cleanText(text);
  for (let i = 0; i < 12; i++) {
    const m = new RegExp(`${HEBREW_MONTHS[i]}\\s*(\\d{4}|\\d{2})`).exec(t);
    if (m) return { year: fullYear(Number(m[1])), month: i + 1 };
  }
  for (const [alias, month] of Object.entries(MONTH_ALIASES)) {
    const m = new RegExp(`${alias}\\s*(\\d{4}|\\d{2})`).exec(t);
    if (m) return { year: fullYear(Number(m[1])), month };
  }
  const n = /(?:^|\D)(\d{1,2})[/.\-](\d{4}|\d{2})(?:\D|$)/.exec(t);
  if (n && Number(n[1]) >= 1 && Number(n[1]) <= 12) return { year: fullYear(Number(n[2])), month: Number(n[1]) };
  return null;
}
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

/** Sheet title without the month / year / generic words: "דנה לוי אוקטובר 2026" → "דנה לוי". */
export function nameFromTitle(title: string): string | null {
  let t = cleanText(title);
  for (const m of [...HEBREW_MONTHS, ...Object.keys(MONTH_ALIASES)]) t = t.replace(new RegExp(`${m}\\s*(\\d{4}|\\d{2})?`, 'g'), ' ');
  t = t
    .replace(/\d{1,2}[/.\-]\d{2,4}/g, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/(דו"?ח|דוח|נוכחות|שעות|גיליון|sheet)\d*/gi, ' ')
    .replace(/[-–_()]/g, ' ');
  t = cleanText(t);
  if (!t || /^\d+$/.test(t) || !/\p{L}/u.test(t)) return null;
  return t.length <= 60 ? t : null;
}

const firstNumber = (s: string | undefined) => {
  const m = s ? /\d+/.exec(s) : null;
  return m ? Number(m[0]) : null;
};

/** Distinct texts of the rows above the table header (merged cells repeat their value — counted once). */
function headerTexts(sheet: GridSheet, headerRow: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let r = 0; r < Math.max(0, headerRow); r++) {
    for (const c of sheet.rows[r] ?? []) {
      const t = cleanText(c.text);
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return [...out, ...(sheet.headerText ?? [])];
}

const span = (s: { start: string | null; end: string | null; startDate?: LocalDate | null; endDate?: LocalDate | null }) => {
  if (!s.start || !s.end) return 0;
  if (s.startDate && s.endDate) return Math.round((Date.parse(`${s.endDate}T${s.end}:00Z`) - Date.parse(`${s.startDate}T${s.start}:00Z`)) / 60000);
  const m = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  return (m(s.end) - m(s.start) + 1440) % 1440 || 1440;
};

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

export function analyzeWorkbook(grid: Grid, opts: { fallbackYear: number | null }): WorkbookAnalysis {
  const employees: SheetEmployee[] = [];
  const skipped: { sheetName: string; reason: string }[] = [];
  const sheets = grid.sheets.slice(0, MAX_WORKBOOK_SHEETS);
  sheets.forEach((sheet, sheetIndex) => {
    // Same detection as a single report, restricted to this sheet.
    const single: Grid = { ...grid, sheets: grid.sheets.map((s, i) => (i === sheetIndex ? s : { name: s.name, rows: [] })) };
    const det = detectTable(single);
    if (!det.mapping || det.mapping.sheet !== sheetIndex) {
      skipped.push({ sheetName: sheet.name, reason: 'לא נמצאה טבלת נוכחות עם תאריכים' });
      return;
    }
    const mapping = det.mapping;
    const read = readRecords(single, mapping, opts);
    const texts = headerTexts(sheet, mapping.headerRow);
    const labels: Record<string, string> = {};
    for (const t of texts) for (const [k, v] of Object.entries(labelledValues(t))) if (!(k in labels)) labels[k] = v;
    const titleName = nameFromTitle(sheet.name);
    const titleMonth = parseMonthText(sheet.name);
    const labelMonth = labels.month ? parseMonthText(labels.month) : null;

    // Several employees in one sheet (employee column / per-page names) → one entry each.
    const groups = new Map<string, SourceRecord[]>();
    for (const rec of read.records) {
      const k = read.employees.length > 1 ? `${rec.employee ?? ''}|${rec.employeeNo ?? ''}` : '';
      groups.set(k, [...(groups.get(k) ?? []), rec]);
    }
    if (!read.records.length) groups.set('', []);
    let n = 0;
    for (const [gk, records] of groups) {
      const issues: string[] = [];
      const notes: string[] = [];
      if (det.ambiguous) issues.push(...det.reasons);
      const multi = groups.size > 1;
      const tableName = records.find((r) => r.employee)?.employee ?? null;
      const tableNo = records.find((r) => r.employeeNo)?.employeeNo ?? null;
      let name: string | null = null;
      let nameSource: SheetEmployee['nameSource'] = null;
      if (multi && tableName) [name, nameSource] = [tableName, 'table'];
      else if (labels.name) [name, nameSource] = [cleanText(labels.name), 'content'];
      else if (tableName) [name, nameSource] = [tableName, 'table'];
      else if (titleName) [name, nameSource] = [titleName, 'title'];
      if (!name) issues.push('לא זוהה שם עובד בגיליון — יש להזין שם');
      else if (!multi && titleName && nameSource !== 'title' && nameKey(titleName) !== nameKey(name) && !nameKey(titleName).includes(nameKey(name)))
        issues.push(`השם בכותרת הגיליון ("${titleName}") שונה מהשם בתוך הגיליון ("${name}")`);

      const clockId = (multi ? tableNo : null) ?? (labels.clock ? (/\S+/.exec(labels.clock)?.[0] ?? null) : null) ?? (labels.number ? (/\S+/.exec(labels.number)?.[0] ?? null) : null) ?? tableNo;

      let ym = labelMonth ?? titleMonth;
      if (labelMonth && titleMonth && (labelMonth.year !== titleMonth.year || labelMonth.month !== titleMonth.month))
        issues.push('החודש בכותרת הגיליון שונה מהחודש שבתוך הגיליון');
      const inRecords = monthsInRecords(records);
      if (!ym && inRecords.length) ym = { year: +inRecords[0].ym.slice(0, 4), month: +inRecords[0].ym.slice(5) };
      if (ym) {
        const key = `${ym.year}-${String(ym.month).padStart(2, '0')}`;
        const outside = records.filter((r) => r.date.slice(0, 7) !== key).length;
        if (outside) issues.push(`${outside} שורות בתאריכים מחוץ לחודש הדוח (${String(ym.month).padStart(2, '0')}/${ym.year}) — לא ייקלטו`);
      }

      const dates = new Set<string>();
      let shifts = 0;
      let gross = 0;
      let rowTotals: number | null = null;
      for (const r of records) {
        const segs = r.segments.filter((s) => s.start || s.end);
        if (segs.length) dates.add(r.date);
        shifts += segs.length;
        gross += segs.reduce((a, s) => a + span(s), 0);
        if (r.totalMinutes !== null) rowTotals = (rowTotals ?? 0) + r.totalMinutes;
      }
      const declared = { days: multi ? null : firstNumber(labels.days), shifts: multi ? null : firstNumber(labels.shifts) };
      if (declared.days !== null && declared.days !== dates.size) issues.push(`במקור מצוינים ${declared.days} ימי עבודה; זוהו ${dates.size}`);
      if (declared.shifts !== null && declared.shifts !== shifts) issues.push(`במקור מצוינות ${declared.shifts} משמרות; זוהו ${shifts}`);
      const sourceTotalMinutes = multi ? null : read.sourceTotalMinutes;
      if (sourceTotalMinutes !== null) {
        const ref = rowTotals ?? gross;
        if (Math.abs(ref - sourceTotalMinutes) > Math.max(2, records.length)) issues.push('סה״כ השעות של הגיליון אינו תואם לסכום השורות — יש לבדוק');
        else notes.push('סה״כ השעות של הגיליון תואם לסכום השורות במקור');
      }
      if (!records.length) issues.push('לא נמצאו רישומי נוכחות בגיליון');

      employees.push({
        key: multi ? `${sheetIndex}:${n++}` : String(sheetIndex),
        sheetIndex,
        sheetName: sheet.name,
        name,
        nameSource,
        titleName,
        clockId: clockId || null,
        year: ym?.year ?? null,
        month: ym?.month ?? null,
        mapping,
        read,
        records,
        declared,
        sourceTotalMinutes,
        detected: { days: dates.size, shifts, grossMinutes: gross, sumOfRowTotals: rowTotals },
        issues,
        notes,
      });
      void gk;
    }
  });

  // Possible duplicates: same clock id, or same normalised name, on different sheets.
  const groups = new Map<string, string[]>();
  for (const e of employees) {
    const keys = new Set<string>();
    if (e.clockId) keys.add(`id:${e.clockId}`);
    if (e.name) keys.add(`n:${nameKey(e.name)}`);
    for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), e.key]);
  }
  const seen = new Set<string>();
  const possibleDuplicates: string[][] = [];
  for (const g of groups.values()) {
    const uniq = [...new Set(g)];
    if (uniq.length < 2) continue;
    const sig = [...uniq].sort().join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    possibleDuplicates.push(uniq);
  }
  for (const g of possibleDuplicates)
    for (const k of g) {
      const e = employees.find((x) => x.key === k)!;
      const others = g.filter((x) => x !== k).map((x) => employees.find((y) => y.key === x)!.sheetName);
      e.issues.push(`ייתכן שזה אותו עובד כמו בגיליון "${others.join('", "')}" — יש לבחור מיזוג או שמירה כעובדים נפרדים`);
    }
  return { sheetsAnalyzed: sheets.length, employees, skipped, possibleDuplicates };
}
