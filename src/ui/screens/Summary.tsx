import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { dedupeWarnings, premiumMinutes, type BusinessSummary, type BusinessSummaryRow, type PeriodTotals } from '../../engine';
import type { Business, MonthReview } from '../../data/repo';
import { computeBusinessMonth, sha256Hex, snapshotOf, yearMonthKey } from '../../data/service';
import { Crumbs, useApp } from '../App';
import { Badge, Button, Card, Checkbox, PageHeader, severityLabel, severityTone, useUi } from '../components';
import { IconAlert, IconCheck, IconChevronLeft, IconDownload, IconLock, IconPrinter, IconSearch } from '../icons';
import { MonthPicker } from '../MonthPicker';
import { formatDateHe, formatTimestamp, hm, monthTitle, shekels } from '../format';
import { exportBusinessMonth } from '../../export/exporters';
import { issuesText } from '../../export/tables';

type SortKey = 'name' | 'days' | 'regular' | 'ot125' | 'ot150' | 'premium' | 'net';

const sortValue = (r: BusinessSummaryRow, k: SortKey): number | string => {
  const t = r.totals;
  switch (k) {
    case 'name':
      return r.name;
    case 'days':
      return t.daysWorked;
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
  }
};

const REVIEW_LABEL: Record<MonthReview['status'], string> = { open: 'פתוח לעריכה', in_review: 'בבדיקה', final: 'נסגר לאחר בדיקה' };

