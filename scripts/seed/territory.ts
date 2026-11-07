/**
 * Territory plan (prompt 8; SPEC 20.1 + A3). One row per (pincode, locality):
 * - Indore 452001 whole pincode maps to Rahul via a generic row, and the 4th
 *   officer (Savitri Bhil) covers the 'Bhawarkua' slice as its exact row.
 * - Dewas 455001 is split strictly by locality between its two officers —
 *   there is NO generic row, so Dewas loan rows must carry one of the two
 *   configured localities (the generator guarantees that).
 * - Ujjain 456001: Trupti Girdhar owns the 'Freeganj' slice and the generic
 *   row (Arjun Verma) takes the rest. There are NO demo slices since step
 *   0.5: the demo officer chips link to seeded staff (Rahul, Neha) or are a
 *   territory-less joiner (Demo Officer 3 — deliberately no row, so the demo
 *   can show the empty worklist).
 * - Ratlam 457001: single officer Imran Qureshi, no generic fallback beyond
 *   him, and the row's branch is UJJAIN (A3). Also the deliberate single-officer
 *   leave edge case for the later events/officer-absence work.
 *
 * The defect pincode (466001) is intentionally absent, and shares no 5/4/3
 * digit prefix with any listed pincode, so the planner's prefix-tier
 * fallback (assignment.ts) cannot rescue it: those loans queue (A24).
 */
import { DEMO_ACCOUNTS } from '../../src/server/demo.js';
import type { SeedConfig } from './config.js';
import type { StaffIds } from './staff.js';

export interface TerritoryPlanRow {
  branchCode: string;
  pincode: string;
  /** null = generic whole-pincode row (the planner's fallback tier). */
  locality: string | null;
  officerName: string;
}

export type OfficerNameToId = Record<string, string>;

/** The exact id map writeTerritory feeds buildTerritoryRows: the 9 staff
 *  officers keyed by NAME, extended with the demo chips' officers — also
 *  keyed by NAME. ensureDemoAccounts keys its ids by USERNAME
 *  (demo-officer-1/2/3), so those entries are rekeyed through DEMO_ACCOUNTS —
 *  the join a plain object spread silently skipped, leaving 'Demo Officer 1'
 *  without an id and failing the live run inside buildTerritoryRows (A50
 *  follow-up). Since step 0.5 the demo officers 1/2 LINK to seeded staff
 *  (Rahul Chouhan, Neha Solanki): a rekeyed id that disagrees with the staff
 *  map for the same officer name means the demo lookup saw a different row —
 *  that fails the run here instead of silently shadowing the staff officer.
 *  The joiner (Demo Officer 3) contributes a fresh id with no plan row, so
 *  writeTerritory's idempotent delete also clears any stray joiner territory
 *  rows. A demo username with no officer name, or with no id, fails the run
 *  instead of starving that officer. */
export function territoryOfficerIds(staff: StaffIds): OfficerNameToId {
  const ids: OfficerNameToId = { ...staff.officerIdByName };
  for (const [username, officerId] of Object.entries(staff.demoOfficerIdByUsername)) {
    const account = DEMO_ACCOUNTS.find((entry) => entry.username === username);
    if (!account?.officerName) {
      throw new Error(`territory: demo account ${username} maps to no officer name`);
    }
    if (!officerId) {
      throw new Error(`territory: demo account ${username} has no officer id`);
    }
    const staffId = ids[account.officerName];
    if (staffId !== undefined && staffId !== officerId) {
      throw new Error(
        `territory: demo account ${username} links to ${account.officerName} but staff recorded a different officer id — the demo lookup saw another row`
      );
    }
    ids[account.officerName] = officerId;
  }
  return ids;
}

export function buildTerritoryRows(config: SeedConfig, officerIdFor: OfficerNameToId): readonly TerritoryPlanRow[] {
  const indoreMain = config.territory.indore_pincode_main;
  const rows: TerritoryPlanRow[] = [
    // Indore: 3 listed pincodes + the Bhawarkua slice for the 4th officer.
    { branchCode: 'IDR', pincode: indoreMain, locality: null, officerName: 'Rahul Chouhan' },
    { branchCode: 'IDR', pincode: indoreMain, locality: config.territory.indore_shared_locality, officerName: 'Savitri Bhil' },
    { branchCode: 'IDR', pincode: config.territory.indore_pincode_east, locality: null, officerName: 'Premnarayan Bhaskar' },
    { branchCode: 'IDR', pincode: config.territory.indore_pincode_south, locality: null, officerName: 'Shailja Yadav' },
    // Dewas: pure locality split, two rows, no generic.
    { branchCode: 'DWS', pincode: config.territory.dewas_pincode, locality: config.territory.dewas_localities[0]!, officerName: 'Neha Solanki' },
    { branchCode: 'DWS', pincode: config.territory.dewas_pincode, locality: config.territory.dewas_localities[1]!, officerName: 'Murlidhar Garg' },
    // Ujjain: the Freeganj slice + generic. NO demo rows since step 0.5 —
    // the demo officer chips act as Rahul/Neha (their rows above) or are the
    // territory-less joiner, whose empty worklist is the demo's empty state.
    { branchCode: 'UJJAIN', pincode: config.territory.ujjain_pincode, locality: config.territory.ujjain_localities, officerName: 'Trupti Girdhar' },
    { branchCode: 'UJJAIN', pincode: config.territory.ujjain_pincode, locality: null, officerName: 'Arjun Verma' },
    // Ratlam: single officer, whole pincode, UJJAIN branch row (A3).
    { branchCode: 'UJJAIN', pincode: config.territory.ratlam_pincode, locality: null, officerName: 'Imran Qureshi' }
  ];
  for (const row of rows) {
    if (!officerIdFor[row.officerName]) {
      throw new Error(`territory: officer ${row.officerName} has no staff id`);
    }
  }
  return rows;
}
