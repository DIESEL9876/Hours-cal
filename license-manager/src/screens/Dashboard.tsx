import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Drawer, EmptyState, Field, PageHeader, Segmented, Select, useUi } from '../../../src/ui/components';
import { IconAlert, IconBan, IconCopy, IconDownload, IconFolder, IconMonitor, IconPlus, IconRefresh, IconSearch, IconShield, IconUpload } from '../icons';
import { useLm } from '../App';
import { fmtDate, fmtDateTime, licenseInfoText, statusHelp, statusTone, typeLabel } from '../format';
import { asApiError, type LicenseStatus, type LicenseView, type Stats } from '../types';

type TypeFilter = 'all' | 'perpetual' | 'limited';
type StatusFilter = 'all' | LicenseStatus;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'כל הסטטוסים' },
  { value: 'valid', label: 'בתוקף' },
  { value: 'expired', label: 'פג תוקף' },
  { value: 'revoked', label: 'מבוטל' },
  { value: 'replaced', label: 'הוחלף' },
  { value: 'unverifiable', label: 'לא ניתן לאימות' },
];

export function matches(l: LicenseView, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const compact = s.replace(/[\s-]/g, '');
  return [l.licensee, l.licenseId, l.nickname ?? '', l.notes ?? '', l.deviceId].some((f) => f.toLowerCase().includes(s)) || (compact.length >= 4 && l.deviceId.replace(/-/g, '').toLowerCase().includes(compact));
}

