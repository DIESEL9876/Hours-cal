/**
 * Database migrations. Append-only: never edit a released migration, add a new one.
 * Only ENTERED data is stored here; calculated results are always derived by the engine
 * (except explicit finalisation snapshots in month_reviews, which are labelled as such).
 */
export interface Migration {
  version: number;
  description: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial schema',
    statements: [
      `CREATE TABLE businesses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        identifier TEXT,
        defaults_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      )`,
      `CREATE TABLE employees (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
        employee_number TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      )`,
      `CREATE INDEX ix_employees_business ON employees(business_id)`,
      `CREATE UNIQUE INDEX ux_employee_number ON employees(business_id, employee_number)
        WHERE employee_number IS NOT NULL AND archived_at IS NULL`,
      `CREATE TABLE employee_settings (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        effective_from TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (employee_id, effective_from)
      )`,
      `CREATE TABLE shifts (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        employee_id TEXT NOT NULL REFERENCES employees(id),
        work_date TEXT NOT NULL,
        start_at TEXT,
        end_at TEXT,
        break_minutes INTEGER CHECK (break_minutes IS NULL OR break_minutes >= 0),
        break_start TEXT,
        break_confirmed INTEGER NOT NULL DEFAULT 0,
        break_paid INTEGER NOT NULL DEFAULT 0,
        reviewed INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (start_at IS NULL OR end_at IS NULL OR end_at > start_at)
      )`,
      `CREATE INDEX ix_shifts_employee_date ON shifts(employee_id, work_date)`,
      `CREATE TABLE day_entries (
        employee_id TEXT NOT NULL REFERENCES employees(id),
        business_id TEXT NOT NULL REFERENCES businesses(id),
        date TEXT NOT NULL,
        status TEXT,
        note TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, date)
      )`,
      `CREATE TABLE custom_holidays (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        date TEXT NOT NULL,
        name TEXT NOT NULL,
        UNIQUE (business_id, date)
      )`,
      `CREATE TABLE month_reviews (
        business_id TEXT NOT NULL REFERENCES businesses(id),
        year_month TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'in_review', 'final')),
        finalized_at TEXT,
        snapshot_json TEXT,
        snapshot_hash TEXT,
        note TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (business_id, year_month)
      )`,
      `CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        business_id TEXT,
        employee_id TEXT,
        entity TEXT NOT NULL,
        entity_id TEXT,
        action TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT
      )`,
      `CREATE INDEX ix_audit_employee ON audit_log(employee_id, at)`,
      `CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT)`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
