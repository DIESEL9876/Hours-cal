/**
 * Bulk import planning (1.1.8): turns a workbook analysis into one reviewable entry per detected employee —
 * proposed action (create / match existing / merge / skip), editable name and number, and the same per-date
 * preview rows as a single-employee import. Nothing is written here; the approved plan becomes ONE repository batch.
 */
import type { ShiftInput } from '../engine';
import { buildImportChanges, buildPreview, countPreview, evaluateRow, willWrite, type PlanContext } from './plan';
import type { PreviewRow } from './types';
import { nameKey, sameEmployee } from './values';
import type { SheetEmployee, WorkbookAnalysis } from './workbook';

export type BulkAction = { kind: 'create' } | { kind: 'existing'; employeeId: string } | { kind: 'merge'; into: string } | { kind: 'skip' } | { kind: 'review' };

export interface ExistingEmployeeRef {
  id: string;
  fullName: string;
  employeeNumber: string | null;
}

export interface BulkEntry {
  key: string;
  source: SheetEmployee;
  include: boolean;
  /** Editable in the wizard. */
  name: string;
  employeeNumber: string;
  /** null = the user must decide (ambiguous match, possible duplicate, missing name). */
  action: BulkAction | null;
  /** Why an existing employee was proposed. */
  suggestion: { employeeId: string; reason: 'id_and_name' | 'id_only' | 'name_only' } | null;
  rows: PreviewRow[];
  issues: string[];
}

export interface BulkContext {
  existing: ExistingEmployeeRef[];
  /** Existing shifts of an existing employee (loaded when needed). */
  shiftsOf: (employeeId: string) => ShiftInput[];
  gapIsBreak: boolean;
  /** Explicit 0:00 breaks from the source: keep the employee's break policy (default) or use 0 as recorded. */
  zeroBreak: 'policy' | 'source';
}

export function planContext(e: { source: SheetEmployee; action: BulkAction | null }, ctx: BulkContext, extraShifts: ShiftInput[] = []): PlanContext {
  const target = e.action?.kind === 'existing' ? ctx.shiftsOf(e.action.employeeId) : [];
  return {
    year: e.source.year ?? 2000,
    month: e.source.month ?? 1,
    existingShifts: [...target, ...extraShifts],
    existingDayStatus: new Map(),
    gapIsBreak: ctx.gapIsBreak,
    zeroBreak: ctx.zeroBreak,
  };
}

/** Initial proposal for every detected employee. */
export function proposeEntries(analysis: WorkbookAnalysis, ctx: BulkContext): BulkEntry[] {
  const dupOf = new Map<string, string>(); // later sheet → first sheet of its duplicate group
  for (const g of analysis.possibleDuplicates) for (const k of g.slice(1)) dupOf.set(k, g[0]);
  return analysis.employees.map((src) => {
    const issues = [...src.issues];
    let suggestion: BulkEntry['suggestion'] = null;
    const byId = src.clockId ? ctx.existing.filter((x) => x.employeeNumber && x.employeeNumber.trim() === src.clockId) : [];
    const byName = src.name ? ctx.existing.filter((x) => sameEmployee({ name: src.name, number: null }, x)) : [];
    const both = byId.filter((x) => byName.includes(x));
    if (both.length === 1) suggestion = { employeeId: both[0].id, reason: 'id_and_name' };
    else if (byId.length === 1) {
      suggestion = { employeeId: byId[0].id, reason: 'id_only' };
      issues.push(`מספר ${src.clockId} שייך לעובד הקיים "${byId[0].fullName}" ששמו שונה — יש לאשר שיוך או ליצור עובד חדש`);
    } else if (byName.length === 1) {
      suggestion = { employeeId: byName[0].id, reason: 'name_only' };
      issues.push(`קיים בעסק עובד בשם דומה ("${byName[0].fullName}") — שם בלבד אינו מזהה ודאי; יש לבחור שיוך או עובד חדש`);
    } else if (byName.length > 1) issues.push('קיימים בעסק כמה עובדים בשם דומה — יש לבחור פעולה');

    let action: BulkAction | null;
    if (!src.records.length) action = { kind: 'skip' };
    else if (!src.name) action = null;
    else if (dupOf.has(src.key)) action = null;
    else if (suggestion?.reason === 'id_and_name') action = { kind: 'existing', employeeId: suggestion.employeeId };
    else if (suggestion || byName.length > 1) action = null;
    else action = { kind: 'create' };

    // A clock number already used by a different existing employee is not proposed for a new one.
    let employeeNumber = src.clockId ?? '';
    if (employeeNumber && byId.length && action?.kind !== 'existing') employeeNumber = '';

    const entry: BulkEntry = { key: src.key, source: src, include: action?.kind !== 'skip', name: src.name ?? src.titleName ?? src.sheetName, employeeNumber, action, suggestion, rows: [], issues };
    entry.rows = buildPreview(src.records, planContext(entry, ctx));
    return entry;
  });
}

