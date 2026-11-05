/**
 * Version 1.1.8 through the real UI (browser build):
 *  - new business + all employees from one multi-sheet workbook (synthetic), single review, approval, monthly summary;
 *  - bulk import into an existing business with an existing employee (no duplicate created);
 *  - photographed report imported into an employee's monthly report (offline OCR in the browser).
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FX = 'src/import/__tests__/fixtures';
const tauriCsp = (JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { app: { security: { csp: string } } }).app.security.csp;

async function setMonth(page: Page, year: number, month: number) {
  await page.getByLabel('חודש', { exact: true }).selectOption(String(month));
  await page.getByLabel('שנה', { exact: true }).selectOption(String(year));
}

test('new business from a workbook: proposals, duplicate decision, approval, monthly summary', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  // Manual creation is still the default.
  await expect(page.getByTestId('business-create-mode').getByRole('radio', { name: 'הקמת עסק ידנית' })).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('business-name-input').fill('עסק מיובא');
  await page.getByTestId('business-create-mode').getByRole('radio', { name: 'הקמת עסק וייבוא עובדים מקובץ' }).click();
  await page.getByTestId('business-import-file').setInputFiles(`${FX}/bulk-workbook.xlsx`);
  await expect(page.getByTestId('bulk-preview')).toBeVisible({ timeout: 60_000 });

  // Nothing created yet: the business does not exist until approval.
  const counts = page.getByTestId('bulk-counts');
  await expect(counts).toContainText('גיליונות שנבדקו 7');
  await expect(counts).toContainText('עובדים שזוהו 6');
  await expect(counts).toContainText('עובדים חדשים 5');
  await expect(page.getByTestId('bulk-row')).toHaveCount(6);
  await expect(page.getByText('גיליונות ללא טבלת נוכחות (לא ייקלטו): הוראות')).toBeVisible();
  await expect(page.getByTestId('bulk-settings')).toContainText('5 ימים');

  // The second "רון שמש" sheet needs a decision; approval is blocked until it is made.
  await expect(page.getByTestId('bulk-approve')).toBeDisabled();
  await expect(page.getByTestId('bulk-footer')).toContainText('יש לבחור פעולה');
  await page.getByLabel('פעולה רון שמש 2 אוקטובר 2026').selectOption({ label: 'מיזוג עם הגיליון "רון שמש אוקטובר 2026"' });

  // Per-employee preview: two punch pairs stay two shifts.
  await page.getByTestId('bulk-row').nth(1).getByTestId('bulk-expand').click();
  await expect(page.getByTestId('import-row-2026-10-04')).toBeVisible();
  await expect(page.getByTestId('import-start-2026-10-04-1')).toHaveValue('15:00');
  await expect(page.getByTestId('bulk-approve')).toBeEnabled();
  await page.getByTestId('bulk-approve').click();

  await expect(page.getByTestId('bulk-done')).toContainText('נוצרו 5 עובדים חדשים');
  await page.getByTestId('bulk-go-summary').click();
  await expect(page.getByRole('heading', { name: 'סיכום חודשי - אוקטובר 2026' })).toBeVisible();
  await expect(page.getByTestId('summary-row')).toHaveCount(5);
  await expect(page.getByTestId('grand-total')).toBeVisible();

  // The employee list shows the imported employees with their numbers.
  await page.getByRole('button', { name: 'חזרה לעובדים' }).click();
  await expect(page.getByTestId('employee-row')).toHaveCount(5);
  await expect(page.getByTestId('employee-row').filter({ hasText: 'יוסי כהן' })).toContainText('102');
  expect(errors).toEqual([]);
});

test('existing business: an existing employee is matched (no duplicate); cancel writes nothing', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  await page.getByTestId('business-name-input').fill('עסק קיים');
  await page.getByRole('button', { name: 'הקמת העסק' }).click();
  await page.getByRole('button', { name: 'הוספת עובד' }).first().click();
  await page.getByTestId('employee-name-input').fill('דנה לוי');
  await page.getByLabel('מספר עובד (אופציונלי)').fill('101');
  await page.getByTestId('save-employee').click();
  await setMonth(page, 2026, 10);

  // Cancel: nothing changes.
  await page.getByTestId('bulk-import-file').setInputFiles(`${FX}/bulk-workbook.xlsx`);
  await expect(page.getByTestId('bulk-preview')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('bulk-cancel').click();
  await expect(page.getByTestId('employee-row')).toHaveCount(1);

  await page.getByTestId('bulk-import-file').setInputFiles(`${FX}/bulk-workbook.xlsx`);
  await expect(page.getByTestId('bulk-preview')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('פעולה דנה לוי אוקטובר 2026')).toHaveValue(/^existing:/);
  await expect(page.getByTestId('bulk-counts')).toContainText('התאמות לעובדים קיימים 1');
  await page.getByLabel('פעולה רון שמש 2 אוקטובר 2026').selectOption('skip');
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByTestId('bulk-done')).toContainText('עודכנו 1 עובדים קיימים');
  await page.getByRole('button', { name: 'מעבר לרשימת העובדים' }).click();
  await expect(page.getByTestId('employee-row')).toHaveCount(5); // 1 existing + 4 new, no duplicate "דנה לוי"
  await expect(page.getByTestId('employee-row').filter({ hasText: 'דנה לוי' })).toHaveCount(1);
});

test('photographed report → preview with ordered times → approval into the monthly report', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && /Content Security Policy|Refused/.test(m.text()) && errors.push(m.text()));
  // Same content-security policy as the Windows app, and no network beyond the app itself.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'localhost') return route.abort();
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if ((headers['content-type'] ?? '').includes('text/html')) headers['content-security-policy'] = tauriCsp;
    await route.fulfill({ response: res, headers });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  await page.getByTestId('business-name-input').fill('עסק תמונה');
  await page.getByRole('button', { name: 'הקמת העסק' }).click();
  await page.getByRole('button', { name: 'הוספת עובד' }).first().click();
  await page.getByTestId('employee-name-input').fill('מיכאל');
  await page.getByTestId('save-employee').click();
  await setMonth(page, 2026, 11);
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).click();

  await page.getByTestId('import-file-input').setInputFiles(`${FX}/receipt-straight.png`);
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText('התמונה זוהתה במחשב זה באמצעות OCR')).toBeVisible();
  await expect(page.getByTestId('import-source-total')).toContainText('74.05');
  // RTL display "14:31 - 06:58" → entrance 06:58, exit 14:31 (from the hours value 7.55).
  await expect(page.getByTestId('import-start-2026-11-02-0')).toHaveValue('06:58');
  await expect(page.getByTestId('import-end-2026-11-02-0')).toHaveValue('14:31');
  await expect(page.getByTestId('import-zero-break')).toBeVisible();
  await expect(page.getByTestId('import-approve')).toBeEnabled();
  await page.getByTestId('import-approve').click();
  await expect(page.getByTestId('import-done')).toBeVisible();
  await page.getByRole('button', { name: 'סגירה' }).last().click();
  await expect(page.getByLabel('כניסה 2026-11-02')).toHaveValue('06:58');
  await expect(page.getByLabel('יציאה 2026-11-02')).toHaveValue('14:31');
  expect(errors).toEqual([]);
});
