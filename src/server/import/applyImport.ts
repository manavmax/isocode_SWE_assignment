import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { getDb, withTx, type PooledTx } from '../db.js';
import {
  auditLog,
  branches,
  importBatches,
  importRowErrors,
  loanSnapshots,
  loans,
  officers,
  payments,
  promises,
  territory
} from '../db/schema.js';
import { parseCsv } from '../../shared/import/parseFile.js';
import { planImport } from '../../shared/import/planImport.js';
import type { ImportPlan, TerritoryRow } from '../../shared/import/planImport.js';
import type { ImportLoan, RowIssue } from '../../shared/import/validateRow.js';
import { dpdBucketFor } from '../../shared/bucket.js';
import { ASSIGNMENT_REASONS, type AssignmentReason } from '../../shared/assignment.js';
import { runAssignment } from '../assignment/runAssignment.js';
import { inferPaymentsFromDelta, istDayUtcRange, istNoonUtc } from './inferPayments.js';
import { recomputePromiseStatuses } from '../jobs/nightly.js';

export interface ImportActor {
  userId: string | null;
  username: string;
}

export interface ApplyImportInput {
  bytes: Uint8Array;
  filename: string;
  asOf: string;
  actor: ImportActor;
}

export interface StoredImportReport {
  totalRows: number;
  imported: number;
  dropped: number;
  skipped: number;
  new: number;
  lateDiscovery: number;
  aging: number;
  partPaid: number;
  anomalous: number;
  gone: number;
  warnings: number;
  errors: number;
  /** Payments inferred from the outstanding delta (prompt 11 item 2); absent
   *  in reports written before the field existed. */
  paymentsInferred?: number;
  /** Assignment outcomes by reason (A26); zeros until the runner has run. */
  assignment: Record<AssignmentReason, number>;
}

export function zeroAssignmentOutcomes(): Record<AssignmentReason, number> {
  return Object.fromEntries(ASSIGNMENT_REASONS.map((reason) => [reason, 0])) as Record<AssignmentReason, number>;
}

/** Noop replays read the stored json; a batch written before assignment ran
 *  carries no key and reads back as all-zero so the shape stays stable. */
export function withAssignmentOutcomes(stored: StoredImportReport | null, fallback: StoredImportReport): StoredImportReport {
  if (!stored) {
    return fallback;
  }
  return stored.assignment ? stored : { ...stored, assignment: zeroAssignmentOutcomes() };
}

export type ApplyImportOutcome =
  | { status: 'rejected'; abort: { code: string; message: string }; counts: StoredImportReport }
  | { status: 'noop'; batchId: string; report: StoredImportReport }
  | { status: 'imported' | 'replaced'; batchId: string; report: StoredImportReport };

