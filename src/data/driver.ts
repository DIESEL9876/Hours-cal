/**
 * Storage driver abstraction. The same SQL runs on:
 *  - real on-disk SQLite through Rust/rusqlite (Tauri desktop app), and
 *  - sql.js (SQLite compiled to WASM) for the browser preview and automated tests.
 * Placeholders are positional `?`. Values are string | number | null (booleans stored as 0/1).
 */
export type SqlValue = string | number | null;

export interface Statement {
  sql: string;
  params?: SqlValue[];
}

export interface BackupInfo {
  name: string;
  createdAt: string;
  sizeBytes: number;
}

export interface SqlDriver {
  readonly kind: 'tauri' | 'sqljs';
  select<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** Executes all statements atomically in ONE transaction. */
  batch(statements: Statement[]): Promise<void>;
  createBackup(reason: string): Promise<BackupInfo>;
  listBackups(): Promise<BackupInfo[]>;
  /** Restores a backup. A safety backup of the current database is taken first. */
  restoreBackup(name: string): Promise<void>;
  /** Human-readable storage location. */
  location(): Promise<string>;
}
