import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile } from './config.js';
import { OFFICER_SPECS, type StaffIds } from './staff.js';
import { buildTerritoryRows, territoryOfficerIds } from './territory.js';
import { DEMO_ACCOUNTS } from '../../src/server/demo.js';

/**
 * A50 follow-up: the live run died with "territory: officer Demo Officer 1
 * has no staff id" AFTER the reset had truncated the tables, yet every
 * offline test was green — each hand-built its own officerIdFor map already
 * keyed by officer NAME, so the wiring inside writeTerritory (a plain spread
 * of ensureDemoAccounts' USERNAME-keyed ids into the name-keyed map) was
 * never executed by any test. This file drives the extracted wiring
 * (territoryOfficerIds) with StaffIds shaped exactly as upsertStaff +
 * ensureDemoAccounts produce them on a real run, then feeds the result
 * through buildTerritoryRows and the same insert mapping writeTerritory
 * uses: every plan row must resolve to a real officer id, no officer may be
 * left without one, and every branch code must resolve too.
 */

const config = loadSeedConfigFile(fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url)));

/** StaffIds as a real run yields them: officerIdByName keyed by NAME (the 9
 *  OFFICER_SPECS), demoOfficerIdByUsername keyed by USERNAME — the exact
 *  keying mismatch that broke the live run is preserved in the fixture on
 *  purpose, so a wiring regression reproduces the production failure here
 *  instead of on the database. */
function realRunStaffIds(): StaffIds {
  return {
    branchIdByCode: Object.fromEntries(
      [...new Set(OFFICER_SPECS.map((officer) => officer.branchCode))].map((code) => [code, `branch:${code}`])
    ),
    officerIdByName: Object.fromEntries(OFFICER_SPECS.map((officer) => [officer.name, `officer:${officer.username}`])),
    userIdByUsername: {},
    demoUsernames: DEMO_ACCOUNTS.map((account) => account.username),
    demoOfficerIdByUsername: Object.fromEntries(
      DEMO_ACCOUNTS.filter((account) => account.officerUser).map((account) => [account.username, `officer:${account.username}`])
    )
  };
}

describe('territory officer-id wiring (A50 follow-up: the writeTerritory map, built for real)', () => {
  it('rekeys the demo ids from usernames to officer names over the 9 staff officers', () => {
    const ids = territoryOfficerIds(realRunStaffIds());
    expect(Object.keys(ids).sort()).toEqual(
      [...OFFICER_SPECS.map((officer) => officer.name), 'Demo Officer 1', 'Demo Officer 2'].sort()
    );
    // No username key may survive: the plan looks officers up by name.
    for (const account of DEMO_ACCOUNTS) {
      expect(ids[account.username]).toBeUndefined();
    }
    for (const id of Object.values(ids)) {
      expect(id).toBeTruthy();
    }
    expect(new Set(Object.values(ids))).toHaveLength(11); // 9 staff + 2 demo
  });

  it('resolves every territory row to a real officer id and branch id — the writeTerritory insert mapping', () => {
    const staff = realRunStaffIds();
    const officerIdByName = territoryOfficerIds(staff);
    const rows = buildTerritoryRows(config, officerIdByName);
    expect(rows).toHaveLength(11);
    const seenIds = new Set<string>();
    for (const row of rows) {
      const officerId = officerIdByName[row.officerName];
      const branchId = staff.branchIdByCode[row.branchCode];
      expect(officerId).toBeTruthy(); // a row whose officer has no id aborts the real run
      expect(branchId).toBeTruthy();
      seenIds.add(officerId!);
    }
    expect(seenIds).toHaveLength(11); // every officer appears, each exactly one slice
    for (const account of DEMO_ACCOUNTS.filter((entry) => entry.officerUser)) {
      expect(seenIds.has(staff.demoOfficerIdByUsername[account.username]!)).toBe(true);
    }
  });

  it('fails loudly when the demo ids are missing — the shape that broke the live run', () => {
    const staffWithoutDemoIds = { ...realRunStaffIds(), demoOfficerIdByUsername: {} };
    // The old wiring (a plain spread of the username-keyed map) produced
    // exactly this name-keyed gap and failed only on the database.
    expect(() => buildTerritoryRows(config, territoryOfficerIds(staffWithoutDemoIds))).toThrow(
      /Demo Officer 1 has no staff id/
    );
  });

  it('fails loudly when a demo username cannot be rekeyed to an officer name', () => {
    const staff = realRunStaffIds();
    staff.demoOfficerIdByUsername['demo-unknown'] = 'officer:demo-unknown';
    expect(() => territoryOfficerIds(staff)).toThrow(/demo-unknown maps to no officer name/);
  });
});
