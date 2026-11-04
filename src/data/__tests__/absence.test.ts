/** Version 1.1.7 — attendance categories through the real database: additive migration, preservation, finalised months, reconciliation. */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver, type SqlJsPersistence } from '../sqljsDriver';
import { Repository } from '../repo';
import { MIGRATIONS, SCHEMA_VERSION } from '../schema';
import { computeBusinessMonth, computeEmployeeMonth, sha256Hex, snapshotOf } from '../service';
import { defaultEmployeeSettings, sumAttendance, type ShiftInput } from '../../engine';
import { businessMonthTable, employeeMonthTable } from '../../export/tables';
import { tableToCsv } from '../../export/exporters';
import { buildTimestamps } from '../../ui/timeEntry';
import type { BackupInfo } from '../driver';

const SQL = await initSqlJs();

function memoryPersistence() {
  let main: Uint8Array | null = null;
  const backups = new Map<string, Uint8Array>();
  const p: SqlJsPersistence = {
    location: 'memory',
    load: async () => main,
    save: async (b) => void (main = b),
    saveBackup: async (n, bytes) => void backups.set(n, bytes),
    loadBackup: async (n) => backups.get(n) ?? null,
    listBackups: async (): Promise<BackupInfo[]> => [...backups].map(([name, b]) => ({ name, createdAt: '', sizeBytes: b.length })),
  };
  return p;
}

async function open(p: SqlJsPersistence | null = null) {
  const repo = new Repository(await SqlJsDriver.open(SQL, p));
  await repo.migrate();
  return repo;
}

const shift = (date: string, start: string, end: string, breakMinutes = 0): ShiftInput => {
  const ts = buildTimestamps(date, start, end);
  return { id: crypto.randomUUID(), workDate: date, startAt: ts.startAt, endAt: ts.endAt, breakMinutes, breakStart: null, breakConfirmed: true, breakPaid: false, reviewed: false };
};

async function setup(repo: Repository, credit: 'paid_absence' | undefined = undefined) {
  const defaults = defaultEmployeeSettings({ breakMethod: 'manual', ...(credit ? { absence: { weeklyCredit: credit } } : {}) });
  const b = await repo.createBusiness({ name: `עסק ${Math.random()}`, defaults });
  const { fridayOvertimeHistory: _f, weeklyCreditHistory: _w, ...copy } = b.defaults;
  const e = await repo.createEmployee(b.id, { fullName: 'דנה לוי', settings: { ...copy, absence: { employmentStart: '2025-01-01' } } });
  return { b, e };
}

describe('additive migration v1 → v2', () => {
  it('keeps every existing record; new column is empty; a pre-migration backup is created', async () => {
    const p = memoryPersistence();
    // A database exactly as version 1.1.6 left it (schema v1 only).
    const v1 = new Repository(await SqlJsDriver.open(SQL, p));
    await v1.driver.batch([{ sql: `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT NOT NULL)` }]);
    const m1 = MIGRATIONS.find((m) => m.version === 1)!;
    await v1.driver.batch([...m1.statements.map((sql) => ({ sql })), { sql: `INSERT INTO schema_migrations VALUES (1, 'initial schema', '2026-01-01')` }]);
    const b = await v1.createBusiness({ name: 'ישן', defaults: defaultEmployeeSettings({ breakMethod: 'manual' }) });
    // Employee rows exactly as the v1 schema stores them (no later columns).
    const e = { id: 'e-v1' };
    await v1.driver.batch([
      { sql: `INSERT INTO employees (id, business_id, full_name, employee_number, notes, created_at, updated_at) VALUES ('e-v1', ?, 'א', NULL, NULL, 't', 't')`, params: [b.id] },
      { sql: `INSERT INTO employee_settings (id, employee_id, effective_from, settings_json, created_at, updated_at) VALUES ('v-v1', 'e-v1', '1900-01-01', ?, 't', 't')`, params: [JSON.stringify(b.defaults)] },
    ]);
    await v1.upsertShift(b.id, e.id, shift('2026-10-12', '08:00', '17:00', 30));
    await v1.driver.batch([
      {
        sql: `INSERT INTO day_entries (business_id, employee_id, date, status, note, updated_at) VALUES (?, ?, '2026-10-13', 'vacation', 'ישן', 't')`,
        params: [b.id, e.id],
      },
    ]);

    const reopened = new Repository(await SqlJsDriver.open(SQL, p));
    expect(await reopened.migrate()).toBe(SCHEMA_VERSION);
    expect((await reopened.driver.listBackups()).some((x) => x.name.includes('pre-migration'))).toBe(true);
    const entries = await reopened.getDayEntries(b.id, e.id, '2026-10-01', '2026-10-31');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ date: '2026-10-13', status: 'vacation', note: 'ישן' }); // no absence details invented
    const after = await computeBusinessMonth(reopened, b.id, 2026, 10);
    expect(after.grandTotal.netMinutes).toBe(510);
    expect(after.rows[0].result.days.find((d) => d.date === '2026-10-13')!.status).toBe('vacation');
    // The same data entered in a new database gives exactly the same snapshot (finalisation hash unchanged).
    const ref = await open();
    const rb = await ref.createBusiness({ name: 'ישן', defaults: defaultEmployeeSettings({ breakMethod: 'manual' }) });
    const re = await ref.createEmployee(rb.id, { fullName: 'א', settings: rb.defaults });
    await ref.upsertShift(rb.id, re.id, shift('2026-10-12', '08:00', '17:00', 30));
    await ref.setDayEntry(rb.id, re.id, { date: '2026-10-13', status: 'vacation', note: 'ישן' });
    const norm = (j: string) => j.replaceAll(b.id, 'B').replaceAll(e.id, 'E').replaceAll(rb.id, 'B').replaceAll(re.id, 'E');
    expect(norm(snapshotOf(after))).toBe(norm(snapshotOf(await computeBusinessMonth(ref, rb.id, 2026, 10))));
  });
});

