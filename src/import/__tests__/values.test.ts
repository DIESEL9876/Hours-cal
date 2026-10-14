import { describe, expect, it } from 'vitest';
import { inferDateOrder, matchHeader, nameKey, parseBreakCell, parseDateCell, parseTimeCell, parseWeekday, sameEmployee, serialToParts } from '../values';

const t = (text: string) => ({ text });

describe('header recognition (Hebrew and English, any order)', () => {
  it.each([
    ['תאריך', 'date'],
    ['תאריך עבודה', 'date'],
    ['Date', 'date'],
    ['יום', 'weekday'],
    ['כניסה', 'in'],
    ['שעת כניסה', 'in'],
    ['התחלה', 'in'],
    ['Clock In', 'in'],
    ['Start Time', 'in'],
    ['יציאה', 'out'],
    ['שעת יציאה', 'out'],
    ['סיום', 'out'],
    ['Clock Out', 'out'],
    ['End Time', 'out'],
    ['הפסקה', 'break'],
    ['סה"כ הפסקה מדווחת', 'break'],
    ['Break (min)', 'break'],
    ['שעות עבודה', 'total'],
    ['סה"כ', 'total'],
    ['יציאה להפסקה', 'breakOut'],
    ['חזרה מהפסקה', 'breakIn'],
    ['Employee Name', 'employee'],
    ['מספר עובד', 'employeeNo'],
  ])('%s → %s', (label, role) => {
    expect(matchHeader(label)?.role).toBe(role);
  });

  it('reads sequence numbers ("1 כניסה", "Clock In 2")', () => {
    expect(matchHeader('1 כניסה')).toMatchObject({ role: 'in', index: 1 });
    expect(matchHeader('2 יציאה')).toMatchObject({ role: 'out', index: 2 });
    expect(matchHeader('Clock In 2')).toMatchObject({ role: 'in', index: 2 });
  });

  it('does not treat look-alike columns as attendance columns', () => {
    for (const l of ['מצטבר', 'תקן', 'שעות בחוסר', 'שעות עודפות', 'תאריך הדפסה', 'הערות', 'מיקום']) expect(matchHeader(l)?.role === 'in' || matchHeader(l)?.role === 'out' || matchHeader(l)?.role === 'date').toBe(false);
  });

  it('tolerates letter-spaced / reversed Hebrew from PDFs', () => {
    expect(matchHeader('כ ני ס ה')?.role).toBe('in');
    expect(matchHeader('הסינכ')?.role).toBe('in');
  });
});

describe('dates', () => {
  it('DD/MM/YYYY (Israeli default), DD.MM.YY, ISO', () => {
    expect(parseDateCell(t('01/09/2026'))).toBe('2026-09-01');
    expect(parseDateCell(t('1/9/26'))).toBe('2026-09-01');
    expect(parseDateCell(t('30.09.2026'))).toBe('2026-09-30');
    expect(parseDateCell(t('2026-09-15'))).toBe('2026-09-15');
  });
  it('month-first only when the column proves it', () => {
    expect(inferDateOrder(['09/01/2026', '09/13/2026'])).toBe('mdy');
    expect(inferDateOrder(['01/09/2026', '13/09/2026'])).toBe('dmy');
    expect(inferDateOrder(['01/09/2026', '02/09/2026'])).toBe('dmy');
    expect(parseDateCell(t('09/13/2026'), 'mdy')).toBe('2026-09-13');
  });
  it('invalid dates and missing years are not guessed', () => {
    expect(parseDateCell(t('31/02/2026'))).toBeNull();
    expect(parseDateCell(t('01/09'))).toBeNull();
    expect(parseDateCell(t('01/09'), 'dmy', 2026)).toBe('2026-09-01');
    expect(parseDateCell(t('סה"כ'))).toBeNull();
  });
  it('Excel native dates', () => {
    expect(parseDateCell({ text: '', serial: 46266, isDateLike: true })).toBe('2026-09-01');
    expect(serialToParts(46266.75)).toEqual({ date: '2026-09-01', minutes: 1080 });
  });
});

