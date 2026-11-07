import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { importBatches, importRowErrors, loans, promises, users } from './db/schema.js';
import { maskPhone } from '../shared/phone.js';
import type { LoanStatus } from '../shared/types.js';
import { DEMO_ACCOUNTS } from './demo.js';
import { addIstDays } from '../shared/promises.js';
import { promiseDeadline } from '../shared/promiseState.js';
import { isStuck } from './jobs/nightly.js';

export interface Actor {
  userId: string;
  username: string;
  role: 'field_officer' | 'branch_manager';
  branchId: string;
  /** The officer row this user acts as (field officers only; null for managers). */
  officerId: string | null;
  active: boolean;
}

export function isManager(actor: Actor | null | undefined): boolean {
  return Boolean(actor && actor.active && actor.role === 'branch_manager');
}

/** Login lookup (routes never touch the driver directly): returns the columns
 * the login route needs, including is_demo for the DEMO_MODE gate (A31). */
export interface LoginAttemptRow {
  id: string;
  username: string;
  passwordHash: string;
  role: Actor['role'];
  branchId: string;
  officerId: string | null;
  active: boolean;
  isDemo: boolean;
}

export async function findLoginUser(username: string): Promise<LoginAttemptRow | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      passwordHash: users.passwordHash,
      role: users.role,
      branchId: users.branchId,
      officerId: users.officerId,
      active: users.active,
      isDemo: users.isDemo
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return rows[0] ?? null;
}

export interface ImportBatchRecord {
  id: string;
  asOf: string;
  fileSha256: string;
  filename: string;
  status: string;
  rowCountJson: unknown;
}

