/**
 * 1.1.13 — "סיכום חודשי לקליטת שכר": the payroll-entry view of a business month.
 *
 * A pure re-arrangement of the existing monthly results (BusinessSummary from the engine + MonthFinancials). No pay
 * rule is (re)calculated here: every figure is an engine/financials value or a plain sum of them. Shared by the A4
 * print/PDF, the Excel/CSV "קליטת שכר" sheet and the tests, so all three always show the same numbers.
 *
 * Units never mix: days are hundredths of a day, hours are integer MINUTES (decimal hours are derived only for
 * display, from the precise minutes — totals are summed in minutes, never from rounded decimals), money is agorot.
 */
import { absenceByCategory, decimalHundredths, dedupeWarnings, formatDays, formatDecimalHours, formatHM, premiumMinutes, type AbsenceCategoryTotals, type BusinessSummary, type BusinessSummaryRow, type DayStatusKind } from '../engine';
import type { MonthFinancials, sumFinancials } from '../payroll/financials';

export type PeSection = 'days' | 'hours' | 'money';
export type PeKind = 'days' | 'hours' | 'money' | 'flag';
/** ok = calculated and nothing open · review = calculated but needs a human check · missing = not set / incomplete data. */
export type PeStatus = 'ok' | 'review' | 'missing';

export interface PeColumn {
  key: string;
  label: string;
  kind: PeKind;
  section: PeSection;
}

export interface PeValue {
  /** days: hundredths · hours: minutes · money: agorot · flag: 1/0. null = no value (not set). */
  v: number | null;
  status: PeStatus;
}

/**
 * ready = calculated, nothing open · review = figures exist but something needs a check · missing = incomplete
 * records or a required setting is missing · empty = no attendance or absence recorded at all for the month.
 */
export type PeRowState = 'ready' | 'review' | 'missing' | 'empty';

export interface PeRow {
  employeeId: string;
  name: string;
  number: string;
  values: Record<string, PeValue>;
  /** Short Hebrew reasons when anything in the row is not final. Empty = ready for payroll entry. */
  issues: string[];
  state: PeRowState;
}

export interface PayrollEntryReport {
  title: string;
  columns: PeColumn[];
  rows: PeRow[];
  totals: Record<string, PeValue>;
}

export const PAYROLL_ENTRY_TITLE = 'סיכום חודשי לקליטת שכר';

export const SECTION_TITLES: Record<PeSection, string> = {
  days: 'ימים',
  hours: 'שעות',
  money: 'סכומים (₪)',
};

type BusinessFin = { byEmployee: Map<string, MonthFinancials>; totals: ReturnType<typeof sumFinancials> } | null;

/** Absence categories reported separately (in this order). Others fall into "היעדרות אחרת" so nothing is hidden. */
const ABSENCE: { cat: DayStatusKind; key: string; label: string; always: boolean; hours: boolean }[] = [
  { cat: 'vacation', key: 'vacation', label: 'חופשה', always: true, hours: true },
  { cat: 'sick', key: 'sick', label: 'מחלה', always: true, hours: true },
  { cat: 'holiday', key: 'holiday', label: 'חג', always: true, hours: true },
  { cat: 'reserve', key: 'reserve', label: 'מילואים', always: false, hours: true },
  { cat: 'election', key: 'election', label: 'בחירות', always: false, hours: true },
  { cat: 'unpaid', key: 'unpaid', label: 'ללא תשלום', always: false, hours: false },
];

const ok = (v: number | null): PeValue => ({ v, status: 'ok' });
const MONEY_KEYS = new Set(['travel', 'advance', 'bonus', 'recupFlag', 'recupAmount', 'reserveMoney', 'otherMoney', 'deduction']);
const worst = (a: PeStatus, b: PeStatus): PeStatus => (a === 'missing' || b === 'missing' ? 'missing' : a === 'review' || b === 'review' ? 'review' : 'ok');

/** Short labels for the engine's open review flags (what to check), grouped by code. */
const REVIEW_LABELS: Record<string, string> = {
  UNSCHEDULED_DAY_WORK: 'עבודה ביום שאינו יום עבודה',
  MISSING_RECORD: 'ימים ללא רישום',
  EXEMPT_PROFILE: 'עובד מוחרג – לאשר',
  CUSTOM_PROFILE: 'תקן מותאם – לאשר',
  MINOR_PROFILE_ADULT: 'פרופיל נוער לעובד בגיר',
  AGREEMENT_MIN_WAGE: 'שכר מתחת למינימום הענפי',
};
const shortText = (msg: string) => {
  const first = msg.split(/[.—]/)[0].trim();
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
};
const counted = (m: Map<string, number>, prefix = '') => [...m].map(([k, n]) => `${prefix}${k}${n > 1 ? ` (${n})` : ''}`);

