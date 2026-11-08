/**
 * Feature collection for the SPEC 8 scorecard (prompt 12). One query per
 * batch: the loan's own columns plus the promise/contact aggregates that
 * need the database. Everything the scorecard consumes is assembled here so
 * runScoring and scripts/fit-standardisation.ts read the SAME features —
 * the fit cannot drift from the serving path.
 *
 * Data provenance notes (A65): the LMS CSV carries no bounce or vintage
 * column, so bounce_count_12m / vintage_months are populated by the seed's
 * part-2 pass from the generator's ground truth (a side feed in a real
 * deployment); broken-promise and contact features come from the live
 * promise / contact_event tables. A29: BLOCKED attempts are not touches —
 * the last-contact features filter to CALL/VISIT/MESSAGE.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db.js';
import type { OutcomeGroup, RawFeatures } from '../../shared/scoring/scorecard.js';
import { addIstDays } from '../../shared/promises.js';

export interface ScoredLoanFeatures {
  loanId: string;
  features: RawFeatures;
  /** Any broken promise ever — the low-lane exclusion and the fallback
   *  comparator's first key. */
  hasBrokenPromise: boolean;
  /** Open promise whose deadline (promised_date + grace) has not passed —
   *  pins the loan to the top of the worklist. */
  duePromise: boolean;
}

interface FeatureRow {
  loan_id: string;
  dpd: number;
  bounce_count_12m: number;
  vintage_months: number;
  overdue_amount: number;
  emi_amount: number | null;
  outstanding: number;
  broken90: number;
  kept: number;
  made: number;
  last_outcome: string | null;
  last_touch_date: string | null;
  has_broken: boolean;
  due_promise: boolean;
}

const GROUP_FOR_OUTCOME: Record<string, OutcomeGroup> = {
  not_reachable: 'unreachable',
  wrong_number: 'unreachable',
  refused: 'refused',
  dispute: 'refused',
  promise_to_pay: 'promised',
  paid: 'part_paid'
};

export async function collectLoanFeatures(asOf: string): Promise<ScoredLoanFeatures[]> {
  const db = getDb();
  const windowStart = addIstDays(asOf, -90);
  const rows = (
    await db.execute(sql`
      SELECT l.loan_id::text AS loan_id,
             l.dpd,
             l.bounce_count_12m,
             l.vintage_months,
             l.overdue_amount,
             l.emi_amount,
             l.outstanding,
             (SELECT count(*) FROM promise p
               WHERE p.loan_id = l.loan_id AND p.status IN ('broken', 'broken_part')
                 AND p.resolved_at >= DATE ${windowStart})::int AS broken90,
             (SELECT count(*) FROM promise p
               WHERE p.loan_id = l.loan_id AND p.status = 'kept')::int AS kept,
             (SELECT count(*) FROM promise p
               WHERE p.loan_id = l.loan_id AND p.status IN ('kept', 'broken', 'broken_part'))::int AS made,
             (SELECT ce.outcome FROM contact_event ce
               WHERE ce.loan_id = l.loan_id AND ce.kind IN ('CALL', 'VISIT', 'MESSAGE')
               ORDER BY ce.attempted_at_ist DESC LIMIT 1) AS last_outcome,
             (SELECT max((ce.attempted_at_ist AT TIME ZONE 'Asia/Kolkata')::date)::text FROM contact_event ce
               WHERE ce.loan_id = l.loan_id AND ce.kind IN ('CALL', 'VISIT', 'MESSAGE')) AS last_touch_date,
             EXISTS (SELECT 1 FROM promise p WHERE p.loan_id = l.loan_id AND p.status IN ('broken', 'broken_part')) AS has_broken,
             EXISTS (SELECT 1 FROM promise p WHERE p.loan_id = l.loan_id AND p.status = 'open'
               AND p.promised_date <= DATE ${asOf} AND p.promised_date + p.grace_days >= DATE ${asOf}) AS due_promise
        FROM loan l
       WHERE l.status = 'overdue'
       ORDER BY l.loan_id
    `)
  ).rows as unknown as FeatureRow[];

  return rows.map((row) => ({
    loanId: String(row.loan_id),
    hasBrokenPromise: row.has_broken === true,
    duePromise: row.due_promise === true,
    features: {
      dpd: row.dpd,
      bounces: row.bounce_count_12m,
      broken90: row.broken90,
      keptKept: row.kept,
      keptMade: row.made,
      lastOutcomeGroup: row.last_outcome ? (GROUP_FOR_OUTCOME[row.last_outcome] ?? null) : null,
      daysSinceContact: row.last_touch_date
        ? Math.max(0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${row.last_touch_date}T00:00:00Z`)) / 86_400_000))
        : null,
      overdue: row.overdue_amount,
      emi: row.emi_amount,
      outstanding: row.outstanding,
      vintageMonths: row.vintage_months
    }
  }));
}
