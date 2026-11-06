/**
 * "סיכום חודשי לקליטת שכר" — A4 landscape print / PDF.
 *
 * ONE continuous table: one employee = one row with all of their payroll data, read right-to-left. Two-level column
 * headings group the figures (ימים · שעות עבודה · מנוחה/חג · חופשה · מחלה · חג · תשלומים). Every hour value shows its
 * decimal figure (for entry) with HH:MM underneath, in the same cell. Rare categories that would not fit the A4 width
 * as columns are printed on a short line directly under that employee's row (same record, never on another page),
 * together with what needs checking. Renders the PayrollEntryReport model only — no calculation happens here.
 */
import { Fragment } from 'react';
import { cellText, daysText, hhmm, decimalHours, moneyText, NO_RECORDS_TEXT, ROW_STATE_LABELS, type PayrollEntryReport, type PeColumn, type PeRow, type PeValue } from '../export/payrollEntry';

/** Printable width of A4 landscape with 8 mm side margins. */
const PAGE_WIDTH_MM = 281;
const WIDTH_MM = { name: 31, days: 8.5, hours: 13, money: 15.5, flag: 10.5 } as const;
/** Day columns with longer headings or a second line (sick days show the paid equivalent). */
const WIDE_DAYS: Record<string, number> = { actualDays: 11, paidDays: 11, sickDays: 10.5 };
const colWidth = (c: { key: string; kind: keyof typeof WIDTH_MM }) => WIDE_DAYS[c.key] ?? WIDTH_MM[c.kind];

interface Col {
  key: string;
  head: string;
  /** Second heading line (rate), printed smaller. */
  sub?: string;
  kind: PeColumn['kind'];
}
interface Group {
  title: string;
  cols: Col[];
  /** Whole group optional: shown when any of its columns is in the report. */
  optional?: boolean;
}

const MAIN: Group[] = [
  { title: 'ימים', cols: [{ key: 'actualDays', head: 'בפועל', kind: 'days' }, { key: 'paidDays', head: 'משולמים', kind: 'days' }] },
  {
    title: 'שעות עבודה',
    cols: [
      { key: 'actualHours', head: 'בפועל', kind: 'hours' },
      { key: 'paidHours', head: 'משולמות', kind: 'hours' },
      { key: 'regular', head: 'רגילות', sub: '100%', kind: 'hours' },
      { key: 'ot125', head: 'נוספות', sub: '125%', kind: 'hours' },
      { key: 'ot150', head: 'נוספות', sub: '150%', kind: 'hours' },
    ],
  },
  {
    title: 'מנוחה / חג',
    optional: true,
    cols: [
      { key: 'p150', head: '150%', kind: 'hours' },
      { key: 'p175', head: '175%', kind: 'hours' },
      { key: 'p200', head: '200%', kind: 'hours' },
    ],
  },
  { title: 'חופשה', cols: [{ key: 'vacationDays', head: 'ימים', kind: 'days' }, { key: 'vacationHours', head: 'שעות', kind: 'hours' }] },
  { title: 'מחלה', cols: [{ key: 'sickDays', head: 'ימים', kind: 'days' }, { key: 'sickHours', head: 'שעות', kind: 'hours' }] },
  { title: 'חג', cols: [{ key: 'holidayDays', head: 'ימים', kind: 'days' }, { key: 'holidayHours', head: 'שעות', kind: 'hours' }] },
  {
    title: 'תשלומים (₪)',
    cols: [
      { key: 'travel', head: 'נסיעות', kind: 'money' },
      { key: 'advance', head: 'מקדמות', kind: 'money' },
      { key: 'bonus', head: 'בונוסים', kind: 'money' },
      { key: 'recupFlag', head: 'הבראה', kind: 'flag' },
    ],
  },
];

/** Optional groups added as columns while the A4 width allows (in this order); otherwise printed under the row. */
const OPTIONAL: Group[] = [
  { title: 'מילואים', optional: true, cols: [{ key: 'reserveDays', head: 'ימים', kind: 'days' }, { key: 'reserveHours', head: 'שעות', kind: 'hours' }] },
  { title: 'תשלומים נוספים (₪)', optional: true, cols: [{ key: 'recupAmount', head: 'דמי הבראה', kind: 'money' }, { key: 'reserveMoney', head: 'מילואים', kind: 'money' }, { key: 'otherMoney', head: 'תוספות', kind: 'money' }, { key: 'deduction', head: 'ניכוי מאושר', kind: 'money' }] },
];

/** Keys printed inside another cell (never as their own column). */
const INLINE = new Set(['sickPaidDays']);
const ATTENDANCE_SECTIONS = new Set(['days', 'hours']);

export interface PrintLayout {
  groups: Group[];
  /** Report columns printed on the line under the row (label + value). */
  extras: PeColumn[];
  widthMm: number;
}