function reviewLabels(r: BusinessSummaryRow): string[] {
  const m = new Map<string, number>();
  for (const w of dedupeWarnings([...r.result.warnings, ...r.result.days.flatMap((d) => d.warnings)])) {
    if (w.severity !== 'review' || w.acknowledged || w.code === 'BREAK_UNCONFIRMED') continue;
    const label = REVIEW_LABELS[w.code] ?? (w.code.startsWith('YOUTH_') ? 'עבודת נוער – לבדיקה' : shortText(w.message));
    m.set(label, (m.get(label) ?? 0) + 1);
  }
  return counted(m);
}

function absenceReviewLabels(r: BusinessSummaryRow): string[] {
  const m = new Map<string, number>();
  for (const d of r.result.days) {
    if (d.attendance.basis !== 'review') continue;
    const label = shortText(d.attendance.reviewReasons[0] ?? 'זכאות לא נקבעה');
    m.set(label, (m.get(label) ?? 0) + 1);
  }
  return counted(m, 'ימי היעדרות לבדיקה: ');
}

interface Built {
  values: Record<string, PeValue>;
  issues: string[];
  state: PeRowState;
}

export const ROW_STATE_LABELS: Record<PeRowState, string> = { ready: 'מוכן', review: 'לבדיקה', missing: 'חסר', empty: 'אין רישומים' };
export const NO_RECORDS_TEXT = 'אין רישומי נוכחות או היעדרות לחודש זה';

function buildRow(r: BusinessSummaryRow, f: MonthFinancials | null): Built {
  const t = r.totals;
  const a = r.result.attendance;
  const b = t.buckets;
  const p = premiumMinutes(b);
  const cats = absenceByCategory(r.result.days.map((d) => d.attendance));
  const issues: string[] = [];
  // Nothing recorded for the month (no shift, no day type): never presented as a ready zero.
  const empty = r.result.days.every((d) => d.shifts.length === 0 && !d.status);
  if (empty) issues.push(NO_RECORDS_TEXT);

  // Hours status — from the engine's own counters.
  let hoursStatus: PeStatus = 'ok';
  const otherErrors = t.errorCount - t.incompleteEntries;
  if (t.incompleteEntries) issues.push(`${t.incompleteEntries} רישומים חסרים`);
  if (otherErrors > 0) issues.push(`${otherErrors} שגיאות`);
  if (t.incompleteEntries || otherErrors > 0) hoursStatus = 'missing';
  if (t.unconfirmedBreaks) issues.push(`${t.unconfirmedBreaks} הפסקות לא אושרו`);
  issues.push(...reviewLabels(r));
  if (b.unclassified) issues.push('שעות שלא סווגו');
  if (t.unconfirmedBreaks || t.reviewCount > 0 || b.unclassified) hoursStatus = worst(hoursStatus, 'review');

  // Absence status — dates whose entitlement the engine could not determine.
  const absStatus = (c: AbsenceCategoryTotals | undefined): PeStatus => (c?.reviewDays ? 'review' : 'ok');
  if (a.reviewDays) issues.push(...absenceReviewLabels(r));
  const paidStatus = worst(hoursStatus, a.reviewDays ? 'review' : 'ok');

  const v: Record<string, PeValue> = {};
  // Days.
  v.actualDays = { v: a.actualWorkedDays * 100, status: hoursStatus === 'missing' ? 'missing' : 'ok' };
  v.paidDays = { v: a.paidDayHundredths, status: worst(v.actualDays.status, a.reviewDays ? 'review' : 'ok') };
  for (const x of ABSENCE) {
    const c = cats[x.cat];
    v[`${x.key}Days`] = { v: c?.dayHundredths ?? 0, status: absStatus(c) };
    if (x.cat === 'sick') v.sickPaidDays = { v: c?.paidDayHundredths ?? 0, status: absStatus(c) };
  }
  // Hours (minutes).
  v.actualHours = { v: a.actualWorkedMinutes, status: hoursStatus };
  v.paidHours = { v: a.payableEquivalentMinutes, status: paidStatus };
  v.regular = { v: b.regular, status: hoursStatus };
  v.ot125 = { v: b.ot125, status: hoursStatus };
  v.ot150 = { v: b.ot150, status: hoursStatus };
  v.p150 = { v: p.p150, status: hoursStatus };
  v.p175 = { v: p.p175, status: hoursStatus };
  v.p200 = { v: p.p200, status: hoursStatus };
  v.unclassified = { v: b.unclassified, status: b.unclassified ? 'review' : 'ok' };
  let shown = 0;
  for (const x of ABSENCE.filter((y) => y.hours)) {
    const c = cats[x.cat];
    // Entitlement not determinable (e.g. no basis for the day value yet) → no figure rather than a misleading 0.
    v[`${x.key}Hours`] = c?.reviewDays && !c.equivalentMinutes ? { v: null, status: 'review' } : { v: c?.equivalentMinutes ?? 0, status: absStatus(c) };
    shown += c?.equivalentMinutes ?? 0;
  }
  // Any paid-absence equivalent not in a listed category (e.g. a partial absence on a workday): reported, never hidden.
  const rest = a.paidAbsenceEquivalentMinutes - shown;
  v.otherAbsenceHours = { v: rest, status: 'review' as PeStatus };
  if (!rest) v.otherAbsenceHours.status = 'ok';

  // Money (agorot) — entered or configured amounts only; estimates are not payroll figures and are left out.
  if (f) {
    const travelMissing = f.travel.mode === 'none' && f.travel.reviews.length > 0;
    v.travel = travelMissing ? { v: null, status: 'missing' } : { v: f.travel.totalAgorot, status: f.travel.reviews.length ? 'review' : 'ok' };
    if (travelMissing) issues.push('החזר נסיעות לא הוגדר');
    else if (f.travel.reviews.length) issues.push('נסיעות לבדיקה');
    v.advance = ok(f.byCategory.advance);
    v.bonus = ok(f.byCategory.bonus);
    v.recupFlag = ok(f.recuperationDue ? 1 : 0);
    v.recupAmount = ok(f.byCategory.recuperation);
    v.reserveMoney = ok(f.byCategory.reserve);
    v.otherMoney = ok(f.byCategory.other);
    v.deduction = ok(f.advance.authorizedDeductionAgorot);
  }
  if (empty) for (const k of Object.keys(v)) if (!MONEY_KEYS.has(k)) v[k] = { v: v[k].v, status: 'missing' };
  const statuses = Object.values(v).map((x) => x.status);
  const state: PeRowState = empty ? 'empty' : statuses.includes('missing') ? 'missing' : issues.length || statuses.includes('review') ? 'review' : 'ready';
  return { values: v, issues, state };
}

