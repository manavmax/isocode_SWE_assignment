import { describe, expect, it } from 'vitest';
import { todayIst } from './ist.js';

describe('todayIst', () => {
  it('returns the IST calendar date for a given instant', () => {
    expect(todayIst(new Date('2026-11-04T18:00:00Z'))).toBe('2026-11-04');
  });

  it('rolls to the next IST day at midnight IST', () => {
    expect(todayIst(new Date('2026-11-04T18:30:00Z'))).toBe('2026-11-05');
  });
});
