/**
 * "בחירת הסכם קיבוצי או צו הרחבה" — searchable offline seed catalog, per employee (1.1.9, revised 1.1.10).
 *
 * Selecting an instrument is reference only. A clause becomes active only after a COMPLETE applicability confirmation
 * (employee class, full current text, amendments and exclusions) AND a verification of that clause against the
 * official text with its clause reference and effective date. Extension orders, collective agreements and wage notices
 * are shown separately; the catalog is partial and the official directories can be opened from here.
 */
import { useMemo, useState } from 'react';
import type { AgreementClause, AgreementSelection, ClauseVerification, EmployeeClass, TranscribedValues } from '../engine';
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
  TRANSCRIBABLE,
  TRANSCRIBED_VERSION,
  transcribedProblems,
  UNLISTED_ID,
  type CatalogEntry,
  type InstrumentFamily,
  SECTOR_LABELS,
  type Sector,
} from '../agreements';
import { Badge, Button, Field, Modal } from './components';
import { formatDateHe } from './format';

const today = () => new Date().toISOString().slice(0, 10);
const FAMILIES: (InstrumentFamily | 'all')[] = ['all', 'extension_order', 'collective_agreement', 'wage_notice'];

export function AgreementPicker({ value, onChange, employmentStart }: { value: AgreementSelection[]; onChange: (v: AgreementSelection[]) => void; employmentStart: string | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<InstrumentFamily | 'all'>('all');
  const [sector, setSector] = useState<Sector | 'all'>('all');
  const [confirming, setConfirming] = useState<AgreementSelection | null>(null);
  const results = useMemo(() => searchCatalog(query, family, sector), [query, family, sector]);
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select className="field-input !w-auto" value={sector} onChange={(e) => setSector(e.target.value as Sector | 'all')} aria-label="ענף">
              <option value="all">כל הענפים</option>
              {(Object.keys(SECTOR_LABELS) as Sector[]).map((k) => (
                <option key={k} value={k}>
                  {SECTOR_LABELS[k]}
                </option>
              ))}
            </select>
            <span className="text-[11.5px] text-ink-soft">{results.length} תוצאות</span>
          </div>
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
                      ענף: {SECTOR_LABELS[e.sector]} · סוג מסמך: {INSTRUMENT_TYPE_LABELS[e.type]} · מועד פרסום: {e.publicationYear ?? 'לא אומת'} · {e.officialNumber ? `מס׳ ${e.officialNumber}` : 'מספר רשמי: לא אומת'}
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
                <span className="font-medium">
                  {sel.title ?? e.name}
                  {sel.registrationNumber ? ` (מס׳ רישום ${sel.registrationNumber})` : ''}
                </span>
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
  const [title, setTitle] = useState(selection.title ?? '');
  const [regNo, setRegNo] = useState(selection.registrationNumber ?? '');
  const unlisted = selection.catalogId === UNLISTED_ID;
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
    ...(unlisted ? { title: title.trim() || undefined, registrationNumber: regNo.trim() || undefined } : {}),
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
  const ready = employerOk && !!by.trim() && !!industry.trim() && !!occupation.trim() && !!employeeClass && !blocked && (!unlisted || !!title.trim());
  const [transcribed, setTranscribed] = useState<ClauseVerification[]>(() => (selection.clauseVerifications ?? []).filter((v) => v.profileVersion === TRANSCRIBED_VERSION));
  const verifications = (): ClauseVerification[] => {
    const kept = (selection.clauseVerifications ?? []).filter((v) => v.profileVersion !== p?.version && v.profileVersion !== TRANSCRIBED_VERSION);
    const fresh = clauses
      .filter((cl) => cv[cl]?.clauseRef.trim() && cv[cl]?.effectiveFrom && cv[cl]?.by.trim())
      .map((cl) => ({ profileVersion: p!.version, clause: cl as AgreementClause, clauseRef: cv[cl].clauseRef.trim(), effectiveFrom: cv[cl].effectiveFrom, by: cv[cl].by.trim(), at: new Date().toISOString() }));
    return [...kept, ...fresh, ...transcribed];
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
        {unlisted && (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-line p-3">
            <Field label="שם ההסכם / הצו כפי שהוא רשום (חובה)">
              <input className="field-input" value={title} onChange={(x) => setTitle(x.target.value)} aria-label="שם ההסכם" />
            </Field>
            <Field label="מספר רישום (פנקס ההסכמים הקיבוציים)">
              <input className="field-input num" value={regNo} onChange={(x) => setRegNo(x.target.value)} aria-label="מספר רישום ההסכם" />
            </Field>
          </div>
        )}
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
          <div className="rounded-lg bg-slate-50 p-3 text-ink-soft">אין במכשיר זה סעיפי חישוב מקודדים בקטלוג.</div>
        )}
        <TranscribedClauses list={transcribed} onChange={setTranscribed} />
      </div>
    </Modal>
  );
}

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const toHM = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
function parseHM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}
const pctOf = (s: string) => (/^\d{1,3}$/.test(s.trim()) ? +s.trim() : NaN);

