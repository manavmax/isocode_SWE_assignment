/**
 * Territory plan (prompt 8; SPEC 20.1 + A3). One row per (pincode, locality):
 * - Indore 452001 whole pincode maps to Rahul via a generic row, and the 4th
 *   officer (Savitri Bhil) covers the 'Bhawarkua' slice as its exact row.
 * - Dewas 455001 is split strictly by locality between its two officers —
 *   there is NO generic row, so Dewas loan rows must carry one of the two
 *   configured localities (the generator guarantees that).
 * - Ujjain 456001: Trupti Girdhar owns the 'Freeganj' slice, the demo
 *   officers own one slice each (Nanakheda, Dewasgate — A50, so the demo
 *   worklist is never empty), and the generic row (Arjun Verma) takes the
 *   rest.
 * - Ratlam 457001: single officer Imran Qureshi, no generic fallback beyond
 *   him, and the row's branch is UJJAIN (A3). Also the deliberate single-officer
 *   leave edge case for the later events/officer-absence work.
 *
 * The defect pincode (466001) is intentionally absent, and shares no 5/4/3
 * digit prefix with any listed pincode, so the planner's prefix-tier
 * fallback (assignment.ts) cannot rescue it: those loans queue (A24).
 */
import type { SeedConfig } from './config.js';

export interface TerritoryPlanRow {
  branchCode: string;
  pincode: string;
  /** null = generic whole-pincode row (the planner's fallback tier). */
  locality: string | null;
  officerName: string;
}

export type OfficerNameToId = Record<string, string>;

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
    // Ujjain: three slices + generic. The demo officers' rows (A50) resolve
    // only when the caller's map includes their ids (main.ts merges
    // ensureDemoAccounts' officerIdByUsername into the staff map).
    { branchCode: 'UJJAIN', pincode: config.territory.ujjain_pincode, locality: config.territory.ujjain_localities[0]!, officerName: 'Trupti Girdhar' },
    { branchCode: 'UJJAIN', pincode: config.territory.ujjain_pincode, locality: config.territory.ujjain_localities[1]!, officerName: 'Demo Officer 1' },
    { branchCode: 'UJJAIN', pincode: config.territory.ujjain_pincode, locality: config.territory.ujjain_localities[2]!, officerName: 'Demo Officer 2' },
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
