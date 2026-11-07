/**
 * Promise status derivation (SPEC 12, prompt 11 item 1). Pure: no db, no
 * clock — the caller injects `nowIst` (an IST date key) and the payments
 * total, so tests and the nightly job grade identical inputs identically.
 *
 * Rules: deadline = promised_date + grace_days (default 1). `kept` when
 * paid >= 95% of the promised amount (any time — early payment is kept), or
 * when the loan cleared early (posting lag may hide the payment; the loan
 * leaving the book IS the payment, A61). `broken` when now > deadline and
 * paid < 95%; `broken_part` when paid >= 25% but < 95% in that same past-
 * deadline window; otherwise `open`. `superseded` and `disputed` are
 * terminal statuses set elsewhere (reschedules / disputes): derivation never
 * produces them and the kept-rate never counts them.
 *
 * keptRate = kept / (kept + broken + broken_part) over promises whose
 * deadline has passed (now > deadline), null when the denominator is empty —
 * null, never zero, so "no promises yet" cannot print as a 0% kept rate.
 *
 * Money is paise (A11); the thresholds compare paid*100 against
 * amount*95/amount*25 as integers so no float rounding can flip a boundary.
 * Dates are IST YYYY-MM-DD keys compared as strings (fixed 86400 s steps on
 * the UTC anchor; IST has no DST).
 */
import { addIstDays } from './promises.js';
import type { PromiseStatus } from './types.js';

export { addIstDays };

export interface PromiseStateRow {
  /** Stored status: 'open' for anything still live; superseded/disputed pass
   *  through untouched and are excluded from the kept-rate. */
  status: PromiseStatus;
  promisedDate: string;
  graceDays: number;
  /** Paise promised (>= 0 in practice). */
  promisedAmount: number;
  /** Paise actually paid since the promise was created, or null for none. */
  paidAmount: number | null;
  /** The loan left the book (cleared): kept regardless of recorded payments. */
  loanCleared: boolean;
}

/** deadline = promised_date + grace_days, on IST calendar keys. */
export function promiseDeadline(promisedDate: string, graceDays: number): string {
  return addIstDays(promisedDate, graceDays);
}

function atLeast(fractionPercent: number, paid: number, promised: number): boolean {
  return paid * 100 >= promised * fractionPercent;
}

export function derivePromiseStatus(row: PromiseStateRow, nowIst: string): PromiseStatus {
  if (row.status === 'superseded' || row.status === 'disputed') {
    // Terminal by other rules (reschedule / dispute); echoed untouched.
    return row.status;
  }
  const paid = row.paidAmount ?? 0;
  if (row.loanCleared || atLeast(95, paid, row.promisedAmount)) {
    return 'kept';
  }
  const deadline = promiseDeadline(row.promisedDate, row.graceDays);
  if (nowIst <= deadline) {
    return 'open';
  }
  if (atLeast(25, paid, row.promisedAmount)) {
    return 'broken_part';
  }
  return 'broken';
}

export function keptRate(rows: readonly PromiseStateRow[], nowIst: string): number | null {
  let kept = 0;
  let denominator = 0;
  for (const row of rows) {
    // Only already-settled statuses count, and only once their deadline has
    // passed. A still-'open' row past its deadline is stale (the nightly job
    // has not run yet) — excluded rather than guessed at.
    if (row.status !== 'kept' && row.status !== 'broken' && row.status !== 'broken_part') {
      continue;
    }
    if (nowIst <= promiseDeadline(row.promisedDate, row.graceDays)) {
      continue;
    }
    denominator += 1;
    if (row.status === 'kept') {
      kept += 1;
    }
  }
  if (denominator === 0) {
    return null;
  }
  return kept / denominator;
}
