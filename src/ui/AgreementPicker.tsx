/**
 * "בחירת הסכם קיבוצי או צו הרחבה" — searchable offline seed catalog, per employee (1.1.9, revised 1.1.10).
 *
 * Selecting an instrument is reference only. A clause becomes active only after a COMPLETE applicability confirmation
 * (employee class, full current text, amendments and exclusions) AND a verification of that clause against the
 * official text with its clause reference and effective date. Extension orders, collective agreements and wage notices
 * are shown separately; the catalog is partial and the official directories can be opened from here.
 */
import { useMemo, useState } from 'react';
import type { AgreementClause, AgreementSelection, ClauseVerification, EmployeeClass } from '../engine';
import {
  CATALOG_STATUS_LABELS,
  CATALOG_VERSION,
  catalogEntry,
  catalogStatus,
  CLAUSE_LABELS,
  confirmationProblems,
  EMPLOYEE_CLASS_LABELS,
  EVIDENCE_LABELS,
  FAMILY_LABELS,
  FAMILY_OF,
  INSTRUMENT_TYPE_LABELS,
  isAmended,
  NOT_VERIFIED_TEXT,
  OFFICIAL_LINKS,
  profileClauses,
  profileOn,
  resolveAgreements,
  searchCatalog,
  SOURCE_LOCATED_TEXT,
  UNLISTED_ID,
  type CatalogEntry,
  type InstrumentFamily,
} from '../agreements';
import { Badge, Button, Field, Modal } from './components';
import { formatDateHe } from './format';

const today = () => new Date().toISOString().slice(0, 10);
const FAMILIES: (InstrumentFamily | 'all')[] = ['all', 'extension_order', 'collective_agreement', 'wage_notice'];

