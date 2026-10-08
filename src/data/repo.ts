/**
 * Repository: all reads/writes of entered data. Every mutation is written atomically together with
 * an audit-log row. Every query is scoped by business so businesses stay fully separated.
 */
import type { SqlDriver, SqlValue, Statement } from './driver';
import { MIGRATIONS } from './schema';
import type {
  CustomHoliday,
  DayStatus,
  DayStatusKind,
  EmployeeSettings,
  LocalDate,
  SettingsVersion,
  ShiftInput,
} from '../engine/types';
import { BEGINNING_OF_TIME, defaultEmployeeSettings, validateSettings } from '../engine/settings';

export interface Business {
  id: string;
  name: string;
  identifier: string | null;
  /** Template copied into each NEW employee (never live-linked, so history cannot change retroactively). */
  defaults: EmployeeSettings;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Employee {
  id: string;
  businessId: string;
  fullName: string;
  employeeNumber: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ShiftRecord extends ShiftInput {
  employeeId: string;
  businessId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DayEntry {
  date: LocalDate;
  status: DayStatusKind | null;
  note: string | null;
}

export type ReviewStatus = 'open' | 'in_review' | 'final';

export interface MonthReview {
  businessId: string;
  yearMonth: string; // 'YYYY-MM'
  status: ReviewStatus;
  finalizedAt: string | null;
  snapshotHash: string | null;
  snapshotJson: string | null;
  note: string | null;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  businessId: string | null;
  employeeId: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  before: unknown;
  after: unknown;
}

export class RepoError extends Error {}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const b = (v: boolean): number => (v ? 1 : 0);
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

function audit(
  entity: string,
  action: string,
  ids: { businessId?: string | null; employeeId?: string | null; entityId?: string | null },
  before: unknown,
  after: unknown,
): Statement {
  return {
    sql: `INSERT INTO audit_log (at, business_id, employee_id, entity, entity_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [now(), ids.businessId ?? null, ids.employeeId ?? null, entity, ids.entityId ?? null, action, json(before), json(after)],
  };
}

type Row = Record<string, SqlValue>;

function toBusiness(r: Row): Business {
  return {
    id: r.id as string,
    name: r.name as string,
    identifier: (r.identifier as string) ?? null,
    defaults: { ...defaultEmployeeSettings(), ...JSON.parse(r.defaults_json as string) },
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    archivedAt: (r.archived_at as string) ?? null,
  };
}

function toEmployee(r: Row): Employee {
  return {
    id: r.id as string,
    businessId: r.business_id as string,
    fullName: r.full_name as string,
    employeeNumber: (r.employee_number as string) ?? null,
    notes: (r.notes as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    archivedAt: (r.archived_at as string) ?? null,
  };
}

function toShift(r: Row): ShiftRecord {
  return {
    id: r.id as string,
    employeeId: r.employee_id as string,
    businessId: r.business_id as string,
    workDate: r.work_date as string,
    startAt: (r.start_at as string) ?? null,
    endAt: (r.end_at as string) ?? null,
    breakMinutes: r.break_minutes === null || r.break_minutes === undefined ? null : Number(r.break_minutes),
    breakStart: (r.break_start as string) ?? null,
    breakConfirmed: Number(r.break_confirmed) === 1,
    breakPaid: Number(r.break_paid) === 1,
    reviewed: Number(r.reviewed) === 1,
    note: (r.note as string) ?? undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function shiftForAudit(s: ShiftInput | null) {
  if (!s) return null;
  const { id, workDate, startAt, endAt, breakMinutes, breakStart, breakConfirmed, breakPaid, reviewed, note } = s;
  return { id, workDate, startAt, endAt, breakMinutes, breakStart, breakConfirmed, breakPaid, reviewed, note };
}

export class Repository {
  constructor(readonly driver: SqlDriver) {}

  // ---------------------------------------------------------------- migrations
  async migrate(): Promise<number> {
    await this.driver.batch([
      { sql: `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT NOT NULL)` },
    ]);
    const rows = await this.driver.select<{ v: number | null }>(`SELECT MAX(version) AS v FROM schema_migrations`);
    const current = Number(rows[0]?.v ?? 0);
    const pending = MIGRATIONS.filter((m) => m.version > current);
    if (current > 0 && pending.length) await this.driver.createBackup('pre-migration');
    for (const m of pending) {
      await this.driver.batch([
        ...m.statements.map((sql) => ({ sql })),
        { sql: `INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`, params: [m.version, m.description, now()] },
      ]);
    }
    const after = await this.driver.select<{ v: number }>(`SELECT MAX(version) AS v FROM schema_migrations`);
    return Number(after[0].v);
  }

  // ---------------------------------------------------------------- businesses
  async listBusinesses(includeArchived = false): Promise<Business[]> {
    const rows = await this.driver.select(
      `SELECT * FROM businesses ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY name COLLATE NOCASE`,
    );
    return rows.map(toBusiness);
  }

  async getBusiness(id: string): Promise<Business> {
    const rows = await this.driver.select(`SELECT * FROM businesses WHERE id = ?`, [id]);
    if (!rows.length) throw new RepoError('העסק לא נמצא');
    return toBusiness(rows[0]);
  }

  async createBusiness(input: { name: string; identifier?: string | null; defaults: EmployeeSettings }): Promise<Business> {
    const name = input.name.trim();
    if (!name) throw new RepoError('יש להזין שם עסק');
    const errs = validateSettings(input.defaults);
    if (errs.length) throw new RepoError(errs.join('\n'));
    const dup = await this.driver.select(`SELECT id FROM businesses WHERE name = ? AND archived_at IS NULL`, [name]);
    if (dup.length) throw new RepoError('כבר קיים עסק בשם זה');
    const t = now();
    const biz: Business = { id: uuid(), name, identifier: input.identifier?.trim() || null, defaults: input.defaults, createdAt: t, updatedAt: t, archivedAt: null };
    await this.driver.batch([
      {
        sql: `INSERT INTO businesses (id, name, identifier, defaults_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [biz.id, biz.name, biz.identifier, JSON.stringify(biz.defaults), t, t],
      },
      audit('business', 'create', { businessId: biz.id, entityId: biz.id }, null, biz),
    ]);
    return biz;
  }

