/**
 * `pnpm seed -- --seed N --as-of today|YYYY-MM-DD [--yes] [--reset]`
 *
 * Seed part 1 (SPEC 14 + 20; prompt 8): fictional people, territory, demo
 * accounts and 90 days of loan history written as one CSV per non-Sunday day
 * into data/generated/ (gitignored) and imported IN CHRONOLOGICAL ORDER
 * through the real applyImport — snapshots, assignments and cleared loans are
 * produced by production code, never by seed-side table writes. Events and
 * promises are deliberately absent (seed part 2).
 *
 * Safety: the target database host is printed before anything happens; --yes
 * is required; DEMO_MODE must be on; non-demo rows (is_demo=false) or import
 * batches newer than the window refuse the run unless --reset; --reset
 * replays the A17 path (one transaction, audit row first, single TRUNCATE
 * over the config's closure-complete table list). This script never runs
 * during a build — it is a local-only tool.
 */
import { readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inArray } from 'drizzle-orm';
import { closePool, getDb, getPool, withTx } from '../../src/server/db.js';
import { territory as territoryTable } from '../../src/server/db/schema.js';
import { applyImport } from '../../src/server/import/applyImport.js';
import { demoModeEnabled } from '../../src/server/demo.js';
import { loadSeedConfigFile } from './config.js';
import { buildHistory, dateAtOffset, type HistoryResult } from './history.js';
import { buildLoanUniverse, briefLoanDefinitions, BRANCH_NAMES } from './loans.js';
import { importAllHistory, type ImportAllOutcome } from './importAll.js';
import { mulberry32 } from './rng.js';
import { upsertStaff } from './staff.js';
import {
  cohortSanitySql,
  formatBucketMix,
  formatCohortResults,
  formatDemoAccounts,
  formatOfficerCounts,
  type BucketRow,
  type CohortRow,
  type DemoAccountRow,
  type OfficerCountRow
} from './summary.js';
import { buildTerritoryRows, territoryOfficerIds } from './territory.js';
import { decideRun, parseSeedArgs, resetDemoData, resolveAsOf, type DataOverview } from './gates.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const IMPORT_ACTOR_USERNAME = 'kavita.rathore'; // A44: the Indore branch manager imports every file

function weekdayName(date: string): string {
  return WEEKDAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

function targetDatabase(): { host: string; database: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is not set; the seed needs the target database connection (local .env)');
  }
  const url = new URL(raw);
  return { host: url.host, database: url.pathname.replace(/^\//, '') };
}

interface DatabaseOverviewQuery {
  hasAnyRow: boolean;
  allDemo: boolean;
  latestImportDate: string | null;
}

async function readDatabaseOverview(): Promise<DatabaseOverviewQuery> {
  const pool = getPool();
  let loanRows: Record<string, unknown>[];
  try {
    loanRows = (await pool.query('SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT is_demo)::int AS non_demo FROM loan')).rows;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42P01') {
      throw new Error('the loan table does not exist yet; run pnpm db:migrate against this database first', { cause: error });
    }
    throw new Error('reading the seed-safety overview from the target database failed', { cause: error });
  }
  const batchRows = (await pool.query('SELECT max(as_of)::text AS latest FROM import_batch')).rows;
  const total = Number(loanRows[0]?.n ?? 0);
  const nonDemo = Number(loanRows[0]?.non_demo ?? 0);
  const latest = batchRows[0]?.latest;
  return {
    hasAnyRow: total > 0,
    allDemo: nonDemo === 0,
    latestImportDate: typeof latest === 'string' && latest !== '' ? latest.slice(0, 10) : null
  };
}

async function writeTerritory(
  db: ReturnType<typeof getDb>,
  config: ReturnType<typeof loadSeedConfigFile>,
  staff: Awaited<ReturnType<typeof upsertStaff>>
): Promise<number> {
  // A50: the map includes the demo officers — their territory slices are what
  // lets the planner ever route a loan to them (an officer with no territory
  // row receives nothing, which left the demo worklist empty). Their ids
  // arrive keyed by username (ensureDemoAccounts) and are rekeyed to the
  // officer names the plan uses — see territoryOfficerIds.
  const officerIdByName = territoryOfficerIds(staff);
  const rows = buildTerritoryRows(config, officerIdByName);
  const officerIds = Object.values(officerIdByName);
  // Idempotent repair without --reset: rows written by an earlier seed plan
  // for these officers are removed, then the current plan is inserted.
  if (officerIds.length > 0) {
    await db.delete(territoryTable).where(inArray(territoryTable.officerId, officerIds));
  }
  await db.insert(territoryTable).values(
    rows.map((row) => ({
      branchId: staff.branchIdByCode[row.branchCode]!,
      pincode: row.pincode,
      locality: row.locality,
      officerId: officerIdByName[row.officerName]!,
      rank: 1
    }))
  );
  return rows.length;
}

function writeGeneratedFiles(history: HistoryResult): { dir: string; count: number; first: string; last: string } {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/generated');
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.csv')) {
      rmSync(path.join(dir, entry));
    }
  }
  for (const file of history.files) {
    writeFileSync(path.join(dir, file.filename), file.csv);
  }
  return { dir, count: history.files.length, first: history.files[0]!.date, last: history.files[history.files.length - 1]!.date };
}

