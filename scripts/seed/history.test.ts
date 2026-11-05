import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile } from './config.js';
import { buildLoanUniverse } from './loans.js';
import { buildHistory, isSundayOffset, type HistoryResult, type HistoryFile } from './history.js';
import { mulberry32 } from './rng.js';
import { CSV_HEADERS } from './csvWriter.js';

const realFile = fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url));
const config = loadSeedConfigFile(realFile);
const universe = buildLoanUniverse(mulberry32(20261105), config, 20261105);
const AS_OF = '2026-11-05';
const history: HistoryResult = buildHistory(mulberry32(777), config, universe, AS_OF);

function cohortCounts(): number {
  return config.history.cohort_count_indore + config.history.cohort_count_ujjain_branch + config.history.cohort_count_dewas;
}

function sundaysInWindow(): string[] {
  const list: string[] = [];
  for (let offset = config.history.window_days - 1; offset >= 0; offset--) {
    const d = new Date(`${AS_OF}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - offset);
    if (d.getUTCDay() === 0) {
      list.push(d.toISOString().slice(0, 10));
    }
  }
  return list;
}

function rowsOf(file: HistoryFile): Map<string, { dpd: number; outstanding: number; branchCode: string }> {
  return new Map(file.rows.map((row) => [row.loanId, { dpd: row.dpd, outstanding: row.outstanding, branchCode: row.branchCode }]));
}

const entryOffsetById = new Map(universe.loans.map((loan) => [loan.loanId, loan.entryDayOffset]));
const reentryOffsetById = new Map(universe.loans.map((loan) => [loan.loanId, loan.reentryDayOffset]));
/** A loan's presence is banded: the ENTRY band starts at e, and a 'stay' loan
 *  re-enters in a second band starting at r after its 7-20 day gap. Each
 *  band's first CSV sighting has dpd 1 on the band's own start day — or dpd 2
 *  when that start day is a skipped Sunday (the brief's LN-10293 e=11 and
 *  LN-11930 e=18 enter on Sundays; dice re-entries can hit Sundays too). */
const bandStartById = new Map(entryOffsetById);

/** A loan's first CSV sighting normally has dpd 1 (band start). When that
 *  sight-day is a skipped Sunday the loan surfaces one file later at dpd 2. */
function expectedFirstDpd(loanId: string): number {
  return isSundayOffset(AS_OF, bandStartById.get(loanId)!) ? 2 : 1;
}

/** Once a loan is noticed absent its entry band is over; the next possible
 *  sighting belongs to the re-entry band (cure loans never re-enter: r = -1). */
function noteAbsence(loanId: string): void {
  bandStartById.set(loanId, reentryOffsetById.get(loanId) ?? -1);
}

describe('file set shape (one CSV per non-Sunday day, data/generated/)', () => {
  it('generates every non-Sunday day in chronological order and skips Sundays', () => {
    const skipped = sundaysInWindow();
    expect(history.files).toHaveLength(config.history.window_days - skipped.length);
    const dates = history.files.map((file) => file.date);
    expect(dates).toEqual(dates.slice().sort((a, b) => a.localeCompare(b)));
    for (const sunday of skipped) {
      expect(dates).not.toContain(sunday);
    }
    for (const file of history.files) {
      expect(file.filename).toBe(`overdue_${file.date}.csv`);
      expect(new Date(`${file.date}T00:00:00Z`).getUTCDay()).not.toBe(0);
      expect(file.rows.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the first day non-empty (the importer aborts on an empty first file)', () => {
    expect(history.files[0]!.rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('per-loan invariants across the 90 daily snapshots', () => {
  it('dpd only grows while a loan is continuously on file; absence means cleared; re-entry resets to dpd 1', () => {
    const lastSeenDpd = new Map<string, number>();
    let previous: HistoryFile | null = null;
    for (const file of history.files) {
      const rows = rowsOf(file);
      if (previous) {
        const previousRows = rowsOf(previous);
        for (const loanId of previousRows.keys()) {
          if (!rows.has(loanId)) {
            lastSeenDpd.set(loanId, 0); // next sighting must re-enter at dpd 1 (2 behind a skipped Sunday)
            noteAbsence(loanId);
            continue;
          }
          const seen = lastSeenDpd.get(loanId) ?? 0;
          const now = rows.get(loanId)!.dpd;
          expect(now).toBeGreaterThanOrEqual(seen === 0 ? 1 : seen);
          if (seen === 0) {
            expect(now).toBe(expectedFirstDpd(loanId));
          }
          lastSeenDpd.set(loanId, now);
        }
      }
      for (const [loanId, value] of rows) {
        const prevDpd = lastSeenDpd.get(loanId) ?? 0;
        if (prevDpd === 0) {
          expect(value.dpd).toBe(expectedFirstDpd(loanId)); // re-entry / entry always resets (2 behind a skipped Sunday)
        }
        expect(value.dpd).toBeGreaterThanOrEqual(1);
        expect(value.dpd).toBeLessThanOrEqual(90); // the seed never emits an NPA-flag row (dpd > 90)
        lastSeenDpd.set(loanId, value.dpd);
      }
      previous = file;
    }
  });

  it('daily vanishings stay below the vanished_over_40pct abort and file sizes never halve', () => {
    let previousRows = new Map<string, unknown>();
    let anyCure = false;
    for (const file of history.files) {
      const rows = rowsOf(file);
      let gone = 0;
      for (const loanId of previousRows.keys()) {
        if (!rows.has(loanId)) {
          gone += 1;
        }
      }
      if (previousRows.size > 0) {
        expect(gone).toBeLessThanOrEqual(config.history.max_cures_per_day);
        expect(gone * 10).toBeLessThanOrEqual(previousRows.size * 4 - 1); // strictly below the 40% abort bound
        expect(rows.size * 2).toBeGreaterThanOrEqual(previousRows.size); // never under half
        if (gone > 0) {
          anyCure = true;
        }
      }
      previousRows = rows;
    }
    expect(anyCure).toBe(true); // the story contains real cures
  });
});

describe('end-date mixture and cohort calibration (SPEC 13, SPEC 20.3, prompt 8 row)', () => {
  const final = history.files[history.files.length - 1]!;
  const finalRows = new Map(final.rows.map((row) => [row.loanId, row]));

  it('ends with exactly the configured counts per branch and each final row in 1-90 dpd', () => {
    expect(finalRows.size).toBe(config.loans.total_end_active);
    expect(final.rows.filter((row) => row.branchCode === 'IDR')).toHaveLength(config.loans.per_branch_indore);
    expect(final.rows.filter((row) => row.branchCode === 'DWS')).toHaveLength(config.loans.per_branch_dewas);
    expect(final.rows.filter((row) => row.branchCode === 'UJJ')).toHaveLength(config.loans.per_branch_ujjain_branch);
    for (const row of final.rows) {
      expect(row.dpd).toBeGreaterThanOrEqual(1);
      expect(row.dpd).toBeLessThanOrEqual(90);
    }
  });

  it('shows the brief loans at their exact brief DPD and POS on the final file', () => {
    expect(finalRows.get('LN-10293')).toMatchObject({ dpd: 12, outstanding: 64000000, branchCode: 'UJJ' });
    expect(finalRows.get('LN-10871')).toMatchObject({ dpd: 27, outstanding: 31000000, branchCode: 'UJJ' });
    expect(finalRows.get('LN-11930')).toMatchObject({ dpd: 19, outstanding: 22000000, branchCode: 'DWS' });
  });

  it('the t0 snapshot holds exactly the configured cohort members, all in 1-30 dpd', () => {
    expect(history.files.some((file) => file.date === history.t0Date)).toBe(true);
    const t0 = history.files.find((file) => file.date === history.t0Date)!;
    expect(t0.rows.filter((row) => row.dpd >= 1 && row.dpd <= 30)).toHaveLength(cohortCounts());
    expect(t0.rows.length).toBeGreaterThanOrEqual(
      cohortCounts() + config.history.early_count_indore + config.history.early_count_ujjain_branch + config.history.early_count_dewas
    );
  });

  it('realizes the roll allocation with per-branch rates inside 19-25% and closes the ledger', () => {
    const byBranch = new Map<string, { rolled: number; stayed: number; cured: number; cohort: number }>();
    for (const entry of history.cohortOutcomeLedger) {
      const bucket = byBranch.get(entry.branchCode) ?? { rolled: 0, stayed: 0, cured: 0, cohort: 0 };
      bucket.cohort += 1;
      bucket[entry.outcome] += 1;
      if (entry.outcome === 'stayed') {
        const row = finalRows.get(entry.loanId);
        expect(row).toBeDefined();
        expect(row!.dpd).toBeGreaterThanOrEqual(1);
        expect(row!.dpd).toBeLessThanOrEqual(30);
      }
      if (entry.outcome === 'rolled') {
        const row = finalRows.get(entry.loanId);
        expect(row).toBeDefined();
        expect(row!.dpd).toBeGreaterThanOrEqual(31);
      }
      if (entry.outcome === 'cured') {
        expect(finalRows.has(entry.loanId)).toBe(false);
      }
    }
    const total = history.cohortOutcomeLedger.length;
    const rolled = history.cohortOutcomeLedger.filter((entry) => entry.outcome === 'rolled').length;
    const stayed = history.cohortOutcomeLedger.filter((entry) => entry.outcome === 'stayed').length;
    const cured = history.cohortOutcomeLedger.filter((entry) => entry.outcome === 'cured').length;
    expect(cured + stayed + rolled).toBe(total);
    expect(rolled / total).toBeGreaterThan(0.2);
    expect(rolled / total).toBeLessThan(0.25);
    for (const bucket of byBranch.values()) {
      expect(bucket.rolled / bucket.cohort).toBeGreaterThan(0.19);
      expect(bucket.rolled / bucket.cohort).toBeLessThan(0.25);
    }
  });

  it('branches come out as the three lowercase-normalizable names and headers are canonical', () => {
    const branchesSeen = new Set(final.rows.map((row) => row.branch));
    expect([...branchesSeen].sort()).toEqual(['Dewas', 'Indore', 'Ujjain']); // CSV names; importer lowercases + matches DB names
    expect(CSV_HEADERS).toEqual([
      'loan_id', 'borrower_name', 'business_name', 'mobile', 'alt_mobile', 'address', 'locality',
      'product', 'outstanding', 'overdue_amount', 'emi_amount', 'dpd', 'pincode', 'branch'
    ]);
  });
});
