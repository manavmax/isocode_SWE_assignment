/**
 * import:check — local-only integration check for the daily CSV import (SPEC 11).
 *
 * NOT part of CI: it needs a real DATABASE_URL (local .env), writes to that
 * database, and then removes every row it created. It prints which database it
 * is touching before it starts. Never point it at a database you care about.
 *
 * Run: pnpm import:check
 */
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from '@neondatabase/serverless';
import { app } from '../src/server/app.js';
import { closePool } from '../src/server/db.js';
import { hashPassword } from '../src/server/auth.js';
import { auditLog, branches, importBatches, importRowErrors, loanSnapshots, loans, users } from '../src/server/db/schema.js';

const AS_OF = '2030-01-15';
const MANAGER = 'import-check-mgr';
const OFFICER = 'import-check-officer';
const PASSWORD = 'import-check-pw-7f31';
const BRANCHES = [
  { code: 'UJJ', name: 'Ujjain' },
  { code: 'IDR', name: 'Indore' },
  { code: 'DWS', name: 'Dewas' }
];

type LoanRow = typeof loans.$inferSelect;
type SnapshotRow = typeof loanSnapshots.$inferSelect;

interface Report {
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
}

const state = {
  fixtureIds: [] as string[],
  capturedLoans: [] as LoanRow[],
  capturedSnapshots: [] as SnapshotRow[],
  batchIds: [] as string[],
  branchIds: [] as string[]
};

failUnless(process.env.DATABASE_URL, 'DATABASE_URL is not set (run via pnpm import:check)');

const target = new URL(process.env.DATABASE_URL);
console.log(`import-check: touching database ${target.host}${target.pathname} (DATABASE_URL from local .env)`);
console.log('import-check: local-only check, never run in CI; writes demo rows and removes them at the end');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