export function AgreementPicker({ value, onChange, employmentStart }: { value: AgreementSelection[]; onChange: (v: AgreementSelection[]) => void; employmentStart: string | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<InstrumentFamily | 'all'>('all');
  const [confirming, setConfirming] = useState<AgreementSelection | null>(null);
  const results = useMemo(() => searchCatalog(query, family), [query, family]);
  const chosen = new Set(value.map((v) => v.catalogId));
  const resolved = useMemo(() => resolveAgreements(value, today()), [value]);

  const update = (sel: AgreementSelection) => onChange(value.map((v) => (v.catalogId === sel.catalogId ? sel : v)));

  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-medium">הסכם קיבוצי / צו הרחבה (לעובד זה)</span>
      <button type="button" className="field-input flex w-full items-center justify-between text-right text-ink-soft" onClick={() => setOpen((x) => !x)} data-testid="agreement-field">
        <span>{value.length ? `${value.length} נבחרו` : 'בחירת הסכם קיבוצי או צו הרחבה'}</span>
        <span className="text-[11px]">▾</span>
      </button>
      {open && (
        <div className="mt-1 rounded-xl border border-line bg-white p-3 shadow-lg" data-testid="agreement-dropdown">
          <input className="field-input" autoFocus placeholder="חיפוש לפי שם ההסכם, הענף או מספר ההסכם" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="חיפוש הסכם" />
          <div className="mt-2 flex flex-wrap gap-1" role="radiogroup" aria-label="סוג מסמך">
            {FAMILIES.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={family === f}
                className={`rounded-full border px-2.5 py-0.5 text-[12px] ${family === f ? 'border-brand bg-brand/10 text-brand' : 'border-line text-ink-soft'}`}
                onClick={() => setFamily(f)}
              >
                {f === 'all' ? 'הכל' : FAMILY_LABELS[f]}
              </button>
            ))}
          </div>
          <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
            {results.map((e) => (
              <li key={e.id} className="rounded-lg border border-line/70 p-2 text-[13px]" data-testid="agreement-option">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{e.name}</div>
                    <div className="text-[12px] text-ink-soft">
                      סוג מסמך: {INSTRUMENT_TYPE_LABELS[e.type]} · מועד פרסום: {e.publicationYear ?? 'לא אומת'} · {e.officialNumber ? `מס׳ ${e.officialNumber}` : 'מספר רשמי: לא אומת'}
                      {e.researchId ? ` · ${e.researchId}` : ''}
                    </div>
                    <div className="text-[12px] text-ink-soft">תחולה: {e.employers}</div>
                    <div className="text-[11.5px] text-ink-soft">{e.sourceNote}</div>
                    <a className="text-[11.5px] text-brand hover:underline" href={e.sourceUrl} target="_blank" rel="noreferrer">
                      מקור ממשלתי
                    </a>
                    <span className="text-[11px] text-ink-soft">
                      {' '}
                      · {EVIDENCE_LABELS[e.evidence]} · נבדק לאחרונה {formatDateHe(e.lastVerified)}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone="amber">{CATALOG_STATUS_LABELS[catalogStatus(e)]}</Badge>
                    {isAmended(e) && <Badge tone="blue">הוחלף/תוקן</Badge>}
                    <span className="text-[11px] text-ink-soft" data-testid="calc-status">
                      סטטוס חישוב: {SOURCE_LOCATED_TEXT}
                    </span>
                    <Button size="sm" disabled={chosen.has(e.id)} onClick={() => onChange([...value, { catalogId: e.id }])}>
                      {chosen.has(e.id) ? 'נבחר' : 'בחירה'}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
            {!results.length && (
              <li className="p-2 text-center text-[13px] text-ink-soft">
                {family === 'collective_agreement' ? 'אין הסכמים קיבוציים בקטלוג המקומי — ניתן לרשום "הסכם שאינו ברשימה"' : 'לא נמצאו תוצאות בקטלוג המקומי'}
              </li>
            )}
          </ul>
          <div className="mt-2 space-y-1 border-t border-line pt-2">
            <div className="flex items-center justify-between">
              <Button size="sm" variant="ghost" disabled={chosen.has(UNLISTED_ID)} onClick={() => onChange([...value, { catalogId: UNLISTED_ID }])}>
                הסכם שאינו ברשימה — לבדיקה ידנית
              </Button>
              <span className="text-[11px] text-ink-soft">גרסת קטלוג {CATALOG_VERSION} · קטלוג חלקי — אינו מאגר רשמי מלא</span>
            </div>
            <div className="flex flex-wrap gap-x-3 text-[11.5px]" data-testid="official-links">
              {OFFICIAL_LINKS.map((l) => (
                <a key={l.url} className="text-brand hover:underline" href={l.url} target="_blank" rel="noreferrer">
                  {l.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
      {value.length > 0 && (
        <ul className="mt-2 space-y-1.5" data-testid="agreement-selected">
          {value.map((sel) => {
            const e = catalogEntry(sel.catalogId);
            if (!e) return null;
            const r = resolved.instruments.find((i) => i.id === e.id);
            const status = r?.status ?? NOT_VERIFIED_TEXT;
            return (
              <li key={sel.catalogId} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[13px]">
                <span className="font-medium">{e.name}</span>
                <Badge tone={r?.executable ? 'green' : 'amber'}>{status}</Badge>
                <span className="ms-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(sel)}>
                    {sel.confirmation ? 'פרטי תחולה ואימות' : 'אישור תחולה'}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-red-600" onClick={() => onChange(value.filter((v) => v.catalogId !== sel.catalogId))}>
                    הסרה
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {confirming && (
        <ApplicabilityDialog
          selection={confirming}
          employmentStart={employmentStart}
          onClose={() => setConfirming(null)}
          onSave={(sel) => {
            update(sel);
            setConfirming(null);
          }}
        />
      )}
    </div>
  );
}

function ApplicabilityDialog({ selection, employmentStart, onClose, onSave }: { selection: AgreementSelection; employmentStart: string | null; onClose: () => void; onSave: (s: AgreementSelection) => void }) {
  const e = catalogEntry(selection.catalogId)! as CatalogEntry;
  const p = profileOn(e, today());
  const c = selection.confirmation;
  const [industry, setIndustry] = useState(c?.industry ?? '');
  const [occupation, setOccupation] = useState(c?.occupation ?? '');
  const [start, setStart] = useState(c?.employmentStart ?? employmentStart ?? '');
  const [by, setBy] = useState(c?.by ?? '');
  const [note, setNote] = useState(c?.note ?? '');
  const [employeeClass, setEmployeeClass] = useState<EmployeeClass | ''>(c?.employeeClass ?? '');
  const [employerUnit, setEmployerUnit] = useState(c?.employerUnit ?? '');
  const [workSite, setWorkSite] = useState(c?.workSite ?? '');
  const [fullText, setFullText] = useState(!!c?.fullTextReviewed);
  const [amendments, setAmendments] = useState(!!c?.amendmentsChecked);
  const [exclusions, setExclusions] = useState(!!c?.exclusionsChecked);
  const [employerOk, setEmployerOk] = useState(!!c);
  const clauses = profileClauses(p);
  const [cv, setCv] = useState<Record<string, { clauseRef: string; effectiveFrom: string; by: string }>>(() =>
    Object.fromEntries(
      clauses.map((cl) => {
        const v = selection.clauseVerifications?.find((x) => x.clause === cl && x.profileVersion === p?.version);
        return [cl, { clauseRef: v?.clauseRef ?? '', effectiveFrom: v?.effectiveFrom ?? '', by: v?.by ?? '' }];
      }),
    ),
  );
  const draft: AgreementSelection = {
    ...selection,
    confirmation: {
      by: by.trim(),
      at: new Date().toISOString(),
      industry: industry.trim(),
      occupation: occupation.trim(),
      employmentStart: start || null,
      note: note.trim() || undefined,
      employeeClass: employeeClass || undefined,
      employerUnit: employerUnit.trim() || undefined,
      workSite: workSite.trim() || undefined,
      fullTextReviewed: fullText,
      amendmentsChecked: amendments,
      exclusionsChecked: exclusions,
    },
  };
  const problems = confirmationProblems(draft, e);
  const blocked = problems.includes('סיווג העובד אינו בתחולת המכשיר לפי הגדרותיו');
  const ready = employerOk && !!by.trim() && !!industry.trim() && !!occupation.trim() && !!employeeClass && !blocked;
  const verifications = (): ClauseVerification[] => {
    const kept = (selection.clauseVerifications ?? []).filter((v) => v.profileVersion !== p?.version);
    const fresh = clauses
      .filter((cl) => cv[cl]?.clauseRef.trim() && cv[cl]?.effectiveFrom && cv[cl]?.by.trim())
      .map((cl) => ({ profileVersion: p!.version, clause: cl as AgreementClause, clauseRef: cv[cl].clauseRef.trim(), effectiveFrom: cv[cl].effectiveFrom, by: cv[cl].by.trim(), at: new Date().toISOString() }));
    return [...kept, ...fresh];
  };
  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-2xl"
      title={<span>אישור תחולה — {e.name}</span>}
      footer={
        <>
          <Button variant="primary" disabled={!ready} data-testid="confirm-applicability" onClick={() => onSave({ ...draft, clauseVerifications: verifications() })}>
            שמירת התחולה
          </Button>
          {selection.confirmation && (
            <Button variant="ghost" onClick={() => onSave({ catalogId: selection.catalogId })}>
              ביטול האישור
            </Button>
          )}
          <Button onClick={onClose}>סגירה</Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <div className="rounded-lg bg-slate-50 p-3">
          <div>
            {INSTRUMENT_TYPE_LABELS[e.type]} ({FAMILY_LABELS[FAMILY_OF[e.type]]}) · {e.industry} · חל על: {e.employers} · עיסוקים: {e.occupations}
          </div>
          <div>
            תוקף: {e.startDate ? formatDateHe(e.startDate) : 'לא אומת'} – {e.endDate ? formatDateHe(e.endDate) : 'ללא מועד סיום ידוע'} · {EVIDENCE_LABELS[e.evidence]}
          </div>
          {e.history.map((h) => (
            <div key={h} className="text-ink-soft">
              • {h}
            </div>
          ))}
          {e.relations.map((r) => (
            <div key={r.kind + r.id} className="text-ink-soft">
              • {r.kind === 'amended_by' ? 'תוקן/הוחלף על ידי' : r.kind === 'amends' ? 'מתקן את' : r.kind === 'wage_update' ? 'עדכון שכר' : 'מעדכן את'}: {catalogEntry(r.id)?.name ?? r.id}
              {r.note ? ` (${r.note})` : ''}
            </div>
          ))}
          <div className="text-ink-soft">{e.sourceNote}</div>
        </div>
        <p className="text-ink-soft">בחירת מכשיר אינה הוכחה שהוא חל על העובד. יש לבדוק ולאשר:</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="ענף העסק">
            <input className="field-input" value={industry} onChange={(x) => setIndustry(x.target.value)} aria-label="ענף העסק" />
          </Field>
          <Field label="עיסוק / סיווג העובד">
            <input className="field-input" value={occupation} onChange={(x) => setOccupation(x.target.value)} aria-label="עיסוק העובד" />
          </Field>
          <Field label="סיווג העובד לעניין התחולה">
            <select className="field-input" value={employeeClass} onChange={(x) => setEmployeeClass(x.target.value as EmployeeClass | '')} aria-label="סיווג העובד">
              <option value="">— בחירה —</option>
              {(Object.keys(EMPLOYEE_CLASS_LABELS) as EmployeeClass[]).map((k) => (
                <option key={k} value={k}>
                  {EMPLOYEE_CLASS_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="מעסיק / מפעל / ארגון מעסיקים">
            <input className="field-input" value={employerUnit} onChange={(x) => setEmployerUnit(x.target.value)} aria-label="מעסיק או ארגון מעסיקים" />
          </Field>
          <Field label="אתר / מקום העבודה">
            <input className="field-input" value={workSite} onChange={(x) => setWorkSite(x.target.value)} aria-label="אתר העבודה" />
          </Field>
          <Field label="תאריך תחילת העסקה">
            <input type="date" className="field-input num" value={start} onChange={(x) => setStart(x.target.value)} aria-label="תאריך תחילת העסקה" />
          </Field>
          <Field label="שם המאשר/ת">
            <input className="field-input" value={by} onChange={(x) => setBy(x.target.value)} aria-label="שם המאשר" />
          </Field>
          <Field label="הערה (לא חובה)">
            <input className="field-input" value={note} onChange={(x) => setNote(x.target.value)} />
          </Field>
        </div>
        {blocked && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-red-800" data-testid="applicability-blocked">
            העובד/ת בסיווג שאינו בתחולת המכשיר לפי הגדרותיו ({EMPLOYEE_CLASS_LABELS[employeeClass as EmployeeClass]}) — לא ניתן לאשר תחולה.
          </div>
        )}
        <div className="space-y-1">
          {(
            [
              [employerOk, setEmployerOk, 'המעסיק והעובד בתחולת ההסכם', 'בדקתי שהמעסיק והעובד נכללים בתחולה (ענף, ארגון מעסיקים/מפעל, עיסוק, אתר, תקופה).'],
              [fullText, setFullText, 'קראתי את הנוסח המלא', 'קראתי את הנוסח המלא והעדכני, כולל נספחים.'],
              [amendments, setAmendments, 'נבדקו תיקונים', 'בדקתי תיקונים, הארכות וביטולים מאוחרים.'],
              [exclusions, setExclusions, 'נבדקו החרגות', 'בדקתי את סעיפי ההחרגה (למשל עובדי משרד, עובדי קבלן).'],
            ] as const
          ).map(([v, set, label, text]) => (
            <label key={label} className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={v} onChange={(x) => set(x.target.checked)} aria-label={label} />
              <span>{text}</span>
            </label>
          ))}
        </div>
        {problems.length > 0 && !blocked && <div className="text-[12px] text-amber-800">עד להשלמה: {problems.join('; ')} — המכשיר יוצג כ"תחולה בבדיקה" ולא ישפיע על החישוב.</div>}
        {p && clauses.length > 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="font-medium text-amber-900">
              אימות סעיפי חישוב — גרסה {p.version}: {SOURCE_LOCATED_TEXT}
            </div>
            <div className="text-amber-900">{p.summary}</div>
            <p className="mt-1 text-[12px] text-amber-900">כל סעיף מופעל רק לאחר אימות מול הנוסח הרשמי: מספר הסעיף, המועד שממנו הוא חל ושם הבודק/ת.</p>
            {clauses.map((cl) => (
              <div key={cl} className="mt-2 grid grid-cols-3 gap-2" data-testid={`clause-${cl}`}>
                <Field label={`${CLAUSE_LABELS[cl]} — סעיף בנוסח`}>
                  <input className="field-input" value={cv[cl]?.clauseRef ?? ''} onChange={(x) => setCv({ ...cv, [cl]: { ...cv[cl], clauseRef: x.target.value } })} aria-label={`סעיף ${CLAUSE_LABELS[cl]}`} />
                </Field>
                <Field label="חל מתאריך">
                  <input type="date" className="field-input num" value={cv[cl]?.effectiveFrom ?? ''} onChange={(x) => setCv({ ...cv, [cl]: { ...cv[cl], effectiveFrom: x.target.value } })} aria-label={`תחולת ${CLAUSE_LABELS[cl]}`} />
                </Field>
                <Field label="נבדק על ידי">
                  <input className="field-input" value={cv[cl]?.by ?? ''} onChange={(x) => setCv({ ...cv, [cl]: { ...cv[cl], by: x.target.value } })} aria-label={`בודק ${CLAUSE_LABELS[cl]}`} />
                </Field>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-slate-50 p-3 text-ink-soft">אין במכשיר זה סעיפי חישוב מקודדים — הוא מוצג לעיון בלבד ואינו משפיע על החישוב.</div>
        )}
      </div>
    </Modal>
  );
}
