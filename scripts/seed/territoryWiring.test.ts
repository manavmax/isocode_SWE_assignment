import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile } from './config.js';
import { OFFICER_SPECS, type StaffIds } from './staff.js';
import { buildTerritoryRows, territoryOfficerIds } from './territory.js';
import { realRunStaffIds } from './staffIdsFixture.js';
import { DEMO_ACCOUNTS } from '../../src/server/demo.js';

/**
 * A50 follow-up + step 0.5: the live run died with "territory: officer Demo
 * Officer 1 has no staff id" AFTER the reset had truncated the tables, yet
 * every offline test was green — each hand-built its own officerIdFor map
 * already keyed by officer NAME, so the wiring inside writeTerritory (a plain
 * spread of ensureDemoAccounts' USERNAME-keyed ids into the name-keyed map)
 * was never executed by any test. This file drives the extracted wiring
 * (territoryOfficerIds) over StaffIds shaped exactly as a real run produces
 * them, then feeds the result through buildTerritoryRows and the same insert
 * mapping writeTerritory uses: every plan row must resolve to a real officer
 * id, no officer may be left without one, every branch code must resolve,
 * and a demo chip whose id disagrees with the staff map must fail loudly
 * instead of silently shadowing a staff officer.
 */

const config = loadSeedConfigFile(fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url)));

describe('territory officer-id wiring (the writeTerritory map, built for real)', () => {
  it('rekeys the demo ids from usernames to officer names over the staff map', () => {
    const staff = realRunStaffIds();
    const ids = territoryOfficerIds(staff);
    // Keys: the 9 staff officers + the joiner (Demo Officer 3); the linked
    // chips (Rahul/Neha) collapse onto the existing staff keys.
    expect(Object.keys(ids).sort()).toEqual(
      [...OFFICER_SPECS.map((officer) => officer.name), 'Demo Officer 3'].sort()
    );
    // No username key may survive: the plan looks officers up by name.
    for (const account of DEMO_ACCOUNTS) {
      expect(ids[account.username]).toBeUndefined();
    }
    for (const id of Object.values(ids)) {
      expect(id).toBeTruthy();
    }
    expect(new Set(Object.values(ids))).toHaveLength(10); // 9 staff + 1 joiner
    // A linked chip must carry the STAFF officer's id, never shadow it.
    expect(ids['Rahul Chouhan']).toBe(staff.officerIdByName['Rahul Chouhan']);
    expect(ids['Neha Solanki']).toBe(staff.officerIdByName['Neha Solanki']);
  });

  it('resolves every territory row to a real officer id and branch id — the writeTerritory insert mapping', () => {
    const staff = realRunStaffIds();
    const officerIdByName = territoryOfficerIds(staff);
    const rows = buildTerritoryRows(config, officerIdByName);
    expect(rows).toHaveLength(9); // no demo slices since step 0.5
    const seenIds = new Set<string>();
    for (const row of rows) {
      const officerId = officerIdByName[row.officerName];
      const branchId = staff.branchIdByCode[row.branchCode];
      expect(officerId).toBeTruthy(); // a row whose officer has no id aborts the real run
      expect(branchId).toBeTruthy();
      seenIds.add(officerId!);
    }
    expect(seenIds).toHaveLength(9); // every planned officer appears
    // The joiner must NOT appear: no territory, the deliberate empty state.
    expect(seenIds.has(officerIdByName['Demo Officer 3']!)).toBe(false);
  });

  it('fails loudly when a plan row has no id — the failure mode that broke the live run', () => {
    const brokenStaff: StaffIds = realRunStaffIds();
    // The A50 live failure: the name-keyed map lacked a name the plan
    // references. The plan now references only staff names, so drop Rahul —
    // from BOTH maps (the linked chip carries his id and would rescue him,
    // which is correct at runtime) — and expect the same class of failure
    // before any write happens.
    delete brokenStaff.officerIdByName['Rahul Chouhan'];
    delete brokenStaff.demoOfficerIdByUsername['demo-officer-1'];
    expect(() => buildTerritoryRows(config, territoryOfficerIds(brokenStaff))).toThrow(/Rahul Chouhan has no staff id/);
  });

  it('the real-run fixture always carries an id for every demo officer chip', () => {
    const staff = realRunStaffIds();
    for (const account of DEMO_ACCOUNTS.filter((entry) => entry.officerUser)) {
      expect(staff.demoOfficerIdByUsername[account.username]).toBeTruthy();
    }
    // A wired map without the chips would silently skip them in
    // writeTerritory's idempotent repair — it must never happen.
    const ids = territoryOfficerIds(staff);
    for (const account of DEMO_ACCOUNTS.filter((entry) => entry.officerUser)) {
      expect(ids[account.officerName!]).toBeTruthy();
    }
  });

  it('fails loudly when a linked chip carries a different id than the staff map', () => {
    const staff = realRunStaffIds();
    // Simulates ensureDemoAccounts looking up a DIFFERENT officer row than
    // upsertStaff recorded — shadowing Rahul would starve or double-book him.
    staff.demoOfficerIdByUsername['demo-officer-1'] = 'officer:rogue-duplicate-row';
    expect(() => territoryOfficerIds(staff)).toThrow(/links to Rahul Chouhan but staff recorded a different officer id/);
  });

  it('fails loudly when a demo username cannot be rekeyed to an officer name', () => {
    const staff = realRunStaffIds();
    staff.demoOfficerIdByUsername['demo-unknown'] = 'officer:demo-unknown';
    expect(() => territoryOfficerIds(staff)).toThrow(/demo-unknown maps to no officer name/);
  });
});
