/**
 * "ייבוא דוח שעות" — reads an attendance report (Excel / CSV / PDF / scanned PDF) locally, shows a full
 * editable preview, and writes NOTHING until the user approves. Existing data is never overwritten
 * silently: conflicts default to keeping the existing record.
 */
import { useEffect, useMemo, useState } from 'react';
import { monthRange, type LocalDate, type ShiftInput } from '../../engine';
import type { Employee } from '../../data/repo';
import { isTauri } from '../../data/tauriDriver';
import { useApp } from '../App';
import { Badge, Button, Checkbox, Field, Modal, Segmented, Select, useUi } from '../components';
import { IconAlert, IconCheck, IconInfo } from '../icons';
import { formatDateHe, monthTitle, STATUS_LABELS as DAY_STATUS_LABELS } from '../format';
import {
  buildImportChanges,
  buildPreview,
  countPreview,
  detectTable,
  evaluateRow,
  ImportError,
  isIncludable,
  mappingFromSelection,
  monthsInRecords,
  readImportFile,
  readRecords,
  sameEmployee,
  STATUS_LABELS,
  tauriXlsReader,
  willWrite,
  type ColumnMapping,
  type Detection,
  type Grid,
  type OcrProgress,
  type PlanContext,
  type PreviewRow,
  type ReadResult,
  type RowStatus,
} from '../../import';

export interface ImportResult {
  added: ShiftInput[];
  removed: ShiftInput[];
  year: number;
  month: number;
}

const STATUS_TONE: Record<RowStatus, 'green' | 'amber' | 'red' | 'slate' | 'violet' | 'blue'> = {
  ok: 'green',
  review: 'amber',
  missing_in: 'red',
  missing_out: 'red',
  duplicate: 'blue',
  out_of_month: 'slate',
  conflict: 'violet',
  identical: 'slate',
  total_only: 'red',
  invalid: 'red',
};

interface Sel {
  date: number | null;
  in: number | null;
  out: number | null;
  in2: number | null;
  out2: number | null;
  break: number | null;
  employee: number | null;
}

const selFromMapping = (m: ColumnMapping | null): Sel => ({
  date: m?.date ?? null,
  in: m?.pairs[0]?.in ?? null,
  out: m?.pairs[0]?.out ?? null,
  in2: m?.pairs[1]?.in ?? null,
  out2: m?.pairs[1]?.out ?? null,
  break: m?.break ?? null,
  employee: m?.employee ?? null,
});

const empKey = (e: { name: string | null; number: string | null }) => `${e.name ?? ''}|${e.number ?? ''}`;

