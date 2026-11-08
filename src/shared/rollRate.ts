/**
 * Cohort roll rate (SPEC 13, prompt 13 item 1), pure. A cohort = loans in
 * 1-30 DPD at the t0 snapshot; the outcome at t1 = t0 + 30 days is cured
 * (absent from the snapshot or DPD 0), stayed (1-30 again) or rolled (31+).
 * ATTRIBUTION IS OPENING: branch and officer come from the t0 rows only —
 * a loan reassigned during the window is still charged to its opening
 * officer, which is what makes the branch totals equal the sum of the
 * officers (the officer's own rows are the t0 attribution, so summing them
 * reproduces the branch row exactly).
 *
 * Both a count and a balance version exist (the balance version uses the
 * OPENING outstanding, never closing). An immature window reports
 * "pending" — never zero, so an empty window cannot masquerade as a perfect
 * one. The count rate carries a Wilson 95% interval; rows with n < 30 are
 * flagged for the UI to grey out. The migration table groups the same
 * outcomes by OPENING DPD BUCKET with shares that sum to 1 per row.
 */

export interface CohortSlice {
  loanId: string;
  branchId: string;
  officerId: string | null;
  /** DPD at t0 (1-30 for this module's cohorts). */
  dpd: number;
  /** Opening outstanding in paise. */
  outstanding: number;
}

export interface OutcomeRow {
  loanId: string;
  /** DPD at t1, or null when the loan is absent from the snapshot (cured). */
  dpd: number | null;
}

export interface RollResult {
  cohortN: number;
  cured: number;
  stayed: number;
  rolled: number;
  cohortAmt: number;
  rolledAmt: number;
  /** 'pending' while the window is immature — never 0 by construction. */
  rollRateCount: 'pending' | number;
  rollRateAmount: 'pending' | number;
  /** Wilson 95% interval on the count rate; null while pending. */
  wilson: { low: number; high: number } | null;
  /** The officer table greys rows with n < 30 (SPEC 13). */
  greyedOut: boolean;
}

export interface RollOptions {
  windowComplete: boolean;
  /** Grey-out threshold (SPEC 13: grey under 30). */
  greyBelowN?: number;
}

const GREY_BELOW_N = 30;

function classifyOutcome(dpd: number | null): 'cured' | 'stayed' | 'rolled' {
  if (dpd === null || dpd === 0) {
    return 'cured';
  }
  return dpd >= 31 ? 'rolled' : 'stayed';
}

export function computeRollRate(t0: readonly CohortSlice[], t1: readonly OutcomeRow[], options: RollOptions): RollResult {
  const greyBelowN = options.greyBelowN ?? GREY_BELOW_N;
  const outcomes = new Map(t1.map((row) => [row.loanId, row.dpd]));
  let cured = 0;
  let stayed = 0;
  let rolled = 0;
  let cohortAmt = 0;
  let rolledAmt = 0;
  for (const entry of t0) {
    cohortAmt += entry.outstanding;
    const kind = classifyOutcome(outcomes.get(entry.loanId) ?? null);
    if (kind === 'cured') {
      cured += 1;
    } else if (kind === 'stayed') {
      stayed += 1;
    } else {
      rolled += 1;
      rolledAmt += entry.outstanding;
    }
  }
  const cohortN = t0.length;
  if (!options.windowComplete) {
    return {
      cohortN,
      cured,
      stayed,
      rolled,
      cohortAmt,
      rolledAmt,
      rollRateCount: 'pending',
      rollRateAmount: 'pending',
      wilson: null,
      greyedOut: cohortN < greyBelowN
    };
  }
  return {
    cohortN,
    cured,
    stayed,
    rolled,
    cohortAmt,
    rolledAmt,
    rollRateCount: cohortN === 0 ? 'pending' : rolled / cohortN,
    rollRateAmount: cohortAmt === 0 ? 'pending' : rolledAmt / cohortAmt,
    wilson: cohortN === 0 ? null : wilsonInterval(rolled, cohortN),
    greyedOut: cohortN < greyBelowN
  };
}

/** Wilson 95% score interval (z = 1.96) on a binomial proportion. */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) {
    return null;
  }
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator)
  };
}