/** Chooses the columns: fixed payroll columns, then optional groups while they fit A4; the rest go under the row. */
export function printLayout(report: PayrollEntryReport): PrintLayout {
  const present = new Set(report.columns.map((c) => c.key));
  const width = (g: Group) => g.cols.reduce((a, c) => a + colWidth(c), 0);
  const groups: Group[] = [];
  for (const g of MAIN) {
    const cols = g.cols.filter((c) => present.has(c.key) || (!g.optional && c.kind !== 'money' && c.kind !== 'flag'));
    if (cols.length) groups.push({ ...g, cols });
  }
  let used = WIDTH_MM.name + groups.reduce((a, g) => a + width(g), 0);
  for (const g of OPTIONAL) {
    const cols = g.cols.filter((c) => present.has(c.key));
    if (!cols.length) continue;
    const add = { ...g, cols };
    if (used + width(add) <= PAGE_WIDTH_MM) {
      groups.splice(groups.length - (g.title === 'מילואים' ? 1 : 0), 0, add);
      used += width(add);
    }
  }
  const inTable = new Set(groups.flatMap((g) => g.cols.map((c) => c.key)));
  const extras = report.columns.filter((c) => !inTable.has(c.key) && !INLINE.has(c.key));
  return { groups, extras, widthMm: used };
}

function valueClass(val: PeValue | undefined, zero: boolean) {
  if (val && val.status !== 'ok') return 'pe-flagged';
  return zero ? 'pe-zero' : '';
}

function Cell({ col, val, sickPaid, total = false, gs = false }: { col: Col; val: PeValue | undefined; sickPaid?: PeValue; total?: boolean; gs?: boolean }) {
  const t = col.kind === 'flag' && total ? { main: `${val?.v ?? 0} כן`, sub: null, zero: !val?.v } : cellText(col.kind, val);
  // Totals are not marked per column; the totals name cell states once that they include values under review.
  const flagged = !total && !!val && val.status !== 'ok';
  const showPaid = col.key === 'sickDays' && !!sickPaid && !!val?.v && sickPaid.v !== null;
  return (
    <td className={`pe-v pe-${col.kind} ${total ? (t.zero ? 'pe-zero' : '') : valueClass(val, t.zero)}${gs ? ' pe-gs' : ''}`} data-col={col.key} data-status={val?.status ?? 'ok'}>
      <div className="pe-main">
        {t.main}
        {flagged && <span className="pe-mark">*</span>}
      </div>
      {t.sub && <div className="pe-sub">{t.sub}</div>}
      {showPaid && <div className="pe-sub">משולם {daysText(sickPaid.v!)}</div>}
    </td>
  );
}

function extraText(c: PeColumn, val: PeValue | undefined, total = false): string | null {
  if (!val || val.v === 0) return null; // zeros are not listed under the row
  if (val.v === null) return `${c.label}: ${val.status === 'missing' ? 'לא הוגדר' : 'לבדיקה'}`;
  const mark = !total && val.status !== 'ok' ? '*' : '';
  if (c.kind === 'hours') return `${c.label}: ${decimalHours(val.v)} (${hhmm(val.v)})${mark}`;
  if (c.kind === 'days') return `${c.label}: ${daysText(val.v)}${mark}`;
  if (c.kind === 'money') return `${c.label}: ₪${moneyText(val.v)}${mark}`;
  return `${c.label}: ${val.v ? 'כן' : 'לא'}`;
}

