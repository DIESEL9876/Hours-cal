import type { EmployeePeriodInput, EmployeePeriodResult, MinuteBuckets, PeriodTotals } from './types';
import { addBuckets, calculateEmployeePeriod, emptyBuckets } from './engine';

export interface BusinessSummaryRow {
  employeeId: string;
  name: string;
  employeeNumber: string | null;
  totals: PeriodTotals;
  result: EmployeePeriodResult;
}

export interface BusinessSummary {
  rows: BusinessSummaryRow[];
  grandTotal: PeriodTotals;
}

export function emptyTotals(): PeriodTotals {
  return {
    daysWorked: 0,
    grossMinutes: 0,
    breakMinutes: 0,
    paidBreakMinutes: 0,
    netMinutes: 0,
    buckets: emptyBuckets(),
    dailyOvertimeMinutes: 0,
    weeklyOvertimeMinutes: 0,
    contractExcessMinutes: 0,
    unconfirmedBreaks: 0,
    incompleteEntries: 0,
    errorCount: 0,
    reviewCount: 0,
    complianceCount: 0,
    payAgorot: null,
  };
}

export function addTotals(into: PeriodTotals, t: PeriodTotals): void {
  into.daysWorked += t.daysWorked;
  into.grossMinutes += t.grossMinutes;
  into.breakMinutes += t.breakMinutes;
  into.paidBreakMinutes += t.paidBreakMinutes;
  into.netMinutes += t.netMinutes;
  addBuckets(into.buckets, t.buckets);
  into.dailyOvertimeMinutes += t.dailyOvertimeMinutes;
  into.weeklyOvertimeMinutes += t.weeklyOvertimeMinutes;
  into.contractExcessMinutes += t.contractExcessMinutes;
  into.unconfirmedBreaks += t.unconfirmedBreaks;
  into.incompleteEntries += t.incompleteEntries;
  into.errorCount += t.errorCount;
  into.reviewCount += t.reviewCount;
  into.complianceCount += t.complianceCount;
  if (t.payAgorot !== null) into.payAgorot = (into.payAgorot ?? 0) + t.payAgorot;
}

export function calculateBusinessMonthlySummary(
  employees: { employeeId: string; name: string; employeeNumber: string | null; input: EmployeePeriodInput }[],
): BusinessSummary {
  const rows: BusinessSummaryRow[] = employees.map((e) => {
    const result = calculateEmployeePeriod(e.input);
    return { employeeId: e.employeeId, name: e.name, employeeNumber: e.employeeNumber, totals: result.totals, result };
  });
  const grandTotal = emptyTotals();
  for (const r of rows) addTotals(grandTotal, r.totals);
  return { rows, grandTotal };
}

/** Grouped presentation of special premiums (weekly rest + holiday). */
export function premiumMinutes(b: MinuteBuckets): { p150: number; p175: number; p200: number; total: number } {
  const p150 = b.rest150 + b.holiday150;
  const p175 = b.rest175 + b.holiday175;
  const p200 = b.rest200 + b.holiday200;
  return { p150, p175, p200, total: p150 + p175 + p200 };
}
