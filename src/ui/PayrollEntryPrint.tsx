/**
 * 1.1.13 — A4 print / PDF: "סיכום חודשי לקליטת שכר".
 *
 * Renders the PayrollEntryReport model only (src/export/payrollEntry.ts) — no calculation happens here. Three
 * clearly separated sections (days · hours · NIS amounts), one row per employee, decimal hours prominent with
 * HH:MM underneath. Wide sections are split into column groups instead of shrinking the text; table headers repeat on
 * every page; totals appear once, at the end of each table.
 */
import { Fragment } from 'react';
import { cellText, flagTotalText, SECTION_TITLES, type PayrollEntryReport, type PeColumn, type PeSection, type PeValue } from '../export/payrollEntry';

/** Data columns per printed table; wider sections continue in another table (same rows) rather than shrinking. */
const MAX_COLS: Record<PeSection, number> = { days: 12, hours: 12, money: 12 };

function chunk<T>(list: T[], n: number): T[][] {
  if (list.length <= n) return [list];
  const parts = Math.ceil(list.length / n);
  const size = Math.ceil(list.length / parts);
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function Cell({ col, val, total = false }: { col: PeColumn; val: PeValue | undefined; total?: boolean }) {
  const t = col.kind === 'flag' && total ? { main: flagTotalText(val), sub: null } : cellText(col.kind, val);
  const flagged = val && val.status !== 'ok';
  return (
    <td className={`pe-num${flagged ? ' pe-flagged' : ''}`} data-col={col.key} data-status={val?.status ?? 'ok'}>
      <div className="pe-main">
        {t.main}
        {flagged && <span className="pe-mark">*</span>}
      </div>
      {t.sub && <div className="pe-sub">{t.sub}</div>}
    </td>
  );
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
  const sections = (['days', 'hours', 'money'] as PeSection[])
    .map((s) => ({ s, cols: report.columns.filter((c) => c.section === s) }))
    .filter((x) => x.cols.length);
  const withIssues = report.rows.filter((r) => r.issues.length);
  const keep = report.rows.length <= 22; // short tables are kept on one page
  let first = true;
  return (
    <div className="print-only pe-report" dir="rtl" data-testid="payroll-entry-report">
      <header className="pe-header">
        <div className="pe-header-main">
          <h1 data-testid="pe-title">{report.title}</h1>
          <div className="pe-meta">
            <span>
              <b>עסק:</b> {businessName}
            </span>
            <span>
              <b>חודש:</b> {period}
            </span>
            <span>
              <b>עובדים:</b> {report.rows.length}
            </span>
            <span>
              <b>הופק:</b> {generatedAt}
            </span>
          </div>
        </div>
        <div className={`pe-state${monthState.final ? '' : ' pe-state-draft'}`} data-testid="pe-month-state">
          {monthState.text}
        </div>
      </header>
      <div className="pe-legend">שעות: המספר העשרוני (למשל 7.60) הוא הערך לקליטה בתוכנת השכר; ש:דד שמתחתיו לבדיקה · – אין ערך · * לבדיקה – אינו ערך סופי</div>

      {sections.map(({ s, cols }) =>
        chunk(cols, MAX_COLS[s]).map((group, gi, groups) => {
          const isFirst = first;
          first = false;
          const caption = `${SECTION_TITLES[s]}${groups.length > 1 ? ` (${gi + 1}/${groups.length})` : ''}`;
          return (
            <section key={`${s}-${gi}`} className={`pe-section${keep ? ' pe-keep' : ''}`} data-testid={`pe-section-${s}`}>
              <table className={`pe-table pe-${s}`}>
                <colgroup>
                  <col className="pe-col-name" />
                  <col className="pe-col-id" />
                  {isFirst && <col className="pe-col-status" />}
                  {group.map((c) => (
                    <col key={c.key} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="pe-running">
                    <th colSpan={group.length + (isFirst ? 3 : 2)}>
                      <span className="pe-running-section">{caption}</span>
                      <span className="pe-running-meta">
                        {report.title} · {businessName} · {period}
                      </span>
                    </th>
                  </tr>
                  <tr className="pe-cols">
                    <th className="pe-name">עובד</th>
                    <th>מס׳ עובד</th>
                    {isFirst && <th>סטטוס</th>}
                    {group.map((c) => (
                      <th key={c.key} className="pe-num" data-col={c.key}>
                        {c.label}
                        {c.kind === 'hours' && <div className="pe-unit">עשרוני · ש:דד</div>}
                        {c.kind === 'money' && <div className="pe-unit">₪</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.employeeId} data-testid="pe-row">
                      <td className="pe-name">{r.name}</td>
                      <td className="pe-id">{r.number || '–'}</td>
                      {isFirst && <td className={`pe-status${r.issues.length ? ' pe-flagged' : ''}`}>{r.issues.length ? 'לבדיקה *' : 'מוכן'}</td>}
                      {group.map((c) => (
                        <Cell key={c.key} col={c} val={r.values[c.key]} />
                      ))}
                    </tr>
                  ))}
                  <tr className="pe-total" data-testid="pe-total">
                    <td className="pe-name">סה״כ לעסק</td>
                    <td />
                    {isFirst && <td className="pe-status">{withIssues.length ? `${withIssues.length} לבדיקה` : 'מוכן'}</td>}
                    {group.map((c) => (
                      <Cell key={c.key} col={c} val={report.totals[c.key]} total />
                    ))}
                  </tr>
                </tbody>
              </table>
            </section>
          );
        }),
      )}

      {withIssues.length > 0 && (
        <section className="pe-issues" data-testid="pe-issues">
          <table className="pe-table pe-issues-table">
            <colgroup>
              <col className="pe-col-name" />
              <col className="pe-col-id" />
              <col />
            </colgroup>
            <thead>
              <tr className="pe-running">
                <th colSpan={3}>
                  <span className="pe-running-section">פריטים לבדיקה לפני קליטה</span>
                  <span className="pe-running-meta">
                    {report.title} · {businessName} · {period}
                  </span>
                </th>
              </tr>
              <tr className="pe-cols">
                <th className="pe-name">עובד</th>
                <th>מס׳ עובד</th>
                <th>מה לבדוק</th>
              </tr>
            </thead>
            <tbody>
              {withIssues.map((r) => (
                <tr key={r.employeeId}>
                  <td className="pe-name">{r.name}</td>
                  <td className="pe-id">{r.number || '–'}</td>
                  <td>
                    {r.issues.map((x, i) => (
                      <Fragment key={i}>
                        {i > 0 && ' · '}
                        {x}
                      </Fragment>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <footer className="pe-footer">{footer}</footer>
    </div>
  );
}