describe('day categories are stored only as the user saved them', () => {
  it('absence details persist; saving a note without details keeps them; blank stays blank', async () => {
    const p = memoryPersistence();
    const repo = await open(p);
    const { b, e } = await setup(repo);
    await repo.setDayEntry(b.id, e.id, { date: '2026-10-12', status: 'vacation', note: null, absence: { minutes: 240 } });
    await repo.setDayEntry(b.id, e.id, { date: '2026-10-12', status: 'vacation', note: 'חצי יום' }); // caller omitted absence
    const reopened = new Repository(await SqlJsDriver.open(SQL, p));
    await reopened.migrate();
    const [d] = await reopened.getDayEntries(b.id, e.id, '2026-10-12', '2026-10-12');
    expect(d).toMatchObject({ status: 'vacation', note: 'חצי יום', absence: { minutes: 240 } });
    // Rejecting a suggestion stores only the rejection: no category.
    await reopened.setDayEntry(b.id, e.id, { date: '2026-10-13', status: null, note: null, absence: { rejectedSuggestion: 'holiday' } });
    const r = await computeEmployeeMonth(reopened, b.id, e.id, 2026, 10);
    expect(r.days.find((x) => x.date === '2026-10-13')!.status).toBeNull();
    expect(r.days.find((x) => x.date === '2026-10-14')!.attendance.category).toBeNull();
    // Clearing everything removes the row.
    await reopened.setDayEntry(b.id, e.id, { date: '2026-10-13', status: null, note: null, absence: null });
    expect(await reopened.getDayEntries(b.id, e.id, '2026-10-13', '2026-10-13')).toHaveLength(0);
  });

  it('a vacation mark never changes the shifts of that date', async () => {
    const repo = await open();
    const { b, e } = await setup(repo);
    await repo.upsertShift(b.id, e.id, shift('2026-10-12', '08:00', '12:00'));
    await repo.setDayEntry(b.id, e.id, { date: '2026-10-12', status: 'vacation', note: null, absence: { minutes: 252 } });
    const r = await computeEmployeeMonth(repo, b.id, e.id, 2026, 10);
    const d = r.days.find((x) => x.date === '2026-10-12')!;
    expect(d.netMinutes).toBe(240);
    expect(d.attendance).toMatchObject({ actualWorkedMinutes: 240, paidAbsenceNominalMinutes: 252, payableEquivalentMinutes: 492 });
    expect(d.attendance.paidDayHundredths).toBe(100);
  });
});

