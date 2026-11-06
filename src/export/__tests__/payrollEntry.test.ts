/**
 * 1.1.13 — "סיכום חודשי לקליטת שכר": decimal hours, rounding of accumulated totals, overtime and absence categories,
 * empty / unverified values, and consistency with the monthly summary export (same engine results, no recalculation).
 */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver } from '../../data/sqljsDriver';
import { Repository } from '../../data/repo';
import { computeBusinessFinancials, computeBusinessMonth, yearMonthKey } from '../../data/service';
import { defaultEmployeeSettings, premiumMinutes, type ShiftInput } from '../../engine';
import { buildTimestamps } from '../../ui/timeEntry';
import { buildPayrollEntryReport, cellText, decimalHours, decimalHoursNumber, hhmm, PAYROLL_ENTRY_TITLE } from '../payrollEntry';
import { businessMonthTable, payrollEntryTable, type Cell } from '../tables';
import { tableToCsv } from '../exporters';

const SQL = await initSqlJs();
async function open() {
  const r = new Repository(await SqlJsDriver.open(SQL, null));
  await r.migrate();
  return r;
}
const shift = (date: string, start: string, end: string | null, breakMinutes = 0): ShiftInput => {
  const ts = buildTimestamps(date, start, end ?? start);
  return { id: crypto.randomUUID(), workDate: date, startAt: ts.startAt, endAt: end ? ts.endAt : null, breakMinutes, breakStart: null, breakConfirmed: true, breakPaid: false, reviewed: false };
};
async function business(repo: Repository, travel = true) {
  const defaults = defaultEmployeeSettings({
    breakMethod: 'manual',
    hourlyRateAgorot: 5000,
    ...(travel ? { travel: { mode: 'daily' as const, amountAgorot: 1500 } } : {}),
  });
  const b = await repo.createBusiness({ name: `עסק ${Math.random()}`, defaults });
  const { fridayOvertimeHistory: _f, weeklyCreditHistory: _w, ...copy } = b.defaults;
  const employee = (fullName: string, employeeNumber: string | null = null) =>
    repo.createEmployee(b.id, { fullName, employeeNumber, settings: { ...copy, absence: { employmentStart: '2024-01-01' } } });
  return { b, employee };
}
async function report(repo: Repository, bId: string) {
  const s = await computeBusinessMonth(repo, bId, 2026, 11);
  const fin = await computeBusinessFinancials(repo, bId, 2026, 11, s);
  return { s, fin, r: buildPayrollEntryReport(s, fin) };
}

describe('decimal hours (total minutes / 60, never HH:MM read as a decimal)', () => {
  it.each([
    [456, '07:36', '7.60'],
    [504, '08:24', '8.40'],
    [691, '11:31', '11.52'],
    [30, '00:30', '0.50'],
    [105, '01:45', '1.75'],
    [10125, '168:45', '168.75'],
  ])('%i minutes = %s = %s', (minutes, hm, dec) => {
    expect(hhmm(minutes)).toBe(hm);
    expect(decimalHours(minutes)).toBe(dec);
    expect(decimalHoursNumber(minutes)).toBe(Number(dec));
    expect(cellText('hours', { v: minutes, status: 'ok' })).toMatchObject({ main: dec, sub: hm });
    // The classic mistake (reading 7:36 as 7.36) never happens.
    expect(decimalHours(minutes)).not.toBe(hm.replace(':', '.').replace(/^0(\d)/, '$1'));
  });

  it('accumulated totals are converted once from precise minutes, not summed from rounded decimals', async () => {
    const repo = await open();
    const { b, employee } = await business(repo);
    // Three employees × 7:20 (440 min = 7.33 each). Sum of rounded = 21.99; precise total 1320 min = 22.00.
    for (const n of ['א', 'ב', 'ג']) {
      const e = await employee(`עובד ${n}`);
      await repo.upsertShift(b.id, e.id, shift('2026-11-02', '08:00', '15:20'));
    }
    const { r } = await report(repo, b.id);
    for (const row of r.rows) expect(cellText('hours', row.values.actualHours).main).toBe('7.33');
    const roundedSum = r.rows.reduce((a, x) => a + Number(decimalHours(x.values.actualHours.v!)), 0);
    expect(roundedSum.toFixed(2)).toBe('21.99');
    expect(r.totals.actualHours.v).toBe(1320);
    expect(cellText('hours', r.totals.actualHours)).toMatchObject({ main: '22.00', sub: '22:00' });
    expect(cellText('hours', r.totals.regular).main).toBe('22.00');
  });
});

