/**
 * assign:check — local-only integration check for the assignment runner (SPEC 10).
 *
 * NOT part of CI: it needs a real DATABASE_URL (local .env), writes to that
 * database through the same code paths the server uses (applyImport ->
 * runAssignment), and then removes every row it created. It prints which
 * database it is touching before it starts. Never point it at a database you
 * care about.
 *
 * Run: pnpm assign:check
 *
 * Cleanup ownership rules — it deletes only rows it can prove it created:
 * - branch:    the id returned at insert time is deleted; a branch with the
 *              same name that already exists is reused and never deleted
 *              (import:check's rule)
 * - officer / territory / absence: only this script's 'assign-check-' prefixed
 *              officers (tracked ids at cleanup; crashed-run leftovers by name
 *              prefix at pre-start) — a foreign officer on the branch refuses
 *              the run instead of being touched
 * - loan:      only LN-53001..53005 whose borrower names match this script's
 *              marker set and whose branch is the script's own; any other row
 *              under these ids refuses the run
 * - promise / contact_event / assignment_log / loan_snapshot /
 *              import_row_error / import_batch / audit_log: only rows tied to
 *              this run's ids, the run date, or the 'assign-check' actor.
 *
 * Refusals (the run must not create, read or destroy anything else): a batch
 * dated after the run date, ANY earlier batch (a full-file import at the run
 * date would mark every loan absent from its file as 'gone'), a batch at the
 * run date whose bytes are not this script's, foreign rows under the script's
 * ids, or an app_user linked to the script's branch or officers.
 */
import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, like, lt, or, sql } from 'drizzle-orm';
import { closePool, getDb } from '../src/server/db.js';
import {
  assignmentLog,
  auditLog,
  branches,
  contactEvents,
  importBatches,
  importRowErrors,
  loanSnapshots,
  loans,
  officerAbsences,
  officers,
  promises,
  territory,
  users
} from '../src/server/db/schema.js';
import { runAssignment } from '../src/server/assignment/runAssignment.js';
import { applyImport, type StoredImportReport } from '../src/server/import/applyImport.js';
import { ASSIGNMENT_REASONS, workingDays } from '../src/shared/assignment.js';
import type { AssignmentReason } from '../src/shared/assignment.js';
import { dpdBucketFor } from '../src/shared/bucket.js';

const RUN_DATE = '2030-01-16';
const BRANCH_CODE = 'ASGN-CHECK';
const BRANCH_NAME = 'Assign-Check';
const ACTOR = 'assign-check';
/** One officer per planner story: locality row, generic pincode row, prefix tier, cover. */
const OFFICER_NAMES = ['assign-check-loc', 'assign-check-gen', 'assign-check-tier', 'assign-check-cover'] as const;
const LOAN_IDS = ['LN-53001', 'LN-53002', 'LN-53003', 'LN-53004', 'LN-53005'] as const;
const MARKER_BORROWERS = new Set([
  'Fix Locality Borrower',
  'Fix Prefix Borrower',
  'Fix Unmapped Borrower',
  'Fix Tier2 Borrower',
  'Fix Leave Borrower'
]);
const AUDIT_ACTIONS = ['import:apply', 'import:abort', 'import:gone', 'assignment:run', 'assignment:failed'];

/** Same header/aliases as data/sample_overdue.csv; branch must exist first. */
const CSV_TEXT = [
  'Loan ID,Borrower,Business Name,POS,DPD,Pin Code,Branch,Locality,Promise Date,Officer,Mobile,Last Due Date',
  'LN-53001,Fix Locality Borrower,,"Rs. 1,10,000/-",10,456001,Assign-Check,Vijay,-,,9750000001,01-Dec-25',
  'LN-53002,Fix Prefix Borrower,,"Rs. 2,30,000/-",10,456017,Assign-Check,,-,,9750000002,01-Dec-25',
  'LN-53003,Fix Unmapped Borrower,,"Rs. 3,40,000/-",10,460001,Assign-Check,,-,,9750000003,01-Dec-25',
  'LN-53004,Fix Tier2 Borrower,,"Rs. 4,60,000/-",10,456005,Assign-Check,,-,,9750000004,01-Dec-25'
].join('\n');

const CSV_BYTES = new TextEncoder().encode(CSV_TEXT);
// Phase-4 payload: identical except LN-53001's DPD 10 -> 11, so the replace
// demonstrably rewrites a continuing loan. Deterministic bytes, so the sha256
// is a stable ownership marker; the pattern occurs only in LN-53001's row.
const VARIANT_TEXT = CSV_TEXT.replace(',10,456001,', ',11,456001,');
const VARIANT_BYTES = new TextEncoder().encode(VARIANT_TEXT);

const FIXTURE_HASHES = new Set([sha256Hex(CSV_BYTES), sha256Hex(VARIANT_BYTES)]);

type Db = ReturnType<typeof getDb>;

const state = {
  branchCreatedId: null as string | null,
  branchExisted: false,
  officerIds: [] as string[],
  batchIds: [] as string[],
  officerIdByName: new Map<string, string>(),
  officerNameById: new Map<string, string>()
};

failUnless(process.env.DATABASE_URL, 'DATABASE_URL is not set (run via pnpm assign:check)');

const dbTarget = new URL(process.env.DATABASE_URL);
console.log(`assign-check: touching database ${dbTarget.host}${dbTarget.pathname} (DATABASE_URL from local .env)`);
console.log('assign-check: local-only check, never run in CI; writes demo loans/officers and removes them at the end');

let database: Db | null = null;

