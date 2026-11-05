/**
 * Seed summary (prompt 8, SPEC 14). Pure text builders only: main.ts runs the
 * queries and prints these lines. The cohort sanity SQL is embedded in the
 * output verbatim so the printed numbers can be reproduced by hand against
 * the same database.
 *
 * Cohort semantics match scripts/seed/history.ts: membership = a loan_snapshot
 * row at t0 with dpd 1-30; outcomes at the end snapshot are cured (absent),
 * stayed (back at dpd 1-30) and rolled (dpd >= 31), and the three must foot
 * back to cohort_n.
 */

export interface CohortRow {
  branch: string;
  cohortN: number;
  cured: number;
  stayed: number;
  rolled: number;
}

export interface OfficerCountRow {
  branch: string;
  officer: string;
  loans: number;
}

export interface BucketRow {
  bucket: string;
  loans: number;
}

/** Display SQL with the dates interpolated (both are resolveAsOf-validated
 *  YYYY-MM-DD strings, so interpolation is injection-safe). One row per
 *  branch plus a '(all branches)' footing row via GROUPING SETS. */
export function cohortSanitySql(t0: string, end: string): string {
  return `WITH cohort AS (
  SELECT s.loan_id, s.branch_id
  FROM loan_snapshot s
  WHERE s.as_of = DATE '${t0}' AND s.dpd BETWEEN 1 AND 30
), final_state AS (
  SELECT f.loan_id, f.dpd
  FROM loan_snapshot f
  WHERE f.as_of = DATE '${end}'
)
SELECT COALESCE(b.name, '(all branches)') AS branch,
       count(*)::int AS cohort_n,
       count(*) FILTER (WHERE f.loan_id IS NULL)::int AS cured,
       count(*) FILTER (WHERE f.loan_id IS NOT NULL AND f.dpd BETWEEN 1 AND 30)::int AS stayed,
       count(*) FILTER (WHERE f.loan_id IS NOT NULL AND f.dpd >= 31)::int AS rolled,
       round(100.0 * count(*) FILTER (WHERE f.loan_id IS NOT NULL AND f.dpd >= 31)
             / NULLIF(count(*), 0), 1) AS roll_pct,
       (count(*) FILTER (WHERE f.loan_id IS NULL)
          + count(*) FILTER (WHERE f.loan_id IS NOT NULL AND f.dpd BETWEEN 1 AND 30)
          + count(*) FILTER (WHERE f.loan_id IS NOT NULL AND f.dpd >= 31)
          = count(*)) AS footing_ok
FROM cohort c
JOIN branch b ON b.id = c.branch_id
LEFT JOIN final_state f ON f.loan_id = c.loan_id
GROUP BY GROUPING SETS ((b.name), ())
ORDER BY (b.name IS NULL), b.name;`;
}

export function rollPct(row: Pick<CohortRow, 'cohortN' | 'rolled'>): string {
  if (row.cohortN <= 0) {
    return 'n/a';
  }
  return ((100 * row.rolled) / row.cohortN).toFixed(1);
}

export function footingProblems(rows: readonly CohortRow[]): string[] {
  return rows.filter((row) => row.cured + row.stayed + row.rolled !== row.cohortN).map((row) => row.branch);
}

export function formatCohortResults(rows: readonly CohortRow[]): string[] {
  const lines = ['  branch          cohort_n  cured  stayed  rolled   roll%'];
  for (const row of rows) {
    lines.push(
      `  ${row.branch.padEnd(15)} ${String(row.cohortN).padStart(7)} ${String(row.cured).padStart(6)} ${String(
        row.stayed
      ).padStart(6)} ${String(row.rolled).padStart(6)} ${rollPct(row).padStart(7)}%`
    );
  }
  const problems = footingProblems(rows);
  lines.push(
    problems.length === 0
      ? '  footing: cured + stayed + rolled = cohort_n holds on every row'
      : `  FOOTING MISMATCH: ${problems.join(', ')}`
  );
  return lines;
}

export function formatOfficerCounts(rows: readonly OfficerCountRow[], queued: number, cleared: number): string[] {
  const lines = ['  branch  officer                loans'];
  for (const row of rows) {
    lines.push(`  ${row.branch.padEnd(7)} ${row.officer.padEnd(20)} ${String(row.loans).padStart(5)}`);
  }
  lines.push(`  ${'queue (no officer, branch manager)'.padEnd(40)} ${String(queued).padStart(5)}`);
  lines.push(`  ${'cleared by the end date (status=cleared)'.padEnd(40)} ${String(cleared).padStart(5)}`);
  return lines;
}

export function formatBucketMix(rows: readonly BucketRow[], totalEndActive: number): string[] {
  const lines = ['  bucket   loans   share'];
  const total = rows.reduce((sum, row) => sum + row.loans, 0);
  for (const row of rows) {
    const share = total > 0 ? ((100 * row.loans) / total).toFixed(1) : 'n/a';
    lines.push(`  ${row.bucket.padEnd(8)} ${String(row.loans).padStart(4)}   ${share.padStart(5)}%`);
  }
  const totalShare = total > 0 ? '100.0' : 'n/a';
  lines.push(`  ${'total'.padEnd(8)} ${String(total).padStart(4)}   ${totalShare.padStart(5)}%`);
  if (total !== totalEndActive) {
    lines.push(`  WARNING: overdue total ${total} != end-active expectation ${totalEndActive}`);
  }
  return lines;
}