describe('payroll-entry report content', () => {
  it('title, identification, overtime and rest-day categories exactly as the engine computed them', async () => {
    const repo = await open();
    const { b, employee } = await business(repo);
    const e = await employee('מיכל כהן', '1042');
    await repo.upsertShift(b.id, e.id, shift('2026-11-02', '07:00', '19:00', 30)); // long day → daily overtime
    await repo.upsertShift(b.id, e.id, shift('2026-11-03', '08:00', '16:30', 30));
    await repo.upsertShift(b.id, e.id, shift('2026-11-07', '09:00', '14:00')); // Saturday → weekly-rest hours
    const { s, r } = await report(repo, b.id);
    expect(r.title).toBe(PAYROLL_ENTRY_TITLE);
    expect(r.rows[0]).toMatchObject({ name: 'מיכל כהן', number: '1042' });
    const t = s.rows[0].totals;
    const v = r.rows[0].values;
    expect(v.regular.v).toBe(t.buckets.regular);
    expect(v.ot125.v).toBe(t.buckets.ot125);
    expect(v.ot150.v).toBe(t.buckets.ot150);
    expect(t.buckets.ot125).toBeGreaterThan(0);
    const p = premiumMinutes(t.buckets);
    expect(v.p150.v).toBe(p.p150);
    expect(p.total).toBeGreaterThan(0);
    // The rest-day column appears only because it has a value; the hour categories add up to the actual hours.
    const keys = r.columns.map((c) => c.key);
    expect(keys.filter((k) => ['p150', 'p175', 'p200'].includes(k)).length).toBeGreaterThan(0);
    const parts = ['regular', 'ot125', 'ot150', 'p150', 'p175', 'p200', 'unclassified'].reduce((a, k) => a + (v[k].v ?? 0), 0);
    expect(parts).toBe(v.actualHours.v);
    // Days remain days, money remains NIS.
    expect(r.columns.find((c) => c.key === 'actualDays')!.kind).toBe('days');
    expect(r.columns.find((c) => c.key === 'travel')!.kind).toBe('money');
    expect(v.actualDays.v).toBe(300);
    expect(v.travel.v).toBe(3 * 1500);
  });

  it('vacation, sickness and holiday: days and payable hours per category; paid = actual + absence (no double count)', async () => {
    const repo = await open();
    const { b, employee } = await business(repo);
    const e = await employee('יוסי לוי', '7');
    await repo.upsertShift(b.id, e.id, shift('2026-11-02', '08:00', '16:30', 30));
    await repo.setDayEntry(b.id, e.id, { date: '2026-11-03', status: 'vacation', note: null });
    for (const d of ['2026-11-09', '2026-11-10', '2026-11-11']) await repo.setDayEntry(b.id, e.id, { date: d, status: 'sick', note: null });
    const { s, r } = await report(repo, b.id);
    const a = s.rows[0].result.attendance;
    const v = r.rows[0].values;
    expect(v.vacationDays.v).toBe(a.vacationDayHundredths);
    expect(v.vacationDays.v).toBe(100);
    expect(v.sickDays.v).toBe(a.sickDayHundredths);
    expect(v.sickDays.v).toBe(300);
    expect(v.sickPaidDays.v).toBe(a.sickPaidDayHundredths);
    expect(v.sickPaidDays.v).toBeLessThan(300); // first sick day unpaid, then partial rate (statutory)
    expect(v.vacationHours.v).toBeGreaterThan(0);
    // Every paid-absence hour sits in exactly one category column.
    const absenceHours = ['vacationHours', 'sickHours', 'holidayHours', 'reserveHours', 'electionHours', 'otherAbsenceHours'].reduce((x, k) => x + (v[k].v ?? 0), 0);
    expect(absenceHours).toBe(a.paidAbsenceEquivalentMinutes);
    expect(v.actualHours.v! + absenceHours).toBe(v.paidHours.v);
    expect(v.paidHours.v).toBe(a.payableEquivalentMinutes);
    expect(r.columns.some((c) => c.key === 'sickPaidDays')).toBe(true);
    expect(r.columns.some((c) => c.key === 'otherAbsenceHours')).toBe(false); // nothing uncategorised here
  });

  it('empty, missing and unverified values are never shown as final figures', async () => {
    const repo = await open();
    const { b, employee } = await business(repo, false); // no travel reimbursement configured
    const empty = await employee('ללא נתונים');
    const partial = await employee('רישום חסר');
    await repo.upsertShift(b.id, partial.id, shift('2026-11-02', '08:00', '16:00', 30));
    await repo.upsertShift(b.id, partial.id, shift('2026-11-03', '08:00', null)); // exit time missing
    const { r } = await report(repo, b.id);
    const E = r.rows.find((x) => x.employeeId === empty.id)!;
    const P = r.rows.find((x) => x.employeeId === partial.id)!;
    // Nothing recorded for the month: never "ready" — state "empty", attendance values not final, reason given.
    expect(E.state).toBe('empty');
    expect(E.values.actualHours).toEqual({ v: 0, status: 'missing' });
    expect(E.values.travel.status).toBe('ok'); // money columns keep their own status
    expect(E.issues).toEqual(['אין רישומי נוכחות או היעדרות לחודש זה']);
    expect(P.state).toBe('missing');
    // Incomplete record: hours flagged "missing", travel not configured → "לא הוגדר", reasons listed.
    expect(P.values.actualHours.status).toBe('missing');
    expect(P.values.regular.status).toBe('missing');
    expect(P.values.paidHours.status).toBe('missing');
    expect(P.values.travel).toEqual({ v: null, status: 'missing' });
    expect(cellText('money', P.values.travel).main).toBe('לא הוגדר');
    expect(P.issues.join(' ')).toContain('רישומים חסרים');
    expect(P.issues.join(' ')).toContain('החזר נסיעות לא הוגדר');
    // The total of a column with an open item is flagged too.
    expect(r.totals.actualHours.status).not.toBe('ok');
    // Payroll entry sheet: status column and the open reasons.
    const tbl = payrollEntryTable('קליטת שכר', r);
    const row = tbl.rows.find((x) => (x[0] as { v: string }).v === 'רישום חסר')!;
    expect((row[2] as { v: string }).v).toBe('חסר');
    expect((row[row.length - 1] as { v: string }).v).toContain('רישומים חסרים');
  });

  it('money: advances, bonuses, recuperation (כן/לא + amount only when recorded), estimates left out', async () => {
    const repo = await open();
    const { b, employee } = await business(repo);
    const e = await employee('נועה');
    const e2 = await employee('רון');
    await repo.upsertShift(b.id, e.id, shift('2026-11-02', '08:00', '16:30', 30));
    const ym = yearMonthKey(2026, 11);
    const adj = (id: string, emp: string, category: 'advance' | 'bonus' | 'recuperation', amountAgorot: number) =>
      repo.saveAdjustment({ id, businessId: b.id, employeeId: emp, yearMonth: ym, category, amountAgorot, date: null, description: null, details: {} });
    await adj('a1', e.id, 'advance', 50000);
    await adj('b1', e.id, 'bonus', 123456);
    await repo.setEmployeeMonth(b.id, e.id, ym, { recuperationDue: true });
    let { r } = await report(repo, b.id);
    const keys = r.columns.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['travel', 'advance', 'bonus', 'recupFlag']));
    expect(keys).not.toContain('recupAmount'); // no amount recorded → no amount column
    expect(keys.join()).not.toMatch(/estimate|cost/i);
    const v = r.rows.find((x) => x.employeeId === e.id)!.values;
    expect(cellText('money', v.advance).main).toBe('500.00');
    expect(cellText('money', v.bonus).main).toBe('1,234.56');
    expect(cellText('flag', v.recupFlag).main).toBe('כן');
    expect(cellText('flag', r.rows.find((x) => x.employeeId === e2.id)!.values.recupFlag).main).toBe('לא');
    expect(r.totals.recupFlag.v).toBe(1);
    expect(r.totals.bonus.v).toBe(123456);
    await adj('r1', e2.id, 'recuperation', 41800);
    ({ r } = await report(repo, b.id));
    expect(r.columns.map((c) => c.key)).toContain('recupAmount');
    expect(r.totals.recupAmount.v).toBe(41800);
  });
});

