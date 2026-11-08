/**
 * Manager dashboard + manager-only reads (SPEC 13, prompt 13 items 2-4).
 * Every function takes the resolved manager actor and scopes to THEIR
 * branch in the SQL itself — a manager cannot read, list or pin another
 * branch's data regardless of what the client sends. The roll-rate rows
 * come from the roll_cohort cache; the promise/queue/exception lists come
 * from live tables; every footnoted number carries its numerator,
 * denominator, count-vs-balance statement and the synthetic-data note
 * (rendered client-side).
 */
import { sql } from 'drizzle-orm';
import { getDb, withTx } from './db.js';
import { auditLog, loanPriorityOverride } from './db/schema.js';

export interface RollTile {
  t0: string;
  t1: string;
  cohortN: number;
  rolledN: number;
  cohortAmt: number;
  rolledAmt: number;
  rollRateCount: number;
  rollRateAmount: number;
  wilson: { low: number; high: number } | null;
  greyedOut: boolean;
  loansToSave: number;
}

export interface DashboardData {
  branchId: string;
  branchName: string;
  tiles: RollTile | null;
  trend: { t0: string; t1: string; rollRateCount: number | null; cohortN: number }[];
  trendWindowsAvailable: number;
  officerTable: {
    officerId: string;
    officerName: string;
    cohortN: number;
    rolledN: number;
    rollRate: number;
    wilson: { low: number; high: number } | null;
    greyedOut: boolean;
    keptRate: number | null;
    keptMade: number;
    workload: number;
  }[];
  migrationTable: { openingBucket: string; cohortN: number; curedShare: number; stayedShare: number; rolledShare: number }[];
  brokenPromises: { promiseId: string; loanId: string; borrowerName: string; amountPaise: number; promisedDate: string; ageDays: number; officerName: string | null }[];
  exceptions: { loanId: string; borrowerName: string; dpd: number; overdueAmount: number; officerName: string | null }[];
  stuckPromises: { promiseId: string; loanId: string; borrowerName: string; amountPaise: number; deadline: string; daysPastDue: number; officerName: string | null }[];
  queueCount: number;
  blockedAttempts30d: number;
  keptRate: number | null;
  keptMade: number;
  openBrokenPromises: number;
}

const TARGET_RATE = 0.16;

function loansToSave(rollRate: number, cohortN: number): number {
  return Math.max(0, Math.ceil((rollRate - TARGET_RATE) * cohortN));
}

