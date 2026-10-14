/**
 * Version 1.1.6 — Friday overtime setting through the real screens: business default, employee inheritance and
 * override, attendance totals, persistence after reload.
 */
import { expect, test, type Page } from '@playwright/test';

async function setMonth(page: Page, year: number, month: number) {
  await page.getByLabel('חודש', { exact: true }).selectOption(String(month));
  await page.getByLabel('שנה', { exact: true }).selectOption(String(year));
}

async function enterShift(page: Page, date: string, start: string, end: string) {
  await page.getByLabel(`כניסה ${date}`).fill(start);
  await page.getByLabel(`יציאה ${date}`).fill(end);
  await page.getByLabel(`יציאה ${date}`).press('Enter');
}

test('business "all Friday hours as overtime" → inherited by a new employee → 6:00 Friday = 2:00 @125% + 4:00 @150%', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  await page.getByTestId('business-name-input').fill('עסק שישי');
  const biz = page.getByTestId('friday-overtime');
  await expect(biz).toContainText('חישוב שעות נוספות ביום שישי');
  await expect(biz.getByRole('radio', { name: 'ללא תוספת אוטומטית לשעות יום שישי' })).toHaveAttribute('aria-checked', 'true'); // default = earlier behaviour
  await biz.getByRole('radio', { name: 'כל שעות יום שישי כשעות נוספות' }).click();
  await page.getByRole('button', { name: 'הקמת העסק' }).click();

  await page.getByRole('button', { name: 'הוספת עובד' }).first().click();
  await page.getByTestId('employee-name-input').fill('דנה לוי');
  await page.getByRole('radio', { name: 'הגדרות חישוב' }).click();
  await expect(page.getByTestId('friday-overtime').getByRole('radio', { name: 'לפי הגדרת העסק (כשעות נוספות)' })).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('save-employee').click();

  await setMonth(page, 2026, 10);
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  await enterShift(page, '2026-10-16', '0800', '1430');
  await page.getByLabel('הפסקה 2026-10-16').fill('30');
  await page.getByLabel('הפסקה 2026-10-16').press('Enter');
  await expect(page.getByTestId('total-net')).toHaveText('6:00');
  await expect(page.getByTestId('total-regular')).toHaveText('0:00');
  await expect(page.getByTestId('total-125')).toHaveText('2:00');
  await expect(page.getByTestId('total-150')).toHaveText('4:00');
  await expect(page.getByTestId('total-150-decimal')).toHaveText('4.00');
  await page.getByTestId('details-2026-10-16').click();
  await expect(page.getByTestId('explanation')).toContainText('כל שעות העבודה נטו ביום שישי סווגו כשעות נוספות');
  await page.keyboard.press('Escape');

  // Persisted: reload the app and the result is the same.
  await page.reload();
  await page.getByTestId('business-card').filter({ hasText: 'עסק שישי' }).getByRole('button', { name: 'כניסה לעסק' }).click();
  await setMonth(page, 2026, 10);
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  await expect(page.getByTestId('total-150')).toHaveText('4:00');

  // Employee override "none" → the earlier classification (regular hours, weekly allowance not reached).
  await page.getByRole('button', { name: 'חזרה לעובדים' }).click();
  await page.getByRole('button', { name: 'עריכת עובד' }).click();
  await page.getByRole('radio', { name: 'הגדרות חישוב' }).click();
  await page.getByTestId('friday-overtime').getByRole('radio', { name: 'ללא תוספת אוטומטית לשעות יום שישי' }).click();
  await page.getByTestId('save-employee').click();
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  await expect(page.getByTestId('total-regular')).toHaveText('6:00');
  await expect(page.getByTestId('total-125')).toHaveText('0:00');
  expect(errors).toEqual([]);
});
