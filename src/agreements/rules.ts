/**
 * Applicability and precedence of selected agreements (1.1.9).
 *
 * Order (lowest → highest): statute → general extension order → industry extension order → general collective
 * agreement → special collective agreement → (personal contract, entered in the employee settings).
 * A higher layer may only IMPROVE on statutory minimums. Rules are executable only when:
 *   1. the employee-level applicability confirmation exists, and
 *   2. the profile version is verified against the official text (catalog 'primary', or a recorded professional
 *      verification of exactly that version).
 * Several instruments regulating the same domain are never mixed silently: hours rules from two instruments block
 * each other (review); monetary values take the most favourable figure and are flagged for review.
 */
import type { AgreementHoursRule, AgreementSelection, LocalDate } from '../engine';
import { LAW } from '../engine';
import { CATALOG_VERSION, catalogEntry, INSTRUMENT_TYPE_LABELS, PRECEDENCE, profileOn, type CatalogEntry, type RecuperationRule, type RuleProfileVersion, type TravelRule } from './catalog';

export interface ResolvedInstrument {
  id: string;
  name: string;
  typeLabel: string;
  version: string | null;
  verification: CatalogEntry['verification'];
  confirmed: boolean;
  verified: boolean;
  executable: boolean;
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

function isVerified(sel: AgreementSelection, _entry: CatalogEntry, profile: RuleProfileVersion | null): boolean {
  if (!profile) return false;
  if (profile.verification === 'primary') return true;
  return !!sel.professionalVerification && sel.professionalVerification.version === profile.version && !!sel.professionalVerification.by.trim();
}

export function resolveAgreements(selections: AgreementSelection[] | undefined, date: LocalDate): ResolvedRules {
  const out: ResolvedRules = { date, instruments: [], hours: null, recuperation: null, travel: null, reviews: [], notes: [] };
  const items = (selections ?? [])
    .map((sel) => ({ sel, entry: catalogEntry(sel.catalogId) }))
    .filter((x): x is { sel: AgreementSelection; entry: CatalogEntry } => !!x.entry)
    .sort((a, b) => PRECEDENCE[a.entry.type] - PRECEDENCE[b.entry.type]);
  const hoursCandidates: { entry: CatalogEntry; profile: RuleProfileVersion }[] = [];
  for (const { sel, entry } of items) {
    const profile = profileOn(entry, date);
    const confirmed = !!sel.confirmation;
    const inForce = (!entry.startDate || date >= entry.startDate) && (!entry.endDate || date <= entry.endDate);
    const verified = isVerified(sel, entry, profile);
    const executable = confirmed && verified && inForce && !!profile;
    let status: string;
    if (!inForce) status = 'אינו בתוקף בתאריך זה';
    else if (!profile) status = `${NOT_VERIFIED_TEXT} — לשימוש כמידע בלבד`;
    else if (!confirmed) status = 'ממתין לאישור תחולה על העובד';
    else if (!verified) status = `${NOT_VERIFIED_TEXT} מול הנוסח הרשמי — הכללים אינם מופעלים`;
    else status = 'מאושר ומופעל בחישוב';
    out.instruments.push({ id: entry.id, name: entry.name, typeLabel: INSTRUMENT_TYPE_LABELS[entry.type], version: profile?.version ?? null, verification: entry.verification, confirmed, verified, executable, status });
    if (!profile || !inForce) continue;
    if (profile.hours && executable) hoursCandidates.push({ entry, profile });
    if (profile.recuperation) {
      const inYear = profile.recuperation.find((r) => date >= r.yearFrom && date <= r.yearTo);
      const rule = inYear ?? profile.recuperation[profile.recuperation.length - 1];
      if (!inYear) out.reviews.push(`תעריף יום ההבראה ${(rule.dayValueAgorot / 100).toFixed(2)} ₪ הוא האחרון שפורסם בקטלוג (לשנת ההבראה שהסתיימה ב-${rule.yearTo}); יש לבדוק אם פורסם תעריף חדש`);
      if (!out.recuperation || rule.dayValueAgorot > out.recuperation.rule.dayValueAgorot) {
        if (out.recuperation) out.reviews.push('כמה מקורות קובעים דמי הבראה — הוצג הערך המיטיב; יש לבדוק שאין מניעה לשלב ביניהם');
        out.recuperation = { rule, source: entry.name, executable };
      }
    }
    if (profile.travel) {
      if (!out.travel || profile.travel.dailyCapAgorot > out.travel.rule.dailyCapAgorot) out.travel = { rule: profile.travel, source: entry.name, executable };
    }
  }
  if (hoursCandidates.length > 1) out.reviews.push('כמה הסכמים מאומתים קובעים שעות עבודה — לא הוחל אף אחד מהם עד להכרעה מקצועית');
  else if (hoursCandidates.length === 1) {
    const { entry, profile } = hoursCandidates[0];
    const h = profile.hours!;
    if (h.weeklyThresholdMinutes > LAW.WEEKLY_REGULAR_MINUTES) out.reviews.push(`ההסכם "${entry.name}" קובע שבוע ארוך מהחוק — לא הוחל (אין לגרוע מזכויות שבחוק)`);
    else
      out.hours = {
        from: profile.effectiveFrom,
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

/** Hours rules for the engine over a period (only executable, single-instrument profiles). */
export function agreementHoursFor(selections: AgreementSelection[] | undefined, from: LocalDate, to: LocalDate): AgreementHoursRule[] {
  const a = resolveAgreements(selections, from).hours;
  const b = resolveAgreements(selections, to).hours;
  const out: AgreementHoursRule[] = [];
  for (const r of [a, b]) if (r && !out.some((x) => x.source === r.source)) out.push(r);
  return out;
}

/** What is stored with a closed month: the catalog version and each employee's rule-profile versions. */
export function rulesSnapshot(perEmployee: { employeeId: string; selections: AgreementSelection[] | undefined }[], date: LocalDate) {
  return {
    catalogVersion: CATALOG_VERSION,
    youthRules: 'youth-2026.11 (secondary sources)',
    minimumWageTable: '2026-04-01',
    employees: perEmployee
      .filter((e) => e.selections?.length)
      .map((e) => ({
        employeeId: e.employeeId,
        instruments: resolveAgreements(e.selections, date).instruments.map((i) => ({ id: i.id, version: i.version, executable: i.executable, verification: i.verification })),
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