/** Builds the payroll-entry report. `fin` null → the money section is omitted (no payroll data loaded). */
export function buildPayrollEntryReport(s: BusinessSummary, fin: BusinessFin): PayrollEntryReport {
  const built = s.rows.map((r) => ({ r, ...buildRow(r, fin?.byEmployee.get(r.employeeId) ?? null) }));
  const rows: PeRow[] = built.map(({ r, values, issues, state }) => ({ employeeId: r.employeeId, name: r.name, number: r.employeeNumber ?? '', values, issues, state }));

  // A column is relevant when some employee has a figure (or an undeterminable one) — not merely a flagged zero.
  const any = (key: string) => rows.some((x) => { const val = x.values[key]; return !!val && (val.v === null || val.v !== 0); });
  const cols: PeColumn[] = [];
  const add = (key: string, label: string, kind: PeKind, section: PeSection, show = true) => {
    if (show) cols.push({ key, label, kind, section });
  };

  // Days.
  add('actualDays', 'ימים בפועל', 'days', 'days');
  add('paidDays', 'ימים משולמים', 'days', 'days');
  for (const x of ABSENCE) {
    add(`${x.key}Days`, x.cat === 'unpaid' ? 'היעדרות ללא תשלום' : `ימי ${x.label}`, 'days', 'days', x.always || any(`${x.key}Days`));
    if (x.cat === 'sick') add('sickPaidDays', 'מחלה – ימים משולמים', 'days', 'days', any('sickDays'));
  }
  // Hours.
  add('actualHours', 'שעות בפועל', 'hours', 'hours');
  add('paidHours', 'שעות משולמות', 'hours', 'hours');
  add('regular', 'שעות רגילות 100%', 'hours', 'hours');
  add('ot125', 'נוספות 125%', 'hours', 'hours');
  add('ot150', 'נוספות 150%', 'hours', 'hours');
  add('p150', 'מנוחה/חג 150%', 'hours', 'hours', any('p150'));
  add('p175', 'מנוחה/חג 175%', 'hours', 'hours', any('p175'));
  add('p200', 'מנוחה/חג 200%', 'hours', 'hours', any('p200'));
  add('unclassified', 'שעות לא מסווגות', 'hours', 'hours', any('unclassified'));
  for (const x of ABSENCE.filter((y) => y.hours)) add(`${x.key}Hours`, `שעות ${x.label}`, 'hours', 'hours', x.always || any(`${x.key}Hours`));
  add('otherAbsenceHours', 'שעות היעדרות אחרת', 'hours', 'hours', any('otherAbsenceHours'));
  // Money.
  if (fin) {
    add('travel', 'נסיעות', 'money', 'money');
    add('advance', 'מקדמות', 'money', 'money');
    add('bonus', 'בונוסים', 'money', 'money');
    add('recupFlag', 'הבראה', 'flag', 'money');
    add('recupAmount', 'דמי הבראה', 'money', 'money', any('recupAmount'));
    add('reserveMoney', 'מילואים', 'money', 'money', any('reserveMoney'));
    add('otherMoney', 'תוספות אחרות', 'money', 'money', any('otherMoney'));
    add('deduction', 'ניכוי מאושר', 'money', 'money', any('deduction'));
  }

  // Totals: sums of the precise per-employee units (minutes / hundredths / agorot). Hours are summed in MINUTES
  // and converted once, so the decimal total is never a sum of already-rounded decimals.
  const totals: Record<string, PeValue> = {};
  for (const c of cols) {
    let sum = 0;
    let status: PeStatus = 'ok';
    let anyValue = false;
    for (const x of rows) {
      const val = x.values[c.key];
      if (!val) continue;
      if (val.v !== null) {
        sum += val.v;
        anyValue = true;
      }
      status = worst(status, val.status === 'missing' ? 'review' : val.status);
    }
    totals[c.key] = { v: anyValue || !rows.length ? sum : null, status };
  }
  return { title: PAYROLL_ENTRY_TITLE, columns: cols, rows, totals };
}

