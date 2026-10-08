/**
 * Calendar facts: weekly-rest windows, statutory Jewish holidays (Israel schedule), holiday eves.
 *
 * Weekly rest for a Jewish employee includes Shabbat. Following the case law cited by secondary sources
 * (Shabbat begins at sunset on Friday and ends at nightfall — "צאת הכוכבים" — on Saturday), the window is
 * computed astronomically for the configured city using @hebcal/core (offline, deterministic).
 * Window boundaries are rounded OUTWARD to whole minutes (start floored, end ceiled) which is the
 * employee-favourable direction.
 */
import { HebrewCalendar, Location, Zmanim, flags } from '@hebcal/core';
import type { CustomHoliday, EmployeeSettings, LocalDate } from './types';
import { addDays, ceilToMinute, floorToMinute, localMidnightUtc, MINUTE_MS, parseDate, weekdayOf } from './time';

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface HolidayInfo {
  date: LocalDate;
  name: string;
  /** Automatic statutory yom-tov, or office-defined custom holiday. */
  source: 'statutory' | 'custom' | 'independence_day';
}

export const DEFAULT_LOCATION = 'Tel Aviv';

/** Israeli cities supported by @hebcal/core's built-in location table, with Hebrew labels. */
export const ISRAELI_CITIES: { value: string; label: string }[] = [
  { value: 'Tel Aviv', label: 'תל אביב' },
  { value: 'Jerusalem', label: 'ירושלים' },
  { value: 'Haifa', label: 'חיפה' },
  { value: 'Beer Sheva', label: 'באר שבע' },
  { value: 'Ashdod', label: 'אשדוד' },
  { value: 'Netanya', label: 'נתניה' },
  { value: 'Petach Tikvah', label: 'פתח תקווה' },
  { value: 'Rishon LeZion', label: 'ראשון לציון' },
  { value: 'Eilat', label: 'אילת' },
  { value: 'Tiberias', label: 'טבריה' },
];

const locationCache = new Map<string, Location>();
function getLocation(name: string): Location {
  let loc = locationCache.get(name);
  if (!loc) {
    loc = Location.lookup(name) ?? Location.lookup(DEFAULT_LOCATION)!;
    locationCache.set(name, loc);
  }
  return loc;
}

function zmanimFor(location: string, date: LocalDate): Zmanim {
  const p = parseDate(date);
  // Noon local avoids any ambiguity in how the library reads the JS Date's calendar day.
  return new Zmanim(getLocation(location), new Date(p.y, p.m - 1, p.d, 12, 0, 0), false);
}

const sunsetCache = new Map<string, number>();
export function sunsetMs(location: string, date: LocalDate): number {
  const key = `${location}|${date}`;
  let v = sunsetCache.get(key);
  if (v === undefined) {
    v = floorToMinute(zmanimFor(location, date).sunset().getTime());
    sunsetCache.set(key, v);
  }
  return v;
}

