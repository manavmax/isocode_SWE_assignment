import { eq, inArray, ne, sql } from 'drizzle-orm';
import { withTx } from '../db.js';
import {
  assignmentLog,
  auditLog,
  contactEvents,
  loans,
  officerAbsences,
  officers,
  promises,
  territory
} from '../db/schema.js';
import { planAssignment } from '../../shared/assignment.js';
import type {
  AssignmentContact,
  AssignmentInput,
  AssignmentLoan,
  AssignmentOfficer,
  AssignmentPromise,
  AssignmentReason,
  AssignmentTerritory
} from '../../shared/assignment.js';
import type { PromiseStatus } from '../../shared/types.js';

/**
 * Thin runner for the planner (SPEC 10). Own transaction, company-wide
 * advisory lock so two concurrent imports never interleave loan moves (A26).
 * The broken-promise input comes from the promise table (A22); contact
 * events feed the return-of-leave revert rule (SPEC 10.6).
 */
export interface RunAssignmentResult {
  outcomesByReason: Record<AssignmentReason, number>;
  /** Loans whose stored row this run actually rewrote (excluding no-ops). */
  changedLoans: number;
  /** Rows written to assignment_log: one per officer change, with a reason. */
  logRows: number;
  alertsRaised: number;
}

/** Revert logic only ever needs the leave windows behind current != home
 *  loans; 120 days backstop covers a stale leave that the runner could not
 *  process while it was down (the 3+-day working pattern keeps that short). */
const CONTACT_BACKSTOP_DAYS = 120;

function dayPart(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function runAssignment(runDate: string, actor: string): Promise<RunAssignmentResult> {
  return withTx(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assignment:run`}))`);

    const loanRows = await tx
      .select({
        loanId: loans.loanId,
        borrowerName: loans.borrowerName,
        branchId: loans.branchId,
        pincode: loans.pincode,
        locality: loans.locality,
        dpd: loans.dpd,
        outstanding: loans.outstanding,
        mobile: loans.mobile,
        altMobile: loans.altMobile,
        address: loans.address,
        assignedOfficerId: loans.assignedOfficerId,
        homeOfficerId: loans.homeOfficerId,
        status: loans.status
      })
      .from(loans)
      .where(ne(loans.status, 'cleared'));

    const officerRows = await tx
      .select({ id: officers.id, branchId: officers.branchId, active: officers.active, capacityPoints: officers.capacityPoints })
      .from(officers);
    const territoryRows = await tx
      .select({ branchId: territory.branchId, pincode: territory.pincode, locality: territory.locality, officerId: territory.officerId, rank: territory.rank })
      .from(territory);
    const absenceRows = await tx
      .select({ officerId: officerAbsences.officerId, fromDate: officerAbsences.fromDate, toDate: officerAbsences.toDate, coverOfficerId: officerAbsences.coverOfficerId })
      .from(officerAbsences);

    // Broken-promise input (A22): promised_date in the 14-day window makes the
    // row interesting for weights; every open promise matters for the return
    // revert rule, whatever its promised_date.
    const promiseFloor = addDays(runDate, -14);
    const promiseRows = await tx
      .select({ loanId: promises.loanId, promisedDate: promises.promisedDate, status: promises.status, createdAt: promises.createdAt })
      .from(promises)
      .where(sql`${promises.status} = 'open' or ${promises.promisedDate} >= ${promiseFloor}`);
    const assignmentPromises: AssignmentPromise[] = promiseRows.map((row) => ({
      loanId: row.loanId,
      promisedDate: row.promisedDate,
      status: row.status as PromiseStatus,
      createdOn: dayPart(row.createdAt)
    }));

    // Contacts only matter for loans sitting with a cover officer (current !=
    // home): the plan looks for touches inside their ended-leave windows.
    const coverLoanIds = loanRows
      .filter((row) => row.assignedOfficerId !== null && row.homeOfficerId !== null && row.assignedOfficerId !== row.homeOfficerId)
      .map((row) => row.loanId);
    let assignmentContacts: AssignmentContact[] = [];
    if (coverLoanIds.length > 0) {
      const contactFloor = addDays(runDate, -CONTACT_BACKSTOP_DAYS);
      const contactRows = await tx
        .select({ loanId: contactEvents.loanId, attemptedAtIst: contactEvents.attemptedAtIst })
        .from(contactEvents)
        .where(inArray(contactEvents.loanId, coverLoanIds));
      assignmentContacts = contactRows.map((row) => ({ loanId: row.loanId, attemptedAt: dayPart(row.attemptedAtIst) }));
      // Backstop filter applied client-side so the loaded set stays inside the
      // window the plan can express as dates.
      assignmentContacts = assignmentContacts.filter((c) => c.attemptedAt >= contactFloor);
    }

    const input: AssignmentInput = {
      runDate,
      loans: loanRows.map((row): AssignmentLoan => ({ ...row })),
      officers: officerRows.map((row): AssignmentOfficer => ({ ...row })),
      territory: territoryRows.map((row): AssignmentTerritory => ({ ...row })),
      absences: absenceRows.map((row) => ({ ...row })),
      promises: assignmentPromises,
      contacts: assignmentContacts
    };
    const plan = planAssignment(input);

    let changedLoans = 0;
    const storedById = new Map(loanRows.map((row) => [row.loanId, row]));
    for (const decision of plan.decisions) {
      const stored = storedById.get(decision.loanId);
      if (!stored) {
        continue;
      }
      const differs =
        stored.assignedOfficerId !== decision.toOfficerId ||
        stored.homeOfficerId !== decision.homeOfficerId ||
        stored.status !== decision.status;
      if (!differs) {
        continue;
      }
      await tx
        .update(loans)
        .set({ assignedOfficerId: decision.toOfficerId, homeOfficerId: decision.homeOfficerId, status: decision.status })
        .where(eq(loans.loanId, decision.loanId));
      changedLoans += 1;
    }

    if (plan.logEntries.length > 0) {
      await tx.insert(assignmentLog).values(
        plan.logEntries.map((entry) => ({
          loanId: entry.loanId,
          runDate: entry.runDate,
          fromOfficer: entry.fromOfficerId,
          toOfficer: entry.toOfficerId,
          reason: entry.reason
        }))
      );
    }

    await tx.insert(auditLog).values({
      actor,
      action: 'assignment:run',
      subject: runDate,
      detail: {
        outcomesByReason: plan.outcomesByReason,
        changedLoans,
        logRows: plan.logEntries.length,
        alerts: plan.alerts.length
      }
    });

    return {
      outcomesByReason: plan.outcomesByReason,
      changedLoans,
      logRows: plan.logEntries.length,
      alertsRaised: plan.alerts.length
    };
  });
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
