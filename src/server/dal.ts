import { asc, eq } from 'drizzle-orm';
import { getDb } from './db.js';
import { importBatches, importRowErrors, users } from './db/schema.js';
import { parseBasicAuth, verifyPassword } from './auth.js';

export interface Actor {
  userId: string;
  username: string;
  role: 'field_officer' | 'branch_manager';
  branchId: string;
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
  return { userId: user.id, username: user.username, role: user.role, branchId: user.branchId, active: user.active };
}

export function isManager(actor: Actor | null | undefined): boolean {
  return Boolean(actor && actor.active && actor.role === 'branch_manager');
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
