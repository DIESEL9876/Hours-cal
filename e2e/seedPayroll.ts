/**
 * Fictional demo data for the payroll-entry PDF tests and screenshots (1.1.13). Built in Node with the real
 * Repository (sql.js), then injected into the browser preview's IndexedDB — the app computes everything itself.
 * All names and figures are invented.
 */
import initSqlJs from 'sql.js';
import type { Page } from '@playwright/test';
import { SqlJsDriver, type SqlJsPersistence } from '../src/data/sqljsDriver';
import { Repository } from '../src/data/repo';
import { computeBusinessMonth, sha256Hex, snapshotOf } from '../src/data/service';
import { defaultEmployeeSettings, type ShiftInput } from '../src/engine';
import { buildTimestamps } from '../src/ui/timeEntry';

export const DEMO_BUSINESS = 'מאפיית השקמה (דוגמה)';

const FIRST = ['אורית', 'בני', 'גלעד', 'דפנה', 'הדס', 'ויקטור', 'זיו', 'חן', 'טל', 'יעל', 'כרמל', 'ליאור', 'מאיה', 'נדב', 'סיון', 'עומר', 'פזית', 'צחי', 'קרן', 'רועי', 'שירן', 'תומר', 'אביטל', 'ברק', 'גאיה', 'דניאל', 'הילה', 'ורד', 'זהבה', 'חגי', 'טליה', 'ינון', 'כנרת', 'לביא', 'מורן', 'נגה'];
const LAST = ['אלמוג', 'ברוש', 'גפן', 'דקל', 'הדר', 'ורדי', 'זית', 'חרוב', 'טללי', 'יערי', 'כליל', 'לבנה', 'מור', 'נחל', 'סלע', 'ענבר', 'פלג', 'צור'];

const shift = (date: string, start: string, end: string | null, breakMinutes = 30): ShiftInput => {
  const ts = buildTimestamps(date, start, end ?? start);
  return { id: crypto.randomUUID(), workDate: date, startAt: ts.startAt, endAt: end ? ts.endAt : null, breakMinutes, breakStart: null, breakConfirmed: true, breakPaid: false, reviewed: false };
};

/** Deterministic pseudo-random numbers so the sample PDF is reproducible. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const t = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export async function buildDemoDatabase(employees = 36, opts: { finalize?: boolean } = {}): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  let bytes: Uint8Array | null = null;
  const p: SqlJsPersistence = {
    location: 'memory',
    load: async () => null,
    save: async (b) => void (bytes = b),
    saveBackup: async () => undefined,
    loadBackup: async () => null,
    listBackups: async () => [],
  };
  const repo = new Repository(await SqlJsDriver.open(SQL, p));
  await repo.migrate();
  const defaults = defaultEmployeeSettings({ breakMethod: 'manual', hourlyRateAgorot: 4250, travel: { mode: 'daily', amountAgorot: 1250 } });
  const b = await repo.createBusiness({ name: DEMO_BUSINESS, defaults });
  const { fridayOvertimeHistory: _f, weeklyCreditHistory: _w, ...copy } = b.defaults;
  const r = rng(20261101);
  const ym = '2026-11';
  for (let i = 0; i < employees; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const travel = i === 5 ? { mode: 'none' as const, amountAgorot: null } : i % 6 === 0 ? { mode: 'monthly' as const, amountAgorot: 30000 } : undefined;
    const e = await repo.createEmployee(b.id, {
      fullName: name,
      employeeNumber: String(1001 + i),
      settings: { ...copy, ...(travel ? { travel } : {}), absence: { employmentStart: '2023-01-01', salaryType: 'hourly' } },
    });
    // Employees with absences in November get September–October history, so the paid-day average can be computed.
    if (i % 11 === 3 || i % 7 === 2 || i === 8) {
      for (const [month, days] of [[9, 30], [10, 31]] as const) {
        for (let d = 1; d <= days; d++) {
          const wd = new Date(Date.UTC(2026, month - 1, d)).getUTCDay();
          if (wd <= 4) await repo.upsertShift(b.id, e.id, shift(`2026-${pad(month)}-${pad(d)}`, '08:00', '16:30'));
        }
      }
    }
    // Weekdays of November 2026 (1 Nov = Sunday). Fridays short, some Saturdays.
    for (let d = 1; d <= 30; d++) {
      const date = `2026-11-${pad(d)}`;
      const wd = new Date(Date.UTC(2026, 10, d)).getUTCDay(); // 0 = Sunday
      if (wd === 6) {
        if (i % 9 === 1 && d <= 14) await repo.upsertShift(b.id, e.id, shift(date, '07:00', '13:00', 0));
        continue;
      }
      if (wd === 5) {
        if (i === 16 && d === 13) await repo.upsertShift(b.id, e.id, shift(date, '06:30', '11:45', 0)); // one unscheduled Friday (review)
        continue;
      }
      if (i % 11 === 3 && d >= 16 && d <= 18) {
        await repo.setDayEntry(b.id, e.id, { date, status: 'sick', note: null });
        continue;
      }
      if (i % 7 === 2 && (d === 9 || d === 10)) {
        await repo.setDayEntry(b.id, e.id, { date, status: 'vacation', note: null });
        continue;
      }
      if (i === 8 && d >= 23 && d <= 25) {
        await repo.setDayEntry(b.id, e.id, { date, status: 'reserve', note: null });
        continue;
      }
      const start = 360 + Math.floor(r() * 120); // 06:00–08:00
      const length = 480 + Math.floor(r() * 200) - (i % 5 === 4 ? 150 : 0); // part-timers shorter
      const missingExit = i === 12 && d === 26;
      await repo.upsertShift(b.id, e.id, shift(date, t(start), missingExit ? null : t(start + length + 30)));
    }
    if (i % 3 === 0) await repo.saveAdjustment({ id: `inline:advance:${e.id}:${ym}`, businessId: b.id, employeeId: e.id, yearMonth: ym, category: 'advance', amountAgorot: 50000 + (i % 4) * 25000, date: null, description: 'מקדמה', details: {} });
    if (i % 4 === 1) await repo.saveAdjustment({ id: `inline:bonus:${e.id}:${ym}`, businessId: b.id, employeeId: e.id, yearMonth: ym, category: 'bonus', amountAgorot: 30000 + i * 1750, date: null, description: 'בונוס', details: {} });
    if (i % 5 === 2) await repo.setEmployeeMonth(b.id, e.id, ym, { recuperationDue: true });
  }
  if (opts.finalize) {
    const summary = await computeBusinessMonth(repo, b.id, 2026, 11);
    const json = snapshotOf(summary);
    await repo.setMonthReview(b.id, ym, 'final', { json, hash: await sha256Hex(json) }, null, null);
  }
  if (!bytes) throw new Error('database was not saved');
  return bytes;
}

/** Loads the database into the preview's IndexedDB and reloads the app. */
export async function loadDemo(page: Page, bytes: Uint8Array) {
  await page.goto('/');
  await page.evaluate(async (arr) => {
    const data = new Uint8Array(arr);
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('hours-cal', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('db');
        req.result.createObjectStore('backups');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('db', 'readwrite');
        tx.objectStore('db').put(data, 'main');
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, Array.from(bytes));
  await page.reload();
}