function describe(c: ClauseVerification): string {
  const v = c.values ?? {};
  switch (c.clause) {
    case 'hours':
      return v.hours ? `ימים: ${v.hours.dailyThresholdMinutes.map(toHM).join(' / ')} · שבוע ${toHM(v.hours.weeklyThresholdMinutes)} · מדרגה ראשונה ${toHM(v.hours.firstTierMinutes)}` : '';
    case 'overtime_rates':
      return v.overtimeRates ? `${v.overtimeRates.tier1Percent}% / ${v.overtimeRates.tier2Percent}%` : '';
    case 'rest_holiday_rates':
      return v.restHolidayRates ? `מנוחה ${v.restHolidayRates.restPercent}% · חג ${v.restHolidayRates.holidayPercent}%` : '';
    case 'night_premium':
      return v.nightPremium ? `משעה ${toHM(v.nightPremium.startMinute)} עד ${toHM(v.nightPremium.endMinute)} · תוספת ${v.nightPremium.percent}%` : '';
    case 'minimum_wage':
      return v.minimumHourlyAgorot ? `₪${(v.minimumHourlyAgorot / 100).toFixed(2)} לשעה` : '';
    default:
      return '';
  }
}

/**
 * 1.1.11: a payroll professional transcribes a calculation clause from the OFFICIAL text (clause reference, effective
 * dates, values). It is applied only together with a complete applicability confirmation; values below the statute
 * are rejected; two instruments for the same domain block each other.
 */