export interface RowErrorRecord {
  rowNo: number;
  loanId: string | null;
  column: string;
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export async function fetchBatchWithRowErrors(
  batchId: string
): Promise<{ batch: ImportBatchRecord; rows: RowErrorRecord[] } | null> {
  const db = getDb();
  const batch = (await db.select().from(importBatches).where(eq(importBatches.id, batchId)).limit(1))[0];
  if (!batch) {
    return null;
  }
  const rows = await db
    .select({
      rowNo: importRowErrors.rowNo,
      loanId: importRowErrors.loanId,
      column: importRowErrors.sourceColumn,
      code: importRowErrors.code,
      severity: importRowErrors.severity,
      message: importRowErrors.message
    })
    .from(importRowErrors)
    .where(eq(importRowErrors.batchId, batchId))
    .orderBy(asc(importRowErrors.rowNo));
  return {
    batch: {
      id: batch.id,
      asOf: batch.asOf,
      fileSha256: batch.fileSha256,
      filename: batch.filename,
      status: batch.status,
      rowCountJson: batch.rowCountJson
    },
    rows
  };
}

/** The plain-Node degraded probe for /api/health: routes must not import the
 * driver themselves, so the query lives here like every other one. */
export async function probeDb(): Promise<void> {
  const db = getDb();
  await db.execute(sql`select 1 as ok`);
}

// --- loan reads (A33, prompt 7) ---------------------------------------------

/** Pure visibility rule. A field officer reads exactly the loans assigned to
 * them (assignment is branch-internal by construction); a manager reads
 * exactly their own branch's loans. Foreign/invisible/missing loans all fall
 * through to null, so routes answer one generic 404 and nothing is
 * enumerable. */
export function canReadLoan(actor: Actor | null | undefined, loan: { branchId: string; assignedOfficerId: string | null }): boolean {
  if (!actor || !actor.active) {
    return false;
  }
  if (actor.role === 'branch_manager') {
    return actor.branchId === loan.branchId;
  }
  return Boolean(actor.officerId) && actor.officerId === loan.assignedOfficerId;
}

interface LoanRowData {
  loanId: string;
  borrowerName: string;
  businessName: string | null;
  address: string | null;
  pincode: string | null;
  locality: string | null;
  product: string | null;
  outstanding: number;
  overdueAmount: number;
  emiAmount: number | null;
  dpd: number;
  bucket: string;
  branchId: string;
  assignedOfficerId: string | null;
  homeOfficerId: string | null;
  status: LoanStatus;
  mobile: string | null;
  altMobile: string | null;
}

/** Phone masking happens INSIDE the data-access layer: LoanDetail cannot carry
 * a raw mobile number, and callers never see one (A32). */
function maskLoan(loan: LoanRowData): LoanDetail {
  return {
    loanId: loan.loanId,
    borrowerName: loan.borrowerName,
    businessName: loan.businessName,
    address: loan.address,
    pincode: loan.pincode,
    locality: loan.locality,
    product: loan.product,
    outstanding: loan.outstanding,
    overdueAmount: loan.overdueAmount,
    emiAmount: loan.emiAmount,
    dpd: loan.dpd,
    bucket: loan.bucket,
    assignedOfficerId: loan.assignedOfficerId,
    homeOfficerId: loan.homeOfficerId,
    status: loan.status,
    mobileMasked: maskPhone(loan.mobile),
    altMobileMasked: maskPhone(loan.altMobile)
  };
}

export interface LoanDetail {
  loanId: string;
  borrowerName: string;
  businessName: string | null;
  address: string | null;
  pincode: string | null;
  locality: string | null;
  product: string | null;
  outstanding: number;
  overdueAmount: number;
  emiAmount: number | null;
  dpd: number;
  bucket: string;
  assignedOfficerId: string | null;
  homeOfficerId: string | null;
  status: LoanStatus;
  mobileMasked: string | null;
  altMobileMasked: string | null;
}

export async function fetchLoanForActor(actor: Actor, loanId: string): Promise<LoanDetail | null> {
  const db = getDb();
  const rows = await db
    .select({
      loanId: loans.loanId,
      borrowerName: loans.borrowerName,
      businessName: loans.businessName,
      address: loans.address,
      pincode: loans.pincode,
      locality: loans.locality,
      product: loans.product,
      outstanding: loans.outstanding,
      overdueAmount: loans.overdueAmount,
      emiAmount: loans.emiAmount,
      dpd: loans.dpd,
      bucket: loans.bucket,
      branchId: loans.branchId,
      assignedOfficerId: loans.assignedOfficerId,
      homeOfficerId: loans.homeOfficerId,
      status: loans.status,
      mobile: loans.mobile,
      altMobile: loans.altMobile
    })
    .from(loans)
    .where(eq(loans.loanId, loanId))
    .limit(1);
  const loan = rows[0];
  if (!loan || !canReadLoan(actor, loan)) {
    return null;
  }
  return maskLoan(loan as LoanRowData);
}

/** A34/A31: demo-account chips. Returns ONLY the A31 demo chip usernames
 * (DEMO_ACCOUNTS: demo-manager, demo-officer-1/2/3) that are active demo
 * users; nothing else (no ids, roles, hashes). Callers gate on
 * demoModeEnabled(). The seeded synthetic officers are is_demo for the
 * "(demo)" marker (A40) but are NOT demo login chips. */
export async function listDemoUsernames(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ username: users.username })
    .from(users)
    .where(and(eq(users.isDemo, true), eq(users.active, true)))
    .orderBy(asc(users.username));
  const chipNames = new Set<string>(DEMO_ACCOUNTS.map((account) => account.username));
  return rows.map((row) => row.username).filter((username) => chipNames.has(username));
}

export interface AssignmentSummary {
  loanId: string;
  borrowerName: string;
  pincode: string | null;
  locality: string | null;
  dpd: number;
  bucket: string;
  outstanding: number;
  overdueAmount: number;
  mobileMasked: string | null;
}

/** The officer's overdue work list. Manager requests are refused at the route
 * (A33: assignments are officer-scoped); this stays defensive with []. */
