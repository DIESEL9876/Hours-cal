/**
 * Native SQLite driver for the desktop app. SQL is executed by Rust (rusqlite, bundled SQLite) on a single
 * connection in WAL mode; every batch runs inside one transaction. See src-tauri/src/db.rs.
 */
import { invoke } from '@tauri-apps/api/core';
import type { BackupInfo, SqlDriver, SqlValue, Statement } from './driver';

export class TauriDriver implements SqlDriver {
  readonly kind = 'tauri' as const;

  select<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return invoke<T[]>('db_select', { sql, params });
  }

  batch(statements: Statement[]): Promise<void> {
    return invoke('db_batch', { statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });
  }

  createBackup(reason: string): Promise<BackupInfo> {
    return invoke<BackupInfo>('backup_create', { reason });
  }

  listBackups(): Promise<BackupInfo[]> {
    return invoke<BackupInfo[]>('backup_list');
  }

  restoreBackup(name: string): Promise<void> {
    return invoke('backup_restore', { name });
  }

  location(): Promise<string> {
    return invoke<string>('db_location');
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
