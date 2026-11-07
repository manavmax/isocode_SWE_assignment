/**
 * Nightly promise-status recompute (SPEC 12, prompt 11 item 3). The promise
 * table stores a status; the truth lives in the payments feed (inferred from
 * the LMS delta) and the calendar. This job re-derives every non-terminal
 * promise's status from promiseState (pure rules) and writes only the rows
 * whose derived state differs — so a rerun over an unchanged database
 * changes nothing (idempotent), and a late payment can still upgrade a
 * broken_part to kept the next night.
 *
 * Sources of truth per promise: payments posted on/after the creation day
 * (IST dates), the loan's cleared flag (a loan that leaves the book is a
 * kept promise even with no recorded payment — posting lag), and today's
 * IST date for the grace deadline. superseded and disputed are terminal by
 * other rules and never touched.
 *
 * Called at the end of a successful import (fresh payments just landed) and
 * from POST /api/jobs/nightly, which Vercel's cron hits daily with the
 * CRON_SECRET bearer token.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb, withTx } from '../db.js';
import { promises } from '../db/schema.js';
import { istDateKey } from '../../shared/datetime.js';
import { derivePromiseStatus, promiseDeadline } from '../../shared/promiseState.js';
import type { PromiseStatus } from '../../shared/types.js';

export interface NightlyOutcome {
  /** Promises read (non-terminal ones). */
  examined: number;
  /** Rows whose stored state differed and was written. */
  updated: number;
  kept: number;
  broken: number;
  brokenPart: number;
  /** Kept rate over settled promises (kept / (kept + broken + broken_part)),
   *  null when none have settled — never zero, so an empty book prints as
   *  "no data" rather than a perfect failure. */
  keptRate: number | null;
}

interface PromiseTruthRow {
  id: string;
  status: PromiseStatus;
  promisedAmount: number;
  promisedDate: string;
  graceDays: number;
  paidAmount: number | null;
  resolvedAt: Date | null;
  loanCleared: boolean;
  paid: number;
}

/** timestamptz arrives as a Date (pooled driver) or an ISO string (neon
 *  http) — normalise to Date or null. */
function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export async function recomputePromiseStatuses(nowMs: number = Date.now()): Promise<NightlyOutcome> {
  const db = getDb();
  const todayIst = istDateKey(nowMs);
  const readRows = await db.execute(sql`
    SELECT p.id::text AS id,
           p.status::text AS status,
           p.promised_amount::bigint AS promised_amount,
           p.promised_date::text AS promised_date,
           p.grace_days::int AS grace_days,
           p.paid_amount::bigint AS paid_amount,
           p.resolved_at,
           (l.status = 'cleared') AS loan_cleared,
           COALESCE(pay.total, 0)::bigint AS paid
    FROM promise p
    JOIN loan l ON l.loan_id = p.loan_id
    LEFT JOIN LATERAL (
      SELECT SUM(pay.amount) AS total
      FROM payment pay
      WHERE pay.loan_id = p.loan_id
        AND (pay.posted_at AT TIME ZONE 'Asia/Kolkata')::date
              >= (p.created_at AT TIME ZONE 'Asia/Kolkata')::date
    ) pay ON true
    WHERE p.status NOT IN ('superseded', 'disputed')
  `);

  const rows: PromiseTruthRow[] = readRows.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      status: String(row.status) as PromiseStatus,
      promisedAmount: Number(row.promised_amount),
      promisedDate: String(row.promised_date).slice(0, 10),
      graceDays: Number(row.grace_days),
      paidAmount: row.paid_amount === null || row.paid_amount === undefined ? null : Number(row.paid_amount),
      // The neon-http driver returns timestamptz as ISO strings; the pooled
      // driver returns Dates. Accept both — an instanceof-only check made
      // every settled row look unresolved over http and rewrote it.
      resolvedAt: parseTimestamp(row.resolved_at),
      loanCleared: row.loan_cleared === true,
      paid: Number(row.paid)
    };
  });

  const now = new Date(nowMs);
  const updates: { id: string; status: PromiseStatus; paidAmount: number; resolve: boolean }[] = [];
  const settled = { kept: 0, broken: 0, brokenPart: 0 };
  const settledKey = (status: PromiseStatus): 'kept' | 'broken' | 'brokenPart' | null =>
    status === 'kept' ? 'kept' : status === 'broken' ? 'broken' : status === 'broken_part' ? 'brokenPart' : null;

  for (const row of rows) {
    const derived = derivePromiseStatus(
      {
        status: row.status,
        promisedDate: row.promisedDate,
        graceDays: row.graceDays,
        promisedAmount: row.promisedAmount,
        paidAmount: row.paid,
        loanCleared: row.loanCleared
      },
      todayIst
    );
    // Resolve the moment a promise settles; never un-resolve afterwards.
    const needsResolve = derived !== 'open' && row.resolvedAt === null;
    const statusChanged = derived !== row.status;
    const paidChanged = row.paidAmount === null || row.paidAmount !== row.paid;

    if (statusChanged || paidChanged || needsResolve) {
      updates.push({ id: row.id, status: derived, paidAmount: row.paid, resolve: needsResolve });
    }
    const key = settledKey(derived);
    if (key) {
      settled[key] += 1;
    }
  }

  if (updates.length > 0) {
    await withTx(async (tx) => {
      for (const update of updates) {
        await tx
          .update(promises)
          .set({
            status: update.status,
            paidAmount: update.paidAmount,
            ...(update.resolve ? { resolvedAt: now } : {})
          })
          .where(eq(promises.id, update.id));
      }
    });
  }

  const denominator = settled.kept + settled.broken + settled.brokenPart;
  return {
    examined: rows.length,
    updated: updates.length,
    kept: settled.kept,
    broken: settled.broken,
    brokenPart: settled.brokenPart,
    keptRate: denominator === 0 ? null : settled.kept / denominator
  };
}

/** CRON_SECRET gate: the header must be exactly `Bearer <secret>`, compared
 *  through sha256 digests + timingSafeEqual (length-independent, A30's token
 *  pattern). The job is disabled — never matching — while the env var is
 *  unset or empty, so a deployment without the variable cannot be cronned
 *  and cannot be probed either. */
export function cronSecretMatches(authorizationHeader: string | null, cronSecret: string | undefined): boolean {
  if (!cronSecret || !authorizationHeader) {
    return false;
  }
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(`Bearer ${cronSecret}`), digest(authorizationHeader));
}

/** SPEC 12 stuck list: a broken promise two or more days past its deadline
 *  with no officer action. The dal applies the same definition for the
 *  officer endpoint's cards; the manager dashboard consumes it later. */
export function isStuck(daysPastDue: number): boolean {
  return daysPastDue >= 2;
}

export { promiseDeadline };
