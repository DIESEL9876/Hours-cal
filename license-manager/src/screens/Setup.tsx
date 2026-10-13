import { useState, type ReactNode } from 'react';
import { Button, Card, Checkbox, useUi } from '../../../src/ui/components';
import { IconAlert, IconKey, IconLock, IconShield, IconUpload, IconFile } from '../icons';
import { useLm } from '../App';
import { asApiError } from '../types';

export const NEW_KEY_CONFIRMATION = 'מפתח חדש';

/** First launch (no key) or recovery (a key was configured but cannot be opened). */
export function SetupScreen() {
  const { api, vault, refresh, openBackup, openRestore } = useLm();
  const ui = useUi();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unavailable = vault.state === 'keyUnavailable';

  async function create(confirm?: string) {
    setBusy(true);
    setError(null);
    try {
      const k = await api.vaultCreate(confirm);
      ui.toast(`מפתח החתימה נוצר ונשמר בהגנת Windows (${k.keyId}).`);
      await refresh();
      // The very next step: an offline backup (the key exists only on this computer).
      openBackup();
    } catch (e) {
      setError(asApiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  async function createReplacement() {
    const ok = await ui.confirm({
      title: 'יצירת מפתח חתימה חדש במקום המפתח שאבד',
      danger: true,
      confirmLabel: 'יצירת מפתח חדש',
      typeToConfirm: NEW_KEY_CONFIRMATION,
      message: (
        <div className="space-y-2">
          <p>
            המפתח הקודם (<span className="mono">{vault.configuredKeyId}</span>) לא ישוחזר. רישיונות חדשים ייחתמו במפתח אחר, ולכן <b>גרסאות Hours-Cal הקיימות לא יקבלו אותם</b> עד שתבנו גרסה חדשה עם המפתח הציבורי
            החדש.
          </p>
          <p>רישיונות שכבר הונפקו במפתח הקודם ימשיכו לפעול במחשבי הלקוחות. אם יש לכם קובץ גיבוי — עדיף לשחזר ממנו.</p>
        </div>
      ),
    });
    if (ok) await create(NEW_KEY_CONFIRMATION);
  }

  async function importCli(confirm?: string) {
    const path = await api.pickOpen('cliKey');
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const k = await api.vaultImportCliKey(path, confirm);
      ui.toast(`המפתח יובא ונשמר בהגנת Windows (${k.keyId}). מומלץ למחוק כעת את קובץ ה-PRIVATE המקורי לאחר שמירת גיבוי.`);
      await refresh();
      openBackup();
    } catch (e) {
      const err = asApiError(e);
      if (err.code === 'CONFIRMATION_REQUIRED') {
        const ok = await ui.confirm({ title: 'ייבוא מפתח שונה', danger: true, typeToConfirm: NEW_KEY_CONFIRMATION, confirmLabel: 'ייבוא', message: err.message });
        setBusy(false);
        if (ok) await importCliWith(path, NEW_KEY_CONFIRMATION);
        return;
      }
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function importCliWith(path: string, confirm: string) {
    setBusy(true);
    try {
      await api.vaultImportCliKey(path, confirm);
      await refresh();
      openBackup();
    } catch (e) {
      setError(asApiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl" data-testid="setup-screen">
      {unavailable ? (
        <Card className="mb-6 border-red-200 bg-red-50/60 p-6" role="alert">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-red-600">
              <IconAlert size={22} />
            </span>
            <div>
              <h1 className="text-[20px] font-bold text-red-800">מפתח החתימה אינו זמין במחשב זה</h1>
              <p className="mt-1 text-[14px] text-red-900">
                בתוכנה הוגדר בעבר מפתח <span className="mono font-medium">{vault.configuredKeyId}</span>, אך לא ניתן לפתוח אותו
                {vault.problem ? ` (${vault.problem})` : ''}. זה קורה לאחר התקנה מחדש של Windows, מעבר למשתמש Windows אחר או מחיקת קבצים.
              </p>
              <p className="mt-2 text-[14px] font-medium text-red-900">מפתח חדש לא נוצר אוטומטית. שחזרו את המפתח מקובץ הגיבוי כדי להמשיך להנפיק רישיונות שגרסאות Hours-Cal הקיימות מקבלות.</p>
            </div>
          </div>
        </Card>
      ) : (
        <div className="mb-6">
          <h1 className="text-[24px] font-bold text-ink">ברוכים הבאים למנהל הרישיונות של Hours-Cal</h1>
          <p className="mt-1.5 max-w-3xl text-[15px] leading-relaxed text-ink-soft">
            כדי להנפיק רישיונות יש להגדיר פעם אחת מפתח חתימה פרטי. המפתח נוצר במחשב זה בלבד, נשמר מוצפן בהגנת Windows לחשבון המשתמש שלכם, ואינו נשלח לשום מקום. אותו מפתח ישמש
            אתכם לתמיד — לכל הרישיונות, בלי לבנות מחדש את Hours-Cal.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-[14px] text-red-800 ring-1 ring-red-200" role="alert">
          {error}
        </div>
      )}

      <div className={`grid gap-4 ${unavailable ? 'md:grid-cols-2' : 'md:grid-cols-3'}`}>
        {!unavailable && (
          <Option
            icon={<IconKey size={22} />}
            title="יצירת מפתח חתימה חדש"
            badge="הגדרה ראשונה"
            testid="setup-create"
            text="מתאים כשזו הפעם הראשונה ואין לכם מפתח קיים."
          >
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-[13px] leading-relaxed text-ink-soft">
              <ul className="list-disc space-y-1 pe-1 ps-4">
                <li>המפתח הפרטי לא יוצג ולא ייצא מהמחשב, אלא בגיבוי מוצפן שתבקשו במפורש.</li>
                <li>אם המפתח יאבד ללא גיבוי, לא ניתן יהיה להנפיק רישיונות שגרסאות Hours-Cal הקיימות מקבלות.</li>
                <li>מיד לאחר היצירה תתבקשו לשמור גיבוי מוצפן (למשל בדיסק און קי).</li>
              </ul>
            </div>
            <div className="mt-3">
              <Checkbox checked={ack} onChange={setAck} label="קראתי והבנתי" />
            </div>
            <Button variant="primary" className="mt-3 w-full" disabled={!ack || busy} onClick={() => void create()} data-testid="create-key">
              יצירת המפתח
            </Button>
          </Option>
        )}
        <Option icon={<IconUpload size={22} />} title="שחזור מקובץ גיבוי" badge={unavailable ? 'מומלץ' : undefined} testid="setup-restore" text="יש לכם קובץ ‎.hckeybak‎ ששמרתם ממנהל הרישיונות (במחשב זה או במחשב אחר).">
          <Button variant={unavailable ? 'primary' : 'secondary'} className="mt-auto w-full" disabled={busy} onClick={openRestore} data-testid="restore-key">
            שחזור מפתחות
          </Button>
        </Option>
        <Option icon={<IconFile size={22} />} title="ייבוא מפתח מכלי שורת הפקודה" testid="setup-import" text="כבר יצרתם מפתח בכלי hourscal-license (קובץ ‎*.PRIVATE.txt‎). הרישיונות שכבר הונפקו בו ימשיכו לפעול.">
          <Button className="mt-auto w-full" disabled={busy} onClick={() => void importCli()} data-testid="import-cli-key">
            בחירת קובץ המפתח
          </Button>
        </Option>
      </div>

      {unavailable && (
        <Card className="mt-6 p-5">
          <h2 className="text-[15px] font-semibold text-ink">אין לכם גיבוי?</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
            ניתן ליצור מפתח חדש, אך רישיונות שייחתמו בו יפעלו רק בגרסת Hours-Cal חדשה שתיבנה עם המפתח הציבורי החדש. פעולה זו דורשת אישור מפורש.
          </p>
          <Button variant="danger" className="mt-3" disabled={busy} onClick={() => void createReplacement()} data-testid="create-replacement-key">
            יצירת מפתח חדש במקום המפתח שאבד…
          </Button>
        </Card>
      )}

      <div className="mt-6 flex items-start gap-2 text-[12px] leading-relaxed text-ink-soft">
        <IconLock size={14} className="mt-0.5 shrink-0" />
        <span>
          כל פעולות המפתח הפרטי (יצירה, חתימה, הצפנת גיבוי) מתבצעות ברכיב המקומי של התוכנה ולא בממשק. התוכנה פועלת ללא חיבור לאינטרנט.
          <IconShield size={14} className="ms-1 inline" />
        </span>
      </div>
    </div>
  );
}

function Option({ icon, title, text, badge, testid, children }: { icon: ReactNode; title: string; text: string; badge?: string; testid: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col p-5" data-testid={testid}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand">{icon}</span>
        {badge && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">{badge}</span>}
      </div>
      <h2 className="mt-3 text-[16px] font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{text}</p>
      <div className="mt-2 flex flex-1 flex-col">{children}</div>
    </Card>
  );
}
