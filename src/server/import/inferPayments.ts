/**
 * Payment inference from the LMS delta (prompt 11 item 2, SPEC 11
 * companion). The daily CSV carries balances only, so a payment is inferred
 * from the outstanding drop against the previous snapshot; a loan that
 * vanished from the full file was paid off (applyImport clears it — SPEC 11
 * gone-handling — and the payment row records the money). Every inferred
 * payment is source 'lms_delta' and posts on the import's as_of IST date at
 * noon IST (06:30 UTC), so the timestamp belongs to exactly one IST day —
 * the granularity the promise tracker (SPEC 12 "payments since creation")
 * and the replace-recompute delete window both operate on.
 *
 * Idempotency lives in applyImport: the same-bytes noop path returns before
 * any write, so a replay adds nothing; a replace deletes this as_of's
 * inferred rows (source + posted on that IST day) and reinserts the fresh
 * inference inside the same transaction.
 */
export interface InferredPayment {
  loanId: string;
  amountPaise: number;
  /** IST date key the payment posts on (the import's as_of). */
  postedOnIst: string;
}

export interface InferPaymentsInput {
  previous: ReadonlyMap<string, { outstanding: number }>;
  rows: readonly { loanId: string; outstanding: number }[];
  goneLoanIds: readonly string[];
  /** The import's as_of IST date key — every inferred payment posts on it. */
  asOf: string;
}

/** Pure delta rule: outstanding fall = payment of the drop (positive only —
 * a rising balance is not a refund); gone = full previous outstanding.
 * Rows are walked in file order, then gone loans, so the inference is
 * deterministic for a given file. */
export function inferPaymentsFromDelta(input: InferPaymentsInput): InferredPayment[] {
  const inferred: InferredPayment[] = [];
  for (const row of input.rows) {
    const previous = input.previous.get(row.loanId);
    if (!previous) {
      continue;
    }
    const drop = previous.outstanding - row.outstanding;
    if (drop > 0) {
      inferred.push({ loanId: row.loanId, amountPaise: drop, postedOnIst: input.asOf });
    }
  }
  for (const loanId of input.goneLoanIds) {
    const previous = input.previous.get(loanId);
    if (previous && previous.outstanding > 0) {
      inferred.push({ loanId, amountPaise: previous.outstanding, postedOnIst: input.asOf });
    }
  }
  return inferred;
}

/** The UTC instant of noon IST (06:30 UTC) on an IST date key: the canonical
 * posted_at for inferred payments. */
export function istNoonUtc(dateKey: string): Date {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + 6 * 3_600_000 + 30 * 60_000);
}

/** The UTC half-open window [start, end) covering the whole IST day of a
 * date key — the delete window a same-as_of replace recomputes within. */
export function istDayUtcRange(dateKey: string): { startUtc: Date; endUtc: Date } {
  const startMs = Date.parse(`${dateKey}T00:00:00Z`) - 330 * 60_000;
  return { startUtc: new Date(startMs), endUtc: new Date(startMs + 86_400_000) };
}
