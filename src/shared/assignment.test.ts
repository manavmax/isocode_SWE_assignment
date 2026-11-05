import { describe, expect, it } from 'vitest';
import { brokenPromisesInWindow, loanWeight, workingDays, planAssignment } from './assignment.js';
import type {
  AssignmentAbsence,
  AssignmentContact,
  AssignmentInput,
  AssignmentLoan,
  AssignmentOfficer,
  AssignmentPromise,
  AssignmentTerritory
} from './assignment.js';

const RUN = '2026-11-10';
const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';

function officer(id: string, over: Partial<AssignmentOfficer> = {}): AssignmentOfficer {
  return { id, branchId: B1, active: true, capacityPoints: 10, ...over };
}

function loan(over: Partial<AssignmentLoan> & { loanId: string }): AssignmentLoan {
  const { loanId, ...rest } = over;
  return {
    loanId,
    borrowerName: `Borrower ${loanId}`,
    branchId: B1,
    pincode: '452001',
    locality: null,
    dpd: 10,
    outstanding: 100000,
    mobile: '9876543210',
    altMobile: null,
    address: 'address',
    assignedOfficerId: null,
    homeOfficerId: null,
    status: 'overdue',
    ...rest
  };
}

function terr(pincode: string, locality: string | null, officerId: string, branchId = B1, rank = 1): AssignmentTerritory {
  return { branchId, pincode, locality, officerId, rank };
}

function absence(officerId: string, fromDate: string, toDate: string, coverOfficerId: string | null = null): AssignmentAbsence {
  return { officerId, fromDate, toDate, coverOfficerId };
}

function contact(loanId: string, attemptedAt: string): AssignmentContact {
  return { loanId, attemptedAt };
}

function promise(loanId: string, promisedDate: string, status: AssignmentPromise['status'], createdOn = promisedDate): AssignmentPromise {
  return { loanId, promisedDate, status, createdOn };
}

function plan(input: Partial<AssignmentInput>) {
  return planAssignment({
    runDate: RUN,
    loans: [],
    officers: [],
    territory: [],
    absences: [],
    promises: [],
    contacts: [],
    ...input
  });
}

describe('loan weight (SPEC 10.2)', () => {
  it('is 1 at base and adds 0.5 at dpd 16 and another 0.5 at dpd 31', () => {
    expect(loanWeight(loan({ loanId: 'L1', dpd: 15 }), false)).toBe(1);
    expect(loanWeight(loan({ loanId: 'L2', dpd: 16 }), false)).toBe(1.5);
    expect(loanWeight(loan({ loanId: 'L3', dpd: 31 }), false)).toBe(2);
  });

  it('adds 0.5 for a broken promise in the last 14 days', () => {
    expect(loanWeight(loan({ loanId: 'L4' }), true)).toBe(1.5);
    expect(loanWeight(loan({ loanId: 'L5', dpd: 31 }), true)).toBe(2.5);
  });

  it('adds 0.5 at outstanding of exactly Rs 10 lakh and not below', () => {
    expect(loanWeight(loan({ loanId: 'L6', outstanding: 99999999 }), false)).toBe(1);
    expect(loanWeight(loan({ loanId: 'L7', outstanding: 100000000 }), false)).toBe(1.5);
  });

  it('caps out at 3.0 with every component', () => {
    const max = loan(loanIdExtra());
    expect(loanWeight(max, true)).toBe(3);
  });

  function loanIdExtra(): Partial<AssignmentLoan> & { loanId: string } {
    return { loanId: 'L8', dpd: 45, outstanding: 200000000 };
  }
});

describe('working days (Mon-Sat, Sunday off)', () => {
  it('counts Mon-Sat and excludes Sunday', () => {
    expect(workingDays('2026-11-09', '2026-11-15')).toBe(6);
    expect(workingDays('2026-11-08', '2026-11-10')).toBe(2);
    expect(workingDays('2026-11-09', '2026-11-12')).toBe(4);
  });

  it('a single-day absence is 1 working day', () => {
    expect(workingDays('2026-11-10', '2026-11-10')).toBe(1);
  });
});