function TranscribedClauses({ list, onChange }: { list: ClauseVerification[]; onChange: (l: ClauseVerification[]) => void }) {
  const [clause, setClause] = useState<AgreementClause>('overtime_rates');
  const [ref, setRef] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [by, setBy] = useState('');
  const [copied, setCopied] = useState(false);
  const [f, setF] = useState<Record<string, string>>({ t1: '125', t2: '150', rest: '150', hol: '150', ns: '22:00', ne: '06:00', np: '', min: '', week: '42:00', tier: '2:00', d0: '8:36', d1: '8:36', d2: '8:36', d3: '8:36', d4: '7:36', d5: '0:00', d6: '0:00' });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const values = (): TranscribedValues => {
    switch (clause) {
      case 'hours':
        return { hours: { dailyThresholdMinutes: [0, 1, 2, 3, 4, 5, 6].map((i) => parseHM(f[`d${i}`]) ?? -1), weeklyThresholdMinutes: parseHM(f.week) ?? -1, firstTierMinutes: parseHM(f.tier) ?? -1 } };
      case 'overtime_rates':
        return { overtimeRates: { tier1Percent: pctOf(f.t1), tier2Percent: pctOf(f.t2) } };
      case 'rest_holiday_rates':
        return { restHolidayRates: { restPercent: pctOf(f.rest), holidayPercent: pctOf(f.hol) } };
      case 'night_premium':
        return { nightPremium: { startMinute: parseHM(f.ns) ?? -1, endMinute: parseHM(f.ne) ?? -1, percent: pctOf(f.np) } };
      case 'minimum_wage': {
        const n = Number(f.min.replace(',', '.'));
        return { minimumHourlyAgorot: Number.isFinite(n) && n > 0 ? Math.round(n * 100) : NaN };
      }
      default:
        return {};
    }
  };
  const problems = transcribedProblems(clause, values());
  const ready = copied && !!ref.trim() && !!from && !!by.trim() && (!to || to >= from) && problems.length === 0;
  const input = (k: string, label: string, w = 'w-20') => (
    <Field label={label}>
      <input className={`field-input num ${w} text-left`} value={f[k]} onChange={(e) => set(k, e.target.value)} aria-label={label} />
    </Field>
  );
  return (
    <div className="rounded-lg border border-line p-3" data-testid="transcribed-clauses">
      <div className="font-medium">סעיפי חישוב שהוזנו מהנוסח הרשמי</div>
      <p className="text-[12px] text-ink-soft">
        לשימוש איש/אשת מקצוע שקרא/ה את הנוסח הרשמי: מזינים את מספר הסעיף, תוקפו והערכים כפי שהם מופיעים בנוסח. הסעיף ישפיע על החישוב רק לאחר אישור תחולה מלא. ערכים נמוכים מהחוק נדחים; שני מכשירים לאותו נושא — אף אחד לא יוחל.
      </p>
      {list.length > 0 && (
        <ul className="my-2 space-y-1">
          {list.map((c, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 rounded bg-slate-50 px-2 py-1 text-[12.5px]" data-testid="transcribed-clause">
              <b>{CLAUSE_LABELS[c.clause]}</b>
              <span>{describe(c)}</span>
              <span className="text-ink-soft">
                {c.clauseRef} · {c.effectiveFrom}
                {c.effectiveTo ? `–${c.effectiveTo}` : ''} · {c.by}
              </span>
              <Button size="sm" variant="ghost" className="ms-auto text-red-600" onClick={() => onChange(list.filter((_, j) => j !== i))}>
                הסרה
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 grid grid-cols-4 gap-2">
        <Field label="סוג הסעיף">
          <select className="field-input" value={clause} onChange={(e) => setClause(e.target.value as AgreementClause)} aria-label="סוג הסעיף">
            {TRANSCRIBABLE.map((c) => (
              <option key={c} value={c}>
                {CLAUSE_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="סעיף בנוסח הרשמי">
          <input className="field-input" value={ref} onChange={(e) => setRef(e.target.value)} aria-label="מספר הסעיף" />
        </Field>
        <Field label="חל מתאריך">
          <input type="date" className="field-input num" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="סעיף חל מתאריך" />
        </Field>
        <Field label="עד תאריך (לא חובה)">
          <input type="date" className="field-input num" value={to} onChange={(e) => setTo(e.target.value)} aria-label="סעיף חל עד תאריך" />
        </Field>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        {clause === 'overtime_rates' && (
          <>
            {input('t1', 'מדרגה ראשונה (%)')}
            {input('t2', 'מדרגה שנייה (%)')}
          </>
        )}
        {clause === 'rest_holiday_rates' && (
          <>
            {input('rest', 'מנוחה שבועית (%)')}
            {input('hol', 'חג (%)')}
          </>
        )}
        {clause === 'night_premium' && (
          <>
            {input('ns', 'משעה')}
            {input('ne', 'עד שעה')}
            {input('np', 'תוספת (%)')}
          </>
        )}
        {clause === 'minimum_wage' && input('min', 'שכר מינימום ענפי לשעה (₪)', 'w-28')}
        {clause === 'hours' && (
          <>
            {DAY_NAMES.map((d, i) => input(`d${i}`, d, 'w-16'))}
            {input('week', 'תקן שבועי')}
            {input('tier', 'מדרגת 125%')}
          </>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Field label="הוזן ונבדק על ידי">
          <input className="field-input" value={by} onChange={(e) => setBy(e.target.value)} aria-label="מזין הסעיף" />
        </Field>
        <label className="flex items-end gap-2 pb-2">
          <input type="checkbox" className="h-4 w-4 accent-brand" checked={copied} onChange={(e) => setCopied(e.target.checked)} aria-label="הערכים הועתקו מהנוסח הרשמי" />
          <span>הערכים הועתקו מהנוסח הרשמי של הסעיף, בתוקף לתקופה שצוינה</span>
        </label>
      </div>
      {problems.length > 0 && <div className="mt-1 text-[12px] text-amber-800">{problems.join('; ')}</div>}
      <Button
        size="sm"
        className="mt-2"
        disabled={!ready}
        data-testid="add-transcribed-clause"
        onClick={() => {
          onChange([...list, { profileVersion: TRANSCRIBED_VERSION, clause, clauseRef: ref.trim(), effectiveFrom: from, effectiveTo: to || null, by: by.trim(), at: new Date().toISOString(), values: values() }]);
          setRef('');
          setCopied(false);
        }}
      >
        הוספת הסעיף
      </Button>
    </div>
  );
}
