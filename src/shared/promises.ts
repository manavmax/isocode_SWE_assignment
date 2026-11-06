/**
 * Promise creation rules (SPEC 12): date today..+7 days (+10 in bucket B2),
 * never a Sunday (the caller rolls forward with a visible note), amount at
 * least 50% of overdue and at most the outstanding balance, one open promise
 * per loan with at most two reschedules per bucket stay — a reschedule marks
 * the old promise superseded. State transitions (kept/broken) and reminders
 * are the following prompt's work; every number here is a decision recorded
 * in docs/assumptions.md (A51/A55).
 *
 * Money is paise end-to-end (A11). Dates are IST YYYY-MM-DD keys and are
 * compared as such — never through the process clock.
 */
import { istDateParts } from './datetime.js';

export const DEFAULT_PROMISE_GRACE_DAYS = 1;
/** A bucket-2 (31-60 DPD) stay gets the longer window (SPEC 12: +10 in B2). */
export const B2_BUCKET = '31-60';
export const PROMISE_MAX_LEAD_DAYS_B1 = 7;
export const PROMISE_MAX_LEAD_DAYS_B2 = 10;
/** "Max two reschedules per bucket stay": re-timing is allowed twice, the
 * third attempt must go through a manager path (A55). */
export const MAX_PROMISE_RESCHEDULES = 2;

export interface PromiseCreationInput {
  promised_date: string;
  promised_amount: number;
}

export interface PromiseCreationContext {
  /** Server "today" as an IST date key (the caller supplies the clock). */
  todayIst: string;
  /** The loan's DPD bucket (A4 list) — B2 stretches the lead window. */
  bucket: string;
  overduePaise: number;
  outstandingPaise: number;
  /** Id of the loan's current open promise, or null. */
  openPromiseId: string | null;
  /** How many reschedules the current stay has already used — the count of
   * superseded promises for the loan (A55 approximation of "per bucket stay"). */
  rescheduleCount: number;
}

export type PromiseCreationReason =
  | 'invalid_date'
  | 'date_before_today'
  | 'date_too_far_out'
  | 'date_is_sunday'
  | 'amount_not_positive'
  | 'amount_below_half_overdue'
  | 'amount_above_outstanding'
  | 'reschedule_limit_reached';

export type PromiseCreationResult =
  | {
      ok: true;
      promisedDateIst: string;
      promisedAmountPaise: number;
      /** When the loan already held an open promise this IS that id: the new
       * promise supersedes the old one, keeping "one open promise per loan". */
      supersedesPromiseId: string | null;
      graceDays: number;
    }
  | {
      ok: false;
      reasons: PromiseCreationReason[];
      /** Set when the promised date fell on a Sunday: the next working (IST)
       * day, for a visible roll-forward note in the UI and API reason. */
      rollForwardToDateIst: string | null;
    };

/** Calendar arithmetic on IST date keys without any wall-clock involvement:
 * IST has no DST, so a fixed 86400 s step on the UTC anchor is exact. */
export function addIstDays(dateKey: string, days: number): string {
  const shifted = new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** True when the IST calendar date is a Sunday (weekday 0). */
export function isSundayIst(dateKey: string): boolean {
  return istDateParts(Date.parse(`${dateKey}T12:00:00Z`)).weekday === 0;
}

/** The next non-Sunday IST date, returned unchanged when the input is fine —
 * the helper behind the "roll forward with a visible note" behaviour. */
export function nextWorkingDayIst(dateKey: string): string {
  let key = dateKey;
  while (isSundayIst(key)) {
    key = addIstDays(key, 1);
  }
  return key;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIstDateKey(value: string): boolean {
  if (!DATE_KEY_RE.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** SPEC 12 creation validation. All individual rules report together so one
 * officer attempt can show every problem at once. */
export function validatePromiseCreation(
  input: PromiseCreationInput,
  context: PromiseCreationContext
): PromiseCreationResult {
  const reasons: PromiseCreationReason[] = [];
  let rollForwardToDateIst: string | null = null;

  if (!isValidIstDateKey(input.promised_date)) {
    reasons.push('invalid_date');
  } else {
    if (input.promised_date < context.todayIst) {
      reasons.push('date_before_today');
    }
    const maxLead = context.bucket === B2_BUCKET ? PROMISE_MAX_LEAD_DAYS_B2 : PROMISE_MAX_LEAD_DAYS_B1;
    if (input.promised_date > addIstDays(context.todayIst, maxLead)) {
      reasons.push('date_too_far_out');
    }
    if (isSundayIst(input.promised_date)) {
      reasons.push('date_is_sunday');
      rollForwardToDateIst = nextWorkingDayIst(input.promised_date);
    }
  }

  if (!Number.isInteger(input.promised_amount) || input.promised_amount <= 0) {
    reasons.push('amount_not_positive');
  } else {
    const halfOverdue = Math.ceil(context.overduePaise / 2);
    if (input.promised_amount < halfOverdue) {
      reasons.push('amount_below_half_overdue');
    }
    if (input.promised_amount > context.outstandingPaise) {
      reasons.push('amount_above_outstanding');
    }
  }

  // One open promise per loan: while one is open this creation IS a
  // reschedule of it, so only the two-reschedule cap can veto.
  if (context.openPromiseId !== null && context.rescheduleCount >= MAX_PROMISE_RESCHEDULES) {
    reasons.push('reschedule_limit_reached');
  }

  if (reasons.length > 0) {
    return { ok: false, reasons, rollForwardToDateIst };
  }
  return {
    ok: true,
    promisedDateIst: input.promised_date,
    promisedAmountPaise: input.promised_amount,
    supersedesPromiseId: context.openPromiseId,
    graceDays: DEFAULT_PROMISE_GRACE_DAYS
  };
}
