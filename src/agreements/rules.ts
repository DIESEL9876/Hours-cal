/**
 * Applicability, verification and precedence of selected instruments (1.1.10).
 *
 * Selecting an instrument is reference only. A rule CLAUSE (hours / recuperation / travel) executes only when ALL hold:
 *   1. the instrument is in force on the date;
 *   2. a COMPLETE applicability confirmation exists for this employee — industry, occupation, employee class (not
 *      excluded by the instrument), confirmer, and explicit checks that the full current text, its amendments and its
 *      exclusion clauses were read (selection is not proof of applicability);
 *   3. that clause of that profile version was verified against the official text, with the clause reference and the
 *      date from which it applies (a whole-profile verification from 1.1.9 is no longer sufficient).
 * Otherwise the instrument is informational and the calculation is flagged for professional review.
 *
 * Several instruments regulating the same domain are never combined automatically: clauses must be read as a coherent
 * package, so the engine does not cherry-pick the most favourable value — the conflict is flagged instead.
 */
import type { AgreementClause, AgreementHoursRule, AgreementSelection, LocalDate } from '../engine';
import { LAW } from '../engine';
import { CATALOG_VERSION, catalogEntry, INSTRUMENT_TYPE_LABELS, PRECEDENCE, profileOn, type CatalogEntry, type RecuperationRule, type RuleProfileVersion, type TravelRule } from './catalog';

export interface ResolvedInstrument {
  id: string;
  name: string;
  typeLabel: string;
  version: string | null;
  verification: CatalogEntry['verification'];
  confirmed: boolean;
  /** Some clause is verified and executable. */
  verified: boolean;
  executable: boolean;
  /** Executable clauses on this date. */
  clauses: AgreementClause[];
  status: string;
}

export interface ResolvedRules {
  date: LocalDate;
  instruments: ResolvedInstrument[];
  hours: AgreementHoursRule | null;
  recuperation: { rule: RecuperationRule; source: string; executable: boolean } | null;
  travel: { rule: TravelRule; source: string; executable: boolean } | null;
  reviews: string[];
  notes: string[];
}

export const NOT_VERIFIED_TEXT = 'הוראות ההסכם טרם אומתו';
/** Required wording for an instrument whose source was located but whose calculation clauses were not verified. */
export const SOURCE_LOCATED_TEXT = 'המקור אותר; הוראות החישוב לא אומתו';
export const VERIFIED_RULES_TEXT = 'כללים מאומתים';
export const SCOPE_REVIEW_TEXT = 'תחולה בבדיקה';

export const CLAUSE_LABELS: Record<AgreementClause, string> = { hours: 'שעות עבודה ושעות נוספות', recuperation: 'דמי הבראה', travel: 'החזר נסיעות' };

/** Clauses a profile carries (only these can ever be verified/executed). */
export function profileClauses(p: RuleProfileVersion | null): AgreementClause[] {
  if (!p) return [];
  const out: AgreementClause[] = [];
  if (p.hours) out.push('hours');
  if (p.recuperation) out.push('recuperation');
  if (p.travel) out.push('travel');
  return out;
}

/** Why a confirmation is incomplete or blocked (empty = complete). */
export function confirmationProblems(sel: AgreementSelection, entry: CatalogEntry): string[] {
  const c = sel.confirmation;
  if (!c) return ['לא אושרה תחולה'];
  const out: string[] = [];
  if (!c.by?.trim() || !c.industry?.trim() || !c.occupation?.trim()) out.push('חסרים ענף, עיסוק או שם המאשר');
  if (!c.employeeClass) out.push('לא נבחר סיווג העובד');
  else if (entry.excludedClasses?.includes(c.employeeClass) || (entry.coveredClasses && !entry.coveredClasses.includes(c.employeeClass)))
    out.push('סיווג העובד אינו בתחולת המכשיר לפי הגדרותיו');
  if (!c.fullTextReviewed) out.push('לא אושרה קריאת הנוסח המלא והעדכני');
  if (!c.amendmentsChecked) out.push('לא נבדקו תיקונים וביטולים');
  if (!c.exclusionsChecked) out.push('לא נבדקו סעיפי החרגה');
  return out;
}

function clauseVerified(sel: AgreementSelection, profile: RuleProfileVersion, clause: AgreementClause, date: LocalDate): boolean {
  return !!sel.clauseVerifications?.some((v) => v.profileVersion === profile.version && v.clause === clause && !!v.by.trim() && !!v.clauseRef.trim() && !!v.effectiveFrom && date >= v.effectiveFrom);
}

