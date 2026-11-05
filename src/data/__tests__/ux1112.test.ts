/**
 * 1.1.12 — inline monthly payroll in the summary: advances/bonuses stored as a single canonical adjustment, the
 * recuperation (הבראה) כן/לא flag in employee_months, persistence, and closed-month protection.
 */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsDriver, type SqlJsPersistence } from '../sqljsDriver';
import { Repository, RepoError } from '../repo';
import { computeBusinessFinancials, computeBusinessMonth, yearMonthKey } from '../service';
import { defaultEmployeeSettings } from '../../engine';
import type { BackupInfo } from '../driver';

const SQL = await initSqlJs();
function memory(): SqlJsPersistence {
  let main: Uint8Array | null = null;
  const backups = new Map<string, Uint8Array>();
  return {
    location: 'memory',
    load: async () => main,
    save: async (b) => void (main = b),
    saveBackup: async (n, b) => void backups.set(n, b),
    loadBackup: async (n) => backups.get(n) ?? null,
    listBackups: async (): Promise<BackupInfo[]> => [...backups].map(([name, b]) => ({ name, createdAt: '', sizeBytes: b.length })),
  };
}
async function open(p: SqlJsPersistence | null = null) {
  const r = new Repository(await SqlJsDriver.open(SQL, p));
  await r.migrate();
  return r;
}
async function setup(repo: Repository) {
  const b = await repo.createBusiness({ name: `עסק ${Math.random()}`, defaults: defaultEmployeeSettings({ breakMethod: 'manual', hourlyRateAgorot: 5000 }) });
  const { fridayOvertimeHistory: _f, weeklyCreditHistory: _w, ...copy } = b.defaults;
  const e = await repo.createEmployee(b.id, { fullName: 'דנה', settings: copy });
  return { b, e };
}
const ym = yearMonthKey(2026, 11);
async function fin(repo: Repository, bId: string) {
  const s = await computeBusinessMonth(repo, bId, 2026, 11);
  return computeBusinessFinancials(repo, bId, 2026, 11, s);
}

describe('inline advances / bonuses (canonical per-month adjustment)', () => {
  it('a single value per category persists and sums into the business totals', async () => {
    const p = memory();
    const repo = await open(p);
    const { b, e } = await setup(repo);
    const id = (cat: string) => `inline:${cat}:${e.id}:${ym}`;
    await repo.saveAdjustment({ id: id('advance'), businessId: b.id, employeeId: e.id, yearMonth: ym, category: 'advance', amountAgorot: 50000, date: null, description: 'הוזן בסיכום החודשי', details: {} });
    await repo.saveAdjustment({ id: id('bonus'), businessId: b.id, employeeId: e.id, yearMonth: ym, category: 'bonus', amountAgorot: 120000, date: null, description: 'הוזן בסיכום החודשי', details: {} });
    let f = await fin(repo, b.id);
    expect(f.totals.byCategory.advance).toBe(50000);
    expect(f.totals.byCategory.bonus).toBe(120000);

    // Re-opening the database (restart): values persist.
    const repo2 = await open(p);
    f = await fin(repo2, b.id);
    expect(f.totals.byCategory.advance).toBe(50000);
    expect(f.totals.byCategory.bonus).toBe(120000);

    // Editing to zero deletes the canonical row.
    await repo2.deleteAdjustment(b.id, id('advance'));
    expect((await fin(repo2, b.id)).totals.byCategory.advance).toBe(0);
    // Re-entering a value revives it.
    await repo2.saveAdjustment({ id: id('advance'), businessId: b.id, employeeId: e.id, yearMonth: ym, category: 'advance', amountAgorot: 30000, date: null, description: 'x', details: {} });
    expect((await fin(repo2, b.id)).totals.byCategory.advance).toBe(30000);
  });
});

describe('recuperation (הבראה) כן/לא flag', () => {
  it('persists in employee_months and surfaces in the financials', async () => {
    const p = memory();
    const repo = await open(p);
    const { b, e } = await setup(repo);
    expect((await fin(repo, b.id)).byEmployee.get(e.id)!.recuperationDue).toBe(false);
    await repo.setEmployeeMonth(b.id, e.id, ym, { recuperationDue: true });
    expect((await fin(repo, b.id)).byEmployee.get(e.id)!.recuperationDue).toBe(true);
    // Persists across restart.
    const repo2 = await open(p);
    expect((await fin(repo2, b.id)).byEmployee.get(e.id)!.recuperationDue).toBe(true);
    // Turning it off clears it.
    await repo2.setEmployeeMonth(b.id, e.id, ym, { recuperationDue: false });
    expect((await fin(repo2, b.id)).byEmployee.get(e.id)!.recuperationDue).toBe(false);
  });
});

describe('closed-month protection (req 2)', () => {
  it('a finalized month rejects inline advances/bonuses and the recuperation flag', async () => {
    const repo = await open();
    const { b, e } = await setup(repo);
    await repo.setMonthReview(b.id, ym, 'final', { json: '{}', hash: 'h' }, null, null);
    await expect(
      repo.saveAdjustment({ id: `inline:advance:${e.id}:${ym}`, businessId: b.id, employeeId: e.id, yearMonth: ym, category: 'advance', amountAgorot: 1000, date: null, description: 'x', details: {} }),
    ).rejects.toBeInstanceOf(RepoError);
    await expect(repo.setEmployeeMonth(b.id, e.id, ym, { recuperationDue: true })).rejects.toBeInstanceOf(RepoError);
  });
});
