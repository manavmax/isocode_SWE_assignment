import { describe, expect, it } from 'vitest';
import {
  bandFor,
  fallbackComparator,
  keptRateShrunk,
  logit,
  lowLaneFor,
  scoreLoan,
  worklistOrder,
  type OutcomeGroup,
  type RawFeatures,
  type StandardisationParams,
  type Weights
} from './scorecard.js';
import { describeReason, describeReasons } from './phrases.js';

/**
 * SPEC 8 scorecard, pure: z = clip((x - mean)/sd, -3, 3) on the continuous
 * features; logit = logit(0.22) + sum(beta * clip(z)) + sum(beta_g * x_g)
 * over the last-contact one-hot groups (reference = no contact, which
 * contributes zero); score = round(100 * p_roll); bands High >= 40,
 * Medium 20-39, Low < 20. Kept rate shrunk (kept+2)/(made+3). Reasons are
 * the per-feature model terms (linear SHAP on the standardised feature:
 * beta * clip(z), the sd-scaled form of beta*(x-mean)), so
 * base + sum(contributions) = logit exactly.
 *
 * The tests run on a FIXTURE params file (hand-set means/SDs); the real
 * params.json is fitted by scripts/fit-standardisation.ts from the seeded
 * data and committed.
 */

const weights: Weights = {
  modelVersion: 'scorecard-v1-priors',
  centerRate: 0.22,
  betas: {
    dpd: 0.55,
    bounces: 0.4,
    broken90: 0.45,
    keptRate: -0.4,
    daysSinceContact: 0.2,
    overdueEmiMultiples: 0.25,
    logOutstanding: 0.15,
    vintageMonths: -0.15
  },
  outcomeGroupBetas: { unreachable: 0.5, refused: 0.55, promised: -0.4, part_paid: -0.6 },
  caps: { bounces: 4, broken90: 3 },
  keptRateShrinkage: { addedKept: 2, addedMade: 3 },
  featureOrder: ['broken90', 'bounces', 'daysSinceContact', 'dpd', 'overdueEmiMultiples', 'lastOutcomeGroup', 'keptRate', 'logOutstanding', 'vintageMonths'],
  lowLaneMaxPRoll: 0.1
};

const params: StandardisationParams = {
  modelVersion: 'scorecard-v1-priors',
  features: {
    dpd: { mean: 15, sd: 10 },
    bounces: { mean: 1, sd: 1 },
    broken90: { mean: 0.5, sd: 0.5 },
    keptRate: { mean: 0.6, sd: 0.25 },
    daysSinceContact: { mean: 5, sd: 4 },
    overdueEmiMultiples: { mean: 2, sd: 1 },
    logOutstanding: { mean: 13.5, sd: 0.8 },
    vintageMonths: { mean: 18, sd: 8 }
  },
  outcomeShares: { unreachable: 0.2, refused: 0.1, promised: 0.3, part_paid: 0.1 }
};

function features(overrides: Partial<RawFeatures>): RawFeatures {
  return {
    dpd: 15,
    bounces: 1,
    broken90: 1,
    keptKept: 4,
    keptMade: 6,
    lastOutcomeGroup: null,
    daysSinceContact: 5,
    overdue: 100_000,
    emi: 50_000,
    outstanding: 729415, // log1p(729415) = 13.5 exactly at the fitted mean
    vintageMonths: 18,
    ...overrides
  };
}

