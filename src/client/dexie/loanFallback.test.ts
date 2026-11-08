import { describe, expect, it } from 'vitest';
import { loanOfflineFallback, partialDetailFromCard } from './loanFallback.js';
import type { AssignmentCard, LoanDetailDto } from '../api.js';

/**
 * Offline detail fallback (prompt 19.1): the pure chain — full cached
 * detail first, then the worklist card rebuilt as a partial detail with
 * uncached fields null, then null (error state). The floating action bar
 * must render in every non-null case so the officer can queue an outcome
 * offline.
 */

const card: AssignmentCard = {
  loanId: 'LN-11009',
  borrowerName: 'Manisha Bhasker',
  businessName: 'Avanti Steel Udyog',
  pincode: '452001',
  locality: null,
  dpd: 9,
  bucket: '1-30',
  outstanding: 58724000,
  overdueAmount: 9800000,
  mobileMasked: '98XXXXXX21',
  score: 24,
  band: 'medium',
  rupeesAtRisk: 2352000,
  topReasons: [{ feature: 'dpd', contribution: 0.2, evidence: { days: 9 } }],
  limitedData: false,
  pinned: false,
  lowLane: false,
  duePromise: false
};

const fullDetail: LoanDetailDto = {
  loanId: 'LN-11009',
  borrowerName: 'Manisha Bhasker',
  businessName: 'Avanti Steel Udyog',
  address: 'shop 4, market road',
  pincode: '452001',
  locality: null,
  product: 'term loan',
  outstanding: 58724000,
  overdueAmount: 9800000,
  emiAmount: 816700,
  dpd: 9,
  bucket: '1-30',
  assignedOfficerId: 'o1',
  homeOfficerId: 'o1',
  status: 'overdue',
  mobileMasked: '98XXXXXX21',
  altMobileMasked: null,
  lastContactDays: 9,
  openPromiseDue: '2026-11-10',
  score: 24,
  band: 'medium',
  rupeesAtRisk: 2352000,
  limitedData: false,
  topReasons: [{ feature: 'dpd', contribution: 0.2, evidence: { days: 9 } }]
};

describe('offline detail fallback chain (prompt 19.1)', () => {
  it('prefers the full cached detail when present', () => {
    const result = loanOfflineFallback('LN-11009', fullDetail, card);
    expect(result?.source).toBe('cache');
    expect(result?.detail.address).toBe('shop 4, market road');
    expect(result?.detail.emiAmount).toBe(816700);
  });

  it('ignores a cached detail for a different loan (deep-link mismatch)', () => {
    const other = { ...fullDetail, loanId: 'LN-OTHER' };
    const result = loanOfflineFallback('LN-11009', other, card);
    expect(result?.source).toBe('partial');
  });

  it('builds a partial detail from the worklist card when no full detail is cached', () => {
    const result = partialDetailFromCard(card);
    expect(result.detail.borrowerName).toBe('Manisha Bhasker');
    expect(result.detail.businessName).toBe('Avanti Steel Udyog');
    expect(result.detail.overdueAmount).toBe(9800000);
    expect(result.detail.dpd).toBe(9);
    expect(result.detail.mobileMasked).toBe('98XXXXXX21');
    // fields the worklist does not carry: null (rendered '—')
    expect(result.detail.address).toBeNull();
    expect(result.detail.emiAmount).toBeNull();
    expect(result.detail.product).toBeNull();
    expect(result.detail.lastContactDays).toBeNull();
    expect(result.detail.limitedData).toBe(true);
    // the score fields ride on the card
    expect(result.detail.score).toBe(24);
    expect(result.detail.topReasons).toEqual(card.topReasons);
  });

  it('returns null when neither cache has the loan (honest error state)', () => {
    expect(loanOfflineFallback('LN-X', undefined, undefined)).toBeNull();
  });

  it('keeps the top reasons so "Why this score" renders offline', () => {
    const result = loanOfflineFallback('LN-11009', undefined, card);
    expect(result?.detail.topReasons).toEqual(card.topReasons);
  });

  it('marks a partial detail limited so the UI shows the unavailable-data chip', () => {
    const result = partialDetailFromCard(card);
    expect(result.detail.limitedData).toBe(true);
  });

  it('the full cached detail is NOT marked limited', () => {
    const result = loanOfflineFallback('LN-11009', fullDetail, undefined);
    expect(result?.detail.limitedData).toBe(false);
  });
});
