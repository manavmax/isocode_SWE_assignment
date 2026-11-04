export const RBC2025_PARA100_ID = 'RBC2025_para100';
export const RECOVERY2026_100Y_ID = 'RECOVERY2026_100Y';
export const RECOVERY_SWITCH_DATE_IST = '2027-01-01';

export interface ContactRuleSet {
  id: string;
  displayName: string;
  startMinuteIst: number;
  endMinuteIst: number;
  borrowerRequestedTimeException: boolean;
  maxCallsPerLoanPerDay: number | null;
  maxVisitsPerLoanPerDay: number | null;
  note: string;
}

export const CONTACT_RULE_SETS: Record<string, ContactRuleSet> = {
  [RBC2025_PARA100_ID]: {
    id: RBC2025_PARA100_ID,
    displayName: 'RBI Circular Bank Collection 2025 para 100',
    startMinuteIst: 480,
    endMinuteIst: 1140,
    borrowerRequestedTimeException: false,
    maxCallsPerLoanPerDay: null,
    maxVisitsPerLoanPerDay: null,
    note: 'In effect until 2026-12-31 IST. Window 08:00 (480) to 19:00 (1140) exclusive.'
  },
  [RECOVERY2026_100Y_ID]: {
    id: RECOVERY2026_100Y_ID,
    displayName: 'Recovery Directions 2026 clause 100Y (illustrative, built ahead of effective date)',
    startMinuteIst: 480,
    endMinuteIst: 1140,
    borrowerRequestedTimeException: true,
    maxCallsPerLoanPerDay: 3,
    maxVisitsPerLoanPerDay: 1,
    note: 'Assumption A: 2027-direction changes declared per SPEC 7. Same hard window 08:00 to 19:00; borrower-requested exception needs evidence; template-only outbound; cap 3 calls and 1 visits per loan per day (internal policy, not the direction text).'
  }
};

export function ruleSetIdForAttemptDate(istDate: string): string {
  return istDate >= RECOVERY_SWITCH_DATE_IST ? RECOVERY2026_100Y_ID : RBC2025_PARA100_ID;
}

export function contactRuleSetForAttemptDate(istDate: string): ContactRuleSet {
  const id = ruleSetIdForAttemptDate(istDate);
  return CONTACT_RULE_SETS[id]!;
}
