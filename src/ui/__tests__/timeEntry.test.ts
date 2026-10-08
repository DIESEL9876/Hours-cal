import { describe, expect, it } from 'vitest';
import { buildTimestamps, normalizeTimeInput, parseBreakInput } from '../timeEntry';

describe('normalizeTimeInput', () => {
  it.each([
    ['8', '08:00'],
    ['08', '08:00'],
    ['830', '08:30'],
    ['0830', '08:30'],
    ['1730', '17:30'],
    ['8:5', '08:05'],
    ['8:05', '08:05'],
    ['17.30', '17:30'],
    ['24', '00:00'],
    ['0', '00:00'],
    ['', ''],
    ['  ', ''],
  ])('%s → %s', (input, out) => expect(normalizeTimeInput(input)).toBe(out));
  it.each(['17.5', '25', '2400x', '1260', '8:75', 'abc', '12345', '-1'])('rejects %s', (input) => expect(normalizeTimeInput(input)).toBeNull());
});

describe('buildTimestamps', () => {
  it('same-day shift', () => {
    expect(buildTimestamps('2026-10-12', '08:00', '17:30')).toEqual({ startAt: '2026-10-12T08:00', endAt: '2026-10-12T17:30', overnight: false, error: null });
  });
  it('overnight shift rolls the exit to the next day (incl. month end)', () => {
    expect(buildTimestamps('2026-10-31', '22:00', '06:00')).toEqual({ startAt: '2026-10-31T22:00', endAt: '2026-11-01T06:00', overnight: true, error: null });
  });
  it('equal times are rejected', () => {
    expect(buildTimestamps('2026-10-12', '08:00', '08:00').error).not.toBeNull();
  });
  it('partial entries are kept as incomplete', () => {
    expect(buildTimestamps('2026-10-12', '08:00', '').endAt).toBeNull();
    expect(buildTimestamps('2026-10-12', '', '17:00').startAt).toBeNull();
  });
});

describe('parseBreakInput', () => {
  it('parses minutes and h:mm', () => {
    expect(parseBreakInput('30')).toBe(30);
    expect(parseBreakInput('0:45')).toBe(45);
    expect(parseBreakInput('1:00')).toBe(60);
    expect(parseBreakInput('')).toBeNull();
    expect(parseBreakInput('x')).toBe('invalid');
    expect(parseBreakInput('-5')).toBe('invalid');
  });
});
