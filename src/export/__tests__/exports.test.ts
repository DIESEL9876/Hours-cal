/**
 * Monthly summary exports must show the same decimal values as the screens:
 * both use formatDecimalHours / decimalHundredths on the same integer-minute totals.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { calculateBusinessMonthlySummary, defaultEmployeeSettings, formatDecimalHours, formatHM } from '../../engine';
import { businessMonthTable, employeeMonthTable } from '../tables';
import { tableToCsv, tablesToXlsx } from '../exporters';
import { sh, versions } from '../../engine/__tests__/helpers';

function summary() {
  const s = defaultEmployeeSettings({ breakMethod: 'manual' });
  // Two employees, enough days to exceed 100 hours each.
  const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];
  const a = days.map((d) => sh(d, '08:07', '18:45', { breakMinutes: 45 }));
  const b = days.map((d) => sh(d, '07:53', '17:20', { breakMinutes: 30 }));
  const input = (id: string, shifts: typeof a) => ({ employeeId: id, settingsVersions: versions(s), shifts, dayStatuses: [], customHolidays: [], from: '2026-09-01', to: '2026-09-30' });
  return calculateBusinessMonthlySummary([
    { employeeId: 'a', name: 'דוקוצ׳איב סרגיי', employeeNumber: '6', input: input('a', a) },
    { employeeId: 'b', name: 'ישראל ישראלי', employeeNumber: '7', input: input('b', b) },
  ]);
}

/** RFC-4180 style parser (quoted fields may contain commas and doubled quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(cur), (cur = '');
    else if (ch === '\r' && src[i + 1] === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      i++;
    } else cur += ch;
  }
  return rows;
}

describe('monthly summary exports match the displayed decimal totals', () => {
  const s = summary();
  const t = businessMonthTable('סיכום', s, false);

  it('totals exceed 100 hours in this fixture', () => {
    expect(s.grandTotal.netMinutes).toBeGreaterThan(200 * 60);
  });

  it('CSV: decimal columns equal formatDecimalHours of each employee and the business total', () => {
    const rows = parseCsv(tableToCsv(t));
    const header = rows[0];
    const col = (h: string) => header.indexOf(h);
    const check = (row: string[], tot: typeof s.grandTotal) => {
      expect(row[col('שעות רגילות')]).toBe(formatHM(tot.buckets.regular));
      expect(row[col('שעות רגילות (עשרוני)')]).toBe(formatDecimalHours(tot.buckets.regular));
      expect(row[col('נוספות 125% (עשרוני)')]).toBe(formatDecimalHours(tot.buckets.ot125));
      expect(row[col('נוספות 150% (עשרוני)')]).toBe(formatDecimalHours(tot.buckets.ot150));
      expect(row[col('סה״כ שעות נטו (עשרוני)')]).toBe(formatDecimalHours(tot.netMinutes));
      expect(row[col('סך הפסקות (עשרוני)')]).toBe(formatDecimalHours(tot.breakMinutes));
    };
    check(rows[1], s.rows[0].totals);
    check(rows[2], s.rows[1].totals);
    expect(rows[3][0]).toBe('סה״כ לעסק');
    check(rows[3], s.grandTotal);
    expect(rows).toHaveLength(4); // header + 2 employees + total — no duplicated rows
  });

  it('XLSX: decimal cells equal the same hundredths as the screen', async () => {
    const bytes = await tablesToXlsx([t], { title: 'x', subtitle: 'y' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer as ArrayBuffer);
    const ws = wb.getWorksheet('סיכום')!;
    const header: Record<string, number> = {};
    ws.getRow(4).eachCell((c, i) => (header[String(c.value)] = i));
    const total = ws.getRow(4 + 3);
    expect(total.getCell(1).value).toBe('סה״כ לעסק');
    expect((total.getCell(header['סה״כ שעות נטו (עשרוני)']).value as number).toFixed(2)).toBe(formatDecimalHours(s.grandTotal.netMinutes));
    expect((total.getCell(header['שעות רגילות (עשרוני)']).value as number).toFixed(2)).toBe(formatDecimalHours(s.grandTotal.buckets.regular));
    expect((total.getCell(header['נוספות 125% (עשרוני)']).value as number).toFixed(2)).toBe(formatDecimalHours(s.grandTotal.buckets.ot125));
    expect((total.getCell(header['נוספות 150% (עשרוני)']).value as number).toFixed(2)).toBe(formatDecimalHours(s.grandTotal.buckets.ot150));
  });

  it('employee export total row carries the same decimals as the attendance totals bar', () => {
    const r = s.rows[0].result;
    const rows = parseCsv(tableToCsv(employeeMonthTable('דוח', r)));
    const header = rows[0];
    const total = rows.find((x) => x[0] === 'סה״כ')!;
    expect(total[header.indexOf('שעות ברוטו (עשרוני)')]).toBe(formatDecimalHours(r.totals.grossMinutes));
    expect(total[header.indexOf('הפסקה (עשרוני)')]).toBe(formatDecimalHours(r.totals.breakMinutes));
    expect(total[header.indexOf('שעות נטו (עשרוני)')]).toBe(formatDecimalHours(r.totals.netMinutes));
    expect(total[header.indexOf('שעות רגילות (עשרוני)')]).toBe(formatDecimalHours(r.totals.buckets.regular));
  });
});
