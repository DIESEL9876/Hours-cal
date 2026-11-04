/**
 * 1.1.11 through the real UI: a payroll professional records a registered agreement that is not in the catalog,
 * confirms its applicability and transcribes an overtime-rates clause from the official text; the employee's pay
 * estimate then follows the verified clause while recorded hours stay the same. Values are synthetic test data.
 */
import { expect, test } from '@playwright/test';

test('a transcribed, verified clause changes the pay estimate (hours unchanged)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  await page.getByTestId('business-name-input').fill('עסק הסכם');
  await page.getByRole('button', { name: 'הקמת העסק' }).click();
  await page.getByRole('button', { name: 'הוספת עובד' }).first().click();
  await page.getByTestId('employee-name-input').fill('יוסי טבח');
  await page.getByRole('radio', { name: 'הגדרות חישוב' }).click();
  await page.getByText('שכר שעתי (₪, אופציונלי)').locator('..').locator('input').fill('50');

  await page.getByTestId('agreement-field').click();
  await page.getByLabel('ענף').selectOption('agriculture');
  await expect(page.getByTestId('agreement-option')).toHaveCount(2);
  await page.getByLabel('ענף').selectOption('all');
  await page.getByRole('button', { name: 'הסכם שאינו ברשימה — לבדיקה ידנית' }).click();
  await page.getByTestId('agreement-selected').getByRole('button', { name: 'אישור תחולה' }).click();
  await page.getByLabel('שם ההסכם').fill('הסכם קיבוצי מיוחד — חברת דוגמה');
  await page.getByLabel('מספר רישום ההסכם').fill('7029/2024');
  await page.getByLabel('ענף העסק').fill('הסעדה');
  await page.getByLabel('עיסוק העובד').fill('טבח');
  await page.getByLabel('סיווג העובד').selectOption('other');
  await page.getByLabel('שם המאשר').fill('מנהלת השכר');
  for (const c of ['המעסיק והעובד בתחולת ההסכם', 'קראתי את הנוסח המלא', 'נבדקו תיקונים', 'נבדקו החרגות']) await page.getByLabel(c).check();
  // Transcribe: 150% / 200% from 1.1.2026 (a value below the statute would be rejected).
  await page.getByLabel('סוג הסעיף').selectOption('overtime_rates');
  await page.getByLabel('מדרגה ראשונה (%)').fill('120');
  await expect(page.getByTestId('transcribed-clauses')).toContainText('שיעור נמוך מהחוק');
  await page.getByLabel('מדרגה ראשונה (%)').fill('150');
  await page.getByLabel('מדרגה שנייה (%)').fill('200');
  await page.getByLabel('מספר הסעיף').fill('סעיף 7(א)');
  await page.getByLabel('סעיף חל מתאריך').fill('2026-01-01');
  await page.getByLabel('מזין הסעיף').fill('רו"ח לוי');
  await page.getByLabel('הערכים הועתקו מהנוסח הרשמי').check();
  await page.getByTestId('add-transcribed-clause').click();
  await expect(page.getByTestId('transcribed-clause')).toContainText('150% / 200%');
  await page.getByTestId('confirm-applicability').click();
  await expect(page.getByTestId('agreement-selected')).toContainText('כללים מאומתים');
  await expect(page.getByTestId('agreement-selected')).toContainText('7029/2024');
  await page.getByTestId('save-employee').click();

  await page.getByLabel('חודש', { exact: true }).selectOption('11');
  await page.getByLabel('שנה', { exact: true }).selectOption('2026');
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).first().click();
  await page.getByLabel('כניסה 2026-11-02').fill('0800');
  await page.getByLabel('יציאה 2026-11-02').fill('1900');
  await page.getByLabel('יציאה 2026-11-02').press('Enter');
  await page.getByLabel('הפסקה 2026-11-02').fill('0');
  await page.getByLabel('הפסקה 2026-11-02').press('Enter');
  await expect(page.getByTestId('total-net')).toHaveText('11:00');
  // Office policy 8:24 regular + 2:00 @150% + 0:36 @200% at 50 ₪ = 420 + 150 + 60 = 630 ₪ (statute: 420 + 125 + 45 = 590 ₪).
  await expect(page.getByText('₪630.00').first()).toBeVisible();
  await page.getByTestId('details-2026-11-02').click();
  await expect(page.getByText('הערכת העלות לפי סעיפים מאומתים').first()).toBeVisible();
  await expect(page.getByText('הסכם קיבוצי מיוחד — חברת דוגמה (מס׳ רישום 7029/2024), סעיף 7(א)').first()).toBeVisible();
  expect(errors).toEqual([]);
});