export function DashboardScreen() {
  const { api, info, vault, version, openIssue, openBackup, openRestore, go } = useLm();
  const ui = useUi();
  const [list, setList] = useState<LicenseView[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([api.listLicenses(), api.stats()]).then(
      ([l, s]) => {
        if (!live) return;
        setList(l);
        setStats(s);
      },
      (e) => ui.toast(asApiError(e).message, 'error'),
    );
    return () => {
      live = false;
    };
  }, [api, ui, version, reload]);

  const filtered = useMemo(
    () =>
      (list ?? [])
        .filter((l) => (type === 'all' ? true : l.licenseType === type))
        .filter((l) => (status === 'all' ? true : l.status === status))
        .filter((l) => matches(l, q))
        .sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : b.licenseId.localeCompare(a.licenseId))),
    [list, type, status, q],
  );

  const backupMissing = !info.lastBackupAt || info.lastBackupKeyId !== vault.key?.keyId;
  const current = list?.find((l) => l.licenseId === selected) ?? null;

  async function exportRevocations() {
    const ok = await ui.confirm({
      title: 'ייצוא רשימת ביטולים',
      confirmLabel: 'בחירת מיקום ושמירה',
      message: (
        <div className="space-y-2">
          <p>
            הקובץ <span className="mono">revoked-licenses.txt</span> מכיל את מספרי הרישיונות שסימנתם כמבוטלים. כדי שהביטול ייכנס לתוקף יש להחליף בו את הקובץ{' '}
            <span className="mono">src-tauri/keys/revoked-licenses.txt</span> בפרויקט Hours-Cal ולבנות גרסה חדשה.
          </p>
          <p className="font-medium">
            הרישיונות פועלים ללא אינטרנט, ולכן אין ביטול מרחוק ומיידי: הביטול חל רק במחשבים שיתקינו את הגרסה החדשה. מחשב שלא יעודכן ימשיך לפעול עם הרישיון שלו.
          </p>
        </div>
      ),
    });
    if (!ok) return;
    const out = await api.pickSave('revocationList', 'revoked-licenses.txt');
    if (!out) return;
    try {
      const n = await api.exportRevocationList(out);
      ui.toast(`רשימת הביטולים נשמרה (${n} רישיונות מבוטלים).`);
    } catch (e) {
      ui.toast(asApiError(e).message, 'error');
    }
  }

  return (
    <div data-testid="dashboard">
      <PageHeader
        title="רישיונות Hours-Cal"
        subtitle={
          <>
            מפתח חתימה פעיל: <span className="mono font-medium text-ink">{vault.key?.keyId}</span> · כל הרישיונות נחתמים באותו מפתח, ללא צורך לבנות מחדש את Hours-Cal.
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => openIssue()} data-testid="btn-issue">
              הפקת רישיון חדש
            </Button>
            <Button icon={<IconDownload size={16} />} onClick={openBackup} data-testid="btn-backup">
              גיבוי מפתחות
            </Button>
            <Button icon={<IconUpload size={16} />} onClick={openRestore} data-testid="btn-restore">
              שחזור מפתחות
            </Button>
            <Button icon={<IconMonitor size={16} />} onClick={() => go('myComputer')} data-testid="btn-my-computer">
              פרטי המחשב שלי
            </Button>
          </div>
        }
      />

      {backupMissing && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 px-5 py-3.5 ring-1 ring-amber-200" role="alert" data-testid="backup-warning">
          <div className="flex items-start gap-2.5 text-[14px] text-amber-900">
            <IconAlert size={18} className="mt-0.5 shrink-0" />
            <span>
              <b>עדיין לא נשמר גיבוי של מפתח החתימה.</b> המפתח קיים רק במחשב זה. אם המחשב יתקלקל או Windows יותקן מחדש, לא תוכלו להנפיק רישיונות שגרסאות Hours-Cal הקיימות מקבלות.
            </span>
          </div>
          <Button variant="primary" size="sm" onClick={openBackup}>
            שמירת גיבוי עכשיו
          </Button>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="stats">
        <StatCard label='סה"כ רישיונות' value={stats?.total} tone="brand" testid="stat-total" />
        <StatCard label="קבועים" value={stats?.perpetual} testid="stat-perpetual" />
        <StatCard label="מוגבלים בזמן" value={stats?.limited} testid="stat-limited" />
        <StatCard label="בתוקף" value={stats?.valid} tone="green" testid="stat-valid" />
        <StatCard label="פג תוקף" value={stats?.expired} tone="amber" testid="stat-expired" />
        <StatCard label="מבוטלים / הוחלפו" value={stats ? stats.revoked + stats.replaced : undefined} tone="slate" testid="stat-revoked" hint={stats?.unverifiable ? `${stats.unverifiable} לא ניתנים לאימות` : undefined} />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <div className="relative min-w-[260px] flex-1">
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-400">
              <IconSearch size={16} />
            </span>
            <input
              className="field-input pr-9"
              placeholder="חיפוש לפי שם, מספר רישיון, מזהה מחשב, כינוי או הערות"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="חיפוש רישיונות"
              data-testid="search"
            />
          </div>
          <Segmented<TypeFilter>
            value={type}
            onChange={setType}
            options={[
              { value: 'all', label: 'הכול' },
              { value: 'perpetual', label: 'קבועים' },
              { value: 'limited', label: 'מוגבלים בזמן' },
            ]}
          />
          <Select<StatusFilter> value={status} onChange={setStatus} options={STATUS_OPTIONS} className="!w-auto" aria-label="סינון לפי סטטוס" data-testid="status-filter" />
          <Button variant="ghost" size="sm" icon={<IconRefresh size={15} />} onClick={() => setReload((x) => x + 1)}>
            רענון
          </Button>
        </div>

        {list && list.length === 0 ? (
          <EmptyState
            icon={<IconShield size={26} />}
            title="עדיין לא הונפקו רישיונות"
            text='התחילו ברישיון למחשב שלכם: "פרטי המחשב שלי" ← "הנפקת רישיון למחשב זה". כך תוודאו שההפעלה עובדת לפני שתפעילו את דרישת הרישיון ב-Hours-Cal.'
            action={
              <div className="flex gap-2">
                <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => openIssue()}>
                  הפקת רישיון חדש
                </Button>
                <Button icon={<IconMonitor size={16} />} onClick={() => go('myComputer')}>
                  פרטי המחשב שלי
                </Button>
              </div>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]" data-testid="license-table">
              <thead>
                <tr className="border-b border-line bg-slate-50/70 text-right text-[12px] font-medium text-ink-soft">
                  <th className="px-4 py-2.5 font-medium">מספר רישיון</th>
                  <th className="px-4 py-2.5 font-medium">בעל הרישיון</th>
                  <th className="px-4 py-2.5 font-medium">מחשב</th>
                  <th className="px-4 py-2.5 font-medium">סוג</th>
                  <th className="px-4 py-2.5 font-medium">הונפק</th>
                  <th className="px-4 py-2.5 font-medium">בתוקף עד</th>
                  <th className="px-4 py-2.5 font-medium">סטטוס</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr
                    key={l.licenseId}
                    className="cursor-pointer border-b border-line/70 transition last:border-0 hover:bg-brand-soft/40"
                    onClick={() => setSelected(l.licenseId)}
                    data-testid={`row-${l.licenseId}`}
                  >
                    <td className="px-4 py-2.5">
                      <span className="mono text-[12.5px] text-ink">{l.licenseId}</span>
                    </td>
                    <td className="px-4 py-2.5 font-medium text-ink">{l.licensee}</td>
                    <td className="px-4 py-2.5">
                      {l.nickname && <div className="text-ink">{l.nickname}</div>}
                      <div className="mono text-right text-[11.5px] text-ink-soft">{l.deviceId}</div>
                    </td>
                    <td className="px-4 py-2.5">{l.licenseType === 'perpetual' ? <Badge tone="blue">קבוע</Badge> : <Badge tone="violet">מוגבל בזמן</Badge>}</td>
                    <td className="num px-4 py-2.5 text-right">{fmtDate(l.issuedAt)}</td>
                    <td className="num px-4 py-2.5 text-right">{l.expiresAt ? fmtDate(l.expiresAt) : <span className="text-ink-soft">ללא הגבלה</span>}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={statusTone[l.status]} title={statusHelp[l.status]}>
                        {l.statusHe}
                      </Badge>
                    </td>
                  </tr>
                ))}
                {list && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-ink-soft">
                      לא נמצאו רישיונות התואמים לחיפוש.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-[12.5px] text-ink-soft">
          <span>
            מוצגים {filtered.length} מתוך {list?.length ?? 0} רישיונות · תיקיית קבצי הרישיון: <span className="mono">{info.licenseDir}</span>
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<IconFolder size={15} />} onClick={() => api.revealPath(info.licenseDir).catch((e) => ui.toast(asApiError(e).message, 'error'))}>
              פתיחת התיקייה
            </Button>
            <Button size="sm" variant="ghost" icon={<IconBan size={15} />} onClick={() => void exportRevocations()} data-testid="btn-revocations">
              ייצוא רשימת ביטולים
            </Button>
          </div>
        </div>
      </Card>

      <LicenseDrawer license={current} all={list ?? []} onSelect={setSelected} onClose={() => setSelected(null)} onChanged={() => setReload((x) => x + 1)} />
    </div>
  );
}