export function resolveAgreements(selections: AgreementSelection[] | undefined, date: LocalDate): ResolvedRules {
  const out: ResolvedRules = { date, instruments: [], hours: null, recuperation: null, travel: null, reviews: [], notes: [] };
  const items = (selections ?? [])
    .map((sel) => ({ sel, entry: catalogEntry(sel.catalogId) }))
    .filter((x): x is { sel: AgreementSelection; entry: CatalogEntry } => !!x.entry)
    .sort((a, b) => PRECEDENCE[a.entry.type] - PRECEDENCE[b.entry.type]);
  const hoursCandidates: { entry: CatalogEntry; profile: RuleProfileVersion }[] = [];
  const recup: { rule: RecuperationRule; source: string; executable: boolean }[] = [];
  const travel: { rule: TravelRule; source: string; executable: boolean }[] = [];
  for (const { sel, entry } of items) {
    const profile = profileOn(entry, date);
    const problems = confirmationProblems(sel, entry);
    const confirmed = problems.length === 0;
    const inForce = (!entry.startDate || date >= entry.startDate) && (!entry.endDate || date <= entry.endDate);
    const clauses = confirmed && inForce && profile ? profileClauses(profile).filter((c) => clauseVerified(sel, profile, c, date)) : [];
    const executable = clauses.length > 0;
    let status: string;
    if (!inForce) status = 'אינו בתוקף בתאריך זה';
    else if (!sel.confirmation) status = `${SCOPE_REVIEW_TEXT} — טרם אושרה תחולה על העובד`;
    else if (!confirmed) status = `${SCOPE_REVIEW_TEXT}: ${problems.join('; ')}`;
    else if (executable) status = `${VERIFIED_RULES_TEXT}: ${clauses.map((c) => CLAUSE_LABELS[c]).join(', ')}`;
    else if (entry.evidence === 'directory_only' || entry.evidence === 'unapproved_secondary') status = `אין מקור מלא — ${NOT_VERIFIED_TEXT}; לשימוש כמידע בלבד`;
    else status = `${SOURCE_LOCATED_TEXT} — ${NOT_VERIFIED_TEXT}; לשימוש כמידע בלבד`;
    out.instruments.push({ id: entry.id, name: entry.name, typeLabel: INSTRUMENT_TYPE_LABELS[entry.type], version: profile?.version ?? null, verification: entry.verification, confirmed, verified: executable, executable, clauses, status });
    if (sel.confirmation && !executable && inForce) out.reviews.push(`${entry.name}: ${status} — החישוב דורש בדיקה מקצועית`);
    if (!profile || !inForce) continue;
    if (profile.hours && clauses.includes('hours')) hoursCandidates.push({ entry, profile });
    if (profile.recuperation) {
      const inYear = profile.recuperation.find((r) => date >= r.yearFrom && date <= r.yearTo);
      const rule = inYear ?? profile.recuperation[profile.recuperation.length - 1];
      if (!inYear) out.reviews.push(`תעריף יום ההבראה ${(rule.dayValueAgorot / 100).toFixed(2)} ₪ הוא האחרון שבקטלוג (לשנת ההבראה שהסתיימה ב-${rule.yearTo}); יש לבדוק אם פורסם תעריף חדש`);
      recup.push({ rule, source: entry.name, executable: clauses.includes('recuperation') });
    }
    if (profile.travel) travel.push({ rule: profile.travel, source: entry.name, executable: clauses.includes('travel') });
  }
  // Conflicts: never pick a value automatically across instruments.
  const pick = <T extends { executable: boolean; source: string }>(list: T[], label: string): T | null => {
    const exec = list.filter((x) => x.executable);
    if (exec.length > 1) {
      out.reviews.push(`כמה מכשירים מאומתים קובעים ${label} (${exec.map((x) => x.source).join(', ')}) — לא הוחל אף אחד; נדרשת הכרעה מקצועית (הסעיפים נקראים כמכלול)`);
      return null;
    }
    return exec[0] ?? list[0] ?? null;
  };
  out.recuperation = pick(recup, 'דמי הבראה');
  out.travel = pick(travel, 'החזר נסיעות');
  if (hoursCandidates.length > 1) out.reviews.push('כמה מכשירים מאומתים קובעים שעות עבודה — לא הוחל אף אחד מהם עד להכרעה מקצועית');
  else if (hoursCandidates.length === 1) {
    const { entry, profile } = hoursCandidates[0];
    const h = profile.hours!;
    if (h.weeklyThresholdMinutes > LAW.WEEKLY_REGULAR_MINUTES) out.reviews.push(`"${entry.name}" קובע שבוע ארוך מהחוק — לא הוחל (אין לגרוע מזכויות שבחוק)`);
    else
      out.hours = {
        from: profile.effectiveFrom ?? date,
        to: profile.effectiveTo,
        dailyThresholdMinutes: h.dailyThresholdMinutes,
        weeklyThresholdMinutes: h.weeklyThresholdMinutes,
        firstTierMinutes: h.firstTierMinutes,
        source: `${entry.name} (גרסה ${profile.version})`,
      };
  }
  for (const i of out.instruments) if (!i.executable && i.confirmed) out.notes.push(`${i.name}: ${i.status}`);
  return out;
}

/** Hours rules for the engine over a period (only executable, single-instrument clauses). */
export function agreementHoursFor(selections: AgreementSelection[] | undefined, from: LocalDate, to: LocalDate): AgreementHoursRule[] {
  const a = resolveAgreements(selections, from).hours;
  const b = resolveAgreements(selections, to).hours;
  const out: AgreementHoursRule[] = [];
  for (const r of [a, b]) if (r && !out.some((x) => x.source === r.source)) out.push(r);
  return out;
}

/** What is stored with a closed month: the catalog version and each employee's instrument / clause status. */
export function rulesSnapshot(perEmployee: { employeeId: string; selections: AgreementSelection[] | undefined }[], date: LocalDate) {
  return {
    catalogVersion: CATALOG_VERSION,
    minimumWageTable: '2026-04-01',
    employees: perEmployee
      .filter((e) => e.selections?.length)
      .map((e) => ({
        employeeId: e.employeeId,
        instruments: resolveAgreements(e.selections, date).instruments.map((i) => ({ id: i.id, version: i.version, executable: i.executable, clauses: i.clauses, verification: i.verification })),
        clauseVerifications: (e.selections ?? []).flatMap((s) => (s.clauseVerifications ?? []).map((v) => ({ catalogId: s.catalogId, ...v }))),
      })),
  };
}

/** Recuperation days for completed years of seniority (null before the first full year). */
export function recuperationDays(rule: RecuperationRule, completedYears: number): number | null {
  if (completedYears < 1) return null;
  let days: number | null = null;
  for (const [min, d] of rule.daysBySeniority) if (completedYears >= min) days = d;
  return days;
}
