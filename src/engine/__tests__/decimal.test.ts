import { describe, expect, it } from 'vitest';
import { decimalHundredths, formatDecimalHours, formatHM } from '../index';

const m = (h: number, mm: number) => h * 60 + mm;

describe('decimal hours = total minutes / 60, exactly 2 decimals', () => {
  it.each([
    [m(8, 30), '8.50'],
    [m(8, 24), '8.40'],
    [m(1, 15), '1.25'],
    [m(26, 20), '26.33'],
    [m(149, 9), '149.15'],
    [m(181, 26), '181.43'],
    [m(8, 36), '8.60'],
    [m(7, 36), '7.60'],
  ])('%i minutes → %s', (minutes, expected) => expect(formatDecimalHours(minutes)).toBe(expected));

  it('minute boundaries', () => {
    expect(formatDecimalHours(0)).toBe('0.00');
    expect(formatDecimalHours(1)).toBe('0.02'); // 0.01666…
    expect(formatDecimalHours(2)).toBe('0.03'); // 0.0333…
    expect(formatDecimalHours(3)).toBe('0.05');
    expect(formatDecimalHours(20)).toBe('0.33');
    expect(formatDecimalHours(40)).toBe('0.67');
    expect(formatDecimalHours(59)).toBe('0.98');
    expect(formatDecimalHours(60)).toBe('1.00');
    expect(formatDecimalHours(61)).toBe('1.02');
    expect(formatDecimalHours(119)).toBe('1.98');
    expect(formatDecimalHours(120)).toBe('2.00');
  });

  it('totals exceeding 100 hours', () => {
    expect(formatDecimalHours(m(100, 0))).toBe('100.00');
    expect(formatDecimalHours(m(100, 1))).toBe('100.02');
    expect(formatDecimalHours(m(99, 59))).toBe('99.98');
    expect(formatDecimalHours(m(365, 3))).toBe('365.05');
    expect(formatDecimalHours(m(1000, 20))).toBe('1000.33');
    expect(formatDecimalHours(m(9999, 59))).toBe('9999.98');
  });

  it('every minute 0…20,000 matches exact rational rounding of minutes/60 to hundredths', () => {
    for (let minutes = 0; minutes <= 20_000; minutes++) {
      // exact: hundredths = minutes × 100 / 60 = minutes × 5 / 3; round to nearest (no ties possible)
      const num = minutes * 5;
      const q = Math.floor(num / 3);
      const r = num % 3;
      const expected = r === 2 ? q + 1 : q;
      expect(decimalHundredths(minutes)).toBe(expected);
      // never further than half a hundredth from the true value
      expect(Math.abs(decimalHundredths(minutes) / 100 - minutes / 60)).toBeLessThanOrEqual(0.005 + 1e-12);
      const s = formatDecimalHours(minutes);
      expect(s).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('is computed from the minute total, not from the HH:MM text (8:24 is not 8.24)', () => {
    expect(formatHM(504)).toBe('8:24');
    expect(formatDecimalHours(504)).toBe('8.40');
    expect(formatDecimalHours(504)).not.toBe('8.24');
  });

  it('sum of rounded parts may differ from the rounded total — totals are always converted from the total minutes', () => {
    // 3 × 0:01 = 0:03 → 0.05, whereas 0.02 + 0.02 + 0.02 = 0.06
    expect(formatDecimalHours(3)).toBe('0.05');
  });

  it('negative values are symmetric and non-integers are rejected', () => {
    expect(formatDecimalHours(-90)).toBe('-1.50');
    expect(() => formatDecimalHours(1.5)).toThrow();
  });
});
