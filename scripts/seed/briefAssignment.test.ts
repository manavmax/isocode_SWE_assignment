import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile } from './config.js';
import { buildLoanUniverse, BRIEF_LOAN_IDS } from './loans.js';
import { mulberry32 } from './rng.js';
import { buildTerritoryRows, territoryOfficerIds } from './territory.js';
import { BRANCHES, OFFICER_SPECS } from './staff.js';
import { realRunStaffIds } from './staffIdsFixture.js';
import { DEMO_ACCOUNTS } from '../../src/server/demo.js';
import { planAssignment } from '../../src/shared/assignment.js';
import type { AssignmentLoan, AssignmentOfficer, AssignmentTerritory } from '../../src/shared/assignment.js';

const realFile = fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url));
const config = loadSeedConfigFile(realFile);
const universe = buildLoanUniverse(mulberry32(20261105), config, 20261105);

/** Fake stable ids — the planner only compares ids, so the brief-officer
 *  assertions need no database. The id map comes from the REAL run wiring
 *  (the A50 lesson): StaffIds shaped as upsertStaff + ensureDemoAccounts
 *  produce them, rekeyed by territoryOfficerIds exactly as writeTerritory
 *  does. The demo chips ride in the same map — demo-officer-1/2 share the
 *  Rahul/Neha officer rows, the joiner has a fresh id — and at runtime
 *  runAssignment reads them from the officers table like any other officer. */
const staffIds = realRunStaffIds();
const officerIdFor = territoryOfficerIds(staffIds);

const BRIEF_OFFICER: Record<string, string> = {
  'LN-10293': 'Rahul Chouhan',
  'LN-10871': 'Neha Solanki',
  'LN-11930': 'Imran Qureshi'
};

/** End-state territory + officers exactly as the live run writes them. */
const territory: readonly AssignmentTerritory[] = buildTerritoryRows(config, officerIdFor).map((row) => ({
  branchId: staffIds.branchIdByCode[row.branchCode]!,
  pincode: row.pincode,
  locality: row.locality,
  officerId: officerIdFor[row.officerName]!,
  rank: 1
}));
const joinerIds = DEMO_ACCOUNTS.filter((account) => account.officerUser && account.createsOfficer).map(
  (account) => officerIdFor[account.officerName!]!
);
const officers: readonly AssignmentOfficer[] = [
  ...OFFICER_SPECS.map((officer) => ({
    id: officerIdFor[officer.name]!,
    branchId: staffIds.branchIdByCode[officer.branchCode]!,
    active: true,
    capacityPoints: config.people.officer_capacity_points
  })),
  ...joinerIds.map((id) => ({ id, branchId: staffIds.branchIdByCode.UJJAIN!, active: true, capacityPoints: 30 }))
];

/** All end-active loans at their end-date dpd, unassigned — one clean
 *  assignment run over the whole book, like the last file's runner pass. */
function endStateLoans(): AssignmentLoan[] {
  return universe.loans
    .filter((loan) => loan.destiny !== 'cure')
    .map((loan) => ({
      loanId: loan.loanId,
      borrowerName: loan.borrowerName,
      branchId: staffIds.branchIdByCode[loan.branchCode === 'UJJ' ? 'UJJAIN' : loan.branchCode]!,
      pincode: loan.pincode,
      locality: loan.locality,
      dpd: loan.destiny === 'stay' ? loan.reentryDayOffset + 1 : loan.entryDayOffset + 1,
      outstanding: loan.outstandingRupees * 100,
      mobile: loan.mobile,
      altMobile: loan.altMobile,
      address: loan.address,
      assignedOfficerId: null,
      homeOfficerId: null,
      status: 'overdue' as const
    }));
}

describe('the brief loans resolve to the officers the brief names, by territory (A48)', () => {
  it('assigns LN-10293, LN-10871 and LN-11930 to Rahul, Neha and Imran', () => {
    const plan = planAssignment({
      runDate: '2026-11-05',
      loans: endStateLoans(),
      officers,
      territory,
      absences: [],
      promises: [],
      contacts: []
    });
    const byId = new Map(plan.decisions.map((decision) => [decision.loanId, decision]));
    for (const loanId of BRIEF_LOAN_IDS) {
      const decision = byId.get(loanId)!;
      expect(decision.status).toBe('overdue');
      expect(decision.toOfficerId).toBe(officerIdFor[BRIEF_OFFICER[loanId]!]!);
      expect(decision.reason).toBe('new_assigned');
    }
  });

  it('keeps the five 466001 defect loans as the only queued loans', () => {
    const plan = planAssignment({
      runDate: '2026-11-05',
      loans: endStateLoans(),
      officers,
      territory,
      absences: [],
      promises: [],
      contacts: []
    });
    const queued = plan.decisions.filter((decision) => decision.status === 'queue');
    expect(queued).toHaveLength(5);
    const byId = new Map(universe.loans.map((loan) => [loan.loanId, loan]));
    for (const decision of queued) {
      expect(byId.get(decision.loanId)!.pincode).toBe(config.territory.unmapped_defect_pincode);
      expect(decision.reason).toBe('queue_unmapped');
    }
    expect(BRIEF_LOAN_IDS.every((loanId) => byId.get(loanId)!.pincode !== config.territory.unmapped_defect_pincode)).toBe(true);
  });

  it('keeps every officer inside their own branch plan (9 territory rows, 10 officers incl. the joiner)', () => {
    expect(BRANCHES).toHaveLength(3);
    expect(OFFICER_SPECS).toHaveLength(9);
    expect(territory).toHaveLength(9);
    for (const row of territory) {
      expect(officers.find((officer) => officer.id === row.officerId)!.branchId).toBe(row.branchId);
    }
  });
});
