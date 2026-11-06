/**
 * 1.1.13 — "סיכום חודשי לקליטת שכר" A4 PDF through the real UI: Hebrew RTL, decimal hours with H:MM, multi-page A4
 * output with repeated headers, nothing clipped, and the same figures as the on-screen summary and the Excel export.
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

test('payroll-entry PDF: RTL, decimal hours, multi-page A4, no clipping, consistent with summary and Excel', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openSummary(page, 36);

  // On-screen summary figures (the reference).
  const screenActual = (await page.getByTestId('grand-actual-hours').innerText()).split('\n')[0].trim();
  const screenPaid = (await page.getByTestId('grand-paid-hours').innerText()).split('\n')[0].trim();
  const screenBonus = (await page.getByTestId('grand-pay-bonus').innerText()).trim();

  await page.emulateMedia({ media: 'print' });
  const report = page.getByTestId('payroll-entry-report');
  await expect(report).toBeVisible();
  await expect(page.getByTestId('summary-table')).toBeHidden();
  await expect(report).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('pe-title')).toHaveText('סיכום חודשי לקליטת שכר');
  await expect(report).toContainText(DEMO_BUSINESS);
  await expect(report).toContainText('נובמבר 2026');
  await expect(page.getByTestId('pe-month-state')).toContainText('טיוטה');
  // Three separated sections: days, hours, NIS amounts; one row per employee in each.
  for (const s of ['days', 'hours', 'money']) {
    const sec = page.getByTestId(`pe-section-${s}`);
    await expect(sec.first()).toBeVisible();
    await expect(sec.first().getByTestId('pe-row')).toHaveCount(36);
  }
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pe-report')!).direction)).toBe('rtl');

  // Hours: decimal value prominent + H:MM reference, and both agree (minutes / 60).
  const hoursTotal = page.getByTestId('pe-section-hours').first().getByTestId('pe-total');
  const cell = hoursTotal.locator('td[data-col="actualHours"]');
  const main = (await cell.locator('.pe-main').innerText()).replace('*', '').trim();
  const sub = (await cell.locator('.pe-sub').innerText()).trim();
  const [h, m] = sub.split(':').map(Number);
  expect(main).toBe(((h * 60 + m) / 60).toFixed(2));
  expect(sub.replace(/^0/, '')).toBe(screenActual); // same total as the on-screen summary
  const fsMain = await cell.locator('.pe-main').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  const fsSub = await cell.locator('.pe-sub').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect(fsMain).toBeGreaterThan(fsSub);
  const paidSub = (await hoursTotal.locator('td[data-col="paidHours"] .pe-sub').innerText()).trim();
  expect(paidSub.replace(/^0/, '')).toBe(screenPaid);
  const bonusTotal = (await page.getByTestId('pe-section-money').first().getByTestId('pe-total').locator('td[data-col="bonus"] .pe-main').innerText()).trim();
  expect(`₪${bonusTotal}`).toBe(screenBonus);

  // Open items are marked, never shown as final, and listed for review.
  await expect(page.locator('td.pe-flagged').first()).toBeVisible();
  await expect(page.getByTestId('pe-issues')).toContainText('רישומים חסרים');
  await expect(page.getByTestId('pe-issues')).toContainText('החזר נסיעות לא הוגדר');

  // Nothing clipped: every table fits its page width and no cell overflows (A4 landscape content width).
  await page.setViewportSize({ width: 1047, height: 720 }); // 277 mm at 96 dpi
  const overflow = await page.evaluate(() => {
    const bad: string[] = [];
    for (const t of document.querySelectorAll<HTMLTableElement>('.pe-report table')) {
      if (t.scrollWidth > t.parentElement!.clientWidth + 1) bad.push(`table ${t.className} ${t.scrollWidth}>${t.parentElement!.clientWidth}`);
      for (const c of t.querySelectorAll<HTMLElement>('td, th')) if (c.scrollWidth > c.clientWidth + 1) bad.push(`cell "${c.innerText.slice(0, 20)}" ${c.scrollWidth}>${c.clientWidth}`);
    }
    return bad;
  });
  expect(overflow).toEqual([]);

  // A4 PDF: several pages, repeated report/section header and column headers on every page.
  const pdf = await page.pdf({ format: 'A4', landscape: true, preferCSSPageSize: true, printBackground: true });
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/payroll-entry-36.pdf', pdf);
  const pages = await pdfText(pdf);
  expect(pages.length).toBeGreaterThan(1);
  for (const [i, text] of pages.entries()) {
    const flat = text.replace(/\s+/g, '');
    // Running header and column headers on every page (PDF text order of Hebrew words may be reversed).
    expect(flat, `page ${i + 1}`).toContain('לקליטת');
    expect(flat, `page ${i + 1}`).toContain(DEMO_BUSINESS.replace(/\s+/g, '').slice(0, 6));
    expect(flat, `page ${i + 1}`).toContain('עובד');
    expect(flat, `page ${i + 1}`).toMatch(/עמוד\d+|\d+עמוד/);
  }

  // Excel: the "קליטת שכר" sheet carries the same totals.
  await page.emulateMedia({ media: 'screen' });
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync((await (await dl).path())!) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('קליטת שכר')!;
  expect(ws).toBeTruthy();
  const headers = (ws.getRow(4).values as unknown[]).map((v) => String(v ?? ''));
  const decCol = headers.indexOf('שעות בפועל (עשרוני)');
  expect(decCol).toBeGreaterThan(0);
  let last = 5;
  while (ws.getRow(last + 1).getCell(1).value) last++;
  expect(String(ws.getRow(last).getCell(1).value)).toBe('סה״כ לעסק');
  expect(Number(ws.getRow(last).getCell(decCol).value).toFixed(2)).toBe(main);
  expect(errors).toEqual([]);
});

test('payroll-entry PDF with a few employees: all three sections on the first A4 page', async ({ page }) => {
  await openSummary(page, 4);
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ format: 'A4', landscape: true, preferCSSPageSize: true, printBackground: true });
  writeFileSync('test-results/payroll-entry-4.pdf', pdf);
  const pages = await pdfText(pdf);
  expect(pages.length).toBeLessThanOrEqual(2); // the review list may continue on a second page
  const first = pages[0].replace(/\s+/g, '');
  for (const w of ['ימים', 'שעות', 'סכומים', 'לעסק']) expect(first).toContain(w);
  expect(first.split('לעסק').length - 1).toBe(3); // the three section totals are all on page 1
});

test('closed month: the report is marked final and shows the figures stored for that month', async ({ page }) => {
  await openSummary(page, 4, true);
  const screenActual = (await page.getByTestId('grand-actual-hours').innerText()).split('\n')[0].trim();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('pe-month-state')).toContainText('סופי – החודש נסגר');
  await expect(page.getByTestId('pe-month-state')).not.toContainText('השתנו');
  const sub = await page.getByTestId('pe-section-hours').getByTestId('pe-total').locator('td[data-col="actualHours"] .pe-sub').innerText();
  expect(sub.trim().replace(/^0/, '')).toBe(screenActual);
});
