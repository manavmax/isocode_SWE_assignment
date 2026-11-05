import { describe, expect, it } from 'vitest';
import { maskPhone } from './phone.js';

describe('maskPhone (A32: first two + X last two)', () => {
  it('masks the brief example 98XXXXXX21', () => {
    expect(maskPhone('9876543321')).toBe('98XXXXXX21');
  });

  it('preserves length for other digit counts', () => {
    expect(maskPhone('9700011234')).toBe('97XXXXXX34');
    expect(maskPhone('1234567')).toBe('12XXX67');
    expect(maskPhone('1313555012345')).toBe('13XXXXXXXXX45');
  });

  it('strips formatting that the importer tolerated', () => {
    expect(maskPhone('+91 98765 43321')).toBe('91XXXXXXXX21');
  });

  it('gives up (null) when there is nothing safely maskable', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('12')).toBeNull();
    expect(maskPhone('   ')).toBeNull();
  });
});
