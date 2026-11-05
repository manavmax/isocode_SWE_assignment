/**
 * Seed run gates (SPEC 14; A17 mechanism, A31 demo handles). Everything that
 * can refuse a seed run lives here as pure logic so the rules are testable
 * without a database:
 *
 *  - parseSeedArgs: `pnpm seed -- --seed N --as-of today|YYYY-MM-DD [--yes] [--reset]`
 *  - resolveAsOf/weekdayOf: calendar guards for the daily-file shape (the
 *    as-of date and the cohort day t0 = asOf - cohortDaysBeforeEnd must not
 *    be Sundays, otherwise a file day at the window boundary is skipped).
 *  - decideRun: DEMO_MODE only, --yes required, non-demo data (is_demo=false
 *    in the target DB) refuses unless --reset.
 *
 * resetDemoData is the A17 reset path bound to the seed's WIDER table list
 * (seed.reset_tables): inside ONE database transaction, write the audit row
 * first (action 'demo_reset', actor 'seed', the table list in the detail),
 * then a single `TRUNCATE TABLE ...` statement over the validated list.
 * Nothing here runs during builds; it is only reachable from
 * scripts/seed/main.ts.
 */
import { sql } from 'drizzle-orm';
import { auditLog } from '../../src/server/db/schema.js';
import type { PooledTx } from '../../src/server/db.js';

export interface SeedArgs {
  seed: number;
  asOfRequest: string;
  yes: boolean;
  reset: boolean;
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  let seed: number | null = null;
  let asOfRequest: string | null = null;
  let yes = false;
  let reset = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--seed') {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error('--seed expects a positive integer argument');
      }
      seed = Number(raw);
      if (!Number.isInteger(seed) || seed <= 0) {
        throw new Error(`--seed ${raw} is not a positive integer`);
      }
      continue;
    }
    if (flag === '--as-of') {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error('--as-of expects "today" or a YYYY-MM-DD date');
      }
      asOfRequest = raw;
      continue;
    }
    if (flag === '--yes') {
      yes = true;
      continue;
    }
    if (flag === '--reset') {
      reset = true;
      continue;
    }
    throw new Error(`unknown seed option ${String(flag)}; supported: --seed, --as-of, --yes, --reset`);
  }
  if (seed === null) {
    throw new Error('--seed <positive integer> is required');
  }
  if (asOfRequest === null) {
    throw new Error('--as-of <today|YYYY-MM-DD> is required');
  }
  return { seed, asOfRequest, yes, reset };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveAsOf(asOfRequest: string, todayUtc: string): string {
  if (asOfRequest === 'today') {
    return todayUtc;
  }
  if (!DATE_RE.test(asOfRequest)) {
    throw new Error(`--as-of ${asOfRequest} is neither "today" nor a YYYY-MM-DD date`);
  }
  const probe = new Date(`${asOfRequest}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== asOfRequest) {
    throw new Error(`--as-of ${asOfRequest} is not a real calendar date`);
  }
  return asOfRequest;
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function shiftUtcDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export interface DataOverview {
  /** true when any row exists in the loan table (the app data marker). */
  hasAnyRow: boolean;
  /** hasAnyRow && every loan row has is_demo = true. */
  allDemo: boolean;
  /** max(import_batch.as_of): a batch NEWER than the generated window would
   *  make the chronological import abort as backdated, so it refuses early. */
  latestImportDate: string | null;
}

export interface RunDecision {
  action: 'proceed' | 'refuse';
  reset: boolean;
  reason?: string;
}

/** Collates every violated rule (deterministic order), then refuses or
 *  proceeds. Refusal never writes anything; it is printed by main.ts. */
export function decideRun(input: {
  asOf: string;
  cohortDaysBeforeEnd: number;
  yes: boolean;
  resetRequested: boolean;
  demoMode: boolean;
  data: DataOverview;
}): RunDecision {
  const reasons: string[] = [];
  if (input.demoMode === false) {
    reasons.push('DEMO_MODE must be enabled: the seed only ever writes demo accounts and demo loans');
  }
  if (weekdayOf(input.asOf) === 0) {
    reasons.push(`--as-of ${input.asOf} falls on a Sunday; the daily file set would end one file short of the as-of date`);
  }
  const t0 = shiftUtcDate(input.asOf, -input.cohortDaysBeforeEnd);
  if (weekdayOf(t0) === 0) {
    reasons.push(`the cohort day t0 ${t0} (as-of minus ${input.cohortDaysBeforeEnd} days) is a Sunday; pick a weekday --as-of`);
  }
  if (!input.yes) {
    reasons.push('pass --yes to confirm writing the seed data to the connected database');
  }
  if (input.data.hasAnyRow && !input.data.allDemo && !input.resetRequested) {
    reasons.push('the target database holds non-demo rows (is_demo=false); rerun with --reset to truncate the demo table set first');
  }
  if (!input.resetRequested && input.data.latestImportDate !== null && input.data.latestImportDate > input.asOf) {
    reasons.push(
      `the database already holds an import batch dated ${input.data.latestImportDate}, newer than the as-of ` +
        'window; the chronological import would abort as backdated, so rerun with --reset'
    );
  }
  if (reasons.length > 0) {
    return { action: 'refuse', reset: false, reason: reasons.join('; ') };
  }
  return { action: 'proceed', reset: input.resetRequested };
}

/** Identifiers only — the list of table names is config data and every entry
 *  must be a plain lowercase SQL identifier before it is quoted into the
 *  TRUNCATE statement. */
export function validateResetTables(tables: readonly string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of tables) {
    const name = raw.trim();
    if (!/^[a-z_]+$/.test(name)) {
      throw new Error(`seed.reset_tables contains ${JSON.stringify(raw)}; table names must be lowercase identifiers`);
    }
    if (cleaned.includes(name)) {
      throw new Error(`seed.reset_tables repeats ${name}`);
    }
    cleaned.push(name);
  }
  if (cleaned.length === 0) {
    throw new Error('seed.reset_tables is empty; refusing a reset without a table list');
  }
  return cleaned;
}

export interface SeedResetInput {
  seed: number;
  asOf: string;
  tables: readonly string[];
}

export interface ResetAuditRow {
  actor: string;
  action: 'demo_reset';
  subject: string | null;
  detail: {
    seed: number;
    asOf: string;
    tables: string[];
    /** true: the audited writer verified every listed name is a public table. */
    verified: boolean;
  };
}

export function planResetAudit(input: SeedResetInput): ResetAuditRow {
  return {
    actor: 'seed',
    action: 'demo_reset',
    subject: null,
    detail: { seed: input.seed, asOf: input.asOf, tables: validateResetTables(input.tables), verified: true }
  };
}

export interface PooledTxRunner {
  run: <T>(fn: (tx: PooledTx) => T | Promise<T>) => Promise<T>;
}

/** A17 path replayed for the seed's table scope: ONE transaction, audit row
 *  first, then a single TRUNCATE over the whole list (FK-safe: the list is
 *  closure-complete in seed_config.yaml). */
export async function resetDemoData(run: PooledTxRunner, input: SeedResetInput): Promise<void> {
  const audit = planResetAudit(input);
  const tableList = audit.detail.tables.map((table) => `"${table}"`).join(', ');
  await run.run(async (tx) => {
    await tx.insert(auditLog).values(audit);
    await tx.execute(sql.raw(`TRUNCATE TABLE ${tableList}`));
  });
}