export async function managerDashboard(actor: { branchId: string }, todayIst: string): Promise<DashboardData> {
  const db = getDb();
  const branchRow = (
    await db.execute(sql`SELECT id::text AS id, name FROM branch WHERE id = ${actor.branchId}::uuid LIMIT 1`)
  ).rows[0] as { id: string; name: string } | undefined;
  if (!branchRow) {
    throw new Error('manager: branch not found');
  }

  // --- the latest completed window's cached roll rows for this branch ---
  const rollRows = (
    await db.execute(sql`
      SELECT rc.t0::text AS t0, rc.t1::text AS t1, rc.cohort_n, rc.rolled_n, rc.cohort_amt, rc.rolled_amt,
             (rc.officer_id IS NULL) AS is_branch_row, rc.officer_id::text AS officer_id, o.name AS officer_name
      FROM roll_cohort rc
      JOIN branch b ON b.id = rc.branch_id
      LEFT JOIN officer o ON o.id = rc.officer_id
      WHERE rc.branch_id = ${actor.branchId}::uuid
      ORDER BY rc.t0 DESC
    `)
  ).rows as unknown as {
    t0: string; t1: string; cohort_n: number; rolled_n: number; cohort_amt: number; rolled_amt: number;
    is_branch_row: boolean; officer_id: string | null; officer_name: string | null;
  }[];

  const branchRows = rollRows.filter((row) => row.is_branch_row);
  const officerRows = rollRows.filter((row) => !row.is_branch_row);
  const latest = branchRows[0] ?? null;

  // The officer table needs the kept rate and the workload per officer.
  const officerStats = (
    await db.execute(sql`
      SELECT o.id::text AS officer_id, o.name AS officer_name,
             (SELECT count(*) FROM promise p JOIN loan l ON l.loan_id = p.loan_id
               WHERE l.assigned_officer_id = o.id AND p.status IN ('kept','broken','broken_part'))::int AS kept_made,
             (SELECT count(*) FROM promise p JOIN loan l ON l.loan_id = p.loan_id
               WHERE l.assigned_officer_id = o.id AND p.status = 'kept')::int AS kept_n,
             (SELECT count(*) FROM loan l WHERE l.assigned_officer_id = o.id AND l.status = 'overdue')::int AS workload
      FROM officer o
      WHERE o.branch_id = ${actor.branchId}::uuid AND o.active = true
      ORDER BY o.name
    `)
  ).rows as unknown as { officer_id: string; officer_name: string; kept_made: number; kept_n: number; workload: number }[];

  const officerTable = officerRows.map((row) => {
    const stats = officerStats.find((entry) => entry.officer_id === row.officer_id);
    const keptMade = stats?.kept_made ?? 0;
    const keptN = stats?.kept_n ?? 0;
    return {
      officerId: row.officer_id!,
      officerName: row.officer_name ?? '(unknown)',
      cohortN: row.cohort_n,
      rolledN: row.rolled_n,
      rollRate: row.cohort_n > 0 ? row.rolled_n / row.cohort_n : 0,
      wilson: row.cohort_n > 0 ? wilsonFor(row.rolled_n, row.cohort_n) : null,
      greyedOut: row.cohort_n < 30,
      keptRate: keptMade > 0 ? keptN / keptMade : null,
      keptMade,
      workload: stats?.workload ?? 0
    };
  });

  // --- migration table: outcomes of the latest completed window by opening bucket ---
  const migrationRows = latest
    ? (
        await db.execute(sql`
          WITH cohort AS (
            SELECT s.loan_id, s.dpd FROM loan_snapshot s
            WHERE s.as_of = ${latest.t0}::date AND s.dpd BETWEEN 1 AND 30
              AND s.branch_id = ${actor.branchId}::uuid
          ), end_state AS (
            SELECT e.loan_id, e.dpd FROM loan_snapshot e WHERE e.as_of = ${latest.t1}::date
          )
          SELECT CASE WHEN c.dpd <= 30 THEN '1-30' ELSE '31-60' END AS opening_bucket,
                 count(*)::int AS n,
                 count(*) FILTER (WHERE es.loan_id IS NULL OR es.dpd = 0)::int AS cured,
                 count(*) FILTER (WHERE es.loan_id IS NOT NULL AND es.dpd BETWEEN 1 AND 30)::int AS stayed,
                 count(*) FILTER (WHERE es.loan_id IS NOT NULL AND es.dpd >= 31)::int AS rolled
          FROM cohort c LEFT JOIN end_state es ON es.loan_id = c.loan_id
          GROUP BY 1 ORDER BY 1
        `)
      ).rows as unknown as { opening_bucket: string; n: number; cured: number; stayed: number; rolled: number }[]
    : [];

  // --- broken promises (branch), oldest break first; age in days ---
  const brokenPromises = (
    await db.execute(sql`
      SELECT p.id::text AS promise_id, p.loan_id, l.borrower_name, p.promised_amount, p.promised_date::text AS promised_date,
             p.resolved_at, o.name AS officer_name,
             (SELECT max((ce.attempted_at_ist AT TIME ZONE 'Asia/Kolkata')::date)::text FROM contact_event ce
               WHERE ce.loan_id = p.loan_id AND ce.kind IN ('CALL','VISIT','MESSAGE')) AS last_touch
      FROM promise p
      JOIN loan l ON l.loan_id = p.loan_id
      LEFT JOIN officer o ON o.id = p.officer_id
      WHERE l.branch_id = ${actor.branchId}::uuid AND p.status IN ('broken', 'broken_part')
      ORDER BY p.resolved_at ASC
      LIMIT 25
    `)
  ).rows as unknown as Record<string, unknown>[];

  // --- exceptions: 25-30 DPD, no promise, no contact in 5 days ---
  const exceptions = (
    await db.execute(sql`
      SELECT l.loan_id, l.borrower_name, l.dpd, l.overdue_amount, o.name AS officer_name
      FROM loan l
      LEFT JOIN officer o ON o.id = l.assigned_officer_id
      WHERE l.branch_id = ${actor.branchId}::uuid AND l.status = 'overdue'
        AND l.dpd BETWEEN 25 AND 30
        AND NOT EXISTS (SELECT 1 FROM promise p WHERE p.loan_id = l.loan_id AND p.status = 'open')
        AND NOT EXISTS (
          SELECT 1 FROM contact_event ce
          WHERE ce.loan_id = l.loan_id AND ce.kind IN ('CALL','VISIT','MESSAGE')
            AND (ce.attempted_at_ist AT TIME ZONE 'Asia/Kolkata')::date >= ${todayIst}::date - 4
        )
      ORDER BY l.dpd DESC, l.loan_id
      LIMIT 25
    `)
  ).rows as unknown as Record<string, unknown>[];

  // --- the nightly stuck list, branch-scoped ---
  const stuckPromises = (
    await db.execute(sql`
      SELECT p.id::text AS promise_id, p.loan_id, l.borrower_name, p.promised_amount,
             (p.promised_date + p.grace_days)::text AS deadline, o.name AS officer_name
      FROM promise p
      JOIN loan l ON l.loan_id = p.loan_id
      LEFT JOIN officer o ON o.id = p.officer_id
      WHERE l.branch_id = ${actor.branchId}::uuid AND p.status IN ('broken', 'broken_part')
        AND (p.promised_date + p.grace_days) <= ${todayIst}::date - 2
        AND NOT EXISTS (
          SELECT 1 FROM contact_event ce
          WHERE ce.loan_id = p.loan_id AND ce.attempted_at_ist >= p.resolved_at
        )
      ORDER BY (p.promised_date + p.grace_days) ASC
      LIMIT 25
    `)
  ).rows as unknown as Record<string, unknown>[];

  // --- tiles ---
  const queueRow = (
    await db.execute(sql`SELECT count(*)::int AS n FROM loan WHERE branch_id = ${actor.branchId}::uuid AND status = 'queue'`)
  ).rows[0] as { n: number };
  const blockedRow = (
    await db.execute(sql`
      SELECT count(*)::int AS n FROM contact_event ce
      JOIN loan l ON l.loan_id = ce.loan_id
      WHERE l.branch_id = ${actor.branchId}::uuid AND ce.kind = 'BLOCKED'
        AND (ce.attempted_at_ist AT TIME ZONE 'Asia/Kolkata')::date >= ${todayIst}::date - 29
    `)
  ).rows[0] as { n: number };
  const keptRow = (
    await db.execute(sql`
      SELECT count(*)::int AS made,
             count(*) FILTER (WHERE status = 'kept')::int AS kept
      FROM promise p JOIN loan l ON l.loan_id = p.loan_id
      WHERE l.branch_id = ${actor.branchId}::uuid AND p.status IN ('kept','broken','broken_part')
    `)
  ).rows[0] as { made: number; kept: number };

  const openBrokenRow = (
    await db.execute(sql`
      SELECT count(*)::int AS n FROM promise p JOIN loan l ON l.loan_id = p.loan_id
      WHERE l.branch_id = ${actor.branchId}::uuid AND p.status IN ('broken', 'broken_part')
    `)
  ).rows[0] as { n: number };

  const tiles: RollTile | null = latest
    ? {
        t0: latest.t0,
        t1: latest.t1,
        cohortN: latest.cohort_n,
        rolledN: latest.rolled_n,
        cohortAmt: Number(latest.cohort_amt),
        rolledAmt: Number(latest.rolled_amt),
        rollRateCount: latest.cohort_n > 0 ? latest.rolled_n / latest.cohort_n : 0,
        rollRateAmount: Number(latest.cohort_amt) > 0 ? Number(latest.rolled_amt) / Number(latest.cohort_amt) : 0,
        wilson: latest.cohort_n > 0 ? wilsonFor(latest.rolled_n, latest.cohort_n) : null,
        greyedOut: latest.cohort_n < 30,
        loansToSave: loansToSave(latest.cohort_n > 0 ? latest.rolled_n / latest.cohort_n : 0, latest.cohort_n)
      }
    : null;

  const daysBetween = (dateKey: string): number =>
    Math.max(0, Math.round((Date.parse(`${todayIst}T00:00:00Z`) - Date.parse(`${dateKey}T00:00:00Z`)) / 86_400_000));

  return {
    branchId: branchRow.id,
    branchName: branchRow.name,
    tiles,
    trend: branchRows
      .slice()
      .reverse()
      .map((row) => ({
        t0: row.t0,
        t1: row.t1,
        cohortN: row.cohort_n,
        rollRateCount: row.cohort_n > 0 ? row.rolled_n / row.cohort_n : null
      })),
    trendWindowsAvailable: branchRows.length,
    officerTable,
    migrationTable: migrationRows.map((row) => {
      const curedShare = row.cured / row.n;
      const rolledShare = row.rolled / row.n;
      return {
        openingBucket: row.opening_bucket,
        cohortN: row.n,
        curedShare,
        rolledShare,
        stayedShare: 1 - curedShare - rolledShare
      };
    }),
    brokenPromises: brokenPromises.map((row) => ({
      promiseId: String(row.promise_id),
      loanId: String(row.loan_id),
      borrowerName: String(row.borrower_name),
      amountPaise: Number(row.promised_amount),
      promisedDate: String(row.promised_date),
      ageDays: row.resolved_at ? daysBetween(new Date(row.resolved_at as unknown as string).toISOString().slice(0, 10)) : 0,
      officerName: row.officer_name === null ? null : String(row.officer_name)
    })),
    exceptions: exceptions.map((row) => ({
      loanId: String(row.loan_id),
      borrowerName: String(row.borrower_name),
      dpd: Number(row.dpd),
      overdueAmount: Number(row.overdue_amount),
      officerName: row.officer_name === null ? null : String(row.officer_name)
    })),
    stuckPromises: stuckPromises.map((row) => {
      const deadline = String(row.deadline);
      return {
        promiseId: String(row.promise_id),
        loanId: String(row.loan_id),
        borrowerName: String(row.borrower_name),
        amountPaise: Number(row.promised_amount),
        deadline,
        daysPastDue: Math.max(2, daysBetween(deadline)),
        officerName: row.officer_name === null ? null : String(row.officer_name)
      };
    }),
    queueCount: Number(queueRow.n),
    blockedAttempts30d: Number(blockedRow.n),
    keptRate: Number(keptRow.made) > 0 ? Number(keptRow.kept) / Number(keptRow.made) : null,
    keptMade: Number(keptRow.made),
    openBrokenPromises: Number(openBrokenRow.n)
  };

  function wilsonFor(successes: number, n: number): { low: number; high: number } {
    const p = successes / n;
    const z = 1.96;
    const denominator = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return { low: Math.max(0, (centre - spread) / denominator), high: Math.min(1, (centre + spread) / denominator) };
  }
}

