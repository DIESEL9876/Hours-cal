/**
 * "רכיבי שכר נוספים" (1.1.9) — monthly payroll components of ONE employee for ONE month: advances, bonuses,
 * recuperation, reserve-duty amounts, other additions; travel days; and the value of a paid absence day.
 * Money only — nothing here changes attendance or hours. A closed month is read-only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { monthRange, resolveSettings, type EmployeePeriodResult, type EmployeeSettings } from '../../engine';
import type { AdjustmentCategory, AdjustmentTreatment, Business, Employee, EmployeeMonthData, MonthlyAdjustment, ReserveKind } from '../../data/repo';
import { computeEmployeeMonth, yearMonthKey } from '../../data/service';
import { useApp } from '../App';
import { Badge, Button, Field, Modal, Select, useUi } from '../components';
import { IconEdit, IconPlus, IconTrash } from '../icons';
import { formatDateHe, hm, monthTitle } from '../format';
import { ADJUSTMENT_LABELS, monthFinancials, resolveTravel, shekelsText, TRAVEL_LABELS, type MonthFinancials } from '../../payroll/financials';
import { recuperationDays, resolveAgreements } from '../../agreements';

const TREATMENT_LABELS: Record<AdjustmentTreatment, string> = {
  gross_addition: 'תוספת לשכר ברוטו',
  advance: 'מקדמה (תשלום על חשבון השכר)',
  employer_reimbursement: 'החזר למעסיק (אינו משולם לעובד)',
  informational: 'לידיעה בלבד (אינו רכיב שכר)',
};
const RESERVE_LABELS: Record<ReserveKind, string> = {
  wage_during_service: 'מקדמה/שכר ששולם בתקופת השירות',
  nii_reimbursement: 'החזר מביטוח לאומי למעסיק',
  additional_payable: 'סכום נוסף לתשלום לעובד',
  manual: 'רישום ידני — לבדיקה מקצועית',
};
const METHOD_LABELS: Record<string, string> = {
  schedule: 'לפי מתכונת העבודה של העובד',
  fixed: 'הזנה ידנית של שעות ליום',
  average_month: 'ממוצע שעות עבודה בחודש הנוכחי',
  average_3m: 'ממוצע שעות עבודה בשלושת החודשים הקודמים',
  override: 'ערך ידני לחודש זה',
};

/** "8.40" (decimal hours) or "8:24" → minutes; null when invalid. */
export function parseHoursInput(raw: string): number | null {
  const t = raw.trim();
  const hmm = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (hmm) return Number(hmm[1]) * 60 + Number(hmm[2]);
  if (/^\d{1,2}([.,]\d{1,2})?$/.test(t)) return Math.round(Number(t.replace(',', '.')) * 60);
  return null;
}
/** "1,250.50" / "1250.5" → agorot (integer), null when invalid. */
export function parseShekels(raw: string): number | null {
  const t = raw.trim().replace(/[,\s₪]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const [a, b = ''] = t.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
}
const decimalHours = (m: number) => (Math.round((m / 60) * 100) / 100).toFixed(2);

interface Draft {
  id: string;
  category: AdjustmentCategory;
  amount: string;
  date: string;
  description: string;
  treatment: AdjustmentTreatment | '';
  proposed: string;
  authorized: string;
  authorization: string;
  reserveKind: ReserveKind;
}
const emptyDraft = (): Draft => ({ id: crypto.randomUUID(), category: 'bonus', amount: '', date: '', description: '', treatment: '', proposed: '', authorized: '', authorization: '', reserveKind: 'wage_during_service' });

export function PayrollItemsDialog({ business, employee, ym, onClose, onChanged }: { business: Business; employee: Employee; ym: { year: number; month: number }; onClose: () => void; onChanged: () => void }) {
  const { repo } = useApp();
  const ui = useUi();
  const key = yearMonthKey(ym.year, ym.month);
  const [items, setItems] = useState<MonthlyAdjustment[]>([]);
  const [month, setMonth] = useState<EmployeeMonthData>({});
  const [result, setResult] = useState<EmployeePeriodResult | null>(null);
  const [settings, setSettings] = useState<EmployeeSettings | null>(null);
  const [final, setFinal] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [travelDays, setTravelDays] = useState('');
  const [travelReason, setTravelReason] = useState('');
  const [dayValue, setDayValue] = useState('');
  const [dayReason, setDayReason] = useState('');
  const [fraction, setFraction] = useState('100');

  const load = useCallback(async () => {
    const { to } = monthRange(ym.year, ym.month);
    const [list, m, r, review, versions] = await Promise.all([
      repo.listAdjustments(business.id, key, employee.id),
      repo.getEmployeeMonth(business.id, employee.id, key),
      computeEmployeeMonth(repo, business.id, employee.id, ym.year, ym.month),
      repo.getMonthReview(business.id, key),
      repo.getSettingsVersions(employee.id),
    ]);
    setItems(list);
    setMonth(m);
    setResult(r);
    setFinal(review.status === 'final');
    setSettings(resolveSettings(versions, to)?.settings ?? null);
    setTravelDays(m.travel ? String(m.travel.eligibleDays) : '');
    setTravelReason(m.travel?.reason ?? '');
    setDayValue(m.paidDayOverride ? hm(m.paidDayOverride.minutes) : '');
    setDayReason(m.paidDayOverride?.reason ?? '');
  }, [repo, business.id, employee.id, key, ym]);

  useEffect(() => {
    load().catch((e) => ui.toast(String(e), 'error'));
  }, [load, ui]);

  const rules = useMemo(() => (settings ? resolveAgreements(settings.agreements, monthRange(ym.year, ym.month).to) : null), [settings, ym]);
  const fin: MonthFinancials | null = useMemo(
    () => (result ? monthFinancials(result, items, resolveTravel(settings, business.defaults), month, rules) : null),
    [result, items, settings, business.defaults, month, rules],
  );

  const run = async (f: () => Promise<void>, ok: string) => {
    if (busy) return; // repeated clicks never post twice
    setBusy(true);
    try {
      await f();
      ui.toast(ok);
      await load();
      onChanged();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    const amount = parseShekels(draft.amount);
    if (amount === null || amount <= 0) return ui.toast('יש להזין סכום חיובי בשקלים', 'error');
    const proposed = draft.proposed.trim() ? parseShekels(draft.proposed) : null;
    const authorized = draft.authorized.trim() ? parseShekels(draft.authorized) : null;
    if ((draft.proposed.trim() && proposed === null) || (draft.authorized.trim() && authorized === null)) return ui.toast('סכום לא תקין', 'error');
    return run(async () => {
      await repo.saveAdjustment({
        id: draft.id,
        businessId: business.id,
        employeeId: employee.id,
        yearMonth: key,
        category: draft.category,
        amountAgorot: amount,
        date: draft.date || null,
        description: draft.description || null,
        details:
          draft.category === 'advance'
            ? { advance: { proposedRecoveryAgorot: proposed, authorizedDeductionAgorot: authorized, authorization: draft.authorization || null } }
            : draft.category === 'reserve'
              ? { reserve: { kind: draft.reserveKind } }
              : {},
        ...(draft.category === 'other' && draft.treatment ? { treatment: draft.treatment } : {}),
      });
      setDraft(null);
    }, 'הרכיב נשמר');
  };

  const edit = (a: MonthlyAdjustment) =>
    setDraft({
      id: a.id,
      category: a.category,
      amount: (a.amountAgorot / 100).toFixed(2),
      date: a.date ?? '',
      description: a.description ?? '',
      treatment: a.category === 'other' ? a.treatment : '',
      proposed: a.details.advance?.proposedRecoveryAgorot != null ? (a.details.advance.proposedRecoveryAgorot / 100).toFixed(2) : '',
      authorized: a.details.advance?.authorizedDeductionAgorot != null ? (a.details.advance.authorizedDeductionAgorot / 100).toFixed(2) : '',
      authorization: a.details.advance?.authorization ?? '',
      reserveKind: a.details.reserve?.kind ?? 'manual',
    });

  const remove = async (a: MonthlyAdjustment) => {
    const ok = await ui.confirm({ title: 'מחיקת רכיב', message: `למחוק את הרכיב "${ADJUSTMENT_LABELS[a.category]}" בסך ${shekelsText(a.amountAgorot)}? הפעולה נרשמת ביומן השינויים.`, danger: true, confirmLabel: 'מחיקה' });
    if (ok) await run(() => repo.deleteAdjustment(business.id, a.id), 'הרכיב נמחק');
  };

  const saveMonth = (patch: Partial<EmployeeMonthData>) => run(() => repo.setEmployeeMonth(business.id, employee.id, key, { ...month, ...patch }), 'נשמר');

  const pd = result?.paidDay;
  const rate = settings?.hourlyRateAgorot ?? null;
  const recup = rules?.recuperation;
  const start = settings?.absence?.employmentStart ?? null;
  const years = start ? Math.floor((Date.parse(monthRange(ym.year, ym.month).to) - Date.parse(start)) / (365.25 * 86400000)) : null;
  const recupDays = recup && years !== null ? recuperationDays(recup.rule, years) : null;
  const frac = Math.max(0, Math.min(100, Number(fraction) || 0));
  const recupSuggestion = recup && recupDays !== null ? Math.round((recup.rule.dayValueAgorot * recupDays * frac) / 100) : null;

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-4xl"
      title={
        <span data-testid="payroll-items-title">
          רכיבי שכר נוספים — {employee.fullName} — {monthTitle(ym.year, ym.month)}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose} data-testid="payroll-items-close">
            סגירה
          </Button>
          <span className="ms-auto text-[12px] text-ink-soft">סכומים לצורך הכנת שכר בלבד — אינם תלוש שכר ואינם חישוב ברוטו-נטו.</span>
        </>
      }
    >
      <div className="space-y-5 text-[14px]" data-testid="payroll-items">
        {final && <div className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900 ring-1 ring-amber-200">החודש נסגר לאחר בדיקה — הנתונים לקריאה בלבד. לשינוי יש לפתוח את החודש מחדש בסיכום החודשי.</div>}

        {/* Components */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[14px] font-semibold">רכיבים לחודש זה</h3>
            {!final && !draft && (
              <Button size="sm" variant="primary" icon={<IconPlus size={15} />} onClick={() => setDraft(emptyDraft())} data-testid="add-payroll-item">
                הוספת רכיב
              </Button>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-slate-50 text-right text-[12px] text-ink-soft">
                <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:font-medium">
                  <th>סוג</th>
                  <th>סכום</th>
                  <th>תאריך</th>
                  <th>תיאור</th>
                  <th>טיפול חשבונאי</th>
                  <th>עודכן</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className="border-t border-line/70" data-testid="payroll-item-row">
                    <td className="px-3 py-2 font-medium">{ADJUSTMENT_LABELS[a.category]}</td>
                    <td className="num px-3 py-2">{shekelsText(a.amountAgorot)}</td>
                    <td className="num px-3 py-2">{a.date ? formatDateHe(a.date) : '—'}</td>
                    <td className="px-3 py-2">
                      {a.description ?? ''}
                      {a.category === 'advance' && (
                        <div className="text-[11.5px] text-ink-soft">
                          הוצע להחזר: {shekelsText(a.details.advance?.proposedRecoveryAgorot ?? 0)} · אושר לניכוי: {shekelsText(a.details.advance?.authorizedDeductionAgorot ?? 0)}
                          {a.details.advance?.authorization ? ` (${a.details.advance.authorization})` : ''}
                        </div>
                      )}
                      {a.category === 'reserve' && <div className="text-[11.5px] text-ink-soft">{RESERVE_LABELS[a.details.reserve?.kind ?? 'manual']}</div>}
                    </td>
                    <td className="px-3 py-2 text-[12px]">{TREATMENT_LABELS[a.treatment]}</td>
                    <td className="px-3 py-2 text-[11.5px] text-ink-soft">{new Date(a.updatedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}</td>
                    <td className="px-2 py-2">
                      {!final && (
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" icon={<IconEdit size={14} />} onClick={() => edit(a)} aria-label="עריכה" />
                          <Button size="sm" variant="ghost" className="text-red-600" icon={<IconTrash size={14} />} onClick={() => remove(a)} aria-label="מחיקה" />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={7} className="px-3 py-4 text-center text-ink-soft">
                      לא נרשמו רכיבים לחודש זה
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {draft && (
            <div className="mt-3 rounded-xl border border-brand/30 bg-blue-50/30 p-4" data-testid="payroll-item-form">
              <div className="grid grid-cols-4 gap-3">
                <Field label="סוג הרכיב">
                  <Select<AdjustmentCategory>
                    value={draft.category}
                    onChange={(v) => setDraft({ ...draft, category: v })}
                    options={(Object.keys(ADJUSTMENT_LABELS) as AdjustmentCategory[]).map((k) => ({ value: k, label: ADJUSTMENT_LABELS[k] }))}
                    aria-label="סוג הרכיב"
                  />
                </Field>
                <Field label="סכום (₪)">
                  <input className="field-input num text-left" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} aria-label="סכום" />
                </Field>
                <Field label="תאריך (לא חובה)">
                  <input type="date" className="field-input num" value={draft.date} min={`${key}-01`} max={monthRange(ym.year, ym.month).to} onChange={(e) => setDraft({ ...draft, date: e.target.value })} aria-label="תאריך הרכיב" />
                </Field>
                <Field label="תיאור / הערה">
                  <input className="field-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="תיאור" />
                </Field>
                {draft.category === 'other' && (
                  <Field label="טיפול חשבונאי" className="col-span-2">
                    <Select<string>
                      value={draft.treatment || 'gross_addition'}
                      onChange={(v) => setDraft({ ...draft, treatment: v as AdjustmentTreatment })}
                      options={[
                        { value: 'gross_addition', label: TREATMENT_LABELS.gross_addition },
                        { value: 'informational', label: TREATMENT_LABELS.informational },
                      ]}
                    />
                  </Field>
                )}
                {draft.category === 'reserve' && (
                  <Field label="סוג תשלום המילואים" className="col-span-2" hint="תגמול המילואים מחושב לפי נוסחת ביטוח לאומי; כאן נרשמים סכומים ידניים בלבד">
                    <Select<ReserveKind> value={draft.reserveKind} onChange={(v) => setDraft({ ...draft, reserveKind: v })} options={(Object.keys(RESERVE_LABELS) as ReserveKind[]).map((k) => ({ value: k, label: RESERVE_LABELS[k] }))} aria-label="סוג תשלום המילואים" />
                  </Field>
                )}
                {draft.category === 'advance' && (
                  <>
                    <Field label="סכום מוצע להחזר (₪)">
                      <input className="field-input num text-left" value={draft.proposed} onChange={(e) => setDraft({ ...draft, proposed: e.target.value })} aria-label="סכום מוצע להחזר" />
                    </Field>
                    <Field label="סכום שאושר לניכוי (₪)">
                      <input className="field-input num text-left" value={draft.authorized} onChange={(e) => setDraft({ ...draft, authorized: e.target.value })} aria-label="סכום שאושר לניכוי" />
                    </Field>
                    <Field label="בסיס האישור לניכוי" className="col-span-2" hint="ניכוי מהשכר מותר רק לפי דין או הסכמה בכתב של העובד">
                      <input className="field-input" value={draft.authorization} onChange={(e) => setDraft({ ...draft, authorization: e.target.value })} aria-label="בסיס האישור לניכוי" />
                    </Field>
                  </>
                )}
              </div>
              <div className="mt-3 flex gap-2">
                <Button variant="primary" disabled={busy} onClick={saveDraft} data-testid="save-payroll-item">
                  שמירה
                </Button>
                <Button onClick={() => setDraft(null)}>ביטול</Button>
              </div>
            </div>
          )}
        </section>

        {/* Totals */}
        {fin && (
          <section data-testid="payroll-totals">
            <h3 className="mb-2 text-[14px] font-semibold">סיכום החודש</h3>
            <div className="grid grid-cols-3 gap-2 text-[13px]">
              {(Object.keys(ADJUSTMENT_LABELS) as AdjustmentCategory[]).map((k) => (
                <div key={k} className="rounded-lg bg-slate-50 px-3 py-2">
                  <div className="text-[11.5px] text-ink-soft">{ADJUSTMENT_LABELS[k]}</div>
                  <div className="num font-semibold">{shekelsText(fin.byCategory[k])}</div>
                </div>
              ))}
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[11.5px] text-ink-soft">החזר נסיעות</div>
                <div className="num font-semibold">{shekelsText(fin.travel.totalAgorot)}</div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-line p-3 text-[13px]">
              <div>תוספות ברוטו (כולל נסיעות): <b className="num">{shekelsText(fin.totals.grossAdditionsAgorot)}</b></div>
              <div>מקדמות ששולמו: <b className="num">{shekelsText(fin.totals.advancesPaidAgorot)}</b></div>
              <div>ניכויים שאושרו: <b className="num">{shekelsText(fin.totals.authorizedDeductionsAgorot)}</b></div>
              <div>הצעות להחזר (לא אושרו): <b className="num">{shekelsText(fin.totals.proposedDeductionsAgorot)}</b></div>
              <div>החזרים למעסיק: <b className="num">{shekelsText(fin.totals.employerReimbursementsAgorot)}</b></div>
              <div>לידיעה בלבד: <b className="num">{shekelsText(fin.totals.informationalAgorot)}</b></div>
            </div>
          </section>
        )}

        {/* Travel */}
        {fin && (
          <section className="rounded-xl border border-line p-4" data-testid="payroll-travel">
            <h3 className="mb-1 text-[14px] font-semibold">החזר הוצאות נסיעה</h3>
            <div className="text-[13px]">
              {TRAVEL_LABELS[fin.travel.mode]}
              {fin.travel.inherited ? ' (לפי הגדרת העסק)' : ''}
              {fin.travel.mode !== 'none' && ` · ${shekelsText(fin.travel.amountAgorot)}${fin.travel.mode === 'daily' ? ' ליום' : ' לחודש'}`}
              {fin.travel.mode === 'daily' && ` · ימי נסיעה: ${fin.travel.eligibleDays} (לפי ימי עבודה בפועל: ${fin.travel.autoDays})`} · סה״כ: <b className="num">{shekelsText(fin.travel.totalAgorot)}</b>
            </div>
            {[...fin.travel.notes, ...fin.travel.reviews].map((n) => (
              <div key={n} className={`mt-1 text-[12px] ${fin.travel.reviews.includes(n) ? 'text-amber-800' : 'text-ink-soft'}`}>
                {n}
              </div>
            ))}
            {fin.travel.mode === 'daily' && !final && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="תיקון ימי נסיעה">
                  <input className="field-input num w-24 text-left" value={travelDays} onChange={(e) => setTravelDays(e.target.value)} aria-label="ימי נסיעה מתוקנים" />
                </Field>
                <Field label="סיבה (חובה)">
                  <input className="field-input w-64" value={travelReason} onChange={(e) => setTravelReason(e.target.value)} placeholder="עבודה מהבית / הסעה מטעם המעסיק" aria-label="סיבת התיקון" />
                </Field>
                <Button size="sm" disabled={busy} onClick={() => saveMonth({ travel: { eligibleDays: Math.round(Number(travelDays)), reason: travelReason, autoDays: fin.travel.autoDays } })}>
                  שמירת תיקון
                </Button>
                {month.travel && (
                  <Button size="sm" variant="ghost" onClick={() => saveMonth({ travel: null })}>
                    ביטול התיקון
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        {/* Paid absence day value */}
        {pd && (
          <section className="rounded-xl border border-line p-4" data-testid="paid-day-value">
            <h3 className="mb-1 text-[14px] font-semibold">ערך יום היעדרות בתשלום — {monthTitle(ym.year, ym.month)}</h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px]">
              <div>
                שיטה: <b>{METHOD_LABELS[pd.method]}</b>
                {pd.method !== 'schedule' && <span className="text-ink-soft"> (שיטת חישוב לפי הגדרת העסק)</span>}
              </div>
              {pd.from && (
                <div>
                  תקופת ייחוס: <span className="num">{formatDateHe(pd.from)}–{formatDateHe(pd.to!)}</span>
                </div>
              )}
              {(pd.method === 'average_month' || pd.method === 'average_3m' || pd.calculatedMinutes !== undefined) && (
                <>
                  <div>ימי עבודה בפועל: <span className="num">{pd.workedDays}</span></div>
                  <div>שעות נטו בפועל: <span className="num">{hm(pd.workedMinutes, '0:00')}</span></div>
                </>
              )}
              <div>
                שעות ליום: {pd.dayMinutes !== null ? <b className="num">{hm(pd.dayMinutes)} ({decimalHours(pd.dayMinutes)})</b> : <b className="text-amber-800">אין מספיק נתונים לחישוב ממוצע</b>}
                {pd.calculatedMinutes != null && <span className="text-ink-soft"> · מחושב: {hm(pd.calculatedMinutes)} · סיבה: {pd.overrideReason}</span>}
              </div>
              <div>שכר שעתי: {rate ? <span className="num">{shekelsText(rate)}</span> : <span className="text-ink-soft">לא הוגדר</span>}</div>
              <div>
                הערכת ערך יום מלא: {rate && pd.dayMinutes ? <b className="num">{shekelsText(Math.round((rate * pd.dayMinutes) / 60))}</b> : '—'}
              </div>
              <div>
                סטטוס: {pd.insufficient ? <Badge tone="amber">דורש בדיקה</Badge> : <Badge tone="blue">חישוב לפי הגדרת העסק — לא חישוב לפי החוק</Badge>}
              </div>
            </div>
            {result && result.attendance.estimatedAbsenceValueAgorot > 0 && (
              <div className="mt-1 text-[13px]">הערכת ערך ההיעדרויות בחודש: <b className="num">{shekelsText(result.attendance.estimatedAbsenceValueAgorot)}</b></div>
            )}
            <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
              לעובד חודשי ימי חופשה וחג משולמים במסגרת המשכורת (ללא תשלום נוסף). לעובד שעתי/יומי, דמי החופשה לפי החוק מחושבים לפי השכר בפועל בתקופת הייחוס — יש להשוות בשכר ולא להחליף זכאות גבוהה יותר בהערכה זו. מילואים משולמים לפי נוסחת ביטוח לאומי.
            </p>
            {!final && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="ערך ידני לחודש (ש:דד או עשרוני)">
                  <input className="field-input num w-28 text-left" value={dayValue} onChange={(e) => setDayValue(e.target.value)} placeholder="8.40" aria-label="ערך יום ידני" />
                </Field>
                <Field label="סיבה (חובה)">
                  <input className="field-input w-64" value={dayReason} onChange={(e) => setDayReason(e.target.value)} aria-label="סיבת הערך הידני" />
                </Field>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    const m = parseHoursInput(dayValue);
                    if (!m) return ui.toast('ערך לא תקין — לדוגמה 8.40 או 8:24', 'error');
                    return saveMonth({ paidDayOverride: { minutes: m, reason: dayReason, calculatedMinutes: pd.method === 'override' ? (pd.calculatedMinutes ?? null) : pd.dayMinutes } });
                  }}
                  data-testid="save-paid-day"
                >
                  שמירת ערך ידני
                </Button>
                {month.paidDayOverride && (
                  <Button size="sm" variant="ghost" onClick={() => saveMonth({ paidDayOverride: null })}>
                    חזרה לחישוב
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        {/* Recuperation helper (only when the extension order is selected for the employee) */}
        {recup && (
          <section className="rounded-xl border border-line p-4 text-[13px]" data-testid="recuperation-helper">
            <h3 className="mb-1 text-[14px] font-semibold">עזר לחישוב דמי הבראה</h3>
            <div>
              {recup.source} · תעריף יום: <b className="num">{shekelsText(recup.rule.dayValueAgorot)}</b> (שנת הבראה {formatDateHe(recup.rule.yearFrom)}–{formatDateHe(recup.rule.yearTo)}) ·{' '}
              {recup.executable ? <Badge tone="green">מאומת ומאושר לעובד</Badge> : <Badge tone="amber">הוראות ההסכם טרם אומתו — הצעה בלבד</Badge>}
            </div>
            <div className="mt-1">
              ותק: {years === null ? 'לא הוזן תאריך תחילת עבודה (בהגדרות ההיעדרות)' : `${years} שנים מלאות`} · ימים: {recupDays ?? (years !== null ? 'אין זכאות לפני שנה מלאה' : '—')}
            </div>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="היקף משרה (%)">
                <input className="field-input num w-20 text-left" value={fraction} onChange={(e) => setFraction(e.target.value)} aria-label="היקף משרה" />
              </Field>
              <div className="pb-2">
                הצעה: <b className="num">{recupSuggestion !== null ? shekelsText(recupSuggestion) : '—'}</b>
              </div>
              {recupSuggestion !== null && !final && (
                <Button size="sm" onClick={() => setDraft({ ...emptyDraft(), category: 'recuperation', amount: (recupSuggestion / 100).toFixed(2), description: `${recupDays} ימי הבראה × ${shekelsText(recup.rule.dayValueAgorot)} × ${frac}%` })}>
                  העברה לטופס (לאישור)
                </Button>
              )}
            </div>
            {rules!.reviews
              .filter((r) => r.includes('הבראה'))
              .map((r) => (
                <p key={r} className="mt-1 text-[12px] text-amber-800">
                  {r}
                </p>
              ))}
            <p className="mt-1 text-[12px] text-ink-soft">{recup.rule.note} דמי הבראה אינם משולמים בהכרח בכל חודש — הסכום נרשם רק לאחר אישור.</p>
          </section>
        )}
      </div>
    </Modal>
  );
}