export function PayrollEntryPrint({
  report,
  businessName,
  period,
  monthState,
  generatedAt,
  footer,
}: {
  report: PayrollEntryReport;
  businessName: string;
  period: string;
  /** e.g. "סופי – החודש נסגר" / "טיוטה – החודש פתוח לעריכה". */
  monthState: { final: boolean; text: string };
  generatedAt: string;
  footer: string;
}) {
  const layout = printLayout(report);
  const cols = layout.groups.flatMap((g) => g.cols);
  const groupStart = new Set(layout.groups.map((g) => g.cols[0].key));
  const attendanceCols = cols.filter((c) => ATTENDANCE_SECTIONS.has(report.columns.find((x) => x.key === c.key)?.section ?? 'days')).length;
  const counts = { review: 0, missing: 0, empty: 0, ready: 0 };
  for (const r of report.rows) counts[r.state]++;
  const notReady = report.rows.length - counts.ready;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const running = `${report.title} · ${businessName} · ${period}`;
  // Page margin boxes: page number on every page; a slim running header from page 2. Empty boxes replace the
  // browser's own header/footer text (date, window title, address) where the print engine honours them.
  const pageCss = `@media print {
  @page { margin: 9mm 8mm 10mm;
    @top-right { content: "${esc(running)}"; font: 7.5pt Heebo, sans-serif; color: #333; direction: rtl; }
    @top-left { content: "${esc(monthState.final ? 'סופי' : 'טיוטה')}"; font: 7.5pt Heebo, sans-serif; color: #333; }
    @top-center { content: ""; }
    @bottom-left { content: "עמוד " counter(page) " מתוך " counter(pages); font: 7.5pt Heebo, sans-serif; color: #333; }
    @bottom-right { content: "${esc(`הופק ${generatedAt}`)}"; font: 7pt Heebo, sans-serif; color: #555; direction: rtl; }
    @bottom-center { content: ""; }
  }
  @page :first { @top-right { content: ""; } @top-left { content: ""; } }
}`;

  const rowExtras = (r: PeRow) => layout.extras.map((c) => extraText(c, r.values[c.key])).filter((x): x is string => !!x);
  const totalExtras = layout.extras.map((c) => extraText(c, report.totals[c.key], true)).filter((x): x is string => !!x);

  return (
    <div className="print-only pe-report" dir="rtl" data-testid="payroll-entry-report">
      <style>{pageCss}</style>
      <header className="pe-header">
        <div>
          <h1 data-testid="pe-title">{report.title}</h1>
          <div className="pe-meta">
            <b>{businessName}</b>
            <span>{period}</span>
            <span>{report.rows.length} עובדים</span>
            {notReady > 0 && (
              <span className="pe-meta-alert">
                {[counts.review && `${counts.review} לבדיקה`, counts.missing && `${counts.missing} עם נתונים חסרים`, counts.empty && `${counts.empty} ללא רישומים`].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
        </div>
        <div className={`pe-state${monthState.final ? '' : ' pe-state-draft'}`} data-testid="pe-month-state">
          {monthState.text}
        </div>
      </header>
      <div className="pe-legend">שעות: מספר עשרוני לקליטה, ש:דד מתחתיו · 0 = אפס · * = לבדיקה, אינו סופי · ימים בימים, סכומים ב-₪</div>

      <table className="pe-table" data-testid="pe-table" data-width-mm={Math.round(layout.widthMm)}>
        <colgroup>
          <col style={{ width: `${WIDTH_MM.name}mm` }} />
          {cols.map((c) => (
            <col key={c.key} style={{ width: `${colWidth(c)}mm` }} />
          ))}
        </colgroup>
        <thead>
          <tr className="pe-groups">
            <th rowSpan={2} className="pe-name-h">
              עובד
              <div className="pe-sub-h">מס׳ עובד · סטטוס</div>
            </th>
            {layout.groups.map((g) => (
              <th key={g.title} colSpan={g.cols.length} className="pe-group">
                {g.title}
              </th>
            ))}
          </tr>
          <tr className="pe-cols">
            {layout.groups.map((g) =>
              g.cols.map((c, i) => (
                <th key={c.key} data-col={c.key} className={i === 0 ? 'pe-gs' : ''}>
                  {c.head}
                  {c.sub && <div className="pe-sub-h">{c.sub}</div>}
                </th>
              )),
            )}
          </tr>
        </thead>
        {report.rows.map((r, ri) => {
          const extras = rowExtras(r);
          const notes = r.state === 'empty' ? r.issues.filter((x) => x !== NO_RECORDS_TEXT) : r.issues;
          const below = [...extras, ...(notes.length ? [`לבדיקה: ${notes.join(' · ')}`] : [])];
          return (
            <tbody key={r.employeeId} className={`pe-emp${ri % 2 ? ' pe-odd' : ''}`} data-testid="pe-row" data-state={r.state}>
              <tr>
                <td className="pe-name">
                  <div className="pe-name-main">{r.name}</div>
                  <div className="pe-name-sub">
                    <span className="pe-num">{r.number || '—'}</span>
                    <span className={`pe-state-tag pe-state-${r.state}`}>{ROW_STATE_LABELS[r.state]}</span>
                  </div>
                </td>
                {r.state === 'empty' ? (
                  <>
                    <td colSpan={attendanceCols} className="pe-empty">
                      {NO_RECORDS_TEXT}
                    </td>
                    {cols.slice(attendanceCols).map((c) => (
                      <Cell key={c.key} col={c} val={r.values[c.key]} gs={groupStart.has(c.key)} />
                    ))}
                  </>
                ) : (
                  layout.groups.map((g) => g.cols.map((c, i) => <Cell key={c.key} col={c} val={r.values[c.key]} sickPaid={r.values.sickPaidDays} gs={i === 0} />))
                )}
              </tr>
              {below.length > 0 && (
                <tr className="pe-below">
                  <td />
                  <td colSpan={cols.length}>
                    {below.map((x, i) => (
                      <Fragment key={i}>
                        {i > 0 && <span className="pe-sep"> · </span>}
                        <span className={x.startsWith('לבדיקה:') ? 'pe-issue' : ''}>{x}</span>
                      </Fragment>
                    ))}
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
        <tbody className="pe-total" data-testid="pe-total">
          <tr>
            <td className="pe-name">
              <div className="pe-name-main">סה״כ לעסק</div>
              <div className="pe-name-sub">{notReady ? `${notReady} מתוך ${report.rows.length} אינם מוכנים · כולל ערכים לבדיקה` : `${report.rows.length} עובדים · מוכן`}</div>
            </td>
            {layout.groups.map((g) => g.cols.map((c, i) => <Cell key={c.key} col={c} val={report.totals[c.key]} sickPaid={report.totals.sickPaidDays} total gs={i === 0} />))}
          </tr>
          {totalExtras.length > 0 && (
            <tr className="pe-below">
              <td />
              <td colSpan={cols.length}>{totalExtras.join(' · ')}</td>
            </tr>
          )}
        </tbody>
      </table>
      <footer className="pe-footer">{footer}</footer>
    </div>
  );
}