interface SummaryQueries {
  officerRows: OfficerCountRow[];
  queued: number;
  cleared: number;
  overdue: number;
  buckets: BucketRow[];
  cohortRows: CohortRow[];
  demoRows: DemoAccountRow[];
}

async function readSummary(t0: string, asOf: string): Promise<SummaryQueries> {
  const pool = getPool();
  const officerRowSets = await pool.query(
    `SELECT b.name AS branch, COALESCE(o.name, '(unassigned)') AS officer, count(*)::int AS loans
     FROM loan l
     JOIN branch b ON b.id = l.branch_id
     LEFT JOIN officer o ON o.id = l.assigned_officer_id
     WHERE l.status = 'overdue'
     GROUP BY 1, 2
     ORDER BY 1, 2`
  );
  const statusRow = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'overdue')::int AS overdue,
              count(*) FILTER (WHERE status = 'queue')::int AS queue,
              count(*) FILTER (WHERE status = 'cleared')::int AS cleared
       FROM loan`
    )
  ).rows[0]!;
  const bucketRows = await pool.query(
    // The active book: assigned overdue + the branch-manager queue (A24).
    `SELECT bucket, count(*)::int AS loans FROM loan WHERE status IN ('overdue', 'queue') GROUP BY 1 ORDER BY 1`
  );
  const cohortResult = await pool.query(cohortSanitySql(t0, asOf));
  // A50: the demo chips' officer link and worklist, printed explicitly so an
  // empty demo officer account names itself instead of hiding in the table.
  const demoResult = await pool.query(
    `SELECT u.username, u.role,
            COALESCE(o.name, '(NO OFFICER LINK)') AS officer_name,
            count(l.loan_id) FILTER (WHERE l.status = 'overdue')::int AS worklist,
            count(l.loan_id)::int AS assigned_any
     FROM app_user u
     LEFT JOIN officer o ON o.id = u.officer_id
     LEFT JOIN loan l ON l.assigned_officer_id = u.officer_id
     WHERE u.is_demo = true AND u.username IN ('demo-manager', 'demo-officer-1', 'demo-officer-2')
     GROUP BY u.username, u.role, o.name
     ORDER BY u.username`
  );
  return {
    officerRows: officerRowSets.rows.map((row) => ({
      branch: String(row.branch),
      officer: String(row.officer),
      loans: Number(row.loans)
    })),
    queued: Number(statusRow.queue),
    cleared: Number(statusRow.cleared),
    overdue: Number(statusRow.overdue),
    buckets: bucketRows.rows.map((row) => ({ bucket: String(row.bucket), loans: Number(row.loans) })),
    cohortRows: cohortResult.rows.map((row) => ({
      branch: String(row.branch),
      cohortN: Number(row.cohort_n),
      cured: Number(row.cured),
      stayed: Number(row.stayed),
      rolled: Number(row.rolled)
    })),
    demoRows: demoResult.rows.map((row) => ({
      username: String(row.username),
      role: String(row.role) as 'field_officer' | 'branch_manager',
      officerName: String(row.officer_name),
      worklist: Number(row.worklist),
      assignedAny: Number(row.assigned_any)
    }))
  };
}

function printSummary(
  outcome: ImportAllOutcome,
  history: HistoryResult,
  queries: SummaryQueries,
  totalEndActive: number,
  asOf: string
): void {
  const statusCounts = new Map<string, number>();
  for (const batch of outcome.batches) {
    statusCounts.set(batch.status, (statusCounts.get(batch.status) ?? 0) + 1);
  }
  const statusText = [...statusCounts.entries()].map(([status, count]) => `${count} ${status}`).join(', ');
  const assignmentText = Object.entries(outcome.assignmentTotals)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(' · ');

  console.log('');
  console.log('==== seed summary ====');
  console.log('loans per branch and officer (status=overdue):');
  for (const line of formatOfficerCounts(queries.officerRows, queries.queued, queries.cleared)) {
    console.log(line);
  }
  console.log('');
  for (const line of formatDemoAccounts(queries.demoRows)) {
    console.log(line);
  }
  console.log('');
  console.log('DPD bucket mix (overdue):');
  for (const line of formatBucketMix(queries.buckets, totalEndActive)) {
    console.log(line);
  }
  console.log('');
  console.log(
    `files imported: ${outcome.batches.length} (${statusText}) · warnings ${outcome.totals.warnings} · ` +
      `row errors ${outcome.totals.errors} · aborts 0 (any abort fails the run)`
  );
  console.log(`assignment outcome totals: ${assignmentText}`);
  console.log('');
  console.log(`cohort sanity (t0 = ${history.t0Date} snapshot, end = last snapshot):`);
  console.log(cohortSanitySql(history.t0Date, asOf));
  console.log('');
  for (const line of formatCohortResults(queries.cohortRows)) {
    console.log(line);
  }
}

async function main(): Promise<void> {
  // pnpm forwards the `--` separator as a literal first argument
  // (`pnpm seed -- --seed 20261105 --as-of today`); drop exactly that one.
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv;
  const args = parseSeedArgs(argv);
  const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/seed_config.yaml');
  const config = loadSeedConfigFile(configPath);
  const asOf = resolveAsOf(args.asOfRequest, new Date().toISOString().slice(0, 10));
  const windowStart = dateAtOffset(asOf, config.history.window_days - 1);
  const t0 = dateAtOffset(asOf, config.history.cohort_days_before_end);
  const target = targetDatabase();

  console.log(
    `[seed] seed ${args.seed} · as-of ${asOf} (${weekdayName(asOf)}) · window ${windowStart} .. ${asOf} · ` +
      `cohort day t0 ${t0} (${weekdayName(t0)})`
  );
  console.log(
    `[seed] target database: ${target.host}/${target.database} · DEMO_MODE=${demoModeEnabled() ? 'true' : 'false'}`
  );
  const overview: DataOverview = await readDatabaseOverview();
  console.log(
    `[seed] database check: ${overview.hasAnyRow ? 'has loan rows' : 'no loan rows'} · ` +
      `${overview.allDemo ? 'demo-only' : 'NON-DEMO ROWS PRESENT'} · latest import batch: ${overview.latestImportDate ?? 'none'}`
  );

  const decision = decideRun({
    asOf,
    cohortDaysBeforeEnd: config.history.cohort_days_before_end,
    yes: args.yes,
    resetRequested: args.reset,
    demoMode: demoModeEnabled(),
    data: overview
  });
  if (decision.action === 'refuse') {
    for (const reason of decision.reason!.split('; ')) {
      console.log(`[seed] REFUSED: ${reason}`);
    }
    process.exitCode = 1;
    return;
  }

  if (decision.reset) {
    console.log(`[seed] reset: truncating ${config.seed.reset_tables.length} tables (audit row first, one transaction)…`);
    await resetDemoData({ run: withTx }, { seed: args.seed, asOf, tables: config.seed.reset_tables });
  } else {
    console.log('[seed] reset: skipped (not requested)');
  }

  const db = getDb();
  const staff = await upsertStaff(db, config.people.officer_capacity_points);
  console.log(
    `[seed] people: ${Object.keys(staff.branchIdByCode).length} branches · 9 officers · 3 managers · ` +
      `demo chips ${staff.demoUsernames.length} (${staff.demoUsernames.join(', ')})`
  );
  const territoryCount = await writeTerritory(db, config, staff);
  console.log(`[seed] territory: ${territoryCount} rows (rank 1; the planner's tier rules do the routing)`);

  const universe = buildLoanUniverse(mulberry32(args.seed), config, args.seed);
  const briefs = briefLoanDefinitions(universe, config);
  console.log(
    `[seed] universe: ${universe.loans.length} loans · end-active ${config.loans.total_end_active} ` +
      `(Indore ${config.loans.per_branch_indore}, Ujjain city ${config.loans.per_branch_ujjain_city}, ` +
      `Ratlam ${config.loans.per_branch_ratlam}, Dewas ${config.loans.per_branch_dewas}) · ` +
      `cohort ${config.history.cohort_count_indore + config.history.cohort_count_ujjain_branch + config.history.cohort_count_dewas}`
  );
  console.log(
    `[seed] brief loans pinned: ${briefs.map((brief) => `${brief.loanId} (dpd ${brief.briefEndDpd})`).join(', ')}`
  );

  const history = buildHistory(mulberry32(args.seed + 1), config, universe, asOf);
  const written = writeGeneratedFiles(history);
  console.log(`[seed] files: ${written.count} CSVs in data/generated (${written.first} .. ${written.last}, Sundays skipped)`);

  const actor = { userId: staff.userIdByUsername[IMPORT_ACTOR_USERNAME]!, username: IMPORT_ACTOR_USERNAME };
  console.log(`[seed] import: ${written.count} files through the real applyImport, chronological, actor ${IMPORT_ACTOR_USERNAME}…`);
  const outcome = await importAllHistory({
    files: history.files,
    apply: applyImport,
    actor,
    onFileDone: (index, total) => {
      if (index % 10 === 0 || index === total) {
        console.log(`[seed] import: ${index}/${total} files committed`);
      }
    }
  });
  console.log('[seed] import finished with zero aborts');

  const queries = await readSummary(history.t0Date, asOf);
  printSummary(outcome, history, queries, config.loans.total_end_active, asOf);
  console.log('');
  console.log(`[seed] done · branch codes ${Object.entries(staff.branchIdByCode).map(([code]) => code).join('/')} · ` +
    `branch names ${Object.values(BRANCH_NAMES).join('/')}`);
}

main()
  .then(async () => {
    await closePool();
  })
  .catch(async (error: unknown) => {
    console.error(`[seed] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    await closePool().catch(() => undefined);
    process.exitCode = 1;
  });
