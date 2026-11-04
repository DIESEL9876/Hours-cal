/**
 * "פרטי העסקת נוער" (1.1.10) — details the youth rules need and that must never be inferred from the date of birth:
 * compulsory-education status, official school vacations, night-work permits actually held, recognised apprentice.
 */
import type { SchoolingStatus, YouthProfile } from '../engine';
import { Button, Field } from './components';

const EMPTY: YouthProfile = { schooling: 'unknown', schoolVacations: [], nightPermits: [], apprentice: null };

export function YouthDetails({ value, onChange }: { value: YouthProfile | null; onChange: (v: YouthProfile) => void }) {
  const y = value ?? EMPTY;
  const set = (patch: Partial<YouthProfile>) => onChange({ ...y, ...patch });
  return (
    <div className="col-span-2 space-y-3 rounded-xl border border-line p-4 text-[13px]" data-testid="youth-details">
      <div>
        <div className="text-[14px] font-semibold">פרטי העסקת נוער</div>
        <p className="text-[12px] text-ink-soft">
          משמשים לבדיקות חוק עבודת הנוער (שעות לילה, גיל מינימום, שכר חניך). אינם נגזרים מתאריך הלידה. יום המנוחה השבועית נקבע בלשונית "הגדרות חישוב" ואינו נגזר מדת.
        </p>
      </div>
      <Field label="חובת לימוד">
        <select className="field-input" value={y.schooling} onChange={(e) => set({ schooling: e.target.value as SchoolingStatus })} aria-label="חובת לימוד">
          <option value="unknown">לא ידוע — עבודה בין 20:00 ל-22:00 תסומן לבדיקה</option>
          <option value="compulsory">חוק לימוד חובה חל (שעות לילה 20:00–08:00)</option>
          <option value="not_compulsory">חוק לימוד חובה אינו חל (שעות לילה 22:00–06:00)</option>
        </select>
      </Field>

      <div>
        <div className="mb-1 font-medium">חופשות לימודים רשמיות</div>
        {y.schoolVacations.map((v, i) => (
          <div key={i} className="mb-1 flex items-end gap-2">
            <Field label="מתאריך">
              <input type="date" className="field-input num" value={v.from} aria-label="חופשת לימודים מ" onChange={(e) => set({ schoolVacations: y.schoolVacations.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
            </Field>
            <Field label="עד תאריך">
              <input type="date" className="field-input num" value={v.to} aria-label="חופשת לימודים עד" onChange={(e) => set({ schoolVacations: y.schoolVacations.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
            </Field>
            <Button size="sm" variant="ghost" className="mb-1 text-red-600" onClick={() => set({ schoolVacations: y.schoolVacations.filter((_, j) => j !== i) })}>
              הסרה
            </Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => set({ schoolVacations: [...y.schoolVacations, { from: '', to: '' }] })} data-testid="add-school-vacation">
          + הוספת חופשת לימודים
        </Button>
        <p className="text-[11.5px] text-ink-soft">בחופשה רשמית: גיל 14 מותר בתנאים; בני 16–17 עד 01:00 לפי תיקון 22 (2024), בתנאים ובהסעה אחרי 23:00 — מסומן תמיד לבדיקת התנאים.</p>
      </div>

      <div>
        <div className="mb-1 font-medium">היתרי עבודת לילה</div>
        {y.nightPermits.map((p, i) => {
          const upd = (patch: Partial<YouthProfile['nightPermits'][number]>) => set({ nightPermits: y.nightPermits.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
          return (
            <div key={i} className="mb-1 grid grid-cols-5 items-end gap-2">
              <Field label="מספר היתר">
                <input className="field-input" value={p.reference} aria-label="מספר היתר" onChange={(e) => upd({ reference: e.target.value })} />
              </Field>
              <Field label="בתוקף מ">
                <input type="date" className="field-input num" value={p.validFrom} aria-label="היתר בתוקף מ" onChange={(e) => upd({ validFrom: e.target.value })} />
              </Field>
              <Field label="עד">
                <input type="date" className="field-input num" value={p.validTo} aria-label="היתר בתוקף עד" onChange={(e) => upd({ validTo: e.target.value })} />
              </Field>
              <Field label="עד שעה">
                <input className="field-input num text-left" placeholder="23:00" value={p.until} aria-label="היתר עד שעה" onChange={(e) => upd({ until: e.target.value })} />
              </Field>
              <Button size="sm" variant="ghost" className="mb-1 text-red-600" onClick={() => set({ nightPermits: y.nightPermits.filter((_, j) => j !== i) })}>
                הסרה
              </Button>
            </div>
          );
        })}
        <Button size="sm" variant="ghost" onClick={() => set({ nightPermits: [...y.nightPermits, { reference: '', validFrom: '', validTo: '', until: '23:00' }] })}>
          + הוספת היתר
        </Button>
        <p className="text-[11.5px] text-ink-soft">עבודה לפי היתר מסומנת לבדיקת תנאי ההיתר; היתר שאינו בתוקף אינו מתיר דבר. אין היתר המתיר עבודה במנוחה השבועית.</p>
      </div>

      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={!!y.apprentice} onChange={(e) => set({ apprentice: e.target.checked ? { reference: y.apprentice?.reference ?? '' } : null })} aria-label="חניך מוכר" />
        <span>חניך/ה מוכר/ת לפי חוק החניכות (שכר מינימום 60%) — רק עם מסמך הכרה</span>
      </label>
      {y.apprentice && (
        <Field label="מספר / תיאור מסמך ההכרה (חובה)">
          <input className="field-input" value={y.apprentice.reference} aria-label="מסמך הכרה בחניכות" onChange={(e) => set({ apprentice: { reference: e.target.value } })} />
        </Field>
      )}
    </div>
  );
}
