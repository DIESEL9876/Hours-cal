/**
 * Pure tabular representations of reports (shared by XLSX, CSV and tests).
 * Cells hold integer MINUTES for durations (kind 'dur') so each output format renders them exactly.
 */
import {
  dedupeWarnings,
  HEBREW_WEEKDAYS,
  premiumMinutes,
  type BusinessSummary,
  type EmployeePeriodResult,
  type PeriodTotals,
} from '../engine';
import { formatDateHe, STATUS_LABELS } from '../ui/format';

export type Cell = { kind: 'text'; v: string } | { kind: 'dur'; v: number } | { kind: 'int'; v: number } | { kind: 'money'; v: number | null };

export interface Table {
  title: string;
  headers: string[];
  rows: Cell[][];
  /** Index of the totals row (rendered bold), if any. */
  totalRow: number | null;
}

const T = (v: string): Cell => ({ kind: 'text', v });
const D = (v: number): Cell => ({ kind: 'dur', v });
const I = (v: number): Cell => ({ kind: 'int', v });

export function employeeMonthTable(title: string, r: EmployeePeriodResult): Table {
  const headers = [
    'תאריך',
    'יום',
    'כניסה',
    'יציאה',
    'שעות ברוטו',
    'הפסקה',
    'שעות נטו',
    'שעות רגילות',
    'נוספות 125%',
    'נוספות 150%',
    'מנוחה/חג 150%',
    'מנוחה/חג 175%',
    'מנוחה/חג 200%',
    'לא מסווג',
    'סטטוס',
    'הערות והתראות',
  ];
  const rows: Cell[][] = [];
  for (const d of r.days) {
    const p = premiumMinutes(d.buckets);
    const valid = d.shifts.filter((s) => s.valid || s.incomplete);
    const times = (k: 'startAt' | 'endAt') =>
      valid.map((s) => (s[k] ? s[k]!.slice(11) + (k === 'endAt' && s.startAt && s[k]!.slice(0, 10) !== s.startAt.slice(0, 10) ? ' (+1)' : '') : '—')).join(' / ');
    const notes = dedupeWarnings(d.warnings)
      .filter((w) => w.severity !== 'info')
      .map((w) => w.message);
    if (d.holidayName) notes.unshift(d.holidayName);
    rows.push([
      T(formatDateHe(d.date)),
      T(HEBREW_WEEKDAYS[d.weekday]),
      T(times('startAt')),
      T(times('endAt')),
      D(d.grossMinutes),
      D(d.breakMinutes),
      D(d.netMinutes),
      D(d.buckets.regular),
      D(d.buckets.ot125),
      D(d.buckets.ot150),
      D(p.p150),
      D(p.p175),
      D(p.p200),
      D(d.buckets.unclassified),
      T(d.status ? STATUS_LABELS[d.status] : ''),
      T(notes.join(' | ')),
    ]);
  }
  const t = r.totals;
  const p = premiumMinutes(t.buckets);
  rows.push([
    T('סה״כ'),
    T(`${t.daysWorked} ימי עבודה`),
    T(''),
    T(''),
    D(t.grossMinutes),
    D(t.breakMinutes),
    D(t.netMinutes),
    D(t.buckets.regular),
    D(t.buckets.ot125),
    D(t.buckets.ot150),
    D(p.p150),
    D(p.p175),
    D(p.p200),
    D(t.buckets.unclassified),
    T(''),
    T(issuesText(t)),
  ]);
  return { title, headers, rows, totalRow: rows.length - 1 };
}

export function issuesText(t: PeriodTotals): string {
  const parts: string[] = [];
  if (t.unconfirmedBreaks) parts.push(`${t.unconfirmedBreaks} הפסקות לא מאושרות`);
  if (t.incompleteEntries) parts.push(`${t.incompleteEntries} רישומים חסרים`);
  if (t.errorCount - t.incompleteEntries > 0) parts.push(`${t.errorCount - t.incompleteEntries} שגיאות`);
  if (t.reviewCount - t.unconfirmedBreaks > 0) parts.push(`${t.reviewCount - t.unconfirmedBreaks} סימונים לבדיקה`);
  if (t.complianceCount) parts.push(`${t.complianceCount} אזהרות ציות`);
  return parts.join(', ');
}

export function businessMonthTable(title: string, s: BusinessSummary, includePay: boolean): Table {
  const headers = [
    'עובד',
    'מספר עובד',
    'ימי עבודה',
    'שעות רגילות',
    'נוספות 125%',
    'נוספות 150%',
    'מנוחה/חג 150%',
    'מנוחה/חג 175%',
    'מנוחה/חג 200%',
    'לא מסווג',
    'סה״כ שעות נטו',
    'סך הפסקות',
    ...(includePay ? ['הערכת עלות (₪)'] : []),
    'פריטים פתוחים',
  ];
  const row = (name: string, num: string, t: PeriodTotals): Cell[] => {
    const p = premiumMinutes(t.buckets);
    return [
      T(name),
      T(num),
      I(t.daysWorked),
      D(t.buckets.regular),
      D(t.buckets.ot125),
      D(t.buckets.ot150),
      D(p.p150),
      D(p.p175),
      D(p.p200),
      D(t.buckets.unclassified),
      D(t.netMinutes),
      D(t.breakMinutes),
      ...(includePay ? [{ kind: 'money', v: t.payAgorot } as Cell] : []),
      T(issuesText(t)),
    ];
  };
  const rows = s.rows.map((r) => row(r.name, r.employeeNumber ?? '', r.totals));
  rows.push(row('סה״כ לעסק', '', s.grandTotal));
  return { title, headers, rows, totalRow: rows.length - 1 };
}

export function businessDetailTable(title: string, s: BusinessSummary): Table {
  const base = employeeMonthTable('', s.rows[0]?.result ?? ({ days: [], totals: s.grandTotal } as unknown as EmployeePeriodResult));
  const headers = ['עובד', ...base.headers];
  const rows: Cell[][] = [];
  for (const r of s.rows) {
    const t = employeeMonthTable('', r.result);
    for (const row of t.rows.slice(0, -1)) {
      const worked = row[6].kind === 'dur' && row[6].v > 0;
      const hasNote = row[14].kind === 'text' && (row[14].v || (row[15].kind === 'text' && row[15].v));
      if (worked || hasNote) rows.push([T(r.name), ...row]);
    }
  }
  return { title, headers, rows, totalRow: null };
}
