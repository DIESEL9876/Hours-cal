// In-memory stand-in for the Rust backend, used only by UI tests and browser previews.
// It never performs real signing (tokens are fake); the real logic is tested in Rust.
import type { AppInfo, FieldError, Issued, IssueRequest, KeyInfo, LicenseView, LmApi, MyDevice, PathKind, Stats, VaultStatus } from '../types';

const CROCKFORD = /^HC[1F](-[0-9A-HJKMNP-TV-Z]{4}){6}$/;

export interface MockOptions {
  state?: VaultStatus['state'];
  licenses?: LicenseView[];
  today?: string;
  device?: MyDevice;
  /** Paths the next pickSave/pickOpen calls return (default: a fixed path per kind). */
  pick?: Partial<Record<PathKind, string | null>>;
}

export interface MockApi extends LmApi {
  calls: { name: string; args: unknown[] }[];
  copied: string[];
  revealed: string[];
  key: KeyInfo | null;
}

const KEY: KeyInfo = { keyId: 'k-3f9a1c2b7d4e5f60', publicKey: 'Zm9yLXRlc3RzLW9ubHktbm90LWEtcmVhbC1rZXktMDAwMDA=', createdAt: '2026-10-01T08:00:00Z', protection: 'dpapi-user' };

function err(code: string, message: string, fields: FieldError[] = []) {
  return { code, message, fields };
}

export function sampleLicense(over: Partial<LicenseView> = {}): LicenseView {
  return {
    licenseId: 'HCL-2026-AAAA1111',
    licensee: 'משרד כהן ייעוץ מס',
    deviceId: 'HC1-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12',
    nickname: 'מחשב קבלה',
    licenseType: 'perpetual',
    issuedAt: '2026-10-01',
    expiresAt: null,
    notes: null,
    filePath: 'C:\\Users\\owner\\Documents\\Hours-Cal Licenses\\משרד כהן ייעוץ מס - HCL-2026-AAAA1111.hclic',
    token: 'eyJmb3JtYXQiOiJ0ZXN0In0.c2lnbmF0dXJl',
    replaces: null,
    keyId: KEY.keyId,
    revokedAt: null,
    revokeReason: null,
    createdAt: '2026-10-01T08:00:00Z',
    status: 'valid',
    statusHe: 'בתוקף',
    replacedBy: null,
    replacesChain: [],
    ...over,
  };
}