describe('clock times', () => {
  const ok = (cell: Parameters<typeof parseTimeCell>[0]) => {
    const v = parseTimeCell(cell);
    if (!v || 'error' in v) throw new Error(`not a time: ${JSON.stringify(v)}`);
    return v;
  };
  it('HH:MM variants, seconds, AM/PM, 24:00', () => {
    expect(ok(t('07:54')).time).toBe('07:54');
    expect(ok(t('7:05')).time).toBe('07:05');
    expect(ok(t('17:30:59')).time).toBe('17:30');
    expect(ok(t('5:30 PM')).time).toBe('17:30');
    expect(ok(t('12:15 am')).time).toBe('00:15');
    expect(ok(t('24:00')).time).toBe('00:00');
  });
  it('Excel native time fractions and date+time cells', () => {
    expect(ok({ text: '0.3333333', serial: 8 / 24 }).time).toBe('08:00');
    expect(ok({ text: '', serial: 46266 + 17.5 / 24, isDateLike: true })).toMatchObject({ time: '17:30', date: '2026-09-01' });
    expect(ok(t('02/09/2026 02:00'))).toMatchObject({ time: '02:00', date: '2026-09-02' });
  });
  it('markers are kept as information, dot times are flagged, garbage is an error (never guessed)', () => {
    expect(ok(t('*12:30'))).toMatchObject({ time: '12:30', marked: true });
    expect(ok(t('8.30')).flags.length).toBe(1);
    expect(parseTimeCell(t('25:10'))).toHaveProperty('error');
    expect(parseTimeCell(t('8'))).toHaveProperty('error');
    expect(parseTimeCell(t('בוקר'))).toHaveProperty('error');
    expect(parseTimeCell(t('-'))).toBeNull();
    expect(parseTimeCell(t(''))).toBeNull();
    expect(parseTimeCell({ text: '', unresolvedFormula: true })).toHaveProperty('error');
  });
  it('PDF cells with wrapped neighbour text use the single numeric piece', () => {
    expect(ok({ text: '17:13 הצפון ישראל', parts: ['17:13', 'הצפון ישראל'] }).time).toBe('17:13');
    expect(parseTimeCell({ text: '08:00 09:00', parts: ['08:00', '09:00'] })).toHaveProperty('error');
  });
});

describe('breaks', () => {
  it('H:MM, minutes and Excel time; decimals are ambiguous', () => {
    expect(parseBreakCell(t('0:30'))).toBe(30);
    expect(parseBreakCell(t('00:45:00'))).toBe(45);
    expect(parseBreakCell(t('30'))).toBe(30);
    expect(parseBreakCell({ text: '', serial: 30 / 1440, isDateLike: true })).toBe(30);
    expect(parseBreakCell(t('0.5'))).toHaveProperty('error');
    expect(parseBreakCell(t('500'))).toHaveProperty('error');
    expect(parseBreakCell(t(''))).toBeNull();
  });
});

describe('weekdays and employees', () => {
  it('Hebrew letters/names and English', () => {
    expect(parseWeekday("ג'")).toBe(2);
    expect(parseWeekday('שבת')).toBe(6);
    expect(parseWeekday('יום רביעי')).toBe(3);
    expect(parseWeekday('Fri')).toBe(5);
    expect(parseWeekday('ערב חג')).toBeNull();
  });
  it('name matching ignores word order, tolerates one extra word, matches employee numbers', () => {
    expect(nameKey('נגר עילי')).toBe(nameKey('עילי נגר'));
    expect(sameEmployee({ name: 'לא עילי נגר', number: null }, { fullName: 'עילי נגר', employeeNumber: null })).toBe(true);
    expect(sameEmployee({ name: 'אבי לוי', number: null }, { fullName: 'עילי נגר', employeeNumber: null })).toBe(false);
    expect(sameEmployee({ name: null, number: '130' }, { fullName: 'x', employeeNumber: '130' })).toBe(true);
  });
});
