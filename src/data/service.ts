/**
 * Glue between stored (entered) data and the pure calculation engine.
 */
import {
  calculateBusinessMonthlySummary,
  calculateEmployeePeriod,
  monthRange,
  requiredDataRange,
  type BusinessSummary,
  type EmployeePeriodInput,
  type EmployeePeriodResult,
  type LocalDate,
} from '../engine';
import { Repository, toDayStatuses, type Employee } from './repo';

export async function loadEmployeeInput(
  repo: Repository,
  businessId: string,
  employeeId: string,
  from: LocalDate,
  to: LocalDate,
): Promise<EmployeePeriodInput> {
  const range = requiredDataRange(from, to);
  const [settingsVersions, shifts, entries, customHolidays] = await Promise.all([
    repo.getSettingsVersions(employeeId),
    repo.getShifts(businessId, employeeId, range.from, range.to),
    repo.getDayEntries(businessId, employeeId, range.from, range.to),
    repo.listCustomHolidays(businessId),
  ]);
  return { employeeId, settingsVersions, shifts, dayStatuses: toDayStatuses(entries), customHolidays, from, to };
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
