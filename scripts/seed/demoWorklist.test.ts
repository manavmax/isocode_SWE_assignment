import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile } from './config.js';
import { buildLoanUniverse } from './loans.js';
import { mulberry32 } from './rng.js';
import { buildTerritoryRows } from './territory.js';
import { OFFICER_SPECS } from './staff.js';
import { DEMO_ACCOUNTS } from '../../src/server/demo.js';
import { planAssignment } from '../../src/shared/assignment.js';
import type { AssignmentLoan, AssignmentOfficer, AssignmentTerritory } from '../../src/shared/assignment.js';

/**
 * A50: a demo deployment with an empty demo-officer worklist is a failure —
 * the chips exist so the login screen demo shows a real worklist. The seed
 * must therefore (a) link every demo officer-user to its officer and (b)
 * route at least one end-overdue loan to each of them. This test drives the
 * REAL planAssignment over the REAL universe + territory (including the demo
 * officers' slices) with the pinned seed, so a territory or generator change
 * that starves the demo officers fails here, offline, before any deploy.
 */

const realFile = fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url));
const config = loadSeedConfigFile(realFile);
const universe = buildLoanUniverse(mulberry32(20261105), config, 20261105);

/** Fake stable ids keyed by officer name — the planner only compares ids.
 *  The demo officers sit in the same map main.ts builds (staff + demo ids),
 *  which is exactly what writeTerritory feeds buildTerritoryRows. */
const officerIdFor: Record<string, string> = Object.fromEntries([
  ...OFFICER_SPECS.map((officer) => [officer.name, `officer:${officer.username}`]),
  ...DEMO_ACCOUNTS.filter((account) => account.officerUser).map((account) => [account.officerName!, `officer:${account.username}`])
]);
const dbBranchIdFor: Record<string, string> = { IDR: 'IDR', DWS: 'DWS', UJJ: 'UJJAIN' };

const territory: readonly AssignmentTerritory[] = buildTerritoryRows(config, officerIdFor).map((row) => ({
  branchId: row.branchCode,
  pincode: row.pincode,
  locality: row.locality,
  officerId: officerIdFor[row.officerName]!,
  rank: 1
}));

const demoOfficerIds = DEMO_ACCOUNTS.filter((account) => account.officerUser).map((account) => officerIdFor[account.officerName!]!);
const officers: readonly AssignmentOfficer[] = [
  ...OFFICER_SPECS.map((officer) => ({
    id: officerIdFor[officer.name]!,
    branchId: officer.branchCode,
    active: true,
    capacityPoints: config.people.officer_capacity_points
  })),
  ...demoOfficerIds.map((id) => ({ id, branchId: 'UJJAIN', active: true, capacityPoints: 30 }))
];

function endStateLoans(): AssignmentLoan[] {
  return universe.loans
    .filter((loan) => loan.destiny !== 'cure')
    .map((loan) => ({
      loanId: loan.loanId,
      borrowerName: loan.borrowerName,
      branchId: dbBranchIdFor[loan.branchCode]!,
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

describe('every demo account except the manager is linked to an officer with at least one assigned loan (A50)', () => {
  it('exactly one demo account (the manager) has no officer; every other one does', () => {
    const officerAccounts = DEMO_ACCOUNTS.filter((account) => account.officerUser);
    const managerAccounts = DEMO_ACCOUNTS.filter((account) => !account.officerUser);
    expect(managerAccounts).toEqual([{ username: 'demo-manager', role: 'branch_manager', officerName: null, officerUser: false }]);
    for (const account of officerAccounts) {
      expect(account.role).toBe('field_officer');
      expect(officerIdFor[account.officerName!]).toBeTruthy();
    }
  });

  it('the territory plan carries an exact Ujjain locality slice per demo officer', () => {
    const demoRows = buildTerritoryRows(config, officerIdFor).filter((row) => DEMO_ACCOUNTS.some((account) => account.officerName === row.officerName));
    expect(demoRows).toHaveLength(2);
    for (const row of demoRows) {
      expect(row.branchCode).toBe('UJJAIN');
      expect(row.pincode).toBe(config.territory.ujjain_pincode);
      expect(row.locality).toBeTruthy();
      expect(row.locality).not.toBe(config.territory.ujjain_localities[0]); // Freeganj stays with its officer
      expect(officerIdFor[row.officerName]).toBeTruthy();
    }
  });

  it('the universe pins at least one end-overdue loan into each demo slice', () => {
    const demoLocalities = config.territory.ujjain_localities.slice(1, 3);
    for (const locality of demoLocalities) {
      const loans = universe.loans.filter((loan) => loan.destiny !== 'cure' && loan.locality === locality);
      expect(loans.length).toBeGreaterThanOrEqual(1);
      for (const loan of loans) {
        expect(loan.pincode).toBe(config.territory.ujjain_pincode);
      }
    }
  });

  it('planAssignment routes at least one overdue loan to each demo officer', () => {
    const plan = planAssignment({
      runDate: '2026-11-05',
      loans: endStateLoans(),
      officers,
      territory,
      absences: [],
      promises: [],
      contacts: []
    });
    for (const officerId of demoOfficerIds) {
      const assigned = plan.decisions.filter((decision) => decision.toOfficerId === officerId && decision.status === 'overdue');
      expect(assigned.length).toBeGreaterThanOrEqual(1);
    }
  });
});
