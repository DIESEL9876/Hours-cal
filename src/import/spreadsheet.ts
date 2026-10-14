/**
 * Spreadsheet extraction (CSV / XLSX / XLS / HTML-table "xls" exports) into the Grid model.
 * Only stored values are read. Formulas are never evaluated and macros/embedded content are never
 * executed; a formula without a stored result is reported as unresolved.
 */
import { ImportError, type Cell, type Grid, type GridSheet } from './types';
import { cleanText } from './values';

export const MAX_ROWS = 5000;
export const MAX_COLS = 80;
export const MAX_SHEETS = 30;

// ---------------------------------------------------------------------------------------------
// Text decoding
// ---------------------------------------------------------------------------------------------

/** UTF-8 (with/without BOM) or UTF-16 (BOM); otherwise Windows-1255 (Hebrew Excel CSV default). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1255').decode(bytes);
  }
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 30);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => splitCsvLine(l, d).length).filter((n) => n > 1);
    if (!counts.length) continue;
    // Prefer the delimiter giving many, consistent columns.
    const mode = counts.sort((a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length)[0];
    const score = counts.filter((n) => n === mode).length * mode;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function splitCsvLine(line: string, d: string): string[] {
  return parseCsv(line, d)[0] ?? [];
}

/** RFC 4180 parser (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') q = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > MAX_ROWS) throw new ImportError(`הקובץ ארוך מדי (יותר מ-${MAX_ROWS} שורות).`);
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readCsv(bytes: Uint8Array): Grid {
  const text = decodeText(bytes);
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter).map((r) => r.slice(0, MAX_COLS).map((v) => ({ text: cleanText(v) }) as Cell));
  return { format: 'csv', sheets: [{ name: 'CSV', rows }], notes: [] };
}

// ---------------------------------------------------------------------------------------------
// XLSX (ExcelJS, values only)
// ---------------------------------------------------------------------------------------------

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const toSerial = (d: Date) => (d.getTime() - EXCEL_EPOCH) / 86400000;

/** Number formats that display dates or times (ignoring quoted literals and colours). */
export function isDateFormat(fmt: string | undefined): boolean {
  if (!fmt || fmt === 'General') return false;
  const f = fmt.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dmyhs]/i.test(f);
}

type XValue = unknown;

function cellFromValue(v: XValue, numFmt: string | undefined): Cell {
  if (v === null || v === undefined) return { text: '' };
  if (v instanceof Date) {
    const serial = toSerial(v);
    return { text: serial < 1 ? '' : v.toISOString().slice(0, 10), serial, isDateLike: true };
  }
  if (typeof v === 'number') return { text: String(v), serial: v, isDateLike: isDateFormat(numFmt) };
  if (typeof v === 'string') return { text: cleanText(v) };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) {
      if (o.result === undefined || o.result === null || (typeof o.result === 'object' && o.result !== null && 'error' in (o.result as object)))
        return { text: '', unresolvedFormula: true };
      return cellFromValue(o.result, numFmt);
    }
    if (Array.isArray(o.richText)) return { text: cleanText((o.richText as { text: string }[]).map((r) => r.text).join('')) };
    if ('text' in o) return { text: cleanText(String(o.text)) };
    if ('error' in o) return { text: String(o.error) };
  }
  return { text: cleanText(String(v)) };
}

export async function readXlsx(bytes: Uint8Array): Promise<Grid> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer);
  } catch {
    throw new ImportError('לא ניתן לקרוא את קובץ ה-Excel (ייתכן שהקובץ פגום או מוגן בסיסמה).');
  }
  const sheets: GridSheet[] = [];
  const notes: string[] = [];
  let unresolved = 0;
  wb.eachSheet((ws) => {
    if (sheets.length >= MAX_SHEETS) return;
    const rows: Cell[][] = [];
    const last = Math.min(ws.rowCount, MAX_ROWS);
    for (let r = 1; r <= last; r++) {
      const row = ws.getRow(r);
      const cells: Cell[] = [];
      const lastCol = Math.min(row.cellCount, MAX_COLS);
      for (let c = 1; c <= lastCol; c++) {
        const cell = row.getCell(c);
        // Merged cells: read the master's value (headers spanning several columns).
        const src = cell.isMerged && cell.master ? cell.master : cell;
        const v = cellFromValue(src.value as XValue, src.numFmt);
        if (v.unresolvedFormula) unresolved++;
        cells.push(v);
      }
      rows.push(cells);
    }
    if (ws.rowCount > MAX_ROWS) notes.push(`בגיליון "${ws.name}" נקראו רק ${MAX_ROWS} השורות הראשונות.`);
    sheets.push({ name: ws.name, rows, rtl: ws.views?.some((v) => (v as { rightToLeft?: boolean }).rightToLeft) ?? false });
  });
  if (unresolved) notes.push(`${unresolved} תאים מכילים נוסחה ללא ערך מחושב שמור. הנוסחאות לא הופעלו; תאים אלה סומנו לבדיקה.`);
  return { format: 'xlsx', sheets, notes };
}

// ---------------------------------------------------------------------------------------------
// HTML table (many systems export "Excel" files that are really HTML)
// ---------------------------------------------------------------------------------------------

export function readHtmlTable(text: string): Grid {
  if (typeof DOMParser === 'undefined') throw new ImportError('לא ניתן לקרוא קובץ זה בסביבה הנוכחית.');
  const doc = new DOMParser().parseFromString(text, 'text/html'); // inert document: scripts never run
  const sheets: GridSheet[] = [];
  doc.querySelectorAll('table').forEach((table, i) => {
    if (sheets.length >= MAX_SHEETS) return;
    const rows: Cell[][] = [];
    table.querySelectorAll('tr').forEach((tr) => {
      if (rows.length >= MAX_ROWS) return;
      const cells: Cell[] = [];
      tr.querySelectorAll('th,td').forEach((td) => {
        const span = Math.min(Number(td.getAttribute('colspan') ?? 1) || 1, 10);
        const t = cleanText(td.textContent ?? '');
        for (let k = 0; k < span && cells.length < MAX_COLS; k++) cells.push({ text: t });
      });
      rows.push(cells);
    });
    sheets.push({ name: `טבלה ${i + 1}`, rows, rtl: (table.getAttribute('dir') ?? doc.documentElement.getAttribute('dir')) === 'rtl' });
  });
  return { format: 'xls', sheets, notes: [] };
}

// ---------------------------------------------------------------------------------------------
// XLS (BIFF) — read by the desktop backend (calamine, Rust); values only.
// ---------------------------------------------------------------------------------------------

export interface RawXlsSheet {
  name: string;
  rows: { t?: string; n?: number; d?: boolean; f?: boolean }[][];
}

export function gridFromXls(sheetsIn: RawXlsSheet[]): Grid {
  let unresolved = 0;
  const sheets = sheetsIn.slice(0, MAX_SHEETS).map((s) => ({
    name: s.name,
    rows: s.rows.slice(0, MAX_ROWS).map((r) =>
      r.slice(0, MAX_COLS).map((c): Cell => {
        if (c.f) {
          unresolved++;
          return { text: '', unresolvedFormula: true };
        }
        if (typeof c.n === 'number') return { text: c.t ?? String(c.n), serial: c.n, isDateLike: !!c.d };
        return { text: cleanText(c.t ?? '') };
      }),
    ),
  }));
  const notes = unresolved ? [`${unresolved} תאים מכילים נוסחה ללא ערך מחושב שמור. הנוסחאות לא הופעלו; תאים אלה סומנו לבדיקה.`] : [];
  return { format: 'xls', sheets, notes };
}
