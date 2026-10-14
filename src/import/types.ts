/**
 * Attendance report import — shared types.
 *
 * Pipeline (all local, nothing leaves the computer):
 *   file → extractor (xlsx / xls / csv / pdf text / pdf OCR) → Grid
 *        → analyze (find the table, map columns, read rows)  → SourceRecord[]
 *        → plan (group by date, compare with existing data, statuses) → PreviewRow[]
 *        → user review & approval → buildImportChanges → one atomic DB batch.
 */
import type { LocalDate } from '../engine';

export type SourceFormat = 'xlsx' | 'xls' | 'csv' | 'pdf' | 'pdf-ocr';

/** One spreadsheet-like cell after extraction. Values are never evaluated (no formulas, no macros). */
export interface Cell {
  /** Display text (trimmed). '' for empty. */
  text: string;
  /** Excel serial (days since 1899-12-30, fraction = time of day) when the source cell was a native date/time/number. */
  serial?: number;
  /** True when the source cell was a date/time-formatted native value. */
  isDateLike?: boolean;
  /** Source cell holds a formula without a stored (evaluated) result. */
  unresolvedFormula?: boolean;
  /** OCR confidence 0..100 (scanned PDFs only). */
  conf?: number;
  /** PDF/OCR cells: the individual text pieces (lines/words) that make up `text`. */
  parts?: string[];
}

export interface GridSheet {
  name: string;
  rows: Cell[][];
  /** Reading direction of the sheet's columns (PDF grids are rebuilt in reading order). */
  rtl?: boolean;
  /** Per-row context (PDF page, employee printed on that page). Same length as rows when present. */
  rowMeta?: { page?: number; employee?: string | null; employeeNo?: string | null }[];
  /** Free text found above/around the table (titles, labels) — used to detect employee name and period. */
  headerText?: string[];
}

export interface Grid {
  format: SourceFormat;
  sheets: GridSheet[];
  /** Non-fatal extraction notes (Hebrew), e.g. pages that needed OCR. */
  notes: string[];
}

export type Role = 'date' | 'exitDate' | 'weekday' | 'in' | 'out' | 'breakOut' | 'breakIn' | 'break' | 'total' | 'employee' | 'employeeNo';

export const ROLE_LABELS: Record<Role, string> = {
  date: 'תאריך',
  exitDate: 'תאריך יציאה',
  weekday: 'יום',
  in: 'כניסה',
  out: 'יציאה',
  breakOut: 'יציאה להפסקה',
  breakIn: 'חזרה מהפסקה',
  break: 'הפסקה',
  total: 'סה״כ שעות',
  employee: 'שם עובד',
  employeeNo: 'מספר עובד',
};

/** Pair of columns forming one work segment (entrance → exit). */
export interface PairMapping {
  in: number | null;
  out: number | null;
}

export interface ColumnMapping {
  sheet: number;
  /** Index of the (last) header row; -1 when the table has no header. */
  headerRow: number;
  date: number;
  exitDate: number | null;
  weekday: number | null;
  break: number | null;
  total: number | null;
  employee: number | null;
  employeeNo: number | null;
  pairs: PairMapping[];
}

export interface Detection {
  mapping: ColumnMapping | null;
  /** Column labels of the chosen sheet (header text or "עמודה N"). */
  columnLabels: string[];
  /** Sample values per column (first non-empty values) for the mapping UI. */
  columnSamples: string[][];
  /** True when the mapping must be confirmed by the user before import. */
  ambiguous: boolean;
  reasons: string[];
  /** Signature of the report format (normalised header labels) — key for remembered mappings. */
  signature: string | null;
}

export interface SourceSegment {
  /** 'HH:MM' or null when missing. */
  start: string | null;
  end: string | null;
  /** Explicit dates when the source cell carried a full date+time. */
  startDate?: LocalDate | null;
  endDate?: LocalDate | null;
}

/** One data row read from the source table. */
export interface SourceRecord {
  /** Sheet + row index in the grid (for traceability). */
  sheet: number;
  row: number;
  page?: number;
  date: LocalDate;
  weekdayText: string | null;
  employee: string | null;
  employeeNo: string | null;
  segments: SourceSegment[];
  /** Explicit break minutes from a break column; null = column empty / absent. */
  breakMinutes: number | null;
  /** Worked total from a totals column (minutes), used only to detect "total without times". */
  totalMinutes: number | null;
  /** Problems that require review (Hebrew). */
  flags: string[];
  /** Informational notes (Hebrew). */
  notes: string[];
  /** Minimum OCR confidence over the row's relevant cells. */
  conf?: number;
}

export interface ReadResult {
  records: SourceRecord[];
  /** Rows recognised as totals / summaries and skipped. */
  summaryRows: number;
  /** Dated rows with no attendance data at all (weekends, holidays, absences). */
  emptyDays: number;
  /** Rows whose date could not be read. */
  unreadableRows: number;
  /** Period printed in the document, when found. */
  period: { from: LocalDate; to: LocalDate } | null;
  /** Distinct employees present in the table / pages. */
  employees: { name: string | null; number: string | null; rows: number }[];
}

export type RowStatus =
  | 'ok'
  | 'review'
  | 'missing_in'
  | 'missing_out'
  | 'duplicate'
  | 'out_of_month'
  | 'conflict'
  | 'identical'
  | 'total_only'
  | 'invalid';

export const STATUS_LABELS: Record<RowStatus, string> = {
  ok: 'תקין',
  review: 'דורש בדיקה',
  missing_in: 'חסרה שעת כניסה',
  missing_out: 'חסרה שעת יציאה',
  duplicate: 'רישום כפול',
  out_of_month: 'תאריך מחוץ לחודש',
  conflict: 'התנגשות עם נתון קיים',
  identical: 'זהה לנתון קיים',
  total_only: 'סה״כ שעות בלבד',
  invalid: 'לא תקין',
};

/** Editable preview segment (times as typed / detected). */
export interface PreviewSegment {
  start: string;
  end: string;
  startDate?: LocalDate | null;
  endDate?: LocalDate | null;
}

export interface ExistingShiftView {
  id: string;
  start: string | null;
  end: string | null;
  overnight: boolean;
  breakMinutes: number | null;
}

/** One date in the import preview. */
export interface PreviewRow {
  date: LocalDate;
  weekdayText: string | null;
  segments: PreviewSegment[];
  /** Explicit break (minutes) for single-segment days; '' = none detected (employee policy applies). */
  breakText: string;
  /** The break value came from the report (not from the employee's break policy). */
  explicitBreak: boolean;
  status: RowStatus;
  notes: string[];
  include: boolean;
  /** For conflicts: keep existing data (default) or replace it with the imported values. */
  conflictChoice: 'keep' | 'replace';
  existing: ExistingShiftView[];
  existingDayStatus: string | null;
  sourceRows: number[];
  conf?: number;
  /** User edited this row in the preview. */
  edited: boolean;
  /** Raw flags from extraction (kept so edits can clear them selectively). */
  sourceFlags: string[];
  totalMinutes: number | null;
}

export interface PreviewCounts {
  recognized: number;
  valid: number;
  invalid: number;
  conflicts: number;
  outOfMonth: number;
  willImport: number;
}

export class ImportError extends Error {}
