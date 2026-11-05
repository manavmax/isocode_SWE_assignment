import { describe, expect, it } from 'vitest';
import { istDateKey, istDateParts, istMinutesOfDay, IST_OFFSET_MIN, formatIstTime } from './datetime.js';

describe('IST helpers (SPEC 4/7: instants are UTC, IST derived)', () => {
  it('istMinutesOfDay follows (utcMs/60000 + 330) mod 1440', () => {
    expect(IST_OFFSET_MIN).toBe(330);
    const noonUtc = Date.UTC(2026, 10, 5, 12, 0, 0);
    expect(istMinutesOfDay(noonUtc)).toBe((720 + 330) % 1440);
    expect(istMinutesOfDay(Date.UTC(2026, 10, 5, 18, 30, 0))).toBe(0);
  });

  it('derives IST date parts across the midnight boundary', () => {
    const parts = istDateParts(Date.UTC(2026, 10, 5, 18, 30, 0));
    expect(parts).toEqual({ year: 2026, month: 11, day: 6, hour: 0, minute: 0, weekday: 5 });
  });

  it('formats 24h IST time', () => {
    expect(formatIstTime(Date.UTC(2026, 10, 5, 4, 30, 0))).toBe('10:00');
    expect(formatIstTime(Date.UTC(2026, 10, 5, 12, 5, 0))).toBe('17:35');
  });

  it('formats an IST date key independent of device timezone', () => {
    expect(istDateKey(Date.UTC(2026, 10, 5, 18, 30, 0))).toBe('2026-11-06');
    expect(istDateKey(Date.UTC(2026, 10, 5, 0, 0, 0))).toBe('2026-11-05');
  });
});