describe('display: genuine zero vs missing vs awaiting verification', () => {
  it('zero prints "0", a missing setting "לא הוגדר", an undeterminable value "לבדיקה"; days without needless decimals', () => {
    expect(cellText('hours', { v: 0, status: 'ok' })).toEqual({ main: '0', sub: null, zero: true });
    expect(cellText('money', { v: 0, status: 'ok' })).toEqual({ main: '0', sub: null, zero: true });
    expect(cellText('money', { v: null, status: 'missing' }).main).toBe('לא הוגדר');
    expect(cellText('hours', { v: null, status: 'review' }).main).toBe('לבדיקה');
    expect(cellText('days', { v: 2200, status: 'ok' }).main).toBe('22');
    expect(cellText('days', { v: 150, status: 'ok' }).main).toBe('1.50');
    expect(cellText('flag', { v: 0, status: 'ok' }).main).toBe('לא');
  });

  it('a fully recorded employee is "ready"; one with a review item is "review"', async () => {
    const repo = await open();
    const { b, employee } = await business(repo);
    const e = await employee('מוכנה');
    for (let d = 2; d <= 5; d++) await repo.upsertShift(b.id, e.id, shift(`2026-11-0${d}`, '08:00', '16:30', 30));
    const sat = await employee('שבת');
    await repo.upsertShift(b.id, sat.id, shift('2026-11-07', '09:00', '13:00'));
    const { r } = await report(repo, b.id);
    expect(r.rows.find((x) => x.employeeId === e.id)!.state).toBe('ready');
    const S = r.rows.find((x) => x.employeeId === sat.id)!;
    expect(S.state).toBe('review');
    expect(S.values.p150.v).toBe(240); // weekly-rest hours as computed by the engine
  });
});

