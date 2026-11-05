import { describe, expect, it } from 'vitest';
import { formatLakhCrore, formatRupeePaise } from './money.js';

describe('formatLakhCrore (Indian grouping, SPEC 15)', () => {
  it('keeps 999 ungrouped', () => {
    expect(formatLakhCrore(999)).toBe('999');
  });
  it('groups thousands plainly', () => {
    expect(formatLakhCrore(1000)).toBe('1,000');
    expect(formatLakhCrore(99999)).toBe('99,999');
  });
  it('uses the 2-2-2 lakh/crore pattern', () => {
    expect(formatLakhCrore(100000)).toBe('1,00,000');
    expect(formatLakhCrore(10000000)).toBe('1,00,00,000');
    expect(formatLakhCrore(12345678)).toBe('1,23,45,678');
  });
  it('handles 0 and negatives', () => {
    expect(formatLakhCrore(0)).toBe('0');
    expect(formatLakhCrore(-1234)).toBe('-1,234');
  });
  it('truncates fractional rupees', () => {
    expect(formatLakhCrore(1234.9)).toBe('1,234');
  });
  it('returns a dash for non-finite input', () => {
    expect(formatLakhCrore(Number.NaN)).toBe('-');
  });
});

describe('formatRupeePaise (rupee display from paise, tabular-friendly)', () => {
  it('renders paise with two decimals', () => {
    expect(formatRupeePaise(123456789)).toBe('₹12,34,567.89');
    expect(formatRupeePaise(5)).toBe('₹0.05');
    expect(formatRupeePaise(100)).toBe('₹1.00');
  });
  it('renders whole rupees with .00 for stable number width', () => {
    expect(formatRupeePaise(10000000)).toBe('₹1,00,000.00');
  });
  it('handles zero and negatives', () => {
    expect(formatRupeePaise(0)).toBe('₹0.00');
    expect(formatRupeePaise(-250)).toBe('-₹2.50');
  });
});
