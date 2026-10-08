import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BEGINNING_OF_TIME,
  monthRange,
  resolveSettings,
  validateSettings,
  type BusinessSummary,
  type EmployeeSettings,
  type SettingsVersion,
} from '../../engine';
import type { AuditEntry, Business, Employee } from '../../data/repo';
import { computeBusinessMonth } from '../../data/service';
import { Crumbs, useApp } from '../App';
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Segmented, useUi } from '../components';
import { IconCalendar, IconChart, IconClock, IconEdit, IconHistory, IconPlus, IconSearch, IconUsers } from '../icons';
import { MonthPicker } from '../MonthPicker';
import { SettingsEditor } from '../SettingsEditor';
import { formatDateHe, formatTimestamp, hm, monthTitle, scheduleLabel, weekdayName } from '../format';

interface Row {
  employee: Employee;
  settings: EmployeeSettings | null;
  progress: { entered: number; scheduled: number };
  netMinutes: number;
  issues: number;
}

export function EmployeesScreen({ businessId }: { businessId: string }) {
  const { repo, go, ym, setYm, dataVersion } = useApp();
  const ui = useUi();
  const [business, setBusiness] = useState<Business | null>(null);
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [versions, setVersions] = useState<Map<string, SettingsVersion[]>>(new Map());
  const [summary, setSummary] = useState<BusinessSummary | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const [showHolidays, setShowHolidays] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    const [b, emps] = await Promise.all([repo.getBusiness(businessId), repo.listEmployees(businessId, showArchived)]);
    setBusiness(b);
    setEmployees(emps);
    const vs = new Map<string, SettingsVersion[]>();
    await Promise.all(emps.map(async (e) => vs.set(e.id, await repo.getSettingsVersions(e.id))));
    setVersions(vs);
    setSummary(await computeBusinessMonth(repo, businessId, ym.year, ym.month, emps));
  }, [repo, businessId, ym, showArchived]);

  useEffect(() => {
    load().catch((e) => ui.toast(String(e), 'error'));
  }, [load, dataVersion, ui]);

  const rows: Row[] = useMemo(() => {
    if (!employees) return [];
    const { to } = monthRange(ym.year, ym.month);
    return employees.map((e) => {
      const r = summary?.rows.find((x) => x.employeeId === e.id);
      let entered = 0;
      let scheduled = 0;
      for (const d of r?.result.days ?? []) {
        const has = d.shifts.length > 0 || d.status !== null;
        if (d.scheduled && !d.holidayName) {
          scheduled++;
          if (has) entered++;
        }
      }
      return {
        employee: e,
        settings: resolveSettings(versions.get(e.id) ?? [], to)?.settings ?? null,
        progress: { entered, scheduled },
        netMinutes: r?.totals.netMinutes ?? 0,
        issues: (r?.totals.errorCount ?? 0) + (r?.totals.unconfirmedBreaks ?? 0),
      };
    });
  }, [employees, summary, versions, ym]);

  const filtered = rows.filter((r) => {
    const q = query.trim();
    if (!q) return true;
    return r.employee.fullName.includes(q) || (r.employee.employeeNumber ?? '').includes(q);
  });

  if (!business) return null;

  return (
    <div>
      <PageHeader
        breadcrumbs={<Crumbs items={[{ label: 'עסקים', onClick: () => go({ name: 'businesses' }) }, { label: 'עובדים' }]} />}
        title={business.name}
        subtitle={`עובדים · ${monthTitle(ym.year, ym.month)}`}
        actions={
          <>
            <MonthPicker value={ym} onChange={setYm} />
            <Button icon={<IconChart size={18} />} onClick={() => go({ name: 'summary', businessId })}>
              סיכום חודשי
            </Button>
            <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
              הוספת עובד
            </Button>
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="relative w-full max-w-sm">
            <IconSearch size={17} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="field-input pr-9" placeholder="חיפוש לפי שם או מספר עובד" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="flex items-center gap-1">
            <label className="me-2 flex items-center gap-2 text-[13px] text-ink-soft">
              <input type="checkbox" className="accent-brand" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              כולל עובדים בארכיון
            </label>
            <Button variant="ghost" size="sm" icon={<IconCalendar size={16} />} onClick={() => setShowHolidays(true)}>
              חגים מותאמים
            </Button>
            <Button variant="ghost" size="sm" icon={<IconHistory size={16} />} onClick={() => setShowAudit(true)}>
              יומן שינויים
            </Button>
            <Button variant="ghost" size="sm" onClick={() => go({ name: 'businesses' })}>
              חזרה לעסקים
            </Button>
          </div>
        </div>

        {employees && employees.length === 0 ? (
          <EmptyState
            icon={<IconUsers size={26} />}
            title="אין עובדים בעסק"
            text="הוסיפו עובד ראשון. הגדרות ברירת המחדל של העסק יועתקו אליו וניתן לשנותן."
            action={
              <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
                הוספת עובד
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line bg-slate-50/70 text-right text-[12px] font-medium text-ink-soft">
                  <th className="px-4 py-2.5 font-medium">שם העובד</th>
                  <th className="px-3 py-2.5 font-medium">מספר עובד</th>
                  <th className="px-3 py-2.5 font-medium">מתכונת</th>
                  <th className="px-3 py-2.5 font-medium">יום מקוצר</th>
                  <th className="px-3 py-2.5 font-medium">התקדמות הזנה</th>
                  <th className="px-3 py-2.5 font-medium">שעות נטו בחודש</th>
                  <th className="px-3 py-2.5 font-medium">עודכן לאחרונה</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const pct = r.progress.scheduled ? Math.round((r.progress.entered / r.progress.scheduled) * 100) : 0;
                  return (
                    <tr key={r.employee.id} className="group border-b border-line/70 last:border-0 hover:bg-slate-50/60" data-testid="employee-row">
                      <td className="px-4 py-3">
                        <button className="font-medium text-ink hover:text-brand" onClick={() => go({ name: 'attendance', businessId, employeeId: r.employee.id })}>
                          {r.employee.fullName}
                        </button>
                        {r.employee.archivedAt && (
                          <span className="ms-2">
                            <Badge tone="amber">בארכיון</Badge>
                          </span>
                        )}
                      </td>
                      <td className="num px-3 py-3 text-right text-ink-soft">{r.employee.employeeNumber ?? '–'}</td>
                      <td className="px-3 py-3">{r.settings ? scheduleLabel(r.settings) : '–'}</td>
                      <td className="px-3 py-3">{r.settings?.workweek === 'five' ? weekdayName(r.settings.shortDay) : '–'}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                            <div className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-brand'}`} style={{ width: `${Math.min(100, pct)}%` }} />
                          </div>
                          <span className="num text-[12px] text-ink-soft">
                            {r.progress.entered}/{r.progress.scheduled}
                          </span>
                          {r.issues > 0 && <Badge tone="amber">{r.issues} לטיפול</Badge>}
                        </div>
                      </td>
                      <td className="num px-3 py-3 text-right font-medium">{hm(r.netMinutes, '0:00')}</td>
                      <td className="px-3 py-3 text-[13px] text-ink-soft">{formatTimestamp(r.employee.updatedAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="primary" icon={<IconClock size={15} />} onClick={() => go({ name: 'attendance', businessId, employeeId: r.employee.id })}>
                            פתיחת דוח שעות
                          </Button>
                          <Button size="sm" icon={<IconEdit size={15} />} onClick={() => setEditing(r.employee)}>
                            עריכת עובד
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && employees && employees.length > 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-ink-soft">
                      לא נמצאו עובדים התואמים לחיפוש
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <EmployeeForm
          business={business}
          employee={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {showHolidays && <HolidaysModal businessId={businessId} onClose={() => (setShowHolidays(false), load())} />}
      {showAudit && <AuditModal businessId={businessId} employees={employees ?? []} onClose={() => setShowAudit(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Employee form (details + versioned calculation settings)
// ---------------------------------------------------------------------------

function EmployeeForm({ business, employee, onClose, onSaved }: { business: Business; employee: Employee | null; onClose: () => void; onSaved: () => void }) {
  const { repo, ym } = useApp();
  const ui = useUi();
  const [tab, setTab] = useState<'details' | 'settings'>('details');
  const [fullName, setFullName] = useState(employee?.fullName ?? '');
  const [number, setNumber] = useState(employee?.employeeNumber ?? '');
  const [notes, setNotes] = useState(employee?.notes ?? '');
  const [versions, setVersions] = useState<SettingsVersion[]>([]);
  const [settings, setSettings] = useState<EmployeeSettings>(business.defaults);
  const [dirtySettings, setDirtySettings] = useState(false);
  const firstOfMonth = `${ym.year}-${String(ym.month).padStart(2, '0')}-01`;
  const [effectiveFrom, setEffectiveFrom] = useState(firstOfMonth);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!employee) return;
    repo.getSettingsVersions(employee.id).then((vs) => {
      setVersions(vs);
      const current = resolveSettings(vs, firstOfMonth) ?? vs[vs.length - 1];
      if (current) setSettings(current.settings);
    });
  }, [employee, repo, firstOfMonth]);

  const errors = validateSettings(settings);

  const save = async () => {
    if (!fullName.trim()) return ui.toast('יש להזין שם עובד', 'error');
    setBusy(true);
    try {
      if (!employee) {
        await repo.createEmployee(business.id, { fullName, employeeNumber: number, notes, settings });
        ui.toast('העובד נוסף');
      } else {
        await repo.updateEmployee(business.id, employee.id, { fullName, employeeNumber: number, notes });
        if (dirtySettings) {
          const existing = versions.find((v) => v.effectiveFrom === effectiveFrom);
          const later = versions.some((v) => v.effectiveFrom > effectiveFrom);
          let authorize = false;
          if (existing || later) {
            authorize = await ui.confirm({
              title: 'שינוי רטרואקטיבי',
              message: existing
                ? `קיימת כבר גרסת הגדרות שתחילתה ${existing.effectiveFrom === BEGINNING_OF_TIME ? 'מתחילת ההעסקה' : formatDateHe(existing.effectiveFrom)}. עדכונה ישנה את חישובי כל החודשים שבתקופתה, כולל חודשים שכבר דווחו. להמשיך?`
                : 'קיימת גרסת הגדרות מאוחרת יותר. הוספת גרסה לפניה תשנה חישובים קיימים. להמשיך?',
              confirmLabel: 'כן, לעדכן היסטוריה',
              danger: true,
            });
            if (!authorize) {
              setBusy(false);
              return;
            }
          }
          await repo.saveSettingsVersion(business.id, employee.id, effectiveFrom, settings, { authorizeRetroactive: authorize });
        }
        ui.toast('פרטי העובד נשמרו');
      }
      onSaved();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!employee) return;
    const ok = await ui.confirm({
      title: 'העברת עובד לארכיון',
      message: `העובד ${employee.fullName} יוסתר מהרשימה. רישומי הנוכחות נשמרים וניתן לשחזר.`,
      confirmLabel: 'העברה לארכיון',
      danger: true,
    });
    if (!ok) return;
    await repo.archiveEmployee(business.id, employee.id);
    ui.toast('העובד הועבר לארכיון');
    onSaved();
  };

  const restore = async () => {
    if (!employee) return;
    try {
      await repo.restoreEmployee(business.id, employee.id);
      ui.toast('העובד שוחזר');
      onSaved();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={employee ? `עריכת עובד – ${employee.fullName}` : 'הוספת עובד'}
      footer={
        <>
          <Button variant="primary" disabled={busy || errors.length > 0} onClick={save} data-testid="save-employee">
            {employee ? 'שמירה' : 'הוספת העובד'}
          </Button>
          <Button onClick={onClose}>ביטול</Button>
          {employee && !employee.archivedAt && (
            <Button variant="ghost" className="ms-auto text-red-600 hover:bg-red-50" onClick={archive}>
              העברה לארכיון
            </Button>
          )}
          {employee?.archivedAt && (
            <Button variant="ghost" className="ms-auto" onClick={restore}>
              שחזור מהארכיון
            </Button>
          )}
        </>
      }
    >
      <div className="mb-5">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'details', label: 'פרטי עובד' }, { value: 'settings', label: 'הגדרות חישוב' }]} />
      </div>
      {tab === 'details' ? (
        <div className="grid grid-cols-2 gap-4">
          <Field label="שם מלא *">
            <input className="field-input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus data-testid="employee-name-input" />
          </Field>
          <Field label="מספר עובד (אופציונלי)">
            <input className="field-input num text-left" value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <Field label="הערות" className="col-span-2">
            <textarea className="field-input min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {!employee && (
            <div className="col-span-2 rounded-lg bg-slate-50 p-3 text-[13px] text-ink-soft">
              הגדרות החישוב יועתקו מברירת המחדל של העסק ({scheduleLabel(business.defaults)}). ניתן לשנותן בלשונית "הגדרות חישוב".
            </div>
          )}
        </div>
      ) : (
        <div>
          {employee && (
            <div className="mb-5 rounded-xl border border-line bg-slate-50/60 p-4">
              <div className="mb-2 text-[13px] font-medium">היסטוריית הגדרות</div>
              <div className="flex flex-wrap gap-2">
                {versions.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => {
                      setSettings(v.settings);
                      setEffectiveFrom(v.effectiveFrom);
                      setDirtySettings(false);
                    }}
                    className={`rounded-lg border px-3 py-1.5 text-[12px] ${effectiveFrom === v.effectiveFrom ? 'border-brand bg-white text-brand' : 'border-line bg-white text-ink-soft'}`}
                  >
                    {v.effectiveFrom === BEGINNING_OF_TIME ? 'מתחילת ההעסקה' : `החל מ-${formatDateHe(v.effectiveFrom)}`} · {scheduleLabel(v.settings)}
                  </button>
                ))}
              </div>
              <Field label="השינויים יחולו החל מתאריך" className="mt-3 max-w-xs" hint="ברירת המחדל: תחילת החודש הנבחר. חודשים קודמים לא ישתנו.">
                <input
                  type="date"
                  className="field-input num"
                  value={effectiveFrom === BEGINNING_OF_TIME ? '' : effectiveFrom}
                  onChange={(e) => e.target.value && setEffectiveFrom(e.target.value)}
                />
              </Field>
            </div>
          )}
          <SettingsEditor
            value={settings}
            onChange={(s) => {
              setSettings(s);
              setDirtySettings(true);
            }}
          />
          {errors.length > 0 && <div className="mt-4 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{errors.join(' · ')}</div>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Custom holidays
// ---------------------------------------------------------------------------

function HolidaysModal({ businessId, onClose }: { businessId: string; onClose: () => void }) {
  const { repo } = useApp();
  const ui = useUi();
  const [list, setList] = useState<{ date: string; name: string }[]>([]);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const load = useCallback(() => repo.listCustomHolidays(businessId).then(setList), [repo, businessId]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Modal open onClose={onClose} title="חגים וימי שבתון מותאמים לעסק" footer={<Button onClick={onClose}>סגירה</Button>}>
      <p className="mb-4 text-[13px] text-ink-soft">
        חגי ישראל מזוהים אוטומטית לעובדים שמוגדר להם לוח חגי ישראל. כאן ניתן להוסיף ימי חג נוספים (למשל חגים לעובדים שאינם יהודים). עבודה ביום כזה תסווג כעבודה בחג ותסומן לבדיקה.
      </p>
      <div className="flex items-end gap-2">
        <Field label="תאריך">
          <input type="date" className="field-input num" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="שם החג" className="flex-1">
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button
          variant="primary"
          disabled={!date || !name.trim()}
          onClick={async () => {
            await repo.setCustomHoliday(businessId, date, name);
            setDate('');
            setName('');
            ui.toast('החג נוסף');
            load();
          }}
        >
          הוספה
        </Button>
      </div>
      <div className="mt-4 divide-y divide-line rounded-lg border border-line">
        {list.length === 0 && <div className="p-4 text-center text-[13px] text-ink-soft">לא הוגדרו חגים מותאמים</div>}
        {list.map((h) => (
          <div key={h.date} className="flex items-center justify-between px-4 py-2.5 text-[14px]">
            <span>
              <span className="num ml-3 text-ink-soft">{formatDateHe(h.date)}</span>
              {h.name}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (await ui.confirm({ title: 'הסרת חג', message: `להסיר את "${h.name}"?`, danger: true, confirmLabel: 'הסרה' })) {
                  await repo.setCustomHoliday(businessId, h.date, null);
                  load();
                }
              }}
            >
              הסרה
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

const ENTITY_LABELS: Record<string, string> = {
  business: 'עסק',
  employee: 'עובד',
  employee_settings: 'הגדרות עובד',
  shift: 'משמרת',
  day_entry: 'סטטוס / הערה',
  custom_holiday: 'חג מותאם',
  month_review: 'סטטוס חודש',
};
const ACTION_LABELS: Record<string, string> = {
  create: 'יצירה',
  update: 'עדכון',
  delete: 'מחיקה',
  archive: 'העברה לארכיון',
  restore: 'שחזור',
  update_retroactive: 'עדכון רטרואקטיבי',
  set: 'הגדרה',
  open: 'פתיחה מחדש',
  in_review: 'בבדיקה',
  final: 'סגירה סופית',
};

function describe(e: AuditEntry): string {
  const a = (e.after ?? e.before) as Record<string, unknown> | null;
  if (e.entity === 'shift' && a) {
    const f = (v: unknown) => (typeof v === 'string' ? v.replace('T', ' ') : '–');
    const b = e.before as Record<string, unknown> | null;
    const af = e.after as Record<string, unknown> | null;
    if (b && af) return `${f(b.startAt)}–${f(b.endAt)} ⟵ ${f(af.startAt)}–${f(af.endAt)}`;
    return `${f(a.startAt)} – ${f(a.endAt)}`;
  }
  if (e.entity === 'day_entry') return e.entityId ? formatDateHe(e.entityId) : '';
  if (e.entity === 'month_review') return e.entityId ?? '';
  return '';
}

function AuditModal({ businessId, employees, onClose }: { businessId: string; employees: Employee[]; onClose: () => void }) {
  const { repo } = useApp();
  const [rows, setRows] = useState<AuditEntry[]>([]);
  useEffect(() => {
    repo.listAudit(businessId, null, 300).then(setRows);
  }, [repo, businessId]);
  const names = new Map(employees.map((e) => [e.id, e.fullName]));
  return (
    <Modal open onClose={onClose} width="max-w-4xl" title="יומן שינויים (300 האחרונים)" footer={<Button onClick={onClose}>סגירה</Button>}>
      <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-line">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-slate-50 text-right text-ink-soft">
            <tr>
              <th className="px-3 py-2 font-medium">זמן</th>
              <th className="px-3 py-2 font-medium">עובד</th>
              <th className="px-3 py-2 font-medium">רכיב</th>
              <th className="px-3 py-2 font-medium">פעולה</th>
              <th className="px-3 py-2 font-medium">פרטים</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line/70">
                <td className="whitespace-nowrap px-3 py-1.5 text-ink-soft">{formatTimestamp(r.at)}</td>
                <td className="px-3 py-1.5">{r.employeeId ? (names.get(r.employeeId) ?? '–') : '–'}</td>
                <td className="px-3 py-1.5">{ENTITY_LABELS[r.entity] ?? r.entity}</td>
                <td className="px-3 py-1.5">{ACTION_LABELS[r.action] ?? r.action}</td>
                <td className="num px-3 py-1.5 text-right">{describe(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
