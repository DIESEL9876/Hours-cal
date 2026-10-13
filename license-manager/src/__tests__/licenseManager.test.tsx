// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { createMockApi, sampleLicense, type MockApi } from '../testing/mockApi';
import { deviceIdProblem, normalizeDeviceId } from '../screens/IssueDialog';
import { passphraseStrength } from '../screens/BackupDialogs';
import { matches } from '../screens/Dashboard';
import { addMonths, licenseInfoText } from '../format';

const GOOD_DEVICE = 'HC1-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12';

function setup(api: MockApi) {
  const user = userEvent.setup();
  render(<App api={api} />);
  return user;
}

const sample = () => [
  sampleLicense(),
  sampleLicense({ licenseId: 'HCL-2026-BBBB2222', licensee: 'לוי ושות׳', nickname: 'מחשב מנהלת', deviceId: 'HC1-7Q2M-K9XD-4RTP-ZB3N-HW6C-1F8E', licenseType: 'limited', expiresAt: '2027-06-30' }),
  sampleLicense({ licenseId: 'HCL-2026-EEEE5555', licensee: 'ניסיון', deviceId: 'HC1-5555-6666-7777-8888-9999-AAAA', licenseType: 'limited', expiresAt: '2026-10-10' }),
];

describe('helpers', () => {
  it('normalises device IDs like the Rust side', () => {
    expect(normalizeDeviceId(' hc1-abcd-efgh-jkmn-pqrs-tvwx-yz12 ')).toBe(GOOD_DEVICE);
    expect(normalizeDeviceId('HC1-OOOO-IIII-LLLL-0000-1111-2222')).toBe('HC1-0000-1111-1111-0000-1111-2222');
    expect(deviceIdProblem(GOOD_DEVICE)).toBeNull();
    expect(deviceIdProblem('HC1-ABCD')).not.toBeNull();
    expect(deviceIdProblem('HC1-ABCD-EFGH-JKMN-PQRS-TVWX-YZU2')).not.toBeNull(); // U is not Crockford
    expect(deviceIdProblem('')).toBeNull();
  });
  it('passphrase strength enforces the minimum length', () => {
    expect(passphraseStrength('short', 12).score).toBe(0);
    expect(passphraseStrength('abcdefghijkl', 12).score).toBe(1);
    expect(passphraseStrength('correct horse battery staple', 12).score).toBe(3);
  });
  it('search matches names, IDs and device IDs with or without dashes', () => {
    const l = sampleLicense();
    expect(matches(l, 'כהן')).toBe(true);
    expect(matches(l, 'aaaa1111')).toBe(true);
    expect(matches(l, 'abcdefgh')).toBe(true);
    expect(matches(l, 'zzz')).toBe(false);
  });
  it('licence info text contains only public details', () => {
    const t = licenseInfoText(sampleLicense());
    expect(t).toContain('HCL-2026-AAAA1111');
    expect(t).toContain(GOOD_DEVICE);
    expect(t).toContain('ללא הגבלה');
  });
  it('adds months with month-end clamping', () => {
    expect(addMonths('2026-10-13', 12)).toBe('2027-10-13');
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
  });
});

describe('first-time setup', () => {
  it('creates the key only after acknowledgement, then asks for a backup', async () => {
    const api = createMockApi({ state: 'noKey' });
    const user = setup(api);
    await screen.findByTestId('setup-screen');
    const create = screen.getByTestId('create-key');
    expect(create).toBeDisabled();
    await user.click(screen.getByLabelText('קראתי והבנתי'));
    await user.click(create);
    await screen.findByTestId('dashboard');
    expect(api.calls.filter((c) => c.name === 'vaultCreate')).toEqual([{ name: 'vaultCreate', args: [undefined] }]);
    expect(await screen.findByTestId('backup-dialog')).toBeInTheDocument();
  });

  it('when the configured key is unavailable: no silent regeneration, replacement needs the typed confirmation', async () => {
    const api = createMockApi({ state: 'keyUnavailable' });
    const user = setup(api);
    await screen.findByTestId('setup-screen');
    expect(screen.getByText('מפתח החתימה אינו זמין במחשב זה')).toBeInTheDocument();
    expect(screen.queryByTestId('create-key')).toBeNull();
    await user.click(screen.getByTestId('create-replacement-key'));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'יצירת מפתח חדש' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'מפתח');
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    expect(api.calls.some((c) => c.name === 'vaultCreate')).toBe(false);
    // Now confirm properly.
    await user.click(screen.getByTestId('create-replacement-key'));
    const d2 = await screen.findByRole('dialog');
    await user.type(within(d2).getByRole('textbox'), 'מפתח חדש');
    await user.click(within(d2).getByRole('button', { name: 'יצירת מפתח חדש' }));
    await screen.findByTestId('dashboard');
    expect(api.calls.find((c) => c.name === 'vaultCreate')?.args).toEqual(['מפתח חדש']);
  });

  it('restores from a backup (wrong passphrase first)', async () => {
    const api = createMockApi({ state: 'keyUnavailable' });
    const user = setup(api);
    await user.click(await screen.findByTestId('restore-key'));
    await user.click(await screen.findByTestId('restore-choose'));
    expect(await screen.findByTestId('restore-key-info')).toHaveTextContent('k-3f9a1c2b7d4e5f60');
    await user.type(screen.getByTestId('restore-pass'), 'wrong passphrase!!');
    await user.click(screen.getByTestId('restore-submit'));
    expect(await screen.findByTestId('restore-error')).toHaveTextContent('הסיסמה שגויה');
    await user.clear(screen.getByTestId('restore-pass'));
    await user.type(screen.getByTestId('restore-pass'), 'correct horse battery');
    await user.click(screen.getByTestId('restore-submit'));
    expect(await screen.findByTestId('restore-success')).toHaveTextContent('שוחזר');
    await user.click(screen.getByRole('button', { name: 'המשך' }));
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
  });
});