  async updateBusiness(id: string, patch: { name?: string; identifier?: string | null; defaults?: EmployeeSettings }): Promise<Business> {
    const before = await this.getBusiness(id);
    const after: Business = {
      ...before,
      name: patch.name !== undefined ? patch.name.trim() : before.name,
      identifier: patch.identifier !== undefined ? patch.identifier?.trim() || null : before.identifier,
      defaults: patch.defaults ?? before.defaults,
      updatedAt: now(),
    };
    if (!after.name) throw new RepoError('יש להזין שם עסק');
    const errs = validateSettings(after.defaults);
    if (errs.length) throw new RepoError(errs.join('\n'));
    await this.driver.batch([
      {
        sql: `UPDATE businesses SET name = ?, identifier = ?, defaults_json = ?, updated_at = ? WHERE id = ?`,
        params: [after.name, after.identifier, JSON.stringify(after.defaults), after.updatedAt, id],
      },
      audit('business', 'update', { businessId: id, entityId: id }, before, after),
    ]);
    return after;
  }

  /** Soft delete. The caller must pass the exact business name as confirmation. */
  async archiveBusiness(id: string, confirmName: string): Promise<void> {
    const biz = await this.getBusiness(id);
    if (confirmName.trim() !== biz.name) throw new RepoError('שם העסק שהוקלד אינו תואם – הפעולה בוטלה');
    const t = now();
    await this.driver.batch([
      { sql: `UPDATE businesses SET archived_at = ?, updated_at = ? WHERE id = ?`, params: [t, t, id] },
      audit('business', 'archive', { businessId: id, entityId: id }, biz, { ...biz, archivedAt: t }),
    ]);
  }

