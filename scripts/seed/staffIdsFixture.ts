/**
 * Test fixture shaping StaffIds EXACTLY as a real run produces them
 * (upsertStaff + ensureDemoAccounts): officerIdByName keyed by officer NAME
 * for the 9 OFFICER_SPECS; demoOfficerIdByUsername keyed by USERNAME, where a
 * demo chip linked to a staff officer (Rahul Chouhan / Neha Solanki) carries
 * THAT officer's id — ensureDemoAccounts looks the officer up by name and
 * gets the same row — and the joiner (Demo Officer 3) carries a fresh id.
 *
 * The A50 lesson: a hand-built officer-id map that skips the run's wiring
 * cannot catch wiring bugs (the live run died on a map no test ever built).
 * Tests must shape the fixture like the run and then call the REAL wiring
 * (territoryOfficerIds -> buildTerritoryRows) over it.
 *
 * Ids are stable fakes (`officer:<username>`, `branch:<code>`,
 * `user:<username>`) — the planner and the territory plan only compare ids.
 */
import { DEMO_ACCOUNTS } from '../../src/server/demo.js';
import { MANAGER_SPECS, OFFICER_SPECS, type StaffIds } from './staff.js';

export function realRunStaffIds(): StaffIds {
  const officerIdByName: Record<string, string> = Object.fromEntries(
    OFFICER_SPECS.map((officer) => [officer.name, `officer:${officer.username}`])
  );
  const demoOfficerIdByUsername: Record<string, string> = {};
  for (const account of DEMO_ACCOUNTS) {
    if (!account.officerUser) {
      continue;
    }
    const staffOfficer = OFFICER_SPECS.find((officer) => officer.name === account.officerName);
    demoOfficerIdByUsername[account.username] = staffOfficer
      ? officerIdByName[staffOfficer.name]! // linked chip: the SAME officer row the seed created
      : `officer:${account.username}`; // the joiner: a fresh officer row
  }
  return {
    branchIdByCode: Object.fromEntries(
      [...new Set(OFFICER_SPECS.map((officer) => officer.branchCode))].map((code) => [code, `branch:${code}`])
    ),
    officerIdByName,
    userIdByUsername: Object.fromEntries(MANAGER_SPECS.map((manager) => [manager.username, `user:${manager.username}`])),
    demoUsernames: DEMO_ACCOUNTS.map((account) => account.username),
    demoOfficerIdByUsername
  };
}
