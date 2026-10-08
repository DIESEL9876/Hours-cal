import { useCallback, useEffect, useState } from 'react';
import { defaultEmployeeSettings, validateSettings, type EmployeeSettings } from '../../engine';
import type { Business } from '../../data/repo';
import { useApp } from '../App';
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, useUi } from '../components';
import { IconBuilding, IconEdit, IconPlus, IconArrowBack } from '../icons';
import { SettingsEditor } from '../SettingsEditor';
import { formatTimestamp, scheduleLabel, weekdayName } from '../format';

export function BusinessesScreen() {
  const { repo, go, dataVersion } = useApp();
  const ui = useUi();
  const [list, setList] = useState<Business[] | null>(null);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Business | 'new' | null>(null);

  const load = useCallback(async () => {
    const bs = await repo.listBusinesses(showArchived);
    setList(bs);
    const rows = await repo.driver.select<{ business_id: string; n: number }>(
      `SELECT business_id, COUNT(*) AS n FROM employees WHERE archived_at IS NULL GROUP BY business_id`,
    );
    setCounts(new Map(rows.map((r) => [r.business_id, Number(r.n)])));
  }, [repo, showArchived]);

  useEffect(() => {
    load().catch((e) => ui.toast(String(e), 'error'));
  }, [load, dataVersion, ui]);

  return (
    <div>
      <PageHeader
        title="ניהול עסקים"
        subtitle="מערכת לניהול נוכחות וחישוב שעות עבודה ושעות נוספות"
        actions={
          <>
            <label className="flex items-center gap-2 text-[13px] text-ink-soft">
              <input type="checkbox" className="accent-brand" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              הצגת עסקים בארכיון
            </label>
            <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
              הקמת עסק חדש
            </Button>
          </>
        }
      />

      {list && list.length === 0 && (
        <Card>
          <EmptyState
            icon={<IconBuilding size={26} />}
            title="עדיין לא הוקמו עסקים"
            text="הקימו עסק ראשון כדי להתחיל לנהל עובדים ודוחות נוכחות. כל עסק נשמר בנפרד לחלוטין."
            action={
              <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
                הקמת עסק חדש
              </Button>
            }
          />
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list?.map((b) => (
          <Card key={b.id} data-testid="business-card" className={`flex flex-col p-5 transition hover:shadow-md ${b.archivedAt ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                  <IconBuilding size={22} />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[16px] font-semibold text-ink" data-testid="business-name">
                    {b.name}
                  </div>
                  <div className="text-[13px] text-ink-soft">{b.identifier ? <span className="num">{b.identifier}</span> : 'ללא מזהה'}</div>
                </div>
              </div>
              {b.archivedAt && <Badge tone="amber">בארכיון</Badge>}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-[12px]">
              <div>
                <div className="text-ink-soft">עובדים</div>
                <div className="text-[15px] font-semibold">{counts.get(b.id) ?? 0}</div>
              </div>
              <div>
                <div className="text-ink-soft">מתכונת</div>
                <div className="text-[13px] font-medium">{scheduleLabel(b.defaults)}</div>
              </div>
              <div>
                <div className="text-ink-soft">יום מקוצר</div>
                <div className="text-[13px] font-medium">{b.defaults.workweek === 'five' ? weekdayName(b.defaults.shortDay) : '–'}</div>
              </div>
            </div>
            <div className="mt-3 text-[12px] text-ink-soft">עודכן: {formatTimestamp(b.updatedAt)}</div>
            <div className="mt-4 flex gap-2">
              {b.archivedAt ? (
                <Button
                  onClick={async () => {
                    await repo.restoreBusiness(b.id);
                    ui.toast('העסק שוחזר מהארכיון');
                    load();
                  }}
                >
                  שחזור מהארכיון
                </Button>
              ) : (
                <>
                  <Button variant="primary" className="flex-1" icon={<IconArrowBack size={16} />} onClick={() => go({ name: 'employees', businessId: b.id })}>
                    כניסה לעסק
                  </Button>
                  <Button icon={<IconEdit size={16} />} onClick={() => setEditing(b)}>
                    עריכת פרטי עסק
                  </Button>
                </>
              )}
            </div>
          </Card>
        ))}
      </div>

      {editing && (
        <BusinessForm
          business={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(b) => {
            setEditing(null);
            load();
            if (editing === 'new') go({ name: 'employees', businessId: b.id });
          }}
        />
      )}
    </div>
  );
}

function BusinessForm({ business, onClose, onSaved }: { business: Business | null; onClose: () => void; onSaved: (b: Business) => void }) {
  const { repo } = useApp();
  const ui = useUi();
  const [name, setName] = useState(business?.name ?? '');
  const [identifier, setIdentifier] = useState(business?.identifier ?? '');
  const [defaults, setDefaults] = useState<EmployeeSettings>(business?.defaults ?? defaultEmployeeSettings());
  const [busy, setBusy] = useState(false);
  const errors = validateSettings(defaults);

  const save = async () => {
    if (!name.trim()) return ui.toast('יש להזין שם עסק', 'error');
    setBusy(true);
    try {
      const b = business
        ? await repo.updateBusiness(business.id, { name, identifier, defaults })
        : await repo.createBusiness({ name, identifier, defaults });
      ui.toast(business ? 'פרטי העסק נשמרו' : 'העסק הוקם בהצלחה');
      onSaved(b);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!business) return;
    const ok = await ui.confirm({
      title: 'העברת עסק לארכיון',
      message: (
        <>
          העסק <b>{business.name}</b> יוסתר מרשימת העסקים. הנתונים אינם נמחקים וניתן לשחזר אותו בכל עת.
        </>
      ),
      confirmLabel: 'העברה לארכיון',
      danger: true,
      typeToConfirm: business.name,
    });
    if (!ok) return;
    try {
      await repo.archiveBusiness(business.id, business.name);
      ui.toast('העסק הועבר לארכיון');
      onSaved(business);
    } catch (e) {
      ui.toast(String(e), 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={business ? 'עריכת פרטי עסק' : 'הקמת עסק חדש'}
      footer={
        <>
          <Button variant="primary" disabled={busy || errors.length > 0} onClick={save}>
            {business ? 'שמירת שינויים' : 'הקמת העסק'}
          </Button>
          <Button onClick={onClose}>ביטול</Button>
          {business && (
            <Button variant="ghost" className="ms-auto text-red-600 hover:bg-red-50 hover:text-red-700" onClick={archive}>
              העברה לארכיון
            </Button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="שם העסק *">
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="business-name-input" />
        </Field>
        <Field label="מזהה עסק (ח.פ / ע.מ, אופציונלי)">
          <input className="field-input num text-left" value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/50 px-4 py-3 text-[13px] text-blue-900">
        ההגדרות שלהלן הן <b>ברירת המחדל לעובדים חדשים</b> בעסק. הן מועתקות לכל עובד בעת הקמתו, ושינוי שלהן לא משנה חישובים של עובדים קיימים.
      </div>
      <div className="mt-5">
        <SettingsEditor value={defaults} onChange={setDefaults} />
      </div>
      {errors.length > 0 && <div className="mt-4 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{errors.join(' · ')}</div>}
    </Modal>
  );
}
