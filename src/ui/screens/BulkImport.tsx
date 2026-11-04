/**
 * "ייבוא עובדים ודוחות נוכחות" (1.1.8): one workbook → every employee and their attendance, after ONE controlled review.
 * Nothing is written until "אישור וקליטת הנתונים"; the approved plan is one atomic repository batch (undoable).
 */
import { useEffect, useMemo, useState } from 'react';
import { businessFridayHistory, businessFridayOn, businessWeeklyCreditHistory, businessWeeklyCreditOn, monthRange, validateSettings, type EmployeeSettings, type ShiftInput } from '../../engine';
import type { Business, BulkImportResult, Employee } from '../../data/repo';
import { isTauri } from '../../data/tauriDriver';
import { useApp } from '../App';
import { Badge, Button, Checkbox, Modal, Segmented, useUi } from '../components';
import { IconInfo } from '../icons';
import { hm, monthTitle, scheduleLabel, BREAK_METHOD_LABELS } from '../format';
import { SettingsEditor, FRIDAY_OVERTIME_LABELS } from '../SettingsEditor';
import {
  analyzeWorkbook,
  blockingProblems,
  buildBulkChanges,
  countPreview,
  evaluateRow,
  ImportError,
  planContext,
  proposeEntries,
  readImportFile,
  retarget,
  summarize,
  tauriXlsReader,
  willWrite,
  type BulkAction,
  type BulkContext,
  type BulkEntry,
  type PreviewRow,
  type WorkbookAnalysis,
} from '../../import';
import { Banner, PreviewLine } from './AttendanceImport';

export const BULK_ACCEPT = '.xlsx,.xlsm,.xls';

export interface NewBusinessDraft {
  name: string;
  identifier: string | null;
  defaults: EmployeeSettings;
}

/** Settings a new employee receives: the business defaults, Friday and absence settings "לפי הגדרת העסק". */
export function inheritedSettings(defaults: EmployeeSettings): EmployeeSettings {
  const { fridayOvertimeHistory: _f, weeklyCreditHistory: _w, absence: _a, travel: _t, agreements: _g, ...copy } = defaults;
  return { ...copy, fridayOvertime: 'inherit', absence: {}, travel: { mode: 'inherit' }, agreements: [] };
}

const actionValue = (a: BulkAction | null) => (a === null ? '' : a.kind === 'existing' ? `existing:${a.employeeId}` : a.kind === 'merge' ? `merge:${a.into}` : a.kind);
const parseAction = (v: string): BulkAction | null => {
  if (!v) return null;
  if (v.startsWith('existing:')) return { kind: 'existing', employeeId: v.slice(9) };
  if (v.startsWith('merge:')) return { kind: 'merge', into: v.slice(6) };
  return { kind: v as 'create' | 'skip' | 'review' };
};