// ---------------------------------------------------------------------------
// Display helpers (shared by print and tests)
// ---------------------------------------------------------------------------

/** Decimal hours (2 decimals) from integer minutes: total minutes / 60, rounded half-up only for display. */
export const decimalHours = (minutes: number): string => formatDecimalHours(minutes);
/** Numeric decimal-hours value (for spreadsheets), same rounding as decimalHours. */
export const decimalHoursNumber = (minutes: number): number => decimalHundredths(minutes) / 100;
/** HH:MM with at least two hour digits, e.g. 456 → "07:36", 10125 → "168:45". */
export function hhmm(minutes: number): string {
  const s = formatHM(minutes);
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [h, m] = body.split(':');
  return `${neg ? '-' : ''}${h.padStart(2, '0')}:${m}`;
}
export const moneyText = (agorot: number): string => (agorot / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Day count: whole days without decimals ("22"), fractions with two ("1.50"). */
export const daysText = (hundredths: number): string => (hundredths % 100 === 0 ? String(hundredths / 100) : formatDays(hundredths));

/**
 * Text of a cell for print. `main` is the payroll-entry figure; `sub` (hours only) the HH:MM reference.
 * A genuine zero prints "0"; a value that is not set prints "לא הוגדר"; one that cannot be determined yet "לבדיקה".
 */
export function cellText(kind: PeKind, val: PeValue | undefined): { main: string; sub: string | null; zero: boolean } {
  if (!val || val.v === null) return { main: val?.status === 'missing' ? 'לא הוגדר' : val?.status === 'review' ? 'לבדיקה' : '–', sub: null, zero: false };
  if (val.v === 0 && kind !== 'flag') return { main: '0', sub: null, zero: true };
  switch (kind) {
    case 'hours':
      return { main: decimalHours(val.v), sub: hhmm(val.v), zero: false };
    case 'days':
      return { main: daysText(val.v), sub: null, zero: false };
    case 'money':
      return { main: moneyText(val.v), sub: null, zero: false };
    case 'flag':
      return { main: val.v ? 'כן' : 'לא', sub: null, zero: !val.v };
  }
}

/** Total-row text for the recuperation flag column ("N כן"). */
export const flagTotalText = (val: PeValue | undefined) => `${val?.v ?? 0} כן`;
