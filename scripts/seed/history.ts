/**
 * 90-day daily history → one CSV per non-Sunday day (SPEC 14, A--). Pure:
 * intake is a finished loan universe, output is the exact file set the real
 * importer consumes. Sundays are skipped by the importer contract (no file);
 * DPD calendar-ages across such gaps (+2), never shrinks, so no anomaly
 * paths trigger. Cures are bonded to at most `history.max_cures_per_day`
 * disappearances between consecutive file days — far below both importer
 * aborts (`vanished_over_40pct`, `under_half_previous_count`).
 *
 * Cohort definition: every loan present at t0 = asOf − `cohort_days_before_end`
 * with dpd 1-30. Ledger outcomes: 'rolled' (dpd ≥ 31 at end, never cured),
 * 'stayed' (cured, re-entered within the last 30 days), 'cured' (absent at
 * end → importer writes cleared). rolled + stayed + cured = cohort.
 */
import type { SeedConfig } from './config.js';
import type { BranchCode, GeneratedLoan } from './loans.js';
import { BRANCH_NAMES } from './loans.js';
import { CSV_HEADERS, filenameFor, renderCsv } from './csvWriter.js';
import { pick, type Rng } from './rng.js';

export interface HistoryRow {
  loanId: string;
  borrowerName: string;
  businessName: string | null;
  mobile: string;
  altMobile: string | null;
  address: string;
  locality: string | null;
  product: string;
  /** paise */
  outstanding: number;
  /** paise */
  overdueAmount: number;
  /** paise */
  emiAmount: number;
  dpd: number;
  pincode: string;
  branchCode: BranchCode;
  branch: string;
}

export interface HistoryFile {
  filename: string;
  date: string;
  rows: HistoryRow[];
  csv: string;
}

export type CohortOutcome = 'rolled' | 'stayed' | 'cured';

export interface CohortRecord {
  loanId: string;
  branchCode: BranchCode;
  outcome: CohortOutcome;
}

export interface HistoryResult {
  files: HistoryFile[];
  t0Date: string;
  cohortOutcomeLedger: CohortRecord[];
}