function StatCard({ label, value, tone, testid, hint }: { label: string; value: number | undefined; tone?: 'brand' | 'green' | 'amber' | 'slate'; testid: string; hint?: string }) {
  const color = { brand: 'text-brand', green: 'text-emerald-700', amber: 'text-amber-700', slate: 'text-slate-600' }[tone ?? 'slate'] ?? 'text-ink';
  return (
    <Card className="px-4 py-3.5" data-testid={testid}>
      <div className="text-[12.5px] font-medium text-ink-soft">{label}</div>
      <div className={`num mt-1 text-right text-[26px] font-bold leading-none ${tone ? color : 'text-ink'}`}>{value ?? '–'}</div>
      {hint && <div className="mt-1 text-[11.5px] text-violet-700">{hint}</div>}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-line/60 py-2 text-[13.5px] last:border-0">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

function LicenseDrawer({
  license: l,
  all,
  onSelect,
  onClose,
  onChanged,
}: {
  license: LicenseView | null;
  all: LicenseView[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { api, openIssue } = useLm();
  const ui = useUi();
  const [reason, setReason] = useState('');
  const [showToken, setShowToken] = useState(false);
  useEffect(() => {
    setReason('');
    setShowToken(false);
  }, [l?.licenseId]);
  if (!l) return null;

  const byId = new Map(all.map((x) => [x.licenseId, x]));
  const history: { id: string; label: string }[] = [
    ...(l.replacedBy ? [{ id: l.replacedBy, label: 'הוחלף על ידי' }] : []),
    ...l.replacesChain.map((id, i) => ({ id, label: i === 0 ? 'מחליף את' : 'קודם לכן' })),
  ];

  async function reveal() {
    if (!l?.filePath) return;
    try {
      await api.revealPath(l.filePath);
    } catch (e) {
      ui.toast(`${asApiError(e).message}\nניתן לייצא את קובץ הרישיון מחדש.`, 'error');
    }
  }

  async function reexport() {
    try {
      const p = await api.reexportLicense(l!.licenseId);
      ui.toast('קובץ הרישיון נבדק ונשמר מחדש.');
      onChanged();
      await api.revealPath(p).catch(() => undefined);
    } catch (e) {
      ui.toast(asApiError(e).message, 'error');
    }
  }

  async function toggleRevoked() {
    const revoking = !l!.revokedAt;
    const ok = await ui.confirm({
      title: revoking ? 'סימון הרישיון כמבוטל' : 'ביטול סימון הביטול',
      danger: revoking,
      confirmLabel: revoking ? 'סימון כמבוטל' : 'החזרה לפעיל',
      message: revoking ? (
        <div className="space-y-2">
          <p>
            הרישיון <span className="mono">{l!.licenseId}</span> של {l!.licensee} יסומן כמבוטל ברשומות.
          </p>
          <p className="font-medium">
            חשוב: הרישיון פועל ללא אינטרנט, ולכן הסימון אינו עוצר אותו מרחוק. כדי לחסום אותו יש לייצא את רשימת הביטולים, לבנות גרסת Hours-Cal חדשה ולהתקין אותה במחשב — מחשב שלא יעודכן ימשיך
            לפעול.
          </p>
        </div>
      ) : (
        <p>הרישיון יוצג שוב כפעיל ולא ייכלל ברשימות ביטולים עתידיות.</p>
      ),
    });
    if (!ok) return;
    try {
      await api.setRevoked(l!.licenseId, revoking, revoking ? reason : undefined);
      ui.toast(revoking ? 'הרישיון סומן כמבוטל. זכרו לייצא רשימת ביטולים לגרסה הבאה.' : 'סימון הביטול הוסר.');
      onChanged();
    } catch (e) {
      ui.toast(asApiError(e).message, 'error');
    }
  }

  return (
    <Drawer open onClose={onClose} title={<span className="mono">{l.licenseId}</span>}>
      <div data-testid="license-drawer">
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-slate-50 p-3">
          <Badge tone={statusTone[l.status]}>{l.statusHe}</Badge>
          <span className="text-[12.5px] leading-snug text-ink-soft">{statusHelp[l.status]}</span>
        </div>
        <dl>
          <Row label="בעל הרישיון">{l.licensee}</Row>
          <Row label="מזהה מחשב">
            <span className="mono text-[12.5px]">{l.deviceId}</span>
          </Row>
          <Row label="כינוי המחשב">{l.nickname ?? '—'}</Row>
          <Row label="סוג">{typeLabel(l)}</Row>
          <Row label="תאריך הנפקה">{fmtDate(l.issuedAt)}</Row>
          <Row label="בתוקף עד">{l.expiresAt ? fmtDate(l.expiresAt) : 'ללא הגבלה'}</Row>
          <Row label="מפתח חתימה">
            <span className="mono text-[12.5px]">{l.keyId}</span>
          </Row>
          <Row label="נוצר ברשומות">{fmtDateTime(l.createdAt)}</Row>
          {l.revokedAt && (
            <Row label="בוטל">
              {fmtDateTime(l.revokedAt)}
              {l.revokeReason ? ` · ${l.revokeReason}` : ''}
            </Row>
          )}
          <Row label="מיקום הקובץ">
            {l.filePath ? (
              <button className="text-right text-[12.5px] text-brand hover:underline" onClick={() => void reveal()} title="הצגה בתיקייה">
                <span className="mono">{l.filePath}</span>
              </button>
            ) : (
              '—'
            )}
          </Row>
          {l.notes && (
            <Row label="הערות">
              <span className="whitespace-pre-wrap">{l.notes}</span>
            </Row>
          )}
        </dl>

        <h3 className="mb-2 mt-5 text-[13px] font-semibold text-ink">היסטוריית החלפות</h3>
        {history.length === 0 ? (
          <p className="text-[13px] text-ink-soft">רישיון זה לא החליף רישיון אחר ולא הוחלף.</p>
        ) : (
          <ul className="space-y-1.5" data-testid="replacement-history">
            {history.map((h) => (
              <li key={h.id} className="flex items-center gap-2 text-[13px]">
                <span className="w-24 shrink-0 text-ink-soft">{h.label}</span>
                <button className="mono text-brand hover:underline" onClick={() => onSelect(h.id)}>
                  {h.id}
                </button>
                <span className="truncate text-ink-soft">{byId.get(h.id)?.nickname ?? byId.get(h.id)?.deviceId ?? ''}</span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="mb-2 mt-5 text-[13px] font-semibold text-ink">פעולות</h3>
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" icon={<IconCopy size={15} />} onClick={() => api.copyText(licenseInfoText(l)).then(() => ui.toast('פרטי הרישיון הועתקו.'))}>
            העתקת פרטי הרישיון
          </Button>
          <Button size="sm" icon={<IconCopy size={15} />} onClick={() => api.copyText(l.token).then(() => ui.toast('מפתח ההפעלה הועתק.'))}>
            העתקת מפתח ההפעלה
          </Button>
          <Button size="sm" icon={<IconFolder size={15} />} disabled={!l.filePath} onClick={() => void reveal()}>
            הצגה בתיקייה
          </Button>
          <Button size="sm" icon={<IconDownload size={15} />} disabled={l.status === 'unverifiable'} onClick={() => void reexport()} data-testid="btn-reexport">
            ייצוא קובץ מחדש
          </Button>
          <Button
            size="sm"
            icon={<IconRefresh size={15} />}
            disabled={!!l.replacedBy}
            title="למחשב חדש או לאחר התקנה מחדש של Windows"
            onClick={() => {
              onClose();
              openIssue({ licensee: l.licensee, licenseType: l.licenseType, expiresAt: l.expiresAt, replaces: l.licenseId, notes: l.notes });
            }}
            data-testid="btn-replace"
          >
            הנפקת רישיון חלופי
          </Button>
          <Button size="sm" variant={l.revokedAt ? 'secondary' : 'danger'} icon={<IconBan size={15} />} onClick={() => void toggleRevoked()} data-testid="btn-revoke">
            {l.revokedAt ? 'ביטול סימון הביטול' : 'סימון כמבוטל'}
          </Button>
        </div>
        {!l.revokedAt && (
          <Field label="סיבת ביטול (לא חובה)" className="mt-3">
            <input className="field-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="למשל: הלקוח הפסיק את השימוש" />
          </Field>
        )}

        <button className="mt-5 text-[12.5px] text-brand hover:underline" onClick={() => setShowToken((v) => !v)}>
          {showToken ? 'הסתרת מפתח ההפעלה' : 'הצגת מפתח ההפעלה'}
        </button>
        {showToken && <pre className="mono mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 text-[11px] text-ink-soft">{l.token}</pre>}
      </div>
    </Drawer>
  );
}
