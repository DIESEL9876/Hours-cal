import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, PageHeader, useUi } from '../../../src/ui/components';
import { IconCopy, IconDownload, IconFolder, IconKey, IconMonitor, IconPlus, IconUpload } from '../icons';
import { useLm } from '../App';
import { fmtDateTime } from '../format';
import { asApiError, type MyDevice } from '../types';

export function MyComputerScreen() {
  const { api, info, vault, openIssue, openBackup, openRestore, refresh } = useLm();
  const ui = useUi();
  const [device, setDevice] = useState<MyDevice | null>(null);
  const key = vault.key!;

  useEffect(() => {
    api.myDevice().then(setDevice, (e) => ui.toast(asApiError(e).message, 'error'));
  }, [api, ui]);

  async function exportPublic() {
    const out = await api.pickSave('publicKey', 'license_public_key.txt');
    if (!out) return;
    try {
      await api.exportPublicKey(out);
      ui.toast('הקובץ license_public_key.txt נשמר. הוא מכיל את המפתח הציבורי בלבד.');
    } catch (e) {
      ui.toast(asApiError(e).message, 'error');
    }
  }

  async function changeDir() {
    const p = await api.pickOpen('folder');
    if (!p) return;
    try {
      await api.setLicenseDir(p);
      await refresh();
      ui.toast('תיקיית קבצי הרישיון עודכנה.');
    } catch (e) {
      ui.toast(asApiError(e).message, 'error');
    }
  }

  return (
    <div className="space-y-5" data-testid="my-computer">
      <PageHeader title="פרטי המחשב שלי" subtitle="מזהה המחשב, מפתח החתימה והשילוב החד-פעמי ב-Hours-Cal." />

      <div className="grid gap-5 lg:grid-cols-2">
        <Section icon={<IconMonitor size={20} />} title="מזהה ההפעלה של מחשב זה">
          {device?.deviceId ? (
            <>
              <div className="mono select-all rounded-lg bg-slate-50 px-4 py-3 text-center text-[18px] font-semibold tracking-wide text-ink" data-testid="my-device-id">
                {device.deviceId}
              </div>
              <p className="mt-2 text-[13px] text-ink-soft">{device.note}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button icon={<IconCopy size={16} />} onClick={() => api.copyText(device.deviceId!).then(() => ui.toast('המזהה הועתק.'))}>
                  העתקה
                </Button>
                <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => openIssue({ deviceId: device.deviceId!, nickname: 'המחשב שלי' })} data-testid="issue-for-me">
                  הנפקת רישיון למחשב זה
                </Button>
              </div>
            </>
          ) : (
            <p className="text-[13.5px] text-ink-soft">{device?.note ?? 'טוען…'}</p>
          )}
        </Section>

        <Section icon={<IconKey size={20} />} title="מפתח החתימה">
          <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-[13.5px]">
            <dt className="text-ink-soft">מזהה המפתח</dt>
            <dd className="mono text-right" data-testid="key-id">
              {key.keyId}
            </dd>
            <dt className="text-ink-soft">נוצר</dt>
            <dd>{fmtDateTime(key.createdAt)}</dd>
            <dt className="text-ink-soft">הגנה</dt>
            <dd>{key.protection === 'dpapi-user' ? 'מוצפן בהגנת Windows (DPAPI) למשתמש הנוכחי' : 'מצב פיתוח (ללא הצפנת Windows)'}</dd>
            <dt className="text-ink-soft">גיבוי אחרון</dt>
            <dd className={info.lastBackupAt && info.lastBackupKeyId === key.keyId ? '' : 'font-medium text-amber-700'}>
              {info.lastBackupAt && info.lastBackupKeyId === key.keyId ? fmtDateTime(info.lastBackupAt) : 'לא נשמר גיבוי'}
            </dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button icon={<IconDownload size={16} />} onClick={openBackup}>
              גיבוי מפתחות
            </Button>
            <Button icon={<IconUpload size={16} />} onClick={openRestore}>
              שחזור מפתחות
            </Button>
          </div>
        </Section>
      </div>

      <Section icon={<IconKey size={20} />} title="המפתח הציבורי ושילובו ב-Hours-Cal (פעם אחת בלבד)">
        <p className="text-[13.5px] leading-relaxed text-ink">
          Hours-Cal בודקת רישיונות בעזרת <b>המפתח הציבורי</b>. מפתח זה אינו סודי: ניתן לשמור אותו ב-GitHub ולכלול אותו בהתקנה. המפתח הפרטי לעולם אינו יוצא ממנהל הרישיונות.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className="mono min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-ink" data-testid="public-key">
            {key.publicKey}
          </code>
          <Button size="sm" icon={<IconCopy size={15} />} onClick={() => api.copyText(key.publicKey).then(() => ui.toast('המפתח הציבורי הועתק.'))}>
            העתקה
          </Button>
          <Button size="sm" variant="primary" icon={<IconDownload size={15} />} onClick={() => void exportPublic()} data-testid="export-public-key">
            שמירת license_public_key.txt
          </Button>
        </div>
        <ol className="mt-4 list-decimal space-y-2 ps-5 text-[13.5px] leading-relaxed text-ink">
          <li>
            <b>הפעילו קודם את המחשב שלכם:</b> "הנפקת רישיון למחשב זה" ← ב-Hours-Cal (הגרסה הנוכחית) פתחו "מסמכים משפטיים ורישיון" ← "ייבוא קובץ רישיון". הגרסה הנוכחית שומרת את הרישיון גם לפני
            שהדרישה מופעלת.
          </li>
          <li>
            שמרו את <span className="mono">license_public_key.txt</span> והחליפו בו את הקובץ <span className="mono">src-tauri/keys/license_public_key.txt</span> בפרויקט Hours-Cal (או העבירו אותו
            למי שבונה את הגרסה).
          </li>
          <li>העלו את מספר הגרסה (למשל 1.1.4) ובנו את ההתקנה. מגרסה זו Hours-Cal תדרוש רישיון תקף שנחתם במפתח שלכם.</li>
          <li>התקינו את הגרסה החדשה במחשב שלכם וודאו שהיא נפתחת ללא בקשת הפעלה. רק אז הפיצו אותה ללקוחות.</li>
          <li>מכאן והלאה: כל רישיון חדש מונפק כאן בלחיצה, ללא בנייה מחדש של Hours-Cal.</li>
        </ol>
      </Section>

      <Section icon={<IconFolder size={20} />} title="מיקומי קבצים">
        <dl className="grid grid-cols-[170px_1fr_auto] items-center gap-x-3 gap-y-2 text-[13px]">
          <dt className="text-ink-soft">קבצי רישיון (‎.hclic‎)</dt>
          <dd className="mono truncate text-right">{info.licenseDir}</dd>
          <dd className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => api.revealPath(info.licenseDir).catch((e) => ui.toast(asApiError(e).message, 'error'))}>
              פתיחה
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void changeDir()}>
              שינוי
            </Button>
          </dd>
          <dt className="text-ink-soft">נתוני מנהל הרישיונות</dt>
          <dd className="mono truncate text-right">{info.dataDir}</dd>
          <dd>
            <Button size="sm" variant="ghost" onClick={() => api.revealPath(info.dataDir).catch((e) => ui.toast(asApiError(e).message, 'error'))}>
              פתיחה
            </Button>
          </dd>
        </dl>
      </Section>
    </div>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-ink">
        <span className="text-brand">{icon}</span>
        {title}
      </h2>
      {children}
    </Card>
  );
}
