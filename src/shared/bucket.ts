import type { DpdBucket } from './types.js';

export function dpdBucketFor(dpd: number): DpdBucket {
  if (!Number.isFinite(dpd) || dpd <= 0) return 'not-overdue';
  if (dpd <= 30) return '1-30';
  if (dpd <= 60) return '31-60';
  if (dpd <= 90) return '61-90';
  return '90+';
}