export function dateAtOffset(asOf: string, offset: number): string {
  const day = new Date(`${asOf}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
}

export function isSundayOffset(asOf: string, offset: number): boolean {
  return new Date(`${dateAtOffset(asOf, offset)}T00:00:00Z`).getUTCDay() === 0;
}

/** Presence + dpd of a loan on model day k (k counts back from the end day).
 *  null = absent that day. */
function dpdAtOffset(loan: GeneratedLoan, k: number): number | null {
  const e = loan.entryDayOffset;
  const l = loan.lastPresentDayOffset;
  const r = loan.reentryDayOffset;
  if (k > e) {
    return null; // not yet entered
  }
  if (loan.destiny === 'stay') {
    if (k >= l) {
      return e - k + 1; // pre-cure band [l .. e]
    }
    return k <= r ? r - k + 1 : null; // re-entry band [0 .. r] or gap
  }
  if (loan.destiny === 'cure') {
    return k >= l ? e - k + 1 : null; // cured and gone after day l
  }
  return e - k + 1; // roll / early / fresh run to the end (l = 0)
}

interface CureEvent {
  loan: GeneratedLoan;
  min: number;
  max: number;
}

function rowCells(row: HistoryRow): string[] {
  return [
    row.loanId,
    row.borrowerName,
    row.businessName ?? '',
    row.mobile,
    row.altMobile ?? '',
    row.address,
    row.locality ?? '',
    row.product,
    String(row.outstanding / 100),
    String(row.overdueAmount / 100),
    String(row.emiAmount / 100),
    String(row.dpd),
    row.pincode,
    row.branch
  ];
}

export function buildHistory(
  rng: Rng,
  config: SeedConfig,
  universe: { loans: readonly GeneratedLoan[] },
  asOf: string
): HistoryResult {
  // 1. calendar: file days = non-Sunday offsets, oldest first.
  const fileDays: number[] = [];
  for (let k = config.history.window_days - 1; k >= 0; k -= 1) {
    if (!isSundayOffset(asOf, k)) {
      fileDays.push(k);
    }
  }
  const t0Offset = config.history.cohort_days_before_end;
  if (isSundayOffset(asOf, t0Offset)) {
    throw new Error(`history: t0 (${dateAtOffset(asOf, t0Offset)}) is a Sunday; choose another --as-of`);
  }
  const t0Date = dateAtOffset(asOf, t0Offset);

  // 2. cure events with per-loan feasible l ranges; count vanishings per
  //    file-day transition and rebalance any day above the configured cap.
  const transitionFor = (l: number): number | null => {
    // transition i sits between fileDays[i] (older) and fileDays[i+1] (newer);
    // a loan vanishing there has lastPresentDayOffset in [fileDays[i+1]+1, fileDays[i]].
    for (let i = 0; i < fileDays.length - 1; i += 1) {
      if (fileDays[i]! >= l && l > fileDays[i + 1]!) {
        return i;
      }
    }
    return null; // l sits at/before the first file day: no in-window vanishing
  };
  const events: CureEvent[] = [];
  const counts = new Map<number, number>();
  const register = (loan: GeneratedLoan): number | null => {
    const target = transitionFor(loan.lastPresentDayOffset);
    if (target !== null) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    return target;
  };
  for (const loan of universe.loans) {
    if (loan.destiny === 'cure') {
      events.push({ loan, min: 1, max: Math.min(29, loan.entryDayOffset - 1) });
      register(loan);
    } else if (loan.destiny === 'stay') {
      const min = loan.reentryDayOffset + 7;
      const max = Math.min(loan.reentryDayOffset + 20, 29, loan.entryDayOffset - 1);
      events.push({ loan, min, max });
      register(loan);
    }
  }
  const cap = config.history.max_cures_per_day;
  for (;;) {
    let hottest: number | null = null;
    for (const [index, count] of counts) {
      if (count > cap && (hottest === null || count > counts.get(hottest)!)) {
        hottest = index;
      }
    }
    if (hottest === null) {
      break;
    }
    let moved = false;
    for (const event of events) {
      if (transitionFor(event.loan.lastPresentDayOffset) !== hottest) {
        continue;
      }
      const candidates: { l: number; count: number; target: number }[] = [];
      for (let candidate = event.min; candidate <= event.max; candidate += 1) {
        const target = transitionFor(candidate);
        if (target === null || target === hottest) {
          continue;
        }
        candidates.push({ l: candidate, count: counts.get(target) ?? 0, target });
      }
      if (candidates.length === 0) {
        continue;
      }
      const minCount = Math.min(...candidates.map((candidate) => candidate.count));
      const best = candidates.filter((candidate) => candidate.count === minCount);
      const chosen = best.length === 1 ? best[0]! : pick(rng, best);
      counts.set(hottest, (counts.get(hottest) ?? 0) - 1);
      counts.set(chosen.target, (counts.get(chosen.target) ?? 0) + 1);
      event.loan.lastPresentDayOffset = chosen.l;
      moved = true;
      break;
    }
    if (!moved) {
      throw new Error(`history: cure rebalance stuck on transition ${hottest}`);
    }
  }

  // 3. build the rows per file day.
  const files: HistoryFile[] = [];
  let previousRowIds: Set<string> | null = null;
  let previousCount = 0;
  for (const k of fileDays) {
    const date = dateAtOffset(asOf, k);
    const rows: HistoryRow[] = [];
    for (const loan of universe.loans) {
      const dpd = dpdAtOffset(loan, k);
      if (dpd === null) {
        continue;
      }
      rows.push({
        loanId: loan.loanId,
        borrowerName: loan.borrowerName,
        businessName: loan.businessName,
        mobile: loan.mobile,
        altMobile: loan.altMobile,
        address: loan.address,
        locality: loan.locality,
        product: loan.product,
        outstanding: loan.outstandingRupees * 100,
        overdueAmount: loan.outstandingRupees * 100,
        emiAmount: loan.emiRupees * 100,
        dpd,
        pincode: loan.pincode,
        branchCode: loan.branchCode,
        branch: BRANCH_NAMES[loan.branchCode]
      });
    }
    // abort-safety self-checks against the real planner rules.
    if (previousRowIds !== null) {
      let gone = 0;
      for (const loanId of previousRowIds) {
        if (!rows.some((row) => row.loanId === loanId)) {
          gone += 1;
        }
      }
      if (gone > cap || gone * 10 >= previousCount * 4) {
        throw new Error(`history: ${gone} vanishings into ${date} against ${previousCount} previous rows breaks the abort safety`);
      }
      if (rows.length * 2 < previousCount) {
        throw new Error(`history: file at ${date} would trigger under_half_previous_count`);
      }
    }
    if (rows.length === 0) {
      throw new Error(`history: file at ${date} is empty; the importer aborts on an empty file`);
    }
    files.push({ filename: filenameFor(date), date, rows, csv: renderCsv(CSV_HEADERS, rows.map(rowCells)) });
    previousRowIds = new Set(rows.map((row) => row.loanId));
    previousCount = rows.length;
  }

  // 4. cohort ledger + calibration self-checks.
  const finalFile = files[files.length - 1]!;
  const finalIds = new Set(finalFile.rows.map((row) => row.loanId));
  const cohortTotal = config.history.cohort_count_indore + config.history.cohort_count_ujjain_branch + config.history.cohort_count_dewas;
  const ledger: CohortRecord[] = universe.loans
    .filter((loan) => loan.destiny === 'roll' || loan.destiny === 'stay' || loan.destiny === 'cure')
    .map((loan) => ({
      loanId: loan.loanId,
      branchCode: loan.branchCode,
      outcome: loan.destiny === 'roll' ? 'rolled' : loan.destiny === 'stay' ? 'stayed' : 'cured'
    }));
  if (ledger.length !== cohortTotal) {
    throw new Error(`history: cohort ledger holds ${ledger.length} loans, config expects ${cohortTotal}`);
  }
  const t0File = files.find((file) => file.date === t0Date);
  if (!t0File) {
    throw new Error(`history: t0 file for ${t0Date} is missing from the window`);
  }
  const t0Cohort = t0File.rows.filter((row) => row.dpd >= 1 && row.dpd <= 30).length;
  if (t0Cohort !== cohortTotal) {
    throw new Error(`history: t0 1-30dpd population is ${t0Cohort}, expected the configured cohort ${cohortTotal}`);
  }
  for (const [code, expected] of [
    ['IDR', config.loans.per_branch_indore],
    ['DWS', config.loans.per_branch_dewas],
    ['UJJ', config.loans.per_branch_ujjain_branch]
  ] as const) {
    const actual = finalFile.rows.filter((row) => row.branchCode === code).length;
    if (actual !== expected) {
      throw new Error(`history: end-date branch ${code} holds ${actual} loans, expected ${expected}`);
    }
  }
  if (finalIds.size !== config.loans.total_end_active) {
    throw new Error(`history: end-date file holds ${finalIds.size} loans, expected ${config.loans.total_end_active}`);
  }

  return { files, t0Date, cohortOutcomeLedger: ledger };
}
