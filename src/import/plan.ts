/**
 * Import planning: turns source records into an editable per-date preview, compares it with the
 * employee's existing attendance, and — only after approval — into shift changes.
 *
 * Imported times become shifts through the SAME helpers as manual entry (normalizeTimeInput,
 * buildTimestamps), so the calculation engine cannot tell them apart from typed times.
 */
import { addDays, weekdayOf, type LocalDate, type ShiftInput } from '../engine';
import { buildTimestamps, normalizeTimeInput, parseBreakInput } from '../ui/timeEntry';
import type { ExistingShiftView, PreviewCounts, PreviewRow, PreviewSegment, RowStatus, SourceRecord } from './types';
import { parseWeekday } from './values';

export const LOW_CONFIDENCE = 75;

export interface PlanContext {
  year: number;
  month: number;
  /** Existing shifts of the selected employee (at least the selected month). */
  existingShifts: ShiftInput[];
  /** Existing day statuses (vacation, sick, …) by date, Hebrew label. */
  existingDayStatus: Map<LocalDate, string>;
  /** Days with several entrance/exit pairs: the time between them is the break (no extra deduction). */
  gapIsBreak: boolean;
}

const inMonth = (date: LocalDate, ctx: PlanContext) => date.slice(0, 7) === `${ctx.year}-${String(ctx.month).padStart(2, '0')}`;

const hhmm = (dt: string | null) => (dt ? dt.slice(11, 16) : null);

function existingView(s: ShiftInput): ExistingShiftView {
  return { id: s.id, start: hhmm(s.startAt), end: hhmm(s.endAt), overnight: !!s.startAt && !!s.endAt && s.endAt.slice(0, 10) !== s.startAt.slice(0, 10), breakMinutes: s.breakMinutes };
}

// ---------------------------------------------------------------------------------------------
// Building the preview
// ---------------------------------------------------------------------------------------------