export async function listOfficerAssignments(actor: Actor): Promise<AssignmentSummary[]> {
  if (actor.role !== 'field_officer' || !actor.officerId) {
    return [];
  }
  const db = getDb();
  const rows = await db
    .select({
      loanId: loans.loanId,
      borrowerName: loans.borrowerName,
      pincode: loans.pincode,
      locality: loans.locality,
      dpd: loans.dpd,
      bucket: loans.bucket,
      outstanding: loans.outstanding,
      overdueAmount: loans.overdueAmount,
      mobile: loans.mobile
    })
    .from(loans)
    .where(and(eq(loans.assignedOfficerId, actor.officerId), eq(loans.status, 'overdue')))
    .orderBy(desc(loans.dpd), asc(loans.loanId));
    return rows.map((row) => ({
      loanId: row.loanId,
      borrowerName: row.borrowerName,
      pincode: row.pincode,
      locality: row.locality,
      dpd: row.dpd,
      bucket: row.bucket,
      outstanding: row.outstanding,
      overdueAmount: row.overdueAmount,
      mobileMasked: maskPhone(row.mobile)
    }));
}

/** SPEC 12 promise-tracker cards (prompt 11 item 3), officer-scoped by the
 *  promises' officer. Three sections:
 *  - dueToday: open promises whose promised date IS today (IST);
 *  - upcoming: open promises due after today, soonest first;
 *  - brokenNeedingFollowup: broken/broken_part promises with NO contact
 *    event on the loan since the break was recorded — the follow-up queue.
 *  Escalation is derived from data, no tasks table (SPEC 12): a loan with a
 *  second broken promise flags manager attention; a promise two or more
 *  days past its deadline with no officer action is STUCK (A62) — exposed
 *  on the cards and reusable by the manager dashboard. */
export interface PromiseCard {
  promiseId: string;
  loanId: string;
  borrowerName: string;
  /** Paise (A11). */
  amountPaise: number;
  promisedDate: string;
  status: 'open' | 'broken' | 'broken_part';
  loanCleared: boolean;
}

export interface BrokenPromiseCard extends PromiseCard {
  deadline: string;
  /** Whole IST days between the deadline and today (>= 1 for every row here). */
  daysPastDue: number;
  /** SPEC 12 escalation: this loan has a second broken promise. */
  needsManagerAttention: boolean;
  /** SPEC 12 stuck list: >= 2 days past due with no officer action. */
  stuck: boolean;
}

export interface OfficerPromises {
  dueToday: PromiseCard[];
  upcoming: PromiseCard[];
  brokenNeedingFollowup: BrokenPromiseCard[];
}

export async function listOfficerPromises(actor: Actor, todayIst: string): Promise<OfficerPromises> {
  if (actor.role !== 'field_officer' || !actor.officerId) {
    return { dueToday: [], upcoming: [], brokenNeedingFollowup: [] };
  }
  const db = getDb();
  const cardColumns = {
    promiseId: promises.id,
    loanId: promises.loanId,
    borrowerName: loans.borrowerName,
    amountPaise: promises.promisedAmount,
    promisedDate: promises.promisedDate,
    status: promises.status,
    loanCleared: sql<boolean>`(${loans.status} = 'cleared')`
  };
  const openRows = await db
    .select(cardColumns)
    .from(promises)
    .innerJoin(loans, eq(loans.loanId, promises.loanId))
    .where(
      and(
        eq(promises.officerId, actor.officerId),
        eq(promises.status, 'open'),
        sql`${promises.promisedDate} >= ${todayIst}`,
        sql`${promises.promisedDate} <= ${addIstDays(todayIst, 30)}`
      )
    )
    .orderBy(asc(promises.promisedDate));
  const brokenRows = await db
    .select({
      ...cardColumns,
      graceDays: promises.graceDays,
      resolvedAt: promises.resolvedAt,
      secondBreak: sql<boolean>`(
        SELECT count(*) FROM promise p2
        WHERE p2.loan_id = ${promises.loanId} AND p2.status IN ('broken', 'broken_part')
      ) >= 2`,
      actionedSinceBreak: sql<boolean>`EXISTS (
        SELECT 1 FROM contact_event ce
        WHERE ce.loan_id = ${promises.loanId}
          AND ce.attempted_at_ist >= ${promises.resolvedAt}
      )`
    })
    .from(promises)
    .innerJoin(loans, eq(loans.loanId, promises.loanId))
    .where(
      and(
        eq(promises.officerId, actor.officerId),
        sql`${promises.status} IN ('broken', 'broken_part')`
      )
    )
    .orderBy(desc(promises.resolvedAt))
    .limit(50);

  const dueToday: PromiseCard[] = [];
  const upcoming: PromiseCard[] = [];
  for (const row of openRows) {
    const card: PromiseCard = {
      promiseId: row.promiseId,
      loanId: row.loanId,
      borrowerName: row.borrowerName,
      amountPaise: Number(row.amountPaise),
      promisedDate: String(row.promisedDate),
      status: 'open',
      loanCleared: row.loanCleared
    };
    if (card.promisedDate === todayIst) {
      dueToday.push(card);
    } else {
      upcoming.push(card);
    }
  }

  const brokenNeedingFollowup: BrokenPromiseCard[] = [];
  for (const row of brokenRows) {
    if (row.actionedSinceBreak) {
      continue;
    }
    const deadline = promiseDeadline(String(row.promisedDate), row.graceDays);
    const daysPastDue = Math.max(
      1,
      Math.round((Date.parse(`${todayIst}T00:00:00Z`) - Date.parse(`${deadline}T00:00:00Z`)) / 86_400_000)
    );
    brokenNeedingFollowup.push({
      promiseId: row.promiseId,
      loanId: row.loanId,
      borrowerName: row.borrowerName,
      amountPaise: Number(row.amountPaise),
      promisedDate: String(row.promisedDate),
      status: row.status === 'broken_part' ? 'broken_part' : 'broken',
      loanCleared: row.loanCleared,
      deadline,
      daysPastDue,
      needsManagerAttention: row.secondBreak,
      stuck: isStuck(daysPastDue)
    });
  }
  return { dueToday, upcoming, brokenNeedingFollowup };
}

