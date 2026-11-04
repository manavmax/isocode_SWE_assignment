import { describe, expect, it } from 'vitest';
import { dpdBucketFor } from './bucket.js';

describe('dpdBucketFor', () => {
  it('maps 0 and odd non positives to not-overdue', () => {
    expect(dpdBucketFor(0)).toBe('not-overdue');
  });

  it('maps bucket boundaries 1, 30, 31, 60, 61, 90, 91', () => {
    expect(dpdBucketFor(1)).toBe('1-30');
    expect(dpdBucketFor(30)).toBe('1-30');
    expect(dpdBucketFor(31)).toBe('31-60');
    expect(dpdBucketFor(60)).toBe('31-60');
    expect(dpdBucketFor(61)).toBe('61-90');
    expect(dpdBucketFor(90)).toBe('61-90');
    expect(dpdBucketFor(91)).toBe('90+');
  });

  it('maps deep NPA days to 90+', () => {
    expect(dpdBucketFor(365)).toBe('90+');
  });
});
