import { describe, expect, it } from 'vitest';
import { groupWorklist } from './worklist.js';
import { worklistOrder } from '../shared/scoring/scorecard.js';
import { weights } from '../shared/scoring/scorecard.js';
import type { AssignmentCard } from './api.js';

/**
 * Prompt 20 item 3: a promise-due loan pinned first must NOT be styled as
 * low priority and must not trigger the LOW PRIORITY divider; the divider
 * appears only once, immediately above the first low-lane loan that
 * follows a non-low loan.
 */

function card(overrides: Partial<AssignmentCard>): AssignmentCard {
  return {
    loanId: 'LN-X',
    borrowerName: 'Borrower',
    businessName: null,
    pincode: '452001',
    locality: null,
    dpd: 10,
    bucket: '1-30',
    outstanding: 100000000,
    overdueAmount: 10000000,
    mobileMasked: '98XXXXXX21',
    score: 20,
    band: 'medium',
    rupeesAtRisk: 2000000,
    topReasons: [],
    limitedData: false,
    pinned: false,
    lowLane: false,
    duePromise: false,
    ...overrides
  };
}

describe('groupWorklist (display lane + divider)', () => {
  it('a promise-due loan is never low-lane even when the score flag says low', () => {
    const view = groupWorklist([card({ loanId: 'LN-P', lowLane: true, duePromise: true })]);
    expect(view.cards[0]!.lowLane).toBe(false);
    expect(view.dividerIndex).toBeNull();
  });

  it('the divider sits once above the first low-lane loan after a non-low loan', () => {
    const view = groupWorklist([
      card({ loanId: 'A', lowLane: false }),
      card({ loanId: 'B', lowLane: true }),
      card({ loanId: 'C', lowLane: true }),
      card({ loanId: 'D', lowLane: false }),
      card({ loanId: 'E', lowLane: true })
    ]);
    expect(view.dividerIndex).toBe(1);
  });

  it('a list that opens with low cards gets no divider at the start', () => {
    const view = groupWorklist([
      card({ loanId: 'A', lowLane: true }),
      card({ loanId: 'B', lowLane: true }),
      card({ loanId: 'C', lowLane: false }),
      card({ loanId: 'D', lowLane: true })
    ]);
    expect(view.dividerIndex).toBe(3);
  });

  it('an all-low list renders no divider', () => {
    const view = groupWorklist([card({ loanId: 'A', lowLane: true }), card({ loanId: 'B', lowLane: true })]);
    expect(view.dividerIndex).toBeNull();
  });

  it('a non-low-only list renders no divider', () => {
    const view = groupWorklist([card({ loanId: 'A' }), card({ loanId: 'B' })]);
    expect(view.dividerIndex).toBeNull();
  });
});

describe('worklistOrder with the pinned promise-due low-score loan (SPEC 8 + prompt 20 item 3)', () => {
  const scored = [
    // a promise-due loan whose score puts it in the low lane — the pin must win
    { loanId: 'LN-PIN', pRoll: 0.05, score: 5, band: 'low' as const, rupeesAtRisk: 50_000, hasBrokenPromise: false, duePromise: true },
    { loanId: 'LN-MID', pRoll: 0.4, score: 40, band: 'high' as const, rupeesAtRisk: 800_000, hasBrokenPromise: false, duePromise: false },
    { loanId: 'LN-LOW', pRoll: 0.06, score: 6, band: 'low' as const, rupeesAtRisk: 60_000, hasBrokenPromise: false, duePromise: false }
  ];

  it('the pinned promise-due loan renders first, the low lane follows last', () => {
    const order = worklistOrder(scored, weights);
    expect(order.map((entry) => entry.loanId)).toEqual(['LN-PIN', 'LN-MID', 'LN-LOW']);
  });

  it('and the display grouping never styles the pinned loan low or shows a divider above it', () => {
    const order = worklistOrder(scored, weights);
    const cards = order.map((entry) =>
      card({
        loanId: entry.loanId,
        lowLane: entry.pRoll < 0.1,
        duePromise: entry.duePromise,
        rupeesAtRisk: entry.rupeesAtRisk,
        score: entry.score,
        band: entry.band
      })
    );
    const view = groupWorklist(cards);
    expect(view.cards[0]!.loan.loanId).toBe('LN-PIN');
    expect(view.cards[0]!.lowLane).toBe(false);
    expect(view.dividerIndex).toBe(2);
  });
});
