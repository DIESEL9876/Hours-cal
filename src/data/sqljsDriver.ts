/**
 * sql.js (SQLite → WASM) driver. Used by the automated tests (in-memory) and by the browser preview
 * (persisted to IndexedDB). The desktop app uses the native rusqlite driver instead (tauriDriver.ts).
 */
import type { Database, SqlJsStatic } from 'sql.js';
import type { BackupInfo, SqlDriver, SqlValue, Statement } from './driver';

export interface SqlJsPersistence {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
  saveBackup(name: string, bytes: Uint8Array): Promise<void>;
  loadBackup(name: string): Promise<Uint8Array | null>;
  listBackups(): Promise<BackupInfo[]>;
  location: string;
}

export class SqlJsDriver implements SqlDriver {
  readonly kind = 'sqljs' as const;
  private db: Database;

  private constructor(
    private readonly SQL: SqlJsStatic,
    bytes: Uint8Array | null,
    private readonly persistence: SqlJsPersistence | null,
  ) {
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.run('PRAGMA foreign_keys = ON');
  }

  static async open(SQL: SqlJsStatic, persistence: SqlJsPersistence | null): Promise<SqlJsDriver> {
    const bytes = persistence ? await persistence.load() : null;
    return new SqlJsDriver(SQL, bytes, persistence);
  }

  async select<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      return out;
    } finally {
      stmt.free();
    }
  }

  async batch(statements: Statement[]): Promise<void> {
    this.db.run('BEGIN IMMEDIATE');
    try {
      for (const s of statements) this.db.run(s.sql, s.params ?? []);
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    if (this.persistence) await this.persistence.save(this.db.export());
  }

  async createBackup(reason: string): Promise<BackupInfo> {
    const bytes = this.db.export();
    const createdAt = new Date().toISOString();
    const name = `backup-${createdAt.replace(/[:.]/g, '-')}-${reason}.sqlite3`;
    if (this.persistence) await this.persistence.saveBackup(name, bytes);
    return { name, createdAt, sizeBytes: bytes.length };
  }

  async listBackups(): Promise<BackupInfo[]> {
    return this.persistence ? this.persistence.listBackups() : [];
  }

  async restoreBackup(name: string): Promise<void> {
    if (!this.persistence) throw new Error('אין אחסון גיבויים');
    const bytes = await this.persistence.loadBackup(name);
    if (!bytes) throw new Error('הגיבוי לא נמצא');
    // validate before replacing
    const probe = new this.SQL.Database(bytes);
    probe.exec('SELECT COUNT(*) FROM businesses');
    probe.close();
    await this.createBackup('before-restore');
    this.db.close();
    this.db = new this.SQL.Database(bytes);
    this.db.run('PRAGMA foreign_keys = ON');
    await this.persistence.save(this.db.export());
  }

  async location(): Promise<string> {
    return this.persistence?.location ?? 'זיכרון זמני';
  }
}

// ---------------------------------------------------------------------------
// IndexedDB persistence for the browser preview
// ---------------------------------------------------------------------------

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('hours-cal', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('db');
      req.result.createObjectStore('backups');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

export const indexedDbPersistence: SqlJsPersistence = {
  location: 'דפדפן (IndexedDB) – מצב תצוגה מקדימה',
  load: async () => ((await tx('db', 'readonly', (s) => s.get('main'))) as Uint8Array | undefined) ?? null,
  save: async (bytes) => {
    await tx('db', 'readwrite', (s) => s.put(bytes, 'main'));
  },
  saveBackup: async (name, bytes) => {
    await tx('backups', 'readwrite', (s) => s.put({ bytes, createdAt: new Date().toISOString() }, name));
  },
  loadBackup: async (name) => {
    const v = (await tx('backups', 'readonly', (s) => s.get(name))) as { bytes: Uint8Array } | undefined;
    return v?.bytes ?? null;
  },
  listBackups: async () => {
    const keys = (await tx('backups', 'readonly', (s) => s.getAllKeys())) as string[];
    const vals = (await tx('backups', 'readonly', (s) => s.getAll())) as { bytes: Uint8Array; createdAt: string }[];
    return keys.map((k, i) => ({ name: k, createdAt: vals[i].createdAt, sizeBytes: vals[i].bytes.length })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
};