export interface ActivityRow {
  eventId: string;
  loanId: string;
  kind: string;
  outcome: string | null;
  attemptedAtIst: string;
  withinWindow: boolean;
  complianceStatus: string | null;
  gpsStatus: string | null;
  accuracyM: number | null;
}

/** Manager view of an officer's last 50 contact events (read-only). The
 *  officer must belong to the manager's branch — the join enforces it, so a
 *  foreign officer id answers an empty list rather than foreign data. */
export async function officerActivity(actor: { branchId: string }, officerId: string): Promise<ActivityRow[]> {
  const db = getDb();
  const rows = (
    await db.execute(sql`
      SELECT ce.id::text AS event_id, ce.loan_id, ce.kind::text AS kind, ce.outcome,
             ce.attempted_at_ist, ce.within_window, ce.compliance_status::text AS compliance_status,
             ce.gps_status::text AS gps_status, ce.accuracy_m
      FROM contact_event ce
      JOIN officer o ON o.id = ce.officer_id
      WHERE ce.officer_id = ${officerId}::uuid AND o.branch_id = ${actor.branchId}::uuid
      ORDER BY ce.attempted_at_ist DESC
      LIMIT 50
    `)
  ).rows as unknown as Record<string, unknown>[];
  return rows.map((row) => ({
    eventId: String(row.event_id),
    loanId: String(row.loan_id),
    kind: String(row.kind),
    outcome: row.outcome === null ? null : String(row.outcome),
    attemptedAtIst: new Date(row.attempted_at_ist as unknown as string).toISOString(),
    withinWindow: row.within_window === true,
    complianceStatus: row.compliance_status === null ? null : String(row.compliance_status),
    gpsStatus: row.gps_status === null ? null : String(row.gps_status),
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m)
  }));
}

