import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { dedupeWarnings, formatDays, formatDecimalHours, premiumMinutes, type AttendanceTotals, type BusinessSummary, type BusinessSummaryRow, type PeriodTotals } from '../../engine';
import type { Business, MonthlyAdjustment, MonthReview } from '../../data/repo';
import { closingRules, computeBusinessFinancials, computeBusinessMonth, sha256Hex, snapshotOf, yearMonthKey } from '../../data/service';
import { shekelsText, type MonthFinancials } from '../../payroll/financials';
import { Crumbs, useApp } from '../App';
import { Badge, Button, Card, Checkbox, DECIMAL_HOURS_LABEL, DECIMAL_HOURS_TITLE, DecimalHours, PageHeader, severityLabel, severityTone, WarningTip, useUi } from '../components';
import { IconAlert, IconCheck, IconChevronLeft, IconDownload, IconLock, IconPrinter, IconSearch } from '../icons';
import { MonthPicker } from '../MonthPicker';
import { formatDateHe, formatTimestamp, hm, monthTitle, shekels } from '../format';
import { exportBusinessMonth } from '../../export/exporters';
import { COPYRIGHT } from '../../licensing/CopyrightFooter';
import { issuesText } from '../../export/tables';
import { buildPayrollEntryReport } from '../../export/payrollEntry';
import { PayrollEntryPrint } from '../PayrollEntryPrint';

type SortKey = 'name' | 'regular' | 'ot125' | 'ot150' | 'premium' | 'net' | 'aDays' | 'pDays' | 'aHours' | 'pHours' | 'vac' | 'sick' | 'hol';

const sortValue = (r: BusinessSummaryRow, k: SortKey): number | string => {
  const t = r.totals;
  const a = r.result.attendance;
  switch (k) {
    case 'name':
      return r.name;
    case 'regular':
      return t.buckets.regular;
    case 'ot125':
      return t.buckets.ot125;
    case 'ot150':
      return t.buckets.ot150;
    case 'premium':
      return premiumMinutes(t.buckets).total;
    case 'net':
      return t.netMinutes;
    case 'aDays':
      return a.actualWorkedDays;
    case 'pDays':
      return a.paidDayHundredths;
    case 'aHours':
      return a.actualWorkedMinutes;
    case 'pHours':
      return a.payableEquivalentMinutes;
    case 'vac':
      return a.vacationDayHundredths;
    case 'sick':
      return a.sickDayHundredths;
    case 'hol':
      return a.holidayDayHundredths;
  }
};

const REVIEW_LABEL: Record<MonthReview['status'], string> = { open: 'פתוח לעריכה', in_review: 'בבדיקה', final: 'נסגר לאחר בדיקה' };

const cellCls = 'num px-3 py-3 text-right';
const dayCell = (v: number, testid: string, grand: boolean, sub?: string) => (
  <td key={testid} className={cellCls} data-testid={grand ? `grand-${testid}` : testid}>
    {formatDays(v)}
    {sub && <div className="num mt-0.5 text-[11px] font-normal leading-tight text-slate-500">{sub}</div>}
  </td>
);
const hourCell = (v: number, testid: string, grand: boolean) => (
  <td key={testid} className={cellCls} data-testid={grand ? `grand-${testid}` : testid}>
    {hm(v, '0:00')}
    <DecimalHours minutes={v} testid={`dec-${testid}`} />
  </td>
);

/** The four payroll-preparation key metrics, in the leading positions (req 12). */
function KeyCells({ a, grand = false }: { a: AttendanceTotals; grand?: boolean }) {
  return (
    <>
      {dayCell(a.actualWorkedDays * 100, 'actual-days', grand)}
      {dayCell(a.paidDayHundredths, 'paid-days', grand)}
      {hourCell(a.actualWorkedMinutes, 'actual-hours', grand)}
      {hourCell(a.payableEquivalentMinutes, 'paid-hours', grand)}
    </>
  );
}