  async restoreBusiness(id: string): Promise<void> {
    const biz = await this.getBusiness(id);
    const t = now();
    await this.driver.batch([
      { sql: `UPDATE businesses SET archived_at = NULL, updated_at = ? WHERE id = ?`, params: [t, id] },
      audit('business', 'restore', { businessId: id, entityId: id }, biz, { ...biz, archivedAt: null }),
    ]);
  }

  // ---------------------------------------------------------------- employees
  async listEmployees(businessId: string, includeArchived = false): Promise<Employee[]> {
    const rows = await this.driver.select(
      `SELECT * FROM employees WHERE business_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY full_name COLLATE NOCASE`,
      [businessId],
    );
    return rows.map(toEmployee);
  }

  async getEmployee(businessId: string, id: string): Promise<Employee> {
    const rows = await this.driver.select(`SELECT * FROM employees WHERE id = ? AND business_id = ?`, [id, businessId]);
    if (!rows.length) throw new RepoError('העובד לא נמצא');
    return toEmployee(rows[0]);
  }

  async createEmployee(
    businessId: string,
    input: { fullName: string; employeeNumber?: string | null; notes?: string | null; settings: EmployeeSettings },
  ): Promise<Employee> {
    await this.getBusiness(businessId);
    const fullName = input.fullName.trim();
    if (!fullName) throw new RepoError('יש להזין שם עובד');
    const errs = validateSettings(input.settings);
    if (errs.length) throw new RepoError(errs.join('\n'));
    const num = input.employeeNumber?.trim() || null;
    if (num) await this.assertUniqueNumber(businessId, num, null);
    const t = now();
    const emp: Employee = { id: uuid(), businessId, fullName, employeeNumber: num, notes: input.notes?.trim() || null, createdAt: t, updatedAt: t, archivedAt: null };
    const versionId = uuid();
    await this.driver.batch([
      {
        sql: `INSERT INTO employees (id, business_id, full_name, employee_number, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [emp.id, businessId, emp.fullName, emp.employeeNumber, emp.notes, t, t],
      },
      {
        sql: `INSERT INTO employee_settings (id, employee_id, effective_from, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [versionId, emp.id, BEGINNING_OF_TIME, JSON.stringify(input.settings), t, t],
      },
      audit('employee', 'create', { businessId, employeeId: emp.id, entityId: emp.id }, null, { ...emp, settings: input.settings }),
    ]);
    return emp;
  }

  private async assertUniqueNumber(businessId: string, num: string, exceptId: string | null) {
    const rows = await this.driver.select<{ id: string }>(
      `SELECT id FROM employees WHERE business_id = ? AND employee_number = ? AND archived_at IS NULL`,
      [businessId, num],
    );
    if (rows.some((r) => r.id !== exceptId)) throw new RepoError('מספר עובד זה כבר קיים בעסק');
  }

  async updateEmployee(businessId: string, id: string, patch: { fullName?: string; employeeNumber?: string | null; notes?: string | null }): Promise<Employee> {
    const before = await this.getEmployee(businessId, id);
    const after: Employee = {
      ...before,
      fullName: patch.fullName !== undefined ? patch.fullName.trim() : before.fullName,
      employeeNumber: patch.employeeNumber !== undefined ? patch.employeeNumber?.trim() || null : before.employeeNumber,
      notes: patch.notes !== undefined ? patch.notes?.trim() || null : before.notes,
      updatedAt: now(),
    };
    if (!after.fullName) throw new RepoError('יש להזין שם עובד');
    if (after.employeeNumber) await this.assertUniqueNumber(businessId, after.employeeNumber, id);
    await this.driver.batch([
      {
        sql: `UPDATE employees SET full_name = ?, employee_number = ?, notes = ?, updated_at = ? WHERE id = ? AND business_id = ?`,
        params: [after.fullName, after.employeeNumber, after.notes, after.updatedAt, id, businessId],
      },
      audit('employee', 'update', { businessId, employeeId: id, entityId: id }, before, after),
    ]);
    return after;
  }

  async archiveEmployee(businessId: string, id: string): Promise<void> {
    const before = await this.getEmployee(businessId, id);
    const t = now();
    await this.driver.batch([
      { sql: `UPDATE employees SET archived_at = ?, updated_at = ? WHERE id = ? AND business_id = ?`, params: [t, t, id, businessId] },
      audit('employee', 'archive', { businessId, employeeId: id, entityId: id }, before, { ...before, archivedAt: t }),
    ]);
  }

  async restoreEmployee(businessId: string, id: string): Promise<void> {
    const before = await this.getEmployee(businessId, id);
    if (before.employeeNumber) await this.assertUniqueNumber(businessId, before.employeeNumber, id);
    const t = now();
    await this.driver.batch([
      { sql: `UPDATE employees SET archived_at = NULL, updated_at = ? WHERE id = ? AND business_id = ?`, params: [t, id, businessId] },
      audit('employee', 'restore', { businessId, employeeId: id, entityId: id }, before, { ...before, archivedAt: null }),
    ]);
  }

  // ---------------------------------------------------------------- settings versions
  async getSettingsVersions(employeeId: string): Promise<SettingsVersion[]> {
    const rows = await this.driver.select(`SELECT * FROM employee_settings WHERE employee_id = ? ORDER BY effective_from`, [employeeId]);
    return rows.map((r) => ({
      id: r.id as string,
      effectiveFrom: r.effective_from as string,
      settings: { ...defaultEmployeeSettings(), ...JSON.parse(r.settings_json as string) },
    }));
  }

  /**
   * Save settings effective from a date.
   *  - A NEW effective date creates a new version; earlier dates are untouched.
   *  - Changing an EXISTING version rewrites history for its whole period and therefore requires
   *    `authorizeRetroactive: true` (the UI asks the user explicitly).
   */
  async saveSettingsVersion(
    businessId: string,
    employeeId: string,
    effectiveFrom: LocalDate,
    settings: EmployeeSettings,
    opts: { authorizeRetroactive?: boolean } = {},
  ): Promise<void> {
    await this.getEmployee(businessId, employeeId);
    const errs = validateSettings(settings);
    if (errs.length) throw new RepoError(errs.join('\n'));
    const versions = await this.getSettingsVersions(employeeId);
    const existing = versions.find((v) => v.effectiveFrom === effectiveFrom);
    const t = now();
    if (existing) {
      if (!opts.authorizeRetroactive) throw new RepoError('שינוי גרסת הגדרות קיימת משנה חישובים היסטוריים ודורש אישור מפורש');
      await this.driver.batch([
        { sql: `UPDATE employee_settings SET settings_json = ?, updated_at = ? WHERE id = ?`, params: [JSON.stringify(settings), t, existing.id] },
        { sql: `UPDATE employees SET updated_at = ? WHERE id = ?`, params: [t, employeeId] },
        audit('employee_settings', 'update_retroactive', { businessId, employeeId, entityId: existing.id }, existing, { ...existing, settings }),
      ]);
      return;
    }
    const later = versions.filter((v) => v.effectiveFrom > effectiveFrom);
    if (later.length && !opts.authorizeRetroactive)
      throw new RepoError('קיימת גרסת הגדרות מאוחרת יותר; הוספת גרסה לפניה משנה חישובים קיימים ודורשת אישור מפורש');
    const id = uuid();
    await this.driver.batch([
      {
        sql: `INSERT INTO employee_settings (id, employee_id, effective_from, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [id, employeeId, effectiveFrom, JSON.stringify(settings), t, t],
      },
      { sql: `UPDATE employees SET updated_at = ? WHERE id = ?`, params: [t, employeeId] },
      audit('employee_settings', 'create', { businessId, employeeId, entityId: id }, null, { id, effectiveFrom, settings }),
    ]);
  }

  async deleteSettingsVersion(businessId: string, employeeId: string, versionId: string): Promise<void> {
    const versions = await this.getSettingsVersions(employeeId);
    const v = versions.find((x) => x.id === versionId);
    if (!v) throw new RepoError('הגרסה לא נמצאה');
    if (versions.length === 1) throw new RepoError('לא ניתן למחוק את גרסת ההגדרות היחידה');
    if (v.effectiveFrom === BEGINNING_OF_TIME) throw new RepoError('לא ניתן למחוק את גרסת ההגדרות הראשונה');
    await this.driver.batch([
      { sql: `DELETE FROM employee_settings WHERE id = ? AND employee_id = ?`, params: [versionId, employeeId] },
      audit('employee_settings', 'delete', { businessId, employeeId, entityId: versionId }, v, null),
    ]);
  }

  // ---------------------------------------------------------------- shifts
  async getShifts(businessId: string, employeeId: string, from: LocalDate, to: LocalDate): Promise<ShiftRecord[]> {
    const rows = await this.driver.select(
      `SELECT * FROM shifts WHERE business_id = ? AND employee_id = ? AND work_date >= ? AND work_date <= ? ORDER BY work_date, start_at`,
      [businessId, employeeId, from, to],
    );
    return rows.map(toShift);
  }

  async getShift(businessId: string, id: string): Promise<ShiftRecord | null> {
    const rows = await this.driver.select(`SELECT * FROM shifts WHERE id = ? AND business_id = ?`, [id, businessId]);
    return rows.length ? toShift(rows[0]) : null;
  }

  /** Insert or update a shift. Structural validity (end after start) is enforced; incomplete rows are allowed. */
  async upsertShift(businessId: string, employeeId: string, shift: ShiftInput): Promise<ShiftRecord> {
    await this.getEmployee(businessId, employeeId);
    if (!shift.startAt && !shift.endAt) throw new RepoError('משמרת ריקה אינה נשמרת');
    if (shift.startAt && shift.endAt && shift.endAt <= shift.startAt) throw new RepoError('שעת היציאה חייבת להיות מאוחרת משעת הכניסה');
    if (shift.startAt && shift.startAt.slice(0, 10) !== shift.workDate) throw new RepoError('תאריך המשמרת אינו תואם');
    if (shift.breakMinutes !== null && (!Number.isInteger(shift.breakMinutes) || shift.breakMinutes < 0)) throw new RepoError('משך הפסקה לא תקין');
    const before = await this.getShift(businessId, shift.id);
    if (before && before.employeeId !== employeeId) throw new RepoError('המשמרת שייכת לעובד אחר');
    const t = now();
    const rec: ShiftRecord = { ...shift, employeeId, businessId, createdAt: before?.createdAt ?? t, updatedAt: t };
    const values: SqlValue[] = [
      rec.workDate,
      rec.startAt,
      rec.endAt,
      rec.breakMinutes,
      rec.breakStart,
      b(rec.breakConfirmed),
      b(rec.breakPaid),
      b(rec.reviewed),
      rec.note ?? null,
    ];
    const stmt: Statement = before
      ? {
          sql: `UPDATE shifts SET work_date = ?, start_at = ?, end_at = ?, break_minutes = ?, break_start = ?, break_confirmed = ?, break_paid = ?, reviewed = ?, note = ?, updated_at = ? WHERE id = ? AND business_id = ?`,
          params: [...values, t, rec.id, businessId],
        }
      : {
          sql: `INSERT INTO shifts (work_date, start_at, end_at, break_minutes, break_start, break_confirmed, break_paid, reviewed, note, created_at, updated_at, id, business_id, employee_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [...values, t, t, rec.id, businessId, employeeId],
        };
    await this.driver.batch([
      stmt,
      { sql: `UPDATE employees SET updated_at = ? WHERE id = ?`, params: [t, employeeId] },
      audit('shift', before ? 'update' : 'create', { businessId, employeeId, entityId: rec.id }, shiftForAudit(before), shiftForAudit(rec)),
    ]);
    return rec;
  }

  async deleteShift(businessId: string, employeeId: string, id: string): Promise<void> {
    const before = await this.getShift(businessId, id);
    if (!before || before.employeeId !== employeeId) return;
    const t = now();
    await this.driver.batch([
      { sql: `DELETE FROM shifts WHERE id = ? AND business_id = ?`, params: [id, businessId] },
      { sql: `UPDATE employees SET updated_at = ? WHERE id = ?`, params: [t, employeeId] },
      audit('shift', 'delete', { businessId, employeeId, entityId: id }, shiftForAudit(before), null),
    ]);
  }

  // ---------------------------------------------------------------- day entries (status + note)
  async getDayEntries(businessId: string, employeeId: string, from: LocalDate, to: LocalDate): Promise<DayEntry[]> {
    const rows = await this.driver.select(
      `SELECT date, status, note FROM day_entries WHERE business_id = ? AND employee_id = ? AND date >= ? AND date <= ? ORDER BY date`,
      [businessId, employeeId, from, to],
    );
    return rows.map((r) => ({ date: r.date as string, status: (r.status as DayStatusKind) ?? null, note: (r.note as string) ?? null }));
  }

  async setDayEntry(businessId: string, employeeId: string, entry: DayEntry): Promise<void> {
    await this.getEmployee(businessId, employeeId);
    const beforeRows = await this.getDayEntries(businessId, employeeId, entry.date, entry.date);
    const before = beforeRows[0] ?? null;
    const t = now();
    const empty = !entry.status && !(entry.note && entry.note.trim());
    const stmts: Statement[] = empty
      ? [{ sql: `DELETE FROM day_entries WHERE employee_id = ? AND date = ? AND business_id = ?`, params: [employeeId, entry.date, businessId] }]
      : [
          {
            sql: `INSERT INTO day_entries (employee_id, business_id, date, status, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(employee_id, date) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`,
            params: [employeeId, businessId, entry.date, entry.status, entry.note?.trim() || null, t],
          },
        ];
    await this.driver.batch([
      ...stmts,
      { sql: `UPDATE employees SET updated_at = ? WHERE id = ?`, params: [t, employeeId] },
      audit('day_entry', empty ? 'delete' : before ? 'update' : 'create', { businessId, employeeId, entityId: entry.date }, before, empty ? null : entry),
    ]);
  }

  // ---------------------------------------------------------------- custom holidays
  async listCustomHolidays(businessId: string): Promise<CustomHoliday[]> {
    const rows = await this.driver.select(`SELECT date, name FROM custom_holidays WHERE business_id = ? ORDER BY date`, [businessId]);
    return rows.map((r) => ({ date: r.date as string, name: r.name as string }));
  }

  async setCustomHoliday(businessId: string, date: LocalDate, name: string | null): Promise<void> {
    const t = name?.trim();
    await this.driver.batch([
      t
        ? {
            sql: `INSERT INTO custom_holidays (id, business_id, date, name) VALUES (?, ?, ?, ?) ON CONFLICT(business_id, date) DO UPDATE SET name = excluded.name`,
            params: [uuid(), businessId, date, t],
          }
        : { sql: `DELETE FROM custom_holidays WHERE business_id = ? AND date = ?`, params: [businessId, date] },
      audit('custom_holiday', t ? 'set' : 'delete', { businessId, entityId: date }, null, t ? { date, name: t } : null),
    ]);
  }

  // ---------------------------------------------------------------- month reviews
  async getMonthReview(businessId: string, yearMonth: string): Promise<MonthReview> {
    const rows = await this.driver.select(`SELECT * FROM month_reviews WHERE business_id = ? AND year_month = ?`, [businessId, yearMonth]);
    if (!rows.length) return { businessId, yearMonth, status: 'open', finalizedAt: null, snapshotHash: null, snapshotJson: null, note: null, updatedAt: '' };
    const r = rows[0];
    return {
      businessId,
      yearMonth,
      status: r.status as ReviewStatus,
      finalizedAt: (r.finalized_at as string) ?? null,
      snapshotHash: (r.snapshot_hash as string) ?? null,
      snapshotJson: (r.snapshot_json as string) ?? null,
      note: (r.note as string) ?? null,
      updatedAt: r.updated_at as string,
    };
  }

  async setMonthReview(
    businessId: string,
    yearMonth: string,
    status: ReviewStatus,
    snapshot: { json: string; hash: string } | null,
    note: string | null = null,
  ): Promise<void> {
    const before = await this.getMonthReview(businessId, yearMonth);
    const t = now();
    await this.driver.batch([
      {
        sql: `INSERT INTO month_reviews (business_id, year_month, status, finalized_at, snapshot_json, snapshot_hash, note, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(business_id, year_month) DO UPDATE SET status = excluded.status, finalized_at = excluded.finalized_at,
                snapshot_json = excluded.snapshot_json, snapshot_hash = excluded.snapshot_hash, note = excluded.note, updated_at = excluded.updated_at`,
        params: [businessId, yearMonth, status, status === 'final' ? t : null, snapshot?.json ?? null, snapshot?.hash ?? null, note, t],
      },
      audit('month_review', status, { businessId, entityId: yearMonth }, { status: before.status, hash: before.snapshotHash }, { status, hash: snapshot?.hash ?? null }),
    ]);
  }

  // ---------------------------------------------------------------- audit / meta
  async listAudit(businessId: string, employeeId: string | null, limit = 200): Promise<AuditEntry[]> {
    const rows = await this.driver.select(
      `SELECT * FROM audit_log WHERE business_id = ? ${employeeId ? 'AND employee_id = ?' : ''} ORDER BY id DESC LIMIT ?`,
      employeeId ? [businessId, employeeId, limit] : [businessId, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      at: r.at as string,
      businessId: (r.business_id as string) ?? null,
      employeeId: (r.employee_id as string) ?? null,
      entity: r.entity as string,
      entityId: (r.entity_id as string) ?? null,
      action: r.action as string,
      before: r.before_json ? JSON.parse(r.before_json as string) : null,
      after: r.after_json ? JSON.parse(r.after_json as string) : null,
    }));
  }

  /** Per-employee stats used by the employee list. */
  async employeeMonthStats(businessId: string, from: LocalDate, to: LocalDate): Promise<Map<string, { shiftDays: number; statusDays: number }>> {
    const shiftRows = await this.driver.select<{ employee_id: string; n: number }>(
      `SELECT employee_id, COUNT(DISTINCT work_date) AS n FROM shifts WHERE business_id = ? AND work_date >= ? AND work_date <= ? GROUP BY employee_id`,
      [businessId, from, to],
    );
    const statusRows = await this.driver.select<{ employee_id: string; n: number }>(
      `SELECT employee_id, COUNT(*) AS n FROM day_entries WHERE business_id = ? AND date >= ? AND date <= ? AND status IS NOT NULL
        AND date NOT IN (SELECT work_date FROM shifts s WHERE s.employee_id = day_entries.employee_id) GROUP BY employee_id`,
      [businessId, from, to],
    );
    const out = new Map<string, { shiftDays: number; statusDays: number }>();
    for (const r of shiftRows) out.set(r.employee_id, { shiftDays: Number(r.n), statusDays: 0 });
    for (const r of statusRows) {
      const e = out.get(r.employee_id) ?? { shiftDays: 0, statusDays: 0 };
      e.statusDays = Number(r.n);
      out.set(r.employee_id, e);
    }
    return out;
  }

  async getMeta(key: string): Promise<string | null> {
    const rows = await this.driver.select<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, [key]);
    return rows[0]?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.driver.batch([{ sql: `INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, params: [key, value] }]);
  }
}

/** Convert stored day entries to engine statuses. */
export function toDayStatuses(entries: DayEntry[]): DayStatus[] {
  return entries.filter((e) => e.status).map((e) => ({ date: e.date, status: e.status!, note: e.note ?? undefined }));
}