try {
  database = getDb();
  await run(database);
} catch (err) {
  console.error(`assign-check FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (database) {
    try {
      await cleanup(database);
    } catch (cleanupErr) {
      console.error(`assign-check cleanup also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      process.exitCode = 1;
    }
  }
  await closePool().catch(() => undefined);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * contact_event is append-only by trigger (A14, drizzle/0001): any UPDATE or
 * DELETE raises and the transaction aborts. Only fix/seed scripts own the
 * bypass precedent (A17), and this is its tightest form: disable exactly the
 * append-only trigger, run the id-scoped delete, and re-enable it in a
 * `finally` so a failed delete can never leave the gate off. FK-constraint
 * triggers and every other trigger are never touched, so the window doesn't
 * weaken referential integrity.
 */
async function deleteScriptContacts(db: Db, loanIds: readonly string[]): Promise<{ id: string }[]> {
  await db.execute(sql`alter table contact_event disable trigger contact_event_append_only`);
  try {
    return await db
      .delete(contactEvents)
      .where(inArray(contactEvents.loanId, [...loanIds]))
      .returning({ id: contactEvents.id });
  } finally {
    await db.execute(sql`alter table contact_event enable trigger contact_event_append_only`);
  }
}

function outcomesWith(partial: Partial<Record<AssignmentReason, number>>): Record<AssignmentReason, number> {
  const expected = Object.fromEntries(ASSIGNMENT_REASONS.map((reason) => [reason, 0])) as Record<AssignmentReason, number>;
  for (const [reason, value] of Object.entries(partial)) {
    expected[reason as AssignmentReason] = value ?? 0;
  }
  return expected;
}

