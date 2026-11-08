import { describe, expect, it } from 'vitest';
import { visibleReasons } from './reasons.js';
import type { ReasonContributionDto } from './api.js';

/**
 * Prompt 20 item 11: never show "N days past due" under "N days overdue" —
 * the dpd reason is dropped wherever the overdue-days fact is on screen.
 */

const dpd: ReasonContributionDto = { feature: 'dpd', contribution: 0.2, evidence: { days: 9 } };
const bounces: ReasonContributionDto = { feature: 'bounces', contribution: 0.15, evidence: { count: 2 } };
const contact: ReasonContributionDto = { feature: 'daysSinceContact', contribution: 0.1, evidence: { days: 9 } };

describe('visibleReasons', () => {
  it('drops the dpd reason and shows the next one instead', () => {
    expect(visibleReasons([dpd, bounces, contact])).toEqual([bounces, contact]);
  });

  it('returns an empty list when dpd was the only reason', () => {
    expect(visibleReasons([dpd])).toEqual([]);
  });

  it('keeps a list without dpd unchanged', () => {
    expect(visibleReasons([bounces, contact])).toEqual([bounces, contact]);
  });

  it('tolerates null/undefined', () => {
    expect(visibleReasons(null)).toEqual([]);
    expect(visibleReasons(undefined)).toEqual([]);
  });
});
