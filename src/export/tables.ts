/**
 * Pure tabular representations of reports (shared by XLSX, CSV and tests).
 * Cells hold integer MINUTES for durations (kind 'dur') so each output format renders them exactly.
 */
import {
  dedupeWarnings,
  formatDays,
  HEBREW_WEEKDAYS,
  premiumMinutes,
  type AttendanceTotals,
  type BusinessSummary,
  type DayAttendance,
  type EmployeePeriodResult,
  type PeriodTotals,
} from '../engine';
import { formatDateHe, STATUS_LABELS } from '../ui/format';
import type { MonthlyAdjustment } from '../data/repo';
import { ADJUSTMENT_LABELS, type MonthFinancials, type sumFinancials } from '../payroll/financials';

/** 'days' holds HUNDREDTHS of a day (fractional day counts, summed exactly from the daily records). */
export type Cell = { kind: 'text'; v: string } | { kind: 'dur'; v: number } | { kind: 'int'; v: number } | { kind: 'days'; v: number } | { kind: 'money'; v: number | null };

export interface Table {
  title: string;
  headers: string[];
  rows: Cell[][];
  /** Index of the totals row (rendered bold), if any. */
  totalRow: number | null;
  /** CSV: append this table after the main one (CSV has a single sheet). */
  csvAppend?: boolean;
}

const T = (v: string): Cell => ({ kind: 'text', v });
const D = (v: number): Cell => ({ kind: 'dur', v });
const I = (v: number): Cell => ({ kind: 'int', v });
const DY = (v: number): Cell => ({ kind: 'days', v });

/** Daily actual-vs-paid columns (version 1.1.7), placed after the existing hour columns. */
const DAY_ATTENDANCE_HEADERS = ['שעות בפועל', 'היעדרות בתשלום (שעות יום)', 'היעדרות – שווה ערך לתשלום', 'שעות משולמות', 'זיכוי לתקן השבועי', 'יום משולם', 'שיעור תשלום'];
function dayAttendanceCells(a: DayAttendance): Cell[] {
  const rate = a.category && a.paidAbsenceNominalMinutes > 0 ? (a.payPercent === null ? 'דורש בדיקה' : `${a.payPercent}%`) : '';
  return [D(a.actualWorkedMinutes), D(a.paidAbsenceNominalMinutes), D(a.paidAbsenceEquivalentMinutes), D(a.payableEquivalentMinutes), D(a.weeklyCreditMinutes), DY(a.paidDayHundredths), T(rate)];
}

/** One-line category breakdown for a totals row. */
export function categoryDaysText(a: AttendanceTotals): string {
  const parts: string[] = [];
  if (a.vacationDayHundredths) parts.push(`חופשה ${formatDays(a.vacationDayHundredths)}`);
  if (a.sickDayHundredths) parts.push(`מחלה ${formatDays(a.sickDayHundredths)} (משולם ${formatDays(a.sickPaidDayHundredths)})`);
  if (a.holidayDayHundredths) parts.push(`חג ${formatDays(a.holidayDayHundredths)}`);
  if (a.electionDayHundredths) parts.push(`בחירות ${formatDays(a.electionDayHundredths)}`);
  if (a.unpaidDayHundredths) parts.push(`ללא תשלום ${formatDays(a.unpaidDayHundredths)}`);
  if (a.reviewDays) parts.push(`${a.reviewDays} ימים דורשים בדיקה`);
  return parts.join(' · ');
}

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
    ...DAY_ATTENDANCE_HEADERS,
    'סוג יום',
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
    if (d.attendance.basis === 'review') notes.push(...d.attendance.reviewReasons);
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
      ...dayAttendanceCells(d.attendance),
      T(d.status ? STATUS_LABELS[d.status] : ''),
      T(notes.join(' | ')),
    ]);
  }
  const t = r.totals;
  const a = r.attendance;
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
    D(a.actualWorkedMinutes),
    D(a.paidAbsenceNominalMinutes),
    D(a.paidAbsenceEquivalentMinutes),
    D(a.payableEquivalentMinutes),
    D(a.weeklyCreditMinutes),
    DY(a.paidDayHundredths),
    T(''),
    T(categoryDaysText(a)),
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

/** Business-wide actual vs. paid columns (version 1.1.7). Totals are sums of the daily records. */
export const BUSINESS_ATTENDANCE_HEADERS = [
  'ימים בפועל',
  'ימים משולמים',
  'שעות בפועל',
  'שעות משולמות',
  'ימי חופשה',
  'ימי מחלה',
  'ימי מחלה – שווה ערך משולם',
  'ניכוי ממכסת מחלה (הערכה)',
  'ימי חג',
  'ימי בחירות',
  'ימי היעדרות ללא תשלום',
  'ימים לבדיקה',
];
function businessAttendanceCells(a: AttendanceTotals): Cell[] {
  return [
    I(a.actualWorkedDays),
    DY(a.paidDayHundredths),
    D(a.actualWorkedMinutes),
    D(a.payableEquivalentMinutes),
    DY(a.vacationDayHundredths),
    DY(a.sickDayHundredths),
    DY(a.sickPaidDayHundredths),
    DY(a.sickBalanceDeductionHundredths),
    DY(a.holidayDayHundredths),
    DY(a.electionDayHundredths),
    DY(a.unpaidDayHundredths),
    I(a.reviewDays),
  ];
}

