import { describe, expect, it } from 'vitest';
import { inferPaymentsFromDelta, istDayUtcRange, istNoonUtc } from './inferPayments.js';

/**
 * Payment inference (prompt 11 item 2): the daily LMS CSV carries balances,
 * not payment rows — a payment is INFERRED from the delta between the
 * previous snapshot's outstanding and this file's outstanding. An
 * outstanding that fell means money arrived; a loan that vanished from the
 * full file (cleared) means it was paid off. source = 'lms_delta', posted
 * on the import's as_of IST date (noon IST, so the timestamp unambiguously
 * belongs to that IST day). Pure: applyImport calls this inside its
 * transaction; the noop replay path returns before any write, and a replace
 * recomputes by deleting the as_of's inferred rows first.
 */

const PREV = new Map([
  ['LN-FALL', { outstanding: 500_000 }],
  ['LN-FLAT', { outstanding: 400_000 }],
  ['LN-ROSE', { outstanding: 300_000 }],
  ['LN-GONE', { outstanding: 250_000 }],
  ['LN-ZERO', { outstanding: 0 }]
]);
const AS_OF = '2026-11-07';

function rows(entries: [string, number][]): { loanId: string; outstanding: number }[] {
  return entries.map(([loanId, outstanding]) => ({ loanId, outstanding }));
}

describe('payment inference from the LMS outstanding delta', () => {
  it('infers a payment when the outstanding fell, for exactly the drop, posted on the as_of', () => {
    const inferred = inferPaymentsFromDelta({ previous: PREV, rows: rows([['LN-FALL', 350_000]]), goneLoanIds: [], asOf: AS_OF });
    expect(inferred).toEqual([{ loanId: 'LN-FALL', amountPaise: 150_000, postedOnIst: AS_OF }]);
  });

  it('infers nothing when the balance is unchanged or rose', () => {
    const inferred = inferPaymentsFromDelta({
      previous: PREV,
      rows: rows([
        ['LN-FLAT', 400_000],
        ['LN-ROSE', 320_000]
      ]),
      goneLoanIds: [],
      asOf: AS_OF
    });
    expect(inferred).toEqual([]);
  });

  it('infers a full payment for a loan that vanished from the full file (cleared)', () => {
    const inferred = inferPaymentsFromDelta({ previous: PREV, rows: [], goneLoanIds: ['LN-GONE'], asOf: AS_OF });
    expect(inferred).toEqual([{ loanId: 'LN-GONE', amountPaise: 250_000, postedOnIst: AS_OF }]);
  });

  it('never infers a payment for a loan without a previous snapshot, and never a negative amount', () => {
    const inferred = inferPaymentsFromDelta({
      previous: PREV,
      rows: rows([
        ['LN-UNKNOWN', 100_000],
        ['LN-ZERO', 0],
        ['LN-FALL', 500_000] // unchanged from a zero baseline stays silent
      ]),
      goneLoanIds: ['LN-UNKNOWN'],
      asOf: AS_OF
    });
    expect(inferred).toEqual([]);
  });

  it('infers from both rows and gone loans in a deterministic order (rows first, file order)', () => {
    const inferred = inferPaymentsFromDelta({
      previous: PREV,
      rows: rows([
        ['LN-FALL', 400_000],
        ['LN-FLAT', 400_000] // unchanged balance stays silent
      ]),
      // rows and gone are disjoint by construction (gone = absent from the
      // file); a gone loan with a zero previous outstanding pays nothing.
      goneLoanIds: ['LN-GONE', 'LN-ZERO'],
      asOf: AS_OF
    });
    expect(inferred).toEqual([
      { loanId: 'LN-FALL', amountPaise: 100_000, postedOnIst: AS_OF },
      { loanId: 'LN-GONE', amountPaise: 250_000, postedOnIst: AS_OF }
    ]);
  });

  it('posts at noon IST and deletes a whole IST day on replace', () => {
    const noon = istNoonUtc(AS_OF);
    expect(noon.toISOString()).toBe('2026-11-07T06:30:00.000Z');
    const range = istDayUtcRange(AS_OF);
    expect(range.startUtc.toISOString()).toBe('2026-11-06T18:30:00.000Z');
    expect(range.endUtc.toISOString()).toBe('2026-11-07T18:30:00.000Z');
  });
});
