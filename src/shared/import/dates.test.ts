import { describe, expect, it } from 'vitest';
import { parseCsvDate, parsePromiseCell } from './dates.js';

describe('parseCsvDate', () => {
  it('_parses day-first dd/mm/yyyy', () => {
    expect(parseCsvDate('05/11/2026')).toBe('2026-11-05');
    expect(parseCsvDate('31-Mar-25')).toBe('2025-03-31');
  });

  it('_parses dd-mmm-yy and hyphen and dot variants day-first', () => {
    expect(parseCsvDate('31-Oct-26')).toBe('2026-10-31');
    expect(parseCsvDate('07-04-2026')).toBe('2026-04-07');
    expect(parseCsvDate('07.04.2026')).toBe('2026-04-07');
  });

  it('_parses iso yyyy-mm-dd as-is', () => {
    expect(parseCsvDate('2026-10-31')).toBe('2026-10-31');
  });

  it('_parses excel serial numbers against the 1899-12-30 origin', () => {
    expect(parseCsvDate('2')).toBe('1900-01-01');
    expect(parseCsvDate('46119')).toBe('2026-04-07');
    expect(parseCsvDate('46119')).toBe(parseCsvDate('07-04-2026'));
  });

  it('_rejects impossible dates and junk', () => {
    expect(parseCsvDate('31/02/2026')).toBeNull();
    expect(parseCsvDate('32/01/2026')).toBeNull();
    expect(parseCsvDate('abc')).toBeNull();
    expect(parseCsvDate('')).toBeNull();
  });
});

describe('parsePromiseCell', () => {
  it('_parses a dash cell as no promise', () => {
    expect(parsePromiseCell('-')).toEqual({ iso: null, note: null });
    expect(parsePromiseCell('  -  ')).toEqual({ iso: null, note: null });
  });

  it('_keeps the annotation as note when a date is followed by text', () => {
    expect(parsePromiseCell('2026-10-31 (broken)')).toEqual({
      iso: '2026-10-31',
      note: '(broken)'
    });
  });

  it('_parses day-first dates inside annotated cells', () => {
    expect(parsePromiseCell('05/11/2026 - spoke, will pay next week')).toEqual({
      iso: '2026-11-05',
      note: '- spoke, will pay next week'
    });
  });

  it('_returns text as note when no date can be parsed', () => {
    expect(parsePromiseCell('asked again next Monday')).toEqual({ iso: null, note: 'asked again next Monday' });
  });

  it('_parses a clean date with no note', () => {
    expect(parsePromiseCell('05/11/2026')).toEqual({ iso: '2026-11-05', note: null });
  });
});
