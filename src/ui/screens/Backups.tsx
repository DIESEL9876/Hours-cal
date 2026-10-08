import { useCallback, useEffect, useState } from 'react';
import type { BackupInfo } from '../../data/driver';
import { useApp } from '../App';
import { Button, Card, PageHeader, useUi } from '../components';
import { IconDatabase, IconShield } from '../icons';
import { formatTimestamp } from '../format';

function reasonLabel(name: string): string {
  if (name.includes('-auto')) return 'גיבוי אוטומטי יומי';
  if (name.includes('before-restore')) return 'לפני שחזור';
  if (name.includes('pre-migration')) return 'לפני עדכון מבנה נתונים';
  if (name.includes('finalize')) return 'בעת סגירת חודש';
  return 'גיבוי ידני';
}

export function BackupsScreen() {
  const { repo, bumpData } = useApp();
  const ui = useUi();
  const [list, setList] = useState<BackupInfo[]>([]);
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setList(await repo.driver.listBackups());
    setLocation(await repo.driver.location());
  }, [repo]);
  useEffect(() => {
    load().catch((e) => ui.toast(String(e), 'error'));
  }, [load, ui]);

  const create = async () => {
    setBusy(true);
    try {
      const b = await repo.driver.createBackup('manual');
      ui.toast(`נוצר גיבוי: ${b.name}`);
      load();
    } catch (e) {
      ui.toast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (b: BackupInfo) => {
    const ok = await ui.confirm({
      title: 'שחזור מגיבוי',
      message: (
        <>
          כל הנתונים הנוכחיים יוחלפו בנתוני הגיבוי מ-<b>{formatTimestamp(b.createdAt)}</b>. לפני השחזור יישמר גיבוי של המצב הנוכחי.
        </>
      ),
      confirmLabel: 'שחזור',
      danger: true,
      typeToConfirm: 'שחזור',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await repo.driver.restoreBackup(b.name);
      await repo.migrate();
      bumpData();
      ui.toast('הנתונים שוחזרו מהגיבוי');
      load();
    } catch (e) {
      ui.toast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="גיבוי ונתונים" subtitle="כל הנתונים נשמרים מקומית במחשב בלבד ואינם נשלחים לשום שירות חיצוני." />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-1">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <IconDatabase size={18} /> מסד הנתונים
          </div>
          <div className="text-[13px] text-ink-soft">מיקום:</div>
          <div className="num mt-1 break-all rounded-lg bg-slate-50 p-2 text-left text-[12px]">{location}</div>
          <ul className="mt-4 space-y-1.5 text-[13px] text-ink-soft">
            <li>• SQLite מקומי עם רישום יומן (WAL) וכתיבה מסונכרנת.</li>
            <li>• כל שינוי נשמר מיידית בטרנזקציה אחת יחד עם רישום ביומן השינויים.</li>
            <li>• גיבוי אוטומטי בכל יום שבו המערכת נפתחת (נשמרים 30 אחרונים).</li>
            <li>• גיבוי נוסף לפני שחזור, לפני עדכון מבנה ובעת סגירת חודש.</li>
          </ul>
          <Button variant="primary" className="mt-5 w-full" disabled={busy} onClick={create} icon={<IconShield size={16} />}>
            יצירת גיבוי עכשיו
          </Button>
        </Card>
        <Card className="lg:col-span-2">
          <div className="border-b border-line px-5 py-3 font-semibold">גיבויים קיימים ({list.length})</div>
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-slate-50 text-right text-ink-soft">
                <tr>
                  <th className="px-5 py-2 font-medium">נוצר</th>
                  <th className="px-3 py-2 font-medium">סוג</th>
                  <th className="px-3 py-2 font-medium">גודל</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-ink-soft">
                      אין גיבויים עדיין
                    </td>
                  </tr>
                )}
                {list.map((b) => (
                  <tr key={b.name} className="border-t border-line/70">
                    <td className="px-5 py-2">{formatTimestamp(b.createdAt)}</td>
                    <td className="px-3 py-2">{reasonLabel(b.name)}</td>
                    <td className="num px-3 py-2 text-right">{(b.sizeBytes / 1024).toFixed(0)} KB</td>
                    <td className="px-3 py-2 text-left">
                      <Button size="sm" disabled={busy} onClick={() => restore(b)}>
                        שחזור
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
