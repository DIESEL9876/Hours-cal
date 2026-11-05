/**
 * Version 1.1.7 — actual vs. paid attendance through the real screens: manual "סוג יום", suggestions that are only
 * proposals, partial-day vacation, sickness days, employee totals, the business-wide monthly summary, CSV export,
 * absence settings and persistence after reload.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function setMonth(page: Page, year: number, month: number) {
  await page.getByLabel('חודש', { exact: true }).selectOption(String(month));
  await page.getByLabel('שנה', { exact: true }).selectOption(String(year));
}

async function enterShift(page: Page, date: string, start: string, end: string, brk: string) {
  await page.getByLabel(`כניסה ${date}`).fill(start);
  await page.getByLabel(`יציאה ${date}`).fill(end);
  await page.getByLabel(`יציאה ${date}`).press('Enter');
  await expect(page.getByLabel(`יציאה ${date}`)).not.toHaveClass(/invalid/);
  await page.getByLabel(`הפסקה ${date}`).fill(brk);
  await page.getByLabel(`הפסקה ${date}`).press('Enter');
}

async function openReport(page: Page, year: number, month: number) {
  await setMonth(page, year, month);
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).click();
}

test('day types are manual; actual vs. paid totals in the employee report, the business summary and the CSV', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  await page.getByTestId('business-name-input').fill('עסק היעדרויות');
  const bizAbsence = page.getByTestId('absence-settings');
  await expect(bizAbsence).toBeVisible();
  await expect(bizAbsence.getByLabel('היעדרות בתשלום ותקן 42 השעות')).toHaveValue('paid_absence');
  await bizAbsence.getByLabel('סוג העסקה').selectOption('monthly');
  await page.getByRole('button', { name: 'הקמת העסק' }).click();

  await page.getByRole('button', { name: 'הוספת עובד' }).first().click();
  await page.getByTestId('employee-name-input').fill('נועה כהן');
  await page.getByRole('radio', { name: 'הגדרות חישוב' }).click();
  const empAbsence = page.getByTestId('absence-settings');
  await expect(empAbsence.getByLabel('סוג העסקה')).toHaveValue(''); // inherits
  await expect(empAbsence.getByLabel('סוג העסקה').locator('option:checked')).toHaveText('לפי הגדרת העסק (עובד חודשי)');
  await page.getByTestId('save-employee').click();

  // --- September: calendar holidays are suggestions only ---------------------------------------
  await openReport(page, 2026, 9);
  await expect(page.getByTestId('day-type-2026-09-21')).toHaveValue(''); // nothing assigned automatically
  await expect(page.getByTestId('suggestion-2026-09-21')).toContainText('יום כפור');
  await expect(page.getByTestId('total-holiday-days')).toHaveText('0.00');
  await page.getByRole('button', { name: 'דחיית הצעה 2026-09-21' }).click();
  await expect(page.getByTestId('suggestion-2026-09-21')).toHaveCount(0);
  await expect(page.getByTestId('day-type-2026-09-21')).toHaveValue('');
  await page.getByRole('button', { name: 'אישור הצעה 2026-09-13' }).click(); // ראש השנה ב׳
  await expect(page.getByTestId('day-type-2026-09-13')).toHaveValue('holiday');
  await expect(page.getByTestId('total-holiday-days')).toHaveText('1.00');
  await page.getByRole('button', { name: 'חזרה לעובדים' }).click();

  // --- October ------------------------------------------------------------------------------------
  await openReport(page, 2026, 10);
  await enterShift(page, '2026-10-11', '0800', '1700', '30'); // 8:30 worked
  await page.getByTestId('day-type-2026-10-12').selectOption('vacation'); // full day 8:24
  await page.getByTestId('day-type-2026-10-13').selectOption('sick'); // sick day 1 → 0%
  await page.getByTestId('day-type-2026-10-14').selectOption('sick'); // sick day 2 → 50% of 8:24 = 4:12
  // Partial vacation on a worked day: 4:00 worked + 4:24 vacation, nothing counted twice.
  await enterShift(page, '2026-10-18', '0800', '1200', '0');
  await page.getByTestId('day-type-2026-10-18').selectOption('vacation');
  await page.getByTestId('details-2026-10-18').click();
  await page.getByLabel('שעות היעדרות').fill('4:24');
  await page.getByLabel('שעות היעדרות').press('Tab');
  await expect(page.getByTestId('attendance-panel')).toContainText('8:24'); // 4:00 actual + 4:24 vacation
  await expect(page.getByTestId('attendance-explanation')).toBeVisible();
  await page.keyboard.press('Escape');

  // Entrance / exit fields are untouched by the day type.
  await expect(page.getByLabel('כניסה 2026-10-18')).toHaveValue('08:00');
  await expect(page.getByLabel('יציאה 2026-10-18')).toHaveValue('12:00');

  const expectTotals = async () => {
    await expect(page.getByTestId('total-net')).toHaveText('12:30'); // existing total unchanged: actual work only
    await expect(page.getByTestId('total-actual-days')).toHaveText('2.00');
    await expect(page.getByTestId('total-actual-hours')).toHaveText('12:30');
    await expect(page.getByTestId('total-actual-hours-decimal')).toHaveText('12.50');
    await expect(page.getByTestId('total-paid-hours')).toHaveText('29:30'); // 12:30 + 8:24 + 4:12 + 4:24
    await expect(page.getByTestId('total-paid-hours-decimal')).toHaveText('29.50');
    await expect(page.getByTestId('total-vacation-days')).toHaveText('1.52'); // 1 + 4:24/8:24
    await expect(page.getByTestId('total-sick-days')).toHaveText('2.00');
    await expect(page.getByTestId('attendance-totals')).toContainText('משולם 0.50');
    await expect(page.getByTestId('total-paid-days')).toHaveText('3.50'); // 11/10 + 12/10 + 0.50 sick + 18/10
  };
  await expectTotals();

  // Replacing an existing category needs explicit confirmation; cancelling keeps it.
  await page.getByTestId('day-type-2026-10-12').selectOption('sick');
  await page.getByRole('dialog').last().getByRole('button', { name: 'ביטול' }).click();
  await expect(page.getByTestId('day-type-2026-10-12')).toHaveValue('vacation');

  // Persisted after reload.
  await page.reload();
  await page.getByTestId('business-card').filter({ hasText: 'עסק היעדרויות' }).getByRole('button', { name: 'כניסה לעסק' }).click();
  await openReport(page, 2026, 10);
  await expect(page.getByTestId('day-type-2026-10-12')).toHaveValue('vacation');
  await expectTotals();

  // --- Business-wide monthly summary --------------------------------------------------------------
  await page.getByRole('button', { name: 'חזרה לעובדים' }).click();
  await page.getByRole('button', { name: 'סיכום חודשי' }).click();
  const table = page.getByTestId('summary-table');
  for (const h of ['ימים בפועל', 'ימים משולמים', 'שעות בפועל', 'שעות משולמות', 'ימי חופשה', 'ימי מחלה', 'ימי חג', 'שעות רגילות', 'נוספות 125%', 'סה״כ נטו'])
    await expect(table.locator('thead')).toContainText(h);
  const row = page.getByTestId('summary-row');
  const grand = page.getByTestId('grand-total');
  await expect(row.getByTestId('paid-hours')).toContainText('29:30');
  await expect(row.getByTestId('dec-paid-hours')).toHaveText('29.50');
  await expect(grand.getByTestId('grand-actual-days')).toHaveText('2.00');
  await expect(grand.getByTestId('grand-paid-days')).toHaveText('3.50');
  await expect(grand.getByTestId('grand-actual-hours')).toContainText('12:30');
  await expect(grand.getByTestId('dec-actual-hours')).toHaveText('12.50');
  await expect(grand.getByTestId('grand-vacation-days')).toHaveText('1.52');
  await expect(grand.getByTestId('grand-sick-days')).toContainText('2.00');
  await expect(grand.getByTestId('grand-holiday-days')).toHaveText('0.00');
  await expect(grand.getByTestId('dec-net')).toHaveText('12.50');

  const csvDl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV' }).click();
  const csv = readFileSync((await (await csvDl).path())!, 'utf8');
  const [header] = csv.split('\r\n');
  for (const h of ['ימים בפועל', 'ימים משולמים', 'שעות בפועל', 'שעות משולמות', 'ימי חופשה', 'ימי מחלה', 'ימי חג']) expect(header).toContain(h);
  const totalLine = csv.split('\r\n').find((l) => l.startsWith('סה״כ לעסק'))!;
  for (const v of ['29:30', '29.50', '12:30', '12.50', '3.50', '1.52', '2.00']) expect(totalLine).toContain(v);

  expect(errors).toEqual([]);
});