export function SummaryScreen({ businessId }: { businessId: string }) {
  const { repo, go, ym, setYm, dataVersion } = useApp();
  const ui = useUi();
  const [business, setBusiness] = useState<Business | null>(null);
  const [summary, setSummary] = useState<BusinessSummary | null>(null);
  const [review, setReview] = useState<MonthReview | null>(null);
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ackReview, setAckReview] = useState(false);
  const [ackCompliance, setAckCompliance] = useState(false);

  const key = yearMonthKey(ym.year, ym.month);
  const load = useCallback(async () => {
    const [b, s, rev] = await Promise.all([repo.getBusiness(businessId), computeBusinessMonth(repo, businessId, ym.year, ym.month), repo.getMonthReview(businessId, key)]);
    setBusiness(b);
    setSummary(s);
    setReview(rev);
    setCurrentHash(await sha256Hex(snapshotOf(s)));
    setAckReview(false);
    setAckCompliance(false);
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

  if (!business || !summary || !review) return null;
  const g = summary.grandTotal;
  const gp = premiumMinutes(g.buckets);
  const includePay = summary.rows.some((r) => r.totals.payAgorot !== null);
  const blocking = g.errorCount + g.unconfirmedBreaks;
  const periodReview = summary.rows.reduce((a, r) => a + r.result.warnings.filter((w) => w.severity === 'review').length, 0);
  const openReview = g.reviewCount - g.unconfirmedBreaks;
  const changedSinceFinal = review.status === 'final' && review.snapshotHash !== null && review.snapshotHash !== currentHash;
  const title = `סיכום שעות עובדים - ${monthTitle(ym.year, ym.month)}`;
  const statusLine = `סטטוס חודש: ${REVIEW_LABEL[review.status]}${changedSinceFinal ? ' (הנתונים השתנו מאז הסגירה)' : ''}${blocking ? ` · ${issuesText(g)}` : ''}`;

  const setStatus = async (status: MonthReview['status']) => {
    if (status === 'open' && review.status === 'final') {
      const ok = await ui.confirm({ title: 'פתיחת חודש סגור', message: 'החודש נסגר לאחר בדיקה. לפתוח אותו מחדש לעריכה?', confirmLabel: 'פתיחה מחדש', danger: true });
      if (!ok) return;
    }
    let snap: { json: string; hash: string } | null = null;
    if (status === 'final') {
      const json = snapshotOf(summary);
      snap = { json, hash: await sha256Hex(json) };
      // Safety backup at finalisation.
      await repo.driver.createBackup('finalize').catch(() => undefined);
    }
    await repo.setMonthReview(businessId, key, status, snap);
    ui.toast(status === 'final' ? 'החודש נסגר. נשמרה תמונת מצב וגיבוי.' : `סטטוס החודש: ${REVIEW_LABEL[status]}`);
    load();
  };

  const header = (k: SortKey, label: string, cls = '') => (
    <th className={`px-3 py-2.5 font-medium ${cls}`}>
      <button className={`inline-flex items-center gap-1 hover:text-ink ${sort.key === k ? 'text-ink' : ''}`} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : k === 'name' ? 1 : -1 }))}>
        {label}
        {sort.key === k && <span className="text-[10px]">{sort.dir === 1 ? '▲' : '▼'}</span>}
      </button>
    </th>
  );

  const doExport = (f: 'xlsx' | 'csv') =>
    exportBusinessMonth(f, business, summary, ym, statusLine)
      .then((m) => m && ui.toast(m))
      .catch((e) => ui.toast(String(e), 'error'));

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
            <Button icon={<IconPrinter size={16} />} onClick={() => window.print()} title="להפקת PDF בחרו 'שמירה כ-PDF' בחלון ההדפסה">
              הדפסה / PDF
            </Button>
            <Button variant="ghost" onClick={() => go({ name: 'employees', businessId })}>
              חזרה לעובדים
            </Button>
          </>
        }
      />
      <div className="print-only mb-3">
        <div className="text-[18px] font-bold">{title}</div>
        <div className="text-[12px]">
          {business.name} · {statusLine}
        </div>
      </div>

      {(blocking > 0 || openReview > 0 || g.complianceCount > 0 || changedSinceFinal) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
          <IconAlert size={18} />
          {changedSinceFinal && <b>הנתונים השתנו לאחר סגירת החודש.</b>}
          <span>
            הדוח כולל: {g.unconfirmedBreaks} הפסקות לא מאושרות · {g.incompleteEntries} רישומים חסרים · {g.errorCount - g.incompleteEntries} שגיאות · {openReview} סימונים לבדיקה · {g.complianceCount} אזהרות ציות.
          </span>
        </div>
      )}

      <Card className="print-full">
        <div className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="relative w-full max-w-sm">
            <IconSearch size={17} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="field-input pr-9" placeholder="חיפוש עובד" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="text-[12px] text-ink-soft">לחיצה על שורה מציגה פירוט שבועי והתראות</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]" data-testid="summary-table">
            <thead>
              <tr className="border-b border-line bg-slate-50/70 text-right text-[12px] text-ink-soft">
                {header('name', 'עובד', 'ps-4')}
                {header('days', 'ימי עבודה')}
                {header('regular', 'שעות רגילות')}
                {header('ot125', 'נוספות 125%')}
                {header('ot150', 'נוספות 150%')}
                {header('premium', 'מנוחה / חג (150·175·200)')}
                {header('net', 'סה״כ שעות נטו')}
                {includePay && <th className="px-3 py-2.5 font-medium">הערכת עלות</th>}
                <th className="px-3 py-2.5 font-medium">פריטים פתוחים</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.employeeId}>
                  <SummaryRow
                    name={r.name}
                    number={r.employeeNumber}
                    t={r.totals}
                    includePay={includePay}
                    expanded={expanded === r.employeeId}
                    onToggle={() => setExpanded(expanded === r.employeeId ? null : r.employeeId)}
                  />
                  {expanded === r.employeeId && (
                    <tr className="bg-slate-50/50">
                      <td colSpan={includePay ? 9 : 8} className="px-6 py-4">
                        <EmployeeDetail row={r} onOpen={() => go({ name: 'attendance', businessId, employeeId: r.employeeId })} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold" data-testid="grand-total">
                <td className="px-4 py-3">סה״כ לעסק ({summary.rows.length} עובדים)</td>
                <td className="num px-3 py-3 text-right">{g.daysWorked}</td>
                <td className="num px-3 py-3 text-right">{hm(g.buckets.regular, '0:00')}</td>
                <td className="num px-3 py-3 text-right">{hm(g.buckets.ot125, '0:00')}</td>
                <td className="num px-3 py-3 text-right">{hm(g.buckets.ot150, '0:00')}</td>
                <td className="num px-3 py-3 text-right">
                  {hm(gp.p150, '0')} · {hm(gp.p175, '0')} · {hm(gp.p200, '0')}
                </td>
                <td className="num px-3 py-3 text-right text-brand">{hm(g.netMinutes, '0:00')}</td>
                {includePay && <td className="num px-3 py-3 text-right">{shekels(g.payAgorot)}</td>}
                <td className="px-3 py-3 text-[12px] font-normal">{issuesText(g) || '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {includePay && <p className="px-4 py-2 text-[12px] text-ink-soft">הערכת העלות מבוססת על שכר שעתי ושיעורי הגמול בלבד. אינה כוללת מס, ביטוח לאומי, פנסיה, חופשה, נסיעות או רכיבי שכר אחרים ואינה תלוש שכר.</p>}
      </Card>

      <Card className="no-print mt-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[15px] font-semibold">
              <IconLock size={18} /> בדיקה וסגירת החודש
              <span data-testid="review-status">
                <Badge tone={review.status === 'final' ? (changedSinceFinal ? 'red' : 'green') : review.status === 'in_review' ? 'blue' : 'slate'}>{REVIEW_LABEL[review.status]}</Badge>
              </span>
            </div>
            {review.finalizedAt && <div className="mt-1 text-[12px] text-ink-soft">נסגר: {formatTimestamp(review.finalizedAt)}</div>}
            <ul className="mt-3 space-y-1 text-[13px]">
              <Check ok={g.incompleteEntries === 0} text={`רישומים חסרים: ${g.incompleteEntries}`} />
              <Check ok={g.errorCount - g.incompleteEntries === 0} text={`שגיאות נתונים: ${g.errorCount - g.incompleteEntries}`} />
              <Check ok={g.unconfirmedBreaks === 0} text={`הפסקות משוערות שלא אושרו: ${g.unconfirmedBreaks}`} />
              <Check ok={openReview === 0 || ackReview} warn text={`סימונים לבדיקה פתוחים (כולל ${periodReview} ברמת עובד): ${openReview}`} />
              <Check ok={g.complianceCount === 0 || ackCompliance} warn text={`אזהרות ציות: ${g.complianceCount}`} />
            </ul>
            <p className="mt-3 max-w-2xl text-[12px] leading-relaxed text-ink-soft">
              סגירת החודש שומרת תמונת מצב של החישוב וגיבוי. היא מאשרת שהנתונים נבדקו – ואינה קביעה שהדוח עומד בכל דרישות הדין. סיווגים הסכמיים, היתרים ועבודה בחג/מנוחה דורשים בדיקה מקצועית.
            </p>
          </div>
          <div className="flex min-w-[280px] flex-col gap-2">
            {review.status !== 'final' && (
              <>
                {openReview > 0 && <Checkbox checked={ackReview} onChange={setAckReview} label="בדקתי את הסימונים לבדיקה והם מטופלים" />}
                {g.complianceCount > 0 && <Checkbox checked={ackCompliance} onChange={setAckCompliance} label="ראיתי את אזהרות הציות" />}
                {review.status === 'open' && <Button onClick={() => setStatus('in_review')}>סימון כ"בבדיקה"</Button>}
                <Button
                  variant="primary"
                  icon={<IconCheck size={16} />}
                  disabled={blocking > 0 || (openReview > 0 && !ackReview) || (g.complianceCount > 0 && !ackCompliance)}
                  onClick={() => setStatus('final')}
                  data-testid="finalize"
                >
                  סגירת החודש לאחר בדיקה
                </Button>
                {blocking > 0 && <span className="text-[12px] text-red-700">לא ניתן לסגור כל עוד קיימים רישומים חסרים, שגיאות או הפסקות לא מאושרות.</span>}
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
      <span className={`flex h-4 w-4 items-center justify-center rounded-full ${ok ? 'bg-emerald-100 text-emerald-700' : warn ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
        {ok ? <IconCheck size={11} /> : '!'}
      </span>
      {text}
    </li>
  );
}

function SummaryRow({ name, number, t, includePay, expanded, onToggle }: { name: string; number: string | null; t: PeriodTotals; includePay: boolean; expanded: boolean; onToggle: () => void }) {
  const p = premiumMinutes(t.buckets);
  const issues = issuesText(t);
  return (
    <tr className={`cursor-pointer border-b border-line/70 hover:bg-slate-50/60 ${expanded ? 'bg-slate-50/60' : ''}`} onClick={onToggle} data-testid="summary-row">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <IconChevronLeft size={15} className={`no-print text-slate-400 transition ${expanded ? '-rotate-90' : ''}`} />
          <span className="font-medium">{name}</span>
          {number && <span className="num text-[12px] text-ink-soft">#{number}</span>}
        </div>
      </td>
      <td className="num px-3 py-3 text-right">{t.daysWorked}</td>
      <td className="num px-3 py-3 text-right">{hm(t.buckets.regular, '0:00')}</td>
      <td className="num px-3 py-3 text-right">{hm(t.buckets.ot125, '0:00')}</td>
      <td className="num px-3 py-3 text-right">{hm(t.buckets.ot150, '0:00')}</td>
      <td className="num px-3 py-3 text-right text-[13px]">{p.total ? `${hm(p.p150, '0')} · ${hm(p.p175, '0')} · ${hm(p.p200, '0')}` : '–'}</td>
      <td className="num px-3 py-3 text-right font-semibold">{hm(t.netMinutes, '0:00')}</td>
      {includePay && <td className="num px-3 py-3 text-right">{shekels(t.payAgorot)}</td>}
      <td className="px-3 py-3">{issues ? <Badge tone={t.errorCount || t.unconfirmedBreaks ? 'red' : 'amber'}>{issues}</Badge> : <Badge tone="green">תקין לבדיקה</Badge>}</td>
    </tr>
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
          שבועות החוצים חודש מחושבים כשבוע שלם; כל משמרת נספרת בחודש של יום תחילתה. ברוטו: {hm(t.grossMinutes, '0:00')} · הפסקות: {hm(t.breakMinutes, '0:00')}
          {t.paidBreakMinutes ? ` · הפסקות בתשלום: ${hm(t.paidBreakMinutes)}` : ''}
          {t.contractExcessMinutes ? ` · שעות עודפות 100%: ${hm(t.contractExcessMinutes)}` : ''}
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
              <Badge tone={severityTone[w.severity]}>{severityLabel[w.severity]}</Badge>
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
