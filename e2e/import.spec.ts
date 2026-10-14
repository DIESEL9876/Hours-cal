/**
 * Attendance report import through the real UI (browser build): Excel, text PDF, scanned PDF (OCR in the
 * browser, as in the desktop WebView), wrong month, multiple employees, conflicts, approval and undo.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FX = 'src/import/__tests__/fixtures';
const tauriCsp = (JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { app: { security: { csp: string } } }).app.security.csp;

async function setMonth(page: Page, year: number, month: number) {
  await page.getByLabel('חודש', { exact: true }).selectOption(String(month));
  await page.getByLabel('שנה', { exact: true }).selectOption(String(year));
}

async function openEmployee(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  await page.getByTestId('business-name-input').fill('משרד ייבוא');
  await page.getByRole('button', { name: 'הקמת העסק' }).click();
  await page.getByRole('button', { name: 'הוספת עובד' }).first().click();
  await page.getByTestId('employee-name-input').fill(name);
  await page.getByTestId('save-employee').click();
  await setMonth(page, 2026, 9);
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  await expect(page.getByRole('heading', { name: `דוח שעות - ${name} - ספטמבר 2026` })).toBeVisible();
}

async function upload(page: Page, file: string) {
  await page.getByTestId('import-file-input').setInputFiles(`${FX}/${file}`);
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 120_000 });
}

test('Excel: preview → approve → same table as manual entry → undo removes the whole import', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmployee(page, 'דנה לוי');
  await expect(page.getByTestId('import-button')).toHaveText('ייבוא דוח שעות');

  // Selecting a file changes nothing until approval.
  await upload(page, 'he-standard.xlsx');
  await expect(page.getByTestId('import-counts')).toContainText('זוהו 20 ימים');
  await expect(page.getByTestId('import-row-2026-09-08')).toContainText('חסרה שעת יציאה');
  await expect(page.getByTestId('import-row-2026-09-15')).toContainText('חסרה שעת כניסה');
  await expect(page.getByTestId('import-row-2026-09-07')).toContainText('תקין');
  await page.getByTestId('import-cancel').click();
  await expect(page.getByLabel('כניסה 2026-09-01')).toHaveValue('');

  // Import again, correct the missing exit in the preview, approve.
  await upload(page, 'he-standard.xlsx');
  await page.getByTestId('import-end-2026-09-08-0').fill('16:45');
  await page.getByTestId('import-end-2026-09-08-0').press('Enter');
  await expect(page.getByTestId('import-row-2026-09-08')).toContainText('תקין');
  await page.getByTestId('import-include-2026-09-08').check();
  await expect(page.getByTestId('import-approve')).toBeEnabled();
  await page.getByTestId('import-approve').click();
  await expect(page.getByTestId('import-done')).toContainText('נקלטו בהצלחה 19 ימי עבודה לדוח חודש ספטמבר 2026');
  await expect(page.getByTestId('import-skipped')).toContainText('חסרה שעת כניסה');
  await page.getByRole('button', { name: 'סגירה' }).last().click();

  await expect(page.getByLabel('כניסה 2026-09-01')).toHaveValue('08:00');
  await expect(page.getByLabel('יציאה 2026-09-07')).toHaveValue('06:00');
  await expect(page.getByTestId('day-2026-09-07')).toContainText('+1');
  await expect(page.getByLabel('יציאה 2026-09-08')).toHaveValue('16:45');
  await expect(page.getByLabel('כניסה 2026-09-15')).toHaveValue(''); // not imported (missing entrance)

  // Imported shifts are ordinary shifts: one undo step removes the whole import.
  await page.getByRole('button', { name: 'ביטול פעולה (Ctrl+Z)' }).click();
  await expect(page.getByLabel('כניסה 2026-09-01')).toHaveValue('');
  await page.getByRole('button', { name: 'ביצוע חוזר (Ctrl+Y)' }).click();
  await expect(page.getByLabel('כניסה 2026-09-01')).toHaveValue('08:00');

  // Re-importing the same file: everything identical, nothing to write.
  await upload(page, 'he-standard.xlsx');
  await expect(page.getByTestId('import-row-2026-09-01')).toContainText('זהה לנתון קיים');
  await expect(page.getByTestId('import-approve')).toBeDisabled();
  await page.getByTestId('import-cancel').click();
  expect(errors).toEqual([]);
});

test('existing data is never overwritten silently', async ({ page }) => {
  await openEmployee(page, 'דנה לוי');
  await page.getByLabel('כניסה 2026-09-01').fill('0700');
  await page.getByLabel('יציאה 2026-09-01').fill('1500');
  await page.getByLabel('יציאה 2026-09-01').press('Enter');
  await upload(page, 'he-standard.xlsx');
  const conflict = page.getByTestId('import-conflict-2026-09-01');
  await expect(conflict).toContainText('07:00–15:00');
  await expect(conflict).toContainText('08:00–17:00');
  await page.getByTestId('import-approve').click();
  await page.getByRole('button', { name: 'סגירה' }).last().click();
  await expect(page.getByLabel('כניסה 2026-09-01')).toHaveValue('07:00'); // kept (default)

  await upload(page, 'he-standard.xlsx');
  await page.getByTestId('import-conflict-2026-09-01').getByRole('radio', { name: 'החלפה בנתון מהקובץ' }).click();
  await page.getByTestId('import-approve').click();
  await page.getByRole('button', { name: 'סגירה' }).last().click();
  await expect(page.getByLabel('כניסה 2026-09-01')).toHaveValue('08:00'); // replaced only on explicit choice
});

test('text PDF with two employees requires choosing the employee', async ({ page }) => {
  await openEmployee(page, 'יוסי כהן');
  await upload(page, 'report-text.pdf');
  await expect(page.getByTestId('import-employee')).toContainText('2 עובדים');
  // The selected employee's name matches one of them → pre-selected; the other employee's rows are excluded.
  await expect(page.getByTestId('import-employee-select')).toHaveValue('יוסי כהן|2044');
  await expect(page.getByTestId('import-counts')).toContainText('זוהו 7 ימים');
  await page.getByTestId('import-employee-select').selectOption('');
  await expect(page.getByTestId('import-approve')).toBeDisabled();
  await page.getByTestId('import-employee-select').selectOption('יוסי כהן|2044');
  await expect(page.getByTestId('import-break-2026-09-06')).toHaveValue('45');
  await page.getByTestId('import-approve').click();
  await expect(page.getByTestId('import-done')).toContainText('נקלטו בהצלחה 6 ימי עבודה');
});

test('wrong month: controlled switch to the month in the file', async ({ page }) => {
  await openEmployee(page, 'משה פרץ');
  await setMonth(page, 2026, 8);
  await upload(page, 'he-standard.xlsx');
  await expect(page.getByTestId('import-wrong-month')).toContainText('ספטמבר 2026');
  await expect(page.getByTestId('import-approve')).toBeDisabled();
  await page.getByTestId('import-month-2026-09').click();
  await expect(page.getByTestId('import-approve')).toBeEnabled();
  await page.getByTestId('import-approve').click();
  await page.getByRole('button', { name: 'סגירה' }).last().click();
  await expect(page.getByRole('heading', { name: 'דוח שעות - משה פרץ - ספטמבר 2026' })).toBeVisible();
});

test('scanned PDF: offline OCR in the browser under the desktop app’s content-security policy', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && /Content Security Policy|Refused/.test(m.text()) && errors.push(m.text()));
  // Same CSP as the Windows app (minus the Tauri IPC scheme), and NO network beyond the app itself.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'localhost') return route.abort();
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if ((headers['content-type'] ?? '').includes('text/html')) headers['content-security-policy'] = tauriCsp;
    await route.fulfill({ response: res, headers });
  });
  await openEmployee(page, 'רונית שמש');
  await upload(page, 'report-scanned.pdf');
  await expect(page.getByTestId('import-preview')).toContainText('PDF סרוק (OCR)');
  await expect(page.getByTestId('import-counts')).toContainText('זוהו 12 ימים');
  await expect(page.getByTestId('import-start-2026-09-01-0')).toHaveValue('07:45');
  await expect(page.getByTestId('import-end-2026-09-17-0')).toHaveValue('16:46');
  // Low-confidence readings are never imported silently: approve the reviewed rows explicitly.
  for (const box of await page.locator('input[data-testid^="import-include-"]:not(:checked):not(:disabled)').all()) await box.check();
  await page.getByTestId('import-approve').click();
  await expect(page.getByTestId('import-done')).toContainText('נקלטו בהצלחה 12 ימי עבודה');
  await page.getByRole('button', { name: 'סגירה' }).last().click();
  await expect(page.getByLabel('כניסה 2026-09-03')).toHaveValue('08:05');
  expect(errors).toEqual([]);
});
