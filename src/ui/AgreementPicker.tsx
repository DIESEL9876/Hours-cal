/**
 * "בחירת הסכם קיבוצי או צו הרחבה" (1.1.9) — searchable offline catalog, per employee.
 * Selecting an instrument is reference only; its rules become active only after the applicability confirmation AND
 * a verification of the rule-profile version (catalog primary source or a named payroll professional).
 */
import { useMemo, useState } from 'react';
import type { AgreementSelection } from '../engine';
import { CATALOG_VERSION, catalogEntry, INSTRUMENT_TYPE_LABELS, NOT_VERIFIED_TEXT, profileOn, searchCatalog, UNLISTED_ID, type CatalogEntry } from '../agreements';
import { Badge, Button, Field, Modal } from './components';
import { formatDateHe } from './format';

const VERIFICATION_LABEL: Record<CatalogEntry['verification'], { text: string; tone: 'green' | 'blue' | 'amber' }> = {
  primary: { text: 'אומת מול מקור רשמי', tone: 'green' },
  secondary: { text: 'אומת במקורות משניים', tone: 'blue' },
  metadata_only: { text: NOT_VERIFIED_TEXT, tone: 'amber' },
};

const today = () => new Date().toISOString().slice(0, 10);

export function AgreementPicker({ value, onChange, employmentStart }: { value: AgreementSelection[]; onChange: (v: AgreementSelection[]) => void; employmentStart: string | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<AgreementSelection | null>(null);
  const results = useMemo(() => searchCatalog(query), [query]);
  const chosen = new Set(value.map((v) => v.catalogId));

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
          <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
            {results.map((e) => {
              const p = profileOn(e, today());
              return (
                <li key={e.id} className="rounded-lg border border-line/70 p-2 text-[13px]" data-testid="agreement-option">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{e.name}</div>
                      <div className="text-[12px] text-ink-soft">
                        {INSTRUMENT_TYPE_LABELS[e.type]} · {e.industry}
                        {e.officialNumber ? ` · מס׳ ${e.officialNumber}` : ' · מספר רשמי: לא אומת'}
                        {e.startDate ? ` · מ-${formatDateHe(e.startDate)}` : ''}
                        {e.endDate ? ` עד ${formatDateHe(e.endDate)}` : ''}
                      </div>
                      <div className="text-[11.5px] text-ink-soft">{p ? p.summary : 'ללא כללי חישוב מקודדים — מידע בלבד'}</div>
                      <a className="text-[11.5px] text-brand hover:underline" href={e.sourceUrl} target="_blank" rel="noreferrer">
                        מקור רשמי
                      </a>
                      <span className="text-[11px] text-ink-soft"> · נבדק לאחרונה {formatDateHe(e.lastVerified)}</span>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={VERIFICATION_LABEL[e.verification].tone}>{VERIFICATION_LABEL[e.verification].text}</Badge>
                      <Button size="sm" disabled={chosen.has(e.id)} onClick={() => onChange([...value, { catalogId: e.id }])}>
                        {chosen.has(e.id) ? 'נבחר' : 'בחירה'}
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
            {!results.length && <li className="p-2 text-center text-[13px] text-ink-soft">לא נמצאו תוצאות בקטלוג המקומי</li>}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
            <Button size="sm" variant="ghost" disabled={chosen.has(UNLISTED_ID)} onClick={() => onChange([...value, { catalogId: UNLISTED_ID }])}>
              הסכם שאינו ברשימה — לבדיקה ידנית
            </Button>
            <span className="text-[11px] text-ink-soft">גרסת קטלוג {CATALOG_VERSION} · הקטלוג חלקי — ראו דוח הכיסוי</span>
          </div>
        </div>
      )}
      {value.length > 0 && (
        <ul className="mt-2 space-y-1.5" data-testid="agreement-selected">
          {value.map((sel) => {
            const e = catalogEntry(sel.catalogId);
            if (!e) return null;
            const p = profileOn(e, today());
            const status = !sel.confirmation ? 'ממתין לאישור תחולה' : !p ? 'מידע בלבד' : p.verification === 'primary' || sel.professionalVerification?.version === p.version ? 'מאושר ומופעל' : `${NOT_VERIFIED_TEXT} — הכללים אינם מופעלים`;
            return (
              <li key={sel.catalogId} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[13px]">
                <span className="font-medium">{e.name}</span>
                <Badge tone={status === 'מאושר ומופעל' ? 'green' : 'amber'}>{status}</Badge>
                <span className="ms-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(sel)}>
                    {sel.confirmation ? 'פרטי תחולה' : 'אישור תחולה'}
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
  const e = catalogEntry(selection.catalogId)!;
  const p = profileOn(e, today());
  const c = selection.confirmation;
  const [industry, setIndustry] = useState(c?.industry ?? '');
  const [occupation, setOccupation] = useState(c?.occupation ?? '');
  const [start, setStart] = useState(c?.employmentStart ?? employmentStart ?? '');
  const [by, setBy] = useState(c?.by ?? '');
  const [note, setNote] = useState(c?.note ?? '');
  const [employerOk, setEmployerOk] = useState(!!c);
  const [verifier, setVerifier] = useState(selection.professionalVerification?.by ?? '');
  const ready = industry.trim() && occupation.trim() && by.trim() && employerOk;
  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-2xl"
      title={<span>אישור תחולה — {e.name}</span>}
      footer={
        <>
          <Button
            variant="primary"
            disabled={!ready}
            data-testid="confirm-applicability"
            onClick={() =>
              onSave({
                ...selection,
                confirmation: { by: by.trim(), at: new Date().toISOString(), industry: industry.trim(), occupation: occupation.trim(), employmentStart: start || null, note: note.trim() || undefined },
                professionalVerification: p && verifier.trim() ? { by: verifier.trim(), at: new Date().toISOString(), version: p.version } : (selection.professionalVerification ?? null),
              })
            }
          >
            אישור התחולה
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
            {INSTRUMENT_TYPE_LABELS[e.type]} · {e.industry} · חל על: {e.employers} · עיסוקים: {e.occupations}
          </div>
          <div>
            תוקף: {e.startDate ? formatDateHe(e.startDate) : 'לא אומת'} – {e.endDate ? formatDateHe(e.endDate) : 'ללא מועד סיום ידוע'}
          </div>
          {e.history.map((h) => (
            <div key={h} className="text-ink-soft">
              • {h}
            </div>
          ))}
          <div className="text-ink-soft">{e.sourceNote}</div>
        </div>
        <p className="text-ink-soft">בחירת הסכם אינה הוכחה שהוא חל על העובד. יש לאשר את התנאים הבאים:</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="ענף העסק">
            <input className="field-input" value={industry} onChange={(x) => setIndustry(x.target.value)} aria-label="ענף העסק" />
          </Field>
          <Field label="עיסוק / סיווג העובד">
            <input className="field-input" value={occupation} onChange={(x) => setOccupation(x.target.value)} aria-label="עיסוק העובד" />
          </Field>
          <Field label="תאריך תחילת העסקה">
            <input type="date" className="field-input num" value={start} onChange={(x) => setStart(x.target.value)} aria-label="תאריך תחילת העסקה" />
          </Field>
          <Field label="שם המאשר/ת">
            <input className="field-input" value={by} onChange={(x) => setBy(x.target.value)} aria-label="שם המאשר" />
          </Field>
          <Field label="הערה (לא חובה)" className="col-span-2">
            <input className="field-input" value={note} onChange={(x) => setNote(x.target.value)} />
          </Field>
        </div>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={employerOk} onChange={(x) => setEmployerOk(x.target.checked)} aria-label="המעסיק והעובד בתחולת ההסכם" />
          <span>בדקתי שהמעסיק והעובד נכללים בתחולת ההסכם (ענף, ארגון מעסיקים/חברות, עיסוק, תקופה).</span>
        </label>
        {p && p.verification !== 'primary' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="font-medium text-amber-900">
              גרסת כללים {p.version}: {NOT_VERIFIED_TEXT} מול הנוסח הרשמי
            </div>
            <div className="text-amber-900">{p.summary}</div>
            <Field label="אימות מקצועי (שם מי שבדק את הנוסח הרשמי) — יפעיל את הכללים לגרסה זו בלבד" className="mt-2">
              <input className="field-input" value={verifier} onChange={(x) => setVerifier(x.target.value)} aria-label="אימות מקצועי" />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
