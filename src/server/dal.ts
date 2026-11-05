import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { importBatches, importRowErrors, loans, users } from './db/schema.js';
import { parseBasicAuth, verifyPassword } from './auth.js';
import { maskPhone } from '../shared/phone.js';
import type { LoanStatus } from '../shared/types.js';

export interface Actor {
  userId: string;
  username: string;
  role: 'field_officer' | 'branch_manager';
  branchId: string;
  /** The officer row this user acts as (field officers only; null for managers). */
  officerId: string | null;
  active: boolean;
}

export async function resolveActor(authorization: string | null | undefined): Promise<Actor | null> {
  const creds = parseBasicAuth(authorization);
  if (!creds) {
    return null;
  }
  const db = getDb();
  const found = await db.select().from(users).where(eq(users.username, creds.username)).limit(1);
  const user = found[0];
  if (!user || !user.active) {
    return null;
  }
  if (!verifyPassword(user.passwordHash, creds.password)) {
    return null;
  }
  return { userId: user.id, username: user.username, role: user.role, branchId: user.branchId, officerId: user.officerId ?? null, active: user.active };
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
