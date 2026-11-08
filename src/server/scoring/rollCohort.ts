/**
 * roll_cohort cache (SPEC 13, prompt 13 item 2): every completed 30-day
 * window with real snapshots gets its per-branch, per-officer (and branch
 * roll-up via the NULL-officer row) aggregates written as an idempotent
 * upsert on (t0, t1, branch, officer) — the dashboard reads the cache, the
 * nightly and every successful import refresh it. Attribution and both
 * versions (count + balance) come from the pure module.
 */
import { sql } from 'drizzle-orm';
import { getDb, withTx } from '../db.js';
import { rollCohorts } from '../db/schema.js';
import { aggregateByBranch, aggregateByOfficer, enumerateWindows, type CohortSlice, type OutcomeRow } from '../../shared/rollRate.js';

export interface RollCacheOutcome {
  windows: { t0: string; t1: string }[];
  rowsWritten: number;
}

export async function writeRollCohortCache(latestBatchDate: string): Promise<RollCacheOutcome> {
  const db = getDb();
  const snapshotDates = (
    await db.execute(sql`SELECT DISTINCT as_of::text AS as_of FROM loan_snapshot ORDER BY as_of`)
  ).rows as unknown as { as_of: string }[];
  const dates = snapshotDates.map((row) => String(row.as_of).slice(0, 10));
  const windows = enumerateWindows(dates, 30, latestBatchDate);

  let rowsWritten = 0;
  for (const window of windows) {
    const t0Rows = (
      await db.execute(sql`
        SELECT s.loan_id::text AS loan_id, s.branch_id::text AS branch_id, s.officer_id::text AS officer_id,
               s.dpd, s.outstanding
        FROM loan_snapshot s
        WHERE s.as_of = ${window.t0}::date AND s.dpd BETWEEN 1 AND 30
        ORDER BY s.loan_id
      `)
    ).rows as unknown as { loan_id: string; branch_id: string; officer_id: string | null; dpd: number; outstanding: number }[];
    const t1Rows = (
      await db.execute(sql`
        SELECT loan_id::text AS loan_id, dpd FROM loan_snapshot WHERE as_of = ${window.t1}::date
      `)
    ).rows as unknown as { loan_id: string; dpd: number }[];
    const t0: CohortSlice[] = t0Rows.map((row) => ({
      loanId: row.loan_id,
      branchId: row.branch_id,
      officerId: row.officer_id,
      dpd: Number(row.dpd),
      outstanding: Number(row.outstanding)
    }));
    const t1: OutcomeRow[] = t1Rows.map((row) => ({ loanId: row.loan_id, dpd: row.dpd === null ? null : Number(row.dpd) }));
    if (t0.length === 0) {
      continue;
    }
    const branchRows = aggregateByBranch(t0, t1, { windowComplete: true });
    const officerRows = aggregateByOfficer(t0, t1, { windowComplete: true });
    await withTx(async (tx) => {
      for (const row of [...branchRows, ...officerRows]) {
        await tx
          .insert(rollCohorts)
          .values({
            t0: window.t0,
            t1: window.t1,
            branchId: row.branchId,
            officerId: row.officerId,
            cohortN: row.cohortN,
            curedN: row.cured,
            stayedN: row.stayed,
            rolledN: row.rolled,
            cohortAmt: row.cohortAmt,
            rolledAmt: row.rolledAmt
          })
          .onConflictDoUpdate({
            target: [rollCohorts.t0, rollCohorts.t1, rollCohorts.branchId, rollCohorts.officerId],
            set: {
              cohortN: sql`excluded.cohort_n`,
              curedN: sql`excluded.cured_n`,
              stayedN: sql`excluded.stayed_n`,
              rolledN: sql`excluded.rolled_n`,
              cohortAmt: sql`excluded.cohort_amt`,
              rolledAmt: sql`excluded.rolled_amt`
            }
          });
        rowsWritten += 1;
      }
    });
  }
  return { windows: windows.map((w) => ({ t0: w.t0, t1: w.t1 })), rowsWritten };
}