describe('scorecard score (SPEC 8)', () => {
  it('a portfolio-mean loan with no contact and a shrunk-neutral kept rate scores the 22% centre', () => {
    // All continuous features at their means -> every z = 0; no contact ->
    // zero one-hot contribution. The kept rate at the mean (0.6) also
    // centres, so p = 0.22 exactly.
    const atMean = features({ broken90: 0.5, keptKept: 1, keptMade: 2, daysSinceContact: 5 });
    const result = scoreLoan({ features: atMean, params }, weights);
    expect(result.score).toBe(22);
    // log1p of an integer rupee amount cannot hit the 13.5 mean exactly;
    // the p lands within a rounding hair of the centre. The EXACT identity
    // (base + sum = logit) is the additivity test above.
    expect(result.pRoll).toBeCloseTo(0.22, 6);
    expect(result.band).toBe('medium');
  });

  it('higher DPD raises the score and clips at 3 SD above the mean', () => {
    const base = scoreLoan({ features: features({ dpd: 15 }), params }, weights);
    const high = scoreLoan({ features: features({ dpd: 45 }), params }, weights); // z = 3 exactly
    const absurd = scoreLoan({ features: features({ dpd: 95 }), params }, weights); // z = 8 -> clipped to 3
    expect(high.pRoll).toBeGreaterThan(base.pRoll);
    expect(absurd.logit).toBeCloseTo(high.logit, 12); // clipping holds
  });

  it('kept-rate shrinkage: zero promises give the (kept+2)/(made+3) prior of 2/3', () => {
    expect(keptRateShrunk(0, 0, weights)).toBeCloseTo(2 / 3, 12);
    expect(keptRateShrunk(6, 6, weights)).toBeCloseTo(8 / 9, 12);
    expect(keptRateShrunk(0, 4, weights)).toBeCloseTo(2 / 7, 12);
    // A fully-kept history (8/9) sits above the portfolio mean 0.6 -> the
    // negative beta pulls the score DOWN; a broken history pulls it up.
    const kept = scoreLoan({ features: features({ keptKept: 6, keptMade: 6 }), params }, weights);
    const broken = scoreLoan({ features: features({ keptKept: 0, keptMade: 4 }), params }, weights);
    expect(kept.pRoll).toBeLessThan(broken.pRoll);
  });

  it('the last-contact one-hot uses no-contact as the reference: none contributes zero', () => {
    const none = scoreLoan({ features: features({ lastOutcomeGroup: null }), params }, weights);
    expect(none.contributions.filter((c) => c.feature === 'lastOutcomeGroup')).toHaveLength(0);
    const refused = scoreLoan({ features: features({ lastOutcomeGroup: 'refused' as OutcomeGroup }), params }, weights);
    const refusedTerm = refused.contributions.find((c) => c.feature === 'lastOutcomeGroup')!;
    expect(refusedTerm.contribution).toBeCloseTo(0.55, 12);
    expect(refused.pRoll).toBeGreaterThan(none.pRoll);
    const promised = scoreLoan({ features: features({ lastOutcomeGroup: 'promised' as OutcomeGroup }), params }, weights);
    expect(promised.pRoll).toBeLessThan(none.pRoll); // -0.40 beta
  });

  it('additivity: base + sum of ALL contributions = logit within 1e-9, including clipped and imputed features', () => {
    const cases: RawFeatures[] = [
      features({ dpd: 95, bounces: 9, broken90: 7 }), // heavy clipping
      features({ lastOutcomeGroup: 'unreachable' as OutcomeGroup, daysSinceContact: 40 }),
      features({ dpd: null, bounces: null, broken90: null, keptKept: null, keptMade: null, overdue: null, emi: null, outstanding: null, vintageMonths: null, daysSinceContact: null }), // all imputed
      features({})
    ];
    for (const f of cases) {
      const result = scoreLoan({ features: f, params }, weights);
      const sum = result.contributions.reduce((acc, c) => acc + c.contribution, 0);
      expect(result.base + sum).toBeCloseTo(result.logit, 9);
    }
  });

  it('bands: High >= 40, Medium 20 to 39, Low < 20', () => {
    expect(bandFor(40)).toBe('high');
    expect(bandFor(39)).toBe('medium');
    expect(bandFor(20)).toBe('medium');
    expect(bandFor(19)).toBe('low');
  });

  it('missing features impute the portfolio mean (z = 0) and flag limited data', () => {
    const result = scoreLoan(
      { features: features({ dpd: null, overdue: null, emi: null, lastOutcomeGroup: null, daysSinceContact: null }), params },
      weights
    );
    expect(result.limitedData.sort()).toEqual(['daysSinceContact', 'dpd', 'overdueEmiMultiples']);
    // The imputed dpd contributes nothing: z = 0.
    expect(result.contributions.find((c) => c.feature === 'dpd')).toBeUndefined();
  });

  it('capped features: bounces and broken promises never exceed their caps', () => {
    const capped = scoreLoan({ features: features({ bounces: 9, broken90: 7 }), params }, weights);
    const atCap = scoreLoan({ features: features({ bounces: 4, broken90: 3 }), params }, weights);
    expect(capped.logit).toBeCloseTo(atCap.logit, 12);
  });

  it('overdue in EMI multiples: no EMI imputes the mean and flags limited data', () => {
    const noEmi = scoreLoan({ features: features({ emi: null }), params }, weights);
    expect(noEmi.limitedData).toContain('overdueEmiMultiples');
  });
});