export function AttendanceImportDialog({
  businessId,
  employee,
  year,
  month,
  file,
  onClose,
  onImported,
}: {
  businessId: string;
  employee: Employee;
  year: number;
  month: number;
  file: File;
  onClose: () => void;
  onImported: (r: ImportResult) => void;
}) {
  const { repo } = useApp();
  const ui = useUi();
  const [phase, setPhase] = useState<'reading' | 'error' | 'review' | 'saving' | 'done'>('reading');
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [mappingNote, setMappingNote] = useState<string | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [sel, setSel] = useState<Sel>(selFromMapping(null));
  const [target, setTarget] = useState({ year, month });
  const [existing, setExisting] = useState<{ shifts: ShiftInput[]; status: Map<LocalDate, string> } | null>(null);
  const [empChoice, setEmpChoice] = useState<string | null>(null);
  const [empConfirmed, setEmpConfirmed] = useState(false);
  const [gapIsBreak, setGapIsBreak] = useState(true);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [finalMonth, setFinalMonth] = useState(false);
  const [done, setDone] = useState<{ days: number; shifts: number; replaced: number; skipped: string[] } | null>(null);

  // 1. Read the file (in memory) and find the table.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const g = await readImportFile({ name: file.name, bytes }, { onProgress: (p) => alive && setProgress(p), xlsReader: isTauri() ? tauriXlsReader : null });
        if (!alive) return;
        const det = detectTable(g);
        let m = det.mapping;
        let note: string | null = null;
        let confirmed = !det.ambiguous;
        if (det.signature) {
          const saved = await repo.getMeta(`import_mapping:${det.signature}`).catch(() => null);
          if (saved) {
            try {
              const parsed = JSON.parse(saved) as ColumnMapping;
              if (parsed && typeof parsed.date === 'number' && g.sheets[parsed.sheet]) {
                m = parsed;
                confirmed = true;
                note = 'נעשה שימוש במיפוי העמודות שנשמר עבור פורמט דוח זה.';
              }
            } catch {
              /* ignore a damaged saved mapping */
            }
          }
        }
        setGrid(g);
        setDetection(det);
        setMapping(m);
        setSel(selFromMapping(m));
        setMappingNote(note);
        setMappingConfirmed(confirmed);
        setMappingOpen(!confirmed);
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
  }, [file, repo]);

  // 2. Existing data of the target month (for conflicts) and month status.
  useEffect(() => {
    let alive = true;
    const { from, to } = monthRange(target.year, target.month);
    Promise.all([
      repo.getShifts(businessId, employee.id, from, to),
      repo.getDayEntries(businessId, employee.id, from, to),
      repo.getMonthReview(businessId, `${target.year}-${String(target.month).padStart(2, '0')}`),
    ]).then(([sh, en, review]) => {
      if (!alive) return;
      setExisting({
        shifts: sh.map((s) => ({ id: s.id, workDate: s.workDate, startAt: s.startAt, endAt: s.endAt, breakMinutes: s.breakMinutes, breakStart: s.breakStart, breakConfirmed: s.breakConfirmed, breakPaid: s.breakPaid, reviewed: s.reviewed, note: s.note })),
        status: new Map(en.filter((e) => e.status).map((e) => [e.date, DAY_STATUS_LABELS[e.status!]])),
      });
      setFinalMonth(review.status === 'final');
    });
    return () => {
      alive = false;
    };
  }, [repo, businessId, employee.id, target]);

  // 3. Read rows with the current mapping.
  const read: ReadResult | null = useMemo(() => (grid && mapping ? readRecords(grid, mapping, { fallbackYear: target.year }) : null), [grid, mapping, target.year]);

  const employees = read?.employees ?? [];
  const multiEmployee = employees.length > 1;
  useEffect(() => {
    if (!read) return;
    if (read.employees.length === 1) setEmpChoice(empKey(read.employees[0]));
    else {
      const match = read.employees.filter((e) => sameEmployee(e, employee));
      setEmpChoice(match.length === 1 ? empKey(match[0]) : null);
    }
    setEmpConfirmed(false);
  }, [read, employee]);

  const chosen = employees.find((e) => empKey(e) === empChoice) ?? null;
  const nameMismatch = !!chosen && (chosen.name || chosen.number) && !sameEmployee(chosen, employee);
  const records = useMemo(() => (read && empChoice !== null ? read.records.filter((r) => empKey({ name: r.employee, number: r.employeeNo }) === empChoice) : []), [read, empChoice]);
  const otherEmployeeRows = read ? read.records.length - records.length : 0;
  const months = useMemo(() => monthsInRecords(records), [records]);
  const targetYm = `${target.year}-${String(target.month).padStart(2, '0')}`;

  const ctx: PlanContext | null = useMemo(
    () => (existing ? { year: target.year, month: target.month, existingShifts: existing.shifts, existingDayStatus: existing.status, gapIsBreak } : null),
    [existing, target, gapIsBreak],
  );

  useEffect(() => {
    if (ctx) setRows(buildPreview(records, ctx));
  }, [records, ctx]);

  const counts = countPreview(rows);
  const hasMulti = rows.some((r) => r.segments.filter((s) => s.start || s.end).length > 1);
  const empReady = !multiEmployee || empChoice !== null;
  const empOk = empReady && (!nameMismatch || empConfirmed);
  const canApprove = phase === 'review' && !!mapping && mappingConfirmed && empOk && counts.willImport > 0;

  const updateRow = (date: LocalDate, patch: Partial<PreviewRow>) => {
    if (!ctx) return;
    setRows((list) => list.map((r) => (r.date === date ? evaluateRow({ ...r, ...patch, edited: patch.include === undefined && patch.conflictChoice === undefined ? true : r.edited }, ctx) : r)));
  };

  const applySelection = () => {
    if (!grid || !detection) return;
    const base = mapping ?? detection.mapping;
    const m = mappingFromSelection(base, base?.sheet ?? 0, base?.headerRow ?? 0, sel);
    if (!m) {
      ui.toast('יש לבחור לפחות עמודת תאריך ועמודת כניסה או יציאה.', 'error');
      return;
    }
    setMapping(m);
    setMappingConfirmed(true);
    setMappingOpen(false);
    setMappingNote(null);
  };

  async function approve() {
    if (!ctx || !mapping) return;
    if (finalMonth) {
      const ok = await ui.confirm({
        title: 'החודש סומן כסופי',
        danger: true,
        confirmLabel: 'קליטה בכל זאת',
        message: 'דוח החודש סומן כסופי. קליטת נתונים תשנה את חישובי החודש והשינוי יזוהה כשינוי לאחר סגירה. להמשיך?',
      });
      if (!ok) return;
    }
    setPhase('saving');
    try {
      const changes = buildImportChanges(rows, ctx);
      await repo.applyAttendanceImport(businessId, employee.id, changes, {
        fileName: file.name,
        fileBytes: file.size,
        format: grid?.format,
        month: targetYm,
        days: changes.days.length,
        sourceEmployee: chosen ? { name: chosen.name, number: chosen.number } : null,
        counts,
      });
      if (detection?.signature && mappingConfirmed && (detection.ambiguous || JSON.stringify(mapping) !== JSON.stringify(detection.mapping))) {
        await repo.setMeta(`import_mapping:${detection.signature}`, JSON.stringify(mapping)).catch(() => undefined);
      }
      const skipped: string[] = [];
      const notImported = rows.filter((r) => !willWrite(r) && r.status !== 'identical' && !(r.status === 'conflict' && r.conflictChoice === 'keep'));
      const byStatus = new Map<RowStatus, number>();
      for (const r of notImported) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      for (const [s, n] of byStatus) skipped.push(`${n} ימים לא נקלטו — ${STATUS_LABELS[s]}`);
      const kept = rows.filter((r) => r.status === 'conflict' && r.conflictChoice === 'keep').length;
      if (kept) skipped.push(`${kept} ימים עם נתונים קיימים נשמרו ללא שינוי`);
      if (otherEmployeeRows) skipped.push(`${otherEmployeeRows} רשומות של עובדים אחרים בקובץ לא נקלטו`);
      if (read?.unreadableRows) skipped.push(`${read.unreadableRows} שורות בקובץ לא זוהו`);
      setDone({ days: changes.days.length, shifts: changes.add.length, replaced: changes.remove.length, skipped });
      setPhase('done');
      ui.toast(`נקלטו בהצלחה ${changes.days.length} ימי עבודה לדוח חודש ${monthTitle(target.year, target.month)}.`);
      onImported({ added: changes.add, removed: changes.remove, year: target.year, month: target.month });
    } catch (e) {
      ui.toast(`הקליטה נכשלה ולא נשמר דבר: ${e instanceof Error ? e.message : String(e)}`, 'error');
      setPhase('review');
    }
  }

  // ------------------------------------------------------------------- render
  if (phase === 'reading' || phase === 'error') {
    return (
      <Modal open onClose={onClose} title="ייבוא דוח שעות" width="max-w-lg" footer={<Button onClick={onClose}>{phase === 'error' ? 'סגירה' : 'ביטול'}</Button>}>
        {phase === 'reading' ? (
          <div className="py-4 text-center" data-testid="import-reading">
            <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            <div className="text-[14px] text-ink">קורא את הקובץ "{file.name}" במחשב זה…</div>
            {progress && (
              <div className="mt-3">
                <div className="text-[13px] text-ink-soft">
                  {progress.stage === 'render' ? 'מכין' : 'מזהה טקסט (OCR) בעמוד'} {progress.page} מתוך {progress.pages}
                </div>
                <div className="mx-auto mt-2 h-1.5 w-64 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full bg-brand transition-all" style={{ width: `${Math.round(((progress.page - 1 + progress.progress) / progress.pages) * 100)}%` }} />
                </div>
              </div>
            )}
            <div className="mt-3 text-[12px] text-ink-soft">הקובץ אינו נשלח לשום מקום. הנתונים לא ישתנו עד לאישורך.</div>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 rounded-lg bg-red-50 p-3 text-[14px] text-red-800 ring-1 ring-red-200" role="alert" data-testid="import-error">
            <IconAlert size={18} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </Modal>
    );
  }

  if (phase === 'done' && done) {
    return (
      <Modal open onClose={onClose} title="הייבוא הושלם" width="max-w-lg" footer={<Button variant="primary" onClick={onClose}>סגירה</Button>}>
        <div data-testid="import-done" className="space-y-3 text-[14px]">
          <div className="flex items-start gap-2.5 rounded-lg bg-emerald-50 p-3 text-emerald-900 ring-1 ring-emerald-200">
            <IconCheck size={18} className="mt-0.5 shrink-0" />
            <span>
              נקלטו בהצלחה {done.days} ימי עבודה לדוח חודש {monthTitle(target.year, target.month)}
              {done.replaced ? ` (הוחלפו ${done.replaced} משמרות קיימות לפי בחירתך)` : ''}.
            </span>
          </div>
          {done.skipped.length > 0 && (
            <ul className="list-disc space-y-1 ps-5 text-ink-soft" data-testid="import-skipped">
              {done.skipped.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          <p className="text-[12.5px] text-ink-soft">השעות שנקלטו מחושבות בדיוק כמו שעות שהוזנו ידנית. ניתן לבטל את הייבוא כולו בלחצן "ביטול פעולה" (Ctrl+Z).</p>
        </div>
      </Modal>
    );
  }

  const labels = detection?.columnLabels ?? [];
  const samples = detection?.columnSamples ?? [];
  const colOptions = [{ value: -1, label: '— ללא —' }, ...labels.map((l, i) => ({ value: i, label: `${l}${samples[i]?.length ? ` (${samples[i].slice(0, 2).join(', ')})` : ''}` }))];
  const selField = (key: keyof Sel, label: string) => (
    <Field label={label}>
      <Select<number> value={sel[key] ?? -1} onChange={(v) => setSel((s) => ({ ...s, [key]: v < 0 ? null : v }))} options={colOptions} data-testid={`map-${key}`} />
    </Field>
  );

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-[1180px]"
      title={
        <span>
          ייבוא דוח שעות — {employee.fullName} — {monthTitle(target.year, target.month)}
        </span>
      }
      footer={
        <>
          <Button variant="primary" disabled={!canApprove} onClick={() => void approve()} data-testid="import-approve">
            {phase === 'saving' ? 'שומר…' : 'אישור וקליטת הנתונים'}
          </Button>
          <Button onClick={onClose} data-testid="import-cancel">
            ביטול
          </Button>
          <span className="ms-auto text-[12.5px] text-ink-soft">
            {counts.willImport > 0 ? `ייקלטו ${counts.willImport} ימים` : 'לא נבחרו ימים לקליטה'}
          </span>
        </>
      }
    >
      <div className="space-y-3" data-testid="import-preview">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-soft">
          <span>
            קובץ: <span className="text-ink">{file.name}</span>
          </span>
          {grid && <span>סוג: {{ xlsx: 'Excel', xls: 'Excel', csv: 'CSV', pdf: 'PDF', 'pdf-ocr': 'PDF סרוק (OCR)' }[grid.format]}</span>}
          {chosen?.name && (
            <span>
              עובד בקובץ: <span className="text-ink">{chosen.name}</span>
              {chosen.number ? ` (${chosen.number})` : ''}
            </span>
          )}
        </div>

        {grid?.notes.map((n) => (
          <Banner key={n} tone="info">
            {n}
          </Banner>
        ))}
        {mappingNote && <Banner tone="info">{mappingNote}</Banner>}

        {/* Column mapping */}
        {(mappingOpen || !mapping) && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4" data-testid="import-mapping">
            <div className="mb-2 text-[14px] font-medium text-ink">אישור מיפוי עמודות</div>
            {detection?.reasons.map((r) => (
              <p key={r} className="mb-2 text-[13px] text-amber-900">
                {r}
              </p>
            ))}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {selField('date', 'תאריך')}
              {selField('in', 'כניסה')}
              {selField('out', 'יציאה')}
              {selField('break', 'הפסקה')}
              {selField('in2', 'כניסה נוספת (לא חובה)')}
              {selField('out2', 'יציאה נוספת (לא חובה)')}
              {selField('employee', 'שם עובד (לא חובה)')}
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" size="sm" onClick={applySelection} data-testid="map-apply">
                אישור המיפוי
              </Button>
              {mapping && mappingConfirmed && (
                <Button size="sm" onClick={() => setMappingOpen(false)}>
                  סגירה
                </Button>
              )}
            </div>
            <p className="mt-2 text-[12px] text-ink-soft">המיפוי יישמר לייבוא הבא של דוח באותו פורמט.</p>
          </div>
        )}
        {mapping && !mappingOpen && (
          <div className="text-[12.5px] text-ink-soft">
            עמודות שזוהו: תאריך ← "{labels[mapping.date]}", {mapping.pairs.map((p, i) => `כניסה${mapping.pairs.length > 1 ? ` ${i + 1}` : ''} ← "${p.in !== null ? labels[p.in] : '—'}", יציאה ← "${p.out !== null ? labels[p.out] : '—'}"`).join(', ')}
            {mapping.break !== null ? `, הפסקה ← "${labels[mapping.break]}"` : ''}.{' '}
            <button className="text-brand hover:underline" onClick={() => setMappingOpen(true)} data-testid="map-edit">
              שינוי מיפוי
            </button>
          </div>
        )}

        {/* Employee */}
        {multiEmployee && (
          <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-4" data-testid="import-employee">
            <div className="mb-2 text-[14px] font-medium text-ink">הקובץ מכיל נתונים של {employees.length} עובדים. יש לבחור את הנתונים של {employee.fullName}:</div>
            <Select<string>
              value={empChoice ?? ''}
              onChange={(v) => setEmpChoice(v || null)}
              options={[{ value: '', label: '— בחירת עובד מהקובץ —' }, ...employees.map((e) => ({ value: empKey(e), label: `${e.name ?? 'ללא שם'}${e.number ? ` (${e.number})` : ''} — ${e.rows} ימים` }))]}
              className="!w-auto"
              data-testid="import-employee-select"
            />
            <p className="mt-2 text-[12px] text-ink-soft">רק הנתונים של העובד שנבחר ייקלטו. נתוני העובדים האחרים לא ייקלטו.</p>
          </div>
        )}
        {nameMismatch && (
          <Banner tone="warn">
            <div>
              בקובץ מופיע העובד "{chosen?.name ?? ''}
              {chosen?.number ? ` (${chosen.number})` : ''}", שאינו תואם לעובד שנבחר במערכת ({employee.fullName}).
            </div>
            <div className="mt-1.5">
              <Checkbox checked={empConfirmed} onChange={setEmpConfirmed} label={`אני מאשר/ת שהנתונים שייכים ל-${employee.fullName}`} />
            </div>
          </Banner>
        )}

        {/* Month */}
        {months.length > 0 && !months.some((m) => m.ym === targetYm) && (
          <Banner tone="warn">
            <div data-testid="import-wrong-month">
              הקובץ אינו מכיל נתונים לחודש {monthTitle(target.year, target.month)}. החודש בקובץ: {months.map((m) => monthTitle(+m.ym.slice(0, 4), +m.ym.slice(5))).join(', ')}.
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {months.slice(0, 3).map((m) => (
                <Button key={m.ym} size="sm" onClick={() => setTarget({ year: +m.ym.slice(0, 4), month: +m.ym.slice(5) })} data-testid={`import-month-${m.ym}`}>
                  ייבוא לחודש {monthTitle(+m.ym.slice(0, 4), +m.ym.slice(5))} ({m.days} ימים)
                </Button>
              ))}
            </div>
          </Banner>
        )}
        {finalMonth && <Banner tone="warn">דוח החודש סומן כסופי. קליטה תשנה את נתוני החודש.</Banner>}

        {/* Counts */}
        <div className="flex flex-wrap gap-2 text-[12.5px]" data-testid="import-counts">
          <Badge tone="slate">זוהו {counts.recognized} ימים</Badge>
          <Badge tone="green">תקינים {counts.valid}</Badge>
          <Badge tone="red">דורשים טיפול {counts.invalid}</Badge>
          <Badge tone="violet">התנגשויות {counts.conflicts}</Badge>
          {counts.outOfMonth > 0 && <Badge tone="slate">מחוץ לחודש {counts.outOfMonth}</Badge>}
          {read && read.summaryRows > 0 && <Badge tone="slate">שורות סיכום שדולגו {read.summaryRows}</Badge>}
          {read && read.emptyDays > 0 && <Badge tone="slate">ימים ללא נוכחות {read.emptyDays}</Badge>}
        </div>

        {hasMulti && (
          <Checkbox
            checked={gapIsBreak}
            onChange={setGapIsBreak}
            label="בימים עם כמה רישומי כניסה/יציאה — הזמן שבין הרישומים הוא ההפסקה (לא לקזז הפסקה נוספת)"
            hint="אם יבוטל, תופעל מדיניות ההפסקות של העובד על כל רישום, והיום יסומן לבדיקה."
          />
        )}

        {/* Preview table */}
        <div className="max-h-[52vh] overflow-auto rounded-xl border border-line">
          <table className="w-full border-separate border-spacing-0 text-[13.5px]" data-testid="import-table">
            <thead className="sticky top-0 z-10 bg-slate-50 text-right text-[12px] text-ink-soft">
              <tr className="[&>th]:border-b [&>th]:border-line [&>th]:px-2 [&>th]:py-2 [&>th]:font-medium">
                <th className="w-8 text-center">קליטה</th>
                <th className="w-[96px]">תאריך</th>
                <th className="w-[96px] text-center">כניסה שזוהתה</th>
                <th className="w-[96px] text-center">יציאה שזוהתה</th>
                <th className="w-[84px] text-center">הפסקה שזוהתה</th>
                <th className="w-[130px]">סטטוס</th>
                <th>הערות</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <PreviewLine key={r.date} row={r} onChange={(p) => updateRow(r.date, p)} />
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-ink-soft">
                    {mapping ? 'לא נמצאו רישומי נוכחות לעובד ולחודש שנבחרו.' : 'יש לאשר את מיפוי העמודות כדי לראות את התצוגה המקדימה.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="flex items-start gap-1.5 text-[12px] text-ink-soft">
          <IconInfo size={14} className="mt-0.5 shrink-0" />
          שום נתון לא נשמר עד ללחיצה על "אישור וקליטת הנתונים". ימים שבהם קיימים נתונים שמורים יישארו ללא שינוי אלא אם תבחר/י "החלפה". שורות ריקות בקובץ אינן מוחקות נתונים קיימים.
        </p>
      </div>
    </Modal>
  );
}

function Banner({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-lg p-3 text-[13px] ring-1 ${tone === 'warn' ? 'bg-amber-50 text-amber-900 ring-amber-200' : 'bg-sky-50 text-sky-900 ring-sky-200'}`}>
      {tone === 'warn' ? <IconAlert size={16} className="mt-0.5 shrink-0" /> : <IconInfo size={16} className="mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function PreviewLine({ row: r, onChange }: { row: PreviewRow; onChange: (p: Partial<PreviewRow>) => void }) {
  const includable = isIncludable(r);
  const segs = r.segments.length ? r.segments : [{ start: '', end: '' }];
  const setSeg = (i: number, key: 'start' | 'end', v: string) => onChange({ segments: segs.map((s, k) => (k === i ? { ...s, [key]: v } : s)) });
  const dim = !willWriteLocal(r) ? 'text-ink-soft' : '';
  return (
    <tr className={`align-top ${r.status === 'out_of_month' ? 'opacity-50' : ''}`} data-testid={`import-row-${r.date}`}>
      <td className="border-b border-line/70 px-2 py-1.5 text-center">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-brand"
          checked={r.include && includable}
          disabled={!includable}
          onChange={(e) => onChange({ include: e.target.checked })}
          aria-label={`קליטת ${r.date}`}
          data-testid={`import-include-${r.date}`}
        />
      </td>
      <td className={`border-b border-line/70 px-2 py-1.5 ${dim}`}>
        <div className="num font-medium">{formatDateHe(r.date)}</div>
        {r.weekdayText && <div className="text-[11px] text-ink-soft">{r.weekdayText}</div>}
      </td>
      <td className="border-b border-line/70 px-1 py-1 text-center">
        {segs.map((s, i) => (
          <TimeInput key={i} value={s.start} onCommit={(v) => setSeg(i, 'start', v)} testid={`import-start-${r.date}-${i}`} />
        ))}
      </td>
      <td className="border-b border-line/70 px-1 py-1 text-center">
        {segs.map((s, i) => (
          <TimeInput key={i} value={s.end} onCommit={(v) => setSeg(i, 'end', v)} testid={`import-end-${r.date}-${i}`} suffix={s.endDate && s.endDate !== r.date ? '+1' : undefined} />
        ))}
      </td>
      <td className="border-b border-line/70 px-1 py-1 text-center">
        <TimeInput value={r.breakText} onCommit={(v) => onChange({ breakText: v, explicitBreak: v.trim() !== '' })} testid={`import-break-${r.date}`} placeholder={r.segments.length > 1 ? '' : 'מדיניות'} />
      </td>
      <td className="border-b border-line/70 px-2 py-1.5">
        <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABELS[r.status]}</Badge>
        {r.conf !== undefined && <div className="mt-1 text-[11px] text-ink-soft">ביטחון OCR: {Math.round(r.conf)}%</div>}
      </td>
      <td className="border-b border-line/70 px-2 py-1.5 text-[12.5px]">
        {r.status === 'conflict' && (
          <div className="mb-1.5 rounded-lg bg-violet-50 p-2 ring-1 ring-violet-200" data-testid={`import-conflict-${r.date}`}>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[11px] text-ink-soft">נתון קיים</div>
                {r.existing.map((x) => (
                  <div key={x.id} className="num">
                    {x.start ?? '—'}–{x.end ?? '—'}
                    {x.overnight ? ' (+1)' : ''}
                    {x.breakMinutes !== null ? ` · הפסקה ${x.breakMinutes}` : ''}
                  </div>
                ))}
              </div>
              <div>
                <div className="text-[11px] text-ink-soft">מהקובץ</div>
                {r.segments.map((s, i) => (
                  <div key={i} className="num">
                    {s.start || '—'}–{s.end || '—'}
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-1.5">
              <Segmented<'keep' | 'replace'>
                value={r.conflictChoice}
                onChange={(v) => onChange({ conflictChoice: v })}
                options={[
                  { value: 'keep', label: 'השארת הקיים' },
                  { value: 'replace', label: 'החלפה בנתון מהקובץ' },
                ]}
              />
            </div>
          </div>
        )}
        <ul className="space-y-0.5">
          {r.notes.map((n, i) => (
            <li key={i} className={n.startsWith('⚠') ? 'text-amber-800' : 'text-ink-soft'}>
              {n.replace(/^[⚠ℹ]\s*/, '')}
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

function willWriteLocal(r: PreviewRow) {
  return willWrite(r);
}

function TimeInput({ value, onCommit, testid, suffix, placeholder }: { value: string; onCommit: (v: string) => void; testid: string; suffix?: string; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="flex items-center justify-center gap-1">
      <input
        className="cell-input"
        value={v}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onCommit(v.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        data-testid={testid}
      />
      {suffix && <span className="text-[10px] text-ink-soft">{suffix}</span>}
    </div>
  );
}