/** The manager dashboard's stuck-promise list (SPEC 12), company-wide —
 *  the same definition as the officer cards' stuck flag (A62), exposed as
 *  its own read so the dashboard view can consume it without re-deriving. */
export async function listStuckPromises(todayIst: string): Promise<(BrokenPromiseCard & { officerName: string | null; branchId: string })[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT p.id::text AS promise_id,
           p.loan_id,
           l.borrower_name,
           p.promised_amount::bigint AS amount_paise,
           p.promised_date::text AS promised_date,
           p.status::text AS status,
           (l.status = 'cleared') AS loan_cleared,
           (p.promised_date + p.grace_days)::text AS deadline,
           o.name AS officer_name,
           l.branch_id
    FROM promise p
    JOIN loan l ON l.loan_id = p.loan_id
    LEFT JOIN officer o ON o.id = p.officer_id
    WHERE p.status IN ('broken', 'broken_part')
      AND (p.promised_date + p.grace_days) <= DATE ${todayIst} - 2
      AND NOT EXISTS (
        SELECT 1 FROM contact_event ce
        WHERE ce.loan_id = p.loan_id AND ce.attempted_at_ist >= p.resolved_at
      )
    ORDER BY (p.promised_date + p.grace_days) ASC
    LIMIT 100
  `);
  return (rows.rows as Record<string, unknown>[]).map((raw) => {
    const deadline = String(raw.deadline).slice(0, 10);
    const daysPastDue = Math.max(
      1,
      Math.round((Date.parse(`${todayIst}T00:00:00Z`) - Date.parse(`${deadline}T00:00:00Z`)) / 86_400_000)
    );
    return {
      promiseId: String(raw.promise_id),
      loanId: String(raw.loan_id),
      borrowerName: String(raw.borrower_name),
      amountPaise: Number(raw.amount_paise),
      promisedDate: String(raw.promised_date).slice(0, 10),
      status: String(raw.status) === 'broken_part' ? ('broken_part' as const) : ('broken' as const),
      loanCleared: raw.loan_cleared === true,
      deadline,
      daysPastDue,
      needsManagerAttention: false,
      stuck: isStuck(daysPastDue),
      officerName: raw.officer_name === null ? null : String(raw.officer_name),
      branchId: String(raw.branch_id)
    };
  });
}