describe('dashboard', () => {
  it('shows stats, the four main actions and the backup warning', async () => {
    setup(createMockApi({ licenses: sample() }));
    await screen.findByTestId('license-table');
    expect(screen.getByTestId('stat-total')).toHaveTextContent('3');
    expect(screen.getByTestId('stat-perpetual')).toHaveTextContent('1');
    expect(screen.getByTestId('stat-limited')).toHaveTextContent('2');
    expect(screen.getByTestId('stat-expired')).toHaveTextContent('1');
    for (const name of ['הפקת רישיון חדש', 'גיבוי מפתחות', 'שחזור מפתחות', 'פרטי המחשב שלי']) expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0);
    expect(screen.getByTestId('backup-warning')).toBeInTheDocument();
  });

  it('searches and filters the registry', async () => {
    const user = setup(createMockApi({ licenses: sample() }));
    await screen.findByTestId('license-table');
    const rows = () => within(screen.getByTestId('license-table')).getAllByRole('row').length - 1;
    expect(rows()).toBe(3);
    await user.type(screen.getByTestId('search'), 'מנהלת');
    expect(rows()).toBe(1);
    await user.clear(screen.getByTestId('search'));
    await user.click(screen.getByRole('radio', { name: 'קבועים' }));
    expect(rows()).toBe(1);
    await user.click(screen.getByRole('radio', { name: 'הכול' }));
    await user.selectOptions(screen.getByTestId('status-filter'), 'expired');
    expect(screen.getByTestId('row-HCL-2026-EEEE5555')).toBeInTheDocument();
    expect(rows()).toBe(1);
  });

  it('marks a licence revoked only after a confirmation that explains offline limits', async () => {
    const api = createMockApi({ licenses: sample() });
    const user = setup(api);
    await user.click(await screen.findByTestId('row-HCL-2026-AAAA1111'));
    await user.click(screen.getByTestId('btn-revoke'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('אינו עוצר אותו מרחוק');
    await user.click(within(dialog).getByRole('button', { name: 'סימון כמבוטל' }));
    await waitFor(() => expect(api.calls.some((c) => c.name === 'setRevoked')).toBe(true));
    await waitFor(() => expect(within(screen.getByTestId('row-HCL-2026-AAAA1111')).getByText('מבוטל')).toBeInTheDocument());
  });

  it('issues a replacement licence from the details drawer', async () => {
    const api = createMockApi({ licenses: sample() });
    const user = setup(api);
    await user.click(await screen.findByTestId('row-HCL-2026-AAAA1111'));
    await user.click(screen.getByTestId('btn-replace'));
    expect(await screen.findByText('הנפקת רישיון חלופי')).toBeInTheDocument();
    expect(screen.getByTestId('f-licensee')).toHaveValue('משרד כהן ייעוץ מס');
    await user.type(screen.getByTestId('f-device'), 'HC1-ZZZZ-YYYY-XXXX-WWWW-VVVV-TTTT');
    await user.click(screen.getByTestId('issue-submit'));
    await screen.findByTestId('issue-success');
    const req = api.calls.find((c) => c.name === 'issueLicense')!.args[0] as { replaces: string };
    expect(req.replaces).toBe('HCL-2026-AAAA1111');
  });
});

describe('issuing', () => {
  it('rejects an invalid device ID without calling the backend', async () => {
    const api = createMockApi();
    const user = setup(api);
    await user.click(await screen.findByTestId('btn-issue'));
    await user.type(screen.getByTestId('f-licensee'), 'משרד כהן');
    await user.type(screen.getByTestId('f-device'), 'HC1-1234');
    await user.click(screen.getByTestId('issue-submit'));
    expect(await screen.findByText(/מזהה ההפעלה אינו תקין/)).toBeInTheDocument();
    expect(api.calls.some((c) => c.name === 'issueLicense')).toBe(false);
  });

  it('issues a perpetual licence and offers copy / open-folder', async () => {
    const api = createMockApi();
    const user = setup(api);
    await user.click(await screen.findByTestId('btn-issue'));
    await user.type(screen.getByTestId('f-licensee'), 'משרד כהן');
    await user.type(screen.getByTestId('f-device'), GOOD_DEVICE.toLowerCase());
    await user.type(screen.getByTestId('f-nickname'), 'קבלה');
    await user.click(screen.getByTestId('issue-submit'));
    const ok = await screen.findByTestId('issue-success');
    expect(ok).toHaveTextContent('קבוע (ללא הגבלת זמן)');
    const req = api.calls.find((c) => c.name === 'issueLicense')!.args[0] as { deviceId: string; licenseType: string; expiresAt: string | null };
    expect(req).toMatchObject({ deviceId: GOOD_DEVICE, licenseType: 'perpetual', expiresAt: null });
    await user.click(screen.getByTestId('issued-copy-info'));
    expect(api.copied[0]).toContain(screen.getByTestId('issued-id').textContent!);
    await user.click(screen.getByTestId('issued-reveal'));
    expect(api.revealed[0]).toMatch(/\.hclic$/);
  });

  it('requires an expiry date for a time-limited licence', async () => {
    const api = createMockApi();
    const user = setup(api);
    await user.click(await screen.findByTestId('btn-issue'));
    await user.type(screen.getByTestId('f-licensee'), 'ניסיון');
    await user.type(screen.getByTestId('f-device'), GOOD_DEVICE);
    await user.click(screen.getByRole('radio', { name: 'מוגבל בזמן' }));
    await user.click(screen.getByTestId('issue-submit'));
    expect(await screen.findByText('ברישיון מוגבל בזמן יש לבחור תאריך תפוגה.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'שנה' }));
    expect(screen.getByTestId('f-expires')).toHaveValue('2027-10-13');
    await user.click(screen.getByTestId('issue-submit'));
    expect(await screen.findByTestId('issue-success')).toHaveTextContent('13/10/2027');
  });

  it('issues a licence for this computer from "פרטי המחשב שלי"', async () => {
    const api = createMockApi();
    const user = setup(api);
    await user.click(await screen.findByTestId('btn-my-computer'));
    expect(await screen.findByTestId('my-device-id')).toHaveTextContent('HC1-MY00-PC00-1234-5678-9ABC-DEFG');
    await user.click(screen.getByTestId('issue-for-me'));
    expect(screen.getByTestId('f-device')).toHaveValue('HC1-MY00-PC00-1234-5678-9ABC-DEFG');
    expect(screen.getByTestId('f-nickname')).toHaveValue('המחשב שלי');
  });

  it('exports the PUBLIC key file', async () => {
    const api = createMockApi();
    const user = setup(api);
    await user.click(await screen.findByTestId('btn-my-computer'));
    await user.click(await screen.findByTestId('export-public-key'));
    await waitFor(() => expect(api.calls.find((c) => c.name === 'exportPublicKey')?.args[0]).toMatch(/license_public_key\.txt$/));
  });
});

describe('backup', () => {
  it('needs a long, confirmed passphrase and acknowledgement', async () => {
    const api = createMockApi();
    const user = setup(api);
    await user.click(await screen.findByTestId('btn-backup'));
    const save = screen.getByTestId('backup-save');
    await user.type(screen.getByTestId('backup-pass'), 'short');
    await user.type(screen.getByTestId('backup-pass2'), 'short');
    await user.click(screen.getByRole('checkbox'));
    expect(save).toBeDisabled();
    await user.clear(screen.getByTestId('backup-pass'));
    await user.clear(screen.getByTestId('backup-pass2'));
    await user.type(screen.getByTestId('backup-pass'), 'correct horse battery staple');
    await user.type(screen.getByTestId('backup-pass2'), 'correct horse battery stapl');
    expect(screen.getByText('הסיסמאות אינן זהות.')).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.type(screen.getByTestId('backup-pass2'), 'e');
    expect(save).toBeEnabled();
    await user.click(save);
    expect(await screen.findByTestId('backup-success')).toHaveTextContent('k-3f9a1c2b7d4e5f60');
    const call = api.calls.find((c) => c.name === 'backupCreate')!;
    expect(call.args[1]).toMatch(/\.hckeybak$/);
    await user.click(screen.getAllByRole('button', { name: 'סגירה' }).at(-1)!);
    await waitFor(() => expect(screen.queryByTestId('backup-warning')).toBeNull());
  });
});
