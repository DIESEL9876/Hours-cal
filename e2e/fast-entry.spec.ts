/**
 * Guard (1.1.10) for fast typing in the attendance grid: entry → exit → break, with the CPU throttled.
 *
 * Background: once, in a full e2e run, an exit time typed while the entry-only save was still in flight was lost (the
 * row still believed it had no shift and tried to create a second, overlapping one). Rows now serialise their commits
 * and always build on their own latest shift. This test could NOT reproduce that timing on demand (it also passes on
 * the old code); it guards the behaviour, it is not proof of the original race.
 */
import { expect, test } from '@playwright/test';

test('fast entry → exit typing keeps every value', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  await page.getByTestId('business-name-input').fill('עסק הקלדה מהירה');
  await page.getByRole('button', { name: 'הקמת העסק' }).click();
  await page.getByRole('button', { name: 'הוספת עובד' }).first().click();
  await page.getByTestId('employee-name-input').fill('עובד מהיר');
  await page.getByTestId('save-employee').click();
  await page.getByLabel('חודש', { exact: true }).selectOption('11');
  await page.getByLabel('שנה', { exact: true }).selectOption('2026');
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).first().click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 30 });
  for (const d of ['02', '03', '04']) {
    await page.getByLabel(`כניסה 2026-11-${d}`).fill('0800');
    await page.getByLabel(`יציאה 2026-11-${d}`).fill('1600');
    await page.getByLabel(`יציאה 2026-11-${d}`).press('Enter');
    await page.getByLabel(`הפסקה 2026-11-${d}`).fill('30');
    await page.getByLabel(`הפסקה 2026-11-${d}`).press('Enter');
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  for (const d of ['02', '03', '04']) await expect(page.getByLabel(`יציאה 2026-11-${d}`)).toHaveValue('16:00');
  await expect(page.getByTestId('total-net')).toHaveText('22:30');
  await page.reload();
  await page.getByTestId('business-card').filter({ hasText: 'עסק הקלדה מהירה' }).getByRole('button', { name: 'כניסה לעסק' }).click();
  await page.getByLabel('חודש', { exact: true }).selectOption('11');
  await page.getByLabel('שנה', { exact: true }).selectOption('2026');
  await page.getByRole('button', { name: 'פתיחת דוח שעות' }).first().click();
  await expect(page.getByTestId('total-net')).toHaveText('22:30');
});