interface GroupKey {
  branchId: string;
  officerId: string | null;
}

function aggregate(t0: readonly CohortSlice[], t1: readonly OutcomeRow[], options: RollOptions, key: (slice: CohortSlice) => GroupKey) {
  const groups = new Map<string, { key: GroupKey; slices: CohortSlice[] }>();
  for (const slice of t0) {
    const groupKey = key(slice);
    const id = `${groupKey.branchId}|${groupKey.officerId ?? ''}`;
    const bucket = groups.get(id) ?? { key: groupKey, slices: [] };
    bucket.slices.push(slice);
    groups.set(id, bucket);
  }
  return [...groups.values()]
    .map((group) => ({
      branchId: group.key.branchId,
      officerId: group.key.officerId,
      ...computeRollRate(group.slices, t1, options)
    }))
    .sort((a, b) => b.cohortN - a.cohortN || a.branchId.localeCompare(b.branchId));
}

export interface BranchRollRow extends RollResult {
  branchId: string;
  officerId: string | null;
}

export function aggregateByBranch(t0: readonly CohortSlice[], t1: readonly OutcomeRow[], options: RollOptions): BranchRollRow[] {
  return aggregate(t0, t1, options, (slice) => ({ branchId: slice.branchId, officerId: null }));
}

export interface OfficerRollRow extends RollResult {
  branchId: string;
  officerId: string | null;
}

export function aggregateByOfficer(t0: readonly CohortSlice[], t1: readonly OutcomeRow[], options: RollOptions): OfficerRollRow[] {
  return aggregate(t0, t1, options, (slice) => ({ branchId: slice.branchId, officerId: slice.officerId }));
}

export interface MigrationRow {
  openingBucket: string;
  cohortN: number;
  curedShare: number;
  stayedShare: number;
  rolledShare: number;
}

function bucketFor(dpd: number): string {
  if (dpd <= 30) return '1-30';
  if (dpd <= 60) return '31-60';
  if (dpd <= 90) return '61-90';
  return '90+';
}

/** SPEC 13's migration table: per OPENING DPD bucket, the share of loans
 *  that cured / stayed / rolled. Shares sum to 1 per row (exact halves can
 *  need a rounding nudge, so the stayed share absorbs the residue). */
export function migrationTable(t0: readonly CohortSlice[], t1: readonly OutcomeRow[], options: RollOptions): MigrationRow[] {
  const outcomes = new Map(t1.map((row) => [row.loanId, row.dpd]));
  const groups = new Map<string, { n: number; cured: number; stayed: number; rolled: number }>();
  for (const slice of t0) {
    if (options.greyBelowN !== undefined && slice.dpd > 90) {
      continue; // NPA loans sit outside the migration view
    }
    const bucket = bucketFor(slice.dpd);
    const row = groups.get(bucket) ?? { n: 0, cured: 0, stayed: 0, rolled: 0 };
    row.n += 1;
    const kind = classifyOutcome(outcomes.get(slice.loanId) ?? null);
    row[kind] += 1;
    groups.set(bucket, row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([openingBucket, row]) => {
      const curedShare = row.cured / row.n;
      const rolledShare = row.rolled / row.n;
      return {
        openingBucket,
        cohortN: row.n,
        curedShare,
        rolledShare,
        stayedShare: 1 - curedShare - rolledShare
      };
    });
}

/** Every completed 30-day window whose t0 and t1 are both real snapshot
 *  dates and whose t1 has passed: the trend's x axis (SPEC 13: every
 *  completed window available). */
export function enumerateWindows(snapshotDates: readonly string[], windowDays: number, today: string): { t0: string; t1: string; complete: boolean }[] {
  const dates = new Set(snapshotDates);
  const windows: { t0: string; t1: string; complete: boolean }[] = [];
  for (const date of [...dates].sort()) {
    const t1 = new Date(Date.parse(`${date}T00:00:00Z`) + windowDays * 86_400_000).toISOString().slice(0, 10);
    if (t1 <= today && dates.has(t1)) {
      windows.push({ t0: date, t1, complete: true });
    }
  }
  return windows;
}
