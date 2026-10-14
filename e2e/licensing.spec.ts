/**
 * Licensing gate wired into the real Hours-Cal entry point (main.tsx).
 * The desktop backend is replaced by an in-page fake (window.__HC_LICENSING_TEST_API__), which the
 * production Tauri build never reads. Rust-side enforcement is covered by the cargo tests.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const AGREEMENT = readFileSync(new URL('../legal/agreement_he.md', import.meta.url), 'utf8');
const DEVICE = 'HC1-7KQ2-ABCD-EFGH-JKMN-PQRS-TVWX';

async function installFake(page: Page, opts: { enforced: boolean }) {
  await page.addInitScript(
    ({ text, device, enforced }) => {
      const s = { accepted: false, license: null as null | { id: string; licensee: string } };
      const route = () =>
        !s.accepted
          ? { route: 'legalAgreement', appVersion: '1.1.3', docVersion: '1.0' }
          : enforced && !s.license
            ? { route: 'activation', deviceId: device, reasonHe: null, recoveryAvailable: true }
            : { route: 'ready', licensee: s.license?.licensee ?? '', organization: null, licenseId: s.license?.id ?? '', expiresAt: null };
      (window as unknown as Record<string, unknown>).__HC_LICENSING_TEST_API__ = {
        startupRoute: async () => route(),
        legalDocument: async () => ({ text, docVersion: '1.0', sha256: 'f'.repeat(64), appVersion: '1.1.3', copyright: '© 2026 עילי נגר | כל הזכויות שמורות', consentLabel: 'קראתי את הסכם הרישיון, תנאי השימוש ומדיניות הפרטיות ואני מסכים/ה להם' }),
        acceptLegal: async () => {
          s.accepted = true;
          return { schema_version: 1, installation_id: 'x', app_version: '1.1.3', legal_doc_version: '1.0', legal_sha256: 'f'.repeat(64), accepted_at_utc: new Date().toISOString(), local_utc_offset_minutes: 180 };
        },
        legalHistory: async () => (s.accepted ? [{ schema_version: 1, installation_id: 'x', app_version: '1.1.3', legal_doc_version: '1.0', legal_sha256: 'f'.repeat(64), accepted_at_utc: '2026-10-13T09:00:00Z', local_utc_offset_minutes: 180 }] : []),
        acceptedText: async () => text,
        declineAndExit: async () => {},
        deviceId: async () => ({ code: device, fallback: false }),
        activate: async (k: string) => {
          if (k.trim() !== 'OWNER-LICENSE') return { route: 'activation', deviceId: device, reasonHe: 'חתימת הרישיון אינה תקפה.', recoveryAvailable: true };
          s.license = { id: 'HCL-2026-OWNER', licensee: 'עילי נגר' };
          return route();
        },
        pickAndImportLicenseFile: async () => null,
        recoveryTables: async () => [{ table: 'employees', rows: 3 }],
        pickFolderAndExport: async () => null,
        copyText: async () => {},
        licenseStatus: async () => ({
          enforced,
          deviceId: device,
          deviceFallback: false,
          licenseId: s.license?.id ?? null,
          licensee: s.license?.licensee ?? null,
          organization: null,
          expiresAt: null,
          state: s.license ? (enforced ? 'valid' : 'pending') : 'none',
          messageHe: null,
        }),
      };
    },
    { text: AGREEMENT, device: DEVICE, enforced: opts.enforced },
  );
}

test('agreement is required before any business data is shown; the app works normally after it', async ({ page }) => {
  await installFake(page, { enforced: false });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'הסכם רישיון, תנאי שימוש ומדיניות פרטיות' })).toBeVisible();
  await expect(page.getByText('בעל התוכנה ומעניק הרישיון: עילי נגר')).toBeVisible();
  await expect(page.getByText('ניהול עסקים')).toHaveCount(0);
  const box = page.getByRole('checkbox', { name: /קראתי את הסכם הרישיון/ });
  await expect(box).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'המשך לאפליקציה' })).toBeDisabled();
  await box.check();
  await page.getByRole('button', { name: 'אישור קריאה והסכמה' }).click();
  await page.getByRole('button', { name: 'המשך לאפליקציה' }).click();

  // Not enforced yet: straight to the business list; data features work.
  await expect(page.getByRole('heading', { name: 'ניהול עסקים' })).toBeVisible();
  await expect(page.getByTestId('copyright-footer')).toContainText('© 2026 עילי נגר | כל הזכויות שמורות');
  await expect(page.getByTestId('copyright-footer')).toContainText('1.1.4');
  await page.getByRole('button', { name: 'הקמת עסק חדש' }).first().click();
  await page.getByTestId('business-name-input').fill('עסק לאחר אישור');
  await page.getByRole('button', { name: 'הקמת העסק' }).click();
  await expect(page.getByRole('heading', { name: 'עסק לאחר אישור' })).toBeVisible();

  // Legal & licence page: not-enforced notice, device ID, pre-install, acceptance history.
  await page.getByRole('button', { name: 'מסמכים משפטיים ורישיון' }).click();
  await expect(page.getByTestId('license-mode')).toContainText('דרישת הרישיון טרם הופעלה');
  await expect(page.getByTestId('status-device-id')).toHaveText(DEVICE);
  await page.getByLabel(/מפתח הפעלה/).fill('OWNER-LICENSE');
  await page.getByRole('button', { name: 'שמירת הרישיון' }).click();
  await expect(page.getByTestId('license-state')).toContainText('החתימה תאומת');
  await expect(page.getByText('HCL-2026-OWNER')).toBeVisible();
  await expect(page.getByText(/גרסה 1.1.3, נוסח 1.0, אושר/)).toBeVisible();
  // reviewing the documents never asks for acceptance again
  await page.getByRole('button', { name: 'צפייה בהסכם הרישיון ובמדיניות הפרטיות' }).click();
  await expect(page.getByRole('heading', { name: 'מסמכים משפטיים', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});

test('enforced build: activation is required, wrong key rejected, owner licence opens the app', async ({ page }) => {
  await installFake(page, { enforced: true });
  await page.goto('/');
  await page.getByRole('checkbox', { name: /קראתי את הסכם הרישיון/ }).check();
  await page.getByRole('button', { name: 'אישור קריאה והסכמה' }).click();
  await page.getByRole('button', { name: 'המשך לאפליקציה' }).click();

  await expect(page.getByRole('heading', { name: 'הפעלת רישיון' })).toBeVisible();
  await expect(page.getByTestId('device-id')).toHaveText(DEVICE);
  await expect(page.getByText('ניהול עסקים')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ייצוא נתונים קיימים (קריאה בלבד)' })).toBeVisible();

  await page.getByLabel('מפתח הפעלה').fill('FORGED');
  await page.getByRole('button', { name: 'הפעלת הרישיון' }).click();
  await expect(page.getByRole('alert')).toContainText('חתימת הרישיון אינה תקפה');
  await expect(page.getByText('ניהול עסקים')).toHaveCount(0);

  await page.getByLabel('מפתח הפעלה').fill('OWNER-LICENSE');
  await page.getByRole('button', { name: 'הפעלת הרישיון' }).click();
  await expect(page.getByRole('heading', { name: 'הרישיון הופעל בהצלחה' })).toBeVisible();
  await page.getByRole('button', { name: 'המשך לבחירת עסק' }).click();
  await expect(page.getByRole('heading', { name: 'ניהול עסקים' })).toBeVisible();
  await page.getByRole('button', { name: 'מסמכים משפטיים ורישיון' }).click();
  await expect(page.getByTestId('license-state')).toContainText('רישיון תקף ומאומת');
});