/** Re-evaluates an entry's rows after its action changed (existing data of the new target). */
export function retarget(entry: BulkEntry, ctx: BulkContext): BulkEntry {
  const pc = planContext(entry, ctx);
  return { ...entry, rows: entry.rows.map((r) => withExisting(r, pc)) };
}

function withExisting(r: PreviewRow, pc: PlanContext): PreviewRow {
  const existing = pc.existingShifts.filter((s) => s.workDate === r.date).map((s) => ({
    id: s.id,
    start: s.startAt?.slice(11, 16) ?? null,
    end: s.endAt?.slice(11, 16) ?? null,
    overnight: !!s.startAt && !!s.endAt && s.endAt.slice(0, 10) !== s.startAt.slice(0, 10),
    breakMinutes: s.breakMinutes,
  }));
  return evaluateRow({ ...r, existing }, pc);
}

export interface BulkSummary {
  sheets: number;
  employees: number;
  proposedNew: number;
  existingMatches: number;
  days: number;
  shifts: number;
  unresolved: number;
}

export function summarize(analysis: WorkbookAnalysis, entries: BulkEntry[]): BulkSummary {
  const active = entries.filter((e) => e.include);
  return {
    sheets: analysis.sheetsAnalyzed,
    employees: entries.length,
    proposedNew: active.filter((e) => e.action?.kind === 'create').length,
    existingMatches: entries.filter((e) => e.suggestion).length,
    days: active.reduce((a, e) => a + e.rows.filter(willWrite).length, 0),
    shifts: active.reduce((a, e) => a + e.rows.filter(willWrite).reduce((s, r) => s + r.segments.filter((x) => x.start || x.end).length, 0), 0),
    unresolved: active.filter((e) => e.action === null).length + active.reduce((a, e) => a + countPreview(e.rows).invalid, 0),
  };
}

/** Problems that block approval (Hebrew), empty when the plan can be written. */
export function blockingProblems(entries: BulkEntry[], existing: ExistingEmployeeRef[]): string[] {
  const out: string[] = [];
  const active = entries.filter((e) => e.include && e.action && e.action.kind !== 'skip' && e.action.kind !== 'review');
  for (const e of entries.filter((x) => x.include && x.action === null)) out.push(`${e.name || e.source.sheetName}: יש לבחור פעולה`);
  const numbers = new Map<string, string>();
  for (const x of existing) if (x.employeeNumber) numbers.set(x.employeeNumber.trim(), x.fullName);
  for (const e of active.filter((x) => x.action!.kind === 'create')) {
    if (!e.name.trim()) out.push(`${e.source.sheetName}: יש להזין שם עובד`);
    const n = e.employeeNumber.trim();
    if (!n) continue;
    if (numbers.has(n)) out.push(`${e.name}: מספר העובד ${n} כבר קיים (${numbers.get(n)})`);
    else numbers.set(n, e.name);
  }
  for (const e of active.filter((x) => x.action!.kind === 'merge')) {
    const into = entries.find((x) => x.key === (e.action as { into: string }).into);
    if (!into || !into.include || !into.action || !['create', 'existing'].includes(into.action.kind)) out.push(`${e.name}: הגיליון שאליו ממוזג אינו נקלט`);
  }
  if (!active.length) out.push('לא נבחרו עובדים לקליטה');
  return out;
}

/** The approved plan as repository input. Merged sheets are written to the employee of the sheet they merge into. */
export function buildBulkChanges(
  entries: BulkEntry[],
  ctx: BulkContext,
  newEmployeeSettings: import('../engine').EmployeeSettings,
): { ref: string; target: { existingId: string } | { create: { fullName: string; employeeNumber: string | null; settings: import('../engine').EmployeeSettings } }; add: ShiftInput[]; remove: ShiftInput[] }[] {
  const items = new Map<string, { ref: string; target: { existingId: string } | { create: { fullName: string; employeeNumber: string | null; settings: import('../engine').EmployeeSettings } }; add: ShiftInput[]; remove: ShiftInput[] }>();
  const active = entries.filter((e) => e.include && e.action && (e.action.kind === 'create' || e.action.kind === 'existing'));
  for (const e of active) {
    const pc = planContext(e, ctx);
    const ch = buildImportChanges(e.rows, pc);
    items.set(e.key, {
      ref: e.key,
      target: e.action!.kind === 'existing' ? { existingId: e.action!.employeeId } : { create: { fullName: e.name.trim(), employeeNumber: e.employeeNumber.trim() || null, settings: newEmployeeSettings } },
      add: ch.add,
      remove: ch.remove,
    });
  }
  for (const e of entries.filter((x) => x.include && x.action?.kind === 'merge')) {
    const into = items.get((e.action as { into: string }).into);
    if (!into) continue;
    // Dates already covered by the target sheet are conflicts: kept as in the target (never doubled).
    const pc = { ...planContext({ source: e.source, action: null }, ctx, into.add) };
    const rows = e.rows.map((r) => withExisting({ ...r, include: r.include }, pc));
    const ch = buildImportChanges(
      rows.map((r) => (r.status === 'conflict' ? { ...r, include: false } : r)),
      pc,
    );
    into.add.push(...ch.add);
  }
  return [...items.values()];
}

export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);
