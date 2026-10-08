import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  calculateEmployeePeriod,
  dedupeWarnings,
  eachDate,
  formatDurationHe,
  HEBREW_WEEKDAYS,
  monthRange,
  premiumMinutes,
  requiredDataRange,
  resolveSettings,
  type DayResult,
  type DayStatusKind,
  type EmployeePeriodResult,
  type LocalDate,
  type SettingsVersion,
  type ShiftInput,
  type ShiftResult,
  type Warning,
  type WeekResult,
} from '../../engine';
import { toDayStatuses, type Business, type DayEntry, type Employee, type ShiftRecord } from '../../data/repo';
import { Crumbs, useApp } from '../App';
import { Badge, Button, Checkbox, Drawer, Field, IconButton, PageHeader, Select, severityLabel, severityTone, useUi } from '../components';
import { IconAlert, IconCheck, IconDownload, IconInfo, IconPlus, IconPrinter, IconRedo, IconTrash, IconUndo } from '../icons';
import { MonthPicker } from '../MonthPicker';
import { formatDateHe, hm, monthTitle, shekels, STATUS_LABELS, STATUS_OPTIONS } from '../format';
import { buildTimestamps, normalizeTimeInput, parseBreakInput } from '../timeEntry';
import { exportEmployeeMonth } from '../../export/exporters';

type Op =
  | { kind: 'shift'; before: ShiftInput | null; after: ShiftInput | null }
  | { kind: 'day'; date: LocalDate; before: DayEntry | null; after: DayEntry | null };

const stripShift = (s: ShiftInput | ShiftRecord): ShiftInput => ({
  id: s.id,
  workDate: s.workDate,
  startAt: s.startAt,
  endAt: s.endAt,
  breakMinutes: s.breakMinutes,
  breakStart: s.breakStart,
  breakConfirmed: s.breakConfirmed,
  breakPaid: s.breakPaid,
  reviewed: s.reviewed,
  note: s.note,
});

