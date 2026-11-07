import { describe, expect, it } from 'vitest';
import {
  addIstDays,
  derivePromiseStatus,
  keptRate,
  promiseDeadline,
  type PromiseStateRow
} from './promiseState.js';

/**
 * SPEC 12 status derivation, pure: deadline = promised_date + grace_days
 * (default 1); kept when paid >= 95% of promised (a loan that clears early
 * is kept too); broken when now > deadline and paid < 95% (broken_part at
 * >= 25%); still open on the deadline itself. superseded and disputed are
 * terminal statuses that derivation never produces and never counts in the
 * kept-rate; keptRate = kept / (kept + broken + broken_part) over promises
 * whose deadline has passed, null when that denominator is empty — null,
 * never zero, so an empty book cannot masquerade as a 0% kept rate.
 *
 * Money is paise; ratios use integer cross-products (paid*100 vs amount*95)
 * so no float rounding can flip a boundary. Dates are IST keys.
 */

const PROMISED = 100_000; // Rs 1000 in paise

function row(overrides: Partial<PromiseStateRow>): PromiseStateRow {
  return {
    status: 'open',
    promisedDate: '2026-11-01',
    graceDays: 1,
    promisedAmount: PROMISED,
    paidAmount: null,
    loanCleared: false,
    ...overrides
  };
}

describe('promise status derivation (SPEC 12, pure)', () => {
  it('kept early: the full amount paid before the deadline is kept', () => {
    const derived = derivePromiseStatus(row({ paidAmount: PROMISED }), '2026-10-30');
    expect(derived).toBe('kept');
  });

  it('kept exactly at the deadline: 95% paid on the deadline day is kept', () => {
    // deadline = promised 2026-11-01 + 1 grace day = 2026-11-02
    const paid = Math.ceil((PROMISED * 95) / 100);
    expect(derivePromiseStatus(row({ paidAmount: paid }), '2026-11-02')).toBe('kept');
    expect(derivePromiseStatus(row({ paidAmount: paid - 1 }), '2026-11-02')).toBe('open');
  });

  it('broken the day after the deadline: nothing paid', () => {
    expect(derivePromiseStatus(row({ paidAmount: 0 }), '2026-11-03')).toBe('broken');
    expect(derivePromiseStatus(row({ paidAmount: null }), '2026-11-03')).toBe('broken');
  });

  it('broken_part: at least a quarter but under 95% paid past the deadline', () => {
    const quarter = Math.ceil((PROMISED * 25) / 100);
    expect(derivePromiseStatus(row({ paidAmount: quarter }), '2026-11-03')).toBe('broken_part');
    expect(derivePromiseStatus(row({ paidAmount: quarter - 1 }), '2026-11-03')).toBe('broken');
    expect(derivePromiseStatus(row({ paidAmount: Math.ceil((PROMISED * 95) / 100) - 1 }), '2026-11-03')).toBe('broken_part');
  });

  it('grace boundary: still open on the last grace day, broken the day after', () => {
    // now == deadline -> open even with nothing paid; now == deadline + 1 -> broken
    expect(derivePromiseStatus(row({ paidAmount: 0 }), '2026-11-02')).toBe('open');
    expect(derivePromiseStatus(row({ paidAmount: 0 }), '2026-11-03')).toBe('broken');
    expect(promiseDeadline('2026-11-01', 1)).toBe('2026-11-02');
    expect(promiseDeadline('2026-11-01', 3)).toBe('2026-11-04');
  });

  it('a loan that cleared early is kept even with no recorded payments', () => {
    // The LMS feed removed the loan: posting lag may hide the payment, the
    // outcome is still a kept promise (SPEC 12 edge case).
    expect(derivePromiseStatus(row({ paidAmount: 0, loanCleared: true }), '2026-11-03')).toBe('kept');
  });

  it('keptRate counts kept / (kept + broken + broken_part) only past the deadline', () => {
    const rows: PromiseStateRow[] = [
      row({ status: 'kept', promisedDate: '2026-10-01' }), // deadline 10-02, passed
      row({ status: 'broken', promisedDate: '2026-10-02' }), // deadline 10-03, passed
      row({ status: 'broken_part', promisedDate: '2026-10-03' }), // deadline 10-04, passed
      row({ status: 'kept', promisedDate: '2026-11-01' }), // deadline 11-02, NOT passed at 11-01
      row({ status: 'open', promisedDate: '2026-11-01' }) // never counted anyway
    ];
    expect(keptRate(rows, '2026-11-01')).toBeCloseTo(1 / 3, 10);
  });

  it('superseded promises are excluded from the kept-rate statistics', () => {
    const rows: PromiseStateRow[] = [
      row({ status: 'superseded', promisedDate: '2026-10-01' }),
      row({ status: 'kept', promisedDate: '2026-10-01' })
    ];
    expect(keptRate(rows, '2026-11-01')).toBe(1);
  });

  it('disputed promises are excluded from the kept-rate statistics', () => {
    const rows: PromiseStateRow[] = [
      row({ status: 'disputed', promisedDate: '2026-10-01' }),
      row({ status: 'broken', promisedDate: '2026-10-01' })
    ];
    expect(keptRate(rows, '2026-11-01')).toBe(0);
  });

  it('no eligible promises gives null, not zero', () => {
    expect(keptRate([], '2026-11-01')).toBeNull();
    expect(keptRate([row({ status: 'superseded', promisedDate: '2026-10-01' })], '2026-11-01')).toBeNull();
    expect(keptRate([row({ status: 'open', promisedDate: '2026-11-01' })], '2026-11-01')).toBeNull();
  });

  it('addIstDays steps calendar days on the IST anchor', () => {
    expect(addIstDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addIstDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addIstDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 is not a leap year
  });
});