try {
  const preBatches = await db.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.asOf, AS_OF));
  failUnless(preBatches.length === 0, `import_batch already has rows for as_of ${AS_OF}; the check needs that date free`);

  const fixtureLoanIds = ['data/sample_overdue.csv', 'data/bad_rows.csv', 'data/abort_rows.csv'].flatMap((file) =>
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.trim() !== '')
      .map((line) => line.split(',')[0]!.trim())
  );
  state.fixtureIds = [...new Set(fixtureLoanIds)];
  state.capturedLoans = await db.select().from(loans).where(inArray(loans.loanId, state.fixtureIds));
  state.capturedSnapshots = await db.select().from(loanSnapshots).where(eq(loanSnapshots.asOf, AS_OF));

  const branchByName = new Map((await db.select().from(branches)).map((row) => [row.name.trim().toLowerCase(), row.id]));
  for (const branch of BRANCHES) {
    if (!branchByName.has(branch.name.toLowerCase())) {
      const inserted = await db.insert(branches).values(branch).returning({ id: branches.id });
      state.branchIds.push(inserted[0]!.id);
      branchByName.set(branch.name.toLowerCase(), inserted[0]!.id);
    }
  }
  const ujjainId = branchByName.get('ujjain')!;
  await db.insert(users).values([
    { username: MANAGER, passwordHash: hashPassword(PASSWORD), role: 'branch_manager', branchId: ujjainId, active: true },
    { username: OFFICER, passwordHash: hashPassword(PASSWORD), role: 'field_officer', branchId: ujjainId, active: true }
  ]);
  const managerAuth = basic(MANAGER, PASSWORD);
  const officerAuth = basic(OFFICER, PASSWORD);

  const bytesOf = (file: string): Uint8Array => new Uint8Array(readFileSync(file));
  const post = async (filename: string, bytes: Uint8Array, asOf?: string, auth: string = managerAuth): Promise<Response> => {
    const form = new FormData();
    form.append('file', new File([bytes], filename, { type: 'text/csv' }));
    if (asOf !== undefined) {
      form.append('as_of', asOf);
    }
    return app.request('/api/import', { method: 'POST', body: form, headers: { Authorization: auth } });
  };
  const importJson = async (res: Response): Promise<{ status: string; batchId?: string; abort?: { code: string; message: string }; report: Report }> =>
    (await res.json()) as { status: string; batchId?: string; abort?: { code: string; message: string }; report: Report };

  console.log('probe   POST /api/import with no credentials -> expect 401');
  failUnless((await app.request('/api/import', { method: 'POST' })).status === 401, 'expected 401 without credentials');

  console.log('probe   POST /api/import as a field officer -> expect 403 (manager only)');
  const officerRes = await post('sample_overdue.csv', bytesOf('data/sample_overdue.csv'), AS_OF, officerAuth);
  failUnless(officerRes.status === 403, `expected 403 for a field officer, got ${officerRes.status}`);

  console.log('probe   POST /api/import with as_of=2026-02-30 -> expect 400 (not a real calendar date)');
  const badDate = await post('sample_overdue.csv', bytesOf('data/sample_overdue.csv'), '2026-02-30');
  failUnless(badDate.status === 400, `expected 400 for an impossible as_of, got ${badDate.status}`);

  console.log('probe   POST /api/import with a .txt upload -> expect 415 (extension + MIME check)');
  const badType = await post('notes.txt', bytesOf('data/sample_overdue.csv'), AS_OF);
  failUnless(badType.status === 415, `expected 415 for a .txt upload, got ${badType.status}`);

  console.log('');
  console.log(`phase 1/5  sample_overdue.csv   as_of=${AS_OF}  -> expect imported`);
  const first = importJson(await post('sample_overdue.csv', bytesOf('data/sample_overdue.csv'), AS_OF));
  const firstBody = await first;
  failUnless(firstBody.status === 'imported' && firstBody.batchId !== undefined, `phase 1: expected imported, got ${JSON.stringify(firstBody)}`);
  state.batchIds.push(firstBody.batchId!);
  printReport(firstBody.report);

  console.log('phase 2/5  sample_overdue.csv   (same bytes) -> expect noop, previous report replayed, nothing written');
  const secondBody = await importJson(await post('sample_overdue.csv', bytesOf('data/sample_overdue.csv'), AS_OF));
  failUnless(secondBody.status === 'noop', `phase 2: expected noop, got ${JSON.stringify(secondBody)}`);
  failUnless(secondBody.batchId === firstBody.batchId, 'phase 2: noop must return the previous batch id');
  failUnless(stableJson(secondBody.report) === stableJson(firstBody.report), 'phase 2: noop must replay the previous report');
  failUnless((await batchCount()) === 1, 'phase 2: noop must not add a batch row');

  console.log(`phase 3/5  bad_rows.csv         as_of=${AS_OF}  -> expect replace with partial acceptance`);
  const thirdBody = await importJson(await post('bad_rows.csv', bytesOf('data/bad_rows.csv'), AS_OF));
  failUnless(thirdBody.status === 'replaced', `phase 3: expected replaced, got ${JSON.stringify(thirdBody)}`);
  failUnless(thirdBody.report.imported === 42 && thirdBody.report.dropped === 4, `phase 3: expected 42 imported / 4 dropped, got ${JSON.stringify(thirdBody.report)}`);
  failUnless(thirdBody.report.errors === 4, `phase 3: expected 4 row errors (under the 20 percent abort), got ${thirdBody.report.errors}`);
  failUnless((await batchCount()) === 1, 'phase 3: replace must leave exactly one batch for the date');
  state.batchIds.push(thirdBody.batchId!);
  printReport(thirdBody.report);

  console.log(`phase 4/5  abort_rows.csv       as_of=${AS_OF}  -> expect abort, nothing written`);
  const fourthRes = await post('abort_rows.csv', bytesOf('data/abort_rows.csv'), AS_OF);
  const fourthBody = await importJson(fourthRes);
  failUnless(fourthRes.status === 422 && fourthBody.status === 'rejected', `phase 4: expected 422 rejected, got ${fourthRes.status} ${JSON.stringify(fourthBody)}`);
  failUnless(fourthBody.abort?.code === 'error_rate', `phase 4: expected an error_rate abort, got ${JSON.stringify(fourthBody.abort)}`);
  failUnless((await batchCount()) === 1, 'phase 4: an aborted import must not write a batch');
  failUnless((await db.select({ id: loans.loanId }).from(loans).where(eq(loans.loanId, 'LN-60001'))).length === 0, 'phase 4: an aborted import must not write loans');
  console.log(`           abort: ${fourthBody.abort!.code} (${fourthBody.abort!.message})`);

  console.log(`phase 5/5  bad_rows variant     as_of=${AS_OF}  -> expect replace (same date, different bytes)`);
  const variant = new TextEncoder().encode(new TextDecoder().decode(bytesOf('data/bad_rows.csv')).replace('"1,20,000",3,457001', '"1,20,000",4,457001'));
  const fifthBody = await importJson(await post('bad_rows_v2.csv', variant, AS_OF));
  failUnless(fifthBody.status === 'replaced', `phase 5: expected replaced, got ${JSON.stringify(fifthBody)}`);
  failUnless(fifthBody.batchId !== thirdBody.batchId, 'phase 5: replace must write a new batch id');
  failUnless((await batchCount()) === 1, 'phase 5: replace must leave exactly one batch for the date');
  state.batchIds.push(fifthBody.batchId!);
  printReport(fifthBody.report);

  console.log('phase +    GET /api/import/:id/errors.csv -> expect csv with excel row numbers and loan ids');
  const errorsRes = await app.request(`/api/import/${fifthBody.batchId}/errors.csv`, { headers: { Authorization: managerAuth } });
  failUnless(errorsRes.status === 200, `errors.csv: expected 200, got ${errorsRes.status}`);
  failUnless((errorsRes.headers.get('content-type') ?? '').includes('text/csv'), `errors.csv: expected text/csv, got ${errorsRes.headers.get('content-type')}`);
  const lines = (await errorsRes.text()).trimEnd().split('\n');
  failUnless(lines[0] === 'row_no,loan_id,source_column,code,severity,message', `errors.csv: unexpected header ${lines[0]}`);
  const dataRows = lines.slice(1).map((line) => line.split(','));
  failUnless(dataRows.length === fifthBody.report.errors + fifthBody.report.warnings, `errors.csv: expected ${fifthBody.report.errors + fifthBody.report.warnings} rows, got ${dataRows.length}`);
  failUnless(dataRows.every((cells) => /^\d+$/.test(cells[0]!) && Number(cells[0]) >= 2), 'errors.csv: row numbers must be excel numbers >= 2');
  failUnless(dataRows.some((cells) => cells[2] === 'loan_id' && cells[3] === 'duplicate_loan_id' && cells[1] === 'LN-50001'), 'errors.csv: expected the duplicate row error carrying its loan id');
  failUnless(dataRows.some((cells) => cells[2] === 'mobile' && cells[4] === 'warning'), 'errors.csv: expected the mobile warning stored with severity warning');
  console.log(`           errors.csv: ${dataRows.length} rows, excel row numbers ${dataRows.map((cells) => cells[0]).join(', ')}`);

  await cleanup();
  console.log('import-check OK');
} catch (err) {
  console.error(`import-check FAILED: ${err instanceof Error ? err.message : String(err)}`);
  try {
    await cleanup();
  } catch (cleanupErr) {
    console.error(`import-check cleanup also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
  }
  process.exitCode = 1;
} finally {
  await closePool().catch(() => undefined);
  await pool.end();
}

function printReport(report: Report) {
  console.log(`           counts: ${Object.entries(report).map(([key, value]) => `${key}=${value}`).join(' ')}`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function batchCount(): Promise<number> {
  return (await db.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.asOf, AS_OF))).length;
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function cleanup() {
  const capturedIds = new Set(state.capturedLoans.map((row) => row.loanId));
  const createdLoans = state.fixtureIds.filter((loanId) => !capturedIds.has(loanId));

  const rowErrors = state.batchIds.length > 0
    ? await db.delete(importRowErrors).where(inArray(importRowErrors.batchId, state.batchIds)).returning({ id: importRowErrors.id })
    : [];
  const batchRows = state.batchIds.length > 0
    ? await db.delete(importBatches).where(inArray(importBatches.id, state.batchIds)).returning({ id: importBatches.id })
    : [];
  const snapshotRows = await db.delete(loanSnapshots).where(eq(loanSnapshots.asOf, AS_OF)).returning({ loanId: loanSnapshots.loanId });
  const deletedLoans = createdLoans.length > 0
    ? await db.delete(loans).where(inArray(loans.loanId, createdLoans)).returning({ loanId: loans.loanId })
    : [];
  for (const loanRow of state.capturedLoans) {
    await db.update(loans).set(loanRow).where(eq(loans.loanId, loanRow.loanId));
  }
  const auditRows = await db.delete(auditLog).where(inArray(auditLog.actor, [MANAGER, OFFICER])).returning({ id: auditLog.id });
  const userRows = await db.delete(users).where(inArray(users.username, [MANAGER, OFFICER])).returning({ id: users.id });
  const branchRows = state.branchIds.length > 0
    ? await db.delete(branches).where(inArray(branches.id, state.branchIds)).returning({ id: branches.id })
    : [];
  for (const snapshot of state.capturedSnapshots) {
    await db.insert(loanSnapshots).values(snapshot).onConflictDoNothing();
  }
  console.log(`cleanup: import_row_error=${rowErrors.length} import_batch=${batchRows.length} loan_snapshot=${snapshotRows.length} loan deleted=${deletedLoans.length} loan restored=${state.capturedLoans.length} audit_log=${auditRows.length} app_user=${userRows.length} branch=${branchRows.length}`);
}

function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
