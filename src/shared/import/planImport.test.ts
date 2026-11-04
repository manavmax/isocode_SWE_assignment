import { describe, expect, it } from 'vitest';
import { planImport } from './planImport.js';
import type { PreviousLoan } from './planImport.js';
import type { ImportLoan } from './validateRow.js';

type PrevEntry = [string, PreviousLoan];

function loan(overrides: Partial<ImportLoan> & { loanId: string; dpd: number }): ImportLoan {
  return {
    loanId: overrides.loanId,
    borrowerName: overrides.borrowerName ?? 'x',
    pincode: overrides.pincode ?? '452001',
    branch: overrides.branch ?? 'Ujjain',
    locality: overrides.locality,
    outstanding: overrides.outstanding ?? 5000000,
    overdueAmount: 'overdueAmount' in overrides ? overrides.overdueAmount : undefined,
    dpd: overrides.dpd,
    npa: overrides.dpd > 90
  } as ImportLoan;
}

const TERRITORY = [
  { pincode: '452001', locality: null, officerId: 'officer-generic-1' },
  { pincode: '452001', locality: 'Bhawarkua', officerId: 'officer-local-1' }
];

function plan(rows: ImportLoan[], previous: PrevEntry[] = [], input?: Partial<Parameters<typeof planImport>[0]>) {
  return planImport({
    rows,
    warnings: [],
    asOf: '2026-11-01',
    previous: new Map(previous),
    previousCount: previous.length,
    dropped: 0,
    skipped: 0,
    latestBatchDate: null,
    territory: [],
    ...input
  });
}