describe('broken promise window (A22: promised-date anchor)', () => {
  it('counts broken and broken_part promises promised inside the last 14 days', () => {
    const promises = [
      promise('L-A', '2026-10-27', 'broken'), // exactly 14 days before RUN -> inside
      promise('L-B', '2026-10-26', 'broken_part'), // 15 days -> outside
      promise('L-C', '2026-11-04', 'broken'), // inside
      promise('L-D', '2026-11-04', 'kept'), // wrong status
      promise('L-E', '2026-11-04', 'open'), // wrong status
      promise('L-F', '2026-11-15', 'broken') // future promised date
    ];
    expect([...brokenPromisesInWindow(promises, RUN)].sort()).toEqual(['L-A', 'L-C']);
  });

  it('no promise fixtures at all yield no broken loans (nothing is seeded yet)', () => {
    expect(brokenPromisesInWindow([], RUN).size).toBe(0);
  });
});

describe('territory resolution (SPEC 10.1)', () => {
  it('locality row beats pincode row', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', locality: 'Bhawarkua' })],
      officers: [officer('O-GEN'), officer('O-LOC')],
      territory: [terr('452001', null, 'O-GEN'), terr('452001', 'Bhawarkua', 'O-LOC')]
    });
    expect(result.decisions[0]!.toOfficerId).toBe('O-LOC');
    expect(result.decisions[0]!.reason).toBe('new_assigned');
  });

  it('falls back by prefix 45201x then 4520xx then 452xxx within the branch', () => {
    const officers = [officer('O-5'), officer('O-4'), officer('O-3')];
    const territory = [terr('452017', null, 'O-5'), terr('452099', null, 'O-4'), terr('452888', null, 'O-3')];
    const result = plan({
      loans: [loan({ loanId: 'L1', pincode: '452015' })],
      officers,
      territory
    });
    expect(result.decisions[0]!.toOfficerId).toBe('O-5');
    expect(result.decisions[0]!.reason).toBe('new_assigned');

    const tier2 = plan({
      loans: [loan({ loanId: 'L1', pincode: '452015' })],
      officers,
      territory: [terr('452099', null, 'O-4'), terr('452888', null, 'O-3')]
    });
    expect(tier2.decisions[0]!.toOfficerId).toBe('O-4');

    const tier3 = plan({
      loans: [loan({ loanId: 'L1', pincode: '452015' })],
      officers,
      territory: [terr('452888', null, 'O-3')]
    });
    expect(tier3.decisions[0]!.toOfficerId).toBe('O-3');
  });

  it('never crosses branches: an eligible officer in another branch is ignored', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', pincode: '452015' })],
      officers: [officer('O-B2', { branchId: B2 })],
      territory: [terr('452015', null, 'O-B2', B2)]
    });
    expect(result.decisions[0]!.toOfficerId).toBeNull();
    expect(result.decisions[0]!.reason).toBe('queue_unmapped');
    expect(result.decisions[0]!.status).toBe('queue');
  });

  it('sends an unmapped pincode to the branch-manager queue; a never-assigned loan logs nothing (A27)', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', pincode: '999999' })],
      officers: [officer('O-1')],
      territory: [terr('452001', null, 'O-1')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBeNull();
    expect(d.status).toBe('queue');
    expect(d.reason).toBe('queue_unmapped');
    expect(d.changed).toBe(true);
    // The officer never changed (absent -> absent): no assignment_log row.
    expect(result.logEntries).toHaveLength(0);
  });

  it('a queued loan is retried and assigned when the territory appears', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', pincode: '452015', status: 'queue' })],
      officers: [officer('O-5')],
      territory: [terr('452017', null, 'O-5')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-5');
    expect(d.reason).toBe('new_assigned');
    expect(d.status).toBe('overdue');
    expect(result.logEntries[0]!.fromOfficerId).toBeNull();
  });

  it('a retried queued loan overwrites a stale bookkeeping home with the chosen officer (A25)', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', status: 'queue', homeOfficerId: 'O-STALE' })],
      officers: [officer('O-5')],
      territory: [terr('452017', null, 'O-5')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-5');
    expect(d.reason).toBe('new_assigned');
    expect(d.homeOfficerId).toBe('O-5');
    expect(result.logEntries[0]).toMatchObject({ loanId: 'L1', fromOfficerId: null, toOfficerId: 'O-5' });
  });

  it('queues a new loan when every officer on its territory rows is on 3+ day leave, and the healthy officer of a second row takes it (A24)', () => {
    const queued = plan({
      loans: [loan({ loanId: 'L1' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452002', null, 'O-V')],
      absences: [absence('O-C', '2026-11-09', '2026-11-12', 'O-V')]
    });
    const q = queued.decisions[0]!;
    expect(q.reason).toBe('queue_unmapped');
    expect(q.status).toBe('queue');
    expect(q.toOfficerId).toBeNull();
    expect(q.changed).toBe(true);
    // Officer never changed (the loan sits with nobody): no log row (A27).
    expect(queued.logEntries).toHaveLength(0);

    const routed = plan({
      loans: [loan({ loanId: 'L2' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452001', null, 'O-V', B1, 2)],
      absences: [absence('O-C', '2026-11-09', '2026-11-12', 'O-V')]
    });
    const d = routed.decisions[0]!;
    expect(d.toOfficerId).toBe('O-V');
    expect(d.reason).toBe('new_assigned');
    expect(d.homeOfficerId).toBe('O-V');
  });

  it('warns on an invalid pincode by queuing the loan', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', pincode: null })],
      officers: [officer('O-1')],
      territory: [terr('452001', null, 'O-1')]
    });
    expect(result.decisions[0]!.reason).toBe('queue_unmapped');
  });
});

describe('caps and scoring (SPEC 10.3, 10.4)', () => {
  // Held loans keep their officer (each holder gets its own territory row) so
  // their weights load the officers without triggering reassignment churn.
  const held = (officerId: string, count: number, pincode = '452002'): AssignmentLoan[] =>
    Array.from({ length: count }, (_, i) =>
      loan({ loanId: `${officerId}-H${i}`, pincode, assignedOfficerId: officerId, homeOfficerId: officerId })
    );

  it('prefers an officer whose projected utilisation is under the soft cap over a better-scoring one over it', () => {
    // O-A holds 9.0 -> projected (9+1)/10 = 1.0 (at soft cap, allowed).
    // O-B holds 8x1.0 + 1x1.5 = 9.5 -> projected 1.05 (over soft) but is
    // primary (-0.10): raw score favours B (0.95 < 1.0). The soft cap wins.
    const bHeld = [...held('O-B', 8, '452003'), loan({ loanId: 'O-B-H-big', pincode: '452003', dpd: 20, assignedOfficerId: 'O-B', homeOfficerId: 'O-B' })];
    const result = plan({
      loans: [...held('O-A', 9, '452002'), ...bHeld, loan({ loanId: 'L-NEW' })],
      officers: [officer('O-A'), officer('O-B')],
      territory: [terr('452001', null, 'O-B'), terr('452001', null, 'O-A', B1, 2), terr('452002', null, 'O-A'), terr('452003', null, 'O-B')]
    });
    expect(result.decisions.find((d) => d.loanId === 'L-NEW')!.toOfficerId).toBe('O-A');
  });

  it('never assigns a candidate projected over the hard cap while another exists', () => {
    // O-A holds 12.0 -> projected (12+1)/10 = 1.3 (over hard). O-B holds
    // 10.0 -> projected 1.1 (over soft, under hard). O-A is primary but
    // excluded -> O-B wins.
    const result = plan({
      loans: [...held('O-A', 12, '452002'), ...held('O-B', 10, '452003'), loan({ loanId: 'L-NEW' })],
      officers: [officer('O-A'), officer('O-B')],
      territory: [terr('452001', null, 'O-A'), terr('452001', null, 'O-B', B1, 2), terr('452002', null, 'O-A'), terr('452003', null, 'O-B')]
    });
    expect(result.decisions.find((d) => d.loanId === 'L-NEW')!.toOfficerId).toBe('O-B');
  });

  it('keeps the current officer under hysteresis when the improvement is below 0.15', () => {
    // O-C holds 5.5 incl L1 (three dpd-20 loans at 1.5) -> incumbent score
    // 5.5/10 - 0.35 = 0.20. O-D holds 1.0 and is primary: challenger score
    // (1+1)/10 - 0.10 = 0.10. Improvement 0.10 < 0.15 -> keep, no log row.
    const ocExtras = Array.from({ length: 3 }, (_, i) =>
      loan({ loanId: `OC-H${i}`, dpd: 20, pincode: '452004', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })
    );
    const odExtra = loan({ loanId: 'OD-H', pincode: '452005', assignedOfficerId: 'O-D', homeOfficerId: 'O-D' });
    const result = plan({
      loans: [...ocExtras, odExtra, loan({ loanId: 'L1', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-D')],
      territory: [terr('452001', null, 'O-D'), terr('452001', null, 'O-C', B1, 2), terr('452004', null, 'O-C'), terr('452005', null, 'O-D')]
    });
    const d = result.decisions.find((x) => x.loanId === 'L1')!;
    expect(d.toOfficerId).toBe('O-C');
    expect(d.reason).toBe('carry_forward');
    expect(d.changed).toBe(false);
    expect(result.logEntries).toHaveLength(0);
  });

  it('switches away from the current officer when the improvement reaches exactly 0.15, logging the change', () => {
    // O-C holds 6.5 incl L1 (three dpd-20 loans + one plain) -> incumbent score
    // 6.5/10 - 0.35 = 0.30. O-D holds one dpd-20 loan (1.5) and is primary:
    // challenger score (1.5+1)/10 - 0.10 = 0.15. Improvement exactly 0.15 ->
    // switch, one log row, home moves to the new officer.
    const ocExtras = [
      ...Array.from({ length: 3 }, (_, i) =>
        loan({ loanId: `OC-H${i}`, dpd: 20, pincode: '452004', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })
      ),
      loan({ loanId: 'OC-H-plain', pincode: '452004', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })
    ];
    const odExtra = loan({ loanId: 'OD-H', dpd: 20, pincode: '452005', assignedOfficerId: 'O-D', homeOfficerId: 'O-D' });
    const result = plan({
      loans: [...ocExtras, odExtra, loan({ loanId: 'L1', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-D')],
      territory: [terr('452001', null, 'O-D'), terr('452001', null, 'O-C', B1, 2), terr('452004', null, 'O-C'), terr('452005', null, 'O-D')]
    });
    const d = result.decisions.find((x) => x.loanId === 'L1')!;
    expect(d.toOfficerId).toBe('O-D');
    expect(d.reason).toBe('reassigned_score');
    expect(d.changed).toBe(true);
    expect(d.homeOfficerId).toBe('O-D');
    expect(result.logEntries).toHaveLength(1);
    expect(result.logEntries[0]).toMatchObject({ loanId: 'L1', fromOfficerId: 'O-C', toOfficerId: 'O-D', reason: 'reassigned_score' });
  });

  it('gives the -0.35 current-assignee bonus so an even field keeps the incumbent', () => {
    // O-C holds L1 only (projected 0.1, score 0.1 - 0.35 = -0.25).
    // O-E empty and primary (0.1 - 0.10 = 0.0). Without the -0.35 bonus E would win.
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-E')],
      territory: [terr('452001', null, 'O-E'), terr('452001', null, 'O-C', B1, 2)]
    });
    expect(result.decisions[0]!.toOfficerId).toBe('O-C');
    expect(result.decisions[0]!.reason).toBe('carry_forward');
    expect(result.decisions[0]!.changed).toBe(false);
    expect(result.logEntries).toHaveLength(0);
  });

  it('gives the -0.25 borrower affinity bonus for the officer holding the borrower\'s other loan', () => {
    // O-E1 primary: score 0.1 - 0.10 = 0.0. O-E2 holds another loan of the same
    // borrower (case-insensitive): 0.1 - 0.25 = -0.15 -> E2 wins.
    const other = loan({ loanId: 'L-OTHER', borrowerName: 'Same Borrower', assignedOfficerId: 'O-E2', homeOfficerId: 'O-E2' });
    const result = plan({
      loans: [other, loan({ loanId: 'L1', borrowerName: 'same borrower' })],
      officers: [officer('O-E1'), officer('O-E2')],
      territory: [terr('452001', null, 'O-E1'), terr('452001', null, 'O-E2', B1, 2)]
    });
    expect(result.decisions.find((d) => d.loanId === 'L1')!.toOfficerId).toBe('O-E2');
  });

  it('does not count the loan itself as borrower affinity', () => {
    // O-C currently holds L1 plus one plain loan and one dpd-20 loan
    // (2.5 of other weight): incumbent score 3.5/10 - 0.35 = 0.00 with the
    // self-exclusion. O-H holds the borrower's other loan and is primary:
    // score = (1+1)/10 - 0.25 - 0.10 = -0.15 -> H wins by 0.15 (>= 0.15).
    // If the loan itself counted as affinity, C would score -0.25, the
    // improvement would drop to 0.10 and L1 would stay on C.
    const others = [
      loan({ loanId: 'C-H0', pincode: '452002', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' }),
      loan({ loanId: 'C-BIG', dpd: 20, pincode: '452002', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })
    ];
    const other = loan({ loanId: 'L-OTHER', borrowerName: 'Same Borrower', assignedOfficerId: 'O-H', homeOfficerId: 'O-H' });
    const result = plan({
      loans: [...others, other, loan({ loanId: 'L1', borrowerName: 'Same Borrower', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-H')],
      territory: [terr('452001', null, 'O-H'), terr('452001', null, 'O-C', B1, 2), terr('452002', null, 'O-C')]
    });
    const d = result.decisions.find((d) => d.loanId === 'L1')!;
    expect(d.toOfficerId).toBe('O-H');
    expect(d.reason).toBe('reassigned_score');
  });

  it('gives the -0.10 primary officer bonus from the territory-resolved officer', () => {
    // Both empty: equal projected utilisation. Tie-break on officer id would
    // pick O-A; the primary bonus must make O-Z win despite the id order.
    const result = plan({
      loans: [loan({ loanId: 'L1' })],
      officers: [officer('O-A'), officer('O-Z')],
      territory: [terr('452001', null, 'O-Z')]
    });
    expect(result.decisions[0]!.toOfficerId).toBe('O-Z');
  });

  it('counts a borrower loan moved earlier in this batch as affinity, keeping a rerun stable', () => {
    // A-LOAN sits with O-C but its pincode rows only name O-H -> reassigned
    // out of territory to O-H. B-LOAN (same borrower, new) then sees O-H
    // carrying A: affinity -0.25 beats primary O-C (0.1 - 0.10 = 0.00).
    // Without the mid-batch holdings move, B would land on O-C and the rerun
    // would flip it to O-H, writing a log row.
    const loans = [
      loan({ loanId: 'A-LOAN', borrowerName: 'B-X', pincode: '452099', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' }),
      loan({ loanId: 'B-LOAN', borrowerName: 'B-X' })
    ];
    const input = {
      runDate: RUN,
      officers: [officer('O-C'), officer('O-H')],
      territory: [terr('452099', null, 'O-H'), terr('452001', null, 'O-C'), terr('452001', null, 'O-H', B1, 2)],
      absences: [] as AssignmentAbsence[],
      promises: [] as AssignmentPromise[],
      contacts: [] as AssignmentContact[]
    };
    const result = plan({ ...input, loans });
    const dA = result.decisions.find((d) => d.loanId === 'A-LOAN')!;
    expect(dA.toOfficerId).toBe('O-H');
    expect(dA.reason).toBe('reassigned_out_of_territory');
    expect(result.decisions.find((d) => d.loanId === 'B-LOAN')!.toOfficerId).toBe('O-H');

    const applied = loans.map((l) => {
      const d = result.decisions.find((x) => x.loanId === l.loanId)!;
      return { ...l, assignedOfficerId: d.toOfficerId, homeOfficerId: d.homeOfficerId ?? l.homeOfficerId, status: d.status };
    });
    const rerun = plan({ ...input, loans: applied });
    expect(rerun.logEntries).toHaveLength(0);
    expect(rerun.decisions.find((d) => d.loanId === 'B-LOAN')!.toOfficerId).toBe('O-H');
  });
});

describe('leave (SPEC 10.6)', () => {
  it('a 1-2 working day leave changes nothing but the badge', () => {
    // O-C is on leave Sun-Tue = 2 working days covering the run date.
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452002', null, 'O-V')],
      absences: [absence('O-C', '2026-11-08', '2026-11-10', 'O-V')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-C');
    expect(d.reason).toBe('carry_forward');
    expect(d.changed).toBe(false);
    expect(result.logEntries).toHaveLength(0);
  });

  it('a 3+ working day leave reassigns temporarily to the cover officer, keeping home_officer_id', () => {
    // O-C on leave Mon-Thu = 4 working days; cover O-V.
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452002', null, 'O-V')],
      absences: [absence('O-C', '2026-11-09', '2026-11-12', 'O-V')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-V');
    expect(d.reason).toBe('reassigned_leave');
    expect(d.changed).toBe(true);
    expect(d.homeOfficerId).toBe('O-C');
    expect(result.logEntries[0]).toMatchObject({ loanId: 'L1', fromOfficerId: 'O-C', toOfficerId: 'O-V', reason: 'reassigned_leave' });
  });

  it('a 3+ working day leave without a cover officer scores among eligible officers', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452001', null, 'O-V', B1, 2)],
      absences: [absence('O-C', '2026-11-09', '2026-11-12', null)]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-V');
    expect(d.reason).toBe('reassigned_leave');
    expect(d.homeOfficerId).toBe('O-C');
  });

  it('an inactive cover officer is skipped and the loan is scored among eligible officers', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-V', { active: false }), officer('O-W')],
      territory: [terr('452001', null, 'O-C'), terr('452001', null, 'O-W', B1, 2)],
      absences: [absence('O-C', '2026-11-09', '2026-11-12', 'O-V')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-W');
    expect(d.reason).toBe('reassigned_leave');
  });

  it('on return, untouched loans with no open promise revert to home_officer_id', () => {
    // O-C's leave ended Fri 2026-11-06; loan sits with cover O-V.
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-V', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452002', null, 'O-V')],
      absences: [absence('O-C', '2026-11-02', '2026-11-06', 'O-V')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-C');
    expect(d.reason).toBe('revert_return');
    expect(d.changed).toBe(true);
    expect(result.logEntries[0]).toMatchObject({ loanId: 'L1', fromOfficerId: 'O-V', toOfficerId: 'O-C', reason: 'revert_return' });
  });

  it('on return, touched loans (contact during the leave) stay with the cover officer', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-V', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452002', null, 'O-V')],
      absences: [absence('O-C', '2026-11-02', '2026-11-06', 'O-V')],
      contacts: [contact('L1', '2026-11-05')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-V');
    expect(d.reason).toBe('carry_forward');
    expect(d.changed).toBe(false);
    expect(d.homeOfficerId).toBe('O-C');
    expect(result.logEntries).toHaveLength(0);
  });

  it('on return, loans with an open promise stay with the cover officer', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-V', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452002', null, 'O-V')],
      absences: [absence('O-C', '2026-11-02', '2026-11-06', 'O-V')],
      promises: [promise('L1', '2026-11-20', 'open', '2026-11-04')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-V');
    expect(d.reason).toBe('carry_forward');
    expect(d.changed).toBe(false);
  });

  it('while the home officer is still on leave, the temp cover is kept as-is', () => {
    // Run happens mid-leave; cover already holds the loan; nothing changes.
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-V', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452002', null, 'O-V')],
      absences: [absence('O-C', '2026-11-09', '2026-11-12', 'O-V')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-V');
    expect(d.reason).toBe('carry_forward');
    expect(d.changed).toBe(false);
    expect(result.logEntries).toHaveLength(0);
  });
});

describe('edge cases (SPEC 10.7) and ordering (SPEC 10.5)', () => {
  it('a loan at 61+ DPD stays assigned, is flagged, and is never rescored', () => {
    // L1 and its officer's own held loans sit on O-C's rows; challenger O-D
    // would beat O-C by more than the hysteresis threshold but the 61+ guard
    // precedes scoring entirely.
    const result = plan({
      loans: [
        ...Array.from({ length: 4 }, (_, i) =>
          loan({ loanId: `C-H${i}`, pincode: '452002', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })
        ),
        loan({ loanId: 'L1', dpd: 65, pincode: '452002', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })
      ],
      officers: [officer('O-C'), officer('O-D')],
      territory: [terr('452001', null, 'O-D'), terr('452002', null, 'O-C')]
    });
    const d = result.decisions.find((x) => x.loanId === 'L1')!;
    expect(d.toOfficerId).toBe('O-C');
    expect(d.reason).toBe('stays_61plus');
    expect(d.flagged).toBe(true);
    expect(d.changed).toBe(false);
    expect(result.logEntries).toHaveLength(0);
  });

  it('a 61+ DPD loan still moves when its officer goes on 3+ day leave', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', dpd: 70, assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-V')],
      territory: [terr('452001', null, 'O-C'), terr('452002', null, 'O-V')],
      absences: [absence('O-C', '2026-11-09', '2026-11-12', 'O-V')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-V');
    expect(d.reason).toBe('reassigned_leave');
  });

  it('a new 61+ DPD loan without an assignee is assigned normally', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', dpd: 61 })],
      officers: [officer('O-1')],
      territory: [terr('452001', null, 'O-1')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-1');
    expect(d.reason).toBe('new_assigned');
    expect(d.flagged).toBe(false);
  });

  it('no phone and no address goes to the data-fix queue; either one present is workable', () => {
    const result = plan({
      loans: [
        loan({ loanId: 'L1', mobile: null, altMobile: null, address: null }),
        loan({ loanId: 'L2', mobile: null, altMobile: null, address: 'has address' }),
        loan({ loanId: 'L3', mobile: '9876543210', address: null })
      ],
      officers: [officer('O-1')],
      territory: [terr('452001', null, 'O-1')]
    });
    const d1 = result.decisions.find((d) => d.loanId === 'L1')!;
    expect(d1.reason).toBe('queue_data_fix');
    expect(d1.toOfficerId).toBeNull();
    expect(d1.status).toBe('queue');
    expect(result.decisions.find((d) => d.loanId === 'L2')!.toOfficerId).toBe('O-1');
    expect(result.decisions.find((d) => d.loanId === 'L3')!.toOfficerId).toBe('O-1');
  });

  it('an already data-fix queued loan on rerun produces no change and no log row', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', mobile: null, altMobile: null, address: null, status: 'queue' })],
      officers: [officer('O-1')],
      territory: [terr('452001', null, 'O-1')]
    });
    const d = result.decisions[0]!;
    expect(d.reason).toBe('queue_data_fix');
    expect(d.changed).toBe(false);
    expect(result.logEntries).toHaveLength(0);
  });

  it('every eligible officer over the hard cap: assigns to minimum utilisation and alerts', () => {
    // Single officer holding 12.0; orphan loan w=1 -> projected 1.3. No choice.
    const held = Array.from({ length: 12 }, (_, i) =>
      loan({ loanId: `O-A-H${i}`, assignedOfficerId: 'O-A', homeOfficerId: 'O-A' })
    );
    const result = plan({
      loans: [...held, loan({ loanId: 'L1' })],
      officers: [officer('O-A')],
      territory: [terr('452001', null, 'O-A')]
    });
    const d = result.decisions.find((x) => x.loanId === 'L1')!;
    expect(d.toOfficerId).toBe('O-A');
    expect(d.reason).toBe('new_assigned');
    expect(result.alerts).toEqual([{ code: 'all_officers_over_hard_cap', loanId: 'L1' }]);
  });

  it('processes new and orphaned loans by descending outstanding then loan id', () => {
    // capacity 3: the first loan processed takes O-A under the soft cap; the
    // next cannot (projected over hard) and goes to O-B. If the order were
    // reversed, the small loan would take O-A and the big one O-B.
    const result = plan({
      loans: [
        loan({ loanId: 'L-SMALL', outstanding: 10000000 }),
        loan({ loanId: 'L-BIG', outstanding: 300000000, dpd: 45 })
      ],
      officers: [officer('O-A', { capacityPoints: 3 }), officer('O-B', { capacityPoints: 3 })],
      territory: [terr('452001', null, 'O-A'), terr('452001', null, 'O-B', B1, 2)]
    });
    expect(result.decisions.find((d) => d.loanId === 'L-BIG')!.toOfficerId).toBe('O-A');
    expect(result.decisions.find((d) => d.loanId === 'L-SMALL')!.toOfficerId).toBe('O-B');
  });

  it('ignores cleared loans entirely', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', status: 'cleared', assignedOfficerId: 'O-1', homeOfficerId: 'O-1' })],
      officers: [officer('O-1')],
      territory: [terr('452001', null, 'O-1')]
    });
    expect(result.decisions).toHaveLength(0);
  });

  it('reassigns a carry-forward whose officer left the territory, permanently moving home', () => {
    // O-C holds the loan but O-C is no longer in any territory row.
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C'), officer('O-N')],
      territory: [terr('452001', null, 'O-N')]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-N');
    expect(d.reason).toBe('reassigned_out_of_territory');
    expect(d.homeOfficerId).toBe('O-N');
    expect(result.logEntries[0]!.reason).toBe('reassigned_out_of_territory');
  });

  it('reassigns a carry-forward whose officer is inactive', () => {
    const result = plan({
      loans: [loan({ loanId: 'L1', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' })],
      officers: [officer('O-C', { active: false }), officer('O-N')],
      territory: [terr('452001', null, 'O-C'), terr('452001', null, 'O-N', B1, 2)]
    });
    const d = result.decisions[0]!;
    expect(d.toOfficerId).toBe('O-N');
    expect(d.reason).toBe('reassigned_inactive');
    expect(d.homeOfficerId).toBe('O-N');
  });
});

describe('rerun idempotency (SPEC 10.5: a rerun produces zero diffs)', () => {
  it('re-running the whole batch yields zero assignment_log rows', () => {
    const officers = [officer('O-C'), officer('O-D'), officer('O-V')];
    const territory = [terr('452001', null, 'O-C'), terr('452001', null, 'O-D', B1, 2), terr('452002', null, 'O-V')];
    const absences = [absence('O-D', '2026-11-09', '2026-11-12', 'O-V')];
    const loans = [
      loan({ loanId: 'L-NEW1', outstanding: 300000000 }),
      loan({ loanId: 'L-NEW2', dpd: 40, outstanding: 150000000 }),
      loan({ loanId: 'L-CARRY', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' }),
      loan({ loanId: 'L-LEAVE', assignedOfficerId: 'O-C', homeOfficerId: 'O-C' }),
      loan({ loanId: 'L-QUEUE', pincode: '499999', status: 'queue' }),
      loan({ loanId: 'L-DATAFIX', mobile: null, altMobile: null, address: null, status: 'queue' })
    ];

    const run1 = plan({ loans, officers, territory, absences });
    // Apply run 1's decisions to the loan fixtures the way the runner would.
    const applied = loans.map((l) => {
      const d = run1.decisions.find((x) => x.loanId === l.loanId)!;
      return { ...l, assignedOfficerId: d.toOfficerId, homeOfficerId: d.homeOfficerId ?? l.homeOfficerId, status: d.status };
    });

    const run2 = plan({ loans: applied, officers, territory, absences });
    expect(run2.logEntries).toHaveLength(0);
    for (const d of run2.decisions) {
      const first = run1.decisions.find((x) => x.loanId === d.loanId)!;
      expect(d.toOfficerId).toBe(first.toOfficerId);
      expect(d.status).toBe(first.status);
    }
  });
});