describe('consistency with the monthly summary export', () => {
  it('the payroll-entry sheet carries the same figures as the summary table (same engine results)', async () => {
    const repo = await open();
    const { b, employee } = await business(repo);
    const names = ['אורי', 'בתיה', 'גלית', 'דוד'];
    for (const [i, n] of names.entries()) {
      const e = await employee(n, String(100 + i));
      for (let d = 2; d <= 6; d++) await repo.upsertShift(b.id, e.id, shift(`2026-11-0${d}`, '08:00', i % 2 ? '17:31' : '16:13', 30));
      if (i === 2) await repo.setDayEntry(b.id, e.id, { date: '2026-11-09', status: 'vacation', note: null });
    }
    const { s, fin, r } = await report(repo, b.id);
    const summary = businessMonthTable('סיכום', s, true, fin);
    const entry = payrollEntryTable('קליטת שכר', r);
    const col = (t: typeof summary, h: string) => t.headers.indexOf(h);
    const val = (c: Cell) => (c.kind === 'text' ? c.v : c.v);
    const pairs: [string, string][] = [
      ['ימים משולמים', 'ימים משולמים'],
      ['שעות בפועל', 'שעות בפועל (ש:דד)'],
      ['שעות משולמות', 'שעות משולמות (ש:דד)'],
      ['שעות רגילות', 'שעות רגילות 100% (ש:דד)'],
      ['נוספות 125%', 'נוספות 125% (ש:דד)'],
      ['נוספות 150%', 'נוספות 150% (ש:דד)'],
      ['ימי חופשה', 'ימי חופשה'],
      ['ימי מחלה', 'ימי מחלה'],
      ['ימי חג', 'ימי חג'],
      ['נסיעות (₪)', 'נסיעות (₪)'],
      ['מקדמות (₪)', 'מקדמות (₪)'],
      ['בונוסים (₪)', 'בונוסים (₪)'],
      ['הבראה', 'הבראה'],
    ];
    for (const [sh, eh] of pairs) {
      expect(col(summary, sh), sh).toBeGreaterThanOrEqual(0);
      expect(col(entry, eh), eh).toBeGreaterThanOrEqual(0);
      summary.rows.forEach((row, i) => expect(val(entry.rows[i][col(entry, eh)]), `${eh} row ${i}`).toEqual(val(row[col(summary, sh)])));
    }
    // Decimal column = the H:MM column / 60 on every row, including the total row.
    const dec = col(entry, 'שעות בפועל (עשרוני)');
    for (const row of entry.rows) expect(row[dec]).toEqual({ kind: 'dec', v: (row[dec + 1] as { v: number }).v });
    // CSV: decimals appear exactly once per hour field (no duplicated "(עשרוני)" columns appended).
    const csv = tableToCsv(entry);
    const header = csv.split('\r\n')[0];
    expect(header.split('שעות בפועל (עשרוני)').length - 1).toBe(1);
    const totals = csv.trim().split('\r\n').at(-1)!.split(',');
    expect(totals[dec]).toBe(decimalHours(s.attendanceTotal.actualWorkedMinutes));
  });
});
