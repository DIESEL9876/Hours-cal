/**
 * Glue between stored (entered) data and the pure calculation engine.
 */
import {
  absenceHistoryFrom,
  businessAbsenceDefaults,
  businessFridayHistory,
  calculateBusinessMonthlySummary,
  calculateEmployeePeriod,
  monthRange,
  requiredDataRange,
  type BusinessSummary,
  type EmployeePeriodInput,
  type EmployeePeriodResult,
  type LocalDate,
  resolveSettings,
  type SettingsVersion,
} from '../engine';
import { Repository, toDayStatuses, type Employee } from './repo';
import { agreementHoursFor, resolveAgreements, rulesSnapshot } from '../agreements';
import { monthFinancials, resolveTravel, sumFinancials, type MonthFinancials } from '../payroll/financials';

/**
 * 1.1.9 inputs beyond attendance: date of birth, the month's manual paid-day value, and hours rules of verified,
 * confirmed agreements. Shared by the service layer and the attendance screen.
 */
export async function extraEmployeeInput(repo: Repository, businessId: string, employee: Employee, versions: SettingsVersion[], from: LocalDate, to: LocalDate) {
  const ym = from.slice(0, 7);
  const month = await repo.getEmployeeMonth(businessId, employee.id, ym);
  const settings = resolveSettings(versions, to)?.settings ?? null;
  return {
    birthDate: employee.birthDate ?? null,
    paidDayOverrides: month.paidDayOverride ? [{ ym, minutes: month.paidDayOverride.minutes, reason: month.paidDayOverride.reason }] : [],
    agreementHours: agreementHoursFor(settings?.agreements, from, to),
  };
}

export async function loadEmployeeInput(
  repo: Repository,
  businessId: string,
  employeeId: string,
  from: LocalDate,
  to: LocalDate,
): Promise<EmployeePeriodInput> {
  const range = requiredDataRange(from, to);
  // Sickness periods and 3-month averages (paid absences) look further back.
  const history = absenceHistoryFrom(from);
  const start = history < range.from ? history : range.from;
  const [settingsVersions, shifts, entries, customHolidays, business, employee] = await Promise.all([
    repo.getSettingsVersions(employeeId),
    repo.getShifts(businessId, employeeId, start, range.to),
    repo.getDayEntries(businessId, employeeId, start, range.to),
    repo.listCustomHolidays(businessId),
    repo.getBusiness(businessId),
    repo.getEmployee(businessId, employeeId),
  ]);
  const extra = await extraEmployeeInput(repo, businessId, employee, settingsVersions, from, to);
  return {
    ...extra,
    employeeId,
    settingsVersions,
    shifts,
    dayStatuses: toDayStatuses(entries),
    customHolidays,
    from,
    to,
    businessFriday: businessFridayHistory(business.defaults),
    businessAbsence: businessAbsenceDefaults(business.defaults),
    historyFrom: start,
  };
}

export async function computeEmployeeMonth(
  repo: Repository,
  businessId: string,
  employeeId: string,
  year: number,
  month: number,
): Promise<EmployeePeriodResult> {
  const { from, to } = monthRange(year, month);
  return calculateEmployeePeriod(await loadEmployeeInput(repo, businessId, employeeId, from, to));
}

export async function computeBusinessMonth(
  repo: Repository,
  businessId: string,
  year: number,
  month: number,
  employees?: Employee[],
): Promise<BusinessSummary> {
  const { from, to } = monthRange(year, month);
  const list = employees ?? (await repo.listEmployees(businessId));
  const inputs = await Promise.all(
    list.map(async (e) => ({
      employeeId: e.id,
      name: e.fullName,
      employeeNumber: e.employeeNumber,
      input: await loadEmployeeInput(repo, businessId, e.id, from, to),
    })),
  );
  return calculateBusinessMonthlySummary(inputs);
}

export const yearMonthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

/** Monthly payroll-preparation figures of every employee of a business summary (1.1.9). */
export async function computeBusinessFinancials(repo: Repository, businessId: string, year: number, month: number, summary: BusinessSummary) {
  const ym = yearMonthKey(year, month);
  const { to } = monthRange(year, month);
  const [business, adjustments, months] = await Promise.all([repo.getBusiness(businessId), repo.listAdjustments(businessId, ym), repo.listEmployeeMonths(businessId, ym)]);
  const byEmployee = new Map<string, MonthFinancials>();
  for (const row of summary.rows) {
    const versions = await repo.getSettingsVersions(row.employeeId);
    const settings = resolveSettings(versions, to)?.settings ?? null;
    const rules = resolveAgreements(settings?.agreements, to);
    byEmployee.set(
      row.employeeId,
      monthFinancials(row.result, adjustments.filter((a) => a.employeeId === row.employeeId), resolveTravel(settings, business.defaults), months.get(row.employeeId) ?? {}, rules),
    );
  }
  return { byEmployee, totals: sumFinancials([...byEmployee.values()]) };
}

/** Rule versions recorded with a closed month (outside the snapshot hash). */
export async function closingRules(repo: Repository, businessId: string, year: number, month: number) {
  const { to } = monthRange(year, month);
  const employees = await repo.listEmployees(businessId);
  const per = await Promise.all(employees.map(async (e) => ({ employeeId: e.id, selections: resolveSettings(await repo.getSettingsVersions(e.id), to)?.settings.agreements })));
  return rulesSnapshot(per, to);
}

/** Canonical, calculated-data snapshot of a month (used to detect changes after finalisation). */
export function snapshotOf(summary: BusinessSummary): string {
  return JSON.stringify(
    summary.rows.map((r) => ({
      employeeId: r.employeeId,
      name: r.name,
      totals: r.totals,
      days: r.result.days.map((d) => ({ date: d.date, net: d.netMinutes, buckets: d.buckets, status: d.status })),
    })),
  );
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
