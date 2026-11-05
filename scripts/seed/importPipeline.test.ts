import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile } from './config.js';
import { buildLoanUniverse } from './loans.js';
import { buildHistory } from './history.js';
import { mulberry32 } from './rng.js';
import { parseCsv } from '../../src/shared/import/parseFile.js';
import { planImport, type ImportPlan, type PreviousLoan } from '../../src/shared/import/planImport.js';

const realFile = fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url));
const config = loadSeedConfigFile(realFile);
const universe = buildLoanUniverse(mulberry32(20261105), config, 20261105);
const history = buildHistory(mulberry32(777), config, universe, '2026-11-05');

const BRANCH_SET = new Set(['indore', 'dewas', 'ujjain']);

/** The only row warnings validateRow can emit for the seed's 14 canonical
 *  columns (applyImport runs parseCsv without a territory pincodes context,
 *  so pincode_not_in_territory can never fire either way). */
const KNOWN_WARNING_CODES = ['bad_mobile', 'dpd_zero', 'pincode_not_in_territory'] as const;

function utcDayIndex(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

describe('the generated file set through the REAL import planning chain', () => {
  it('plays all 77 daily files through parseCsv + planImport with zero aborts', () => {
    let snapshot = new Map<string, PreviousLoan>();
    let latestBatchDate: string | null = null;
    const plans: { date: string; plan: ImportPlan; parsedRows: number }[] = [];
    const census = new Map<string, number>();

    for (const file of history.files) {
      const parsed = parseCsv(new TextEncoder().encode(file.csv), { branches: BRANCH_SET });
      expect(parsed.abort, `${file.filename} must parse`).toBeNull();
      expect(parsed.errors, `${file.filename} must carry no row errors`).toEqual([]);
      expect(parsed.dropped, `${file.filename} must drop nothing`).toBe(0);
      expect(parsed.skipped, `${file.filename} must skip nothing`).toBe(0);
      expect(parsed.totalRows).toBe(file.rows.length); // the parser sees every generated row
      for (const warning of parsed.warnings) {
        census.set(warning.code, (census.get(warning.code) ?? 0) + 1);
        expect(KNOWN_WARNING_CODES).toContain(warning.code as (typeof KNOWN_WARNING_CODES)[number]);
      }

      const plan = planImport({
        rows: parsed.rows,
        warnings: parsed.warnings,
        asOf: file.date,
        previous: snapshot,
        previousCount: snapshot.size,
        dropped: parsed.dropped,
        skipped: parsed.skipped,
        latestBatchDate,
        territory: []
      });
      expect(plan.abort, `${file.filename} must not plan an abort`).toBeNull();
      plans.push({ date: file.date, plan, parsedRows: parsed.rows.length });

      // Commit semantics identical to applyImport: every parsed row lands as
      // an overdue loan and its snapshot row, so the state the next file's
      // planner reads is exactly this one's rows.
      snapshot = new Map(
        parsed.rows.map((row): [string, PreviousLoan] => [
          row.loanId,
          { dpd: row.dpd, overdueAmount: row.overdueAmount ?? 0, outstanding: row.outstanding, status: 'overdue' }
        ])
      );
      latestBatchDate = file.date;
    }

    // ---- the census asserted from the run ----
    expect(plans).toHaveLength(77);
    expect([...census.entries()]).toEqual([]); // a clean generator emits zero row warnings

    const first = plans[0]!;
    const last = plans[plans.length - 1]!;
    expect(first.plan.continuing).toEqual([]); // nothing is committed before the first file
    expect(first.plan.gone).toEqual([]);
    expect(first.plan.counts.new).toBe(3); // the three loans pinned to the first file day
    for (const entry of plans) {
      expect(entry.plan.counts.partPaid).toBe(0); // POS never shrinks between files
      expect(entry.plan.counts.anomalous).toBe(0); // dpd never travels backwards between files
      expect(entry.plan.counts.lateDiscovery).toBe(0); // entries always surface at dpd 1-2
      expect(entry.plan.counts.gone).toBeLessThanOrEqual(config.history.max_cures_per_day);
    }
    const newTotal = plans.reduce((sum, entry) => sum + entry.plan.counts.new, 0);
    const goneTotal = plans.reduce((sum, entry) => sum + entry.plan.counts.gone, 0);
    const stayedN = config.history.stayed_count_indore + config.history.stayed_count_ujjain_branch + config.history.stayed_count_dewas;
    expect(newTotal).toBe(universe.loans.length + stayedN); // first entries for all loans + one re-entry per stayed loan
    expect(goneTotal).toBe(83 + stayedN); // cured loans vanish once; stayed loans vanish once during their gap

    // Continuing loans age exactly by the file-day distance (Sundays included).
    for (let i = 1; i < plans.length; i += 1) {
      const previous = plans[i - 1]!;
      const current = plans[i]!;
      const distance = utcDayIndex(previous.date, current.date);
      expect(distance).toBeGreaterThanOrEqual(1);
      for (const continuing of current.plan.continuing) {
        expect(continuing.loan.dpd - continuing.previousDpd).toBe(distance);
      }
    }

    // t0 snapshot = the configured cohort in 1-30 dpd, seen through the parser.
    const cohortN = config.history.cohort_count_indore + config.history.cohort_count_ujjain_branch + config.history.cohort_count_dewas;
    const t0File = history.files.find((file) => file.date === history.t0Date)!;
    const t0Rows = t0File.rows.filter((row) => row.dpd >= 1 && row.dpd <= 30);
    expect(t0Rows).toHaveLength(cohortN);

    // End-date mixture through the parser's eyes.
    expect(last.parsedRows).toBe(config.loans.total_end_active);
  });
});
