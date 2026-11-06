/**
 * Contact window (SPEC 7, hard part #2): 08:00 to 19:00 Asia/Kolkata,
 * evaluated on the attempt instant — never on sync time, and never on the
 * device timezone. The only formula allowed here is
 * `istMinutes = (utcMs/60000 + 330) mod 1440`, allowed iff
 * `480 <= istMinutes < 1140`, so the verdict is a pure function of the UTC
 * instant and the IST test-suite boundaries (07:59:59 / 08:00:00 / 18:59:59 /
 * 19:00:00) hold on any device.
 */
import { istDateKey, istMinutesOfDay } from './datetime.js';
import { contactRuleSetForAttemptDate, type ContactRuleSet } from './ruleSets.js';

export const CONTACT_WINDOW_START_MIN = 480; // 08:00 IST
export const CONTACT_WINDOW_END_MIN = 1140; // 19:00 IST (exclusive)

/** The window check on raw minute-of-day terms; the formula itself lives in
 * datetime.istMinutesOfDay and matches SPEC 7 seconds for seconds. */
export function isWithinContactWindow(instantUtcMs: number): boolean {
  const istMinutes = istMinutesOfDay(instantUtcMs);
  return CONTACT_WINDOW_START_MIN <= istMinutes && istMinutes < CONTACT_WINDOW_END_MIN;
}

/** IST calendar date (YYYY-MM-DD) of an instant — the key that selects the
 * rule set. Deliberately computed the same offset way as the window formula,
 * so a UTC instant near midnight never picks the rule set of the wrong day. */
export function attemptDateIst(instantUtcMs: number): string {
  return istDateKey(instantUtcMs);
}

/** Rule-set selector (SPEC 20.2): before 2027-01-01 the RBC 2025 circular,
 * from that date the Recovery Directions — both parking 08:00-19:00. */
export function ruleSetFor(attemptDateIstKey: string): ContactRuleSet {
  return contactRuleSetForAttemptDate(attemptDateIstKey);
}

/** SPEC 7 (2027 direction, declared assumption): a borrower who asked to be
 * contacted at a specific time may be called outside the hard window, but the
 * attempt must carry evidence. Flag + non-blank evidence text together
 * unlock the exception, only under the rule set that declares it. */
export interface AttemptWindowOptions {
  borrowerRequestedTime?: boolean;
  evidence?: string | null;
}

export interface ContactWindowDecision {
  instantUtcMs: number;
  istMinutes: number;
  /** IST calendar date of the attempt. */
  attemptDateIstKey: string;
  /** Rule-set id in force for the attempt date. */
  ruleSetId: string;
  /** Plain SPEC 7 formula result, before the exception is considered. */
  windowOnly: boolean;
  /** Final answer: windowOnly OR the borrower-requested exception. */
  withinWindow: boolean;
  exceptionApplied: boolean;
}

/** Full decision about one attempt instant under its own date's rule set. */
export function decideAttemptWindow(instantUtcMs: number, options: AttemptWindowOptions = {}): ContactWindowDecision {
  const windowOnly = isWithinContactWindow(instantUtcMs);
  const dateKey = attemptDateIst(instantUtcMs);
  const ruleSet = ruleSetFor(dateKey);
  let exceptionApplied = false;
  if (
    !windowOnly &&
    ruleSet.borrowerRequestedTimeException &&
    options.borrowerRequestedTime === true &&
    typeof options.evidence === 'string' &&
    options.evidence.trim().length > 0
  ) {
    exceptionApplied = true;
  }
  return {
    instantUtcMs,
    istMinutes: istMinutesOfDay(instantUtcMs),
    attemptDateIstKey: dateKey,
    ruleSetId: ruleSet.id,
    windowOnly,
    withinWindow: windowOnly || exceptionApplied,
    exceptionApplied
  };
}

/** A logged call (SPEC 7 "block on call start; warn if a logged call ran past
 * 19:00") is classified by BOTH endpoints: started inside is what makes the
 * attempt legal, and bleeding past 19:00 after a legal start is a warning the
 * event carries — the officer approached the borrower inside their rights. */
export type CallSpanClassification = 'inside_window' | 'ran_past_end_warning' | 'started_outside';

export function classifyCallSpan(startUtcMs: number, endUtcMs: number): CallSpanClassification {
  if (!isWithinContactWindow(startUtcMs)) {
    return 'started_outside';
  }
  const sameIstDate = attemptDateIst(endUtcMs) === attemptDateIst(startUtcMs);
  if (sameIstDate && isWithinContactWindow(endUtcMs)) {
    return 'inside_window';
  }
  return 'ran_past_end_warning';
}
