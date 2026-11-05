/**
 * import:check — local-only integration check for the daily CSV import (SPEC 11).
 *
 * NOT part of CI: it needs a real DATABASE_URL (local .env), writes to that
 * database, and then removes every row it created. It prints which database it
 * is touching before it starts. Never point it at a database you care about.
 *
 * Run: pnpm import:check     (IMPORT_CHECK_FAIL=1 runs one deliberate failure:
 *                             proves non-zero exit; cleanup still runs)
 *
 * Cleanup ownership rules — it deletes only rows it can prove it created:
 * - branch:   ids returned at insert time (a seed branch with the same name
 *             is reused and never deleted); crashed-run leftovers are removed
 *             at start only when nothing references them
 * - app_user: ids returned at insert time; a crashed-run leftover is deleted
 *             only after verifyPassword proves it is import-check's own
 * - loan:     fixture loan_ids that did not exist at start are deleted; any
 *             loan that DID exist at start (seed) is captured and restored
 *             column-for-column, never deleted. A sentinel seed-lookalike
 *             (borrower=Seed-Sentinel at LN-50101) proves restore-on-collision
 *             every run, then is removed as a tracked creation.
 * - import_batch / import_row_error / loan_snapshot / audit_log: only rows
 *   tied to this run's batch ids, the test date, or this script's usernames.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { Pool } from '@neondatabase/serverless';
import { app } from '../src/server/app.js';
import { closePool } from '../src/server/db.js';
import { hashPassword, verifyPassword } from '../src/server/auth.js';
import {
  assignmentLog,
  auditLog,
  branches,
  importBatches,
  importRowErrors,
  loanSnapshots,
  loans,
  users
} from '../src/server/db/schema.js';

const AS_OF = '2030-01-15';
const SENTINEL_DATE = '2026-01-01';
const SENTINEL_LOAN = 'LN-50101';
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
type Db = NonNullable<typeof db>;

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
  assignment: Record<string, number>;
}

interface ImportJsonResult {
  status: string;
  batchId?: string;
  abort?: { code: string; message: string };
  report: Report;
}

const state = {
  branchIds: [] as string[],
  userIds: [] as string[],
  batchIds: [] as string[],
  fixtureLoanIds: [] as string[],
  preExistingLoans: [] as LoanRow[],
  preExistingSnapshots: [] as SnapshotRow[],
  sentinelInjected: false
};

failUnless(process.env.DATABASE_URL, 'DATABASE_URL is not set (run via pnpm import:check)');

const dbTarget = new URL(process.env.DATABASE_URL);
console.log(`import-check: touching database ${dbTarget.host}${dbTarget.pathname} (DATABASE_URL from local .env)`);
console.log('import-check: local-only check, never run in CI; writes demo rows and removes them at the end');

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

try {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // A dropped websocket must not kill the process outside the promise chain:
  // surface it on the pool (the next query then fails normally through the
  // catch below, and the finally block still attempts cleanup).
  pool.on('error', (err: Error) => console.error(`import-check: pool error: ${err.message}`));
  db = drizzle(pool);
  await run(db);
} catch (err) {
  console.error(`import-check FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (db) {
    try {
      await cleanup(db);
    } catch (cleanupErr) {
      console.error(`import-check cleanup also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      process.exitCode = 1;
    }
  }
  await closePool().catch(() => undefined);
  await pool?.end().catch(() => undefined);
}

function bytesOf(file: string): Uint8Array {
  return new Uint8Array(readFileSync(file));
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function variantBytes(): Uint8Array {
  // Phase-5 payload: identical to bad_rows.csv except LN-50101's DPD 3 -> 4.
  // Deterministic bytes, so its sha256 is a stable ownership marker.
  const raw = new TextDecoder().decode(bytesOf('data/bad_rows.csv'));
  return new TextEncoder().encode(raw.replace('"1,20,000",3,457001', '"1,20,000",4,457001'));
}

/** Logs a seeded user in through the real POST /api/auth/login (cookie
 * session — the API no longer accepts Basic headers) and returns the
 * fc_session cookie to pass as a `cookie` header on later requests. */
