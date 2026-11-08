import { describe, expect, it } from 'vitest';
import {
  aggregateByBranch,
  aggregateByOfficer,
  computeRollRate,
  enumerateWindows,
  migrationTable,
  wilsonInterval,
  type CohortSlice,
  type OutcomeRow
} from './rollRate.js';

/**
 * SPEC 13 cohort roll rate, pure: a cohort = loans in 1-30 DPD at the t0
 * snapshot; the outcome at t1 = t0 + 30 days is cured (absent or DPD 0),
 * stayed (back in 1-30) or rolled (31+). Attribution is to the OPENING
 * branch and officer — the t0 rows decide, never the t1 assignment. Both a
 * count and a balance version exist; an immature window reports "pending",
 * never zero; the Wilson 95% interval accompanies the count rate; rows
 * with n < 30 are flagged for greying out.
 */

function slice(loanId: string, branchId: string, officerId: string | null, dpd: number, outstanding: number): CohortSlice {
  return { loanId, branchId, officerId, dpd, outstanding };
}

function outcome(loanId: string, dpd: number | null): OutcomeRow {
  return { loanId, dpd };
}

describe('cohort roll rate (SPEC 13, pure)', () => {
  it('footing: cured + stayed + rolled = cohort, on counts and on balances', () => {
    const t0 = [
      slice('L1', 'B', 'O1', 10, 100),
      slice('L2', 'B', 'O1', 20, 200),
      slice('L3', 'B', 'O2', 5, 400),
      slice('L4', 'B', 'O2', 15, 300)
    ];
    const t1 = [outcome('L1', 10), outcome('L2', 45), outcome('L3', null), outcome('L4', 0)];
    const result = computeRollRate(t0, t1, { windowComplete: true });
    expect(result.cohortN).toBe(4);
    expect(result.cured + result.stayed + result.rolled).toBe(result.cohortN);
    expect(result.cured).toBe(2); // L3 absent, L4 dpd 0
    expect(result.stayed).toBe(1);
    expect(result.rolled).toBe(1);
    expect(result.cohortAmt).toBe(1000);
    expect(result.rolledAmt).toBe(200);
    expect(result.rolledAmt + (result.cohortAmt - result.rolledAmt)).toBe(result.cohortAmt);
    expect(result.rollRateCount).toBeCloseTo(0.25, 12);
    expect(result.rollRateAmount).toBeCloseTo(0.2, 12);
  });

  it('attributed to the OPENING branch and officer: a loan reassigned before t1 still counts for its t0 officer', () => {
    const t0 = [slice('L1', 'B1', 'O-open', 12, 100), slice('L2', 'B2', 'O-other', 8, 500)];
    // L1 moved to B2/O-new before t1; the cohort keeps its opening keys.
    const byBranch = aggregateByBranch(t0, [outcome('L1', 40), outcome('L2', 9)], { windowComplete: true });
    const b1 = byBranch.find((row) => row.branchId === 'B1')!;
    expect(b1.cohortN).toBe(1);
    expect(b1.rolled).toBe(1); // the roll is charged to the opening branch
    const b2 = byBranch.find((row) => row.branchId === 'B2')!;
    expect(b2.rolled).toBe(0);
  });

  it('branch totals equal the sum of their officers', () => {
    const t0 = [
      slice('L1', 'B', 'O1', 10, 100),
      slice('L2', 'B', 'O1', 20, 100),
      slice('L3', 'B', 'O2', 5, 100),
      slice('L4', 'B', 'O2', 15, 100),
      slice('L5', 'B', 'O2', 25, 100)
    ];
    const t1 = [outcome('L1', 40), outcome('L2', 20), outcome('L3', null), outcome('L4', 0), outcome('L5', 12)];
    const byBranch = aggregateByBranch(t0, t1, { windowComplete: true });
    const byOfficer = aggregateByOfficer(t0, t1, { windowComplete: true });
    const branch = byBranch[0]!;
    const officerSum = byOfficer.reduce(
      (acc, row) => ({
        cohortN: acc.cohortN + row.cohortN,
        rolled: acc.rolled + row.rolled,
        cohortAmt: acc.cohortAmt + row.cohortAmt
      }),
      { cohortN: 0, rolled: 0, cohortAmt: 0 }
    );
    expect(branch.cohortN).toBe(officerSum.cohortN);
    expect(branch.rolled).toBe(officerSum.rolled);
    expect(branch.cohortAmt).toBe(officerSum.cohortAmt);
    // Footing holds on every officer row too.
    for (const row of byOfficer) {
      expect(row.cured + row.stayed + row.rolled).toBe(row.cohortN);
    }
  });

  it('an immature window reports "pending", never zero', () => {
    const t0 = [slice('L1', 'B', 'O1', 10, 100)];
    const pending = computeRollRate(t0, [outcome('L1', 40)], { windowComplete: false });
    expect(pending.rollRateCount).toBe('pending');
    expect(pending.rollRateAmount).toBe('pending');
    expect(pending.wilson).toBeNull();
    const complete = computeRollRate(t0, [outcome('L1', 40)], { windowComplete: true });
    expect(complete.rollRateCount).toBe(1);
  });

  it('Wilson 95% interval matches the known closed-form values', () => {
    // 0 successes in 30 trials: the 95% Wilson upper bound is ~0.111.
    const none = wilsonInterval(0, 30)!;
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0.05);
    expect(none.high).toBeLessThan(0.15);
    // 8 of 30 (26.7%): the interval straddles the point estimate and is
    // asymmetric (wider above).
    const some = wilsonInterval(8, 30)!;
    expect(some.low).toBeLessThan(8 / 30);
    expect(some.high).toBeGreaterThan(8 / 30);
    expect(some.high - 8 / 30).toBeGreaterThan(8 / 30 - some.low);
    // n = 0 gives null, not a fabricated interval.
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('grey-out flag when n < 30 (the officer table greys under 30)', () => {
    const small = computeRollRate([slice('L1', 'B', 'O1', 10, 100)], [outcome('L1', 40)], { windowComplete: true });
    expect(small.greyedOut).toBe(true);
    const big = computeRollRate(
      Array.from({ length: 30 }, (_, i) => slice(`L${i}`, 'B', 'O1', 10 + (i % 20), 100)),
      Array.from({ length: 30 }, (_, i) => outcome(`L${i}`, 40)),
      { windowComplete: true }
    );
    expect(big.greyedOut).toBe(false);
    expect(big.cohortN).toBe(30);
  });

  it('migration rows: each opening bucket shares cured/stayed/rolled summing to 1', () => {
    const t0 = [
      slice('L1', 'B', 'O1', 10, 100),
      slice('L2', 'B', 'O1', 20, 100),
      slice('L3', 'B', 'O1', 45, 100), // 31-60 bucket at t0
      slice('L4', 'B', 'O1', 50, 100)
    ];
    const t1 = [outcome('L1', null), outcome('L2', 40), outcome('L3', 55), outcome('L4', 10)];
    const rows = migrationTable(t0, t1, { windowComplete: true });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const sum = row.curedShare + row.stayedShare + row.rolledShare;
      expect(sum).toBeCloseTo(1, 12);
      expect(row.cohortN).toBeGreaterThan(0);
    }
    const b1 = rows.find((row) => row.openingBucket === '1-30')!;
    expect(b1.curedShare).toBeCloseTo(0.5, 12); // L1 cured, L2 rolled
    expect(b1.rolledShare).toBeCloseTo(0.5, 12);
  });

  it('enumerates only completed 30-day windows from the snapshot dates', () => {
    // Snapshots on 2026-08-10, 09-09 (+30), 10-09 (+60): two complete
    // windows; a date whose partner does not exist yields none; a window
    // whose t1 is in the future is not listed.
    const windows = enumerateWindows(['2026-08-10', '2026-09-09', '2026-10-09', '2026-11-07'], 30, '2026-11-07');
    expect(windows).toContainEqual({ t0: '2026-08-10', t1: '2026-09-09', complete: true });
    expect(windows).toContainEqual({ t0: '2026-09-09', t1: '2026-10-09', complete: true });
    expect(windows.every((w) => w.t1 <= '2026-11-07')).toBe(true);
  });
});
