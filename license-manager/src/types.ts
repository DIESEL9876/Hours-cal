// Data shapes returned by the Rust backend (serde camelCase). No type here ever carries the private key.

export interface KeyInfo {
  keyId: string;
  publicKey: string;
  createdAt: string;
  protection: string;
}

export type VaultState = 'noKey' | 'ready' | 'keyUnavailable';

export interface VaultStatus {
  state: VaultState;
  key: KeyInfo | null;
  configuredKeyId: string | null;
  problem: string | null;
  publicKeyPath: string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  licenseDir: string;
  protection: string;
  minPassphraseChars: number;
  lastBackupAt: string | null;
  lastBackupKeyId: string | null;
  today: string;
}

export type LicenseType = 'perpetual' | 'limited';
export type LicenseStatus = 'valid' | 'expired' | 'revoked' | 'replaced' | 'unverifiable';

export interface LicenseView {
  licenseId: string;
  licensee: string;
  deviceId: string;
  nickname: string | null;
  licenseType: LicenseType;
  issuedAt: string;
  expiresAt: string | null;
  notes: string | null;
  filePath: string | null;
  /** Public activation key (signed token). */
  token: string;
  replaces: string | null;
  keyId: string;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
  status: LicenseStatus;
  statusHe: string;
  replacedBy: string | null;
  replacesChain: string[];
}

export interface Stats {
  total: number;
  perpetual: number;
  limited: number;
  valid: number;
  expired: number;
  revoked: number;
  replaced: number;
  unverifiable: number;
}

export interface IssueRequest {
  licensee: string;
  deviceId: string;
  nickname?: string | null;
  licenseType: LicenseType;
  expiresAt?: string | null;
  notes?: string | null;
  replaces?: string | null;
}

export interface Issued {
  license: LicenseView;
  filePath: string;
  activationKey: string;
}

export interface BackupSummary {
  keyId: string;
  createdAt: string;
  licenses: number;
}

export interface RestoreSummary {
  key: KeyInfo;
  licensesInBackup: number;
  licensesAdded: number;
}

export interface MyDevice {
  deviceId: string | null;
  source: 'windows' | 'fallback' | 'unknown';
  note: string;
}

export interface FieldError {
  field: string;
  message: string;
}

/** Error shape thrown by every API call. */
export interface ApiError {
  code: string;
  message: string;
  fields: FieldError[];
}

export type PathKind = 'backup' | 'publicKey' | 'revocationList' | 'cliKey' | 'folder';

export interface LmApi {
  appInfo(): Promise<AppInfo>;
  setLicenseDir(path: string): Promise<string>;
  vaultStatus(): Promise<VaultStatus>;
  vaultCreate(confirm?: string): Promise<KeyInfo>;
  vaultImportCliKey(path: string, confirm?: string): Promise<KeyInfo>;
  exportPublicKey(outPath: string): Promise<string>;
  backupCreate(passphrase: string, outPath: string): Promise<BackupSummary>;
  backupPeek(path: string): Promise<string>;
  backupRestore(path: string, passphrase: string, confirm?: string): Promise<RestoreSummary>;
  myDevice(): Promise<MyDevice>;
  listLicenses(): Promise<LicenseView[]>;
  stats(): Promise<Stats>;
  issueLicense(req: IssueRequest): Promise<Issued>;
  reexportLicense(id: string, outDir?: string): Promise<string>;
  setRevoked(id: string, revoked: boolean, reason?: string): Promise<void>;
  exportRevocationList(outPath: string): Promise<number>;
  revealPath(path: string): Promise<void>;
  /** Native file dialogs (null = cancelled). */
  pickSave(kind: PathKind, defaultName: string): Promise<string | null>;
  pickOpen(kind: PathKind): Promise<string | null>;
  copyText(text: string): Promise<void>;
}

export function asApiError(e: unknown): ApiError {
  if (e && typeof e === 'object' && 'message' in e) {
    const o = e as Partial<ApiError>;
    return { code: o.code ?? 'ERROR', message: String(o.message), fields: Array.isArray(o.fields) ? o.fields : [] };
  }
  return { code: 'ERROR', message: String(e), fields: [] };
}