describe('planImport', () => {
  it('first-ever import: a loan at 41 dpd is NOT flagged late_discovery (A20)', () => {
    const report = plan([loan({ loanId: 'LN-1', dpd: 41 })]);
    expect(report.newLoans).toHaveLength(1);
    expect(report.newLoans[0]!.lateDiscovery).toBe(false);
    expect(report.counts.lateDiscovery).toBe(0);
    expect(report.warnings.some((w) => w.code === 'late_discovery')).toBe(false);
  });

  it('with previous snapshot: loan first seen at 35 dpd IS flagged late_discovery (A20)', () => {
    const prev = [['LN-0', { dpd: 5, overdueAmount: 0, outstanding: 0, status: 'overdue' }]] as PrevEntry[];
    const report = plan([loan({ loanId: 'LN-1', dpd: 35 }), loan({ loanId: 'LN-0', dpd: 5 })], prev);
    expect(report.abort).toBeNull();
    expect(report.newLoans[0]!.lateDiscovery).toBe(true);
    expect(report.counts.lateDiscovery).toBe(1);
    const w = report.warnings.find((w) => w.code === 'late_discovery');
    expect(w?.message).toContain('35');
    expect(w?.message).toContain('LN-1');
  });

  it('with previous snapshot: loan first seen at 30 dpd is NOT flagged (boundary)', () => {
    const prev = [['LN-0', { dpd: 5, overdueAmount: 0, outstanding: 0, status: 'overdue' }]] as PrevEntry[];
    const report = plan([loan({ loanId: 'LN-1', dpd: 30 }), loan({ loanId: 'LN-0', dpd: 5 })], prev);
    expect(report.abort).toBeNull();
    expect(report.counts.lateDiscovery).toBe(0);
  });

  it('does not tag first-seen loans at or below 30 dpd', () => {
    const report = plan([loan({ loanId: 'LN-2', dpd: 30 }), loan({ loanId: 'LN-3', dpd: 12 })]);
    expect(report.newLoans.map((entry) => entry.lateDiscovery)).toEqual([false, false]);
    expect(report.counts.lateDiscovery).toBe(0);
  });

  it('classes continuing loans as aging when neither overdue fell nor dpd reset', () => {
    const report = plan([loan({ loanId: 'LN-4', dpd: 15, overdueAmount: 100000 })], [
      ['LN-4', { dpd: 15, overdueAmount: 100000, outstanding: 5000000, status: 'overdue' }]
    ]);
    expect(report.continuing[0]!.kind).toBe('aging');
  });

  it('classes continuing loans as part_paid when overdue fell and dpd did not reset', () => {
    const report = plan([loan({ loanId: 'LN-5', dpd: 15, overdueAmount: 60000 })], [
      ['LN-5', { dpd: 15, overdueAmount: 100000, outstanding: 5000000, status: 'overdue' }]
    ]);
    expect(report.continuing[0]!.kind).toBe('part_paid');
  });

  it('classes continuing loans as anomalous when dpd reset without overdue zeroing', () => {
    const report = plan([loan({ loanId: 'LN-6', dpd: 12, overdueAmount: 80000 })], [
      ['LN-6', { dpd: 40, overdueAmount: 80000, outstanding: 5000000, status: 'overdue' }]
    ]);
    expect(report.continuing[0]!.kind).toBe('anomalous');
  });

  it('marks absent overdue previous loans gone with absent_from_full_file', () => {
    const rows = [loan({ loanId: 'LN-7', dpd: 10 }), loan({ loanId: 'LN-9', dpd: 12 }), loan({ loanId: 'LN-11', dpd: 44 })];
    const previous: PrevEntry[] = [
      ['LN-7', { dpd: 10, overdueAmount: 0, outstanding: 0, status: 'overdue' }],
      ['LN-9', { dpd: 12, overdueAmount: 20000, outstanding: 2000000, status: 'overdue' }],
      ['LN-11', { dpd: 44, overdueAmount: 90000, outstanding: 4000000, status: 'overdue' }],
      ['LN-8', { dpd: 22, overdueAmount: 40000, outstanding: 3000000, status: 'overdue' }],
      ['LN-10', { dpd: 0, overdueAmount: 0, outstanding: 0, status: 'cleared' }]
    ];
    const report = plan(rows, previous);
    expect(report.gone.map((entry) => entry.loanId)).toEqual(['LN-8']);
    expect(report.gone[0]!.reason).toBe('absent_from_full_file');
    expect(report.abort).toBeNull();
  });

  it('counts absent cleared previous loans as neither gone nor aborting', () => {
    const report = plan([loan({ loanId: 'LN-9', dpd: 10 }), loan({ loanId: 'LN-9a', dpd: 14 })], [
      ['LN-9', { dpd: 10, overdueAmount: 0, outstanding: 0, status: 'overdue' }],
      ['LN-9a', { dpd: 14, overdueAmount: 30000, outstanding: 2500000, status: 'overdue' }],
      ['LN-10', { dpd: 0, overdueAmount: 0, outstanding: 0, status: 'cleared' }],
      ['LN-12', { dpd: 0, overdueAmount: 0, outstanding: 0, status: 'cleared' }]
    ]);
    expect(report.gone).toEqual([]);
    expect(report.abort).toBeNull();
  });

  it('aborts when more than 40 percent of the previous snapshot vanishes', () => {
    const previous: PrevEntry[] = [
      ...Array.from({ length: 6 }, (_, i): PrevEntry => [`GO-${i}`, { dpd: 10, overdueAmount: 1000, outstanding: 2000, status: 'overdue' }]),
      ...Array.from({ length: 4 }, (_, i): PrevEntry => [`CL-${i}`, { dpd: 0, overdueAmount: 0, outstanding: 0, status: 'cleared' }])
    ];
    const report = plan(Array.from({ length: 6 }, (_, i) => loan({ loanId: `NW-${i}`, dpd: 10 })), previous);
    expect(report.abort?.code).toBe('vanished_over_40pct');
  });

  it('aborts when the file has under half the previous row count even if nothing vanishes', () => {
    const rows = Array.from({ length: 4 }, (_, i) => loan({ loanId: `OD-${i}`, dpd: 11 }));
    const previous: PrevEntry[] = [
      ...rows.map((row): PrevEntry => [row.loanId, { dpd: 10, overdueAmount: 1000, outstanding: 2000, status: 'overdue' }]),
      ...Array.from({ length: 6 }, (_, i): PrevEntry => [`CL-${i}`, { dpd: 0, overdueAmount: 0, outstanding: 0, status: 'cleared' }])
    ];
    const report = plan(rows, previous);
    expect(report.gone).toEqual([]);
    expect(report.abort?.code).toBe('under_half_previous_count');
  });

  it('aborts an as_of earlier than the latest committed batch', () => {
    const report = plan([loan({ loanId: 'LN-11', dpd: 10 })], [], { latestBatchDate: '2026-11-04' });
    expect(report.abort?.code).toBe('as_of_backdated');
  });

  it('accepts an as_of equal to the latest committed batch for re-runs', () => {
    const report = plan([loan({ loanId: 'LN-12', dpd: 10 })], [], { latestBatchDate: '2026-11-01' });
    expect(report.abort).toBeNull();
  });

  it('warns on pincodes outside the provided territory map', () => {
    const report = plan([loan({ loanId: 'LN-13', dpd: 10, pincode: '999999' })], [], { territory: TERRITORY });
    expect(report.warnings.map((warning) => warning.code)).toContain('pincode_not_in_territory');
    expect(report.newLoans[0]!.territoryOfficerId).toBeNull();
  });

  it('carries parse-warning code and loan id through to plan warnings', () => {
    const report = plan([loan({ loanId: 'LN-19', dpd: 10 })], [], {
      warnings: [
        { rowNo: 4, loanId: 'LN-19', column: 'mobile', code: 'bad_mobile', message: 'mobile 9.87E+9 is not 10 digits starting 6-9' }
      ]
    });
    expect(report.warnings).toEqual([
      { rowNo: 4, loanId: 'LN-19', code: 'bad_mobile', message: 'mobile 9.87E+9 is not 10 digits starting 6-9' }
    ]);
  });

  it('matches exact pincode-locality territory before generic pincode rows', () => {
    const report = plan([loan({ loanId: 'LN-14', dpd: 10, pincode: '452001', locality: 'Bhawarkua' })], [], { territory: TERRITORY });
    expect(report.warnings).toEqual([]);
    expect(report.newLoans[0]!.territoryOfficerId).toBe('officer-local-1');
    const generic = plan([loan({ loanId: 'LN-15', dpd: 10, pincode: '452001', locality: 'Elsewhere' })], [], { territory: TERRITORY });
    expect(generic.newLoans[0]!.territoryOfficerId).toBe('officer-generic-1');
  });

  it('counts every class consistently in one plan', () => {
    const rows = [
      loan({ loanId: 'NW-A', dpd: 41 }),
      loan({ loanId: 'OD-A', dpd: 15, overdueAmount: 100000 }),
      loan({ loanId: 'OD-B', dpd: 20, overdueAmount: 500000 })
    ];
    const previous: PrevEntry[] = [
      ['OD-A', { dpd: 15, overdueAmount: 100000, outstanding: 700000, status: 'overdue' }],
      ['OD-B', { dpd: 20, overdueAmount: 600000, outstanding: 900000, status: 'overdue' }],
      ['CL-A', { dpd: 0, overdueAmount: 0, outstanding: 0, status: 'cleared' }]
    ];
    const report = plan(rows, previous, { dropped: 2, skipped: 1 });
    expect(report.counts).toEqual({ total: 3, imported: 3, dropped: 2, skipped: 1, new: 1, lateDiscovery: 1, aging: 1, partPaid: 1, anomalous: 0, gone: 0 });
    expect(report.abort).toBeNull();
  });
});