export function BulkImportWizard({
  business,
  newBusiness,
  file,
  onClose,
  onDone,
}: {
  business: Business | null;
  newBusiness: NewBusinessDraft | null;
  file: File;
  onClose: () => void;
  onDone: (r: BulkImportResult, ym: { year: number; month: number } | null, goTo: 'summary' | 'employees' | null) => void;
}) {
  const { repo } = useApp();
  const ui = useUi();
  const defaults = business?.defaults ?? newBusiness!.defaults;
  const bizName = business?.name ?? newBusiness!.name;
  const [phase, setPhase] = useState<'reading' | 'error' | 'review' | 'saving' | 'done'>('reading');
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<WorkbookAnalysis | null>(null);
  const [existing, setExisting] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<Map<string, ShiftInput[]>>(new Map());
  const [finalMonths, setFinalMonths] = useState<string[]>([]);
  const [entries, setEntries] = useState<BulkEntry[]>([]);
  const [gapIsBreak, setGapIsBreak] = useState(true);
  const [zeroBreak, setZeroBreak] = useState<'policy' | 'source'>('policy');
  const [settings, setSettings] = useState<EmployeeSettings>(() => inheritedSettings(defaults));
  const [showSettings, setShowSettings] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [result, setResult] = useState<BulkImportResult | null>(null);

  const ctx: BulkContext = useMemo(
    () => ({ existing: existing.map((e) => ({ id: e.id, fullName: e.fullName, employeeNumber: e.employeeNumber })), shiftsOf: (id) => shifts.get(id) ?? [], gapIsBreak, zeroBreak }),
    [existing, shifts, gapIsBreak, zeroBreak],
  );

  // 1. Read the workbook locally, analyse every sheet, load the business's existing employees and shifts.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const grid = await readImportFile({ name: file.name, bytes }, { xlsReader: isTauri() ? tauriXlsReader : null });
        const a = analyzeWorkbook(grid, { fallbackYear: new Date().getFullYear() });
        if (!a.employees.length) throw new ImportError('לא נמצאו בקובץ גיליונות עם טבלת נוכחות.');
        let emps: Employee[] = [];
        const map = new Map<string, ShiftInput[]>();
        const finals: string[] = [];
        if (business) {
          emps = await repo.listEmployees(business.id);
          const months = [...new Set(a.employees.filter((e) => e.year && e.month).map((e) => `${e.year}-${String(e.month).padStart(2, '0')}`))];
          for (const ym of months) {
            const { from, to } = monthRange(+ym.slice(0, 4), +ym.slice(5));
            for (const e of emps) map.set(e.id, [...(map.get(e.id) ?? []), ...(await repo.getShifts(business.id, e.id, from, to))]);
            if ((await repo.getMonthReview(business.id, ym)).status === 'final') finals.push(ym);
          }
        }
        if (!alive) return;
        const c: BulkContext = { existing: emps.map((e) => ({ id: e.id, fullName: e.fullName, employeeNumber: e.employeeNumber })), shiftsOf: (id) => map.get(id) ?? [], gapIsBreak: true, zeroBreak: 'policy' };
        setExisting(emps);
        setShifts(map);
        setFinalMonths(finals);
        setAnalysis(a);
        setEntries(proposeEntries(a, c));
        setPhase('review');
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ImportError ? e.message : `לא ניתן היה לקרוא את הקובץ: ${e instanceof Error ? e.message : String(e)}`);
        setPhase('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [file, repo, business]);

  // Break options apply to every sheet.
  useEffect(() => {
    setEntries((list) => list.map((e) => retarget(e, ctx)));
  }, [ctx]);

  const update = (key: string, patch: Partial<BulkEntry>) =>
    setEntries((list) =>
      list.map((e) => {
        if (e.key !== key) return e;
        const next = { ...e, ...patch };
        return patch.action !== undefined ? retarget(next, ctx) : next;
      }),
    );
  const updateRow = (key: string, date: string, patch: Partial<PreviewRow>) =>
    setEntries((list) =>
      list.map((e) => {
        if (e.key !== key) return e;
        const pc = planContext(e, ctx);
        return { ...e, rows: e.rows.map((r) => (r.date === date ? evaluateRow({ ...r, ...patch, edited: patch.include === undefined && patch.conflictChoice === undefined ? true : r.edited }, pc) : r)) };
      }),
    );

  const summary = analysis ? summarize(analysis, entries) : null;
  const problems = blockingProblems(entries, ctx.existing);
  const settingsErrors = validateSettings(settings);
  const hasMulti = entries.some((e) => e.rows.some((r) => r.segments.filter((s) => s.start || s.end).length > 1));
  const hasZero = entries.some((e) => e.rows.some((r) => r.explicitBreak && r.breakText.trim() === '0'));
  const creating = entries.filter((e) => e.include && e.action?.kind === 'create').length;
  const updating = entries.filter((e) => e.include && e.action?.kind === 'existing').length;
  const canApprove = phase === 'review' && problems.length === 0 && settingsErrors.length === 0 && !!summary && summary.shifts + creating > 0;

  async function approve() {
    if (!analysis) return;
    if (finalMonths.length) {
      const ok = await ui.confirm({
        title: 'חודש שנסגר סופית',
        danger: true,
        confirmLabel: 'קליטה בכל זאת',
        message: `החודש ${finalMonths.map((m) => monthTitle(+m.slice(0, 4), +m.slice(5))).join(', ')} סומן כסופי. קליטה תשנה את חישובי החודש והשינוי יזוהה כשינוי לאחר סגירה. להמשיך?`,
      });
      if (!ok) return;
    }
    setPhase('saving');
    try {
      const changes = buildBulkChanges(entries, ctx, settings);
      const r = await repo.bulkImport({
        business: business ? { id: business.id } : { create: newBusiness! },
        employees: changes,
        meta: { fileName: file.name, fileBytes: file.size, sheets: analysis.sheetsAnalyzed, summary },
      });
      setResult(r);
      setPhase('done');
      ui.toast(`נקלטו ${r.employees.reduce((a, e) => a + e.added.length, 0)} משמרות ל-${r.employees.length} עובדים.`);
    } catch (e) {
      ui.toast(`הקליטה נכשלה ולא נשמר דבר: ${e instanceof Error ? e.message : String(e)}`, 'error');
      setPhase('review');
    }
  }

  const mainYm = (() => {
    const counts = new Map<string, number>();
    for (const e of entries) if (e.source.year && e.source.month) counts.set(`${e.source.year}-${e.source.month}`, (counts.get(`${e.source.year}-${e.source.month}`) ?? 0) + 1);
    const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return best ? { year: +best.split('-')[0], month: +best.split('-')[1] } : null;
  })();

  // ------------------------------------------------------------------- render
  if (phase === 'reading' || phase === 'error') {
    return (
      <Modal open onClose={onClose} title="ייבוא עובדים ודוחות נוכחות" width="max-w-lg" footer={<Button onClick={onClose}>{phase === 'error' ? 'סגירה' : 'ביטול'}</Button>}>
        {phase === 'reading' ? (
          <div className="py-4 text-center" data-testid="bulk-reading">
            <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            <div className="text-[14px]">קורא את הקובץ "{file.name}" ומזהה עובדים במחשב זה…</div>
          </div>
        ) : (
          <Banner tone="warn">{error}</Banner>
        )}
      </Modal>
    );
  }

  if (phase === 'done' && result) {
    const skipped = entries.filter((e) => !e.include || !e.action || e.action.kind === 'skip' || e.action.kind === 'review');
    return (
      <Modal
        open
        onClose={() => onDone(result, mainYm, null)}
        title="הייבוא הושלם"
        width="max-w-2xl"
        footer={
          <>
            <Button variant="primary" onClick={() => onDone(result, mainYm, 'summary')} data-testid="bulk-go-summary">
              מעבר לסיכום החודשי
            </Button>
            <Button onClick={() => onDone(result, mainYm, 'employees')}>מעבר לרשימת העובדים</Button>
            <Button
              variant="ghost"
              className="ms-auto text-red-600 hover:bg-red-50"
              data-testid="bulk-undo"
              onClick={async () => {
                const ok = await ui.confirm({ title: 'ביטול הייבוא', danger: true, confirmLabel: 'ביטול הייבוא', message: 'לבטל את כל הייבוא? המשמרות שנקלטו והעובדים שנוצרו בייבוא זה יוסרו.' });
                if (!ok) return;
                try {
                  await repo.undoBulkImport(result);
                  ui.toast('הייבוא בוטל');
                  onDone({ ...result, employees: [] }, mainYm, null);
                } catch (e) {
                  ui.toast(e instanceof Error ? e.message : String(e), 'error');
                }
              }}
            >
              ביטול הייבוא
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[14px]" data-testid="bulk-done">
          <div>
            {result.businessCreated ? `העסק "${bizName}" הוקם. ` : ''}
            נוצרו <b>{result.employees.filter((e) => e.created).length}</b> עובדים חדשים, עודכנו <b>{result.employees.filter((e) => !e.created).length}</b> עובדים קיימים ונקלטו{' '}
            <b>{result.employees.reduce((a, e) => a + e.added.length, 0)}</b> משמרות.
          </div>
          <div className="max-h-64 overflow-auto rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <tbody>
                {result.employees.map((e) => (
                  <tr key={e.ref} className="border-b border-line/60">
                    <td className="px-3 py-1.5">{e.fullName}</td>
                    <td className="px-3 py-1.5 text-ink-soft">{e.created ? 'עובד חדש' : 'עובד קיים'}</td>
                    <td className="num px-3 py-1.5">{e.added.length} משמרות</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {skipped.length > 0 && <div className="text-[13px] text-ink-soft">לא נקלטו (דילוג / לבדיקה): {skipped.map((e) => e.name || e.source.sheetName).join(', ')}</div>}
          <p className="text-[12.5px] text-ink-soft">השעות חושבו לפי הגדרות Hours-Cal. סוגי ימים (חופשה, מחלה וכו׳) לא נקבעו — יש לסמן אותם ידנית בדוח השעות של כל עובד.</p>
        </div>
      </Modal>
    );
  }

  const fridayLabel = (s: EmployeeSettings) =>
    s.fridayOvertime === 'inherit' || s.fridayOvertime === undefined ? `לפי הגדרת העסק (${FRIDAY_OVERTIME_LABELS[businessFridayOn(businessFridayHistory(defaults), '9999-12-31')]})` : FRIDAY_OVERTIME_LABELS[s.fridayOvertime];

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-[1240px]"
      title={<span>ייבוא עובדים ודוחות נוכחות — {bizName}</span>}
      footer={
        <>
          <Button variant="primary" disabled={!canApprove} onClick={() => void approve()} data-testid="bulk-approve">
            {phase === 'saving' ? 'שומר…' : 'אישור וקליטת הנתונים'}
          </Button>
          <Button onClick={onClose} data-testid="bulk-cancel">
            ביטול
          </Button>
          <span className="ms-auto text-[12.5px] text-ink-soft" data-testid="bulk-footer">
            {problems.length ? problems[0] + (problems.length > 1 ? ` (+${problems.length - 1})` : '') : `ייווצרו ${creating} עובדים · יעודכנו ${updating} עובדים קיימים · ייקלטו ${summary?.shifts ?? 0} משמרות`}
          </span>
        </>
      }
    >
      <div className="space-y-3" data-testid="bulk-preview">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-soft">
          <span>
            קובץ: <span className="text-ink">{file.name}</span>
          </span>
          <span>הנתונים נקראו במחשב זה בלבד. דבר לא נשמר עד לאישור.</span>
        </div>
        {summary && (
          <div className="flex flex-wrap gap-2 text-[12.5px]" data-testid="bulk-counts">
            <Badge tone="slate">גיליונות שנבדקו {summary.sheets}</Badge>
            <Badge tone="blue">עובדים שזוהו {summary.employees}</Badge>
            <Badge tone="green">עובדים חדשים {summary.proposedNew}</Badge>
            <Badge tone="violet">התאמות לעובדים קיימים {summary.existingMatches}</Badge>
            <Badge tone="slate">ימי נוכחות {summary.days}</Badge>
            <Badge tone="slate">משמרות {summary.shifts}</Badge>
            <Badge tone={summary.unresolved ? 'red' : 'green'}>דורשים טיפול {summary.unresolved}</Badge>
          </div>
        )}
        {analysis && analysis.skipped.length > 0 && <Banner tone="info">גיליונות ללא טבלת נוכחות (לא ייקלטו): {analysis.skipped.map((s) => s.sheetName).join(', ')}</Banner>}
        {finalMonths.length > 0 && <Banner tone="warn">החודש {finalMonths.map((m) => monthTitle(+m.slice(0, 4), +m.slice(5))).join(', ')} סומן כסופי בעסק זה. קליטה תשנה את נתוני החודש.</Banner>}

        {/* Settings for new employees */}
        <div className="rounded-lg border border-line bg-slate-50/60 p-3 text-[13px]" data-testid="bulk-settings">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">הגדרות לעובדים חדשים:</span>
            <span>
              {scheduleLabel(settings)} · שישי: {fridayLabel(settings)} · הפסקות: {BREAK_METHOD_LABELS[settings.breakMethod]}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setShowSettings((v) => !v)} data-testid="bulk-settings-toggle">
              {showSettings ? 'הסתרת ההגדרות' : 'עיון ושינוי'}
            </Button>
          </div>
          <div className="mt-1 text-[12px] text-ink-soft">
            ברירת המחדל של העסק. מתכונת העבודה אינה נקבעת לפי מספר הימים שעבד העובד בחודש. הגדרות של עובדים קיימים אינן משתנות.
          </div>
          {showSettings && (
            <div className="mt-3 rounded-lg bg-white p-4 ring-1 ring-line">
              <SettingsEditor
                value={settings}
                onChange={setSettings}
                businessFriday={businessFridayOn(businessFridayHistory(defaults), '9999-12-31')}
                businessAbsence={{ ...defaults.absence, weeklyCredit: businessWeeklyCreditOn(businessWeeklyCreditHistory(defaults), '9999-12-31') }}
                businessTravel={defaults.travel}
              />
              {settingsErrors.length > 0 && <div className="mt-2 text-[12px] text-red-700">{settingsErrors.join(' · ')}</div>}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {hasMulti && (
            <Checkbox
              checked={gapIsBreak}
              onChange={setGapIsBreak}
              label="בימים עם כמה רישומי כניסה/יציאה — הזמן שבין הרישומים אינו עבודה ולא תקוזז הפסקה נוספת"
              hint="אם יבוטל, מדיניות ההפסקות של העובד תחול על כל רישום בנפרד, והיום יסומן לבדיקה."
            />
          )}
          {hasZero && (
            <div className="text-[13px]">
              <div className="mb-1">הפסקה 0:00 בדוח המקור:</div>
              <Segmented<'policy' | 'source'>
                value={zeroBreak}
                onChange={setZeroBreak}
                options={[
                  { value: 'policy', label: 'לפי מדיניות ההפסקות (טעון אישור)' },
                  { value: 'source', label: 'ללא הפסקה, כפי שבדוח' },
                ]}
              />
            </div>
          )}
        </div>

        {/* Employees */}
        <div className="max-h-[56vh] overflow-auto rounded-xl border border-line">
          <table className="w-full border-separate border-spacing-0 text-[13.5px]" data-testid="bulk-table">
            <thead className="sticky top-0 z-10 bg-slate-50 text-right text-[12px] text-ink-soft">
              <tr className="[&>th]:border-b [&>th]:border-line [&>th]:px-2 [&>th]:py-2 [&>th]:font-medium">
                <th className="w-8 text-center">קליטה</th>
                <th>שם עובד</th>
                <th className="w-[96px]">מספר עובד</th>
                <th>גיליון מקור</th>
                <th className="w-[90px]">חודש</th>
                <th className="w-[70px] text-center">ימי עבודה שזוהו</th>
                <th className="w-[70px] text-center">משמרות</th>
                <th className="w-[230px]">פעולה</th>
                <th>סטטוס</th>
                <th className="w-[70px]" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <EntryRows
                  key={e.key}
                  entry={e}
                  entries={entries}
                  existing={existing}
                  dupKeys={analysis?.possibleDuplicates.find((g) => g.includes(e.key))?.filter((k) => k !== e.key) ?? []}
                  open={open === e.key}
                  onToggle={() => setOpen(open === e.key ? null : e.key)}
                  onChange={(p) => update(e.key, p)}
                  onRow={(date, p) => updateRow(e.key, date, p)}
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className="flex items-start gap-1.5 text-[12px] text-ink-soft">
          <IconInfo size={14} className="mt-0.5 shrink-0" />
          עמודות שעות רגילות, נוספות ועלות מהמערכת המקורית משמשות לבדיקה בלבד — Hours-Cal מחשבת מחדש לפי הגדרותיה. עובדים לא ייווצרו ונתונים לא יישמרו עד ללחיצה על "אישור וקליטת הנתונים"; הקליטה מתבצעת כפעולה אחת שניתן לבטל.
        </p>
      </div>
    </Modal>
  );
}

function EntryRows({
  entry: e,
  entries,
  existing,
  dupKeys,
  open,
  onToggle,
  onChange,
  onRow,
}: {
  entry: BulkEntry;
  entries: BulkEntry[];
  existing: Employee[];
  dupKeys: string[];
  open: boolean;
  onToggle: () => void;
  onChange: (p: Partial<BulkEntry>) => void;
  onRow: (date: string, p: Partial<PreviewRow>) => void;
}) {
  const counts = countPreview(e.rows);
  const days = e.rows.filter(willWrite).length;
  const shifts = e.rows.filter(willWrite).reduce((a, r) => a + r.segments.filter((s) => s.start || s.end).length, 0);
  const needs = e.include && e.action === null;
  const status = !e.include || e.action?.kind === 'skip' ? { tone: 'slate' as const, text: 'דילוג' } : e.action?.kind === 'review' ? { tone: 'amber' as const, text: 'דורש בדיקה – לא ייקלט' } : needs ? { tone: 'red' as const, text: 'יש לבחור פעולה' } : e.issues.length || counts.invalid ? { tone: 'amber' as const, text: `דורש בדיקה${counts.invalid ? ` (${counts.invalid} ימים)` : ''}` } : { tone: 'green' as const, text: 'תקין' };
  const options: { value: string; label: string }[] = [
    ...(e.action === null ? [{ value: '', label: '— יש לבחור פעולה —' }] : []),
    { value: 'create', label: 'יצירת עובד חדש' },
    ...existing.map((x) => ({ value: `existing:${x.id}`, label: `שיוך לעובד קיים: ${x.fullName}${x.employeeNumber ? ` (#${x.employeeNumber})` : ''}${e.suggestion?.employeeId === x.id ? ' ★' : ''}` })),
    ...dupKeys.map((k) => {
      const o = entries.find((x) => x.key === k)!;
      return { value: `merge:${k}`, label: `מיזוג עם הגיליון "${o.source.sheetName}"` };
    }),
    { value: 'skip', label: 'דילוג' },
    { value: 'review', label: 'דורש בדיקה (לא ייקלט כעת)' },
  ];
  const ymText = e.source.year && e.source.month ? monthTitle(e.source.year, e.source.month) : '—';
  return (
    <>
      <tr className={`align-top ${!e.include ? 'opacity-60' : ''}`} data-testid="bulk-row">
        <td className="border-b border-line/70 px-2 py-2 text-center">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-brand" checked={e.include} onChange={(ev) => onChange({ include: ev.target.checked })} aria-label={`קליטת ${e.name}`} />
        </td>
        <td className="border-b border-line/70 px-2 py-1.5">
          <input className="field-input !py-1" value={e.name} onChange={(ev) => onChange({ name: ev.target.value })} aria-label={`שם עובד ${e.source.sheetName}`} disabled={e.action?.kind === 'existing'} />
        </td>
        <td className="border-b border-line/70 px-2 py-1.5">
          <input className="field-input num !py-1" value={e.employeeNumber} onChange={(ev) => onChange({ employeeNumber: ev.target.value })} aria-label={`מספר עובד ${e.source.sheetName}`} disabled={e.action?.kind !== 'create'} />
        </td>
        <td className="border-b border-line/70 px-2 py-2 text-[12.5px] text-ink-soft">{e.source.sheetName}</td>
        <td className="border-b border-line/70 px-2 py-2 text-[12.5px]">{ymText}</td>
        <td className="num border-b border-line/70 px-2 py-2 text-center">{days}</td>
        <td className="num border-b border-line/70 px-2 py-2 text-center">{shifts}</td>
        <td className="border-b border-line/70 px-2 py-1.5">
          <select className="field-input !py-1 text-[13px]" value={actionValue(e.action)} onChange={(ev) => onChange({ action: parseAction(ev.target.value), include: ev.target.value !== 'skip' })} aria-label={`פעולה ${e.source.sheetName}`} data-testid="bulk-action">
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </td>
        <td className="border-b border-line/70 px-2 py-2">
          <Badge tone={status.tone} title={e.issues.join('\n')}>
            {status.text}
          </Badge>
          {e.issues.length > 0 && <div className="mt-1 max-w-[260px] text-[11.5px] leading-snug text-amber-800">{e.issues[0]}</div>}
        </td>
        <td className="border-b border-line/70 px-2 py-2 text-center">
          <Button size="sm" variant="ghost" onClick={onToggle} data-testid="bulk-expand">
            {open ? 'סגירה' : 'פירוט'}
          </Button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={10} className="border-b border-line bg-slate-50/50 px-4 py-3">
            {e.issues.length > 1 && (
              <ul className="mb-2 list-disc space-y-0.5 ps-5 text-[12.5px] text-amber-800">
                {e.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
            <div className="mb-2 text-[12.5px] text-ink-soft">
              משך הרישומים בגיליון: {hm(e.source.detected.grossMinutes, '0:00')}
              {e.source.sourceTotalMinutes !== null && ` · סה״כ שעות שהודפס במקור: ${hm(e.source.sourceTotalMinutes, '0:00')} (לבדיקה בלבד)`}
              {e.source.clockId && ` · מזהה במקור: ${e.source.clockId}`}
            </div>
            <div className="max-h-[40vh] overflow-auto rounded-lg border border-line bg-white">
              <table className="w-full border-separate border-spacing-0 text-[13px]" data-testid={`bulk-detail-${e.key}`}>
                <thead className="sticky top-0 bg-slate-50 text-right text-[12px] text-ink-soft">
                  <tr className="[&>th]:border-b [&>th]:border-line [&>th]:px-2 [&>th]:py-1.5 [&>th]:font-medium">
                    <th className="w-8 text-center">קליטה</th>
                    <th className="w-[96px]">תאריך</th>
                    <th className="w-[96px] text-center">כניסה</th>
                    <th className="w-[96px] text-center">יציאה</th>
                    <th className="w-[84px] text-center">הפסקה</th>
                    <th className="w-[130px]">סטטוס</th>
                    <th>הערות</th>
                  </tr>
                </thead>
                <tbody>
                  {e.rows.map((r) => (
                    <PreviewLine key={r.date} row={r} onChange={(p) => onRow(r.date, p)} />
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
