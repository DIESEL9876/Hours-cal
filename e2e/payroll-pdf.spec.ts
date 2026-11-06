/**
 * "סיכום חודשי לקליטת שכר" A4 PDF through the real UI: ONE continuous table (one employee = one row), Hebrew RTL,
 * decimal hours with HH:MM in the same cell, multi-page A4 output with repeated headings, nothing clipped, distinct
 * zero / missing / review states, and the same figures as the on-screen summary and the Excel export.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { buildDemoDatabase, DEMO_BUSINESS, loadDemo } from './seedPayroll';

async function openSummary(page: Page, employees: number, finalize = false) {
  await loadDemo(page, await buildDemoDatabase(employees, { finalize }));
  await page.getByTestId('business-card').filter({ hasText: DEMO_BUSINESS }).getByRole('button', { name: 'כניסה לעסק' }).click();
  await page.getByLabel('חודש', { exact: true }).selectOption('11');
  await page.getByLabel('שנה', { exact: true }).selectOption('2026');
  await page.getByRole('button', { name: 'סיכום חודשי' }).click();
  await expect(page.getByTestId('summary-table')).toBeVisible();
}

async function pdfText(bytes: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    pages.push(c.items.map((x) => ('str' in x ? x.str : '')).join(' '));
  }
  return pages;
}

const A4 = { format: 'A4' as const, landscape: true, preferCSSPageSize: true, printBackground: true };

test('payroll-entry PDF: one table, one row per employee, decimal + HH:MM, multi-page A4, no clipping, consistent', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openSummary(page, 38);

  // On-screen summary figures (the reference).
  const screenActual = (await page.getByTestId('grand-actual-hours').innerText()).split('\n')[0].trim();
  const screenPaid = (await page.getByTestId('grand-paid-hours').innerText()).split('\n')[0].trim();
  const screenBonus = (await page.getByTestId('grand-pay-bonus').innerText()).trim();

  await page.emulateMedia({ media: 'print' });
  const report = page.getByTestId('payroll-entry-report');
  await expect(report).toBeVisible();
  await expect(page.getByTestId('summary-table')).toBeHidden();
  await expect(report).toHaveAttribute('dir', 'rtl');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pe-report')!).direction)).toBe('rtl');
  await expect(page.getByTestId('pe-title')).toHaveText('סיכום חודשי לקליטת שכר');
  await expect(report).toContainText(DEMO_BUSINESS);
  await expect(report).toContainText('נובמבר 2026');
  await expect(page.getByTestId('pe-month-state')).toContainText('טיוטה');

  // ONE table; every employee exactly once; days, hours and money in the same row.
  await expect(report.locator('table')).toHaveCount(1);
  const rows = page.getByTestId('pe-row');
  await expect(rows).toHaveCount(38);
  const names = await rows.locator('.pe-name-main').allInnerTexts();
  expect(new Set(names).size).toBe(38);
  const ready = rows.filter({ has: page.locator('[data-col="regular"]') }).first();
  for (const k of ['actualDays', 'paidDays', 'actualHours', 'paidHours', 'regular', 'ot125', 'ot150', 'vacationDays', 'vacationHours', 'sickDays', 'sickHours', 'holidayDays', 'holidayHours', 'travel', 'advance', 'bonus', 'recupFlag'])
    await expect(ready.locator(`td[data-col="${k}"]`), k).toHaveCount(1);
  for (const k of ['p150', 'p175', 'p200']) await expect(page.locator(`thead th[data-col="${k}"]`), k).toHaveCount(1); // weekly-rest work in the data
  // Employee records are never split across pages; headings repeat on every page.
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('tbody.pe-emp')!).breakInside)).toBe('avoid');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pe-table thead')!).display)).toBe('table-header-group');
  expect(Number(await page.getByTestId('pe-table').getAttribute('data-width-mm'))).toBeLessThanOrEqual(281);

  // Hours: decimal (prominent) and HH:MM in the SAME cell, and they agree (minutes / 60).
  const totals = page.getByTestId('pe-total');
  const cell = totals.locator('td[data-col="actualHours"]');
  const main = (await cell.locator('.pe-main').innerText()).replace('*', '').trim();
  const sub = (await cell.locator('.pe-sub').innerText()).trim();
  const [h, m] = sub.split(':').map(Number);
  expect(main).toBe(((h * 60 + m) / 60).toFixed(2));
  expect(sub.replace(/^0/, '')).toBe(screenActual);
  expect(await cell.locator('.pe-main').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThan(await cell.locator('.pe-sub').evaluate((e) => parseFloat(getComputedStyle(e).fontSize)));
  expect((await totals.locator('td[data-col="paidHours"] .pe-sub').innerText()).trim().replace(/^0/, '')).toBe(screenPaid);
  expect(`₪${(await totals.locator('td[data-col="bonus"] .pe-main').innerText()).trim()}`).toBe(screenBonus);

  // States: genuine zero ("0"), missing ("לא הוגדר" / no records), review (*), and "ready" only when complete.
  await expect(rows.filter({ hasText: 'אין רישומי נוכחות או היעדרות לחודש זה' })).toHaveCount(1);
  await expect(page.locator('tbody[data-state="empty"] .pe-state-tag')).toHaveText('אין רישומים');
  await expect(page.locator('td[data-col="travel"]').filter({ hasText: 'לא הוגדר' })).toHaveCount(1);
  await expect(page.locator('tbody[data-state="missing"]')).not.toHaveCount(0);
  await expect(page.locator('td.pe-flagged .pe-mark').first()).toBeVisible();
  await expect(page.locator('tbody[data-state="ready"] td.pe-zero').first()).toHaveText('0');
  await expect(page.locator('tbody[data-state="ready"] .pe-mark')).toHaveCount(0);
  await expect(page.locator('tr.pe-below').filter({ hasText: 'לבדיקה:' }).first()).toBeVisible();

  // Nothing clipped or overlapping: every cell's content fits its box at the A4 content width (281 mm).
  await page.setViewportSize({ width: 1062, height: 760 });
  const overflow = await page.evaluate(() => {
    const bad: string[] = [];
    const t = document.querySelector<HTMLTableElement>('.pe-table')!;
    if (t.scrollWidth > t.parentElement!.clientWidth + 1) bad.push(`table ${t.scrollWidth}>${t.parentElement!.clientWidth}`);
    for (const c of t.querySelectorAll<HTMLElement>('td, th')) if (c.scrollWidth > c.clientWidth + 1) bad.push(`cell "${c.innerText.slice(0, 24)}" ${c.scrollWidth}>${c.clientWidth}`);
    for (const el of t.querySelectorAll<HTMLElement>('.pe-main, .pe-sub, .pe-name-main')) {
      const r = el.getBoundingClientRect();
      const p = el.closest('td, th')!.getBoundingClientRect();
      if (r.right > p.right + 0.5 || r.left < p.left - 0.5) bad.push(`text "${el.innerText}" outside its cell`);
    }
    return bad;
  });
  expect(overflow).toEqual([]);

  // A4 PDF: several pages; every page has the column headings and page number; pages 2+ the business/month line.
  const pdf = await page.pdf(A4);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/payroll-entry-38.pdf', pdf);
  const pages = await pdfText(pdf);
  expect(pages.length).toBeGreaterThan(1);
  for (const [i, text] of pages.entries()) {
    const flat = text.replace(/\s+/g, '');
    for (const w of ['עובד', 'שעותעבודה', 'חופשה', 'מחלה', 'נסיעות', 'הבראה']) expect(flat, `page ${i + 1}: ${w}`).toMatch(new RegExp(w.length > 5 ? `${w}|${w.split('').reverse().join('')}|עבודהשעות` : w));
    expect(flat, `page ${i + 1}`).toMatch(/עמוד\d+|\d+עמוד/);
    if (i > 0) expect(flat, `page ${i + 1}`).toContain('לקליטת');
  }
  // Each employee name appears in the PDF exactly once (no per-category repetition).
  const all = pages.join(' ').replace(/\s+/g, '');
  for (const n of names.slice(0, 10)) {
    const w = n.trim().split(/\s+/);
    const count = (x: string) => all.split(x).length - 1;
    expect(count(w.join('')) + (w.length > 1 ? count([...w].reverse().join('')) : 0), n).toBe(1); // PDF text may reverse word order
  }

  // Excel: the "קליטת שכר" sheet carries the same totals.
  await page.emulateMedia({ media: 'screen' });
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync((await (await dl).path())!) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('קליטת שכר')!;
  const headers = (ws.getRow(4).values as unknown[]).map((v) => String(v ?? ''));
  const decCol = headers.indexOf('שעות בפועל (עשרוני)');
  expect(decCol).toBeGreaterThan(0);
  let last = 5;
  while (ws.getRow(last + 1).getCell(1).value) last++;
  expect(String(ws.getRow(last).getCell(1).value)).toBe('סה״כ לעסק');
  expect(Number(ws.getRow(last).getCell(decCol).value).toFixed(2)).toBe(main);
  expect(errors).toEqual([]);
});

test('payroll-entry PDF with a few employees fits on one A4 page', async ({ page }) => {
  await openSummary(page, 6);
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf(A4);
  writeFileSync('test-results/payroll-entry-6.pdf', pdf);
  expect((await pdfText(pdf)).length).toBe(1);
});

test('closed month: the report is marked final and shows the same figures as the screen', async ({ page }) => {
  await openSummary(page, 4, true);
  const screenActual = (await page.getByTestId('grand-actual-hours').innerText()).split('\n')[0].trim();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('pe-month-state')).toContainText('סופי – החודש נסגר');
  await expect(page.getByTestId('pe-month-state')).not.toContainText('השתנו');
  const sub = await page.getByTestId('pe-total').locator('td[data-col="actualHours"] .pe-sub').innerText();
  expect(sub.trim().replace(/^0/, '')).toBe(screenActual);
});
