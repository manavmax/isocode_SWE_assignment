import { describe, expect, it } from 'vitest';
import { CONTACT_RULE_SETS, RECOVERY_SWITCH_DATE_IST, contactRuleSetForAttemptDate, ruleSetIdForAttemptDate } from './ruleSets.js';

describe('rule set selection', () => {
  it('uses RBC2025_para100 before the switch date', () => {
    expect(ruleSetIdForAttemptDate('2026-11-04')).toBe('RBC2025_para100');
    expect(ruleSetIdForAttemptDate('2026-12-31')).toBe('RBC2025_para100');
  });

  it('switches on 2027-01-01 IST', () => {
    expect(ruleSetIdForAttemptDate(RECOVERY_SWITCH_DATE_IST)).toBe('RECOVERY2026_100Y');
    expect(ruleSetIdForAttemptDate('2030-06-30')).toBe('RECOVERY2026_100Y');
  });

  it('both rule sets enforce the 08:00-19:00 IST window', () => {
    expect(CONTACT_RULE_SETS['RBC2025_para100']).toMatchObject({ startMinuteIst: 480, endMinuteIst: 1140 });
    expect(CONTACT_RULE_SETS['RECOVERY2026_100Y']).toMatchObject({ startMinuteIst: 480, endMinuteIst: 1140 });
  });

  it('recovery config declares the internal caps and evidence requirement', () => {
    const recovery = contactRuleSetForAttemptDate('2027-03-01');
    expect(recovery.borrowerRequestedTimeException).toBe(true);
    expect(recovery.maxCallsPerLoanPerDay).toBe(3);
    expect(recovery.maxVisitsPerLoanPerDay).toBe(1);
  });
});