async function loginCookie(username: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, pin: password })
  });
  failUnless(res.status === 200, `login for ${username}: expected 200, got ${res.status}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  failUnless(cookie.startsWith('fc_session='), `login for ${username}: no session cookie set`);
  return cookie;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
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

function printReport(report: Report): void {
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

function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function run(database: Db): Promise<void> {
  const fixtureHashes = new Set([
    sha256Of(bytesOf('data/sample_overdue.csv')),
    sha256Of(bytesOf('data/bad_rows.csv')),
    sha256Of(bytesOf('data/abort_rows.csv')),
    sha256Of(variantBytes())
  ]);
  const fixtureLoanIds = [
    ...new Set(
      ['data/sample_overdue.csv', 'data/bad_rows.csv', 'data/abort_rows.csv'].flatMap((file) =>
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .slice(1)
          .filter((line) => line.trim() !== '')
          .map((line) => line.split(',')[0]!.trim())
      )
    )
  ];
  state.fixtureLoanIds = fixtureLoanIds;

  // --- pre-start: remove leftovers from an earlier crashed run -------------
  const futureBatches = await database
    .select({ asOf: importBatches.asOf })
    .from(importBatches)
    .where(gt(importBatches.asOf, AS_OF));
  failUnless(
    futureBatches.length === 0,
    `refusing to run: ${futureBatches.length} non-test batch(es) dated after as_of ${AS_OF} exist ` +
      `(${futureBatches.map((b) => b.asOf).join(', ')}); import:check must not touch a database with real post-dated imports`
  );

  const batchesAtAsOf = await database
    .select({ id: importBatches.id, sha256: importBatches.fileSha256 })
    .from(importBatches)
    .where(eq(importBatches.asOf, AS_OF));
  for (const batch of batchesAtAsOf) {
    if (fixtureHashes.has(batch.sha256)) {
      await database.delete(importRowErrors).where(eq(importRowErrors.batchId, batch.id));
      await database.delete(importBatches).where(eq(importBatches.id, batch.id));
      console.log(`pre-start: removed leftover test batch ${batch.id} (sha256 ${batch.sha256.slice(0, 12)}) from a crashed run`);
    } else {
      failUnless(
        false,
        `refusing to run: a non-test batch exists at as_of ${AS_OF} (sha256 ${batch.sha256.slice(0, 12)}); ` +
          `only import:check's own fixture batches are ever removed`
      );
    }
  }

  // Loans created by a crashed run carry the test date as their only snapshot
  // (the script never imports on any other date); loans that also have a
  // snapshot at another date pre-date the script (seed) and are left alone —
  // they are captured below and restored at cleanup. A fixture-id loan with NO
  // snapshot at all is also a script leftover: the importer always writes a
  // snapshot with its loan (one transaction), and seed generates every loan
  // through the importer, so only this script's cleanup can have removed a
  // loan's snapshots mid-crash. The marker check must read the snapshots
  // BEFORE they are deleted.
  const fixtureSnapshotRows = fixtureLoanIds.length > 0
    ? await database
      .select({ loanId: loanSnapshots.loanId, asOf: loanSnapshots.asOf })
      .from(loanSnapshots)
      .where(inArray(loanSnapshots.loanId, fixtureLoanIds))
    : [];
  const snapshotDatesByLoan = new Map<string, Set<string>>();
  for (const row of fixtureSnapshotRows) {
    const dates = snapshotDatesByLoan.get(row.loanId) ?? new Set<string>();
    dates.add(row.asOf);
    snapshotDatesByLoan.set(row.loanId, dates);
  }
  const crashedLoanIds = fixtureLoanIds.filter((loanId) => {
    const dates = snapshotDatesByLoan.get(loanId);
    if (dates === undefined) {
      return true;
    }
    return dates.has(AS_OF) && dates.size === 1;
  });
  const leftoverSnapshots = await database
    .delete(loanSnapshots)
    .where(eq(loanSnapshots.asOf, AS_OF))
    .returning({ loanId: loanSnapshots.loanId });
  if (leftoverSnapshots.length > 0) {
    console.log(`pre-start: removed ${leftoverSnapshots.length} loan_snapshot row(s) at ${AS_OF} from a crashed run`);
  }
  // assignment_log rows at the script's own test date belong to this script's
  // runs (the runner stamps runDate = as_of = AS_OF); they must go BEFORE the
  // crashed-loan delete below because they reference loans (SPEC 10 wiring).
  const leftoverLogRows = await database
    .delete(assignmentLog)
    .where(eq(assignmentLog.runDate, AS_OF))
    .returning({ loanId: assignmentLog.loanId });
  if (leftoverLogRows.length > 0) {
    console.log(`pre-start: removed ${leftoverLogRows.length} assignment_log row(s) at ${AS_OF} from a crashed run`);
  }
  if (crashedLoanIds.length > 0) {
    const removed = await database.delete(loans).where(inArray(loans.loanId, crashedLoanIds)).returning({ loanId: loans.loanId });
    console.log(`pre-start: removed ${removed.length} loan(s) created by a crashed run (only-snapshot marker at ${AS_OF})`);
  }

  const leftoverUsers = await database
    .select({ id: users.id, username: users.username, passwordHash: users.passwordHash })
    .from(users)
    .where(inArray(users.username, [MANAGER, OFFICER]));
  for (const user of leftoverUsers) {
    if (verifyPassword(user.passwordHash, PASSWORD)) {
      await database.delete(users).where(eq(users.id, user.id));
      console.log(`pre-start: removed leftover test user ${user.username}`);
    } else {
      failUnless(
        false,
        `an app_user named '${user.username}' exists but does not have import-check's password; refusing to touch it`
      );
    }
  }

  // A sentinel loan from a crashed run is provably ours: either it carries the
  // script-namespaced borrower name or the script-only SENTINEL_DATE snapshot.
  const priorSentinelSnapshots = await database
    .select({ loanId: loanSnapshots.loanId })
    .from(loanSnapshots)
    .where(and(eq(loanSnapshots.asOf, SENTINEL_DATE), eq(loanSnapshots.loanId, SENTINEL_LOAN)));
  const priorSentinel = (await database.select().from(loans).where(eq(loans.loanId, SENTINEL_LOAN)).limit(1))[0];
  if (priorSentinelSnapshots.length > 0 || priorSentinel?.borrowerName === 'Seed-Sentinel') {
    await database
      .delete(loanSnapshots)
      .where(and(eq(loanSnapshots.asOf, SENTINEL_DATE), eq(loanSnapshots.loanId, SENTINEL_LOAN)));
    await database.delete(loans).where(eq(loans.loanId, SENTINEL_LOAN));
    console.log('pre-start: removed leftover sentinel loan from a crashed run');
  }

  for (const branch of BRANCHES) {
    const row = (
      await database
        .select({ id: branches.id })
        .from(branches)
        .where(eq(sql`lower(${branches.name})`, branch.name.toLowerCase()))
        .limit(1)
    )[0];
    if (!row) {
      continue;
    }
    const refs = await database.execute(sql`
      select exists(select 1 from officer where branch_id = ${row.id})
          or exists(select 1 from territory where branch_id = ${row.id})
          or exists(select 1 from app_user where branch_id = ${row.id})
          or exists(select 1 from loan where branch_id = ${row.id})
          or exists(select 1 from loan_snapshot where branch_id = ${row.id}) as has_refs
    `);
    if (refs.rows[0] && (refs.rows[0] as { has_refs: boolean }).has_refs === false) {
      await database.delete(branches).where(eq(branches.id, row.id));
      console.log(`pre-start: removed unreferenced leftover branch ${branch.name} from a crashed run`);
    }
  }

  // --- setup: branches (track created ids; reuse seed branches) ------------
  const branchByName = new Map<string, string>();
  for (const branch of BRANCHES) {
    const nameLower = branch.name.toLowerCase();
    const existing = (
      await database
        .select({ id: branches.id })
        .from(branches)
        .where(eq(sql`lower(${branches.name})`, nameLower))
        .limit(1)
    )[0];
    if (existing) {
      branchByName.set(nameLower, existing.id);
    } else {
      const inserted = await database.insert(branches).values(branch).returning({ id: branches.id });
      state.branchIds.push(inserted[0]!.id);
      branchByName.set(nameLower, inserted[0]!.id);
    }
  }
  const ujjainId = branchByName.get('ujjain')!;

  // --- setup: sentinel seed-lookalike (injected BEFORE capture, so it is
  // captured as pre-existing and restored at cleanup, never mass-deleted) ----
  // If the seed already owns this loan id, skip the injection: the real seed
  // row exercises the same restore-on-collision path (and must not be touched).
  const sentinelExists = (
    await database.select({ loanId: loans.loanId }).from(loans).where(eq(loans.loanId, SENTINEL_LOAN)).limit(1)
  ).length > 0;
  if (!sentinelExists) {
    await database.insert(loans).values({
      loanId: SENTINEL_LOAN,
      borrowerName: 'Seed-Sentinel',
      pincode: '452001',
      branchId: ujjainId,
      outstanding: 1000000,
      overdueAmount: 11000,
      dpd: 11,
      bucket: '1-30',
      status: 'overdue',
      isDemo: false
    });
    await database.insert(loanSnapshots).values({
      asOf: SENTINEL_DATE,
      loanId: SENTINEL_LOAN,
      branchId: ujjainId,
      dpd: 11,
      bucket: '1-30',
      outstanding: 1000000
    });
    state.sentinelInjected = true;
    console.log(`pre-start: injected sentinel seed-lookalike loan ${SENTINEL_LOAN} (borrower=Seed-Sentinel, dpd=11)`);
  } else {
    console.log(`pre-start: seed already owns ${SENTINEL_LOAN}; using it as the restore-on-collision sentinel`);
  }

  // --- capture pre-existing rows the seed owns (restored, never deleted) ---
  state.preExistingLoans = await database.select().from(loans).where(inArray(loans.loanId, state.fixtureLoanIds));
  state.preExistingSnapshots = await database.select().from(loanSnapshots).where(eq(loanSnapshots.asOf, AS_OF));

  // --- setup: users (track created ids) ------------------------------------
  const insertedUsers = await database
    .insert(users)
    .values([
      { username: MANAGER, passwordHash: hashPassword(PASSWORD), role: 'branch_manager', branchId: ujjainId, active: true },
      { username: OFFICER, passwordHash: hashPassword(PASSWORD), role: 'field_officer', branchId: ujjainId, active: true }
    ])
    .returning({ id: users.id });
  state.userIds = insertedUsers.map((u) => u.id);
  const managerCookie = await loginCookie(MANAGER, PASSWORD);
  const officerCookie = await loginCookie(OFFICER, PASSWORD);

  // --- helpers --------------------------------------------------------------
  const post = async (filename: string, bytes: Uint8Array, asOf?: string, auth: string = managerCookie): Promise<Response> => {
    const form = new FormData();
    form.append('file', new File([bytes], filename, { type: 'text/csv' }));
    if (asOf !== undefined) {
      form.append('as_of', asOf);
    }
    return app.request('/api/import', { method: 'POST', body: form, headers: { cookie: auth } });
  };
  const importJson = async (res: Response): Promise<ImportJsonResult> => (await res.json()) as ImportJsonResult;
  const batchCount = async (): Promise<number> =>
    (await database.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.asOf, AS_OF))).length;
  const snapshotCountAtAsOf = async (): Promise<number> =>
    (await database.select({ loanId: loanSnapshots.loanId }).from(loanSnapshots).where(eq(loanSnapshots.asOf, AS_OF))).length;
  const snapshotDpd = async (loanId: string): Promise<number | null> => {
    const rows = await database
      .select({ dpd: loanSnapshots.dpd })
      .from(loanSnapshots)
      .where(and(eq(loanSnapshots.asOf, AS_OF), eq(loanSnapshots.loanId, loanId)))
      .limit(1);
    return rows[0]?.dpd ?? null;
  };

  // Independent cross-check of the late_discovery rule (A20), derived from the
  // CSV bytes and the database's own previous snapshot — not from planImport.
  const expectedLateDiscovery = async (fileBytes: Uint8Array): Promise<{ loanId: string; dpd: number }[]> => {
    const previousDateRows = (await database.execute(
      sql`select max(as_of) as as_of from import_batch where as_of < ${AS_OF}`
    )).rows as { as_of: string | null }[];
    const previousDate = previousDateRows[0]?.as_of ?? null;
    if (previousDate === null) {
      return [];
    }
    const previousSnapshots = await database
      .select({ loanId: loanSnapshots.loanId })
      .from(loanSnapshots)
      .where(eq(loanSnapshots.asOf, previousDate));
    const previousIds = new Set(previousSnapshots.map((s) => s.loanId));
    const flagged: { loanId: string; dpd: number }[] = [];
    for (const line of new TextDecoder().decode(fileBytes).split(/\r?\n/).slice(1)) {
      if (line.trim() === '') {
        continue;
      }
      const cells = parseCsvLine(line);
      const loanId = cells[0] ?? '';
      const dpd = Number.parseInt(cells[4] ?? '', 10);
      if (loanId === '' || Number.isNaN(dpd)) {
        continue;
      }
      if (!previousIds.has(loanId) && dpd > 30 && previousIds.size > 0) {
        flagged.push({ loanId, dpd });
      }
    }
    return flagged;
  };
  const printLateDiscovery = (flagged: { loanId: string; dpd: number }[]): void => {
    if (flagged.length === 0) {
      console.log('           late_discovery flagged: none (A20: first-ever import at this date — no previous snapshot, nothing can be late)');
      return;
    }
    console.log(`           late_discovery flagged: ${flagged.length} (A20 rule: absent from previous snapshot + dpd > 30)`);
    for (const { loanId, dpd } of flagged) {
      console.log(`             ${loanId}  dpd=${dpd}`);
    }
  };

  // --- probes ---------------------------------------------------------------
  console.log('probe   POST /api/import with no credentials -> expect 401');
  failUnless((await app.request('/api/import', { method: 'POST' })).status === 401, 'expected 401 without credentials');

  console.log('probe   POST /api/import as a field officer -> expect 403 (manager only)');
  const officerRes = await post('sample_overdue.csv', bytesOf('data/sample_overdue.csv'), AS_OF, officerCookie);
  failUnless(officerRes.status === 403, `expected 403 for a field officer, got ${officerRes.status}`);

  console.log('probe   POST /api/import with as_of=2026-02-30 -> expect 400 (not a real calendar date)');
  const badDate = await post('sample_overdue.csv', bytesOf('data/sample_overdue.csv'), '2026-02-30');
  failUnless(badDate.status === 400, `expected 400 for an impossible as_of, got ${badDate.status}`);

  console.log('probe   POST /api/import with a .txt upload -> expect 415 (extension + MIME check)');
  const badType = await post('notes.txt', bytesOf('data/sample_overdue.csv'), AS_OF);
  failUnless(badType.status === 415, `expected 415 for a .txt upload, got ${badType.status}`);

  // --- deliberate-failure demo ----------------------------------------------
  if (process.env.IMPORT_CHECK_FAIL === '1') {
    console.log('');
    console.log('deliberate failure (IMPORT_CHECK_FAIL=1): proving a failed assertion exits non-zero; cleanup still runs in finally');
    failUnless(false, 'deliberate failure: proving non-zero exit on assertion');
  }

  // --- phases ----------------------------------------------------------------
  console.log('');
  console.log('late_discovery rule (A20 in docs/assumptions.md): a loan absent from the previous snapshot with DPD > 30');
  console.log('  is tagged late_discovery ONLY when a previous snapshot exists (previousCount > 0);');
  console.log('  on a first-ever import (no previous snapshot) nothing can be late.');
  console.log('');

  console.log(`phase 1/5  sample_overdue.csv   as_of=${AS_OF}  -> expect imported, lateDiscovery=0 (first-ever import)`);
  const first = await importJson(await post('sample_overdue.csv', bytesOf('data/sample_overdue.csv'), AS_OF));
  failUnless(first.status === 'imported' && first.batchId !== undefined, `phase 1: expected imported, got ${JSON.stringify(first)}`);
  state.batchIds.push(first.batchId!);
  const flagged1 = await expectedLateDiscovery(bytesOf('data/sample_overdue.csv'));
  failUnless(
    first.report.lateDiscovery === 0 && flagged1.length === 0,
    `phase 1: expected lateDiscovery=0 on a first-ever import (A20), report=${first.report.lateDiscovery}, expected set=${flagged1.length}`
  );
  printReport(first.report);
  printLateDiscovery(flagged1);
  console.log('           loans above 30 dpd in file: none (brief sample values are dpd 12, 27, 19) — lateDiscovery=0 (A20)');

  console.log('phase 2/5  sample_overdue.csv   (same bytes) -> expect noop, previous report replayed, nothing written');
  const second = await importJson(await post('sample_overdue.csv', bytesOf('data/sample_overdue.csv'), AS_OF));
  failUnless(second.status === 'noop', `phase 2: expected noop, got ${JSON.stringify(second)}`);
  failUnless(second.batchId === first.batchId, 'phase 2: noop must return the previous batch id');
  failUnless(stableJson(second.report) === stableJson(first.report), 'phase 2: noop must replay the previous report');
  failUnless((await batchCount()) === 1, 'phase 2: noop must not add a batch row');

  console.log(`phase 3/5  bad_rows.csv         as_of=${AS_OF}  -> expect replace with partial acceptance`);
  const third = await importJson(await post('bad_rows.csv', bytesOf('data/bad_rows.csv'), AS_OF));
  failUnless(third.status === 'replaced', `phase 3: expected replaced, got ${JSON.stringify(third)}`);
  failUnless(
    third.report.imported === 42 && third.report.dropped === 4,
    `phase 3: expected 42 imported / 4 dropped, got ${JSON.stringify(third.report)}`
  );
  failUnless(third.report.errors === 4, `phase 3: expected 4 row errors (under the 20 percent abort), got ${third.report.errors}`);
  failUnless((await batchCount()) === 1, 'phase 3: replace must leave exactly one batch for the date');
  state.batchIds.push(third.batchId!);
  const flagged3 = await expectedLateDiscovery(bytesOf('data/bad_rows.csv'));
  failUnless(
    third.report.lateDiscovery === flagged3.length,
    `phase 3: lateDiscovery mismatch: report=${third.report.lateDiscovery}, independent check=${flagged3.length}`
  );
  printReport(third.report);
  printLateDiscovery(flagged3);

  console.log(`phase 4/5  abort_rows.csv       as_of=${AS_OF}  -> expect abort, nothing written`);
  const fourthRes = await post('abort_rows.csv', bytesOf('data/abort_rows.csv'), AS_OF);
  const fourth = await importJson(fourthRes);
  failUnless(fourthRes.status === 422 && fourth.status === 'rejected', `phase 4: expected 422 rejected, got ${fourthRes.status} ${JSON.stringify(fourth)}`);
  failUnless(fourth.abort?.code === 'error_rate', `phase 4: expected an error_rate abort, got ${JSON.stringify(fourth.abort)}`);
  failUnless((await batchCount()) === 1, 'phase 4: an aborted import must not write a batch');
  failUnless(
    (await database.select({ loanId: loans.loanId }).from(loans).where(eq(loans.loanId, 'LN-60001'))).length === 0,
    'phase 4: an aborted import must not write loans'
  );
  console.log(`           abort: ${fourth.abort!.code} (${fourth.abort!.message})`);

  console.log(`phase 5/5  bad_rows variant     as_of=${AS_OF}  -> expect replace (same date, different bytes)`);
  const variant = variantBytes();
  const fifth = await importJson(await post('bad_rows_v2.csv', variant, AS_OF));
  failUnless(fifth.status === 'replaced', `phase 5: expected replaced, got ${JSON.stringify(fifth)}`);
  failUnless(fifth.batchId !== third.batchId, 'phase 5: replace must write a new batch id');
  failUnless((await batchCount()) === 1, 'phase 5: replace must leave exactly one batch for the date');
  const variantDpd = await snapshotDpd(SENTINEL_LOAN);
  failUnless(variantDpd === 4, `phase 5: replace must store the variant DPD: expected loan_snapshot(${SENTINEL_LOAN}).dpd=4, got ${variantDpd}`);
  const loanDpd = (await database.select({ dpd: loans.dpd }).from(loans).where(eq(loans.loanId, SENTINEL_LOAN)).limit(1))[0]?.dpd;
  failUnless(loanDpd === 4, `phase 5: replace must update the loan row: expected loan(${SENTINEL_LOAN}).dpd=4, got ${loanDpd}`);
  const snapshotCount = await snapshotCountAtAsOf();
  failUnless(
    snapshotCount === fifth.report.imported,
    `phase 5: replace must not double loan_snapshot rows for ${AS_OF}: expected ${fifth.report.imported}, got ${snapshotCount}`
  );
  console.log(`           replace proof: loan_snapshot(${SENTINEL_LOAN}).dpd=4 (was 3), loan_snapshot rows at ${AS_OF}=${snapshotCount} (not ${snapshotCount * 2})`);
  state.batchIds.push(fifth.batchId!);
  printReport(fifth.report);
  const flagged5 = await expectedLateDiscovery(variant);
  failUnless(
    fifth.report.lateDiscovery === flagged5.length,
    `phase 5: lateDiscovery mismatch: report=${fifth.report.lateDiscovery}, independent check=${flagged5.length}`
  );
  printLateDiscovery(flagged5);

  console.log('phase +    GET /api/import/:id/errors.csv -> expect csv with excel row numbers and loan ids');
  const errorsRes = await app.request(`/api/import/${fifth.batchId}/errors.csv`, { headers: { cookie: managerCookie } });
  failUnless(errorsRes.status === 200, `errors.csv: expected 200, got ${errorsRes.status}`);
  failUnless((errorsRes.headers.get('content-type') ?? '').includes('text/csv'), `errors.csv: expected text/csv, got ${errorsRes.headers.get('content-type')}`);
  const lines = (await errorsRes.text()).trimEnd().split('\n');
  failUnless(lines[0] === 'row_no,loan_id,source_column,code,severity,message', `errors.csv: unexpected header ${lines[0]}`);
  const dataRows = lines.slice(1).map((line) => line.split(','));
  failUnless(dataRows.length === fifth.report.errors + fifth.report.warnings, `errors.csv: expected ${fifth.report.errors + fifth.report.warnings} rows, got ${dataRows.length}`);
  failUnless(dataRows.every((cells) => /^\d+$/.test(cells[0]!) && Number(cells[0]) >= 2), 'errors.csv: row numbers must be excel numbers >= 2');
  failUnless(dataRows.some((cells) => cells[2] === 'loan_id' && cells[3] === 'duplicate_loan_id' && cells[1] === 'LN-50001'), 'errors.csv: expected the duplicate row error carrying its loan id');
  failUnless(dataRows.some((cells) => cells[2] === 'mobile' && cells[4] === 'warning'), 'errors.csv: expected the mobile warning stored with severity warning');
  console.log(`           errors.csv: ${dataRows.length} rows, excel row numbers ${dataRows.map((cells) => cells[0]).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Cleanup — deletes only rows this run can prove it created; safe after seed.
// Runs from the finally block on every path, including assertion failures.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Cleanup — deletes only rows this run can prove it created; safe after seed.
// Runs from the finally block on every path, including assertion failures.
// Order matters: children are removed before the rows they reference, so
// branch (referenced by loan / loan_snapshot / app_user) goes last.
// ---------------------------------------------------------------------------
async function cleanup(database: Db): Promise<void> {
  const rowErrors = state.batchIds.length > 0
    ? await database.delete(importRowErrors).where(inArray(importRowErrors.batchId, state.batchIds)).returning({ id: importRowErrors.id })
    : [];

  // import_batch: delete ONLY tracked ids. Replace consumes the previous batch
  // for the date inside applyImport's own transaction, so only the newest
  // tracked batch can still exist here; every deleted row is a tracked id
  // (inArray), so nothing foreign can be touched.
  const batchRows = state.batchIds.length > 0
    ? await database.delete(importBatches).where(inArray(importBatches.id, state.batchIds)).returning({ id: importBatches.id })
    : [];
  failUnless(batchRows.length <= state.batchIds.length, `cleanup: deleted ${batchRows.length} batches but tracked only ${state.batchIds.length}`);

  // loan_snapshot: every row at the test date is script-created (a non-test
  // batch at that date is refused at start), so a date-scoped delete is safe.
  const snapshotRows = await database.delete(loanSnapshots).where(eq(loanSnapshots.asOf, AS_OF)).returning({ loanId: loanSnapshots.loanId });

  // assignment_log: every row at the script's own test date is script-created
  // (the runner stamps runDate = as_of = AS_OF); date-scoped delete, before
  // the loan deletes below because the log references loans.
  const assignmentLogRows = await database
    .delete(assignmentLog)
    .where(eq(assignmentLog.runDate, AS_OF))
    .returning({ loanId: assignmentLog.loanId });

  // loan: delete ONLY fixture loan_ids that did not exist at start. Dropped
  // and aborted rows never become loans, so only a subset of these ids can
  // exist; ownership is proven by the tracked-id list itself, and the safety
  // property that matters is that none of them remain afterwards.
  const preExistingIds = new Set(state.preExistingLoans.map((row) => row.loanId));
  const createdLoanIds = state.fixtureLoanIds.filter((loanId) => !preExistingIds.has(loanId));
  const deletedLoans = createdLoanIds.length > 0
    ? await database.delete(loans).where(inArray(loans.loanId, createdLoanIds)).returning({ loanId: loans.loanId })
    : [];
  failUnless(deletedLoans.length <= createdLoanIds.length, `cleanup: deleted ${deletedLoans.length} loans but tracked only ${createdLoanIds.length}`);
  const remainingCreatedLoans = createdLoanIds.length > 0
    ? await database.select({ loanId: loans.loanId }).from(loans).where(inArray(loans.loanId, createdLoanIds))
    : [];
  failUnless(remainingCreatedLoans.length === 0, `cleanup: ${remainingCreatedLoans.length} loan(s) created by this run remain`);

  // loan: restore every pre-existing loan column-for-column (seed safety).
  for (const loanRow of state.preExistingLoans) {
    const restored = await database.update(loans).set(loanRow).where(eq(loans.loanId, loanRow.loanId)).returning({ loanId: loans.loanId });
    failUnless(restored.length === 1, `cleanup: pre-existing loan ${loanRow.loanId} could not be restored`);
  }

  // audit_log: rows whose actor is one of this run's app_user names. Those
  // usernames exist only because this script created them (uniqueness is
  // enforced, and a colliding user with a different password refuses the run
  // at start), so every matching audit row belongs to import-check.
  const auditRows = await database.delete(auditLog).where(inArray(auditLog.actor, [MANAGER, OFFICER])).returning({ id: auditLog.id });

  // Sentinel: injected before capture, so the restore loop above already put
  // its seed-lookalike values back. Prove the restore worked, then remove it
  // as a tracked creation of this run (a real seed row would never match the
  // Seed-Sentinel marker and is left exactly as the seed wrote it).
  let sentinelDeleted = 0;
  if (state.sentinelInjected) {
    const sentinel = await database.select().from(loans).where(eq(loans.loanId, SENTINEL_LOAN)).limit(1);
    failUnless(
      sentinel[0]?.borrowerName === 'Seed-Sentinel' && sentinel[0]?.dpd === 11 && sentinel[0]?.isDemo === false,
      `cleanup: sentinel loan was not restored to its seed-lookalike values: ${JSON.stringify(sentinel[0])}`
    );
    console.log('           sentinel: restore-on-collision proved (borrower=Seed-Sentinel, dpd=11, isDemo=false survived the import)');
    const sentinelSnapshotRows = await database
      .delete(loanSnapshots)
      .where(and(eq(loanSnapshots.asOf, SENTINEL_DATE), eq(loanSnapshots.loanId, SENTINEL_LOAN)))
      .returning({ loanId: loanSnapshots.loanId });
    const sentinelLoanRows = await database.delete(loans).where(eq(loans.loanId, SENTINEL_LOAN)).returning({ loanId: loans.loanId });
    sentinelDeleted = sentinelSnapshotRows.length + sentinelLoanRows.length;
  }

  // app_user: delete ONLY the ids this run inserted (tracked at insert time).
  const userRows = state.userIds.length > 0
    ? await database.delete(users).where(inArray(users.id, state.userIds)).returning({ id: users.id })
    : [];
  failUnless(userRows.length === state.userIds.length, `cleanup: deleted ${userRows.length} app_user rows but tracked ${state.userIds.length}`);
  // login_attempt: throttle keys are username|client-ip (A30). This run logs
  // its users in through POST /api/auth/login, so drop any throttle rows
  // keyed on them (normally zero: a successful login deletes its own row).
  // session rows die with the users above via the FK cascade.
  const attemptRows = await database.execute(
    sql`delete from login_attempt where key = ${MANAGER + '|unknown'} or key = ${OFFICER + '|unknown'}`
  );

  // branch: delete ONLY the ids this run inserted (tracked at insert time).
  // A seed branch that already existed is never in state.branchIds.
  const branchRows = state.branchIds.length > 0
    ? await database.delete(branches).where(inArray(branches.id, state.branchIds)).returning({ id: branches.id })
    : [];
  failUnless(branchRows.length === state.branchIds.length, `cleanup: deleted ${branchRows.length} branch rows but tracked ${state.branchIds.length}`);

  // Final cleanliness assertions: nothing of ours survives.
  failUnless((await database.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.asOf, AS_OF))).length === 0, `cleanup: import_batch rows remain at ${AS_OF}`);
  failUnless((await database.select({ loanId: loanSnapshots.loanId }).from(loanSnapshots).where(eq(loanSnapshots.asOf, AS_OF))).length === 0, `cleanup: loan_snapshot rows remain at ${AS_OF}`);
  failUnless((await database.select({ loanId: assignmentLog.loanId }).from(assignmentLog).where(eq(assignmentLog.runDate, AS_OF))).length === 0, `cleanup: assignment_log rows remain at ${AS_OF}`);
  const remainingCreatedUsers = state.userIds.length > 0
    ? await database.select({ id: users.id }).from(users).where(inArray(users.id, state.userIds))
    : [];
  failUnless(remainingCreatedUsers.length === 0, 'cleanup: app_user rows created by this run remain');

  // Restore pre-existing snapshots at the test date (belt and braces; normally zero).
  for (const snapshotRow of state.preExistingSnapshots) {
    await database.insert(loanSnapshots).values(snapshotRow).onConflictDoNothing();
  }

  console.log(
    `cleanup: import_row_error=${rowErrors.length} import_batch=${batchRows.length} loan_snapshot=${snapshotRows.length} ` +
      `assignment_log=${assignmentLogRows.length} loan deleted=${deletedLoans.length} loan restored=${state.preExistingLoans.length} ` +
      `sentinel rows removed=${sentinelDeleted} audit_log=${auditRows.length} app_user=${userRows.length} branch=${branchRows.length} ` +
      `login_attempt=${attemptRows.rowCount ?? 0}`
  );
}