export function createMockApi(o: MockOptions = {}): MockApi {
  const today = o.today ?? '2026-10-13';
  let key: KeyInfo | null = o.state === 'ready' || o.state === undefined ? KEY : null;
  const configured = o.state === 'keyUnavailable' ? KEY.keyId : null;
  let records: LicenseView[] = o.licenses ? [...o.licenses] : [];
  let licenseDir = 'C:\\Users\\owner\\Documents\\Hours-Cal Licenses';
  let lastBackupAt: string | null = null;
  let seq = 0;
  const pick = o.pick ?? {};

  const recompute = () => {
    const replacedBy = new Map<string, string>();
    records.forEach((r) => r.replaces && replacedBy.set(r.replaces, r.licenseId));
    records = records.map((r) => {
      let status: LicenseView['status'] = 'valid';
      if (r.revokedAt) status = 'revoked';
      else if (replacedBy.has(r.licenseId)) status = 'replaced';
      else if (!key || r.keyId !== key.keyId) status = 'unverifiable';
      else if (r.expiresAt && r.expiresAt < today) status = 'expired';
      const he = { valid: 'בתוקף', expired: 'פג תוקף', revoked: 'מבוטל', replaced: 'הוחלף', unverifiable: 'לא ניתן לאימות' }[status];
      return { ...r, status, statusHe: he, replacedBy: replacedBy.get(r.licenseId) ?? null };
    });
  };
  recompute();

  const api: MockApi = {
    calls: [],
    copied: [],
    revealed: [],
    get key() {
      return key;
    },
    async appInfo(): Promise<AppInfo> {
      return { version: '1.0.0', dataDir: 'C:\\Users\\owner\\AppData\\Local\\il.owner.hourscal.licensemanager', licenseDir, protection: 'dpapi-user', minPassphraseChars: 12, lastBackupAt, lastBackupKeyId: lastBackupAt ? key?.keyId ?? null : null, today };
    },
    async setLicenseDir(p) {
      licenseDir = p;
      return p;
    },
    async vaultStatus(): Promise<VaultStatus> {
      if (key) return { state: 'ready', key, configuredKeyId: key.keyId, problem: null, publicKeyPath: 'C:\\…\\license_public_key.txt' };
      if (configured) return { state: 'keyUnavailable', key: null, configuredKeyId: configured, problem: 'קובץ המפתח חסר', publicKeyPath: '' };
      return { state: 'noKey', key: null, configuredKeyId: null, problem: null, publicKeyPath: '' };
    },
    async vaultCreate(confirm) {
      api.calls.push({ name: 'vaultCreate', args: [confirm] });
      if (key) throw err('ALREADY_CONFIGURED', 'כבר מוגדר מפתח חתימה.');
      if (configured && confirm !== 'מפתח חדש') throw err('CONFIRMATION_REQUIRED', 'נדרש אישור.');
      key = { ...KEY, keyId: configured ? 'k-0000aaaa1111bbbb' : KEY.keyId };
      recompute();
      return key;
    },
    async vaultImportCliKey(path, confirm) {
      api.calls.push({ name: 'vaultImportCliKey', args: [path, confirm] });
      key = KEY;
      recompute();
      return key;
    },
    async exportPublicKey(out) {
      api.calls.push({ name: 'exportPublicKey', args: [out] });
      if (!key) throw err('NOT_CONFIGURED', 'לא הוגדר מפתח.');
      return out;
    },
    async backupCreate(pass, out) {
      api.calls.push({ name: 'backupCreate', args: ['***', out] });
      if (pass.length < 12) throw err('WEAK_PASSPHRASE', 'סיסמת הגיבוי חייבת לכלול לפחות 12 תווים.');
      lastBackupAt = '2026-10-13T09:00:00Z';
      return { keyId: key!.keyId, createdAt: lastBackupAt, licenses: records.length };
    },
    async backupPeek(path) {
      api.calls.push({ name: 'backupPeek', args: [path] });
      return KEY.keyId;
    },
    async backupRestore(path, pass, confirm) {
      api.calls.push({ name: 'backupRestore', args: [path, '***', confirm] });
      if (pass !== 'correct horse battery') throw err('WRONG_PASSPHRASE', 'הסיסמה שגויה או שקובץ הגיבוי פגום או שונה. לא שוחזר דבר.');
      key = KEY;
      recompute();
      return { key, licensesInBackup: 3, licensesAdded: 3 };
    },
    async myDevice() {
      return o.device ?? { deviceId: 'HC1-MY00-PC00-1234-5678-9ABC-DEFG', source: 'windows', note: 'זהה למזהה ההפעלה ש-Hours-Cal מציגה במחשב זה.' };
    },
    async listLicenses() {
      return records.map((r) => ({ ...r }));
    },
    async stats(): Promise<Stats> {
      const c = (s: LicenseView['status']) => records.filter((r) => r.status === s).length;
      return {
        total: records.length,
        perpetual: records.filter((r) => r.licenseType === 'perpetual').length,
        limited: records.filter((r) => r.licenseType === 'limited').length,
        valid: c('valid'),
        expired: c('expired'),
        revoked: c('revoked'),
        replaced: c('replaced'),
        unverifiable: c('unverifiable'),
      };
    },
    async issueLicense(req: IssueRequest): Promise<Issued> {
      api.calls.push({ name: 'issueLicense', args: [req] });
      const fields: FieldError[] = [];
      const dev = req.deviceId.replace(/\s/g, '').toUpperCase();
      if (!req.licensee.trim()) fields.push({ field: 'licensee', message: 'יש להזין שם בעל הרישיון או שם החברה.' });
      if (!dev) fields.push({ field: 'deviceId', message: 'יש להזין את מזהה ההפעלה של המחשב.' });
      else if (!CROCKFORD.test(dev)) fields.push({ field: 'deviceId', message: 'מזהה ההפעלה אינו תקין.' });
      if (req.licenseType === 'limited' && !req.expiresAt) fields.push({ field: 'expiresAt', message: 'ברישיון מוגבל בזמן יש לבחור תאריך תפוגה.' });
      else if (req.licenseType === 'limited' && req.expiresAt! < today) fields.push({ field: 'expiresAt', message: 'תאריך התפוגה כבר עבר.' });
      if (fields.length) throw err('VALIDATION', 'יש לתקן את השדות המסומנים.', fields);
      if (!key) throw err('NOT_CONFIGURED', 'לא הוגדר מפתח.');
      const id = `HCL-2026-TEST${String(++seq).padStart(4, '0')}`;
      const filePath = `${licenseDir}\\${req.licensee.trim()} - ${id}.hclic`;
      const rec = sampleLicense({
        licenseId: id,
        licensee: req.licensee.trim(),
        deviceId: dev,
        nickname: req.nickname?.trim() || null,
        licenseType: req.licenseType,
        issuedAt: today,
        expiresAt: req.licenseType === 'limited' ? req.expiresAt! : null,
        notes: req.notes?.trim() || null,
        replaces: req.replaces ?? null,
        filePath,
        token: `token-${id}`,
      });
      records.push(rec);
      recompute();
      return { license: records.find((r) => r.licenseId === id)!, filePath, activationKey: rec.token };
    },
    async reexportLicense(id) {
      api.calls.push({ name: 'reexportLicense', args: [id] });
      const r = records.find((x) => x.licenseId === id)!;
      return `${licenseDir}\\${r.licensee} - ${id} (1).hclic`;
    },
    async setRevoked(id, revoked, reason) {
      api.calls.push({ name: 'setRevoked', args: [id, revoked, reason] });
      records = records.map((r) => (r.licenseId === id ? { ...r, revokedAt: revoked ? '2026-10-13T09:00:00Z' : null, revokeReason: revoked ? reason ?? null : null } : r));
      recompute();
    },
    async exportRevocationList(out) {
      api.calls.push({ name: 'exportRevocationList', args: [out] });
      return records.filter((r) => r.revokedAt).length;
    },
    async revealPath(p) {
      api.revealed.push(p);
    },
    async pickSave(kind, name) {
      return kind in pick ? pick[kind]! : `C:\\Users\\owner\\Desktop\\${name}`;
    },
    async pickOpen(kind) {
      return kind in pick ? pick[kind]! : kind === 'folder' ? 'D:\\Licenses' : `E:\\backup.${kind === 'backup' ? 'hckeybak' : 'txt'}`;
    },
    async copyText(t) {
      api.copied.push(t);
    },
  };
  return api;
}