export function AttendanceScreen({ businessId, employeeId }: { businessId: string; employeeId: string }) {
  const { repo, go, ym, setYm, dataVersion } = useApp();
  const ui = useUi();
  const [business, setBusiness] = useState<Business | null>(null);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [versions, setVersions] = useState<SettingsVersion[]>([]);
  const [shifts, setShifts] = useState<ShiftInput[]>([]);
  const [entries, setEntries] = useState<DayEntry[]>([]);
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [extraRows, setExtraRows] = useState<Record<string, number>>({});
  const [detailsDate, setDetailsDate] = useState<LocalDate | null>(null);
  const [undo, setUndo] = useState<Op[]>([]);
  const [redo, setRedo] = useState<Op[]>([]);
  const { from, to } = monthRange(ym.year, ym.month);
  const range = useMemo(() => requiredDataRange(from, to), [from, to]);

  const load = useCallback(async () => {
    const [b, e, vs, sh, en, hol] = await Promise.all([
      repo.getBusiness(businessId),
      repo.getEmployee(businessId, employeeId),
      repo.getSettingsVersions(employeeId),
      repo.getShifts(businessId, employeeId, range.from, range.to),
      repo.getDayEntries(businessId, employeeId, range.from, range.to),
      repo.listCustomHolidays(businessId),
    ]);
    setBusiness(b);
    setEmployee(e);
    setVersions(vs);
    setShifts(sh.map(stripShift));
    setEntries(en);
    setHolidays(hol);
    setLoaded(true);
  }, [repo, businessId, employeeId, range]);

  useEffect(() => {
    setLoaded(false);
    setUndo([]);
    setRedo([]);
    setExtraRows({});
    load().catch((e) => ui.toast(String(e), 'error'));
  }, [load, dataVersion, ui]);

  const result: EmployeePeriodResult | null = useMemo(() => {
    if (!loaded || !versions.length) return null;
    return calculateEmployeePeriod({
      employeeId,
      settingsVersions: versions,
      shifts,
      dayStatuses: toDayStatuses(entries),
      customHolidays: holidays,
      from,
      to,
    });
  }, [loaded, versions, shifts, entries, holidays, employeeId, from, to]);

  // ------------------------------------------------------------- persistence
  const applyShift = useCallback(
    async (before: ShiftInput | null, after: ShiftInput | null) => {
      if (after) {
        await repo.upsertShift(businessId, employeeId, after);
        setShifts((list) => [...list.filter((s) => s.id !== after.id), after]);
      } else if (before) {
        await repo.deleteShift(businessId, employeeId, before.id);
        setShifts((list) => list.filter((s) => s.id !== before.id));
      }
    },
    [repo, businessId, employeeId],
  );

  const applyDay = useCallback(
    async (date: LocalDate, entry: DayEntry | null) => {
      const e = entry ?? { date, status: null, note: null };
      await repo.setDayEntry(businessId, employeeId, e);
      setEntries((list) => {
        const rest = list.filter((x) => x.date !== date);
        return !e.status && !e.note ? rest : [...rest, e];
      });
    },
    [repo, businessId, employeeId],
  );

  const record = (op: Op) => {
    setUndo((u) => [...u.slice(-199), op]);
    setRedo([]);
  };

  const saveShift = useCallback(
    async (before: ShiftInput | null, after: ShiftInput | null): Promise<boolean> => {
      try {
        await applyShift(before, after);
        record({ kind: 'shift', before, after });
        return true;
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e), 'error');
        return false;
      }
    },
    [applyShift, ui],
  );

  const saveDay = useCallback(
    async (date: LocalDate, after: DayEntry | null) => {
      const before = entries.find((e) => e.date === date) ?? null;
      try {
        await applyDay(date, after);
        record({ kind: 'day', date, before, after });
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
    [applyDay, entries, ui],
  );

  const doUndo = useCallback(async () => {
    const op = undo[undo.length - 1];
    if (!op) return;
    try {
      if (op.kind === 'shift') await applyShift(op.after, op.before);
      else await applyDay(op.date, op.before);
      setUndo((u) => u.slice(0, -1));
      setRedo((r) => [...r, op]);
      ui.toast('הפעולה בוטלה', 'info');
    } catch (e) {
      ui.toast(String(e), 'error');
    }
  }, [undo, applyShift, applyDay, ui]);

  const doRedo = useCallback(async () => {
    const op = redo[redo.length - 1];
    if (!op) return;
    try {
      if (op.kind === 'shift') await applyShift(op.before, op.after);
      else await applyDay(op.date, op.after);
      setRedo((r) => r.slice(0, -1));
      setUndo((u) => [...u, op]);
    } catch (e) {
      ui.toast(String(e), 'error');
    }
  }, [redo, applyShift, applyDay, ui]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        doRedo();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [doUndo, doRedo]);

  // ------------------------------------------------------------- bulk confirm
  const unconfirmed = useMemo(() => result?.days.flatMap((d) => d.shifts.filter((s) => s.valid && s.break.unconfirmed)) ?? [], [result]);

  const confirmAllBreaks = async () => {
    if (!unconfirmed.length) return;
    const ok = await ui.confirm({
      title: 'אישור הפסקות משוערות',
      message: `לאשר ${unconfirmed.length} הפסקות שחושבו לפי מדיניות? יש לאשר רק אם ידוע שההפסקות ניתנו בפועל.`,
      confirmLabel: 'אישור כל ההפסקות',
    });
    if (!ok) return;
    for (const r of unconfirmed) {
      const before = shifts.find((s) => s.id === r.shiftId);
      if (before) await saveShift(before, { ...before, breakConfirmed: true });
    }
    ui.toast('ההפסקות אושרו');
  };

  if (!business || !employee || !result) return null;

  const title = `דוח שעות - ${employee.fullName} - ${monthTitle(ym.year, ym.month)}`;
  const t = result.totals;
  const prem = premiumMinutes(t.buckets);
  const allWarnings = dedupeWarnings([...result.warnings, ...result.days.flatMap((d) => d.warnings)]);
  const firstIssueDate = (pred: (w: Warning) => boolean) => allWarnings.find(pred)?.date ?? null;
  const weeksByEnd = new Map(result.weeks.map((w) => [w.weekEnd, w]));
  const hasPay = t.payAgorot !== null;

  return (
    <div className="pb-28">
      <PageHeader
        breadcrumbs={
          <Crumbs
            items={[
              { label: 'עסקים', onClick: () => go({ name: 'businesses' }) },
              { label: business.name, onClick: () => go({ name: 'employees', businessId }) },
              { label: 'דוח שעות' },
            ]}
          />
        }
        title={title}
        subtitle={employee.employeeNumber ? <span>מספר עובד: <span className="num">{employee.employeeNumber}</span></span> : undefined}
        actions={
          <>
            <MonthPicker value={ym} onChange={setYm} />
            <IconButton label="ביטול פעולה (Ctrl+Z)" onClick={doUndo} disabled={!undo.length}>
              <IconUndo />
            </IconButton>
            <IconButton label="ביצוע חוזר (Ctrl+Y)" onClick={doRedo} disabled={!redo.length}>
              <IconRedo />
            </IconButton>
            {unconfirmed.length > 0 && (
              <Button onClick={confirmAllBreaks} icon={<IconCheck size={16} />}>
                אישור {unconfirmed.length} הפסקות משוערות
              </Button>
            )}
            <Button icon={<IconDownload size={16} />} onClick={() => exportEmployeeMonth('xlsx', business, employee, result, ym).then((m) => m && ui.toast(m)).catch((e) => ui.toast(String(e), 'error'))}>
              Excel
            </Button>
            <Button icon={<IconDownload size={16} />} onClick={() => exportEmployeeMonth('csv', business, employee, result, ym).then((m) => m && ui.toast(m)).catch((e) => ui.toast(String(e), 'error'))}>
              CSV
            </Button>
            <Button icon={<IconPrinter size={16} />} onClick={() => window.print()}>
              הדפסה
            </Button>
            <Button variant="ghost" onClick={() => go({ name: 'employees', businessId })}>
              חזרה לעובדים
            </Button>
          </>
        }
      />
      <div className="print-only mb-3">
        <div className="text-[18px] font-bold">{title}</div>
        <div className="text-[12px]">{business.name}</div>
      </div>

      <div className="print-full overflow-auto rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(15,27,45,0.04)]" style={{ maxHeight: 'calc(100vh - 260px)' }}>
        <table className="w-full border-separate border-spacing-0 text-[14px]" data-testid="attendance-table">
          <thead className="sticky top-0 z-10">
            <tr className="bg-slate-50 text-right text-[12px] font-medium text-ink-soft [&>th]:border-b [&>th]:border-line [&>th]:px-2 [&>th]:py-2.5 [&>th]:font-medium">
              <th className="w-[92px] ps-4">תאריך</th>
              <th className="w-[84px]">יום</th>
              <th className="w-[90px] text-center">כניסה</th>
              <th className="w-[90px] text-center">יציאה</th>
              <th className="text-center">שעות ברוטו</th>
              <th className="w-[96px] text-center">הפסקה</th>
              <th className="text-center">שעות נטו</th>
              <th className="text-center">שעות רגילות</th>
              <th className="text-center">נוספות 125%</th>
              <th className="text-center">נוספות 150%</th>
              <th className="text-center" title="עבודה במנוחה שבועית / חג (150% / 175% / 200%)">
                מנוחה / חג
              </th>
              <th className="min-w-[200px]">הערות</th>
              <th className="no-print w-[70px]" />
            </tr>
          </thead>
          <tbody>
            {result.days.map((day) => {
              const dayShifts = shifts.filter((s) => s.workDate === day.date).sort((a, b) => (a.startAt ?? a.endAt ?? '').localeCompare(b.startAt ?? b.endAt ?? ''));
              const rowsCount = Math.max(1, dayShifts.length + (extraRows[day.date] ?? 0));
              const entry = entries.find((e) => e.date === day.date) ?? null;
              const week = weeksByEnd.get(day.date);
              const rows = [];
              for (let i = 0; i < rowsCount; i++) {
                const sh = dayShifts[i] ?? null;
                rows.push(
                  <ShiftRow
                    key={`${day.date}-${i}`}
                    day={day}
                    index={i}
                    rowSpan={rowsCount}
                    shift={sh}
                    shiftResult={sh ? (day.shifts.find((r) => r.shiftId === sh.id) ?? null) : null}
                    entry={entry}
                    onSave={async (after) => {
                      const ok = await saveShift(sh, after);
                      if (ok && !sh && after && i >= dayShifts.length) setExtraRows((x) => ({ ...x, [day.date]: Math.max(0, (x[day.date] ?? 0) - 1) }));
                      return ok;
                    }}
                    onAddShift={() => setExtraRows((x) => ({ ...x, [day.date]: (x[day.date] ?? 0) + 1 }))}
                    onDetails={() => setDetailsDate(day.date)}
                  />,
                );
              }
              if (week && day.date >= from) rows.push(<WeekRow key={`w-${day.date}`} week={week} />);
              return rows;
            })}
          </tbody>
        </table>
      </div>

      <TotalsBar
        items={[
          { label: 'ימי עבודה בפועל', value: String(t.daysWorked), testid: 'total-days' },
          { label: 'שעות ברוטו', value: hm(t.grossMinutes, '0:00') },
          { label: 'סך הפסקות', value: hm(t.breakMinutes, '0:00') },
          { label: 'שעות רגילות', value: hm(t.buckets.regular, '0:00'), testid: 'total-regular' },
          { label: 'שעות נוספות 125%', value: hm(t.buckets.ot125, '0:00'), testid: 'total-125' },
          { label: 'שעות נוספות 150%', value: hm(t.buckets.ot150, '0:00'), testid: 'total-150' },
          ...(prem.total > 0
            ? [{ label: 'מנוחה/חג 150·175·200', value: `${hm(prem.p150, '0')} · ${hm(prem.p175, '0')} · ${hm(prem.p200, '0')}` }]
            : []),
          ...(t.buckets.unclassified > 0 ? [{ label: 'לא מסווג', value: hm(t.buckets.unclassified) }] : []),
          { label: 'שעות עבודה נטו בסה״כ', value: hm(t.netMinutes, '0:00'), strong: true, testid: 'total-net' },
          ...(hasPay ? [{ label: 'הערכת עלות (לא תלוש)', value: shekels(t.payAgorot) }] : []),
        ]}
        flags={[
          { label: 'הפסקות לא מאושרות', count: t.unconfirmedBreaks, tone: 'amber' as const, onClick: () => setDetailsDate(firstIssueDate((w) => w.code === 'BREAK_UNCONFIRMED')) },
          { label: 'רישומים חסרים', count: t.incompleteEntries, tone: 'red' as const, onClick: () => setDetailsDate(firstIssueDate((w) => w.code === 'INCOMPLETE' || w.code === 'MISSING_RECORD')) },
          { label: 'שגיאות', count: t.errorCount - t.incompleteEntries, tone: 'red' as const, onClick: () => setDetailsDate(firstIssueDate((w) => w.severity === 'error')) },
          { label: 'לבדיקה', count: t.reviewCount - t.unconfirmedBreaks, tone: 'amber' as const, onClick: () => setDetailsDate(firstIssueDate((w) => w.severity === 'review' && w.code !== 'BREAK_UNCONFIRMED')) },
          { label: 'אזהרות ציות', count: t.complianceCount, tone: 'violet' as const, onClick: () => setDetailsDate(firstIssueDate((w) => w.severity === 'compliance')) },
        ]}
      />

      {result.warnings.length > 0 && (
        <div className="no-print mt-4 space-y-1.5">
          {result.warnings.map((w) => (
            <div key={w.code} className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900 ring-1 ring-amber-200">
              <IconAlert size={16} /> {w.message}
            </div>
          ))}
        </div>
      )}

      {detailsDate && (
        <DayDrawer
          date={detailsDate}
          day={result.days.find((d) => d.date === detailsDate)!}
          shifts={shifts.filter((s) => s.workDate === detailsDate)}
          entry={entries.find((e) => e.date === detailsDate) ?? null}
          version={resolveSettings(versions, detailsDate)}
          onClose={() => setDetailsDate(null)}
          onSaveShift={saveShift}
          onSaveDay={saveDay}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One table row = one shift (or an empty entry row)
// ---------------------------------------------------------------------------

function focusNav(current: HTMLElement, dir: 'next' | 'down' | 'up') {
  const all = Array.from(document.querySelectorAll<HTMLInputElement>('[data-nav]'));
  const idx = all.indexOf(current as HTMLInputElement);
  if (idx < 0) return;
  let target: HTMLInputElement | undefined;
  if (dir === 'next') target = all[idx + 1];
  else {
    const col = current.dataset.nav;
    const step = dir === 'down' ? 1 : -1;
    for (let i = idx + step; i >= 0 && i < all.length; i += step) {
      if (all[i].dataset.nav === col) {
        target = all[i];
        break;
      }
    }
  }
  target?.focus();
  target?.select();
}

function navKeys(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === 'Enter') {
    e.preventDefault();
    (e.currentTarget as HTMLInputElement).blur();
    focusNav(e.currentTarget, 'next');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusNav(e.currentTarget, 'down');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusNav(e.currentTarget, 'up');
  }
}

const SHORT_ERROR: Record<string, string> = {
  INCOMPLETE: 'רישום חסר',
  MISSING_RECORD: 'רישום חסר',
  DUPLICATE_SHIFT: 'משמרת כפולה',
  OVERLAPPING_SHIFT: 'משמרות חופפות',
  BREAK_EXCEEDS_SHIFT: 'הפסקה ארוכה מהמשמרת',
  BREAK_OUTSIDE_SHIFT: 'הפסקה מחוץ למשמרת',
  NONEXISTENT_TIME: 'שעה לא קיימת',
  NO_SETTINGS: 'אין הגדרות',
};

function ShiftRow({
  day,
  index,
  rowSpan,
  shift,
  shiftResult,
  entry,
  onSave,
  onAddShift,
  onDetails,
}: {
  day: DayResult;
  index: number;
  rowSpan: number;
  shift: ShiftInput | null;
  shiftResult: ShiftResult | null;
  entry: DayEntry | null;
  onSave: (after: ShiftInput | null) => Promise<boolean>;
  onAddShift: () => void;
  onDetails: () => void;
}) {
  const startVal = shift?.startAt?.slice(11) ?? '';
  const endVal = shift?.endAt?.slice(11) ?? '';
  const overnight = !!shift?.endAt && !!shift.startAt && shift.endAt.slice(0, 10) !== shift.startAt.slice(0, 10);
  const breakVal = shift?.breakMinutes === null || shift?.breakMinutes === undefined ? '' : String(shift.breakMinutes);
  const [start, setStart] = useState(startVal);
  const [end, setEnd] = useState(endVal);
  const [brk, setBrk] = useState(breakVal);
  const [bad, setBad] = useState<{ start?: boolean; end?: boolean; brk?: boolean }>({});
  const focused = useRef<string | null>(null);

  useEffect(() => {
    if (focused.current !== 'start') setStart(startVal);
    if (focused.current !== 'end') setEnd(endVal);
    if (focused.current !== 'brk') setBrk(breakVal);
  }, [startVal, endVal, breakVal]);

  const commitTimes = async (s: string, e: string) => {
    const ns = normalizeTimeInput(s);
    const ne = normalizeTimeInput(e);
    if (ns === null || ne === null) {
      setBad({ start: ns === null, end: ne === null });
      return;
    }
    setStart(ns);
    setEnd(ne);
    if (ns === startVal && ne === endVal) return setBad({});
    if (!ns && !ne) {
      setBad({});
      if (shift) await onSave(null);
      return;
    }
    const ts = buildTimestamps(day.date, ns, ne);
    if (ts.error) {
      setBad({ end: true });
      return;
    }
    const base: ShiftInput = shift ?? {
      id: crypto.randomUUID(),
      workDate: day.date,
      startAt: null,
      endAt: null,
      breakMinutes: null,
      breakStart: null,
      breakConfirmed: false,
      breakPaid: false,
      reviewed: false,
    };
    const ok = await onSave({ ...base, startAt: ts.startAt, endAt: ts.endAt, breakStart: base.breakStart && ts.startAt ? base.breakStart : null });
    setBad(ok ? {} : { end: true });
  };

  const commitBreak = async (raw: string) => {
    if (!shift) {
      setBrk('');
      return;
    }
    const v = parseBreakInput(raw);
    if (v === 'invalid') return setBad({ brk: true });
    setBad({});
    if (v === shift.breakMinutes) return;
    await onSave({ ...shift, breakMinutes: v, breakConfirmed: v !== null ? true : shift.breakConfirmed });
  };

  const first = index === 0;
  const tone = day.holidayName ? 'bg-amber-50/50' : day.isRestDay ? 'bg-sky-50/60' : !day.scheduled ? 'bg-slate-50/80' : '';
  const weekStart = day.weekday === 0 && first;
  const br = shiftResult?.break;
  const estimated = br && (br.kind === 'company_estimate' || br.kind === 'legal_estimate');
  const warnings = dedupeWarnings(day.warnings);
  const errorCount = warnings.filter((w) => w.severity === 'error').length;
  const reviewCount = warnings.filter((w) => w.severity === 'review').length;
  const complianceCount = warnings.filter((w) => w.severity === 'compliance').length;
  const p = premiumMinutes(day.buckets);
  const cellBorder = `border-b border-line/70 ${weekStart ? 'border-t-2 border-t-slate-200' : ''}`;
  const dayCell = (content: React.ReactNode, cls = '') =>
    first ? (
      <td rowSpan={rowSpan} className={`${cellBorder} px-2 py-1.5 align-middle ${cls}`}>
        {content}
      </td>
    ) : null;

  const labels: React.ReactNode[] = [];
  if (day.holidayName) labels.push(<Badge key="h" tone="amber">{day.holidayName}</Badge>);
  else if (day.isRestDay) labels.push(<span key="r" className="text-[11px] text-sky-700">מנוחה שבועית</span>);
  else if (!day.scheduled) labels.push(<span key="n" className="text-[11px] text-slate-500">לא יום עבודה</span>);
  if (day.holidayEve) labels.push(<span key="e" className="text-[11px] text-amber-700">ערב חג</span>);
  if (day.shortDay) labels.push(<span key="s" className="text-[11px] text-brand">יום מקוצר</span>);

  return (
    <tr className={`${tone} group`} data-date={day.date} data-testid={first ? `day-${day.date}` : undefined}>
      {dayCell(<span className="num font-medium">{formatDateHe(day.date).slice(0, 5)}</span>, 'ps-4 text-right')}
      {dayCell(
        <div className="leading-tight">
          <div className={day.isRestDay || !day.scheduled ? 'text-ink-soft' : ''}>{HEBREW_WEEKDAYS[day.weekday]}</div>
          {labels.length > 0 && <div className="mt-0.5 flex flex-wrap gap-1">{labels}</div>}
        </div>,
      )}
      <td className={`${cellBorder} px-1 py-1 text-center`}>
        <input
          className={`cell-input ${bad.start ? 'invalid' : ''}`}
          value={start}
          placeholder=""
          data-nav="start"
          aria-label={`כניסה ${day.date}`}
          onFocus={(e) => ((focused.current = 'start'), e.currentTarget.select())}
          onChange={(e) => setStart(e.target.value)}
          onBlur={() => ((focused.current = null), commitTimes(start, end))}
          onKeyDown={navKeys}
        />
      </td>
      <td className={`${cellBorder} px-1 py-1 text-center`}>
        <div className="relative inline-block">
          <input
            className={`cell-input ${bad.end ? 'invalid' : ''}`}
            value={end}
            data-nav="end"
            aria-label={`יציאה ${day.date}`}
            onFocus={(e) => ((focused.current = 'end'), e.currentTarget.select())}
            onChange={(e) => setEnd(e.target.value)}
            onBlur={() => ((focused.current = null), commitTimes(start, end))}
            onKeyDown={navKeys}
          />
          {overnight && (
            <span className="absolute -top-1 left-0 rounded bg-indigo-100 px-1 text-[10px] font-semibold text-indigo-700" title="היציאה ביום שלמחרת">
              +1
            </span>
          )}
        </div>
      </td>
      <td className={`${cellBorder} num px-2 text-center text-ink-soft`}>{shiftResult?.valid ? hm(shiftResult.grossMinutes) : ''}</td>
      <td className={`${cellBorder} px-1 py-1 text-center`}>
        <div className="flex items-center justify-center gap-0.5">
          <input
            className={`cell-input !w-[3.4rem] ${bad.brk ? 'invalid' : ''} ${estimated && br?.unconfirmed ? 'placeholder:text-amber-600' : 'placeholder:text-slate-400'}`}
            value={brk}
            placeholder={shiftResult?.valid ? (br?.paidMinutes ? `${br.paidMinutes}*` : String(br?.deductedMinutes ?? '')) : ''}
            title={br ? `${br.rule}${br.unconfirmed ? ' — טרם אושר' : ''}` : 'הקלידו דקות הפסקה (ריק = לפי מדיניות)'}
            data-nav="brk"
            aria-label={`הפסקה ${day.date}`}
            disabled={!shift}
            onFocus={(e) => ((focused.current = 'brk'), e.currentTarget.select())}
            onChange={(e) => setBrk(e.target.value)}
            onBlur={() => ((focused.current = null), commitBreak(brk))}
            onKeyDown={navKeys}
          />
          {shift && estimated && br?.unconfirmed && (
            <button
              className="no-print rounded p-0.5 text-amber-600 hover:bg-amber-100"
              title="אישור שההפסקה ניתנה בפועל"
              onClick={() => onSave({ ...shift, breakConfirmed: true })}
              data-testid="confirm-break"
            >
              <IconCheck size={15} />
            </button>
          )}
        </div>
      </td>
      {dayCell(<span className="num font-medium">{hm(day.netMinutes, '')}</span>, 'text-center')}
      {dayCell(<span className="num">{hm(day.buckets.regular, '')}</span>, 'text-center')}
      {dayCell(<span className="num text-blue-700">{hm(day.buckets.ot125, '')}</span>, 'text-center')}
      {dayCell(<span className="num text-indigo-700">{hm(day.buckets.ot150, '')}</span>, 'text-center')}
      {dayCell(
        p.total > 0 ? (
          <span className="num text-[12px] text-sky-800" title={`150%: ${hm(p.p150, '0')} · 175%: ${hm(p.p175, '0')} · 200%: ${hm(p.p200, '0')}`}>
            {hm(p.total)}
          </span>
        ) : day.buckets.unclassified ? (
          <span className="num text-[12px] text-slate-500" title="לא מסווג">
            {hm(day.buckets.unclassified)}
          </span>
        ) : null,
        'text-center',
      )}
      {dayCell(
        <button className="flex w-full flex-wrap items-center gap-1 text-right" onClick={onDetails}>
          {entry?.status && <Badge tone={entry.status === 'missing_record' ? 'red' : 'slate'}>{STATUS_LABELS[entry.status]}</Badge>}
          {errorCount > 0 && (
            <Badge tone="red" title={warnings.filter((w) => w.severity === 'error').map((w) => w.message).join('\n')}>
              <IconAlert size={12} /> {errorCount > 1 ? `${errorCount} שגיאות` : (SHORT_ERROR[warnings.find((w) => w.severity === 'error')!.code] ?? 'שגיאה')}
            </Badge>
          )}
          {reviewCount > 0 && (
            <Badge tone="amber" title={warnings.filter((w) => w.severity === 'review').map((w) => w.message).join('\n')}>
              {reviewCount} לבדיקה
            </Badge>
          )}
          {complianceCount > 0 && (
            <Badge tone="violet" title={warnings.filter((w) => w.severity === 'compliance').map((w) => w.message).join('\n')}>
              {complianceCount} ציות
            </Badge>
          )}
          {entry?.note && <span className="max-w-[220px] truncate text-[12px] text-ink-soft">{entry.note}</span>}
        </button>,
      )}
      {first ? (
        <td rowSpan={rowSpan} className={`${cellBorder} no-print px-1 text-center`}>
          <div className="flex items-center justify-center opacity-60 transition group-hover:opacity-100">
            <IconButton label="פרטי חישוב והגדרות יום" onClick={onDetails} data-testid={`details-${day.date}`}>
              <IconInfo size={17} />
            </IconButton>
            <IconButton label="הוספת משמרת נוספת ביום זה" onClick={onAddShift}>
              <IconPlus size={16} />
            </IconButton>
          </div>
        </td>
      ) : null}
    </tr>
  );
}

function WeekRow({ week }: { week: WeekResult }) {
  if (week.netMinutes === 0) return null;
  return (
    <tr className="bg-slate-50/60 text-[12px] text-ink-soft">
      <td colSpan={13} className="border-b border-line px-4 py-1.5">
        סיכום שבוע {formatDateHe(week.weekStart).slice(0, 5)}–{formatDateHe(week.weekEnd).slice(0, 5)}: נטו <span className="num font-medium text-ink">{hm(week.netMinutes, '0:00')}</span>
        {week.weeklyThresholdMinutes !== null && (
          <>
            {' '}
            · שעות רגילות במכסה השבועית{' '}
            <span className="num font-medium text-ink">
              {hm(week.regularCountedMinutes, '0:00')}/{hm(week.weeklyThresholdMinutes)}
            </span>
          </>
        )}
        {week.dailyOvertimeMinutes > 0 && (
          <>
            {' '}
            · נוספות יומיות <span className="num font-medium text-ink">{hm(week.dailyOvertimeMinutes)}</span>
          </>
        )}
        {week.weeklyOvertimeMinutes > 0 && (
          <>
            {' '}
            · נוספות שבועיות <span className="num font-medium text-ink">{hm(week.weeklyOvertimeMinutes)}</span>
          </>
        )}
      </td>
    </tr>
  );
}

function TotalsBar({
  items,
  flags,
}: {
  items: { label: string; value: string; strong?: boolean; testid?: string }[];
  flags: { label: string; count: number; tone: 'amber' | 'red' | 'violet'; onClick: () => void }[];
}) {
  const visible = flags.filter((f) => f.count > 0);
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 shadow-[0_-4px_16px_rgba(15,27,45,0.06)] backdrop-blur print:static print:mt-4 print:shadow-none">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        {items.map((it) => (
          <div key={it.label} className="min-w-0">
            <div className="text-[11px] text-ink-soft">{it.label}</div>
            <div className={`num text-right ${it.strong ? 'text-[18px] font-bold text-brand' : 'text-[15px] font-semibold text-ink'}`} data-testid={it.testid}>
              {it.value}
            </div>
          </div>
        ))}
        <div className="no-print ms-auto flex flex-wrap gap-1.5">
          {visible.length === 0 ? (
            <Badge tone="green">
              <IconCheck size={12} /> אין פריטים פתוחים
            </Badge>
          ) : (
            visible.map((f) => (
              <button key={f.label} onClick={f.onClick}>
                <Badge tone={f.tone}>
                  {f.count} {f.label}
                </Badge>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day details drawer: explanation, warnings, status, note, per-shift break details
// ---------------------------------------------------------------------------

function DayDrawer({
  date,
  day,
  shifts,
  entry,
  version,
  onClose,
  onSaveShift,
  onSaveDay,
}: {
  date: LocalDate;
  day: DayResult;
  shifts: ShiftInput[];
  entry: DayEntry | null;
  version: SettingsVersion | null;
  onClose: () => void;
  onSaveShift: (before: ShiftInput | null, after: ShiftInput | null) => Promise<boolean>;
  onSaveDay: (date: LocalDate, after: DayEntry | null) => Promise<void>;
}) {
  const ui = useUi();
  const [note, setNote] = useState(entry?.note ?? '');
  useEffect(() => setNote(entry?.note ?? ''), [entry?.note, date]);
  const warnings = dedupeWarnings(day.warnings);
  const b = day.buckets;
  const sorted = [...shifts].sort((a, c) => (a.startAt ?? '').localeCompare(c.startAt ?? ''));

  return (
    <Drawer
      open
      onClose={onClose}
      title={
        <span>
          {HEBREW_WEEKDAYS[day.weekday]} {formatDateHe(date)}
          {day.holidayName && <span className="ms-2 text-[13px] font-normal text-amber-700">{day.holidayName}</span>}
        </span>
      }
    >
      <div className="space-y-5 text-[14px]">
        <div className="grid grid-cols-2 gap-3">
          <Field label="סטטוס יום">
            <Select<DayStatusKind | ''>
              value={entry?.status ?? ''}
              onChange={(v) => onSaveDay(date, { date, status: v || null, note: entry?.note ?? null })}
              options={STATUS_OPTIONS}
            />
          </Field>
          <Field label="הערה ליום">
            <input
              className="field-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => note !== (entry?.note ?? '') && onSaveDay(date, { date, status: entry?.status ?? null, note: note || null })}
            />
          </Field>
        </div>
        <p className="-mt-2 text-[12px] text-ink-soft">סטטוס היעדרות אינו יוצר שעות עבודה ואינו מחשב זכויות (חופשה, מחלה וכו').</p>

        {warnings.length > 0 && (
          <div>
            <h3 className="mb-2 text-[13px] font-semibold">התראות</h3>
            <ul className="space-y-1.5">
              {warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[13px]">
                  <Badge tone={severityTone[w.severity]}>{severityLabel[w.severity]}</Badge>
                  <span className="leading-snug">{w.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {day.explanation.length > 0 && (
          <div>
            <h3 className="mb-2 text-[13px] font-semibold">הסבר החישוב</h3>
            <div className="space-y-1.5 rounded-xl border border-blue-100 bg-blue-50/40 p-3 text-[13px] leading-relaxed text-ink" data-testid="explanation">
              {day.explanation.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
          </div>
        )}

        {day.worked && (
          <div>
            <h3 className="mb-2 text-[13px] font-semibold">פירוק דקות (כל דקה נספרת פעם אחת)</h3>
            <table className="w-full text-[13px]">
              <tbody className="[&>tr>td]:border-b [&>tr>td]:border-line/60 [&>tr>td]:py-1">
                {(
                  [
                    ['רגילות 100%', b.regular],
                    ['נוספות 125%', b.ot125],
                    ['נוספות 150%', b.ot150],
                    ['מנוחה שבועית 150%', b.rest150],
                    ['מנוחה שבועית 175%', b.rest175],
                    ['מנוחה שבועית 200%', b.rest200],
                    ['חג 150%', b.holiday150],
                    ['חג 175%', b.holiday175],
                    ['חג 200%', b.holiday200],
                    ['לא מסווג', b.unclassified],
                  ] as [string, number][]
                )
                  .filter(([, v]) => v > 0)
                  .map(([l, v]) => (
                    <tr key={l}>
                      <td>{l}</td>
                      <td className="num text-left font-medium">{hm(v)}</td>
                    </tr>
                  ))}
                <tr>
                  <td className="font-semibold">סה״כ נטו</td>
                  <td className="num text-left font-semibold">{hm(day.netMinutes)}</td>
                </tr>
              </tbody>
            </table>
            {day.dailyThresholdMinutes !== null && (
              <p className="mt-2 text-[12px] text-ink-soft">
                תקן יומי: {formatDurationHe(day.dailyThresholdMinutes)} · נוספות יומיות: {hm(day.dailyOvertimeMinutes, '0:00')} · נוספות שבועיות: {hm(day.weeklyOvertimeMinutes, '0:00')}
                {day.contractExcessMinutes > 0 && ` · שעות עודפות 100%: ${hm(day.contractExcessMinutes)}`}
              </p>
            )}
          </div>
        )}

        {sorted.map((s, i) => {
          const r = day.shifts.find((x) => x.shiftId === s.id);
          return (
            <div key={s.id} className="rounded-xl border border-line p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="font-semibold">
                  משמרת {sorted.length > 1 ? i + 1 : ''}{' '}
                  <span className="num font-normal text-ink-soft">
                    {s.startAt?.slice(11) ?? '--:--'}–{s.endAt?.slice(11) ?? '--:--'}
                    {s.endAt && s.startAt && s.endAt.slice(0, 10) !== s.startAt.slice(0, 10) ? ' (+1)' : ''}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-600 hover:bg-red-50"
                  icon={<IconTrash size={15} />}
                  onClick={async () => {
                    if (await ui.confirm({ title: 'מחיקת משמרת', message: 'למחוק את המשמרת? ניתן לבטל באמצעות Ctrl+Z.', danger: true, confirmLabel: 'מחיקה' })) onSaveShift(s, null);
                  }}
                >
                  מחיקה
                </Button>
              </div>
              {r && (
                <dl className="mb-3 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-2.5 text-[12px]">
                  <div>
                    <dt className="text-ink-soft">ברוטו</dt>
                    <dd className="num text-right font-medium">{hm(r.grossMinutes, '0:00')}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-soft">הפסקה מנוכה</dt>
                    <dd className="num text-right font-medium">{r.break.deductedMinutes} ד׳</dd>
                  </div>
                  <div>
                    <dt className="text-ink-soft">נטו</dt>
                    <dd className="num text-right font-medium">{hm(r.netMinutes, '0:00')}</dd>
                  </div>
                  <div className="col-span-3 text-ink-soft">{r.break.rule}</div>
                  {r.isNightShift && <div className="col-span-3 text-indigo-700">משמרת לילה ({formatDurationHe(r.nightMinutes)} בין 22:00 ל-06:00)</div>}
                </dl>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="דקות הפסקה (ריק = לפי מדיניות)">
                  <input
                    className="field-input num text-left"
                    defaultValue={s.breakMinutes ?? ''}
                    onBlur={(e) => {
                      const v = parseBreakInput(e.target.value);
                      if (v === 'invalid') return ui.toast('משך הפסקה לא תקין', 'error');
                      if (v !== s.breakMinutes) onSaveShift(s, { ...s, breakMinutes: v, breakConfirmed: v !== null ? true : s.breakConfirmed });
                    }}
                  />
                </Field>
                <Field label="שעת תחילת ההפסקה (אופציונלי)" hint="משפר דיוק בגבולות שבת/חג/לילה">
                  <input
                    className="field-input num text-left"
                    placeholder="ש:דד"
                    defaultValue={s.breakStart?.slice(11) ?? ''}
                    onBlur={(e) => {
                      const v = normalizeTimeInput(e.target.value);
                      if (v === null) return ui.toast('שעה לא תקינה', 'error');
                      let breakStart: string | null = null;
                      if (v && s.startAt) {
                        const sameDay = `${s.workDate}T${v}`;
                        breakStart = sameDay >= s.startAt ? sameDay : `${s.endAt?.slice(0, 10) ?? s.workDate}T${v}`;
                      }
                      if (breakStart !== s.breakStart) onSaveShift(s, { ...s, breakStart });
                    }}
                  />
                </Field>
              </div>
              <div className="mt-2">
                <Checkbox
                  checked={s.breakPaid}
                  onChange={(v) => onSaveShift(s, { ...s, breakPaid: v })}
                  label="הפסקה בתשלום / העובד נדרש להישאר זמין"
                  hint="ההפסקה תיחשב כזמן עבודה ולא תנוכה"
                />
                {r?.break.kind === 'company_estimate' || r?.break.kind === 'legal_estimate' ? (
                  <Checkbox checked={s.breakConfirmed} onChange={(v) => onSaveShift(s, { ...s, breakConfirmed: v })} label="אושר שההפסקה המשוערת ניתנה בפועל" />
                ) : null}
                <Checkbox checked={s.reviewed} onChange={(v) => onSaveShift(s, { ...s, reviewed: v })} label="הסימונים לבדיקה במשמרת זו נבדקו" />
              </div>
            </div>
          );
        })}

        {version && (
          <p className="text-[12px] text-ink-soft">
            הגדרות בתוקף: {version.settings.workweek === 'five' ? 'שבוע בן 5 ימים' : 'שבוע בן 6 ימים'} · {day.thresholdReasons.join(' · ')}
          </p>
        )}
      </div>
    </Drawer>
  );
}

export { eachDate };
