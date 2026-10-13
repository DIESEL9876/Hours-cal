export type Route =
  | { route: "legalAgreement"; appVersion: string; docVersion: string }
  | { route: "activation"; deviceId: string; reasonHe: string | null; recoveryAvailable: boolean }
  | { route: "ready"; licensee: string; organization: string | null; licenseId: string; expiresAt: string | null };

export interface LegalDoc {
  text: string; docVersion: string; sha256: string; appVersion: string; copyright: string; consentLabel: string;
}
export interface AcceptanceRecord {
  schema_version: number; installation_id: string; app_version: string; legal_doc_version: string;
  legal_sha256: string; accepted_at_utc: string; local_utc_offset_minutes: number | null;
}
export interface TableSummary { table: string; rows: number }
export interface ExportReport { folder: string; tables: TableSummary[]; sqlite_copy: string }

/** Everything the screens need from the Rust backend. Injected for testability. */
export interface LicensingApi {
  startupRoute(): Promise<Route>;
  legalDocument(): Promise<LegalDoc>;
  acceptLegal(sha256: string, localUtcOffsetMinutes: number): Promise<AcceptanceRecord>;
  legalHistory(): Promise<AcceptanceRecord[]>;
  acceptedText(sha256: string): Promise<string | null>;
  declineAndExit(): Promise<void>;
  deviceId(): Promise<{ code: string; fallback: boolean }>;
  activate(input: string): Promise<Route>;
  pickAndImportLicenseFile(): Promise<Route | null>;
  recoveryTables(): Promise<TableSummary[]>;
  pickFolderAndExport(): Promise<ExportReport | null>;
  copyText(text: string): Promise<void>;
}