const tzeitCache = new Map<string, number>();
/** Nightfall (tzeit hakochavim, sun 8.5° below horizon). */
export function nightfallMs(location: string, date: LocalDate): number {
  const key = `${location}|${date}`;
  let v = tzeitCache.get(key);
  if (v === undefined) {
    v = ceilToMinute(zmanimFor(location, date).tzeit(8.5).getTime());
    tzeitCache.set(key, v);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Statutory holidays (Israel schedule)
// ---------------------------------------------------------------------------

const yearHolidayCache = new Map<number, HolidayInfo[]>();

/** Yom-tov days on which work is prohibited in Israel + Independence Day. */
export function statutoryHolidaysForYear(year: number): HolidayInfo[] {
  const cached = yearHolidayCache.get(year);
  if (cached) return cached;
  const events = HebrewCalendar.calendar({
    start: new Date(year, 0, 1, 12),
    end: new Date(year, 11, 31, 12),
    il: true,
    noMinorFast: true,
    noSpecialShabbat: true,
    noRoshChodesh: true,
  });
  const out: HolidayInfo[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const f = ev.getFlags();
    const g = ev.getDate().greg();
    const date = `${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, '0')}-${String(g.getDate()).padStart(2, '0')}`;
    const isChag = (f & flags.CHAG) !== 0 && (f & flags.CHOL_HAMOED) === 0 && (f & flags.EREV) === 0;
    const isIndependence = ev.getDesc().startsWith("Yom HaAtzma'ut");
    if ((isChag || isIndependence) && !seen.has(date)) {
      seen.add(date);
      out.push({
        date,
        name: stripNikud(ev.render('he')),
        source: isIndependence ? 'independence_day' : 'statutory',
      });
    }
  }
  yearHolidayCache.set(year, out);
  return out;
}

function stripNikud(s: string): string {
  return s.replace(/[֑-ׇ]/g, '');
}

export class CalendarContext {
  private holidays = new Map<LocalDate, HolidayInfo>();

  constructor(
    from: LocalDate,
    to: LocalDate,
    customHolidays: CustomHoliday[],
  ) {
    const y0 = parseDate(addDays(from, -2)).y;
    const y1 = parseDate(addDays(to, 2)).y;
    for (let y = y0; y <= y1; y++) for (const h of statutoryHolidaysForYear(y)) this.holidays.set(h.date, h);
    for (const c of customHolidays) {
      if (!this.holidays.has(c.date)) this.holidays.set(c.date, { date: c.date, name: c.name, source: 'custom' });
    }
  }

  /** Holiday applicable to the employee on a date (statutory only if the employee follows the Jewish calendar). */
  holidayOn(date: LocalDate, settings: EmployeeSettings): HolidayInfo | null {
    const h = this.holidays.get(date);
    if (!h) return null;
    if (h.source === 'custom') return h;
    return settings.holidayCalendar === 'jewish_israel' ? h : null;
  }

  /** Statutory holiday eve: the next day is a yom-tov and this day is not (Independence Day eve excluded). */
  isHolidayEve(date: LocalDate, settings: EmployeeSettings): boolean {
    if (settings.holidayCalendar !== 'jewish_israel') return false;
    const next = this.holidays.get(addDays(date, 1));
    if (!next || next.source !== 'statutory') return false;
    const today = this.holidays.get(date);
    return !today || today.source !== 'statutory';
  }

  /**
   * Holiday premium window. Statutory/Independence Day: sunset of the previous day → nightfall of the day.
   * Custom holiday: civil day 00:00–24:00.
   */
  holidayWindow(h: HolidayInfo, settings: EmployeeSettings): Interval {
    const w = settings.weeklyRest;
    if (h.source === 'custom') {
      return { startMs: localMidnightUtc(h.date), endMs: localMidnightUtc(addDays(h.date, 1)) };
    }
    return {
      startMs: sunsetMs(settings.location, addDays(h.date, -1)) - w.startOffsetMinutes * MINUTE_MS,
      endMs: nightfallMs(settings.location, h.date) + w.endOffsetMinutes * MINUTE_MS,
    };
  }

  /** The weekly-rest "core" day for the week (Saturday for Shabbat, otherwise the fixed day). */
  restWeekday(settings: EmployeeSettings): number {
    return settings.weeklyRest.kind === 'shabbat' ? 6 : (settings.weeklyRest.fixedDay ?? 6);
  }

  /** The weekly-rest window anchored on the given rest day. */
  restWindow(restDay: LocalDate, settings: EmployeeSettings): Interval {
    const w = settings.weeklyRest;
    if (w.kind === 'shabbat') {
      return {
        startMs: sunsetMs(settings.location, addDays(restDay, -1)) - w.startOffsetMinutes * MINUTE_MS,
        endMs: nightfallMs(settings.location, restDay) + w.endOffsetMinutes * MINUTE_MS,
      };
    }
    return {
      startMs: localMidnightUtc(restDay) - w.startOffsetMinutes * MINUTE_MS,
      endMs: localMidnightUtc(addDays(restDay, 1)) + w.endOffsetMinutes * MINUTE_MS,
    };
  }

  isRestDay(date: LocalDate, settings: EmployeeSettings): boolean {
    return weekdayOf(date) === this.restWeekday(settings);
  }

  /** Day before the weekly rest day (Friday for Shabbat). */
  isRestEve(date: LocalDate, settings: EmployeeSettings): boolean {
    return weekdayOf(addDays(date, 1)) === this.restWeekday(settings);
  }
}