/** Paid-absence day counts (vacation / sickness / holiday). Election days were removed from the summary (req 1). */
function AbsenceDayCells({ a, grand = false }: { a: AttendanceTotals; grand?: boolean }) {
  return (
    <>
      {dayCell(a.vacationDayHundredths, 'vacation-days', grand)}
      {dayCell(a.sickDayHundredths, 'sick-days', grand, a.sickDayHundredths ? `משולם ${formatDays(a.sickPaidDayHundredths)}` : undefined)}
      {dayCell(a.holidayDayHundredths, 'holiday-days', grand)}
    </>
  );
}

export function SummaryScreen({ businessId }: { businessId: string }) {
  const { repo, go, ym, setYm, dataVersion } = useApp();
  const ui = useUi();
  const [business, setBusiness] = useState<Business | null>(null);
  const [summary, setSummary] = useState<BusinessSummary | null>(null);
  const [fin, setFin] = useState<Awaited<ReturnType<typeof computeBusinessFinancials>> | null>(null);
  const [adjustments, setAdjustments] = useState<MonthlyAdjustment[]>([]);
  const [review, setReview] = useState<MonthReview | null>(null);
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ackReview, setAckReview] = useState(false);
  const [ackCompliance, setAckCompliance] = useState(false);
  const [ackAbsence, setAckAbsence] = useState(false);

  const key = yearMonthKey(ym.year, ym.month);
  const load = useCallback(async () => {
    const [b, s, rev, adj] = await Promise.all([repo.getBusiness(businessId), computeBusinessMonth(repo, businessId, ym.year, ym.month), repo.getMonthReview(businessId, key), repo.listAdjustments(businessId, key)]);
    setBusiness(b);
    setSummary(s);
    setFin(await computeBusinessFinancials(repo, businessId, ym.year, ym.month, s));
    setAdjustments(adj);
    setReview(rev);
    setCurrentHash(await sha256Hex(snapshotOf(s)));
    setAckReview(false);
    setAckCompliance(false);
    setAckAbsence(false);
  }, [repo, businessId, ym, key]);

  useEffect(() => {
    load().catch((e) => ui.toast(String(e), 'error'));
  }, [load, dataVersion, ui]);

  const rows = useMemo(() => {
    if (!summary) return [];
    const q = query.trim();
    return summary.rows
      .filter((r) => !q || r.name.includes(q) || (r.employeeNumber ?? '').includes(q))
      .sort((a, b) => {
        const va = sortValue(a, sort.key);
        const vb = sortValue(b, sort.key);
        return (typeof va === 'string' ? va.localeCompare(vb as string, 'he') : va - (vb as number)) * sort.dir;
      });
  }, [summary, query, sort]);

  const payrollEntry = useMemo(() => (summary ? buildPayrollEntryReport(summary, fin) : null), [summary, fin]);

  if (!business || !summary || !review || !payrollEntry) return null;
  const g = summary.grandTotal;
  const gp = premiumMinutes(g.buckets);
  const at = summary.attendanceTotal;
  const editable = review.status !== 'final';
  const includePay = summary.rows.some((r) => r.totals.payAgorot !== null);
  const blocking = g.errorCount + g.unconfirmedBreaks;
  const periodReview = summary.rows.reduce((a, r) => a + r.result.warnings.filter((w) => w.severity === 'review').length, 0);
  const openReview = g.reviewCount - g.unconfirmedBreaks;
  const absenceReview = at.reviewDays;
  const changedSinceFinal = review.status === 'final' && review.snapshotHash !== null && review.snapshotHash !== currentHash;
  const title = `סיכום חודשי - ${monthTitle(ym.year, ym.month)}`;
  const statusLine = `סטטוס: ${REVIEW_LABEL[review.status]}${changedSinceFinal ? ' (הנתונים השתנו מאז הסגירה)' : ''}${blocking ? ` · ${issuesText(g)}` : ''}`;

  // --- inline payroll editing (req 2) -------------------------------------------------------------
  const canonicalId = (employeeId: string, category: 'advance' | 'bonus') => `inline:${category}:${employeeId}:${key}`;
  const catAdjustments = (employeeId: string, category: 'advance' | 'bonus') => adjustments.filter((x) => x.employeeId === employeeId && x.category === category);
  const inlineCell = (employeeId: string, category: 'advance' | 'bonus') => {
    const list = catAdjustments(employeeId, category);
    const id = canonicalId(employeeId, category);
    const others = list.filter((x) => x.id !== id);
    const total = list.reduce((s, x) => s + x.amountAgorot, 0);
    const own = list.find((x) => x.id === id)?.amountAgorot ?? 0;
    return { total, own, editable: editable && others.length === 0, hasDetails: others.length > 0 };
  };
  const saveAmount = async (employeeId: string, category: 'advance' | 'bonus', agorot: number) => {
    const id = canonicalId(employeeId, category);
    try {
      if (agorot > 0) await repo.saveAdjustment({ id, businessId, employeeId, yearMonth: key, category, amountAgorot: agorot, date: null, description: 'הוזן בסיכום החודשי', details: {} });
      else if (adjustments.some((x) => x.id === id)) await repo.deleteAdjustment(businessId, id);
      else return;
      await load();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  const setRecuperation = async (employeeId: string, due: boolean) => {
    try {
      const data = await repo.getEmployeeMonth(businessId, employeeId, key);
      await repo.setEmployeeMonth(businessId, employeeId, key, { ...data, recuperationDue: due });
      await load();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const setStatus = async (status: MonthReview['status']) => {
    if (status === 'open' && review.status === 'final') {
      const ok = await ui.confirm({ title: 'פתיחת חודש סגור', message: 'לפתוח את החודש מחדש לעריכה?', confirmLabel: 'פתיחה מחדש', danger: true });
      if (!ok) return;
    }
    let snap: { json: string; hash: string } | null = null;
    if (status === 'final') {
      const json = snapshotOf(summary);
      snap = { json, hash: await sha256Hex(json) };
      await repo.driver.createBackup('finalize').catch(() => undefined);
    }
    await repo.setMonthReview(businessId, key, status, snap, null, status === 'final' ? await closingRules(repo, businessId, ym.year, ym.month) : null);
    ui.toast(status === 'final' ? 'החודש נסגר. נשמרה תמונת מצב וגיבוי.' : `סטטוס: ${REVIEW_LABEL[status]}`);
    load();
  };

  const header = (k: SortKey, label: string, cls = '', tip?: string) => (
    <th className={`whitespace-nowrap px-3 py-2.5 font-medium ${cls}`} title={tip}>
      <button className={`inline-flex items-center gap-1 hover:text-ink ${sort.key === k ? 'text-ink' : ''}`} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : k === 'name' ? 1 : -1 }))}>
        {label}
        {sort.key === k && <span className="text-[10px]">{sort.dir === 1 ? '▲' : '▼'}</span>}
      </button>
    </th>
  );
  const payHeader = (label: string, lead = false, tip?: string) => (
    <th key={label} className={`whitespace-nowrap px-3 py-2.5 font-medium ${lead ? 'border-s border-line' : ''}`} title={tip}>
      {label}
    </th>
  );

  const doExport = (f: 'xlsx' | 'csv') =>
    exportBusinessMonth(f, business, summary, ym, statusLine, fin, adjustments)
      .then((m) => m && ui.toast(m))
      .catch((e) => ui.toast(String(e), 'error'));

  const colCount = 10 + 3 + 6 + (includePay ? 1 : 0) + 1; // key(4)+hours(5)+net already in 10; see render

  return (
    <div>
      <PageHeader
        breadcrumbs={
          <Crumbs
            items={[
              { label: 'עסקים', onClick: () => go({ name: 'businesses' }) },
              { label: business.name, onClick: () => go({ name: 'employees', businessId }) },
              { label: 'סיכום חודשי' },
            ]}
          />
        }
        title={title}
        subtitle={business.name}
        actions={
          <>
            <MonthPicker value={ym} onChange={setYm} />
            <Button icon={<IconDownload size={16} />} onClick={() => doExport('xlsx')}>
              Excel
            </Button>
            <Button icon={<IconDownload size={16} />} onClick={() => doExport('csv')}>
              CSV
            </Button>
            <Button icon={<IconPrinter size={16} />} onClick={() => window.print()} title="בחלון ההדפסה אפשר לשמור כ-PDF">
              הדפסה / PDF
            </Button>
            <Button variant="ghost" onClick={() => go({ name: 'employees', businessId })}>
              חזרה לעובדים
            </Button>
          </>
        }
      />
      {(blocking > 0 || openReview > 0 || g.complianceCount > 0 || absenceReview > 0 || changedSinceFinal) && (
        <div className="no-print mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
          <IconAlert size={18} />
          {changedSinceFinal && <b>הנתונים השתנו לאחר סגירת החודש.</b>}
          <span>
            {g.unconfirmedBreaks} הפסקות לא מאושרות · {g.incompleteEntries} רישומים חסרים · {g.errorCount - g.incompleteEntries} שגיאות · {openReview} לבדיקה · {g.complianceCount} אזהרות ציות{absenceReview > 0 ? ` · ${absenceReview} ימי היעדרות לבדיקה` : ''}
          </span>
        </div>
      )}

      <Card className="print-full">
        <div className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="relative w-full max-w-sm">
            <IconSearch size={17} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="field-input pr-9" placeholder="חיפוש עובד" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="flex items-center gap-4 text-[12px] text-ink-soft">
            <span data-testid="decimal-legend" title={DECIMAL_HOURS_TITLE}>
              בתא שעות: ש:דד · <span className="text-slate-500">{DECIMAL_HOURS_LABEL}</span>
            </span>
            <span>מקדמות ובונוסים ב-₪ · הבראה: כן/לא · לחיצה על שורה מציגה פירוט</span>
          </div>
        </div>
        <PayrollEntryPrint
          report={payrollEntry}
          businessName={business.name}
          period={monthTitle(ym.year, ym.month)}
          monthState={
            review.status === 'final'
              ? { final: !changedSinceFinal, text: changedSinceFinal ? 'החודש נסגר – הנתונים השתנו מאז הסגירה, יש לבדוק' : `סופי – החודש נסגר${review.finalizedAt ? ` ${formatTimestamp(review.finalizedAt).slice(0, 10)}` : ''}` }
              : { final: false, text: `טיוטה – ${REVIEW_LABEL[review.status]}; הנתונים עשויים להשתנות` }
          }
          generatedAt={formatTimestamp(new Date().toISOString())}
          footer={`מסמך עזר לקליטת שכר – אינו תלוש שכר. הנתונים מחושבים במערכת לפי הגדרות העובד לחודש זה. ${COPYRIGHT}`}
        />
        <div className="overflow-x-auto no-print">
          <table className="w-full min-w-max text-[14px]" data-testid="summary-table">
            <thead>
              <tr className="border-b border-line bg-slate-50/70 text-right text-[12px] text-ink-soft">
                {header('name', 'עובד', 'ps-4')}
                {header('aDays', 'ימים בפועל', '', 'ימים שבהם בוצעה עבודה בפועל')}
                {header('pDays', 'ימים משולמים', '', 'ימי עבודה + ימי היעדרות בתשלום')}
                {header('aHours', 'שעות בפועל', '', 'שעות עבודה נטו בפועל')}
                {header('pHours', 'שעות משולמות', '', 'שעות בפועל + שעות היעדרות בתשלום')}
                {header('regular', 'שעות רגילות', 'border-s border-line')}
                {header('ot125', 'נוספות 125%')}
                {header('ot150', 'נוספות 150%')}
                {header('premium', 'מנוחה / חג', '', '150% · 175% · 200%')}
                {header('net', 'סה״כ נטו')}
                {header('vac', 'ימי חופשה', 'border-s border-line')}
                {header('sick', 'ימי מחלה')}
                {header('hol', 'ימי חג')}
                {payHeader('ערך היעדרויות', true, 'הערכה: שכר שעתי × שעות × שיעור')}
                {payHeader('נסיעות')}
                {payHeader('מקדמות', false, 'ניתן לעריכה – ₪')}
                {payHeader('בונוסים', false, 'ניתן לעריכה – ₪')}
                {payHeader('הבראה', false, 'זכאות להבראה החודש')}
                {payHeader('מילואים')}
                {includePay && payHeader('הערכת עלות', false, 'שכר שעתי × שעות – אומדן בלבד')}
                {payHeader('פריטים פתוחים')}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.employeeId}>
                  <SummaryRow
                    row={r}
                    f={fin?.byEmployee.get(r.employeeId) ?? null}
                    includePay={includePay}
                    expanded={expanded === r.employeeId}
                    onToggle={() => setExpanded(expanded === r.employeeId ? null : r.employeeId)}
                    advance={inlineCell(r.employeeId, 'advance')}
                    bonus={inlineCell(r.employeeId, 'bonus')}
                    onSaveAmount={(cat, agorot) => saveAmount(r.employeeId, cat, agorot)}
                    onSetRecuperation={(due) => setRecuperation(r.employeeId, due)}
                  />
                  {expanded === r.employeeId && (
                    <tr className="bg-slate-50/50">
                      <td colSpan={colCount} className="px-6 py-4">
                        <EmployeeDetail row={r} onOpen={() => go({ name: 'attendance', businessId, employeeId: r.employeeId })} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold" data-testid="grand-total">
                <td className="px-4 py-3">סה״כ ({summary.rows.length} עובדים)</td>
                <KeyCells a={at} grand />
                <td className="num border-s border-line px-3 py-3 text-right">
                  {hm(g.buckets.regular, '0:00')}
                  <DecimalHours minutes={g.buckets.regular} testid="dec-regular" />
                </td>
                <td className="num px-3 py-3 text-right">
                  {hm(g.buckets.ot125, '0:00')}
                  <DecimalHours minutes={g.buckets.ot125} testid="dec-125" />
                </td>
                <td className="num px-3 py-3 text-right">
                  {hm(g.buckets.ot150, '0:00')}
                  <DecimalHours minutes={g.buckets.ot150} testid="dec-150" />
                </td>
                <td className="num px-3 py-3 text-right">
                  {hm(gp.p150, '0')} · {hm(gp.p175, '0')} · {hm(gp.p200, '0')}
                  <DecimalTriple a={gp.p150} b={gp.p175} c={gp.p200} />
                </td>
                <td className="num px-3 py-3 text-right text-brand">
                  {hm(g.netMinutes, '0:00')}
                  <DecimalHours minutes={g.netMinutes} testid="dec-net" />
                </td>
                <AbsenceDayCells a={at} grand />
                <td className="num border-s border-line px-3 py-3 text-right" data-testid="grand-pay-absence">
                  {fin ? shekelsText(fin.totals.absenceEstimateAgorot) : '—'}
                </td>
                <td className="num px-3 py-3 text-right" data-testid="grand-pay-travel">
                  {fin ? shekelsText(fin.totals.travelAgorot) : '—'}
                </td>
                <td className="num px-3 py-3 text-right" data-testid="grand-pay-advance">
                  {fin ? shekelsText(fin.totals.byCategory.advance) : '—'}
                </td>
                <td className="num px-3 py-3 text-right" data-testid="grand-pay-bonus">
                  {fin ? shekelsText(fin.totals.byCategory.bonus) : '—'}
                </td>
                <td className="num px-3 py-3 text-right" data-testid="grand-pay-recup">
                  {fin ? [...fin.byEmployee.values()].filter((x) => x.recuperationDue).length || '—' : '—'}
                </td>
                <td className="num px-3 py-3 text-right" data-testid="grand-pay-reserve">
                  {fin ? shekelsText(fin.totals.byCategory.reserve) : '—'}
                </td>
                {includePay && <td className="num px-3 py-3 text-right">{shekels(g.payAgorot)}</td>}
                <td className="px-3 py-3 text-[12px] font-normal">{issuesText(g) || '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="no-print px-4 py-2 text-[12px] text-ink-soft">סכומי ₪ הם להכנת שכר בלבד – אינם תלוש שכר. הערכת העלות מבוססת על שכר שעתי ושיעורי הגמול בלבד (ללא מס, ביטוח לאומי ופנסיה).</p>
      </Card>

      <Card className="no-print mt-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[15px] font-semibold">
              <IconLock size={18} /> סגירת החודש
              <span data-testid="review-status">
                <Badge tone={review.status === 'final' ? (changedSinceFinal ? 'red' : 'green') : review.status === 'in_review' ? 'blue' : 'slate'}>{REVIEW_LABEL[review.status]}</Badge>
              </span>
            </div>
            {review.finalizedAt && <div className="mt-1 text-[12px] text-ink-soft">נסגר: {formatTimestamp(review.finalizedAt)}</div>}
            <ul className="mt-3 space-y-1 text-[13px]">
              <Check ok={g.incompleteEntries === 0} text={`רישומים חסרים: ${g.incompleteEntries}`} />
              <Check ok={g.errorCount - g.incompleteEntries === 0} text={`שגיאות נתונים: ${g.errorCount - g.incompleteEntries}`} />
              <Check ok={g.unconfirmedBreaks === 0} text={`הפסקות משוערות שלא אושרו: ${g.unconfirmedBreaks}`} />
              <Check ok={openReview === 0 || ackReview} warn text={`סימונים לבדיקה (כולל ${periodReview} ברמת עובד): ${openReview}`} />
              <Check ok={g.complianceCount === 0 || ackCompliance} warn text={`אזהרות ציות: ${g.complianceCount}`} />
              <Check ok={absenceReview === 0 || ackAbsence} warn text={`ימי היעדרות לבדיקה: ${absenceReview}`} />
            </ul>
            <p className="mt-3 max-w-2xl text-[12px] leading-relaxed text-ink-soft">סגירת החודש שומרת תמונת מצב וגיבוי ומסמנת שהנתונים נבדקו. אינה קביעה משפטית — סיווגים הסכמיים ועבודה בחג/מנוחה דורשים בדיקה מקצועית.</p>
          </div>
          <div className="flex min-w-[280px] flex-col gap-2">
            {review.status !== 'final' && (
              <>
                {openReview > 0 && <Checkbox checked={ackReview} onChange={setAckReview} label="בדקתי את הסימונים לבדיקה" />}
                {g.complianceCount > 0 && <Checkbox checked={ackCompliance} onChange={setAckCompliance} label="ראיתי את אזהרות הציות" />}
                {absenceReview > 0 && <Checkbox checked={ackAbsence} onChange={setAckAbsence} label="בדקתי את ימי ההיעדרות המסומנים" />}
                {review.status === 'open' && <Button onClick={() => setStatus('in_review')}>סימון כ"בבדיקה"</Button>}
                <Button
                  variant="primary"
                  icon={<IconCheck size={16} />}
                  disabled={blocking > 0 || (openReview > 0 && !ackReview) || (g.complianceCount > 0 && !ackCompliance) || (absenceReview > 0 && !ackAbsence)}
                  onClick={() => setStatus('final')}
                  data-testid="finalize"
                >
                  סגירת החודש
                </Button>
                {blocking > 0 && <span className="text-[12px] text-red-700">לא ניתן לסגור כל עוד יש רישומים חסרים, שגיאות או הפסקות לא מאושרות.</span>}
              </>
            )}
            {review.status === 'final' && (
              <Button onClick={() => setStatus('open')} variant={changedSinceFinal ? 'primary' : 'secondary'}>
                פתיחה מחדש לעריכה
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function Check({ ok, text, warn }: { ok: boolean; text: string; warn?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`flex h-4 w-4 items-center justify-center rounded-full ${ok ? 'bg-emerald-100 text-emerald-700' : warn ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{ok ? <IconCheck size={11} /> : '!'}</span>
      {text}
    </li>
  );
}

type InlineInfo = { total: number; own: number; editable: boolean; hasDetails: boolean };

function SummaryRow({
  row,
  f,
  includePay,
  expanded,
  onToggle,
  advance,
  bonus,
  onSaveAmount,
  onSetRecuperation,
}: {
  row: BusinessSummaryRow;
  f: MonthFinancials | null;
  includePay: boolean;
  expanded: boolean;
  onToggle: () => void;
  advance: InlineInfo;
  bonus: InlineInfo;
  onSaveAmount: (cat: 'advance' | 'bonus', agorot: number) => void;
  onSetRecuperation: (due: boolean) => void;
}) {
  const t = row.totals as PeriodTotals;
  const a = row.result.attendance;
  const p = premiumMinutes(t.buckets);
  const issues = [issuesText(t), a.reviewDays ? `${a.reviewDays} ימי היעדרות לבדיקה` : ''].filter(Boolean).join(', ');
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <tr className={`border-b border-line/70 hover:bg-slate-50/60 ${expanded ? 'bg-slate-50/60' : ''}`} data-testid="summary-row">
      <td className="cursor-pointer px-4 py-3" onClick={onToggle}>
        <div className="flex items-center gap-2">
          <IconChevronLeft size={15} className={`no-print text-slate-400 transition ${expanded ? '-rotate-90' : ''}`} />
          <span className="font-medium">{row.name}</span>
          {row.employeeNumber && <span className="num text-[12px] text-ink-soft">#{row.employeeNumber}</span>}
        </div>
      </td>
      <KeyCells a={a} />
      <td className="num border-s border-line px-3 py-3 text-right">
        {hm(t.buckets.regular, '0:00')}
        <DecimalHours minutes={t.buckets.regular} testid="dec-regular" />
      </td>
      <td className="num px-3 py-3 text-right">
        {hm(t.buckets.ot125, '0:00')}
        <DecimalHours minutes={t.buckets.ot125} testid="dec-125" />
      </td>
      <td className="num px-3 py-3 text-right">
        {hm(t.buckets.ot150, '0:00')}
        <DecimalHours minutes={t.buckets.ot150} testid="dec-150" />
      </td>
      <td className="num px-3 py-3 text-right text-[13px]">
        {p.total ? (
          <>
            {`${hm(p.p150, '0')} · ${hm(p.p175, '0')} · ${hm(p.p200, '0')}`}
            <DecimalTriple a={p.p150} b={p.p175} c={p.p200} />
          </>
        ) : (
          '–'
        )}
      </td>
      <td className="num px-3 py-3 text-right font-semibold">
        {hm(t.netMinutes, '0:00')}
        <DecimalHours minutes={t.netMinutes} testid="dec-net" />
      </td>
      <AbsenceDayCells a={a} />
      <td className="num border-s border-line px-3 py-3 text-right text-[13px]">{f && f.absenceEstimateAgorot ? shekelsText(f.absenceEstimateAgorot) : '–'}</td>
      <td className="num px-3 py-3 text-right text-[13px]">{f && f.travel.totalAgorot ? shekelsText(f.travel.totalAgorot) : '–'}</td>
      <td className="px-2 py-2" onClick={stop} data-testid="cell-advance">
        <MoneyCell info={advance} onSave={(v) => onSaveAmount('advance', v)} />
      </td>
      <td className="px-2 py-2" onClick={stop} data-testid="cell-bonus">
        <MoneyCell info={bonus} onSave={(v) => onSaveAmount('bonus', v)} />
      </td>
      <td className="px-2 py-2 text-center" onClick={stop} data-testid="cell-recup">
        <select
          className="field-input num !w-16 px-1 py-1 text-center text-[13px]"
          value={f?.recuperationDue ? 'yes' : 'no'}
          onChange={(e) => onSetRecuperation(e.target.value === 'yes')}
          aria-label={`הבראה ${row.name}`}
        >
          <option value="no">לא</option>
          <option value="yes">כן</option>
        </select>
      </td>
      <td className="num px-3 py-3 text-right text-[13px]">{f && f.byCategory.reserve ? shekelsText(f.byCategory.reserve) : '–'}</td>
      {includePay && <td className="num px-3 py-3 text-right">{shekels(t.payAgorot)}</td>}
      <td className="cursor-pointer px-3 py-3" onClick={onToggle}>
        {issues ? <Badge tone={t.errorCount || t.unconfirmedBreaks ? 'red' : 'amber'}>{issues}</Badge> : <Badge tone="green">תקין לבדיקה</Badge>}
      </td>
    </tr>
  );
}

/** Editable NIS cell (advances / bonuses). Read-only total when detailed entries exist or the month is closed. */
function MoneyCell({ info, onSave }: { info: InlineInfo; onSave: (agorot: number) => void }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const display = info.total ? (info.total / 100).toFixed(2) : '';
  if (!info.editable) {
    return (
      <div className="num px-1 text-right text-[13px]" title={info.hasDetails ? 'קיימים רכיבים מפורטים – עריכה בדוח השעות של העובד' : 'חודש סגור'}>
        {info.total ? shekelsText(info.total) : '–'}
        {info.hasDetails && <span className="ms-1 text-[10px] text-amber-700">✎</span>}
      </div>
    );
  }
  return (
    <input
      className="field-input num !w-24 px-2 py-1 text-left text-[13px]"
      inputMode="decimal"
      placeholder="₪0"
      value={editing ? text : display}
      aria-label="סכום"
      onFocus={(e) => {
        setEditing(true);
        setText(display);
        e.currentTarget.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const t = text.trim().replace(/[₪,\s]/g, '');
        if (t === display) return;
        if (t === '') return onSave(0);
        const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t);
        if (m) onSave(+m[1] * 100 + (m[2] ? +m[2].padEnd(2, '0') : 0));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(display);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function EmployeeDetail({ row, onOpen }: { row: BusinessSummaryRow; onOpen: () => void }) {
  const r = row.result;
  const t = r.totals;
  const warnings = dedupeWarnings([...r.warnings, ...r.days.flatMap((d) => d.warnings)]).filter((w) => !w.acknowledged);
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div>
        <div className="mb-2 text-[13px] font-semibold">פירוט שבועי</div>
        <table className="w-full text-[13px]">
          <thead className="text-right text-ink-soft">
            <tr>
              <th className="py-1 font-medium">שבוע</th>
              <th className="py-1 font-medium">נטו</th>
              <th className="py-1 font-medium">רגילות במכסה</th>
              <th className="py-1 font-medium">נוספות יומיות</th>
              <th className="py-1 font-medium">נוספות שבועיות</th>
            </tr>
          </thead>
          <tbody>
            {r.weeks.map((w) => (
              <tr key={w.weekStart} className="border-t border-line/60">
                <td className="num py-1 text-right">
                  {formatDateHe(w.weekStart).slice(0, 5)}–{formatDateHe(w.weekEnd).slice(0, 5)}
                </td>
                <td className="num py-1 text-right">{hm(w.netMinutes)}</td>
                <td className="num py-1 text-right">{hm(w.regularCountedMinutes)}</td>
                <td className="num py-1 text-right">{hm(w.dailyOvertimeMinutes)}</td>
                <td className="num py-1 text-right">{hm(w.weeklyOvertimeMinutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[12px] text-ink-soft">
          ברוטו {hm(t.grossMinutes, '0:00')} · הפסקות {hm(t.breakMinutes, '0:00')}
          {t.paidBreakMinutes ? ` · בתשלום ${hm(t.paidBreakMinutes)}` : ''}
          {t.contractExcessMinutes ? ` · עודפות 100% ${hm(t.contractExcessMinutes)}` : ''}
        </p>
        <Button size="sm" variant="primary" className="mt-3" onClick={onOpen}>
          פתיחת דוח השעות
        </Button>
      </div>
      <div>
        <div className="mb-2 text-[13px] font-semibold">התראות פתוחות ({warnings.length})</div>
        <ul className="max-h-64 space-y-1 overflow-y-auto text-[12px]">
          {warnings.length === 0 && <li className="text-ink-soft">אין התראות פתוחות</li>}
          {warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <WarningTip warning={w} name={row.name}>
                <Badge tone={severityTone[w.severity]}>{severityLabel[w.severity]}</Badge>
              </WarningTip>
              <span>
                {w.date && <span className="num ml-1.5 text-ink-soft">{formatDateHe(w.date).slice(0, 5)}</span>}
                {w.message}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DecimalTriple({ a, b, c }: { a: number; b: number; c: number }) {
  return (
    <div className="num mt-0.5 text-right text-[11px] font-normal leading-tight text-slate-500" title={DECIMAL_HOURS_TITLE} data-testid="dec-premium">
      {formatDecimalHours(a)} · {formatDecimalHours(b)} · {formatDecimalHours(c)}
    </div>
  );
}