export interface NewRowError {
  batchId: string;
  rowNo: number;
  loanId: string | null;
  sourceColumn: string;
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function rowErrorRows(
  batchId: string,
  errors: readonly RowIssue[],
  warnings: readonly RowIssue[]
): NewRowError[] {
  const toRow = (issue: RowIssue, severity: 'error' | 'warning'): NewRowError => ({
    batchId,
    rowNo: issue.rowNo,
    loanId: issue.loanId ?? null,
    sourceColumn: issue.column,
    code: issue.code,
    severity,
    message: issue.message
  });
  return [...errors.map((issue) => toRow(issue, 'error')), ...warnings.map((issue) => toRow(issue, 'warning'))];
}

function buildReport(
  plan: ImportPlan,
  parsed: { totalRows: number; rows: ImportLoan[]; dropped: number; skipped: number },
  warnings: number,
  errors: number,
  paymentsInferred = 0
): StoredImportReport {
  return {
    totalRows: parsed.totalRows,
    imported: parsed.rows.length,
    dropped: parsed.dropped,
    skipped: parsed.skipped,
    new: plan.counts.new,
    lateDiscovery: plan.counts.lateDiscovery,
    aging: plan.counts.aging,
    partPaid: plan.counts.partPaid,
    anomalous: plan.counts.anomalous,
    gone: plan.counts.gone,
    warnings,
    errors,
    paymentsInferred,
    assignment: zeroAssignmentOutcomes()
  };
}

function zeroReport(parsed: { totalRows: number; rows: ImportLoan[]; dropped: number; skipped: number }, warnings: number, errors: number): StoredImportReport {
  return {
    totalRows: parsed.totalRows,
    imported: parsed.rows.length,
    dropped: parsed.dropped,
    skipped: parsed.skipped,
    new: 0,
    lateDiscovery: 0,
    aging: 0,
    partPaid: 0,
    anomalous: 0,
    gone: 0,
    warnings,
    errors,
    assignment: zeroAssignmentOutcomes()
  };
}

export async function applyImport(input: ApplyImportInput): Promise<ApplyImportOutcome> {
  const db = getDb();
  const digest = sha256Hex(input.bytes);
  const branchRows = await db.select({ id: branches.id, name: branches.name }).from(branches);
  const parse = parseCsv(input.bytes, {
    branches: new Set(branchRows.map((row) => row.name.trim().toLowerCase()))
  });
  if (parse.abort) {
    const counts = zeroReport(parse, parse.warnings.length, parse.errors.length);
    await withTx(async (tx) => {
      await tx.insert(auditLog).values({
        actor: input.actor.username,
        action: 'import:abort',
        subject: null,
        detail: {
          asOf: input.asOf,
          sha256: digest.slice(0, 12),
          filename: input.filename,
          code: parse.abort!.code,
          message: parse.abort!.message
        }
      });
    });
    return { status: 'rejected', abort: parse.abort, counts };
  }

  const branchByName = new Map(branchRows.map((row) => [row.name.trim().toLowerCase(), row.id]));

  const outcome: ApplyImportOutcome = await withTx(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`import:${input.asOf}`}))`);

    const existing = await tx.select().from(importBatches).where(eq(importBatches.asOf, input.asOf));
    const sameBytes = existing.find((batch) => batch.fileSha256 === digest);
    if (sameBytes) {
      const previousReport = withAssignmentOutcomes(
        sameBytes.rowCountJson as StoredImportReport | null,
        zeroReport(parse, parse.warnings.length, parse.errors.length)
      );
      return { status: 'noop', batchId: sameBytes.id, report: previousReport };
    }

    const earlier = await tx
      .select({ asOf: importBatches.asOf })
      .from(importBatches)
      .where(lt(importBatches.asOf, input.asOf))
      .orderBy(desc(importBatches.asOf))
      .limit(1);
    const previousSnapshotDate = earlier[0]?.asOf ?? null;

    const previousSnapshotRows = previousSnapshotDate
      ? await tx
        .select({ loanId: loanSnapshots.loanId, dpd: loanSnapshots.dpd, outstanding: loanSnapshots.outstanding })
        .from(loanSnapshots)
        .where(eq(loanSnapshots.asOf, previousSnapshotDate))
      : [];
    const previousLoans = previousSnapshotRows.length
      ? await tx
        .select({ loanId: loans.loanId, dpd: loans.dpd, overdueAmount: loans.overdueAmount, status: loans.status })
        .from(loans)
        .where(inArray(loans.loanId, previousSnapshotRows.map((row) => row.loanId)))
      : [];
    const snapshotOutstanding = new Map(previousSnapshotRows.map((row) => [row.loanId, row.outstanding]));
    const previous = new Map(
      previousLoans
        .filter((row) => row.status === 'overdue')
        .map((loanRow): [string, { dpd: number; overdueAmount: number; outstanding: number; status: 'overdue' }] => [
          loanRow.loanId,
          {
            dpd: loanRow.dpd,
            overdueAmount: loanRow.overdueAmount,
            outstanding: snapshotOutstanding.get(loanRow.loanId) ?? 0,
            status: 'overdue'
          }
        ])
    );

    const territoryRows = (await tx.select({ pincode: territory.pincode, locality: territory.locality, officerId: territory.officerId }).from(territory)).map(
      (row): TerritoryRow => ({ pincode: row.pincode, locality: row.locality, officerId: row.officerId })
    );

    const plan = planImport({
      rows: parse.rows,
      warnings: parse.warnings,
      asOf: input.asOf,
      previous,
      previousCount: previousSnapshotRows.length,
      dropped: parse.dropped,
      skipped: parse.skipped,
      latestBatchDate: (await tx.select({ asOf: importBatches.asOf }).from(importBatches).orderBy(desc(importBatches.asOf)).limit(1))[0]?.asOf ?? null,
      territory: territoryRows
    });

    if (plan.abort) {
      await tx.insert(auditLog).values({
        actor: input.actor.username,
        action: 'import:abort',
        subject: null,
        detail: {
          asOf: input.asOf,
          sha256: digest.slice(0, 12),
          filename: input.filename,
          code: plan.abort.code,
          message: plan.abort.message
        }
      });
      return {
        status: 'rejected',
        abort: plan.abort,
        counts: zeroReport(parse, parse.warnings.length, parse.errors.length)
      };
    }

    const replacing = existing.length > 0;
    if (replacing) {
      await tx.delete(importRowErrors).where(inArray(importRowErrors.batchId, existing.map((batch) => batch.id)));
      await tx.delete(importBatches).where(inArray(importBatches.id, existing.map((batch) => batch.id)));
      await tx.delete(loanSnapshots).where(eq(loanSnapshots.asOf, input.asOf));
    }

    const officerByName = new Map(
      (await tx.select({ id: officers.id, name: officers.name }).from(officers).where(eq(officers.active, true))).map(
        (row) => [row.name.trim().toLowerCase(), row.id]
      )
    );

    for (const row of parse.rows) {
      const branchId = branchByName.get(row.branch.trim().toLowerCase());
      if (!branchId) {
        continue;
      }
      const homeOfficerId = row.officer ? (officerByName.get(row.officer.trim().toLowerCase()) ?? null) : null;
      await upsertLoan(tx, row, branchId, homeOfficerId);
      await tx.insert(loanSnapshots).values({
        asOf: input.asOf,
        loanId: row.loanId,
        branchId,
        officerId: homeOfficerId,
        dpd: row.dpd,
        bucket: dpdBucketFor(row.dpd),
        outstanding: row.outstanding
      });
    }

    if (plan.gone.length > 0) {
      const goneIds = plan.gone.map((entry) => entry.loanId);
      await tx.update(loans).set({ status: 'cleared' }).where(inArray(loans.loanId, goneIds));
      await tx
        .update(promises)
        .set({ status: 'kept', resolvedAt: new Date() })
        .where(and(inArray(promises.loanId, goneIds), eq(promises.status, 'open')));
      await tx.insert(auditLog).values(
        goneIds.map((loanId) => ({
          actor: input.actor.username,
          action: 'import:gone',
          subject: loanId,
          detail: { asOf: input.asOf, reason: 'absent_from_full_file' }
        }))
      );
    }

    // Payments inferred from the LMS delta (prompt 11 item 2): an
    // outstanding that fell against the previous snapshot is a payment, a
    // loan that vanished was paid off. Idempotent by construction — the
    // same-bytes noop path above returned before any write — and a same-as_of
    // replace recomputes: this as_of's inferred rows are deleted before the
    // fresh inference lands, all inside this transaction.
    const inferredPayments = inferPaymentsFromDelta({
      previous,
      rows: parse.rows,
      goneLoanIds: plan.gone.map((entry) => entry.loanId),
      asOf: input.asOf
    });
    if (replacing) {
      // A replace recomputes the delta for this as_of: the replaced file's
      // inferred rows die even when the fresh inference is empty.
      const range = istDayUtcRange(input.asOf);
      await tx
        .delete(payments)
        .where(and(eq(payments.source, 'lms_delta'), gte(payments.postedAt, range.startUtc), lt(payments.postedAt, range.endUtc)));
    }
    if (inferredPayments.length > 0) {
      await tx.insert(payments).values(
        inferredPayments.map((payment) => ({
          loanId: payment.loanId,
          amount: payment.amountPaise,
          postedAt: istNoonUtc(payment.postedOnIst),
          source: 'lms_delta' as const
        }))
      );
    }

    const report = buildReport(plan, parse, parse.warnings.length, parse.errors.length, inferredPayments.length);
    const inserted = await tx
      .insert(importBatches)
      .values({
        asOf: input.asOf,
        fileSha256: digest,
        filename: input.filename,
        status: replacing ? 'replaced' : 'imported',
        rowCountJson: report,
        createdBy: input.actor.userId
      })
      .returning({ id: importBatches.id });
    const batchId = inserted[0]!.id;

    const rowErrors = rowErrorRows(batchId, parse.errors, parse.warnings);
    if (rowErrors.length > 0) {
      await tx.insert(importRowErrors).values(rowErrors);
    }

    await tx.insert(auditLog).values({
      actor: input.actor.username,
      action: 'import:apply',
      subject: batchId,
      detail: {
        asOf: input.asOf,
        sha256: digest.slice(0, 12),
        filename: input.filename,
        status: replacing ? 'replaced' : 'imported',
        counts: report
      }
    });

    return { status: replacing ? 'replaced' : 'imported', batchId, report };
  });

  if (outcome.status === 'noop' || outcome.status === 'rejected') {
    return outcome;
  }

  // Imported or replaced: rerun assignment after the import has committed
  // (SPEC 11, A26). runAssignment carries its own transaction and the
  // advisory lock; a failure here never un-saves the import, it is audited
  // and the report stays without fresh outcomes.
  try {
    const assignment = await runAssignment(input.asOf, input.actor.username);
    const report = { ...outcome.report, assignment: assignment.outcomesByReason };
    await persistReport(outcome.batchId, report);
    // Fresh payments just landed: re-derive the promise statuses now rather
    // than waiting for the nightly cron (prompt 11 item 3). Non-fatal — the
    // cron recomputes anyway; a failure is audited, never fails the import.
    try {
      await recomputePromiseStatuses();
    } catch (err) {
      await withTx(async (tx) => {
        await tx.insert(auditLog).values({
          actor: input.actor.username,
          action: 'promise_nightly:failed',
          subject: outcome.batchId,
          detail: { asOf: input.asOf, message: err instanceof Error ? err.message : String(err) }
        });
      });
    }
    return { status: outcome.status, batchId: outcome.batchId, report };
  } catch (err) {
    await auditAssignmentFailure(input, outcome, err);
    return outcome;
  }
}

async function persistReport(batchId: string, report: StoredImportReport): Promise<void> {
  await withTx(async (tx) => {
    await tx.update(importBatches).set({ rowCountJson: report }).where(eq(importBatches.id, batchId));
  });
}

async function auditAssignmentFailure(
  input: ApplyImportInput,
  outcome: Extract<ApplyImportOutcome, { batchId: string }>,
  err: unknown
): Promise<void> {
  try {
    await withTx(async (tx) => {
      await tx.insert(auditLog).values({
        actor: input.actor.username,
        action: 'assignment:failed',
        subject: outcome.batchId ?? null,
        detail: { asOf: input.asOf, message: err instanceof Error ? err.message : String(err) }
      });
    });
  } catch {
    // The import itself is committed; do not mask its success because the
    // failure audit could not be stored either.
  }
}

async function upsertLoan(tx: PooledTx, row: ImportLoan, branchId: string, homeOfficerId: string | null) {
  const values = {
    loanId: row.loanId,
    borrowerName: row.borrowerName,
    businessName: row.businessName ?? null,
    mobile: row.mobile ?? null,
    altMobile: row.altMobile ?? null,
    address: row.address ?? null,
    pincode: row.pincode,
    locality: row.locality ?? null,
    branchId,
    product: row.product ?? null,
    outstanding: row.outstanding,
    overdueAmount: row.overdueAmount ?? 0,
    emiAmount: row.emiAmount ?? null,
    dpd: row.dpd,
    bucket: dpdBucketFor(row.dpd),
    homeOfficerId,
    status: 'overdue' as const
  };
  // A25: on a continuing loan the assignment runner owns home_officer_id —
  // overwriting it with the CSV's bookkeeping Officer column on every import
  // would make the runner see current != home and reroute through the
  // leave-cover story. The CSV officer still seeds home on first insert.
  const { homeOfficerId: _insertOnlyHome, ...updatable } = values;
  void _insertOnlyHome;
  await tx
    .insert(loans)
    .values(values)
    .onConflictDoUpdate({ target: loans.loanId, set: updatable });
}
