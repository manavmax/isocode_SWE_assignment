import { describe, expect, it } from 'vitest';
import { toPaise } from './money.js';

describe('toPaise', () => {
  it('_strips rupee symbol Rs. and /- suffix', () => {
    expect(toPaise('Rs. 6,40,000/-')).toBe(64000000);
    expect(toPaise('\u20b9 5500')).toBe(550000);
    expect(toPaise('INR 150/-')).toBe(15000);
  });

  it('_parses decimal rupees down to the paise', () => {
    expect(toPaise('1200.5')).toBe(120050);
    expect(toPaise('1200.05')).toBe(120005);
    expect(toPaise('0.99')).toBe(99);
  });

  it('_handles Indian comma grouping beyond thousands', () => {
    expect(toPaise('12,34,567')).toBe(123456700);
    expect(toPaise('25,00,000')).toBe(250000000);
  });

  it('_rejects L and Cr shorthand', () => {
    expect(toPaise('6L')).toBeNull();
    expect(toPaise('1.2Cr')).toBeNull();
    expect(toPaise('50Lakhs')).toBeNull();
  });

  it('_rejects scientific notation', () => {
    expect(toPaise('1.2e5')).toBeNull();
    expect(toPaise('1.2E5')).toBeNull();
    expect(toPaise('9.87E+9')).toBeNull();
  });

  it('_rejects empty and dash and plain junk', () => {
    expect(toPaise('')).toBeNull();
    expect(toPaise(' - ')).toBeNull();
    expect(toPaise('nil')).toBeNull();
    expect(toPaise('abc')).toBeNull();
  });

  it('_rejects negatives and three-decimal amounts', () => {
    expect(toPaise('-500')).toBeNull();
    expect(toPaise('Rs. (500)/-')).toBeNull();
    expect(toPaise('1.999')).toBeNull();
  });

  it('_trims stray spaces inside the number', () => {
    expect(toPaise(' Rs 12,500 ')).toBe(1250000);
  });
});