describe('reasons (linear SHAP, top 3, tie-break, phrases)', () => {
  it('keeps only positive contributions, sorted descending, with the fixed feature-order tie-break', () => {
    const result = scoreLoan({ features: features({ broken90: 3, bounces: 4, dpd: 40, daysSinceContact: 30 }), params }, weights);
    const positive = result.contributions.filter((c) => c.contribution > 0);
    for (let i = 1; i < result.topReasons.length; i += 1) {
      const prev = result.topReasons[i - 1]!;
      const curr = result.topReasons[i]!;
      expect(prev.contribution).toBeGreaterThanOrEqual(curr.contribution);
      if (prev.contribution === curr.contribution) {
        expect(weights.featureOrder.indexOf(prev.feature)).toBeLessThan(weights.featureOrder.indexOf(curr.feature));
      }
    }
    expect(result.topReasons.every((r) => r.contribution > 0)).toBe(true);
    expect(positive.length).toBeGreaterThanOrEqual(result.topReasons.length);
  });

  it('takes exactly the top 3', () => {
    const result = scoreLoan({ features: features({ broken90: 3, bounces: 4, dpd: 40, daysSinceContact: 30, lastOutcomeGroup: 'refused' as OutcomeGroup }), params }, weights);
    expect(result.topReasons).toHaveLength(3);
    const sorted = [...result.contributions].filter((c) => c.contribution > 0).sort(
      (a, b) => b.contribution - a.contribution || weights.featureOrder.indexOf(a.feature) - weights.featureOrder.indexOf(b.feature)
    );
    expect(result.topReasons.map((r) => r.feature)).toEqual(sorted.slice(0, 3).map((r) => r.feature));
  });

  it('renders templated phrases with the evidence, in English and Hindi', () => {
    const result = scoreLoan({ features: features({ broken90: 2, daysSinceContact: 9 }), params }, weights);
    for (const reason of result.topReasons) {
      const en = describeReason('en', reason);
      const hi = describeReason('hi', reason);
      expect(en.length).toBeGreaterThan(0);
      expect(hi.length).toBeGreaterThan(0);
      expect(en).not.toEqual(hi);
    }
    const broken = result.topReasons.find((r) => r.feature === 'broken90');
    if (broken) {
      expect(describeReason('en', broken)).toContain('broken promise');
      expect(describeReason('en', broken)).toContain('90 days');
    }
    const noContact = result.topReasons.find((r) => r.feature === 'daysSinceContact');
    if (noContact) {
      expect(describeReason('en', noContact)).toContain('No contact for 9 days');
    }
    const lines = describeReasons('en', result.topReasons);
    expect(lines).toHaveLength(result.topReasons.length);
  });
});

describe('worklist order (SPEC 8)', () => {
  const scored = [
    { loanId: 'LN-A', pRoll: 0.5, score: 50, band: 'high' as const, rupeesAtRisk: 500_000, hasBrokenPromise: true, duePromise: false },
    { loanId: 'LN-B', pRoll: 0.3, score: 30, band: 'medium' as const, rupeesAtRisk: 300_000, hasBrokenPromise: false, duePromise: true },
    { loanId: 'LN-C', pRoll: 0.05, score: 5, band: 'low' as const, rupeesAtRisk: 50_000, hasBrokenPromise: false, duePromise: false },
    { loanId: 'LN-D', pRoll: 0.2, score: 20, band: 'medium' as const, rupeesAtRisk: 800_000, hasBrokenPromise: false, duePromise: false },
    { loanId: 'LN-E', pRoll: 0.08, score: 8, band: 'low' as const, rupeesAtRisk: 90_000, hasBrokenPromise: true, duePromise: false }
  ];

  it('pins a promise due today first, then rupees at risk, with the low lane at the bottom', () => {
    const order = worklistOrder(scored, weights);
    expect(order.map((entry) => entry.loanId)).toEqual(['LN-B', 'LN-D', 'LN-A', 'LN-E', 'LN-C']);
  });

  it('the low lane needs p_roll < 0.10 AND no broken promise', () => {
    expect(lowLaneFor(scored[2]!, weights)).toBe(true);
    expect(lowLaneFor(scored[4]!, weights)).toBe(false); // broken promise -> never the low lane
    expect(lowLaneFor(scored[0]!, weights)).toBe(false);
  });

  it('the fallback comparator orders by broken promises, then DPD, then overdue', () => {
    const rows = [
      { loanId: 'F1', broken: 0, dpd: 20, overdue: 900_000 },
      { loanId: 'F2', broken: 1, dpd: 10, overdue: 100_000 },
      { loanId: 'F3', broken: 0, dpd: 40, overdue: 100_000 },
      { loanId: 'F4', broken: 0, dpd: 40, overdue: 500_000 }
    ];
    const order = [...rows].sort(fallbackComparator);
    expect(order.map((r) => r.loanId)).toEqual(['F2', 'F4', 'F3', 'F1']);
  });
});

describe('logit helper', () => {
  it('logit(0.22) sits at the documented centre', () => {
    expect(logit(0.22)).toBeCloseTo(-1.2657, 3);
  });
});
