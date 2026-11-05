/**
 * Version 1.1.9 through the real UI: the "רכיבי שכר נוספים" button (placed immediately to the right of
 * "פתיחת דוח שעות"), monthly components kept per month, date of birth and youth checks, travel and paid-day value
 * settings, the agreement catalog search and applicability confirmation, and the business summary columns.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function setMonth(page: Page, year: number, month: number) {
  await page.getByLabel('חודש', { exact: true }).selectOption(String(month));
  await page.getByLabel('שנה', { exact: true }).selectOption(String(year));
}

test('payroll components, youth, travel, paid-day value and agreements', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  await page.getByTestId('business-name-input').fill('עסק שכר');
  await page.getByRole('button', { name: 'הקמת העסק' }).click();

  // Employee: date of birth (17 in November 2026), hourly rate, daily travel, month-average paid day, agreement.
  await page.getByRole('button', { name: 'הוספת עובד' }).first().click();
  await page.getByTestId('employee-name-input').fill('נועה הצעירה');
  await page.getByTestId('employee-birthdate').fill('2009-06-01');
  // Youth details (1.1.10): never inferred from the date of birth.
  await expect(page.getByTestId('youth-details')).toBeVisible();
  await page.getByLabel('חובת לימוד').selectOption('not_compulsory');
  await page.getByRole('radio', { name: 'הגדרות חישוב' }).click();
  await page.getByText('שכר שעתי (₪, אופציונלי)').locator('..').locator('input').fill('40');
  await page.getByTestId('absence-settings').getByText('סוג העסקה').locator('..').locator('select').selectOption('hourly');
  await page.getByLabel('החזר הוצאות נסיעה').selectOption('daily');
  await page.getByLabel('סכום החזר נסיעות').fill('15');
  await page.getByLabel('שיטת חישוב ערך יום היעדרות').selectOption('average');
  await page.getByLabel('תקופת הממוצע').selectOption('average_month');
  await page.getByTestId('agreement-field').click();
  await expect(page.getByTestId('official-links')).toContainText('מאגר צווי ההרחבה');
  await page.getByRole('radio', { name: 'הסכמים קיבוציים' }).click();
  await expect(page.getByTestId('agreement-option')).toHaveCount(0); // agreements are kept apart; none catalogued
  await page.getByRole('radio', { name: 'הכל' }).click();
  await page.getByLabel('חיפוש הסכם').fill('הבראה');
  await expect(page.getByTestId('agreement-option')).toHaveCount(1);
  await expect(page.getByTestId('agreement-option')).toContainText('המקור אותר; הוראות החישוב לא אומתו');
  await page.getByTestId('agreement-option').getByRole('button', { name: 'בחירה' }).click();
  await expect(page.getByTestId('agreement-selected')).toContainText('תחולה בבדיקה');
  await page.getByTestId('agreement-selected').getByRole('button', { name: 'אישור תחולה' }).click();
  await page.getByLabel('ענף העסק').fill('מסחר');
  await page.getByLabel('עיסוק העובד').fill('קופאית');
  await page.getByLabel('סיווג העובד').selectOption('other');
  await page.getByLabel('שם המאשר').fill('מנהלת השכר');
  for (const c of ['המעסיק והעובד בתחולת ההסכם', 'קראתי את הנוסח המלא', 'נבדקו תיקונים', 'נבדקו החרגות']) await page.getByLabel(c).check();
  await page.getByTestId('confirm-applicability').click();
  await expect(page.getByTestId('agreement-selected')).toContainText('הוראות ההסכם טרם אומתו');
  // A construction order cannot be confirmed for an office employee.
  await page.getByLabel('חיפוש הסכם').fill('COLL-005');
  await page.getByTestId('agreement-option').getByRole('button', { name: 'בחירה' }).click();
  await page.getByTestId('agreement-selected').locator('li').filter({ hasText: 'בנייה' }).getByRole('button', { name: 'אישור תחולה' }).click();
  await page.getByLabel('סיווג העובד').selectOption('office_staff');
  await expect(page.getByTestId('applicability-blocked')).toBeVisible();
  await expect(page.getByTestId('confirm-applicability')).toBeDisabled();
  await page.getByRole('dialog').last().getByRole('button', { name: 'סגירה', exact: true }).last().click();
  await page.getByTestId('agreement-selected').locator('li').filter({ hasText: 'בנייה' }).getByRole('button', { name: 'הסרה' }).click();
  await page.getByTestId('save-employee').click();

  // Attendance: two shifts on one date = one travel day; youth limit flagged; worked minutes kept.
  await setMonth(page, 2026, 11);
  await page.getByTestId('employee-row').first().getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  await page.getByLabel('כניסה 2026-11-02').fill('0800');
  await page.getByLabel('יציאה 2026-11-02').fill('1300');
  await page.getByLabel('יציאה 2026-11-02').press('Enter');
  await page.getByLabel('הפסקה 2026-11-02').fill('0');
  await page.getByLabel('הפסקה 2026-11-02').press('Enter');
  await page.getByLabel('כניסה 2026-11-03').fill('0800');
  await page.getByLabel('יציאה 2026-11-03').fill('1830');
  await page.getByLabel('יציאה 2026-11-03').press('Enter');
  await page.getByLabel('הפסקה 2026-11-03').fill('30');
  await page.getByLabel('הפסקה 2026-11-03').press('Enter');
  await expect(page.getByTestId('total-net')).toHaveText('15:00');
  await expect(page.getByTestId('age-note')).toContainText('מתחת לגיל 18');
  await page.getByTestId('details-2026-11-03').click();
  await expect(page.getByText('העסקת נער בשעות נוספות אסורה').first()).toBeVisible();
  await page.keyboard.press('Escape');
  // Recorded vs prohibited (kept apart; nothing deducted): 17-year-old, five-day week, 10:00 net → 1:00 above 9:00.
  await expect(page.getByTestId('youth-summary')).toContainText('15:00');
  await expect(page.getByTestId('youth-prohibited')).toHaveText('1:00');
  await page.getByTestId('day-type-2026-11-04').selectOption('vacation');
  await expect(page.getByTestId('pay-absence')).toHaveText('₪300.00'); // average 7:30 × 40 ₪
  await expect(page.getByTestId('pay-travel')).toHaveText('₪30.00'); // 2 worked dates × 15 ₪

  // Detailed payroll components — now opened from the attendance screen (req 2), kept per month.
  await page.getByTestId('payroll-items-button').click();
  await expect(page.getByTestId('payroll-items-title')).toContainText('רכיבי שכר נוספים — נועה הצעירה — נובמבר 2026');
  await expect(page.getByTestId('paid-day-value')).toContainText('ממוצע שעות עבודה בחודש הנוכחי');
  await expect(page.getByTestId('paid-day-value')).toContainText('7:30');
  await expect(page.getByTestId('recuperation-helper')).toContainText('הוראות ההסכם טרם אומתו');
  await page.getByTestId('add-payroll-item').click();
  await page.getByLabel('סכום', { exact: true }).fill('500');
  await page.getByLabel('תיאור').fill('בונוס חג');
  await page.getByTestId('save-payroll-item').dblclick(); // a double click never posts twice
  await expect(page.getByTestId('payroll-item-row')).toHaveCount(1);
  await page.getByTestId('add-payroll-item').click();
  await page.getByLabel('סוג הרכיב').selectOption('advance');
  await page.getByLabel('סכום', { exact: true }).fill('1000');
  await page.getByLabel('סכום מוצע להחזר').fill('500');
  await page.getByTestId('save-payroll-item').click();
  await expect(page.getByTestId('payroll-item-row')).toHaveCount(2);
  await expect(page.getByTestId('payroll-totals')).toContainText('₪530.00'); // gross additions: bonus 500 + travel 30
  await expect(page.getByTestId('payroll-totals')).toContainText('הצעות להחזר (לא אושרו): ₪500.00');
  await page.getByTestId('payroll-items-close').click();

  // October (via the attendance month picker) has its own, empty list.
  await setMonth(page, 2026, 10);
  await page.getByTestId('payroll-items-button').click();
  await expect(page.getByTestId('payroll-item-row')).toHaveCount(0);
  await page.getByTestId('payroll-items-close').click();
  await setMonth(page, 2026, 11);

  // Persisted after reload (own table, not part of the hours data).
  await page.reload();
  await page.getByTestId('business-card').filter({ hasText: 'עסק שכר' }).getByRole('button', { name: 'כניסה לעסק' }).click();
  await setMonth(page, 2026, 11);
  await page.getByTestId('employee-row').first().getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  await page.getByTestId('payroll-items-button').click();
  await expect(page.getByTestId('payroll-item-row')).toHaveCount(2);
  await page.getByTestId('payroll-items-close').click();

  // Business-wide monthly summary: the money columns and totals (recuperation is now a כן/לא flag).
  await page.getByRole('button', { name: 'חזרה לעובדים' }).click();
  await page.getByRole('button', { name: 'סיכום חודשי' }).click();
  const thead = page.getByTestId('summary-table').locator('thead');
  for (const h of ['בונוסים', 'מקדמות', 'נסיעות', 'ערך היעדרויות', 'הבראה', 'מילואים']) await expect(thead).toContainText(h);
  await expect(thead).not.toContainText('תוספות אחרות');
  await expect(page.getByTestId('grand-pay-bonus')).toHaveText('₪500.00');
  await expect(page.getByTestId('grand-pay-travel')).toHaveText('₪30.00');
  await expect(page.getByTestId('grand-total')).toContainText('15:00'); // hours unchanged by money
  const csvDl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV' }).click();
  const csv = readFileSync((await (await csvDl).path())!, 'utf8');
  for (const h of ['בונוסים (₪)', 'נסיעות (₪)', 'רכיבי שכר', 'בונוס חג']) expect(csv).toContain(h);
  expect(csv).toContain('500.00');
  expect(errors).toEqual([]);
});