/** Payroll-preparation columns (₪, 1.1.9) — never hours. */
export const BUSINESS_PAY_HEADERS = ['ערך היעדרויות (הערכה, ₪)', 'נסיעות (₪)', 'בונוס (₪)', 'דמי הבראה (₪)', 'מילואים (₪)', 'תוספות אחרות (₪)', 'מקדמות (₪)', 'ניכויים שאושרו (₪)', 'החזרים למעסיק (₪)'];
function payCells(f: MonthFinancials | null): Cell[] {
  const m = (v: number | undefined): Cell => ({ kind: 'money', v: v ?? 0 });
  return [
    m(f?.absenceEstimateAgorot),
    m(f?.travel.totalAgorot),
    m(f?.byCategory.bonus),
    m(f?.byCategory.recuperation),
    m(f?.byCategory.reserve),
    m(f?.byCategory.other),
    m(f?.byCategory.advance),
    m(f?.totals.authorizedDeductionsAgorot),
    m(f?.totals.employerReimbursementsAgorot),
  ];
}
type BusinessFin = { byEmployee: Map<string, MonthFinancials>; totals: ReturnType<typeof sumFinancials> } | null;

export function businessMonthTable(title: string, s: BusinessSummary, includePay: boolean, fin: BusinessFin = null): Table {
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
    ...BUSINESS_ATTENDANCE_HEADERS,
    ...(includePay ? ['הערכת עלות (₪)'] : []),
    ...(fin ? BUSINESS_PAY_HEADERS : []),
    'פריטים פתוחים',
  ];
  const row = (name: string, num: string, t: PeriodTotals, a: AttendanceTotals): Cell[] => {
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
      ...businessAttendanceCells(a),
      ...(includePay ? [{ kind: 'money', v: t.payAgorot } as Cell] : []),
      ...(fin ? payCells(f) : []),
      T(issuesText(t)),
    ];
  };
  let f: MonthFinancials | null = null;
  const rows = s.rows.map((r) => {
    f = fin?.byEmployee.get(r.employeeId) ?? null;
    return row(r.name, r.employeeNumber ?? '', r.totals, r.result.attendance);
  });
  if (fin) {
    const t = fin.totals;
    f = {
      absenceEstimateAgorot: t.absenceEstimateAgorot,
      travel: { totalAgorot: t.travelAgorot },
      byCategory: t.byCategory,
      totals: t,
    } as unknown as MonthFinancials;
  }
  rows.push(row('סה״כ לעסק', '', s.grandTotal, s.attendanceTotal));
  return { title, headers, rows, totalRow: rows.length - 1 };
}

/** Monthly payroll components, one row per entry, plus travel and the absence estimate (1.1.9). */
export function payrollItemsTable(title: string, rows: { name: string; number: string; f: MonthFinancials; items: MonthlyAdjustment[] }[]): Table {
  const headers = ['עובד', 'מספר עובד', 'סוג', 'סכום (₪)', 'תאריך', 'תיאור', 'טיפול חשבונאי', 'פרטים'];
  const out: Cell[][] = [];
  const TREAT: Record<string, string> = { gross_addition: 'תוספת ברוטו', advance: 'מקדמה', employer_reimbursement: 'החזר למעסיק', informational: 'לידיעה בלבד' };
  for (const r of rows) {
    for (const a of r.items) {
      const det =
        a.category === 'advance'
          ? `הוצע להחזר ${((a.details.advance?.proposedRecoveryAgorot ?? 0) / 100).toFixed(2)} · אושר לניכוי ${((a.details.advance?.authorizedDeductionAgorot ?? 0) / 100).toFixed(2)}${a.details.advance?.authorization ? ` (${a.details.advance.authorization})` : ''}`
          : a.category === 'reserve'
            ? (a.details.reserve?.kind ?? 'manual')
            : '';
      out.push([T(r.name), T(r.number), T(ADJUSTMENT_LABELS[a.category]), { kind: 'money', v: a.amountAgorot }, T(a.date ? formatDateHe(a.date) : ''), T(a.description ?? ''), T(TREAT[a.treatment] ?? a.treatment), T(det)]);
    }
    if (r.f.travel.totalAgorot > 0)
      out.push([T(r.name), T(r.number), T('החזר נסיעות'), { kind: 'money', v: r.f.travel.totalAgorot }, T(''), T(r.f.travel.notes[0] ?? ''), T('תוספת ברוטו'), T(r.f.travel.overrideReason ? `תוקן ידנית: ${r.f.travel.overrideReason}` : '')]);
    if (r.f.absenceEstimateAgorot > 0)
      out.push([T(r.name), T(r.number), T('ערך היעדרויות (הערכה)'), { kind: 'money', v: r.f.absenceEstimateAgorot }, T(''), T('שיטת חישוב לפי הגדרת העסק — אינה הסכום לפי החוק'), T('לידיעה בלבד'), T('')]);
  }
  return { title, headers, rows: out, totalRow: null };
}

export function businessDetailTable(title: string, s: BusinessSummary): Table {
  const base = employeeMonthTable('', s.rows[0]?.result ?? ({ days: [], totals: s.grandTotal, attendance: s.attendanceTotal } as unknown as EmployeePeriodResult));
  const headers = ['עובד', ...base.headers];
  const rows: Cell[][] = [];
  const net = base.headers.indexOf('שעות נטו');
  const type = base.headers.indexOf('סוג יום');
  const notes = base.headers.indexOf('הערות והתראות');
  for (const r of s.rows) {
    const t = employeeMonthTable('', r.result);
    t.rows.slice(0, -1).forEach((row, i) => {
      const worked = row[net].kind === 'dur' && row[net].v > 0;
      const hasNote = (row[type].kind === 'text' && row[type].v) || (row[notes].kind === 'text' && row[notes].v);
      const paid = r.result.days[i].attendance.payableEquivalentMinutes > 0;
      if (worked || hasNote || paid) rows.push([T(r.name), ...row]);
    });
  }
  return { title, headers, rows, totalRow: null };
}
