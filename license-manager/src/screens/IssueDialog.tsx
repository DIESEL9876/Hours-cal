import { useState } from 'react';
import { Button, Field, Modal, Segmented, useUi } from '../../../src/ui/components';
import { IconCheck, IconCopy, IconFolder, IconMonitor } from '../icons';
import { useLm } from '../App';
import { addMonths, fmtDate, licenseInfoText, typeLabel } from '../format';
import { asApiError, type Issued, type IssueRequest, type LicenseType } from '../types';

const DEVICE_RE = /^HC[1F](-[0-9A-HJKMNP-TV-Z]{4}){6}$/;

/** Same normalisation as the Rust side (uppercase, no spaces, O→0, I/L→1). */
export function normalizeDeviceId(s: string): string {
  return s
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function deviceIdProblem(s: string): string | null {
  const n = normalizeDeviceId(s);
  if (!n) return null;
  return DEVICE_RE.test(n) ? null : 'הפורמט הנדרש: HC1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (מסך ההפעלה של Hours-Cal).';
}

export function IssueDialog({ prefill, onClose }: { prefill: Partial<IssueRequest>; onClose: () => void }) {
  const { api, info, refresh } = useLm();
  const ui = useUi();
  const [licensee, setLicensee] = useState(prefill.licensee ?? '');
  const [deviceId, setDeviceId] = useState(prefill.deviceId ?? '');
  const [nickname, setNickname] = useState(prefill.nickname ?? '');
  const [type, setType] = useState<LicenseType>(prefill.licenseType ?? 'perpetual');
  const [expiresAt, setExpiresAt] = useState(prefill.expiresAt ?? '');
  const [notes, setNotes] = useState(prefill.notes ?? '');
  const [replaces, setReplaces] = useState(prefill.replaces ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Issued | null>(null);

  const deviceHint = deviceIdProblem(deviceId);

  async function submit() {
    const local: Record<string, string> = {};
    if (!licensee.trim()) local.licensee = 'יש להזין שם בעל הרישיון או שם החברה.';
    if (!deviceId.trim()) local.deviceId = 'יש להזין את מזהה ההפעלה של המחשב.';
    else if (deviceHint) local.deviceId = `מזהה ההפעלה אינו תקין. ${deviceHint}`;
    if (type === 'limited' && !expiresAt) local.expiresAt = 'ברישיון מוגבל בזמן יש לבחור תאריך תפוגה.';
    setErrors(local);
    setGeneral(null);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const res = await api.issueLicense({
        licensee,
        deviceId: normalizeDeviceId(deviceId),
        nickname: nickname || null,
        licenseType: type,
        expiresAt: type === 'limited' ? expiresAt : null,
        notes: notes || null,
        replaces,
      });
      setDone(res);
      await refresh();
    } catch (e) {
      const err = asApiError(e);
      if (err.fields.length) setErrors(Object.fromEntries(err.fields.map((f) => [f.field, f.message])));
      setGeneral(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function useMyComputer() {
    try {
      const d = await api.myDevice();
      if (d.deviceId) {
        setDeviceId(d.deviceId);
        if (!nickname) setNickname('המחשב שלי');
      } else ui.toast(d.note, 'info');
    } catch (e) {
      ui.toast(asApiError(e).message, 'error');
    }
  }

  function another() {
    setDone(null);
    setLicensee('');
    setDeviceId('');
    setNickname('');
    setNotes('');
    setReplaces(null);
    setErrors({});
  }

  if (done) {
    const l = done.license;
    return (
      <Modal
        open
        onClose={onClose}
        title="הרישיון הונפק"
        width="max-w-2xl"
        footer={
          <>
            <Button variant="primary" onClick={onClose}>
              סגירה
            </Button>
            <Button onClick={another}>הפקת רישיון נוסף</Button>
          </>
        }
      >
        <div data-testid="issue-success">
          <div className="mb-4 flex items-start gap-3 rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
              <IconCheck size={18} />
            </span>
            <div className="text-[14px] text-emerald-900">
              <div className="font-semibold">הרישיון נחתם, נבדק בדיוק כפי ש-Hours-Cal תבדוק אותו, ונשמר ברשומות.</div>
              <div className="mt-0.5 text-[13px]">שלחו ללקוח את קובץ ה-‎.hclic‎ (או את מפתח ההפעלה). הקובץ אינו מכיל את המפתח הפרטי.</div>
            </div>
          </div>
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1.5 text-[13.5px]">
            <dt className="text-ink-soft">מספר רישיון</dt>
            <dd className="mono text-right" data-testid="issued-id">
              {l.licenseId}
            </dd>
            <dt className="text-ink-soft">בעל הרישיון</dt>
            <dd>{l.licensee}</dd>
            <dt className="text-ink-soft">מחשב</dt>
            <dd>
              <span className="mono text-[12.5px]">{l.deviceId}</span>
              {l.nickname ? ` · ${l.nickname}` : ''}
            </dd>
            <dt className="text-ink-soft">סוג</dt>
            <dd>{typeLabel(l)}</dd>
            <dt className="text-ink-soft">בתוקף עד</dt>
            <dd>{l.expiresAt ? fmtDate(l.expiresAt) : 'ללא הגבלה'}</dd>
            <dt className="text-ink-soft">קובץ</dt>
            <dd className="mono break-all text-right text-[12px]">{done.filePath}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button icon={<IconFolder size={16} />} onClick={() => api.revealPath(done.filePath).catch((e) => ui.toast(asApiError(e).message, 'error'))} data-testid="issued-reveal">
              הצגה בתיקייה
            </Button>
            <Button icon={<IconCopy size={16} />} onClick={() => api.copyText(licenseInfoText(l)).then(() => ui.toast('פרטי הרישיון הועתקו.'))} data-testid="issued-copy-info">
              העתקת פרטי הרישיון
            </Button>
            <Button icon={<IconCopy size={16} />} onClick={() => api.copyText(done.activationKey).then(() => ui.toast('מפתח ההפעלה הועתק.'))}>
              העתקת מפתח ההפעלה
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={replaces ? 'הנפקת רישיון חלופי' : 'הפקת רישיון חדש'}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="primary" disabled={busy} onClick={() => void submit()} data-testid="issue-submit">
            {busy ? 'חותם ובודק…' : 'הפקת הרישיון'}
          </Button>
          <Button onClick={onClose}>ביטול</Button>
        </>
      }
    >
      <form
        className="space-y-4"
        data-testid="issue-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {replaces && (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-brand-soft px-3 py-2.5 text-[13px] text-brand-dark">
            <span>
              רישיון זה יחליף את <span className="mono font-medium">{replaces}</span> (למשל לאחר החלפת מחשב או התקנה מחדש של Windows). יש להזין את מזהה המחשב החדש.
            </span>
            <button type="button" className="shrink-0 text-[12px] underline" onClick={() => setReplaces(null)}>
              לא להחליף
            </button>
          </div>
        )}
        <Field label="שם בעל הרישיון / החברה *" error={errors.licensee}>
          <input className={`field-input ${errors.licensee ? 'invalid' : ''}`} value={licensee} onChange={(e) => setLicensee(e.target.value)} autoFocus data-testid="f-licensee" maxLength={200} />
        </Field>
        <Field
          label="מזהה ההפעלה של המחשב *"
          error={errors.deviceId}
          hint={deviceHint ?? 'הלקוח מעתיק את המזהה ממסך "הפעלת רישיון" ב-Hours-Cal. הרישיון יפעל רק במחשב זה.'}
        >
          <div className="flex gap-2">
            <input
              className={`field-input mono ${errors.deviceId ? 'invalid' : ''}`}
              dir="ltr"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              onBlur={() => setDeviceId((v) => normalizeDeviceId(v))}
              placeholder="HC1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              spellCheck={false}
              data-testid="f-device"
            />
            <Button size="md" icon={<IconMonitor size={16} />} onClick={() => void useMyComputer()} title="מילוי המזהה של המחשב הנוכחי">
              המחשב שלי
            </Button>
          </div>
        </Field>
        <Field label="כינוי המחשב (לא חובה)" error={errors.nickname} hint='לזיהוי ברשומות שלכם בלבד, למשל "מחשב הנהלת חשבונות".'>
          <input className="field-input" value={nickname} onChange={(e) => setNickname(e.target.value)} data-testid="f-nickname" maxLength={200} />
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink">סוג הרישיון</span>
          <Segmented<LicenseType>
            value={type}
            onChange={setType}
            options={[
              { value: 'perpetual', label: 'קבוע (ללא הגבלת זמן)' },
              { value: 'limited', label: 'מוגבל בזמן' },
            ]}
          />
        </div>
        {type === 'limited' && (
          <Field label="תאריך תפוגה *" error={errors.expiresAt} hint="הרישיון יפעל עד סוף היום שנבחר (כולל).">
            <div className="flex flex-wrap items-center gap-2">
              <input type="date" className={`field-input !w-48 ${errors.expiresAt ? 'invalid' : ''}`} min={info.today} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} data-testid="f-expires" />
              {[
                { m: 1, l: 'חודש' },
                { m: 3, l: '3 חודשים' },
                { m: 12, l: 'שנה' },
              ].map((p) => (
                <Button key={p.m} size="sm" variant="ghost" onClick={() => setExpiresAt(addMonths(info.today, p.m))}>
                  {p.l}
                </Button>
              ))}
            </div>
          </Field>
        )}
        <Field label="הערות (לא חובה)" error={errors.notes} hint="נשמרות ברשומות שלכם בלבד ואינן נכללות בקובץ הרישיון.">
          <textarea className="field-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="f-notes" maxLength={2000} />
        </Field>
        {errors.replaces && <p className="text-[13px] text-red-600">{errors.replaces}</p>}
        {general && (
          <div className="rounded-lg bg-red-50 px-3 py-2.5 text-[13px] text-red-800 ring-1 ring-red-200" role="alert" data-testid="issue-error">
            {general}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
