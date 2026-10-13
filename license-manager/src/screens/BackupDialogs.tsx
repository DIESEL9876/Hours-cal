import { useState } from 'react';
import { Button, Checkbox, Field, Modal, useUi } from '../../../src/ui/components';
import { IconAlert, IconCheck, IconFolder, IconLock } from '../icons';
import { useLm } from '../App';
import { NEW_KEY_CONFIRMATION } from './Setup';
import { asApiError, type BackupSummary, type RestoreSummary } from '../types';

export function passphraseStrength(p: string, min: number): { score: 0 | 1 | 2 | 3; label: string } {
  if (p.length < min) return { score: 0, label: `קצרה מדי (לפחות ${min} תווים)` };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/, /[֐-׿]/].filter((r) => r.test(p)).length;
  if (p.length >= 20 || (p.length >= 16 && classes >= 3)) return { score: 3, label: 'חזקה' };
  if (p.length >= 14 || classes >= 3) return { score: 2, label: 'טובה' };
  return { score: 1, label: 'מספיקה' };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BackupDialog({ onClose }: { onClose: () => void }) {
  const { api, info, vault, refresh } = useLm();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ summary: BackupSummary; path: string } | null>(null);
  const min = info.minPassphraseChars;
  const strength = passphraseStrength(pass, min);
  const mismatch = pass2.length > 0 && pass !== pass2;
  const canSave = strength.score > 0 && pass === pass2 && ack && !busy;

  function close() {
    setPass('');
    setPass2('');
    onClose();
  }

  async function save() {
    setError(null);
    const out = await api.pickSave('backup', `HoursCal-key-backup-${vault.key?.keyId ?? 'key'}-${today()}.hckeybak`);
    if (!out) return;
    setBusy(true);
    try {
      const summary = await api.backupCreate(pass, out);
      setPass('');
      setPass2('');
      setDone({ summary, path: out });
      await refresh();
    } catch (e) {
      setError(asApiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <Modal open onClose={close} title="הגיבוי נשמר" footer={<Button variant="primary" onClick={close}>סגירה</Button>}>
        <div data-testid="backup-success" className="space-y-3 text-[14px]">
          <div className="flex items-start gap-3 rounded-xl bg-emerald-50 p-4 text-emerald-900 ring-1 ring-emerald-200">
            <IconCheck size={20} className="mt-0.5 shrink-0" />
            <div>
              הגיבוי נוצר ונבדק (נפתח בהצלחה עם הסיסמה שבחרתם). הוא כולל את המפתח <span className="mono">{done.summary.keyId}</span> ו-{done.summary.licenses} רשומות רישיון.
            </div>
          </div>
          <div className="mono break-all rounded-lg bg-slate-50 p-2.5 text-[12px] text-ink-soft">{done.path}</div>
          <p className="text-ink-soft">העבירו את הקובץ לדיסק און קי או לכונן חיצוני ושמרו אותו במקום בטוח, בנפרד מהסיסמה. אל תשלחו אותו בדוא"ל ואל תעלו אותו ל-GitHub.</p>
          <Button icon={<IconFolder size={16} />} onClick={() => api.revealPath(done.path).catch(() => undefined)}>
            הצגה בתיקייה
          </Button>
        </div>
      </Modal>
    );

  return (
    <Modal
      open
      onClose={close}
      title="גיבוי מפתחות"
      footer={
        <>
          <Button variant="primary" disabled={!canSave} onClick={() => void save()} data-testid="backup-save">
            {busy ? 'מצפין ובודק…' : 'בחירת מיקום ושמירת הגיבוי'}
          </Button>
          <Button onClick={close}>ביטול</Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="backup-dialog">
        <p className="text-[14px] leading-relaxed text-ink">
          הגיבוי הוא הדרך היחידה להעביר את מפתח החתימה למחשב אחר או לשחזר אותו לאחר תקלה. הקובץ מכיל את המפתח הפרטי <b>מוצפן בסיסמה שתבחרו</b> (<span dir="ltr">Argon2id + XChaCha20-Poly1305</span>) ואת רשומת
          הרישיונות.
        </p>
        <div className="flex items-start gap-2.5 rounded-lg bg-amber-50 p-3 text-[13px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
          <IconAlert size={17} className="mt-0.5 shrink-0" />
          <ul className="list-disc space-y-0.5 ps-4">
            <li>אין דרך לשחזר או לאפס סיסמה שנשכחה — בלעדיה הגיבוי חסר תועלת.</li>
            <li>מי שמחזיק בקובץ ובסיסמה יכול להנפיק רישיונות בשמכם. שמרו אותם בנפרד.</li>
            <li>אין לשמור את הקובץ ב-GitHub, בדוא"ל או לצרף אותו להתקנת Hours-Cal.</li>
          </ul>
        </div>
        <Field label="סיסמת הגיבוי" hint={pass ? `חוזק: ${strength.label}` : `לפחות ${min} תווים. מומלץ משפט ארוך שקל לכם לזכור.`}>
          <input type="password" className="field-input" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" data-testid="backup-pass" />
        </Field>
        {pass && (
          <div className="-mt-2 flex gap-1" aria-hidden>
            {[1, 2, 3].map((i) => (
              <span key={i} className={`h-1 flex-1 rounded-full ${strength.score >= i ? (strength.score === 1 ? 'bg-amber-400' : 'bg-emerald-500') : 'bg-slate-200'}`} />
            ))}
          </div>
        )}
        <Field label="אימות הסיסמה" error={mismatch ? 'הסיסמאות אינן זהות.' : null}>
          <input type="password" className={`field-input ${mismatch ? 'invalid' : ''}`} value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" data-testid="backup-pass2" />
        </Field>
        <Checkbox checked={ack} onChange={setAck} label="רשמתי את הסיסמה במקום בטוח, ואשמור את קובץ הגיבוי מחוץ למחשב זה." />
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2.5 text-[13px] text-red-800 ring-1 ring-red-200" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function RestoreDialog({ onClose }: { onClose: () => void }) {
  const { api, vault, refresh } = useLm();
  const ui = useUi();
  const [path, setPath] = useState<string | null>(null);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RestoreSummary | null>(null);
  const current = vault.key?.keyId ?? null;
  const differentFromCurrent = !!keyId && !!current && keyId !== current;

  function close() {
    setPass('');
    onClose();
  }

  async function choose() {
    setError(null);
    const p = await api.pickOpen('backup');
    if (!p) return;
    try {
      setKeyId(await api.backupPeek(p));
      setPath(p);
    } catch (e) {
      setPath(null);
      setKeyId(null);
      setError(asApiError(e).message);
    }
  }

  async function restore(confirm?: string) {
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.backupRestore(path, pass, confirm);
      setPass('');
      setDone(r);
    } catch (e) {
      const err = asApiError(e);
      if (err.code === 'CONFIRMATION_REQUIRED') {
        setBusy(false);
        const ok = await ui.confirm({ title: 'שחזור מפתח שונה מהמפתח שהוגדר', danger: true, typeToConfirm: NEW_KEY_CONFIRMATION, confirmLabel: 'שחזור', message: err.message });
        if (ok) return restore(NEW_KEY_CONFIRMATION);
        return;
      }
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    await refresh();
    close();
  }

  if (done)
    return (
      <Modal open onClose={() => void finish()} title="השחזור הושלם" footer={<Button variant="primary" onClick={() => void finish()}>המשך</Button>}>
        <div className="flex items-start gap-3 rounded-xl bg-emerald-50 p-4 text-[14px] text-emerald-900 ring-1 ring-emerald-200" data-testid="restore-success">
          <IconCheck size={20} className="mt-0.5 shrink-0" />
          <div>
            מפתח החתימה <span className="mono">{done.key.keyId}</span> שוחזר ונשמר בהגנת Windows במחשב זה. מתוך {done.licensesInBackup} רשומות רישיון בגיבוי נוספו {done.licensesAdded} חדשות (רשומות
            קיימות לא שונו).
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal
      open
      onClose={close}
      title="שחזור מפתחות"
      footer={
        <>
          <Button variant="primary" disabled={!path || !pass || busy || differentFromCurrent} onClick={() => void restore()} data-testid="restore-submit">
            {busy ? 'מפענח…' : 'שחזור'}
          </Button>
          <Button onClick={close}>ביטול</Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="restore-dialog">
        <p className="text-[14px] leading-relaxed text-ink">
          בחרו קובץ גיבוי (‎.hckeybak‎) והזינו את הסיסמה שנבחרה בעת יצירתו. המפתח יישמר מוצפן בהגנת Windows למשתמש הנוכחי, ורשומות רישיון שאינן קיימות כאן יתווספו.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button icon={<IconFolder size={16} />} onClick={() => void choose()} data-testid="restore-choose">
            בחירת קובץ גיבוי
          </Button>
          {path && <span className="mono min-w-0 flex-1 truncate text-[12px] text-ink-soft">{path}</span>}
        </div>
        {keyId && (
          <div className={`rounded-lg px-3 py-2.5 text-[13px] ring-1 ${differentFromCurrent ? 'bg-red-50 text-red-800 ring-red-200' : 'bg-slate-50 text-ink ring-line'}`} data-testid="restore-key-info">
            הגיבוי מכיל את המפתח <span className="mono font-medium">{keyId}</span>.
            {current && keyId === current && ' זהו המפתח הפעיל — רק רשומות רישיון חסרות יתווספו.'}
            {differentFromCurrent && ` במחשב זה כבר פעיל מפתח אחר (${current}). לא ניתן להחליף מפתח פעיל.`}
            {!current && vault.configuredKeyId && keyId !== vault.configuredKeyId && ` שימו לב: המפתח שהוגדר בעבר במחשב זה הוא ${vault.configuredKeyId}.`}
          </div>
        )}
        <Field label="סיסמת הגיבוי">
          <input type="password" className="field-input" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" disabled={!path} data-testid="restore-pass" />
        </Field>
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2.5 text-[13px] text-red-800 ring-1 ring-red-200" role="alert" data-testid="restore-error">
            {error}
          </div>
        )}
        <p className="flex items-start gap-2 text-[12px] text-ink-soft">
          <IconLock size={14} className="mt-0.5 shrink-0" />
          הפענוח מתבצע ברכיב המקומי של התוכנה. הסיסמה אינה נשמרת.
        </p>
      </div>
    </Modal>
  );
}