export interface PinResult {
  loanId: string;
  officerId: string;
  pinnedAt: string;
}

/** Pin a loan to an officer's top (SPEC 13 manager reorder). Both the loan
 *  and the officer must sit in the manager's branch — a cross-branch pair
 *  is refused here, not just at the route. Audited inside the dal (the
 *  route file holds no driver imports — routeDbGuard). */
export async function pinLoan(
  actor: { userId: string; branchId: string; username: string },
  loanId: string,
  officerId: string
): Promise<PinResult | null> {
  const db = getDb();
  const check = (
    await db.execute(sql`
      SELECT l.loan_id, l.branch_id::text AS loan_branch, o.branch_id::text AS officer_branch
      FROM loan l CROSS JOIN officer o
      WHERE l.loan_id = ${loanId} AND o.id = ${officerId}::uuid
    `)
  ).rows[0] as { loan_id: string; loan_branch: string; officer_branch: string } | undefined;
  if (!check || check.loan_branch !== actor.branchId || check.officer_branch !== actor.branchId) {
    return null; // foreign loan, foreign officer, or the pair does not exist
  }
  const rows = await db
    .insert(loanPriorityOverride)
    .values({ loanId, officerId, pinnedBy: actor.userId })
    .onConflictDoUpdate({
      target: loanPriorityOverride.loanId,
      set: { officerId, pinnedBy: actor.userId, pinnedAt: new Date() }
    })
    .returning({ pinnedAt: loanPriorityOverride.pinnedAt });
  await withTx(async (tx) => {
    await tx.insert(auditLog).values({ actor: actor.username, action: 'priority:pin', subject: loanId, detail: { officerId, pinnedBy: actor.username } });
  });
  return { loanId, officerId, pinnedAt: (rows[0]!.pinnedAt as Date).toISOString() };
}

export async function unpinLoan(actor: { branchId: string; username: string }, loanId: string): Promise<boolean> {
  const db = getDb();
  const existing = (
    await db.execute(sql`
      SELECT lpo.loan_id FROM loan_priority_override lpo
      JOIN loan l ON l.loan_id = lpo.loan_id
      WHERE lpo.loan_id = ${loanId} AND l.branch_id = ${actor.branchId}::uuid
    `)
  ).rows;
  if (rowsExistingEmpty(existing)) {
    return false; // nothing pinned, or a foreign branch's pin
  }
  await db.delete(loanPriorityOverride).where(sql`${loanPriorityOverride.loanId} = ${loanId}`);
  await withTx(async (tx) => {
    await tx.insert(auditLog).values({ actor: actor.username, action: 'priority:unpin', subject: loanId, detail: { pinnedBy: actor.username } });
  });
  return true;
}

function rowsExistingEmpty(rows: unknown[]): boolean {
  return rows.length === 0;
}