export function buildPreview(records: SourceRecord[], ctx: PlanContext): PreviewRow[] {
  const byDate = new Map<LocalDate, SourceRecord[]>();
  for (const r of records) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const dates = [...byDate.keys()].sort();

  const rows: PreviewRow[] = dates.map((date) => {
    const recs = byDate.get(date)!;
    const notes: string[] = [];
    const flags = [...new Set(recs.flatMap((r) => r.flags))];
    for (const n of recs.flatMap((r) => r.notes)) if (!notes.includes(n)) notes.push(n);

    // Exact duplicates (same entrance and exit printed twice) are imported once.
    const seen = new Set<string>();
    const segments: PreviewSegment[] = [];
    let duplicates = 0;
    for (const s of recs.flatMap((r) => r.segments)) {
      const key = `${s.start}|${s.end}|${s.startDate ?? ''}|${s.endDate ?? ''}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      segments.push({ start: s.start ?? '', end: s.end ?? '', startDate: s.startDate ?? null, endDate: s.endDate ?? null });
    }
    if (duplicates) notes.push(`רישום כפול במקור (${duplicates}) — נקלט פעם אחת`);
    segments.sort((a, b) => (a.start || a.end).localeCompare(b.start || b.end));

    const breaks = recs.map((r) => r.breakMinutes).filter((b): b is number => b !== null);
    const breakMinutes = breaks.length ? breaks.reduce((a, b) => a + b, 0) : null;
    if (breaks.length > 1) notes.push('הפסקות מכמה שורות במקור סוכמו');
    const totals = recs.map((r) => r.totalMinutes).filter((t): t is number => t !== null);
    const confs = recs.map((r) => r.conf).filter((c): c is number => typeof c === 'number');

    const row: PreviewRow = {
      date,
      weekdayText: recs.find((r) => r.weekdayText)?.weekdayText ?? null,
      segments,
      breakText: breakMinutes === null ? '' : String(breakMinutes),
      explicitBreak: breakMinutes !== null,
      status: 'ok',
      notes,
      include: false,
      conflictChoice: 'keep',
      existing: ctx.existingShifts.filter((s) => s.workDate === date).map(existingView),
      existingDayStatus: ctx.existingDayStatus.get(date) ?? null,
      sourceRows: recs.map((r) => r.row).filter((r) => r >= 0),
      conf: confs.length ? Math.min(...confs) : undefined,
      edited: false,
      sourceFlags: flags,
      totalMinutes: totals.length ? totals.reduce((a, b) => a + b, 0) : null,
    };
    if (duplicates) row.sourceFlags.push(DUPLICATE_MARK);
    return row;
  });

  mergeMidnightSplits(rows);
  return rows.map((r) => {
    const ev = evaluateRow(r, ctx);
    return { ...ev, include: defaultInclude(ev.status) };
  });
}

const DUPLICATE_MARK = '__duplicate__';

/** "22:00–23:59" on day D followed by "00:00–06:00" on D+1 is one overnight shift: join it, keep real timestamps. */
function mergeMidnightSplits(rows: PreviewRow[]) {
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (addDays(a.date, 1) !== b.date || !a.segments.length || !b.segments.length) continue;
    const last = a.segments[a.segments.length - 1];
    const firstB = b.segments[0];
    if (!last.start || !(last.end === '23:59' || last.end === '00:00') || firstB.start !== '00:00' || !firstB.end) continue;
    last.end = firstB.end;
    last.endDate = b.date;
    b.segments.shift();
    a.notes.push(`משמרת חוצת חצות שפוצלה במקור לשני ימים אוחדה (${last.start}–${firstB.end} ב-${b.date.slice(8)}/${b.date.slice(5, 7)})`);
    if (!b.segments.length) b.notes.push('הרישום אוחד עם משמרת היום הקודם (חוצה חצות)');
  }
  for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].segments.length && rows[i].notes.some((n) => n.startsWith('הרישום אוחד'))) rows.splice(i, 1);
}

export function defaultInclude(status: RowStatus): boolean {
  return status === 'ok' || status === 'duplicate' || status === 'conflict';
}

export function isIncludable(row: PreviewRow): boolean {
  return ['ok', 'duplicate', 'review', 'missing_in', 'missing_out', 'conflict'].includes(row.status);
}

// ---------------------------------------------------------------------------------------------
// Validation of one row (also after edits in the preview)
// ---------------------------------------------------------------------------------------------

interface Built {
  startAt: string | null;
  endAt: string | null;
}

/** Full timestamps for one segment — identical rules to manual entry (exit ≤ entry ⇒ next day). */
export function segmentTimestamps(date: LocalDate, seg: PreviewSegment): Built | { error: string } {
  const s = normalizeTimeInput(seg.start);
  const e = normalizeTimeInput(seg.end);
  if (s === null) return { error: `שעת כניסה לא תקינה "${seg.start}"` };
  if (e === null) return { error: `שעת יציאה לא תקינה "${seg.end}"` };
  if (seg.startDate && seg.startDate !== date) return { error: 'תאריך הכניסה בקובץ שונה מתאריך השורה' };
  if (s && e && seg.endDate) {
    const startAt = `${date}T${s}`;
    const endAt = `${seg.endDate}T${e}`;
    if (endAt <= startAt) return { error: 'שעת היציאה אינה מאוחרת משעת הכניסה' };
    return { startAt, endAt };
  }
  const ts = buildTimestamps(date, s, e);
  if (ts.error) return { error: ts.error };
  return { startAt: ts.startAt, endAt: ts.endAt };
}

const minutesBetween = (a: string, b: string) => Math.round((Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000);

export function evaluateRow(row: PreviewRow, ctx: PlanContext): PreviewRow {
  // Notes generated here are prefixed (⚠ problem, ℹ information) so re-evaluation after an edit replaces them.
  const notes = row.notes.filter((n) => !n.startsWith('⚠') && !n.startsWith('ℹ'));
  const add = (n: string) => notes.push(`⚠ ${n}`);
  const info = (n: string) => notes.push(`ℹ ${n}`);
  let status = 'ok' as RowStatus;
  const worse = (s: RowStatus) => {
    const rank: RowStatus[] = ['ok', 'duplicate', 'review', 'conflict', 'identical', 'missing_in', 'missing_out', 'total_only', 'invalid', 'out_of_month'];
    if (rank.indexOf(s) > rank.indexOf(status)) status = s;
  };

  if (!inMonth(row.date, ctx)) {
    add('התאריך אינו בחודש הדוח המוצג');
    return { ...row, notes, status: 'out_of_month', include: false };
  }

  const segs = row.segments.filter((s) => s.start.trim() || s.end.trim());
  const built: Built[] = [];
  if (!segs.length) {
    if (row.totalMinutes !== null) {
      add('בקובץ מופיע סה״כ שעות בלבד, ללא שעות כניסה ויציאה. לא נוצרו שעות — יש להזין ידנית.');
      worse('total_only');
    } else {
      add('לא נמצאו שעות כניסה/יציאה');
      worse('invalid');
    }
  }
  for (const seg of segs) {
    const b = segmentTimestamps(row.date, seg);
    if ('error' in b) {
      add(b.error);
      worse('invalid');
      continue;
    }
    if (!b.startAt) worse('missing_in');
    if (!b.endAt) worse('missing_out');
    built.push(b);
  }

  // Overlaps between segments of the same day.
  const complete = built.filter((b) => b.startAt && b.endAt).sort((a, b) => a.startAt!.localeCompare(b.startAt!));
  for (let i = 1; i < complete.length; i++) {
    if (complete[i].startAt! < complete[i - 1].endAt!) {
      add('רישומי הכניסה/יציאה ביום זה חופפים');
      worse('invalid');
    }
  }
  for (const b of complete) if (minutesBetween(b.startAt!, b.endAt!) > 24 * 60) {
    add('משמרת ארוכה מ-24 שעות');
    worse('review');
  }

  // Breaks.
  const brk = parseBreakInput(row.breakText);
  if (brk === 'invalid') {
    add(`משך הפסקה לא תקין "${row.breakText}"`);
    worse('invalid');
  } else if (complete.length === 1 && segs.length === 1 && brk !== null) {
    if (brk >= minutesBetween(complete[0].startAt!, complete[0].endAt!)) {
      add('ההפסקה ארוכה ממשך המשמרת');
      worse('invalid');
    }
  } else if (segs.length > 1) {
    const gaps = complete.slice(1).reduce((sum, b, i) => sum + minutesBetween(complete[i].endAt!, b.startAt!), 0);
    if (brk !== null) {
      if (Math.abs(brk - gaps) <= 1) info(`ההפסקה המדווחת (${brk} דק׳) תואמת לפער בין הרישומים — לא תקוזז פעמיים`);
      else {
        add(`ההפסקה המדווחת (${brk} דק׳) שונה מהפער בין הרישומים (${gaps} דק׳). הפער נחשב כזמן שאינו עבודה; ההפסקה המדווחת לא תקוזז בנוסף.`);
        worse('review');
      }
    } else if (ctx.gapIsBreak) {
      if (complete.length > 1) info(`${segs.length} רישומי כניסה/יציאה; הזמן שביניהם (${gaps} דק׳) הוא ההפסקה — לא תקוזז הפסקה נוספת`);
    } else {
      add('כמה רישומי כניסה/יציאה ביום: מדיניות ההפסקות של העובד עלולה לקזז הפסקה בנוסף לפער שבין הרישומים');
      worse('review');
    }
  }

  // Source quality.
  if (!row.edited) {
    for (const f of row.sourceFlags) if (f !== DUPLICATE_MARK) {
      add(f);
      worse('review');
    }
    if (row.conf !== undefined && row.conf < LOW_CONFIDENCE) {
      add(`זיהוי טקסט (OCR) בביטחון נמוך (${Math.round(row.conf)}%) — יש להשוות למסמך המקורי`);
      worse('review');
    }
  }
  if (row.sourceFlags.includes(DUPLICATE_MARK)) worse('duplicate');
  if (row.weekdayText) {
    const wd = parseWeekday(row.weekdayText);
    if (wd !== null && wd !== weekdayOf(row.date)) {
      add(`היום בשבוע בקובץ ("${row.weekdayText}") אינו תואם לתאריך — ייתכן שפורמט התאריך שגוי`);
      worse('review');
    }
  }

  // Existing data on that date.
  if (row.existing.length) {
    const brkMin = brk === 'invalid' ? null : brk;
    const same =
      row.existing.length === complete.length &&
      complete.every((b) => {
        const st = hhmm(b.startAt);
        const en = hhmm(b.endAt);
        return row.existing.some((x) => x.start === st && x.end === en && (!row.explicitBreak || segs.length > 1 || x.breakMinutes === brkMin));
      }) &&
      built.length === complete.length;
    if (same && (status === 'ok' || status === 'duplicate' || status === 'review')) {
      info('הנתונים כבר קיימים בדוח — לא יבוצע שינוי');
      status = 'identical';
    } else if (status === 'ok' || status === 'duplicate' || status === 'review') {
      status = 'conflict';
    } else {
      add('קיימים נתונים שמורים ליום זה — הם לא ישתנו');
    }
  }
  if (row.existingDayStatus && (status === 'ok' || status === 'conflict' || status === 'review' || status === 'duplicate')) {
    info(`היום מסומן כ"${row.existingDayStatus}" — הסימון יישאר; יש לעדכן אותו ידנית אם צריך`);
  }

  const include = row.include && isIncludable({ ...row, status });
  return { ...row, notes, status, include };
}

// ---------------------------------------------------------------------------------------------
// Counts and changes
// ---------------------------------------------------------------------------------------------

export function willWrite(row: PreviewRow): boolean {
  if (!row.include || !isIncludable(row)) return false;
  if (row.status === 'conflict') return row.conflictChoice === 'replace';
  return true;
}

export function countPreview(rows: PreviewRow[]): PreviewCounts {
  const inM = rows.filter((r) => r.status !== 'out_of_month');
  return {
    recognized: rows.length,
    valid: inM.filter((r) => r.status === 'ok' || r.status === 'duplicate' || r.status === 'identical').length,
    invalid: inM.filter((r) => ['invalid', 'missing_in', 'missing_out', 'total_only', 'review'].includes(r.status)).length,
    conflicts: inM.filter((r) => r.status === 'conflict').length,
    outOfMonth: rows.length - inM.length,
    willImport: rows.filter(willWrite).length,
  };
}

export interface ImportChanges {
  add: ShiftInput[];
  /** Existing shifts replaced by explicit user choice. */
  remove: ShiftInput[];
  days: LocalDate[];
}

export function buildImportChanges(rows: PreviewRow[], ctx: PlanContext): ImportChanges {
  const add: ShiftInput[] = [];
  const remove: ShiftInput[] = [];
  const days: LocalDate[] = [];
  for (const row of rows) {
    if (!willWrite(row)) continue;
    const segs = row.segments.filter((s) => s.start.trim() || s.end.trim());
    const brk = parseBreakInput(row.breakText);
    const explicit = brk === 'invalid' ? null : brk;
    const multi = segs.length > 1;
    const built: Built[] = [];
    for (const seg of segs) {
      const b = segmentTimestamps(row.date, seg);
      if ('error' in b) throw new Error(`${row.date}: ${b.error}`);
      built.push(b);
    }
    for (const b of built) {
      // Break: explicit value from the report (single segment) → as if typed (confirmed).
      // Several segments → the gap between them is the break: 0 extra (as if "0" was typed), unless the
      // office chose to let the employee's break policy decide (then it stays unconfirmed, as usual).
      let breakMinutes: number | null = null;
      let breakConfirmed = false;
      if (!multi && explicit !== null) {
        breakMinutes = explicit;
        breakConfirmed = true;
      } else if (multi && (ctx.gapIsBreak || explicit !== null)) {
        breakMinutes = 0;
        breakConfirmed = true;
      }
      add.push({
        id: crypto.randomUUID(),
        workDate: row.date,
        startAt: b.startAt,
        endAt: b.endAt,
        breakMinutes,
        breakStart: null,
        breakConfirmed,
        breakPaid: false,
        reviewed: false,
      });
    }
    if (row.status === 'conflict' && row.conflictChoice === 'replace') {
      remove.push(...ctx.existingShifts.filter((s) => s.workDate === row.date));
    }
    days.push(row.date);
  }
  return { add, remove, days };
}

/** Months (YYYY-MM) present in the records with their day counts, most frequent first. */
export function monthsInRecords(records: SourceRecord[]): { ym: string; days: number }[] {
  const m = new Map<string, Set<string>>();
  for (const r of records) m.set(r.date.slice(0, 7), (m.get(r.date.slice(0, 7)) ?? new Set()).add(r.date));
  return [...m.entries()].map(([ym, d]) => ({ ym, days: d.size })).sort((a, b) => b.days - a.days);
}

