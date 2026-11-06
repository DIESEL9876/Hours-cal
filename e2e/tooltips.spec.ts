/**
 * Warning tooltips ("ציות" / "לבדיקה" / errors): each indicator is its own hover and focus target, only ONE tooltip is
 * visible at a time (rapid pointer moves, keyboard navigation), and it is never clipped by the table or the window.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildDemoDatabase, DEMO_BUSINESS, loadDemo } from './seedPayroll';

async function openSaturdayWorker(page: Page) {
  await loadDemo(page, await buildDemoDatabase(4));
  await page.getByTestId('business-card').filter({ hasText: DEMO_BUSINESS }).getByRole('button', { name: 'כניסה לעסק' }).click();
  await page.getByLabel('חודש', { exact: true }).selectOption('11');
  await page.getByLabel('שנה', { exact: true }).selectOption('2026');
  // Employee #2 (1002) worked on Saturdays: one review ("עבודה ביום שאינו יום עבודה") + one compliance flag.
  await page.getByTestId('employee-row').filter({ hasText: '1002' }).getByRole('button', { name: 'פתיחת דוח שעות' }).click();
  const day = page.getByTestId('day-2026-11-07');
  await expect(day.locator('[data-testid="warning-tip"][data-severity="review"]')).toBeVisible();
  await expect(day.locator('[data-testid="warning-tip"][data-severity="compliance"]')).toBeVisible();
  return day;
}

const visibleTips = (page: Page) => page.locator('[role="tooltip"]:visible');

test('only one tooltip at a time: hover, rapid moves between indicators, row hover', async ({ page }) => {
  const day = await openSaturdayWorker(page);
  const review = day.locator('[data-testid="warning-tip"][data-severity="review"]');
  const compliance = day.locator('[data-testid="warning-tip"][data-severity="compliance"]');

  // Hovering the row (not an indicator) shows nothing — there is no shared hover area.
  await day.locator('td').first().hover();
  await expect(visibleTips(page)).toHaveCount(0);

  await review.hover();
  await expect(visibleTips(page)).toHaveCount(1);
  await expect(visibleTips(page)).toHaveAttribute('data-severity', 'review');

  await compliance.hover();
  await expect(visibleTips(page)).toHaveCount(1);
  await expect(visibleTips(page)).toHaveAttribute('data-severity', 'compliance');

  // Rapid back-and-forth: never two at once.
  for (let i = 0; i < 6; i++) {
    await (i % 2 ? compliance : review).hover();
    expect(await visibleTips(page).count()).toBeLessThanOrEqual(1);
  }
  // The two indicators do not overlap and keep a gap.
  const a = (await review.boundingBox())!;
  const b = (await compliance.boundingBox())!;
  const gap = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  expect(gap).toBeGreaterThanOrEqual(4);

  // The tooltip is fully inside the window (not clipped by the table) and does not cover its own indicator.
  await compliance.hover();
  const tip = (await visibleTips(page).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(tip.x).toBeGreaterThanOrEqual(0);
  expect(tip.y).toBeGreaterThanOrEqual(0);
  expect(tip.x + tip.width).toBeLessThanOrEqual(vp.width);
  expect(tip.y + tip.height).toBeLessThanOrEqual(vp.height);
  const ind = (await compliance.boundingBox())!;
  expect(tip.y >= ind.y + ind.height || tip.y + tip.height <= ind.y).toBe(true);

  // Leaving closes it.
  await page.mouse.move(5, 5);
  await expect(visibleTips(page)).toHaveCount(0);
});

test('keyboard: each indicator is focusable on its own, one tooltip, Escape closes, Enter opens the details', async ({ page }) => {
  const day = await openSaturdayWorker(page);
  const review = day.locator('[data-testid="warning-tip"][data-severity="review"]');
  const compliance = day.locator('[data-testid="warning-tip"][data-severity="compliance"]');
  await review.focus();
  await expect(visibleTips(page)).toHaveCount(1);
  await expect(visibleTips(page)).toHaveAttribute('data-severity', 'review');
  await expect(review).toHaveAttribute('aria-describedby', /tip/);
  await page.keyboard.press('Tab');
  await expect(compliance).toBeFocused();
  await expect(visibleTips(page)).toHaveCount(1);
  await expect(visibleTips(page)).toHaveAttribute('data-severity', 'compliance');
  await expect(visibleTips(page)).toContainText('פעולה:');
  // Focus and hover together still give a single tooltip (the last one activated).
  await review.hover();
  await expect(visibleTips(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(visibleTips(page)).toHaveCount(0);
  await compliance.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('aside h2')).toBeVisible(); // the day details drawer
});

test('summary detail: warning badges also show one tooltip at a time', async ({ page }) => {
  await loadDemo(page, await buildDemoDatabase(4));
  await page.getByTestId('business-card').filter({ hasText: DEMO_BUSINESS }).getByRole('button', { name: 'כניסה לעסק' }).click();
  await page.getByLabel('חודש', { exact: true }).selectOption('11');
  await page.getByLabel('שנה', { exact: true }).selectOption('2026');
  await page.getByRole('button', { name: 'סיכום חודשי' }).click();
  await page.getByTestId('summary-table').getByText('1002').click();
  const tips = page.locator('[data-testid="warning-tip"]');
  await expect(tips.first()).toBeVisible();
  const n = await tips.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 0; i < n; i++) {
    await tips.nth(i).hover();
    await expect(visibleTips(page)).toHaveCount(1);
  }
});