function expectOutcomes(actual: Record<AssignmentReason, number>, expected: Record<AssignmentReason, number>, label: string): void {
  const wrong = ASSIGNMENT_REASONS.filter((reason) => actual[reason] !== expected[reason]).map(
    (reason) => `${reason}: got ${actual[reason]}, expected ${expected[reason]}`
  );
  failUnless(wrong.length === 0, `${label}: unexpected assignment outcomes — ${wrong.join('; ')}`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function printReport(report: StoredImportReport): void {
  // Nested maps (assignment outcomes by reason) print one flat entry each:
  // assignment.new_assigned=3 ... so the console output stays greppable.
  const flat: string[] = [];
  for (const [key, value] of Object.entries(report)) {
    if (value !== null && typeof value === 'object') {
      for (const [sub, subValue] of Object.entries(value as Record<string, number>)) {
        flat.push(`${key}.${sub}=${subValue}`);
      }
    } else {
      flat.push(`${key}=${String(value)}`);
    }
  }
  console.log(`           counts: ${flat.join(' ')}`);
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function run(database: Db): Promise<void> {
  // --- pre-start: refuse foreign data, then remove crashed-run leftovers ----
  const futureBatches = await database
    .select({ asOf: importBatches.asOf })
    .from(importBatches)
    .where(gt(importBatches.asOf, RUN_DATE));
  failUnless(
    futureBatches.length === 0,
    `refusing to run: ${futureBatches.length} batch(es) dated after the run date ${RUN_DATE} exist ` +
      `(${futureBatches.map((b) => b.asOf).join(', ')}); assign:check must not touch a database with real post-dated imports`
  );

  const earlierBatches = await database
    .select({ asOf: importBatches.asOf })
    .from(importBatches)
    .where(lt(importBatches.asOf, RUN_DATE));
  failUnless(
    earlierBatches.length === 0,
    `refusing to run: ${earlierBatches.length} batch(es) dated before the run date exist ` +
      `(${earlierBatches.map((b) => b.asOf).join(', ')}); a full-file import at ${RUN_DATE} marks every loan ` +
      `absent from its file as gone (SPEC 11), so assign:check must not run against databases with earlier imports`
  );

  const batchesAtRunDate = await database
    .select({ id: importBatches.id, sha256: importBatches.fileSha256 })
    .from(importBatches)
    .where(eq(importBatches.asOf, RUN_DATE));
  for (const batch of batchesAtRunDate) {
    if (FIXTURE_HASHES.has(batch.sha256)) {
      await database.delete(importRowErrors).where(eq(importRowErrors.batchId, batch.id));
      await database.delete(importBatches).where(eq(importBatches.id, batch.id));
      console.log(`pre-start: removed leftover test batch ${batch.id} (sha256 ${batch.sha256.slice(0, 12)}) from a crashed run`);
    } else {
      failUnless(
        false,
        `refusing to run: a non-test batch exists at the run date ${RUN_DATE} (sha256 ${batch.sha256.slice(0, 12)}); ` +
          `only assign:check's own fixture batches are ever removed`
      );
    }
  }

  // assignment_log rows at the run date come from assign:check's runner calls
  // (runDate = as_of = RUN_DATE, A26); a crashed run can only have left them here.
  const leftoverLogRows = await database
    .delete(assignmentLog)
    .where(eq(assignmentLog.runDate, RUN_DATE))
    .returning({ loanId: assignmentLog.loanId });
  if (leftoverLogRows.length > 0) {
    console.log(`pre-start: removed ${leftoverLogRows.length} assignment_log row(s) at ${RUN_DATE} from a crashed run`);
  }

  // Every loan_snapshot row at the run date is script-created: the importer
  // writes snapshots only inside its own batch transaction, and batches at the
  // run date are refused unless they carry this script's hashes.
  const leftoverSnapshots = await database
    .delete(loanSnapshots)
    .where(eq(loanSnapshots.asOf, RUN_DATE))
    .returning({ loanId: loanSnapshots.loanId });
  if (leftoverSnapshots.length > 0) {
    console.log(`pre-start: removed ${leftoverSnapshots.length} loan_snapshot row(s) at ${RUN_DATE} from a crashed run`);
  }

  // Branch: reuse an existing one (never deleted at cleanup, import:check's
  // rule) and prove it is script-owned before touching anything on it.
  const branchRow = (
    await database
      .select({ id: branches.id })
      .from(branches)
      .where(eq(sql`lower(${branches.name})`, BRANCH_NAME.toLowerCase()))
      .limit(1)
  )[0];
  if (branchRow) {
    state.branchExisted = true;
  }

  // Loans under the script's ids BEFORE the branch checks: a failed cleanup
  // leaves them behind, and they are the branch's rows, so they must be gone
  // before the branch-reference assertions below. They can only be crashed-run
  // leftovers (marker borrower + script branch). Anything else refuses the
  // run — the ids must never collide with real data.
  const existingScriptLoans = await database
    .select({
      loanId: loans.loanId,
      borrowerName: loans.borrowerName,
      branchId: loans.branchId,
      status: loans.status
    })
    .from(loans)
    .where(inArray(loans.loanId, [...LOAN_IDS]));
  for (const loan of existingScriptLoans) {
    failUnless(
      MARKER_BORROWERS.has(loan.borrowerName) && branchRow !== undefined && loan.branchId === branchRow.id,
      `refusing to run: loan ${loan.loanId} exists (borrower '${loan.borrowerName}') without this script's markers; ` +
        `loan ids LN-53001..53005 are reserved for assign:check`
    );
  }
  const foreignSnapshotsForIds = await database
    .select({ loanId: loanSnapshots.loanId, asOf: loanSnapshots.asOf })
    .from(loanSnapshots)
    .where(and(inArray(loanSnapshots.loanId, [...LOAN_IDS]), lt(loanSnapshots.asOf, RUN_DATE)));
  failUnless(
    foreignSnapshotsForIds.length === 0,
    `refusing to run: loan_snapshot rows for LN-53001..53005 exist before ${RUN_DATE} ` +
      `(${foreignSnapshotsForIds.map((s) => `${s.loanId}@${s.asOf}`).join(', ')}); the script only writes snapshots at its run date`
  );
  if (existingScriptLoans.length > 0) {
    const leftoverIds = existingScriptLoans.map((loan) => loan.loanId);
    // Children first: assignment_log is gone (date delete above); contacts
    // and promises still reference the loans.
    const removedContacts = await deleteScriptContacts(database, leftoverIds);
    const removedPromises = await database
      .delete(promises)
      .where(inArray(promises.loanId, leftoverIds))
      .returning({ id: promises.id });
    const removedLoans = await database
      .delete(loans)
      .where(inArray(loans.loanId, leftoverIds))
      .returning({ loanId: loans.loanId });
    console.log(
      `pre-start: removed ${removedLoans.length} leftover loan(s) ` +
        `(with ${removedPromises.length} promise row(s) and ${removedContacts.length} contact_event row(s)) from a crashed run`
    );
  }

  if (branchRow) {
    const appUsersOnBranch = await database
      .select({ username: users.username })
      .from(users)
      .where(eq(users.branchId, branchRow.id));
    failUnless(
      appUsersOnBranch.length === 0,
      `refusing to run: branch '${BRANCH_NAME}' holds app_user row(s) (${appUsersOnBranch.map((u) => u.username).join(', ')}); ` +
        `the script never creates users, so this branch is not its leftover`
    );

    const nameLeftovers = await database
      .select({ id: officers.id, name: officers.name, branchId: officers.branchId })
      .from(officers)
      .where(like(officers.name, `${ACTOR}-%`));
    for (const officer of nameLeftovers) {
      failUnless(
        officer.branchId === branchRow.id,
        `refusing to run: an officer named '${officer.name}' exists outside branch '${BRANCH_NAME}'; the script's name prefix is not unique in this database`
      );
    }
    const leftoverOfficers = nameLeftovers;
    const otherOfficers = (
      await database.select({ id: officers.id, name: officers.name }).from(officers).where(eq(officers.branchId, branchRow.id))
    ).filter((officer) => !OFFICER_NAMES.some((name) => name === officer.name));
    failUnless(
      otherOfficers.length === 0,
      `refusing to run: branch '${BRANCH_NAME}' holds officer(s) this script did not create (${otherOfficers.map((o) => o.name).join(', ')})`
    );

    const officerIds = leftoverOfficers.map((o) => o.id);
    const linkedUserRows = officerIds.length > 0
      ? await database.select({ username: users.username }).from(users).where(inArray(users.officerId, officerIds))
      : [];
    failUnless(
      linkedUserRows.length === 0,
      `refusing to run: app_user row(s) ${linkedUserRows.map((u) => u.username).join(', ')} are linked to the script's officers`
    );

    if (officerIds.length > 0) {
      // Crash leftovers: absences and territory reference the officers, so
      // children go first. Cover FK included: our only absence row covers
      // O-LOC with assign-check-cover.
      const removedAbsences = await database
        .delete(officerAbsences)
        .where(or(inArray(officerAbsences.officerId, officerIds), inArray(officerAbsences.coverOfficerId, officerIds)))
        .returning({ id: officerAbsences.id });
      const removedTerritory = await database
        .delete(territory)
        .where(inArray(territory.officerId, officerIds))
        .returning({ id: territory.id });
      const removedOfficerRows = await database
        .delete(officers)
        .where(inArray(officers.id, officerIds))
        .returning({ id: officers.id });
      console.log(
        `pre-start: removed ${removedOfficerRows.length} leftover officer(s) ` +
          `(with ${removedTerritory.length} territory and ${removedAbsences.length} absence row(s)) from a crashed run`
      );
    }

    const loansOnBranch = (await database.execute(
      sql`select count(*) as n from loan where branch_id = ${branchRow.id}`
    )).rows as { n: number }[];
    failUnless(
      Number(loansOnBranch[0]?.n ?? 0) === 0,
      `refusing to run: branch '${BRANCH_NAME}' holds loan row(s) after leftover cleanup; the script does not create loans on any other branch`
    );
    const snapshotsOnBranch = (await database.execute(
      sql`select count(*) as n from loan_snapshot where branch_id = ${branchRow.id}`
    )).rows as { n: number }[];
    failUnless(
      Number(snapshotsOnBranch[0]?.n ?? 0) === 0,
      `refusing to run: branch '${BRANCH_NAME}' has loan_snapshot row(s); the script only writes snapshots at ${RUN_DATE} alongside its batches`
    );
  }

  const leftoverAudit = await database
    .delete(auditLog)
    .where(
      and(
        eq(auditLog.actor, ACTOR),
        inArray(auditLog.action, AUDIT_ACTIONS)
      )
    )
    .returning({ id: auditLog.id });
  if (leftoverAudit.length > 0) {
    console.log(`pre-start: removed ${leftoverAudit.length} audit_log row(s) with actor '${ACTOR}' from a crashed run`);
  }

  // --- setup: branch (tracked id), officers, minimal territory map ---------
  let branchId: string;
  if (branchRow) {
    branchId = branchRow.id;
    console.log(`pre-start: branch '${BRANCH_NAME}' already exists; reusing it and never deleting it (import:check's rule)`);
  } else {
    const codeCollision = (
      await database.select({ id: branches.id }).from(branches).where(eq(branches.code, BRANCH_CODE)).limit(1)
    )[0];
    failUnless(!codeCollision, `refusing to run: a branch with code '${BRANCH_CODE}' already exists under another name`);
    const insertedBranch = await database
      .insert(branches)
      .values({ code: BRANCH_CODE, name: BRANCH_NAME })
      .returning({ id: branches.id });
    branchId = insertedBranch[0]!.id;
    state.branchCreatedId = branchId;
  }

  const insertedOfficers = await database
    .insert(officers)
    .values(OFFICER_NAMES.map((name) => ({ name, branchId, active: true, capacityPoints: 30 })))
    .returning({ id: officers.id, name: officers.name });
  failUnless(insertedOfficers.length === OFFICER_NAMES.length, `setup: expected ${OFFICER_NAMES.length} officers inserted`);
  for (const officer of insertedOfficers) {
    state.officerIds.push(officer.id);
    state.officerIdByName.set(officer.name, officer.id);
    state.officerNameById.set(officer.id, officer.name);
  }
  const officerId = (suffix: 'loc' | 'gen' | 'tier' | 'cover'): string =>
    state.officerIdByName.get(`assign-check-${suffix}`)!;

  // Minimal territory map: each officer owns a distinct rule on purpose —
  // 456001+Vijay is the exact locality row, 456005 is a generic pincode row,
  // 456013 is what a 456017 loan falls back to through the prefix tier. No
  // two officers ever tie here: officer ids are random uuids, so a tie would
  // settle nondeterministically across runs.
  await database.insert(territory).values([
    { branchId, pincode: '456001', locality: 'Vijay', officerId: officerId('loc'), rank: 1 },
    { branchId, pincode: '456005', locality: null, officerId: officerId('gen'), rank: 1 },
    { branchId, pincode: '456013', locality: null, officerId: officerId('tier'), rank: 1 }
  ]);

  // --- helpers --------------------------------------------------------------
  const logRowsAt = async (): Promise<{ loanId: string; fromName: string; toName: string; reason: string }[]> => {
    const rows = await database
      .select({ loanId: assignmentLog.loanId, fromOfficer: assignmentLog.fromOfficer, toOfficer: assignmentLog.toOfficer, reason: assignmentLog.reason })
      .from(assignmentLog)
      .where(eq(assignmentLog.runDate, RUN_DATE));
    return rows.map((row) => ({
      loanId: row.loanId,
      fromName: row.fromOfficer === null ? '(new)' : state.officerNameById.get(row.fromOfficer) ?? row.fromOfficer,
      toName: row.toOfficer === null ? '(queue)' : state.officerNameById.get(row.toOfficer) ?? row.toOfficer,
      reason: row.reason
    }));
  };
  const loanRow = async (loanId: string): Promise<typeof loans.$inferSelect> => {
    const rows = await database.select().from(loans).where(eq(loans.loanId, loanId)).limit(1);
    failUnless(rows.length === 1, `expected loan ${loanId} to exist`);
    return rows[0]!;
  };
  const batchCountAtRunDate = async (): Promise<number> =>
    (await database.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.asOf, RUN_DATE))).length;

  // --- phases ----------------------------------------------------------------
  console.log('');
  console.log('phase 1/6  fresh import      : territory beats nothing, prefix fallback, queue for unmapped');

  const first = await applyImport({
    bytes: CSV_BYTES,
    filename: 'assign-check.csv',
    asOf: RUN_DATE,
    actor: { userId: null, username: ACTOR }
  });
  failUnless(first.status === 'imported' && 'batchId' in first && first.batchId !== undefined, `phase 1: expected imported, got ${first.status}`);
  state.batchIds.push(first.batchId!);
  failUnless(first.status === 'imported' && first.report.imported === 4 && first.report.errors === 0, `phase 1: expected 4 imported / 0 dropped, got ${JSON.stringify(first.report)}`);
  failUnless(first.report.lateDiscovery === 0, `phase 1: expected lateDiscovery=0 (no earlier batch exists), got ${first.report.lateDiscovery}`);
  failUnless(
    first.report.warnings === 0,
    `phase 1: expected no parse-level warnings (mobiles and pincodes are valid; planImport's territory warnings stay plan-level and must not reach the report), got ${first.report.warnings}`
  );

  // The wired runner ran after the commit (SPEC 11 + A26). Its outcomes live
  // on the report, and its log rows live in the database.
  expectOutcomes(
    first.report.assignment,
    outcomesWith({ new_assigned: 3, queue_unmapped: 1 }),
    'phase 1'
  );
  const firstLogs = await logRowsAt();
  failUnless(firstLogs.length === 3, `phase 1: expected 3 assignment_log rows (LN-53003 queues from no officer, so no row: A27), got ${firstLogs.length}`);
  const toOfficerOf = new Map(firstLogs.map((row) => [row.loanId, row]));
  failUnless(toOfficerOf.get('LN-53003') === undefined, 'phase 1: a queued-from-empty loan must not log a row (A27)');
  const loanName = (id: string | null): string => id === null ? '(none)' : state.officerNameById.get(id) ?? id;
  const loan1 = await loanRow('LN-53001');
  const loan2 = await loanRow('LN-53002');
  const loan3 = await loanRow('LN-53003');
  const loan4 = await loanRow('LN-53004');
  failUnless(
    loan1.assignedOfficerId === officerId('loc') && loan1.homeOfficerId === officerId('loc'),
    `phase 1: LN-53001 must land on the Vijay locality-row officer (got assigned=${loanName(loan1.assignedOfficerId)}, home=${loanName(loan1.homeOfficerId)})`
  );
  failUnless(
    loan2.assignedOfficerId === officerId('tier') && loan2.homeOfficerId === officerId('tier'),
    `phase 1: LN-53002 must fall back to the 45601x prefix tier (got assigned=${loanName(loan2.assignedOfficerId)}, home=${loanName(loan2.homeOfficerId)})`
  );
  failUnless(
    loan4.assignedOfficerId === officerId('gen') && loan4.homeOfficerId === officerId('gen'),
    `phase 1: LN-53004 must take the 456005 generic pincode row (got assigned=${loanName(loan4.assignedOfficerId)}, home=${loanName(loan4.homeOfficerId)})`
  );
  failUnless(
    loan3.status === 'queue' && loan3.assignedOfficerId === null && loan3.homeOfficerId === null,
    `phase 1: LN-53003 (pincode 460001, no territory) must sit in the branch-manager queue (got status=${loan3.status}, assigned=${loanName(loan3.assignedOfficerId)})`
  );
  failUnless(toOfficerOf.get('LN-53001')?.toName === 'assign-check-loc', 'phase 1: LN-53001 log row must name the locality officer');
  failUnless(toOfficerOf.get('LN-53002')?.toName === 'assign-check-tier', 'phase 1: LN-53002 log row must name the tier officer');
  failUnless(toOfficerOf.get('LN-53004')?.toName === 'assign-check-gen', 'phase 1: LN-53004 log row must name the generic officer');
  failUnless(firstLogs.every((row) => row.reason === 'new_assigned' && row.fromName === '(new)'), 'phase 1: first assignments log from (new) with reason new_assigned');
  printReport(first.report);
  console.log('           LN-53001 -> assign-check-loc (Vijay locality row beats the pincode row)');
  console.log('           LN-53002 -> assign-check-tier (456017 has no row; prefix tier 45601x)');
  console.log('           LN-53004 -> assign-check-gen (456005 has a generic pincode row; no locality row)');
  console.log('           LN-53003 -> queue (460001 unmapped; log row suppressed: A27)');

  console.log('phase 2/6  leave + broken promise -> direct runAssignment call covers cover-officer routing');

  const leave = { fromDate: '2030-01-09', toDate: '2030-01-23' };
  failUnless(
    workingDays(leave.fromDate, leave.toDate) >= 3,
    'phase 2: the absence must span at least 3 working days or the reassignment rule would badge-only'
  );
  const insertedAbsence = await database
    .insert(officerAbsences)
    .values({ officerId: officerId('loc'), ...leave, coverOfficerId: officerId('cover') })
    .returning({ id: officerAbsences.id });
  void insertedAbsence;

  await database.insert(loans).values({
    loanId: 'LN-53005',
    borrowerName: 'Fix Leave Borrower',
    mobile: '9750000005',
    pincode: '456001',
    locality: 'Vijay',
    branchId,
    outstanding: 120000,
    overdueAmount: 20000,
    dpd: 20,
    bucket: dpdBucketFor(20),
    assignedOfficerId: officerId('loc'),
    homeOfficerId: officerId('loc'),
    status: 'overdue',
    isDemo: false
  });

  // A22: the broken promise is anchored on promised_date; statuses broken /
  // broken_part within the 14-day window raise the loan's weight.
  await database.insert(promises).values({
    loanId: 'LN-53001',
    promisedAmount: 50000,
    promisedDate: '2030-01-11',
    status: 'broken'
  });

  const secondRun = await runAssignment(RUN_DATE, ACTOR);
  expectOutcomes(secondRun.outcomesByReason, outcomesWith({ reassigned_leave: 2, carry_forward: 2, queue_unmapped: 1 }), 'phase 2');
  failUnless(secondRun.changedLoans === 2, `phase 2: expected exactly 2 loan writes (LN-53001 + LN-53005), got ${secondRun.changedLoans}`);
  failUnless(secondRun.logRows === 2, `phase 2: expected 2 new log rows, got ${secondRun.logRows}`);
  failUnless(secondRun.alertsRaised === 0, `phase 2: expected no hard-cap alerts, got ${secondRun.alertsRaised}`);
  const afterLeave = await logRowsAt();
  failUnless(afterLeave.length === 5, `phase 2: expected 5 assignment_log rows in total, got ${afterLeave.length}`);
  failUnless(afterLeave.filter((row) => row.reason === 'reassigned_leave').length === 2, 'phase 2: both leave moves must log reassigned_leave');
  const loan5After = await loanRow('LN-53005');
  const loan1After = await loanRow('LN-53001');
  failUnless(
    loan5After.assignedOfficerId === officerId('cover') && loan5After.homeOfficerId === officerId('loc'),
    'phase 2: LN-53005 must sit with the cover officer and keep its home officer'
  );
  failUnless(
    loan1After.assignedOfficerId === officerId('cover') && loan1After.homeOfficerId === officerId('loc'),
    'phase 2: LN-53001 (already assigned) must also move to the cover officer and keep its home officer'
  );
  printAssignmentRun('phase 2', secondRun);
  console.log('           assign-check-loc is on leave from 2030-01-09 to 2030-01-23 (13 working days)');
  console.log('           LN-53005 (home assign-check-loc) and LN-53001 -> assign-check-cover, home preserved');
  console.log('           LN-53001 weight 1.5 via the broken promise (promised 2030-01-11, status broken: A22)');

  console.log('phase 3/6  rerun on the post-state       -> zero writes, zero log rows (idempotent plan)');

  const thirdRun = await runAssignment(RUN_DATE, ACTOR);
  expectOutcomes(thirdRun.outcomesByReason, outcomesWith({ carry_forward: 4, queue_unmapped: 1 }), 'phase 3');
  failUnless(thirdRun.changedLoans === 0, `phase 3: a rerun must not write loans, got ${thirdRun.changedLoans}`);
  failUnless(thirdRun.logRows === 0, `phase 3: a rerun must not write log rows, got ${thirdRun.logRows}`);
  const afterRerun = await logRowsAt();
  failUnless(afterRerun.length === 5, `phase 3: the log must still hold 5 rows, got ${afterRerun.length}`);
  printAssignmentRun('phase 3', thirdRun);
  console.log('           carry_forward=4 covers the two cover-held loans plus the untouched officers');

  console.log('phase 4/6  ended leave + BLOCKED attempt -> a rule denial is not a touch; a CALL is (A29)');

  // LN-53004 (456005 generic row -> assign-check-gen) pretends it was covered
  // during gen's finished leave (2030-01-07..2030-01-11, cover=cover). At the
  // run date the leave is over, so the runner looks for touches inside that
  // window: a BLOCKED attempt must not protect the loan, so it reverts.
  await database.update(loans).set({ assignedOfficerId: officerId('cover') }).where(eq(loans.loanId, 'LN-53004'));
  await database.insert(officerAbsences).values({
    officerId: officerId('gen'),
    fromDate: '2030-01-07',
    toDate: '2030-01-11',
    coverOfficerId: officerId('cover')
  });
  // Blocks are window-enforcement events: the attempt sits OUTSIDE the
  // 08:00-19:00 IST window (07:45) and carries within_window=false (A4/A29).
  const blockedAttempt = new Date('2030-01-09T07:45:00+05:30');
  await database.insert(contactEvents).values({
    loanId: 'LN-53004',
    officerId: officerId('cover'),
    kind: 'BLOCKED',
    attemptedAtDevice: blockedAttempt,
    deviceTzOffsetMinutes: 330,
    attemptedAtIst: blockedAttempt,
    withinWindow: false,
    ruleSet: 'RECOVERY2026_100Y'
  });

  const blockedRun = await runAssignment(RUN_DATE, ACTOR);
  expectOutcomes(blockedRun.outcomesByReason, outcomesWith({ carry_forward: 3, revert_return: 1, queue_unmapped: 1 }), 'phase 4');
  failUnless(blockedRun.changedLoans === 1, `phase 4: the BLOCKED-protected lookalike must revert, got ${blockedRun.changedLoans} changed loans`);
  failUnless(blockedRun.logRows === 1, `phase 4: expected 1 new log row, got ${blockedRun.logRows}`);
  const blockedLoan = await loanRow('LN-53004');
  failUnless(
    blockedLoan.assignedOfficerId === officerId('gen') && blockedLoan.homeOfficerId === officerId('gen'),
    'phase 4: LN-53004 must revert to assign-check-gen with home assign-check-gen'
  );
  const afterBlocked = await logRowsAt();
  failUnless(afterBlocked.length === 6, `phase 4: expected 6 assignment_log rows in total, got ${afterBlocked.length}`);
  failUnless(afterBlocked.some((row) => row.loanId === 'LN-53004' && row.reason === 'revert_return'), "phase 4: the revert must log with reason 'revert_return'");
  printAssignmentRun('phase 4', blockedRun);
  console.log('           assign-check-gen was on leave 2030-01-07..2030-01-11 (ended before the run date)');
  console.log('           BLOCKED attempt 2030-01-09 07:45 IST (outside the window) inside the ended');
  console.log('           leave window -> a denial is not a touch: LN-53004 reverted to assign-check-gen');

  // Already-touched instead: a real CALL inside the window keeps the loan.
  const callAttempt = new Date('2030-01-09T10:00:00+05:30');
  await database.update(loans).set({ assignedOfficerId: officerId('cover') }).where(eq(loans.loanId, 'LN-53004'));
  await database.insert(contactEvents).values({
    loanId: 'LN-53004',
    officerId: officerId('cover'),
    kind: 'CALL',
    attemptedAtDevice: callAttempt,
    deviceTzOffsetMinutes: 330,
    attemptedAtIst: callAttempt,
    withinWindow: true,
    ruleSet: 'RECOVERY2026_100Y'
  });

  const callRun = await runAssignment(RUN_DATE, ACTOR);
  expectOutcomes(callRun.outcomesByReason, outcomesWith({ carry_forward: 4, queue_unmapped: 1 }), 'phase 4');
  failUnless(callRun.changedLoans === 0, `phase 4: the CALL must keep LN-53004 with the cover officer, got ${callRun.changedLoans} changed loans`);
  failUnless(callRun.logRows === 0, `phase 4: expected no new log rows, got ${callRun.logRows}`);
  const afterCall = await logRowsAt();
  failUnless(afterCall.length === 6, `phase 4: the CALL changes nothing, log rows must stay 6, got ${afterCall.length}`);
  printAssignmentRun('phase 4', callRun);
  console.log('           CALL attempt 2030-01-09 10:00 IST (inside the window) in the same ended');
  console.log('           leave window -> a real touch: LN-53004 stays with assign-check-cover, no log row');

  console.log('phase 5/6  same date, changed bytes     -> replace re-queues LN-53003 and logs nothing (A27)');

  const variant = await applyImport({
    bytes: VARIANT_BYTES,
    filename: 'assign-check-v2.csv',
    asOf: RUN_DATE,
    actor: { userId: null, username: ACTOR }
  });
  failUnless(variant.status === 'replaced' && 'batchId' in variant && variant.batchId !== undefined, `phase 5: expected replaced, got ${variant.status}`);
  state.batchIds.push(variant.batchId!);
  expectOutcomes(variant.report.assignment, outcomesWith({ carry_forward: 4, queue_unmapped: 1 }), 'phase 5');
  failUnless(variant.report.imported === 4 && variant.report.lateDiscovery === 0, `phase 5: replace must import 4 rows, got ${JSON.stringify(variant.report)}`);
  failUnless((await batchCountAtRunDate()) === 1, 'phase 5: replace must leave exactly one batch for the run date');
  const variantLoan1 = await loanRow('LN-53001');
  failUnless(variantLoan1.dpd === 11, `phase 5: replace must rewrite the loan row: expected dpd 11, got ${variantLoan1.dpd}`);
  const variantLoan3 = await loanRow('LN-53003');
  failUnless(
    variantLoan3.status === 'queue' && variantLoan3.assignedOfficerId === null,
    'phase 5: the upsert reset LN-53003 to overdue and the runner re-queues it'
  );
  const afterVariant = await logRowsAt();
  failUnless(afterVariant.length === 6, `phase 5: A27 re-queue must not log: log rows must stay 6, got ${afterVariant.length}`);
  const loan3Logs = afterVariant.filter((row) => row.loanId === 'LN-53003');
  failUnless(loan3Logs.length === 0, 'phase 5: LN-53003 must have no assignment_log row at any point (A27)');
  const variantSnapshot = (
    await database
      .select({ dpd: loanSnapshots.dpd })
      .from(loanSnapshots)
      .where(and(eq(loanSnapshots.asOf, RUN_DATE), eq(loanSnapshots.loanId, 'LN-53001')))
      .limit(1)
  )[0];
  failUnless(variantSnapshot?.dpd === 11, `phase 5: replace must refresh the snapshot dpd, got ${variantSnapshot?.dpd ?? 'none'}`);
  printReport(variant.report);
  console.log(`           replace proof: loan + loan_snapshot LN-53001 dpd 10 -> 11; ${LOAN_IDS.length - 1} snapshots at ${RUN_DATE}`);

  console.log('phase 6/6  same bytes again            -> noop replays the stored report byte-for-byte');

  const noop = await applyImport({
    bytes: VARIANT_BYTES,
    filename: 'assign-check-v2.csv',
    asOf: RUN_DATE,
    actor: { userId: null, username: ACTOR }
  });
  failUnless(noop.status === 'noop', `phase 6: expected noop, got ${noop.status}`);
  failUnless(noop.status === 'noop' && noop.batchId === (variant.status === 'replaced' ? variant.batchId : undefined), 'phase 6: noop must return the previous batch id');
  failUnless(stableJson(noop.report) === stableJson(variant.report), 'phase 6: noop must replay the previous report including assignment outcomes');
  console.log('           noop replay includes assignment.carry_forward=4 and assignment.queue_unmapped=1 (persisted report)');

  const finalLogs = afterVariant;
  console.log('');
  console.log(`           final run-state: ${finalLogs.length} log rows across the six phases (3 new_assigned + 2 reassigned_leave + 1 revert_return)`);

  // Deliberate-failure hook: proves a failed assertion exits non-zero while
  // cleanup still runs in finally.
  if (process.env.ASSIGN_CHECK_FAIL === '1') {
    console.log('');
    console.log('deliberate failure (ASSIGN_CHECK_FAIL=1): proving a failed assertion exits non-zero; cleanup still runs in finally');
    failUnless(false, 'deliberate failure: proving non-zero exit on assertion');
  }
}

function printAssignmentRun(label: string, run: { outcomesByReason: Record<AssignmentReason, number>; changedLoans: number; logRows: number; alertsRaised: number }): void {
  const active = ASSIGNMENT_REASONS.filter((reason) => run.outcomesByReason[reason] > 0);
  console.log(
    `           ${label} outcomes: ${active.map((reason) => `${reason}=${run.outcomesByReason[reason]}`).join(' ')} ` +
      `| loan writes=${run.changedLoans} log rows=${run.logRows} alerts=${run.alertsRaised}`
  );
}

// ---------------------------------------------------------------------------
// Cleanup — deletes only rows this run can prove it created; safe after seed.
// Runs from the finally block on every path, including assertion failures.
// Order matters: children (promise, absence, territory, log, snapshot) go
// before the officer and loan rows they reference; branch goes last.
// ---------------------------------------------------------------------------
async function cleanup(database: Db): Promise<void> {
  const rowErrorRows = state.batchIds.length > 0
    ? await database.delete(importRowErrors).where(inArray(importRowErrors.batchId, state.batchIds)).returning({ id: importRowErrors.id })
    : [];

  const batchRows = state.batchIds.length > 0
    ? await database.delete(importBatches).where(inArray(importBatches.id, state.batchIds)).returning({ id: importBatches.id })
    : [];
  failUnless(batchRows.length <= state.batchIds.length, `cleanup: deleted ${batchRows.length} batches but tracked only ${state.batchIds.length}`);

  // loan_snapshot: only the script writes at the run date (non-test batches
  // there are refused at pre-start), so a date-scoped delete is safe. Usually
  // already zero (the phase-4 replace's delete + insert cycle leaves 4).
  const snapshotRows = await database.delete(loanSnapshots).where(eq(loanSnapshots.asOf, RUN_DATE)).returning({ loanId: loanSnapshots.loanId });

  // assignment_log: same date-scoped proof (the runner stamps runDate = as_of).
  const logRows = await database.delete(assignmentLog).where(eq(assignmentLog.runDate, RUN_DATE)).returning({ loanId: assignmentLog.loanId });

  const promiseRows = await database.delete(promises).where(inArray(promises.loanId, [...LOAN_IDS])).returning({ id: promises.id });

  // Contacts reference the loans like promises do; every contact under the
  // script's ids is script-created (foreign LN-53xxx loans are refused in
  // pre-start), so an id-scoped delete is safe. The append-only trigger is
  // disabled only around this one delete (A14 gate, A17 bypass precedent).
  const contactRows = await deleteScriptContacts(database, LOAN_IDS);

  // Absences reference two officers (subject + cover); territory and the
  // loans' assignment columns reference the officers too, so children first.
  const officerIds = state.officerIds;
  const absenceRows = officerIds.length > 0
    ? await database
      .delete(officerAbsences)
      .where(or(inArray(officerAbsences.officerId, officerIds), inArray(officerAbsences.coverOfficerId, officerIds)))
      .returning({ id: officerAbsences.id })
    : [];
  const territoryRows = officerIds.length > 0 ? await database.delete(territory).where(inArray(territory.officerId, officerIds)).returning({ id: territory.id }) : [];

  const loanRows = await database.delete(loans).where(inArray(loans.loanId, [...LOAN_IDS])).returning({ loanId: loans.loanId });
  failUnless(loanRows.length <= LOAN_IDS.length, `cleanup: deleted ${loanRows.length} loans but only ${LOAN_IDS.length} ids are the script's`);
  const remainingLoans = await database.select({ loanId: loans.loanId }).from(loans).where(inArray(loans.loanId, [...LOAN_IDS]));
  failUnless(remainingLoans.length === 0, `cleanup: ${remainingLoans.length} loan(s) created by this run remain`);

  const officerRows = officerIds.length > 0
    ? await database.delete(officers).where(inArray(officers.id, officerIds)).returning({ id: officers.id })
    : [];
  failUnless(officerRows.length === officerIds.length, `cleanup: deleted ${officerRows.length} officers but tracked ${officerIds.length}`);

  const auditRows = await database
    .delete(auditLog)
    .where(and(eq(auditLog.actor, ACTOR), inArray(auditLog.action, AUDIT_ACTIONS)))
    .returning({ id: auditLog.id });

  let branchRows: { id: string }[] = [];
  if (state.branchCreatedId) {
    branchRows = await database.delete(branches).where(eq(branches.id, state.branchCreatedId)).returning({ id: branches.id });
    failUnless(branchRows.length === 1, `cleanup: the tracked branch row could not be deleted`);
  }

  // Final cleanliness assertions: nothing of ours survives.
  failUnless((await database.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.asOf, RUN_DATE))).length === 0, `cleanup: import_batch rows remain at ${RUN_DATE}`);
  failUnless((await database.select({ loanId: loanSnapshots.loanId }).from(loanSnapshots).where(eq(loanSnapshots.asOf, RUN_DATE))).length === 0, `cleanup: loan_snapshot rows remain at ${RUN_DATE}`);
  failUnless((await database.select({ loanId: assignmentLog.loanId }).from(assignmentLog).where(eq(assignmentLog.runDate, RUN_DATE))).length === 0, `cleanup: assignment_log rows remain at ${RUN_DATE}`);
  failUnless((await database.select({ loanId: loans.loanId }).from(loans).where(inArray(loans.loanId, [...LOAN_IDS]))).length === 0, 'cleanup: LN-53001..53005 rows remain');
  failUnless((await database.select({ id: promises.id }).from(promises).where(inArray(promises.loanId, [...LOAN_IDS]))).length === 0, 'cleanup: promise rows remain for the script\'s loans');
  failUnless((await database.select({ id: contactEvents.id }).from(contactEvents).where(inArray(contactEvents.loanId, [...LOAN_IDS]))).length === 0, "cleanup: contact_event rows remain for the script's loans");
  if (!state.branchExisted) {
    const survivingOfficers = await database.select({ id: officers.id }).from(officers).where(like(officers.name, `${ACTOR}-%`));
    failUnless(survivingOfficers.length === 0, 'cleanup: assign-check- officers remain');
  }

  console.log(
    `cleanup: import_row_error=${rowErrorRows.length} import_batch=${batchRows.length} loan_snapshot=${snapshotRows.length} ` +
      `assignment_log=${logRows.length} promise=${promiseRows.length} contact_event=${contactRows.length} ` +
      `absence=${absenceRows.length} territory=${territoryRows.length} ` +
      `loan=${loanRows.length} officer=${officerRows.length} audit_log=${auditRows.length} ` +
      `branch=${branchRows.length}${state.branchExisted ? ' (pre-existing branch kept)' : ''}`
  );
}