describe('finalised months', () => {
  it('turning on the weekly credit applies after the last finalised month only', async () => {
    const repo = await open();
    const { b, e } = await setup(repo);
    // October: vacation Sun–Wed, 9h Thursday, 6h Friday.
    for (const d of ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']) await repo.setDayEntry(b.id, e.id, { date: d, status: 'vacation', note: null });
    await repo.upsertShift(b.id, e.id, shift('2026-10-15', '08:00', '17:00'));
    await repo.upsertShift(b.id, e.id, shift('2026-10-16', '08:00', '14:00'));
    const oct = await computeBusinessMonth(repo, b.id, 2026, 10);
    const json = snapshotOf(oct);
    await repo.setMonthReview(b.id, '2026-10', 'final', { json, hash: await sha256Hex(json) });

    const biz = await repo.getBusiness(b.id);
    const updated = await repo.updateBusiness(b.id, { defaults: { ...biz.defaults, absence: { ...biz.defaults.absence, weeklyCredit: 'paid_absence' } } });
    expect(updated.defaults.weeklyCreditHistory).toEqual([{ from: '2026-11-01', value: 'paid_absence' }]);
    expect(snapshotOf(await computeBusinessMonth(repo, b.id, 2026, 10))).toBe(json); // October unchanged

    // November: the same week pattern now receives the credit.
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']) await repo.setDayEntry(b.id, e.id, { date: d, status: 'vacation', note: null });
    await repo.upsertShift(b.id, e.id, shift('2026-11-05', '08:00', '17:00'));
    await repo.upsertShift(b.id, e.id, shift('2026-11-06', '08:00', '14:00'));
    const nov = await computeEmployeeMonth(repo, b.id, e.id, 2026, 11);
    expect(nov.weeks.find((w) => w.weekStart === '2026-11-01')!.absenceCreditMinutes).toBe(4 * 504);
    expect(nov.attendance.vacationDayHundredths).toBe(400);
  });
});

describe('summary and export reconciliation', () => {
  it('business totals = sum of employees = sum of days; CSV carries the new columns', async () => {
    const repo = await open();
    const { b, e } = await setup(repo);
    const e2 = await repo.createEmployee(b.id, { fullName: 'אבי', settings: { ...(await repo.getSettingsVersions(e.id))[0].settings } });
    await repo.upsertShift(b.id, e.id, shift('2026-10-12', '08:00', '17:00', 30));
    await repo.setDayEntry(b.id, e.id, { date: '2026-10-13', status: 'vacation', note: null });
    await repo.setDayEntry(b.id, e.id, { date: '2026-10-14', status: 'sick', note: null });
    await repo.setDayEntry(b.id, e.id, { date: '2026-10-15', status: 'sick', note: null });
    await repo.upsertShift(b.id, e2.id, shift('2026-10-12', '09:00', '13:00'));
    await repo.setDayEntry(b.id, e2.id, { date: '2026-10-12', status: 'vacation', note: null, absence: { minutes: 264 } });
    const s = await computeBusinessMonth(repo, b.id, 2026, 10);
    expect(s.attendanceTotal).toEqual(sumAttendance(s.rows.flatMap((r) => r.result.days.map((d) => d.attendance))));
    for (const r of s.rows) expect(r.result.attendance).toEqual(sumAttendance(r.result.days.map((d) => d.attendance)));
    const dana = s.rows.find((r) => r.name === 'דנה לוי')!.result.attendance;
    expect(dana).toMatchObject({ actualWorkedDays: 1, actualWorkedMinutes: 510, vacationDayHundredths: 100, sickDayHundredths: 200, sickPaidDayHundredths: 50 });
    expect(dana.payableEquivalentMinutes).toBe(510 + 504 + 228); // sick day 2 on the shortened Thursday (7:36) at 50%
    expect(s.attendanceTotal.actualWorkedMinutes).toBe(510 + 240);

    const csv = tableToCsv(businessMonthTable('סיכום', s, false));
    for (const h of ['ימים בפועל', 'ימים משולמים', 'שעות בפועל', 'שעות משולמות', 'ימי חופשה', 'ימי מחלה', 'ימי חג', 'ימי בחירות']) expect(csv).toContain(h);
    const emp = tableToCsv(employeeMonthTable('דוח', s.rows[0].result));
    expect(emp).toContain('סוג יום');
  });
});
