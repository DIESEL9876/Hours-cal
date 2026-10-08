/**
 * End-to-end test of the real UI (browser build, sql.js + IndexedDB storage).
 * Verifies the main workflow, calculations shown on screen, persistence, undo/redo, exports and finalisation.
 */
import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';

async function setMonth(page: Page, year: number, month: number) {
  await page.getByLabel('חודש', { exact: true }).selectOption(String(month));
  await page.getByLabel('שנה', { exact: true }).selectOption(String(year));
}

async function enterShift(page: Page, date: string, start: string, end: string) {
  await page.getByLabel(`כניסה ${date}`).fill(start);
  await page.getByLabel(`יציאה ${date}`).fill(end);
  await page.getByLabel(`יציאה ${date}`).press('Enter');
  await expect(page.getByLabel(`יציאה ${date}`)).not.toHaveClass(/invalid/);
}

test('full workflow: business → employee → attendance → summary → export → finalize', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ניהול עסקים' })).toBeVisible();

  // --- create two businesses (isolation) ---------------------------------
  for (const name of ['עסק בדיקה א', 'עסק בדיקה ב']) {
    await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
    await page.getByTestId('business-name-input').fill(name);
    await page.getByRole('button', { name: 'הקמת העסק' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await page.getByRole('button', { name: 'עסקים', exact: true }).click();
  }
  await expect(page.getByTestId('business-name')).toHaveCount(2);
  await page.getByTestId('business-card').filter({ hasText: 'עסק בדיקה א' }).getByRole('button', { name: 'כניסה לעסק' }).click();

  // --- add employee ---------------------------------------------------------
  await page.getByRole('button', { name: 'הוספת עובד' }).first().click();
  await page.getByTestId('employee-name-input').fill('ישראל ישראלי');
  await page.getByTestId('save-employee').click();
  await expect(page.getByTestId('employee-row')).toHaveCount(1);
  await setMonth(page, 2026, 10);
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  await expect(page.getByRole('heading', { name: 'דוח שעות - ישראל ישראלי - אוקטובר 2026' })).toBeVisible();

  // 31 rows for October
  await expect(page.locator('tr[data-testid^="day-"]')).toHaveCount(31);

  // --- Test 1 scenario through the UI: 08:00–18:00, company break 30 → 9:30 net, threshold 8:24, 1:06 at 125% ---------
  await enterShift(page, '2026-10-11', '0800', '1800');
  const row11 = page.getByTestId('day-2026-10-11');
  await expect(row11).toContainText('9:30');
  await expect(row11).toContainText('8:24');
  await expect(row11).toContainText('1:06');
  await expect(page.getByTestId('total-net')).toHaveText('9:30');

  // explanation in the details drawer
  await page.getByTestId('details-2026-10-11').click();
  await expect(page.getByTestId('explanation')).toContainText('תקן היום הוא 8 שעות ו-24 דקות, ולכן חושבו שעה ו-6 דקות נוספות בתעריף 125%.');
  await page.keyboard.press('Escape');

  // --- overnight shift and shortened day ----------------------------------
  await enterShift(page, '2026-10-12', '22', '6');
  await expect(page.getByTestId('day-2026-10-12')).toContainText('+1');
  await expect(page.getByTestId('day-2026-10-12')).toContainText('7:00'); // night threshold
  await enterShift(page, '2026-10-15', '8', '17');
  await expect(page.getByTestId('day-2026-10-15')).toContainText('יום מקוצר');
  await expect(page.getByTestId('day-2026-10-15')).toContainText('7:36');

  // invalid input is rejected, not saved
  await page.getByLabel('כניסה 2026-10-13').fill('25:99');
  await page.getByLabel('כניסה 2026-10-13').press('Enter');
  await expect(page.getByLabel('כניסה 2026-10-13')).toHaveClass(/invalid/);
  await page.getByLabel('כניסה 2026-10-13').fill('');
  await page.getByLabel('כניסה 2026-10-13').press('Tab');

  // incomplete entry is flagged
  await page.getByLabel('כניסה 2026-10-14').fill('9');
  await page.getByLabel('כניסה 2026-10-14').press('Tab');
  await expect(page.getByTestId('day-2026-10-14')).toContainText('רישום חסר');

  // --- undo / redo ----------------------------------------------------------
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('כניסה 2026-10-14')).toHaveValue('');
  await page.keyboard.press('Control+y');
  await expect(page.getByLabel('כניסה 2026-10-14')).toHaveValue('09:00');
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('כניסה 2026-10-14')).toHaveValue('');

  // --- confirm estimated breaks -----------------------------------------------
  await page.getByRole('button', { name: /אישור 3 הפסקות משוערות/ }).click();
  await page.getByRole('button', { name: 'אישור כל ההפסקות' }).click();
  await expect(page.getByRole('button', { name: /הפסקות משוערות/ })).toHaveCount(0);

  const net = await page.getByTestId('total-net').innerText();
  expect(net).toBe('25:30'); // 9:30 + 7:30 + 8:30

  // --- persistence across reload -----------------------------------------------
  await page.reload();
  await page.getByTestId('business-card').filter({ hasText: 'עסק בדיקה א' }).getByRole('button', { name: 'כניסה לעסק' }).click();
  await setMonth(page, 2026, 10);
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  await expect(page.getByTestId('total-net')).toHaveText('25:30');
  await expect(page.getByLabel('כניסה 2026-10-11')).toHaveValue('08:00');

  // --- export employee CSV ------------------------------------------------------
  const csvDl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV' }).click();
  const csv = readFileSync(await (await csvDl).path()!, 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const totalLine = csv.split('\r\n').find((l) => l.startsWith('סה״כ'))!;
  expect(totalLine).toContain('25:30');
  expect(totalLine).toContain('25.50');

  // --- business summary -----------------------------------------------------------
  await page.getByRole('button', { name: 'חזרה לעובדים' }).click();
  await page.getByRole('button', { name: 'סיכום חודשי' }).click();
  await expect(page.getByRole('heading', { name: 'סיכום שעות עובדים - אוקטובר 2026' })).toBeVisible();
  await expect(page.getByTestId('grand-total')).toContainText('25:30');

  // export XLSX and verify totals match the screen
  const xlsxDl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile((await (await xlsxDl).path())!);
  const ws = wb.getWorksheet('סיכום')!;
  expect(ws.views[0].rightToLeft).toBe(true);
  expect(String(ws.getCell('A2').value)).toContain('5 ימים 8:24 (מדיניות המשרד)');
  // ExcelJS reads [h]:mm cells back as Dates; convert from the Excel serial (epoch 1899-12-30).
  const minutesOf = (v: unknown) => Math.round((v instanceof Date ? (v.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000 : (v as number)) * 1440);
  const headerRow = ws.getRow(4);
  let netCol = 0;
  let netDecCol = 0;
  headerRow.eachCell((c, col) => {
    if (c.value === 'סה״כ שעות נטו') netCol = col;
    if (c.value === 'סה״כ שעות נטו (עשרוני)') netDecCol = col;
  });
  let grandNet: number | null = null;
  let grandDec: number | null = null;
  ws.eachRow((row) => {
    if (row.getCell(1).value === 'סה״כ לעסק') {
      grandNet = minutesOf(row.getCell(netCol).value);
      grandDec = row.getCell(netDecCol).value as number;
    }
  });
  expect(grandNet).toBe(25 * 60 + 30);
  expect(grandDec).toBe(25.5);
  expect(wb.getWorksheet('פירוט יומי')!.rowCount).toBeGreaterThan(4);

  // finalisation: compliance/review acknowledgement required, then final with snapshot
  const finalize = page.getByTestId('finalize');
  const reviewBox = page.getByLabel('בדקתי את הסימונים לבדיקה והם מטופלים');
  if (await reviewBox.count()) {
    await expect(finalize).toBeDisabled();
    await reviewBox.check();
  }
  const complianceBox = page.getByLabel('ראיתי את אזהרות הציות');
  if (await complianceBox.count()) await complianceBox.check();
  await expect(finalize).toBeEnabled();
  await finalize.click();
  await expect(page.getByTestId('review-status')).toHaveText('נסגר לאחר בדיקה');

  // a change after finalisation is detected
  await page.getByRole('button', { name: 'חזרה לעובדים' }).click();
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  await enterShift(page, '2026-10-20', '8', '12');
  await page.getByRole('button', { name: 'חזרה לעובדים' }).click();
  await page.getByRole('button', { name: 'סיכום חודשי' }).click();
  await expect(page.getByText('הנתונים השתנו לאחר סגירת החודש.')).toBeVisible();

  // --- business isolation: the second business has no employees ---------------
  await page.getByRole('button', { name: 'עסקים', exact: true }).first().click();
  await page.getByTestId('business-card').filter({ hasText: 'עסק בדיקה ב' }).getByRole('button', { name: 'כניסה לעסק' }).click();
  await expect(page.getByText('אין עובדים בעסק')).toBeVisible();

  // --- archive protection: requires typing the business name -----------------
  await page.getByRole('button', { name: 'עסקים', exact: true }).first().click();
  await page.getByTestId('business-card').filter({ hasText: 'עסק בדיקה ב' }).getByRole('button', { name: 'עריכת פרטי עסק' }).click();
  await page.getByRole('button', { name: 'העברה לארכיון' }).click();
  const confirmBtn = page.getByRole('dialog').last().getByRole('button', { name: 'העברה לארכיון' });
  await expect(confirmBtn).toBeDisabled();
  await page.getByLabel(/להמשך יש להקליד/).fill('עסק בדיקה ב');
  await confirmBtn.click();
  await expect(page.getByTestId('business-name')).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('backups: create and restore', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'גיבוי ונתונים' }).click();
  await page.getByRole('button', { name: 'יצירת גיבוי עכשיו' }).click();
  await expect(page.getByText('גיבוי ידני').first()).toBeVisible();
  await page.getByRole('button', { name: 'שחזור' }).first().click();
  await page.getByLabel(/להמשך יש להקליד/).fill('שחזור');
  await page.getByRole('dialog').getByRole('button', { name: 'שחזור' }).click();
  await expect(page.getByText('הנתונים שוחזרו מהגיבוי')).toBeVisible();
  await expect(page.getByText('לפני שחזור').first()).toBeVisible();
});
