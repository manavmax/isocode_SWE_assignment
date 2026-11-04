import type { ImportLoan, RowIssue } from './validateRow.js';

export interface PreviousLoan {
  dpd: number;
  overdueAmount: number;
  outstanding: number;
  status: 'overdue' | 'cleared' | 'queue';
}

export interface TerritoryRow {
  pincode: string;
  locality: string | null;
  officerId: string;
}

export type PlanAbortCode = 'as_of_backdated' | 'vanished_over_40pct' | 'under_half_previous_count';

export interface PlanAbort {
  code: PlanAbortCode;
  message: string;
}

export interface PlannedNew {
  loan: ImportLoan;
  lateDiscovery: boolean;
  territoryOfficerId: string | null;
}

export interface PlannedContinuing {
  loan: ImportLoan;
  previousDpd: number;
  kind: 'aging' | 'part_paid' | 'anomalous';
}

export interface PlannedGone {
  loanId: string;
  reason: 'absent_from_full_file';
}

export interface PlanWarning {
  rowNo?: number;
  loanId?: string;
  code: string;
  message: string;
}

export interface PlanCounts {
  total: number;
  imported: number;
  dropped: number;
  skipped: number;
  new: number;
  lateDiscovery: number;
  aging: number;
  partPaid: number;
  anomalous: number;
  gone: number;
}

export interface PlanInput {
  rows: ImportLoan[];
  warnings: RowIssue[];
  asOf: string;
  previous: ReadonlyMap<string, PreviousLoan>;
  previousCount: number;
  dropped: number;
  skipped: number;
  latestBatchDate: string | null;
  territory: readonly TerritoryRow[];
}

export interface ImportPlan {
  abort: PlanAbort | null;
  newLoans: PlannedNew[];
  continuing: PlannedContinuing[];
  gone: PlannedGone[];
  warnings: PlanWarning[];
  counts: PlanCounts;
}

export function planImport(input: PlanInput): ImportPlan {
  const rowIds = new Set(input.rows.map((row) => row.loanId));
  const gone: PlannedGone[] = [];
  for (const [loanId, previousLoan] of input.previous) {
    if (previousLoan.status === 'overdue' && !rowIds.has(loanId)) {
      gone.push({ loanId, reason: 'absent_from_full_file' });
    }
  }

  if (input.latestBatchDate !== null && input.asOf < input.latestBatchDate) {
    return emptyPlan(input, {
      code: 'as_of_backdated',
      message: `as_of ${input.asOf} is earlier than the latest committed batch ${input.latestBatchDate}`
    });
  }
  if (gone.length * 10 > input.previousCount * 4) {
    return emptyPlan(input, {
      code: 'vanished_over_40pct',
      message: `${gone.length} of ${input.previousCount} previous loans are absent from the file`
    });
  }
  if (input.rows.length * 2 < input.previousCount) {
    return emptyPlan(input, {
      code: 'under_half_previous_count',
      message: `file has ${input.rows.length} rows against ${input.previousCount} in the previous snapshot`
    });
  }

  const newLoans: PlannedNew[] = [];
  const continuing: PlannedContinuing[] = [];
  const warnings: PlanWarning[] = input.warnings.map((issue) => ({
    rowNo: issue.rowNo,
    loanId: issue.loanId,
    code: issue.code,
    message: issue.message
  }));

  for (const row of input.rows) {
    const previousLoan = input.previous.get(row.loanId);
    if (previousLoan) {
      continuing.push({ loan: row, previousDpd: previousLoan.dpd, kind: continuingKind(row, previousLoan) });
      continue;
    }
    const lateDiscovery = row.dpd > 30;
    if (lateDiscovery) {
      warnings.push({
        loanId: row.loanId,
        code: 'late_discovery',
        message: `loan ${row.loanId} first seen above 30 dpd, tagged late_discovery`
      });
    }
    const territoryOfficerId = input.territory.length > 0 ? territoryOfficerFor(input.territory, row) : null;
    if (input.territory.length > 0 && territoryOfficerId === null) {
      warnings.push({
        loanId: row.loanId,
        code: 'pincode_not_in_territory',
        message: `pincode ${row.pincode} is not in the territory map`
      });
    }
    newLoans.push({ loan: row, lateDiscovery, territoryOfficerId });
  }

  const counts: PlanCounts = {
    total: input.rows.length,
    imported: input.rows.length,
    dropped: input.dropped,
    skipped: input.skipped,
    new: newLoans.length,
    lateDiscovery: newLoans.filter((entry) => entry.lateDiscovery).length,
    aging: continuing.filter((entry) => entry.kind === 'aging').length,
    partPaid: continuing.filter((entry) => entry.kind === 'part_paid').length,
    anomalous: continuing.filter((entry) => entry.kind === 'anomalous').length,
    gone: gone.length
  };

  return { abort: null, newLoans, continuing, gone, warnings, counts };
}

function emptyPlan(input: PlanInput, abort: PlanAbort): ImportPlan {
  return {
    abort,
    newLoans: [],
    continuing: [],
    gone: [],
    warnings: [],
    counts: {
      total: input.rows.length,
      imported: input.rows.length,
      dropped: input.dropped,
      skipped: input.skipped,
      new: 0,
      lateDiscovery: 0,
      aging: 0,
      partPaid: 0,
      anomalous: 0,
      gone: 0
    }
  };
}

function continuingKind(row: ImportLoan, previousLoan: PreviousLoan): PlannedContinuing['kind'] {
  if (row.dpd < previousLoan.dpd) {
    return 'anomalous';
  }
  return row.overdueAmount !== undefined && row.overdueAmount < previousLoan.overdueAmount ? 'part_paid' : 'aging';
}

function territoryOfficerFor(territory: readonly TerritoryRow[], row: ImportLoan): string | null {
  const exact = territory.find(
    (entry) => entry.pincode === row.pincode && entry.locality !== null && entry.locality === row.locality
  );
  if (exact) {
    return exact.officerId;
  }
  const generic = territory.find((entry) => entry.pincode === row.pincode && entry.locality === null);
  return generic ? generic.officerId : null;
}
