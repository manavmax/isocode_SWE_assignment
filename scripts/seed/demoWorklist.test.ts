import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile } from './config.js';
import { buildLoanUniverse } from './loans.js';
import { mulberry32 } from './rng.js';
import { buildTerritoryRows, territoryOfficerIds } from './territory.js';
import { MANAGER_SPECS, OFFICER_SPECS } from './staff.js';
import { realRunStaffIds } from './staffIdsFixture.js';
import { DEMO_ACCOUNTS } from '../../src/server/demo.js';
import { planAssignment } from '../../src/shared/assignment.js';
import type { AssignmentLoan, AssignmentOfficer, AssignmentTerritory } from '../../src/shared/assignment.js';

/**
 * Step 0.5: the demo chips are the login screen's product demo, so their
 * worklists are specified: demo-officer-1 acts as Rahul Chouhan and
 * demo-officer-2 as Neha Solanki (each must hold >= 10 assigned overdue
 * loans), demo-officer-3 is a territory-less new joiner (exactly 0 — the
 * empty state) and the manager chip follows Kavita Rathore (no worklist of
 * their own). No demo-owned officers or territory slices exist any more.
 *
 * This test drives the REAL run wiring — realRunStaffIds() shapes StaffIds
 * as upsertStaff + ensureDemoAccounts produce them, territoryOfficerIds does
 * the username->name rekey main.ts uses, and the REAL planAssignment routes
 * the REAL universe over the resulting plan with the pinned seed — so a
 * wiring, territory or generator change that starves (or feeds) a demo chip
 * fails here, offline, before any deploy.
 */

const realFile = fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url));
const config = loadSeedConfigFile(realFile);
const universe = buildLoanUniverse(mulberry32(20261105), config, 20261105);

const staffIds = realRunStaffIds();
const officerIdByName = territoryOfficerIds(staffIds); // THE wiring writeTerritory uses

const territory: readonly AssignmentTerritory[] = buildTerritoryRows(config, officerIdByName).map((row) => ({
  branchId: staffIds.branchIdByCode[row.branchCode]!,
  pincode: row.pincode,
  locality: row.locality,
  officerId: officerIdByName[row.officerName]!,
  rank: 1
}));

const joinerAccounts = DEMO_ACCOUNTS.filter((account) => account.officerUser && account.createsOfficer);
const officers: readonly AssignmentOfficer[] = [
  ...OFFICER_SPECS.map((officer) => ({
    id: officerIdByName[officer.name]!,
    branchId: staffIds.branchIdByCode[officer.branchCode]!,
    active: true,
    capacityPoints: config.people.officer_capacity_points
  })),
  ...joinerAccounts.map((account) => ({
    id: officerIdByName[account.officerName!]!,
    branchId: staffIds.branchIdByCode.UJJAIN!, // the demo branch takes the joiner
    active: true,
    capacityPoints: 30
  }))
];

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

function planOnce() {
  return planAssignment({
    runDate: '2026-11-05',
    loans: endStateLoans(),
    officers,
    territory,
    absences: [],
    promises: [],
    contacts: []
  });
}

describe('demo chip worklists (step 0.5: linked staff officers, a joiner, a manager)', () => {
  it('links the officer chips to seeded staff and the manager chip to Kavita Rathore', () => {
    const byUsername = new Map(DEMO_ACCOUNTS.map((account) => [account.username, account]));
    expect(byUsername.get('demo-officer-1')!.officerName).toBe('Rahul Chouhan');
    expect(byUsername.get('demo-officer-2')!.officerName).toBe('Neha Solanki');
    expect(byUsername.get('demo-officer-3')).toMatchObject({ officerName: 'Demo Officer 3', createsOfficer: true });
    const manager = byUsername.get('demo-manager')!;
    expect(manager.officerUser).toBe(false);
    expect(manager.officerName).toBeNull();
    // The manager link must name a real staff manager on the Indore branch —
    // the offline guard for ensureDemoAccounts' database lookup.
    const linked = MANAGER_SPECS.find((spec) => spec.username === manager.linkedManagerUsername);
    expect(linked).toBeDefined();
    expect(linked!.name).toBe('Kavita Rathore');
    expect(linked!.branchCode).toBe('IDR');
    // Chips linked to staff officers must not create their own officers.
    for (const account of DEMO_ACCOUNTS.filter((entry) => entry.officerUser && entry.officerName !== 'Demo Officer 3')) {
      expect(account.createsOfficer).toBe(false);
    }
  });

  it('carries no demo territory slices: 9 staff rows, none owned by a demo-only officer', () => {
    const rows = buildTerritoryRows(config, officerIdByName);
    expect(rows).toHaveLength(9);
    // The old demo officers own nothing; Rahul/Neha rows are staff territory
    // that the chips share, not demo slices.
    for (const row of rows) {
      expect(row.officerName).not.toMatch(/^Demo Officer/);
    }
    // The joiner exists in the id map but has no plan row — the empty state.
    expect(officerIdByName['Demo Officer 3']).toBeTruthy();
    expect(rows.find((row) => row.officerName === 'Demo Officer 3')).toBeUndefined();
  });

  it('no demo localities remain: no end-state loan sits in a deleted demo slice', () => {
    // Nanakheda/Dewasgate slices (A50) are gone; the config carries only the
    // Freeganj slice and the generator no longer emits the deleted names.
    expect(config.territory.ujjain_localities).toBe('Freeganj');
    for (const loan of universe.loans) {
      expect(['Nanakheda', 'Dewasgate']).not.toContain(loan.locality);
    }
  });

  it('every demo officer except the joiner holds >= 10 assigned overdue loans; the joiner exactly 0; the manager none', () => {
    const plan = planOnce();
    for (const account of DEMO_ACCOUNTS) {
      if (!account.officerUser) {
        continue; // the manager has no officer, hence no worklist of their own
      }
      const assigned = plan.decisions.filter(
        (decision) => decision.toOfficerId === officerIdByName[account.officerName!] && decision.status === 'overdue'
      );
      if (account.createsOfficer) {
        expect(assigned).toHaveLength(0); // the joiner: exactly 0, the empty state
      } else {
        expect(assigned.length).toBeGreaterThanOrEqual(account.minOverdueLoans);
        expect(assigned.length).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('the manager chip has no officer to hold loans — the planner can never route to it', () => {
    const managerAccounts = DEMO_ACCOUNTS.filter((account) => !account.officerUser);
    expect(managerAccounts).toHaveLength(1);
    expect(managerAccounts[0]!.officerName).toBeNull();
    // No manager chip appears in the planner's officer set, so no decision
    // can target one; the branch queue is the managers' shared view.
    for (const account of managerAccounts) {
      expect(officers.find((officer) => officer.id === `officer:${account.username}`)).toBeUndefined();
    }
    const plan = planOnce();
    for (const decision of plan.decisions) {
      expect(decision.toOfficerId === null || officers.some((officer) => officer.id === decision.toOfficerId)).toBe(true);
    }
  });
});
